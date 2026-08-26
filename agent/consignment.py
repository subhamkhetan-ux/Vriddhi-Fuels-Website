"""Consignment-note ingest — the cloud half of the IOCL-invoice automation.

Each run, on the HDFC mailbox (which also receives IndianOil tax invoices), we
look for new mails from ``B2BPRD@indianoil.in`` with a PDF attachment, extract
the invoice fields, and — only for OUR own tank truck — claim a consignment
note in Supabase (idempotent, serial auto-assigned). The /payments app then
lets the user set the reporting date and download the filled Word note.

Everything here is best-effort: a failure is surfaced to the caller as a string
(so it can Telegram-alert) but never sinks the credit-alert ingest. Idempotency
has two layers: a per-mailbox high-water mark in ``seen`` (so we don't re-fetch
old invoices) and the DB claim RPC (so a note is never double-created).
"""

from __future__ import annotations

import datetime as dt

from . import invoice as invoice_mod
from . import state_store
from .config import ACCOUNTS, CONSIGNMENT, LOOKBACK_DAYS

# Separate high-water key so it never collides with the credit-alert cursor for
# the same mailbox.
SEEN_KEY = "consignment"


def _account_token_env() -> str | None:
    for acc in ACCOUNTS:
        if acc["id"] == CONSIGNMENT["account_id"]:
            return acc["token_env"]
    return None


def _note_from_invoice(msg_id: str, fields: invoice_mod.InvoiceFields) -> dict:
    return {
        "id": state_store.entry_id(msg_id),
        "gmail_msg_id": msg_id,
        "invoice_no": fields.invoice_no,
        "invoice_date": fields.invoice_date,
        "tt_no": fields.tt_no,
        "product": fields.product,
        "column_key": fields.column_key,
        "qty": fields.qty,
        "value": fields.value,
    }


def run(seen: dict) -> tuple[int, list[str]]:
    """Scan for new IOCL invoices and claim consignment notes for our own TT.

    Returns ``(created, errors)``. Advances the high-water mark past every mail
    handled (ours or not) so we never re-scan it. Best-effort: import/auth/parse
    problems are returned as error strings, not raised."""
    import os

    from . import supabase_sync

    errors: list[str] = []
    if not supabase_sync.enabled():
        # Nowhere to store notes — skip quietly (payments still work).
        return 0, errors

    token_env = _account_token_env()
    token = os.environ.get(token_env) if token_env else None
    if not token:
        return 0, [f"consignment: missing secret {token_env}"]

    try:
        from .gmail_client import build_service, fetch_invoice_mails, pdf_to_text
    except Exception as exc:  # pragma: no cover - import guard
        return 0, [f"consignment: gmail client unavailable: {exc}"]

    acc_state = seen.setdefault(SEEN_KEY, {"high_water": 0, "ids": []})
    after_ms = acc_state.get("high_water") or None
    if after_ms is None:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=LOOKBACK_DAYS)
        after_ms = int(cutoff.timestamp() * 1000)
    seen_ids = set(acc_state.get("ids", []))

    own_tt = CONSIGNMENT["own_tt"].upper()
    min_invoice_no = str(CONSIGNMENT.get("min_invoice_no") or "")
    created = 0
    try:
        service = build_service(token)
        mails = fetch_invoice_mails(service, CONSIGNMENT["gmail_query"],
                                    after_ms, seen_ids)
    except Exception as exc:
        return 0, [f"consignment: fetch failed: {exc}"]

    for mail in mails:  # oldest first
        try:
            handled = _handle_mail(mail, own_tt, pdf_to_text, supabase_sync,
                                   min_invoice_no)
            created += handled
        except Exception as exc:
            errors.append(f"consignment: {mail.msg_id} failed: {exc}")
        # advance the mark past this mail regardless (we've handled it)
        acc_state["high_water"] = max(acc_state.get("high_water", 0), mail.internal_ms)
        if mail.msg_id not in acc_state["ids"]:
            acc_state["ids"].append(mail.msg_id)

    acc_state["ids"] = acc_state["ids"][-500:]
    return created, errors


def _handle_mail(mail, own_tt: str, pdf_to_text, supabase_sync,
                 min_invoice_no: str = "") -> int:
    """Extract the first usable own-TT invoice from a mail's PDFs and claim a
    note. Returns 1 if a note was claimed, else 0."""
    for pdf in mail.pdfs:
        text = pdf_to_text(pdf)
        fields = invoice_mod.extract_fields(text)
        # Only our own truck; ignore invoices for other trucks / customers.
        if not fields.tt_no or fields.tt_no.upper() != own_tt:
            continue
        # Anchor: only number invoices from min_invoice_no onward. Older ones
        # (smaller IOCL document number) were noted manually up to 046 — skip
        # them quietly, they are not errors.
        if (min_invoice_no and fields.invoice_no and fields.invoice_no.isdigit()
                and int(fields.invoice_no) < int(min_invoice_no)):
            continue
        if not invoice_mod.is_complete(fields):
            # A partial parse on our own truck is worth surfacing loudly.
            raise ValueError(
                f"own-TT invoice {fields.invoice_no or '?'} parsed incompletely: "
                f"date={fields.invoice_date} product={fields.product} "
                f"qty={fields.qty} value={fields.value}")
        note = _note_from_invoice(mail.msg_id, fields)
        claimed = supabase_sync.claim_consignment(note)
        if claimed is None:
            raise RuntimeError("supabase claim_consignment returned nothing")
        return 1
    return 0
