"""Gmail API access via an OAuth refresh token (spec §7).

A refresh token — NOT a password — authenticates each mailbox: Google blocks
datacenter password logins, and a refresh token is revocable and scoped
(``gmail.readonly``). The one-time consent that mints it is done on the Mac
(see ``export_customers.py`` / README) and the JSON blob is stored as a GitHub
secret; the runner exchanges refresh -> access at runtime.

Heavy Google imports are done lazily so the pure-logic modules and their tests
don't need the client libraries installed.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass

from .config import GMAIL_SCOPES


@dataclass
class Alert:
    msg_id: str
    internal_ms: int          # Gmail internalDate (ms since epoch) — the HWM axis
    subject: str
    body: str


def build_service(token_json: str):
    """Build a Gmail API service from a stored authorized-user JSON blob."""
    from google.oauth2.credentials import Credentials  # lazy
    from googleapiclient.discovery import build

    info = json.loads(token_json)
    creds = Credentials.from_authorized_user_info(info, GMAIL_SCOPES)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _decode_part(data: str) -> str:
    return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", "replace")


def _strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"[ \t]+", " ", text)


def _extract_body(payload: dict) -> str:
    """Prefer text/plain; fall back to stripped text/html. Walks nested parts."""
    plain, html = [], []

    def walk(part):
        mime = part.get("mimeType", "")
        body = part.get("body", {})
        data = body.get("data")
        if data:
            if mime == "text/plain":
                plain.append(_decode_part(data))
            elif mime == "text/html":
                html.append(_strip_html(_decode_part(data)))
        for sub in part.get("parts", []) or []:
            walk(sub)

    walk(payload)
    if plain:
        return "\n".join(plain)
    return "\n".join(html)


def _header(payload: dict, name: str) -> str:
    for h in payload.get("headers", []) or []:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def fetch_alerts(service, query: str, after_ms: int | None,
                 seen_ids: set[str], max_results: int = 50) -> list[Alert]:
    """Return parsed-ready alerts newer than ``after_ms`` and not in ``seen_ids``,
    oldest first (so the high-water mark advances monotonically)."""
    q = query
    if after_ms:
        # Gmail's after: takes seconds; subtract a minute of slack for safety.
        q = f"{query} after:{max(0, after_ms // 1000 - 60)}"

    listed = service.users().messages().list(
        userId="me", q=q, maxResults=max_results).execute()
    ids = [m["id"] for m in listed.get("messages", [])]

    alerts: list[Alert] = []
    for mid in ids:
        if mid in seen_ids:
            continue
        msg = service.users().messages().get(
            userId="me", id=mid, format="full").execute()
        internal = int(msg.get("internalDate", "0"))
        if after_ms and internal <= after_ms:
            continue
        payload = msg.get("payload", {})
        alerts.append(Alert(
            msg_id=mid,
            internal_ms=internal,
            subject=_header(payload, "Subject"),
            body=_extract_body(payload),
        ))

    alerts.sort(key=lambda a: a.internal_ms)
    return alerts
