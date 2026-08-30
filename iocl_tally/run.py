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
import re

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




def normalize_dir(path: str | None) -> str:
    """Make a pasted folder path usable.

    macOS users paste paths two ways: dragged from Terminal (shell-escaped, e.g.
    ``com\\~apple\\~CloudDocs`` and ``\\ `` for spaces) or copied from Finder's
    Get Info (plain). Un-escape the shell form, drop surrounding quotes, and
    expand ``~`` so either paste resolves to the real directory."""
    if not path:
        return ""
    p = path.strip().strip('"').strip("'")
    p = re.sub(r"\\(.)", r"\1", p)          # \  -> space, \~ -> ~, \\ -> \
    return os.path.expanduser(p)


def load_invoices(invoices_dir: str | None) -> dict:
    """Index invoices under a folder (and its subfolders) by document number.

    Returns ``{invoice_no: Invoice}``. Recurses so a folder organised by month
    (``…/IOCL Challan/2026/August 2026/…``) is covered when you point at the
    ``2026`` parent. Best-effort: an unreadable/again-unparsable PDF is skipped
    (the purchase then simply has no match and is flagged)."""
    index: dict = {}
    root = normalize_dir(invoices_dir)
    if not root or not os.path.isdir(root):
        return index
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            if name.startswith(".") or not name.lower().endswith(".pdf"):
                continue
            try:
                text = P.extract_text(os.path.join(dirpath, name))
                iv = IP.parse_invoice(text)
            except Exception:
                continue
            if iv.invoice_no:
                index[iv.invoice_no] = iv
    return index


def process(text: str, invoices_dir: str | None = None, invoices: dict | None = None,
            tt_state: dict | None = None):
    """Parse + generate. Returns ``(records, vouchers, review_rows, summary)``.

    ``tt_state`` (``{"next_tt": N, "issued": {...}}``) carries the manual TT
    voucher-number counter for purchases; it is mutated in place so the caller
    can persist it. Defaults to starting at TT001 if not given."""
    records, summary = P.parse(text)
    if invoices is None:
        invoices = load_invoices(invoices_dir)
    if tt_state is None:
        tt_state = {"next_tt": 1, "issued": {}}
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
        counter_ledger = COUNTER_LEDGER.get(r.category, "")
        if r.category == "COLLECTION":
            counter_ledger = G.collection_route(r.item_text)[1]
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
            elif G.choose_purchase_template(iv.products) is None:
                status, note = "SKIPPED", (
                    "unsupported product mix "
                    f"({', '.join(p.description for p in iv.products)})")
                skipped_purchases += 1
            else:
                tt = G.assign_tt(tt_state, r.doc_number)
                vch = G.make_purchase(iv, _ymd(r.date), reference=r.doc_number,
                                      voucher_number=tt)
                if not G.purchase_balances(vch):
                    status, note = "SKIPPED", "purchase voucher did not balance"
                    skipped_purchases += 1
                else:
                    vouchers.append(vch)
                    vtype = f"Purchase ({tt})"
                    counts["PURCHASE"] = counts.get("PURCHASE", 0) + 1
        elif r.category in G.JOURNAL_TEMPLATES:
            vch = G.make_journal(
                r.category, _ymd(r.date), r.amount,
                reference=r.doc_number or r.fleet_ref,
                collection_item_text=r.item_text)
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
            "counter_ledger": counter_ledger,
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
    purch_path = os.path.join(out_dir, "IOCL_purchases.xml")
    with open(xml_path, "w", encoding="utf-8") as fh:
        fh.write(G.build_envelope(vouchers))
    # A purchases-only file, so purchases can be re-imported (e.g. to fix their
    # numbering) without duplicating journals that already imported fine.
    purchases = [v for v in vouchers
                 if "<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>" in v]
    with open(purch_path, "w", encoding="utf-8") as fh:
        fh.write(G.build_envelope(purchases))
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
    ap.add_argument("--tt-start", type=int, default=96,
                    help="first purchase (TT) voucher number to assign")
    args = ap.parse_args(argv)

    text = P.extract_text(args.pad)
    tt_state = {"next_tt": args.tt_start, "issued": {}}
    records, vouchers, review, summary = process(
        text, args.invoices, tt_state=tt_state)
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
