"""IOCL Challan — every IndianOil invoice PDF (all trucks) saved to Google Drive.

Each run, the IOCL invoice mails (the same mailbox and sender as credit.py /
decant.py) are read and every invoice PDF is filed by its INVOICE date:

    IOCL Challan / 2026 / 11 - November / 7013019147 - 12-11-2026 - OD23U8210.pdf

The year and month folders are always made inside "IOCL Challan" as needed.
Which "IOCL Challan" depends on the token (mint_drive_token.py):

* ``drive.file`` (the default, narrowest): the agent sees and touches only what
  it created itself — nothing else in the Drive — so it makes its own
  "IOCL Challan" in My Drive.
* full ``drive`` (minted with ``--existing-folder``): it finds the
  "IOCL Challan" folder already in My Drive and fills that one. For a folder
  that isn't at the top of My Drive, set the repo variable
  ``DRIVE_ARCHIVE_FOLDER_ID`` to its id (from its link: .../folders/<id>).

Never twice: each file carries its invoice number (``appProperties``), and an
invoice already in the archive — a resent mail, a re-run — is skipped. A mail
counts as done only once all its PDFs are in Drive; a failure leaves it (and the
ones after it) for the next run, so nothing is lost while Drive is unreachable.

Best-effort like the rest of the agent: problems come back as error strings.
Skipped quietly until the ``GDRIVE_UPLOAD_TOKEN`` secret is set.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re

from . import invoice as invoice_mod
from .config import ACCOUNTS, DECANT, LOOKBACK_DAYS

SEEN_KEY = "drive_archive"
TOKEN_ENV = "GDRIVE_UPLOAD_TOKEN"
# Optional first-run back-fill start, "YYYY-MM-DD" (repo variable): archive
# every invoice mail since then instead of the last LOOKBACK_DAYS.
SINCE_ENV = "DRIVE_ARCHIVE_SINCE"
# Optional: the existing "IOCL Challan" folder's id (needs a full-drive token).
FOLDER_ID_ENV = "DRIVE_ARCHIVE_FOLDER_ID"
SCOPES = ["https://www.googleapis.com/auth/drive.file"]      # the default token's scope
ROOT = "IOCL Challan"
FOLDER_MIME = "application/vnd.google-apps.folder"
PROP = "iocl_invoice"            # appProperties key: the invoice's SAP entry number
PER_RUN = 60                     # mails per run, oldest first (a back-fill goes on next run)
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


# ---------------------------------------------------------------------------
# Where an invoice goes
# ---------------------------------------------------------------------------

def place(invoice_date: str | None, mail_ms: int | None = None) -> tuple[str, str]:
    """(year folder, month folder) for an invoice date "dd/mm/yyyy" — e.g.
    ("2026", "11 - November"). Without a readable date, the mail's date (IST)."""
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", (invoice_date or "").strip())
    if m and 1 <= int(m.group(2)) <= 12:
        y, mo = int(m.group(3)), int(m.group(2))
    else:
        d = dt.datetime.fromtimestamp((mail_ms or 0) / 1000, IST)
        y, mo = d.year, d.month
    return str(y), f"{mo:02d} - {MONTHS[mo - 1]}"


def file_name(key: str, invoice_date: str | None, tt_no: str | None) -> str:
    """"7013019147 - 12-11-2026 - OD23U8210.pdf" (date and TT when known)."""
    parts = [key]
    if invoice_date:
        parts.append(invoice_date.replace("/", "-"))
    if tt_no:
        parts.append(tt_no)
    return re.sub(r'[\\/:*?"<>|]+', "-", " - ".join(parts)) + ".pdf"


def invoices_in_mail(mail, pdf_to_text) -> list[dict]:
    """The invoice PDFs of one mail: [{key, date, tt, name, pdf}], deduped on
    the SAP entry number. A PDF that isn't an IOCL tax invoice (no 70xxxxxxxx
    number) is left out."""
    out: list[dict] = []
    seen: set[str] = set()
    names = getattr(mail, "pdf_names", None) or []
    for i, pdf in enumerate(mail.pdfs):
        fields = invoice_mod.extract_fields(pdf_to_text(pdf))
        key = invoice_mod.sap_entry_no(names[i] if i < len(names) else "", fields.invoice_no)
        if key and not re.fullmatch(r"70\d{8}", key):
            key = fields.invoice_no
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({"key": key, "date": fields.invoice_date, "tt": fields.tt_no,
                    "name": file_name(key, fields.invoice_date, fields.tt_no), "pdf": pdf})
    return out


# ---------------------------------------------------------------------------
# Google Drive (v3)
# ---------------------------------------------------------------------------

def _q(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


class Drive:
    """The few Drive calls the archive needs, with folder ids cached per run.
    ``service`` is a googleapiclient Drive v3 resource (or a test double)."""

    def __init__(self, service):
        self.svc = service
        self._folders: dict[tuple[str, str], str] = {}

    def folder(self, name: str, parent: str = "root") -> str:
        """The id of folder ``name`` under ``parent``, made if it isn't there."""
        if (parent, name) in self._folders:
            return self._folders[(parent, name)]
        res = self.svc.files().list(
            q=f"name = '{_q(name)}' and mimeType = '{FOLDER_MIME}' and '{parent}' in parents and trashed = false",
            spaces="drive", fields="files(id)", pageSize=1).execute()
        found = res.get("files") or []
        fid = found[0]["id"] if found else self.svc.files().create(
            body={"name": name, "mimeType": FOLDER_MIME, "parents": [parent]}, fields="id").execute()["id"]
        self._folders[(parent, name)] = fid
        return fid

    def has(self, key: str) -> bool:
        """Is this invoice in the archive already (anywhere, not in the bin)?"""
        res = self.svc.files().list(
            q=f"appProperties has {{ key='{PROP}' and value='{_q(key)}' }} and trashed = false",
            spaces="drive", fields="files(id)", pageSize=1).execute()
        return bool(res.get("files"))

    def upload(self, name: str, parent: str, data: bytes, key: str) -> str:
        from googleapiclient.http import MediaInMemoryUpload  # lazy: tests pass a double
        media = MediaInMemoryUpload(data, mimetype="application/pdf", resumable=False)
        return self.svc.files().create(
            body={"name": name, "parents": [parent], "appProperties": {PROP: key}},
            media_body=media, fields="id").execute()["id"]


def build_drive(token_json: str):
    """A Drive v3 service from the authorized-user JSON minted by
    mint_drive_token.py (a revocable refresh token; its own scope — drive.file,
    or drive when minted for an existing folder)."""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    info = json.loads(token_json)
    creds = Credentials.from_authorized_user_info(info, scopes=info.get("scopes") or SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def archive(drive: Drive, invoices: list[dict], root_id: str | None = None) -> int:
    """File each invoice into IOCL Challan / year / month, making the year and
    month folders as needed. ``root_id``: an existing "IOCL Challan" folder to
    use; else the one named so at the top of My Drive (made if missing).
    Returns how many were uploaded (ones already there are skipped). Raises on
    a Drive error."""
    up = 0
    for inv in invoices:
        if drive.has(inv["key"]):
            continue
        year, month = place(inv["date"], inv.get("mail_ms"))
        root = root_id or drive.folder(ROOT)
        parent = drive.folder(month, drive.folder(year, root))
        drive.upload(inv["name"], parent, inv["pdf"], inv["key"])
        up += 1
    return up


# ---------------------------------------------------------------------------
# Each run
# ---------------------------------------------------------------------------

def _account_token_env() -> str | None:
    for acc in ACCOUNTS:
        if acc["id"] == DECANT["account_id"]:          # the HDFC mailbox (IOCL invoices)
            return acc["token_env"]
    return None


def _start_ms() -> int:
    since = (os.environ.get(SINCE_ENV) or "").strip()
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", since)
    if m:
        d = dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=IST)
        return int(d.timestamp() * 1000)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=LOOKBACK_DAYS)
    return int(cutoff.timestamp() * 1000)


def run(seen: dict, *, drive=None, mail_conn=None, fetch=None, pdf_to_text=None) -> tuple[int, list[str]]:
    """Archive new invoice mails' PDFs to Drive. Returns ``(uploaded, errors)``.
    The keyword arguments are for tests (doubles for Drive and the mailbox)."""
    token = os.environ.get(TOKEN_ENV, "").strip()
    if drive is None and not token:
        print(f"Drive archive: {TOKEN_ENV} not set; skipping.")
        return 0, []

    st = seen.setdefault(SEEN_KEY, {"high_water": 0, "ids": []})
    after_ms = st.get("high_water") or _start_ms()
    seen_ids = set(st.get("ids", []))

    try:
        if fetch is None or pdf_to_text is None:
            from .gmail_client import build_service, fetch_invoice_mails
            from .gmail_client import pdf_to_text as _ptt
            fetch, pdf_to_text = fetch or fetch_invoice_mails, pdf_to_text or _ptt
        if mail_conn is None:
            env = _account_token_env()
            cred = os.environ.get(env) if env else None
            if not cred:
                return 0, [f"drive archive: missing secret {env}"]
            mail_conn = build_service(cred)
        if drive is None:
            drive = Drive(build_drive(token))
        mails = fetch(mail_conn, DECANT["gmail_query"], after_ms, seen_ids,
                      max_results=PER_RUN, oldest=True)
    except Exception as exc:
        return 0, [f"drive archive: {exc}"]

    uploaded = 0
    for mail in mails[:PER_RUN]:                         # oldest first
        try:
            invs = invoices_in_mail(mail, pdf_to_text)
            for inv in invs:
                inv["mail_ms"] = mail.internal_ms
            uploaded += archive(drive, invs, (os.environ.get(FOLDER_ID_ENV) or "").strip() or None)
        except Exception as exc:
            # Leave this mail (and the later ones) for the next run, in order.
            return uploaded, [f"drive archive: {getattr(mail, 'msg_id', '?')}: {exc}"]
        st["high_water"] = max(st.get("high_water") or 0, mail.internal_ms)
        if mail.msg_id and mail.msg_id not in st["ids"]:
            st["ids"].append(mail.msg_id)
    st["ids"] = st["ids"][-500:]
    return uploaded, []


def should_alert(seen: dict, now: dt.datetime | None = None) -> bool:
    """Telegram about archive errors at most once a day (they repeat every run
    while e.g. the token is expired)."""
    st = seen.setdefault(SEEN_KEY, {"high_water": 0, "ids": []})
    now = now or dt.datetime.now(dt.timezone.utc)
    last = st.get("alerted_at")
    if last:
        try:
            if now - dt.datetime.fromisoformat(last) < dt.timedelta(hours=24):
                return False
        except ValueError:
            pass
    st["alerted_at"] = now.isoformat()
    return True
