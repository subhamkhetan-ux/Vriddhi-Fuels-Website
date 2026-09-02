"""Gmail access over IMAP with an App Password (no OAuth).

Why not OAuth: Google expires OAuth refresh tokens for apps in "Testing"
publishing status after ~7 days, which kept killing the agent, and publishing a
restricted-scope app to production needs verification/an owned domain. An **App
Password over IMAP** never expires (until you revoke it or change the account
password), needs no consent screen and no verification.

Each mailbox's GitHub secret (still ``GMAIL_TOKEN_BANK1`` / ``GMAIL_TOKEN_BANK2``)
now holds a small JSON blob instead of a refresh token:

    {"email": "you@gmail.com", "app_password": "abcd efgh ijkl mnop"}

Prereqs (one-time, per account): enable **2-Step Verification**, then create an
**App Password** (Google Account → Security → App passwords). IMAP is on by
default in Gmail. Spaces in the app password are ignored.

Gmail's IMAP supports the **X-GM-RAW** search extension, so the exact Gmail
search strings in ``config.py`` (``gmail_query``) work unchanged — no query
translation. Stable per-message ids come from **X-GM-MSGID** (account-global and
permanent, the closest IMAP equivalent of the old Gmail-API message id).

Only the standard library is used (imaplib, email) — no third-party client.
"""

from __future__ import annotations

import datetime as dt
import email
import imaplib
import json
import re
from dataclasses import dataclass
from email.header import decode_header, make_header
from email.message import Message

IMAP_HOST = "imap.gmail.com"


@dataclass
class Alert:
    msg_id: str
    internal_ms: int          # message INTERNALDATE (ms since epoch) — the HWM axis
    subject: str
    body: str


@dataclass
class InvoiceMail:
    msg_id: str
    internal_ms: int
    pdfs: list[bytes]         # decoded PDF attachment bytes


# ---- connection ------------------------------------------------------------

def build_service(cred_json: str):
    """Log in to Gmail IMAP with the app-password JSON blob and return the
    connection, with **All Mail** selected read-only so search covers archived
    mail too (matching the old Gmail-API behaviour). Raises on bad credentials."""
    info = json.loads(cred_json)
    user = (info.get("email") or info.get("user") or "").strip()
    pw = (info.get("app_password") or info.get("password") or "").replace(" ", "")
    if not user or not pw:
        raise RuntimeError("credential JSON needs 'email' and 'app_password'")
    conn = imaplib.IMAP4_SSL(IMAP_HOST)
    conn.login(user, pw)
    conn.select(_all_mail_folder(conn), readonly=True)
    return conn


def _all_mail_folder(conn) -> str:
    """Gmail's All Mail folder, found locale-independently via its ``\\All``
    special-use flag; falls back to the usual name."""
    try:
        typ, data = conn.list()
        if typ == "OK":
            for line in data or []:
                s = line.decode("utf-8", "replace") if isinstance(line, (bytes, bytearray)) else str(line)
                if "\\All" in s:
                    m = re.search(r'"([^"]+)"\s*$', s) or re.search(r'([^\s"]+)\s*$', s)
                    if m:
                        return '"%s"' % m.group(1)
    except Exception:
        pass
    return '"[Gmail]/All Mail"'


# ---- search + fetch --------------------------------------------------------

def _imap_quote(s: str) -> str:
    """IMAP quoted-string form of ``s`` (backslash-escape " and \\)."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _search_uids(conn, gmail_query: str) -> list[bytes]:
    """UIDs matching a Gmail search string, via the X-GM-RAW extension."""
    typ, data = conn.uid("SEARCH", "X-GM-RAW", _imap_quote(gmail_query))
    if typ != "OK" or not data or not data[0]:
        return []
    return data[0].split()


def _fetch_raw(conn, uid: bytes):
    """Return ``(info_bytes, raw_message_bytes)`` for one UID, or ``(b"", None)``.
    ``info_bytes`` carries INTERNALDATE + X-GM-MSGID; the body is peeked (the
    mailbox is read-only anyway, so nothing is marked read)."""
    typ, data = conn.uid("FETCH", uid, "(INTERNALDATE X-GM-MSGID BODY.PEEK[])")
    if typ != "OK" or not data:
        return b"", None
    for item in data:
        if isinstance(item, tuple) and len(item) >= 2:
            return item[0] or b"", item[1]
    return b"", None


def _xgm_msgid(info: bytes) -> str:
    m = re.search(rb"X-GM-MSGID\s+(\d+)", info or b"")
    return m.group(1).decode() if m else ""


def _internaldate_ms(info: bytes) -> int:
    m = re.search(rb'INTERNALDATE "([^"]+)"', info or b"")
    if not m:
        return 0
    try:  # e.g. "02-Sep-2026 08:00:21 +0000"
        d = dt.datetime.strptime(m.group(1).decode(), "%d-%b-%Y %H:%M:%S %z")
        return int(d.timestamp() * 1000)
    except Exception:
        return 0


def _subject(msg: Message) -> str:
    raw = msg.get("Subject", "")
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return raw or ""


def _part_text(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, "replace")
    except (LookupError, TypeError):
        return payload.decode("utf-8", "replace")


def _strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"[ \t]+", " ", text)


def _extract_body(msg: Message) -> str:
    """Prefer text/plain; fall back to stripped text/html. Skips attachments."""
    plain, html = [], []
    if msg.is_multipart():
        for part in msg.walk():
            if part.is_multipart():
                continue
            if (part.get_content_disposition() or "") == "attachment":
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain":
                plain.append(_part_text(part))
            elif ctype == "text/html":
                html.append(_strip_html(_part_text(part)))
    else:
        txt = _part_text(msg)
        if msg.get_content_type() == "text/html":
            html.append(_strip_html(txt))
        else:
            plain.append(txt)
    return "\n".join(plain) if plain else "\n".join(html)


def _pdf_attachments(msg: Message) -> list[bytes]:
    pdfs: list[bytes] = []
    for part in msg.walk():
        filename = (part.get_filename() or "").lower()
        if filename.endswith(".pdf") or part.get_content_type() == "application/pdf":
            payload = part.get_payload(decode=True)
            if payload:
                pdfs.append(payload)
    return pdfs


def _with_after(query: str, after_ms: int | None) -> str:
    if after_ms:
        # Gmail search after: takes epoch seconds; a minute of slack for safety.
        return f"{query} after:{max(0, after_ms // 1000 - 60)}"
    return query


# ---- public API (same shape as the old OAuth client) -----------------------

def fetch_alerts(conn, query: str, after_ms: int | None,
                 seen_ids: set[str], max_results: int = 50) -> list[Alert]:
    """Parsed-ready alerts newer than ``after_ms`` and not in ``seen_ids``,
    oldest first (so the high-water mark advances monotonically)."""
    uids = _search_uids(conn, _with_after(query, after_ms))
    if max_results:
        uids = uids[-max_results:]                 # most recent matches
    alerts: list[Alert] = []
    for uid in uids:
        info, raw = _fetch_raw(conn, uid)
        if raw is None:
            continue
        mid = _xgm_msgid(info)
        internal = _internaldate_ms(info)
        if mid and mid in seen_ids:
            continue
        if after_ms and internal <= after_ms:
            continue
        msg = email.message_from_bytes(raw)
        alerts.append(Alert(msg_id=mid, internal_ms=internal,
                            subject=_subject(msg), body=_extract_body(msg)))
    alerts.sort(key=lambda a: a.internal_ms)
    return alerts


def fetch_invoice_mails(conn, query: str, after_ms: int | None,
                        seen_ids: set[str], max_results: int = 25) -> list[InvoiceMail]:
    """IOC invoice mails (with their PDF attachments) newer than ``after_ms`` and
    not already seen, oldest first."""
    uids = _search_uids(conn, _with_after(query, after_ms))
    if max_results:
        uids = uids[-max_results:]
    mails: list[InvoiceMail] = []
    for uid in uids:
        info, raw = _fetch_raw(conn, uid)
        if raw is None:
            continue
        mid = _xgm_msgid(info)
        internal = _internaldate_ms(info)
        if mid and mid in seen_ids:
            continue
        if after_ms and internal <= after_ms:
            continue
        msg = email.message_from_bytes(raw)
        mails.append(InvoiceMail(msg_id=mid, internal_ms=internal,
                                 pdfs=_pdf_attachments(msg)))
    mails.sort(key=lambda m: m.internal_ms)
    return mails


def pdf_to_text(pdf_bytes: bytes) -> str:
    """Extract text from a PDF (lazy pymupdf import; only needed on the runner)."""
    import pymupdf  # lazy: keeps pure-logic tests import-free

    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        return "".join(page.get_text() for page in doc)
    finally:
        doc.close()
