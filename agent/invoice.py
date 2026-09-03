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
from dataclasses import dataclass, field

# Template quantity columns, in the order they appear on the consignment note.
# The invoice's product description is mapped onto exactly one of these.
COLUMN_MS_EBMS = "MS | EBMS"
COLUMN_XTRAGREEN = "XtraGreen HSD"
COLUMN_HSD = "HSD"
COLUMN_LSHF = "LSHFHSD"


@dataclass
class ProductLine:
    """One product row off the invoice (an invoice can carry several, e.g. an
    MS load and an HSD load on the same TT)."""
    product: str                  # raw description, e.g. "HSD-BSVI [PDRP]"
    column_key: str               # which template column this product maps to
    qty: str                      # integer KL as a string, e.g. "22"


@dataclass
class InvoiceFields:
    invoice_no: str | None
    invoice_date: str | None      # normalized dd/mm/yyyy
    tt_no: str | None
    product: str | None           # raw description of the FIRST product (back-compat/display)
    column_key: str | None        # column the first product maps to (back-compat)
    qty: str | None               # first product's qty (back-compat)
    value: int | None             # value of goods, whole rupees (grand total, all products)
    # Every product line on the invoice, in order. ``product``/``column_key``/
    # ``qty`` above mirror ``lines[0]`` so single-product callers keep working.
    lines: list[ProductLine] = field(default_factory=list)
    # Template quantity per column, summed across lines that share a column,
    # e.g. {"MS | EBMS": "5", "HSD": "17"}. This is what the note fills in.
    columns: dict[str, str] = field(default_factory=dict)


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

    # Product + quantity: each item line "<material-code>   <DESCRIPTION>",
    # followed within a few lines by "<qty>" then the unit "KL". An invoice can
    # list SEVERAL products for the same TT (e.g. MS and HSD on one load), so we
    # collect every product line, not just the first.
    product_lines: list[ProductLine] = []
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
                product_lines.append(ProductLine(
                    product=desc,
                    column_key=product_column(desc),
                    qty=str(int(round(float(qm.group(1))))),
                ))
                break

    # Sum quantities per template column (two lines can share one column).
    columns: dict[str, str] = {}
    for pl in product_lines:
        prev = int(columns.get(pl.column_key, "0"))
        columns[pl.column_key] = str(prev + int(pl.qty))

    first = product_lines[0] if product_lines else None

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
        product=first.product if first else None,
        column_key=first.column_key if first else None,
        qty=first.qty if first else None,
        value=value,
        lines=product_lines,
        columns=columns,
    )


def is_complete(f: InvoiceFields) -> bool:
    """True when every field the consignment note needs was found."""
    return all([f.invoice_no, f.invoice_date, f.tt_no, f.product, f.qty, f.value])
