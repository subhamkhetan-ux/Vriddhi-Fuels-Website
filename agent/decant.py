"""Tanker-decanting feed — every IOCL invoice with its chamber table, for /decant.

Same mailbox and sender as ``credit.py`` (all trucks), but this mirrors what the
/decant app needs to plan a decantation: the tank truck, each product line with
the chambers it was loaded into ("Comp No(s)") and its density, and the truck's
chamber table (PL / DIP / QTY per chamber). Rows go to Supabase
``dec_invoices``, keyed on the SAP entry number like the credit rows.

Insert-if-absent: once a row exists the app owns it (the user may correct a
chamber or dismiss an invoice there), so a re-scan never overwrites it. A
separate high-water mark lets the first run back-fill the last
``LOOKBACK_DAYS`` of invoices without touching the credit/consignment cursors.
Best-effort like the rest of the agent: problems come back as error strings.
"""

from __future__ import annotations

import datetime as dt

from . import invoice as invoice_mod
from .config import ACCOUNTS, DECANT, LOOKBACK_DAYS

SEEN_KEY = "decant_invoices"


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
    import os

    from . import supabase_sync

    errors: list[str] = []
    if not supabase_sync.enabled():
        return 0, errors
    if not supabase_sync.decant_table_ready():
        # Schema not run yet (or Supabase unreachable): leave the cursor where it
        # is so the first successful run back-fills, and don't alert every run.
        print("Decant: dec_invoices not reachable — run supabase/decant-schema.sql; skipping.")
        return 0, errors

    token_env = _account_token_env()
    token = os.environ.get(token_env) if token_env else None
    if not token:
        return 0, [f"decant: missing secret {token_env}"]

    try:
        from .gmail_client import build_service, fetch_invoice_mails, pdf_to_text
    except Exception as exc:  # pragma: no cover - import guard
        return 0, [f"decant: gmail client unavailable: {exc}"]

    acc_state = seen.setdefault(SEEN_KEY, {"high_water": 0, "ids": []})
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

    sent = supabase_sync.upsert_decant_invoices(rows) if rows else 0
    if rows and not sent:
        # Don't advance past invoices that never reached the app — they'll be
        # fetched again next run (the insert is idempotent).
        return 0, errors + [f"decant: couldn't store {len(rows)} invoice(s) in Supabase"]

    for mail in handled:
        acc_state["high_water"] = max(acc_state.get("high_water", 0), mail.internal_ms)
        if mail.msg_id not in acc_state["ids"]:
            acc_state["ids"].append(mail.msg_id)
    acc_state["ids"] = acc_state["ids"][-500:]
    return sent, errors
