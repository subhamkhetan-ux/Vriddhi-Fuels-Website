"""Fuel-credit invoice ingest — sum ALL IOCL invoices for the dues tracker.

Unlike ``consignment.py`` (own TT only), this captures **every** IndianOil tax
invoice (all trucks) and mirrors each one's grand total to Supabase
(``pay_fuel_invoices``), so the /payments **Credit** section can build the T+2
working-day repayment schedule and reconcile it against the balance you paste in.

Idempotent by invoice number (the DB primary key), and best-effort like the rest
of the agent: any auth/parse/network problem is returned as an error string, not
raised, so it never sinks the credit-alert ingest. A separate high-water mark
keeps it from re-scanning old mail.
"""

from __future__ import annotations

import datetime as dt
import os
import re

from . import invoice as invoice_mod
from . import state_store
from .config import ACCOUNTS, CREDIT, LOOKBACK_DAYS

# Separate high-water key so it never collides with the credit-alert or
# consignment cursors for the same mailbox.
SEEN_KEY = "credit_invoices"


def _dmy_to_iso(dmy: str) -> str:
    """dd/mm/yyyy -> yyyy-mm-dd (for date comparison); '' if unparseable."""
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", (dmy or "").strip())
    return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}" if m else ""


def _account_token_env() -> str | None:
    for acc in ACCOUNTS:
        if acc["id"] == CREDIT["account_id"]:
            return acc["token_env"]
    return None


def _invoice_row(msg_id: str, fields: invoice_mod.InvoiceFields) -> dict:
    return {
        "invoice_no": fields.invoice_no,
        "invoice_date": fields.invoice_date,   # dd/mm/yyyy
        "tt_no": fields.tt_no,
        "amount": fields.value,                # invoice grand total, rupees
        "gmail_msg_id": msg_id,
    }


def run(seen: dict) -> tuple[int, list[str]]:
    """Scan for IOCL invoice mail and upsert every invoice's total to Supabase.

    Returns ``(upserted, errors)``. Advances the high-water mark past every mail
    handled so we never re-scan it; the DB primary key on ``invoice_no`` makes a
    re-processed invoice a no-op anyway."""
    import os

    from . import supabase_sync

    errors: list[str] = []
    if not supabase_sync.enabled():
        return 0, errors

    token_env = _account_token_env()
    token = os.environ.get(token_env) if token_env else None
    if not token:
        return 0, [f"credit: missing secret {token_env}"]

    try:
        from .gmail_client import build_service, fetch_invoice_mails, pdf_to_text
    except Exception as exc:  # pragma: no cover - import guard
        return 0, [f"credit: gmail client unavailable: {exc}"]

    acc_state = seen.setdefault(SEEN_KEY, {"high_water": 0, "ids": []})
    after_ms = acc_state.get("high_water") or None
    if after_ms is None:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=LOOKBACK_DAYS)
        after_ms = int(cutoff.timestamp() * 1000)
    seen_ids = set(acc_state.get("ids", []))

    try:
        service = build_service(token)
        mails = fetch_invoice_mails(service, CREDIT["gmail_query"], after_ms, seen_ids)
    except Exception as exc:
        return 0, [f"credit: fetch failed: {exc}"]

    rows: list[dict] = []
    prices: dict = {}                    # col_key -> {price, as_of, invoice_no} (newest date wins)
    for mail in mails:  # oldest first
        try:
            inv_rows, obs = _rows_from_mail(mail, pdf_to_text)
            rows.extend(inv_rows)
            for o in obs:
                cur = prices.get(o["col_key"])
                if (cur is None) or (o["as_of"] > cur["as_of"]):
                    prices[o["col_key"]] = o
        except Exception as exc:
            errors.append(f"credit: {mail.msg_id} failed: {exc}")
        acc_state["high_water"] = max(acc_state.get("high_water", 0), mail.internal_ms)
        if mail.msg_id not in acc_state["ids"]:
            acc_state["ids"].append(mail.msg_id)

    acc_state["ids"] = acc_state["ids"][-500:]

    upserted = 0
    if rows:
        upserted = supabase_sync.upsert_fuel_invoices(rows)
    if prices:
        supabase_sync.upsert_fuel_prices(
            {k: {"price": v["price"], "as_of": v["as_of"], "invoice_no": v["invoice_no"]}
             for k, v in prices.items()})
    return upserted, errors


def _sap_entry_no(filename: str, text_invoice_no: str | None) -> str | None:
    """The invoice's unique key = its SAP entry number, which is the PDF filename.

    IndianOil occasionally resends the same invoice as a fresh mail; keying on
    the filename (rather than the text-parsed number, which a resend can format
    differently) means the duplicate collapses onto the same DB row. Prefer the
    canonical 10-digit IOCL document number when the filename carries it (so we
    match keys already stored), else the filename stem, else the parsed number.
    """
    stem = os.path.splitext(os.path.basename((filename or "").strip()))[0].strip()
    m = re.search(r"70\d{8}", stem)
    if m:
        return m.group(0)
    return stem or text_invoice_no


def _rows_from_mail(mail, pdf_to_text):
    """From each usable PDF in a mail (any truck): the invoice row for the dues
    total, plus a per-product price observation (after-VAT ₹/KL). Rows are keyed
    on the SAP entry number (the PDF filename), so a resent invoice is deduped —
    within this mail here, and across mails by the ``invoice_no`` primary key.
    Returns ``(invoice_rows, price_observations)``."""
    inv_rows: list[dict] = []
    obs: list[dict] = []
    seen_nos: set[str] = set()
    names = getattr(mail, "pdf_names", None) or []
    for idx, pdf in enumerate(mail.pdfs):
        text = pdf_to_text(pdf)
        fields = invoice_mod.extract_fields(text)
        if not (fields.invoice_date and fields.value):
            continue
        key = _sap_entry_no(names[idx] if idx < len(names) else "", fields.invoice_no)
        if not key or key in seen_nos:                 # missing key, or the same invoice again
            continue
        seen_nos.add(key)
        row = _invoice_row(mail.msg_id, fields)
        row["invoice_no"] = key                        # dedupe on the SAP entry number
        inv_rows.append(row)
        as_of = _dmy_to_iso(fields.invoice_date)
        for line in fields.lines:
            ppk = line.price_per_kl
            if ppk and as_of:
                obs.append({"col_key": line.column_key, "price": ppk,
                            "as_of": as_of, "invoice_no": key})
    return inv_rows, obs
