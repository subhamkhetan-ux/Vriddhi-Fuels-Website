"""Pure extraction of the consignment-note fields from an Indian Oil tax
invoice's text (spec: auto-generate a consignment note for own TT).

Kept dependency-free and text-only so it is unit-testable without a PDF: the
Gmail/PDF plumbing (``consignment.py``) hands the already-extracted text here.
The invoice is a fixed IOCL layout; the anchors below are the stable labels on
it. A missing field yields ``None`` for that field so the caller can decide
whether the invoice is usable (a real IOCL invoice always has invoice no, date,
TT, product, qty and value).
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

# Template quantity columns, in the order they appear on the consignment note.
# The invoice's product description is mapped onto exactly one of these.
COLUMN_MS_EBMS = "MS | EBMS"
COLUMN_XTRAGREEN = "XtraGreen HSD"
COLUMN_HSD = "HSD"
COLUMN_LSHF = "LSHFHSD"


@dataclass
class InvoiceFields:
    invoice_no: str | None
    invoice_date: str | None      # normalized dd/mm/yyyy
    tt_no: str | None
    product: str | None           # raw description, e.g. "HSD-BSVI [PDRP]"
    column_key: str | None        # which template column the product maps to
    qty: str | None               # integer KL as a string, e.g. "22"
    value: int | None             # value of goods, whole rupees


def _norm_date(s: str) -> str | None:
    s = s.strip()
    for fmt in ("%d-%b-%Y", "%d-%b-%y", "%d/%m/%Y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(s, fmt).strftime("%d/%m/%Y")
        except ValueError:
            continue
    return None


def product_column(product: str) -> str:
    """Map an IOCL product description onto a consignment-note quantity column.

    Defaults to plain HSD (the common case: "HSD-BSVI [PDRP]") when nothing more
    specific matches."""
    u = (product or "").upper()
    if "XTRAGREEN" in u or "XTRA GREEN" in u or "XTRAGRN" in u:
        return COLUMN_XTRAGREEN
    if "LSHF" in u:
        return COLUMN_LSHF
    if "EBMS" in u or re.match(r"\s*MS\b", u):
        return COLUMN_MS_EBMS
    return COLUMN_HSD


def extract_fields(text: str) -> InvoiceFields:
    """Pull the consignment-note-relevant fields out of the invoice text."""
    lines = [ln.rstrip() for ln in text.splitlines()]

    # Invoice number: the 10-digit IOCL document number (starts with 70).
    m = re.search(r"\b(70\d{8})\b", text)
    invoice_no = m.group(1) if m else None

    # Invoice date: the value on the line after a bare "Date" label; fall back
    # to the first dd-Mon-yy anywhere.
    invoice_date = None
    for i, ln in enumerate(lines):
        if ln.strip() == "Date" and i + 1 < len(lines):
            cand = lines[i + 1].strip()
            if re.match(r"\d{1,2}-[A-Za-z]{3}-\d{2,4}", cand):
                invoice_date = _norm_date(cand)
                break
    if not invoice_date:
        m = re.search(r"\b(\d{1,2}-[A-Za-z]{3}-\d{2,4})\b", text)
        if m:
            invoice_date = _norm_date(m.group(1))

    # Tank-truck registration number, e.g. OD23U8210.
    m = re.search(r"\b([A-Z]{2}\d{2}[A-Z]{1,2}\d{3,4})\b", text)
    tt_no = m.group(1) if m else None

    # Product + quantity: the item line "<material-code>   <DESCRIPTION>",
    # followed within a few lines by "<qty>" then the unit "KL".
    product = qty = None
    for i, ln in enumerate(lines):
        pm = re.match(r"\s*\d{4,6}\s+([A-Z][^\n]*?)\s*$", ln)
        if not pm:
            continue
        desc = pm.group(1).strip()
        if not re.search(r"HSD|MS|EBMS|LSHF|PETROL|DIESEL", desc.upper()):
            continue
        for j in range(i + 1, min(i + 4, len(lines))):
            qm = re.match(r"^(\d+(?:\.\d+)?)$", lines[j].strip())
            if qm:
                product = desc
                qty = str(int(round(float(qm.group(1)))))
                break
        if product:
            break

    # Value of goods: the grand total — the numeric value on the line after the
    # LAST bare "Total" label (i.e. after the rounding line). Falls back to the
    # "Total for material" figure, rounded.
    value = None
    for i in range(len(lines) - 1, 0, -1):
        if lines[i - 1].strip() == "Total" and re.match(r"^\d+(?:\.\d+)?$", lines[i].strip()):
            value = int(round(float(lines[i].strip())))
            break
    if value is None:
        m = re.search(r"Total for material\s*\n\s*([\d.]+)", text)
        if m:
            value = int(round(float(m.group(1))))

    return InvoiceFields(
        invoice_no=invoice_no,
        invoice_date=invoice_date,
        tt_no=tt_no,
        product=product,
        column_key=product_column(product) if product else None,
        qty=qty,
        value=value,
    )


def is_complete(f: InvoiceFields) -> bool:
    """True when every field the consignment note needs was found."""
    return all([f.invoice_no, f.invoice_date, f.tt_no, f.product, f.qty, f.value])
