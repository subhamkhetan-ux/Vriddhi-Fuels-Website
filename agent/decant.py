"""Tanker-decanting feed — every IOCL invoice with its chamber table, for /decant.

Same mailbox and sender as ``credit.py`` (all trucks), but this mirrors what the
/decant app needs to plan a decantation: the tank truck, each product line with
the chambers it was loaded into ("Comp No(s)") and its density, and the truck's
chamber table (PL / DIP / QTY per chamber). Rows go to ``dec_invoices`` in
the decanting app's OWN Supabase project, keyed on the SAP entry number like
the credit rows.

That project is read from ``decant/config.js`` (its URL and publishable key,
the same the app uses — the dec_* tables accept that key); the
``DECANT_SUPABASE_URL`` / ``DECANT_SUPABASE_KEY`` environment variables
override it. This module never
touches the payments project: it doesn't use the payments secrets, and it
refuses to run if the decanting project is set to the payments one. Until the
project is set, the feed is skipped quietly.

Insert-if-absent: once a row exists the app owns it (the user may correct a
chamber or dismiss an invoice there), so a re-scan never overwrites it. A
separate high-water mark lets the first run back-fill the last
``LOOKBACK_DAYS`` of invoices without touching the credit/consignment cursors.
Best-effort like the rest of the agent: problems come back as error strings.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import urllib.request
from pathlib import Path

from . import invoice as invoice_mod
from .config import ACCOUNTS, DECANT, LOOKBACK_DAYS

SEEN_KEY = "decant_invoices"
APP_CONFIG = Path(__file__).resolve().parent.parent / "decant" / "config.js"
URL_ENV = "DECANT_SUPABASE_URL"
KEY_ENV = "DECANT_SUPABASE_KEY"
PAYMENTS_URL_ENV = "SUPABASE_URL"           # the payments project — never written to here
COLUMNS = (
    "invoice_no", "invoice_date", "invoice_time", "tt_no", "lines", "chambers",
    "density15", "seals", "origin", "amount", "gmail_msg_id", "source",
)


# ---------------------------------------------------------------------------
# The decanting app's own Supabase project
# ---------------------------------------------------------------------------

def project() -> tuple[tuple[str, str] | None, str]:
    """``((url, key), "")`` for the decanting project, or ``(None, why)``."""
    url = os.environ.get(URL_ENV, "").strip()
    key = os.environ.get(KEY_ENV, "").strip()
    if not (url and key):
        try:
            text = APP_CONFIG.read_text(encoding="utf-8")
        except OSError:
            return None, "decant/config.js not found"

        def grab(name: str) -> str:
            m = re.search(rf'{name}\s*:\s*"([^"]*)"', text)
            return m.group(1).strip() if m else ""
        url, key = grab("SUPABASE_URL"), grab("SUPABASE_ANON_KEY")
    if not (url.startswith("https://") and key) or "PASTE_" in url + key:
        return None, "no Supabase project set for the decanting app (decant/config.js)"
    url = url.rstrip("/")
    payments = os.environ.get(PAYMENTS_URL_ENV, "").strip().rstrip("/")
    if payments and url.lower() == payments.lower():
        return None, "decant/config.js points at the payments project — refusing to write there"
    return (url, key), ""


def _request(cfg: tuple[str, str], method: str, path: str,
             body: object | None = None, prefer: str | None = None) -> object:
    url, key = cfg
    headers = {"apikey": key, "Content-Type": "application/json"}
    if not key.startswith("sb_"):              # a legacy JWT key goes in Authorization too
        headers["Authorization"] = f"Bearer {key}"
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{url}/rest/v1/{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else None


def table_ready(cfg: tuple[str, str]) -> bool:
    """True when ``dec_invoices`` exists (decant-schema.sql has been run)."""
    try:
        _request(cfg, "GET", "dec_invoices?select=invoice_no&limit=1")
        return True
    except Exception:
        return False


def store(cfg: tuple[str, str], rows: list[dict]) -> int:
    """Insert invoices, ignoring ones already there (the app owns them once
    stored). Returns the count sent, or 0 on any error."""
    payload = [{c: r.get(c) for c in COLUMNS} for r in rows if r.get("invoice_no")]
    if not payload:
        return 0
    try:
        _request(cfg, "POST", "dec_invoices?on_conflict=invoice_no", body=payload,
                 prefer="resolution=ignore-duplicates,return=minimal")
        return len(payload)
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Invoices from mail
# ---------------------------------------------------------------------------


def _account_token_env() -> str | None:
    for acc in ACCOUNTS:
        if acc["id"] == DECANT["account_id"]:
            return acc["token_env"]
    return None


def invoice_row(msg_id: str, fields: invoice_mod.InvoiceFields, key: str) -> dict:
    """The ``dec_invoices`` row for one parsed invoice."""
    return {
        "invoice_no": key,
        "invoice_date": fields.invoice_date,          # dd/mm/yyyy
        "invoice_time": fields.invoice_time,          # HH:MM
        "tt_no": fields.tt_no,
        "lines": [
            {
                "product": ln.product,
                "column_key": ln.column_key,
                "qty_kl": ln.qty_kl if ln.qty_kl is not None else float(ln.qty),
                "compartments": ln.compartments,
                "density15": ln.density15,
                "terminal_tank": ln.terminal_tank,
                "value": ln.value,                    # after-VAT ₹ for this product
            }
            for ln in fields.lines
        ],
        "chambers": [
            {"no": c.no, "pl_cm": c.pl_cm, "dip_cm": c.dip_cm, "qty_kl": c.qty_kl}
            for c in fields.chambers
        ],
        "density15": fields.density15,
        "seals": fields.seals,
        "origin": fields.origin,
        "amount": fields.value,
        "gmail_msg_id": msg_id,
        "source": "agent",
    }


def rows_from_mail(mail, pdf_to_text) -> list[dict]:
    """One row per usable invoice PDF in a mail (any truck), deduped on the SAP
    entry number (the PDF filename) so a resent invoice collapses."""
    rows: list[dict] = []
    seen_nos: set[str] = set()
    names = getattr(mail, "pdf_names", None) or []
    for idx, pdf in enumerate(mail.pdfs):
        fields = invoice_mod.extract_fields(pdf_to_text(pdf))
        # Nothing to decant without a truck and at least one product line.
        if not (fields.tt_no and fields.lines):
            continue
        key = invoice_mod.sap_entry_no(names[idx] if idx < len(names) else "",
                                       fields.invoice_no)
        if not key or key in seen_nos:
            continue
        seen_nos.add(key)
        rows.append(invoice_row(mail.msg_id, fields, key))
    return rows


def run(seen: dict) -> tuple[int, list[str]]:
    """Scan for new IOCL invoice mail and insert each invoice for /decant.

    Returns ``(sent, errors)``. Advances the high-water mark past every mail
    handled so it's never re-scanned; the ``invoice_no`` primary key makes a
    re-processed invoice a no-op anyway."""
    errors: list[str] = []
    cfg, why = project()
    if not cfg:
        print(f"Decant: {why}; skipping.")
        return 0, errors
    if not table_ready(cfg):
        # Schema not run yet (or the project unreachable): leave the cursor where
        # it is so the first successful run back-fills.
        print("Decant: dec_invoices not reachable — run supabase/decant-schema.sql in the decanting project; skipping.")
        return 0, errors

    token_env = _account_token_env()
    token = os.environ.get(token_env) if token_env else None
    if not token:
        return 0, [f"decant: missing secret {token_env}"]

    try:
        from .gmail_client import build_service, fetch_invoice_mails, pdf_to_text
    except Exception as exc:  # pragma: no cover - import guard
        return 0, [f"decant: gmail client unavailable: {exc}"]

    # The cursor belongs to one project: a new one (the app moved to its own
    # project) starts over, so it gets the last LOOKBACK_DAYS of invoices too.
    acc_state = seen.get(SEEN_KEY)
    if not acc_state or acc_state.get("project") != cfg[0]:
        acc_state = seen[SEEN_KEY] = {"high_water": 0, "ids": [], "project": cfg[0]}
    after_ms = acc_state.get("high_water") or None
    if after_ms is None:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=LOOKBACK_DAYS)
        after_ms = int(cutoff.timestamp() * 1000)
    seen_ids = set(acc_state.get("ids", []))

    try:
        service = build_service(token)
        mails = fetch_invoice_mails(service, DECANT["gmail_query"], after_ms, seen_ids)
    except Exception as exc:
        return 0, [f"decant: fetch failed: {exc}"]

    rows: list[dict] = []
    handled = []
    for mail in mails:  # oldest first
        try:
            rows.extend(rows_from_mail(mail, pdf_to_text))
        except Exception as exc:
            errors.append(f"decant: {mail.msg_id} failed: {exc}")
        handled.append(mail)

    sent = store(cfg, rows) if rows else 0
    if rows and not sent:
        # Don't advance past invoices that never reached the app — they'll be
        # fetched again next run (the insert is idempotent).
        return 0, errors + [f"decant: couldn't store {len(rows)} invoice(s) in the decanting project"]

    for mail in handled:
        acc_state["high_water"] = max(acc_state.get("high_water", 0), mail.internal_ms)
        if mail.msg_id not in acc_state["ids"]:
            acc_state["ids"].append(mail.msg_id)
    acc_state["ids"] = acc_state["ids"][-500:]
    return sent, errors
