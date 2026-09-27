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
import os
import re
from dataclasses import dataclass, field

# Template quantity columns, in the order they appear on the consignment note.
# The invoice's product description is mapped onto exactly one of these.
COLUMN_MS_EBMS = "MS | EBMS"
COLUMN_XTRAGREEN = "XtraGreen HSD"
COLUMN_HSD = "HSD"
COLUMN_LSHF = "LSHFHSD"

# Loading terminal → the "Place of Origin" line printed on the consignment note.
# The invoice always names the supplying IOCL terminal; we detect the terminal's
# town in the invoice text and print its full address. Jharsuguda is the usual
# terminal and the safe default when nothing else is recognised. Add a row here
# for any new terminal (key = an UPPERCASE token that appears in that terminal's
# invoices; first match wins).
DEFAULT_ORIGIN = "Jharsuguda Terminal, Jharsuguda, Odisha"
TERMINALS = {
    "JHARSUGUDA": "Jharsuguda Terminal, Jharsuguda, Odisha",
    "PARADEEP":   "Paradeep Terminal, Paradeep, Odisha",
    "PARADIP":    "Paradeep Terminal, Paradeep, Odisha",
}


def parse_origin(text: str) -> str:
    """The Place of Origin = the loading terminal named in the invoice.

    Scans the invoice text for a known terminal token and returns its full
    address; falls back to the usual Jharsuguda terminal when none is found, so a
    note is never left without an origin.
    """
    upper = (text or "").upper()
    for token, full in TERMINALS.items():
        if token in upper:
            return full
    return DEFAULT_ORIGIN


@dataclass
class Chamber:
    """One row of the tank-truck compartment table printed at the foot of every
    IOCL invoice ("PL - cm | DIP - Cm | QTY - kl"), in printed order."""
    no: int                       # 1-based chamber number (row order on the invoice)
    pl_cm: float | None           # the "PL - cm" column, as printed
    dip_cm: float | None          # calibrated dip mark of the chamber, cm
    qty_kl: float                 # chamber quantity, KL (e.g. 5.0)


@dataclass
class ProductLine:
    """One product row off the invoice (an invoice can carry several, e.g. an
    MS load and an HSD load on the same TT)."""
    product: str                  # raw description, e.g. "HSD-BSVI [PDRP]"
    column_key: str               # which template column this product maps to
    qty: str                      # integer KL as a string, e.g. "22"
    value: int | None = None      # this product's "Total for material" (after-VAT ₹)
    qty_kl: float | None = None   # exact quantity as printed, KL (e.g. 17.0)
    # Chambers this product was loaded into ("Comp No(s) 2,3,4,5"). Empty when
    # the invoice doesn't say — a single-product load fills every chamber.
    compartments: list[int] = field(default_factory=list)
    density15: float | None = None    # "Density@15: 829.300" (kg/m³)
    terminal_tank: str | None = None  # terminal tank it was loaded from ("T002")

    @property
    def price_per_kl(self) -> float | None:
        """After-VAT ₹/KL for this product (value / qty), or None."""
        try:
            q = int(self.qty)
            return round(self.value / q, 2) if (self.value and q) else None
        except (TypeError, ValueError, ZeroDivisionError):
            return None


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
    # "Place of Origin" for the note — the loading terminal named in the invoice
    # (e.g. Paradeep when loaded there), defaulting to the usual Jharsuguda.
    origin: str = DEFAULT_ORIGIN
    # For the /decant app: invoice time ("HH:MM"), the header "Den@15", the
    # truck's chamber table and the seal / lock numbers.
    invoice_time: str | None = None
    density15: float | None = None
    chambers: list[Chamber] = field(default_factory=list)
    seals: str | None = None


def sap_entry_no(filename: str | None, text_invoice_no: str | None) -> str | None:
    """The invoice's unique key = its SAP entry number, which is the PDF filename.

    IndianOil occasionally resends the same invoice as a fresh mail; keying on the
    filename (rather than the text-parsed number, which a resend can format
    differently) means the duplicate collapses onto the same row / note. Prefer
    the canonical 10-digit IOCL document number when the filename carries it (so
    we match keys already stored), else the filename stem, else the parsed number.
    """
    stem = os.path.splitext(os.path.basename((filename or "").strip()))[0].strip()
    m = re.search(r"70\d{8}", stem)
    if m:
        return m.group(0)
    return stem or text_invoice_no


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


_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def parse_chambers(lines: list[str]) -> list[Chamber]:
    """The tank truck's compartment table at the foot of the invoice::

        PL - cm
        DIP - Cm QTY - kl
        184.9
        140.0
        5.00
        185.2
        ...

    Reads the numbers after the header (one or several per line) up to the first
    line that isn't numeric, three at a time: PL, DIP, QTY. Returns ``[]`` when
    the table is missing or doesn't come out as whole, plausible rows, so a
    misread never invents chambers.
    """
    start = None
    for i, ln in enumerate(lines):
        if re.search(r"QTY\s*-\s*kl", ln, re.I):
            start = i + 1
            break
    if start is None:
        return []
    nums: list[float] = []
    for ln in lines[start:]:
        toks = ln.split()
        if not toks:
            continue                      # blank spacer line
        if not all(_NUM_RE.fullmatch(t) for t in toks):
            break
        nums.extend(float(t) for t in toks)
    if not nums or len(nums) % 3:
        return []
    chambers: list[Chamber] = []
    for n in range(len(nums) // 3):
        pl, dip, qty = nums[3 * n:3 * n + 3]
        # A chamber holds a few KL and dips a couple of metres at most.
        if not (0 <= qty <= 30 and 0 <= dip <= 400 and 0 <= pl <= 400):
            return []
        chambers.append(Chamber(no=n + 1, pl_cm=pl, dip_cm=dip, qty_kl=qty))
    return chambers


def _invoice_time(lines: list[str], text: str) -> str | None:
    """Invoice time "HH:MM": the value under the "Date" label (the IOCL layout
    prints "26-Sep-26 / Date / 14:15"), else the first clock time in the text."""
    for i, ln in enumerate(lines):
        if ln.strip() == "Date" and i + 1 < len(lines):
            m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", lines[i + 1].strip())
            if m:
                return f"{int(m.group(1)):02d}:{m.group(2)}"
    m = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", text)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


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

    # Product lines: each item line "<material-code>   <DESCRIPTION>", followed
    # within a few lines by "<qty>" then "KL", and — within that product's block —
    # a "Total for material" label whose next number is that product's after-VAT
    # value. An invoice can list SEVERAL products for one TT (e.g. MS + HSD), so
    # we collect every product line and its own value (for per-product pricing).
    prod_idx = []
    for i, ln in enumerate(lines):
        pm = re.match(r"\s*\d{4,6}\s+([A-Z][^\n]*?)\s*$", ln)
        if pm and re.search(r"HSD|MS|EBMS|LSHF|PETROL|DIESEL|XTRA", pm.group(1).upper()):
            prod_idx.append((i, pm.group(1).strip()))

    product_lines: list[ProductLine] = []
    for k, (i, desc) in enumerate(prod_idx):
        end = prod_idx[k + 1][0] if k + 1 < len(prod_idx) else len(lines)
        qty = qty_kl = None
        for j in range(i + 1, min(i + 4, end)):
            qm = re.match(r"^(\d+(?:\.\d+)?)$", lines[j].strip())
            if qm:
                qty_kl = float(qm.group(1))
                qty = str(int(round(qty_kl)))
                break
        if qty is None:
            continue
        # "Tank no: T002 Comp No(s) 2,3,4,5, Density@15: 829.300" — which chambers
        # this product went into, its density and the terminal tank it came from.
        block = "\n".join(lines[i + 1:end])
        cm = re.search(r"Comp\s*No\(?s?\)?\s*:?\s*([\d, ]+)", block, re.I)
        compartments = [int(c) for c in re.findall(r"\d+", cm.group(1))] if cm else []
        dm = re.search(r"Density\s*@\s*15\s*:?\s*(\d+(?:\.\d+)?)", block, re.I)
        tm = re.search(r"Tank\s*no\s*:?\s*([A-Z0-9]+)", block, re.I)
        # This product's "Total for material" value, within its block only.
        val = None
        for j in range(i + 1, end):
            if lines[j].strip() == "Total for material":
                for t in range(j + 1, min(j + 3, end)):
                    if re.match(r"^\d+(?:\.\d+)?$", lines[t].strip()):
                        val = int(round(float(lines[t].strip())))
                        break
                break
        product_lines.append(ProductLine(
            product=desc, column_key=product_column(desc), qty=qty, value=val,
            qty_kl=qty_kl, compartments=compartments,
            density15=float(dm.group(1)) if dm else None,
            terminal_tank=tm.group(1) if tm else None))

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

    # Header density "Den@15" (its value sits a line or two below the label).
    m = re.search(r"Den\s*@\s*15\s*:?\s*(\d{3,4}(?:\.\d+)?)", text)
    density15 = float(m.group(1)) if m else None
    m = re.search(r"Seal\s*/\s*Lock\s*no\s*:?\s*([^\n]+)", text, re.I)
    seals = m.group(1).strip() if m else None

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
        origin=parse_origin(text),
        invoice_time=_invoice_time(lines, text),
        density15=density15,
        chambers=parse_chambers(lines),
        seals=seals,
    )


def is_complete(f: InvoiceFields) -> bool:
    """True when every field the consignment note needs was found."""
    return all([f.invoice_no, f.invoice_date, f.tt_no, f.product, f.qty, f.value])
