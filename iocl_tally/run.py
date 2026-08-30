"""Orchestrator: IOCL PAD statement PDF -> Tally import XML + review sheet.

    python3 -m iocl_tally.run --pad PAD.pdf --out OUTDIR [--invoices DIR]

Parses the PAD, reconciles the running balance, generates one voucher per
postable line against ``M/s Indian Oil Corporation Limited``, and writes:

  * ``IOCL_import.xml``  — the combined Tally 'Import Data' envelope
  * ``IOCL_review.csv``  — every PAD line, its mapping, and OK / SKIPPED status

Journals (TDS, Fleet, Collection, K1, License, Dealer Margin, NFR, Interest) are
generated in full. Purchases need the matching invoice PDF for their base /
per-product VAT / round-off split; without one the line is SKIPPED and flagged
(handoff decision §2), so every other voucher still generates.
"""

from __future__ import annotations

import argparse
import csv
import os

from . import invoice_parser as IP
from . import pad_parser as P
from . import xml_generator as G

# Counter ledger shown in the review sheet (informational).
COUNTER_LEDGER = {
    "TDS": "TDS CREDIT NOTE IOCL 2025-26",
    "FLEET": "Fleet Card Posting",
    "COLLECTION": "HDFC BANK OD A/C - 50200110712542",
    "K1": "K1 PARTICIPATION FEE",
    "LICENSE": "License Fee Recovery",
    "DEALERMARGIN": "Dealer Margin 2026-27",
    "NFR": "NFR Fee IOCL",
    "INTEREST": "Interest Paid",
    "PURCHASE": "PURCHASE HSD MS & XG + VAT + R/off (from invoice)",
}
OPEN_DELIVERY_LABEL = "Open Delivery value in all CCA"


def _ymd(date) -> str:
    return f"{date.year}{date.month:02d}{date.day:02d}"


def _is_ca_collection(rec) -> bool:
    return rec.category == "COLLECTION" and "5921701" in rec.item_text


def load_invoices(invoices_dir: str | None) -> dict:
    """Index invoices in a folder by their document number, for purchase matching.

    Returns ``{invoice_no: Invoice}``. Best-effort: an unreadable/again-unparsable
    PDF is skipped (the purchase then simply has no match and is flagged)."""
    index: dict = {}
    if not invoices_dir or not os.path.isdir(invoices_dir):
        return index
    for name in sorted(os.listdir(invoices_dir)):
        if name.startswith(".") or not name.lower().endswith(".pdf"):
            continue
        try:
            text = P.extract_text(os.path.join(invoices_dir, name))
            iv = IP.parse_invoice(text)
        except Exception:
            continue
        if iv.invoice_no:
            index[iv.invoice_no] = iv
    return index


def process(text: str, invoices_dir: str | None = None, invoices: dict | None = None):
    """Parse + generate. Returns ``(records, vouchers, review_rows, summary)``."""
    records, summary = P.parse(text)
    if invoices is None:
        invoices = load_invoices(invoices_dir)
    vouchers: list[str] = []
    review: list[dict] = []

    counts = {}
    skipped_purchases = 0
    for r in records:
        if r.category == P.CAT_OPENING:
            continue
        status = "OK"
        vtype = "Journal"
        note = ""
        if r.category == P.CAT_PURCHASE:
            vtype = "Purchase"
            iv = invoices.get(r.doc_number or "")
            if iv is None:
                status, note = "SKIPPED", "no matching invoice PDF"
                skipped_purchases += 1
            elif not iv.is_complete():
                status, note = "SKIPPED", f"invoice {r.doc_number} parsed incompletely"
                skipped_purchases += 1
            elif abs((iv.total or 0) - r.debit) >= 0.005:
                status, note = "SKIPPED", (
                    f"invoice total {iv.total} != PAD amount {r.debit:.2f}")
                skipped_purchases += 1
            else:
                vch = G.make_purchase(iv, _ymd(r.date), reference=r.doc_number)
                if vch is None:
                    status, note = "SKIPPED", (
                        "unsupported product mix "
                        f"({', '.join(p.description for p in iv.products)})")
                    skipped_purchases += 1
                elif not G.purchase_balances(vch):
                    status, note = "SKIPPED", "purchase voucher did not balance"
                    skipped_purchases += 1
                else:
                    vouchers.append(vch)
                    counts["PURCHASE"] = counts.get("PURCHASE", 0) + 1
        elif r.category in G.JOURNAL_TEMPLATES:
            vch = G.make_journal(
                r.category, _ymd(r.date), r.amount,
                reference=r.doc_number or r.fleet_ref,
                collection_to_ca=_is_ca_collection(r))
            if not G.voucher_balances(vch):
                status, note = "SKIPPED", "voucher did not balance"
            else:
                vouchers.append(vch)
                counts[r.category] = counts.get(r.category, 0) + 1
        else:
            status, note = "SKIPPED", f"unmapped category {r.category}"

        review.append({
            "index": r.index,
            "date": r.date.strftime("%d-%m-%Y") if r.date else "",
            "category": r.category,
            "voucher_type": vtype,
            "doc_number": r.doc_number or r.fleet_ref or "",
            "debit": f"{r.debit:.2f}",
            "credit": f"{r.credit:.2f}",
            "balance": f"{r.balance:.2f}",
            "reconciles": "yes" if r.reconciles else "NO",
            "counter_ledger": COUNTER_LEDGER.get(r.category, ""),
            "status": status,
            "note": note,
        })

    open_delivery = None
    if summary["closing_stated"] is not None:
        # The PAD's stated closing minus our last transactional balance is the
        # non-transactional 'Open Delivery value in all CCA' add-on (never posted).
        m = _stated_closing(text)
        if m is not None:
            open_delivery = round(m - summary["closing_stated"], 2)

    summary = {
        **summary,
        "n_vouchers": len(vouchers),
        "counts": counts,
        "skipped_purchases": skipped_purchases,
        "stated_closing": _stated_closing(text),
        "open_delivery_addon": open_delivery,
    }
    return records, vouchers, review, summary


def _stated_closing(text: str):
    import re
    m = re.search(r"Closing Balance:\s*Rs\s*(-?[\d,]+\.\d{2})", text)
    return float(m.group(1).replace(",", "")) if m else None


def write_outputs(out_dir: str, vouchers: list[str], review: list[dict]) -> tuple[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    xml_path = os.path.join(out_dir, "IOCL_import.xml")
    csv_path = os.path.join(out_dir, "IOCL_review.csv")
    with open(xml_path, "w", encoding="utf-8") as fh:
        fh.write(G.build_envelope(vouchers))
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(review[0].keys()) if review else [])
        if review:
            w.writeheader()
            w.writerows(review)
    return xml_path, csv_path


def main(argv=None):
    ap = argparse.ArgumentParser(description="IOCL PAD -> Tally import XML")
    ap.add_argument("--pad", required=True, help="PAD statement PDF")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--invoices", help="folder of IOCL invoice PDFs (for purchases)")
    args = ap.parse_args(argv)

    text = P.extract_text(args.pad)
    records, vouchers, review, summary = process(text, args.invoices)
    xml_path, csv_path = write_outputs(args.out, vouchers, review)

    print(f"Parsed {summary['n_postable']} postable lines "
          f"({summary['n_records']} total).")
    print(f"Reconciles: {summary['reconciles']}"
          + ("" if summary["reconciles"]
             else f"  (first break at #{summary['first_break']})"))
    if summary["open_delivery_addon"] is not None:
        print(f"Open Delivery add-on (not posted): {summary['open_delivery_addon']:.2f}")
    print(f"Vouchers generated: {summary['n_vouchers']}  "
          f"{summary['counts']}")
    print(f"Purchases skipped (need invoice): {summary['skipped_purchases']}")
    print(f"Wrote {xml_path}\n      {csv_path}")


if __name__ == "__main__":
    main()
