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

from . import invoice as invoice_mod
from . import state_store
from .config import ACCOUNTS, CREDIT, LOOKBACK_DAYS

# Separate high-water key so it never collides with the credit-alert or
# consignment cursors for the same mailbox.
SEEN_KEY = "credit_invoices"


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
    for mail in mails:  # oldest first
        try:
            rows.extend(_rows_from_mail(mail, pdf_to_text))
        except Exception as exc:
            errors.append(f"credit: {mail.msg_id} failed: {exc}")
        acc_state["high_water"] = max(acc_state.get("high_water", 0), mail.internal_ms)
        if mail.msg_id not in acc_state["ids"]:
            acc_state["ids"].append(mail.msg_id)

    acc_state["ids"] = acc_state["ids"][-500:]

    upserted = 0
    if rows:
        upserted = supabase_sync.upsert_fuel_invoices(rows)
    return upserted, errors


def _rows_from_mail(mail, pdf_to_text) -> list[dict]:
    """Extract one invoice row per usable PDF in a mail (any truck)."""
    out: list[dict] = []
    seen_nos: set[str] = set()
    for pdf in mail.pdfs:
        text = pdf_to_text(pdf)
        fields = invoice_mod.extract_fields(text)
        # Need at least an invoice number, a date and an amount to schedule it.
        if not (fields.invoice_no and fields.invoice_date and fields.value):
            continue
        if fields.invoice_no in seen_nos:
            continue
        seen_nos.add(fields.invoice_no)
        out.append(_invoice_row(mail.msg_id, fields))
    return out
