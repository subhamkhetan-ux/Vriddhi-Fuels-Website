"""Parse an IOCL PAD (Periodic Account of Dealer) statement into transactions.

The PAD PDF is a fixed IndianOil layout whose column headers have been stable
across statements. We extract its text with pymupdf and walk it into one record
per line of the dealer's IOCL account. Each record carries the document type,
document number, date, and the debit / credit / running-balance triple.

Two properties make the parse self-checking:

* **Date anchor.** Every record has exactly one ``dd.mm.yy`` date. Everything
  between the previous record's balance and this date is the record's item text
  / document type / document number; everything after the date up to the balance
  is its numeric tail.
* **Balance chain.** ``balance[i] == balance[i-1] + debit[i] - credit[i]`` to the
  paise. We rebuild it from the stated opening balance and flag any break, so a
  mis-parse can never slip through silently (handoff reconciliation rule §7).

Classification of each record into a posting category is by the stable keywords
in its item text / document-type block (see ``classify``).
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field

# ---- categories (map 1:1 to a voucher template + counter ledger) -----------
CAT_TDS = "TDS"
CAT_FLEET = "FLEET"
CAT_COLLECTION = "COLLECTION"
CAT_PURCHASE = "PURCHASE"
CAT_K1 = "K1"
CAT_LICENSE = "LICENSE"
CAT_DEALERMARGIN = "DEALERMARGIN"
CAT_NFR = "NFR"
CAT_INTEREST = "INTEREST"
CAT_OPENING = "OPENING"          # the OP.BAL line — not posted
CAT_UNKNOWN = "UNKNOWN"

_DATE_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{2})$")
_NUM_RE = re.compile(r"-?\d[\d,]*\.\d{2}|-?\d[\d,]*")
_DOCNO_RE = re.compile(r"\b(70\d{8})\b")          # IOCL SAP document number


@dataclass
class PadRecord:
    index: int
    category: str
    doc_type: str                 # raw document-type text (joined)
    item_text: str                # raw item-text block (joined)
    doc_number: str | None
    date: dt.date | None
    debit: float
    credit: float
    balance: float                # balance stated on the line
    calc_balance: float | None = None   # balance we rebuilt (reconciliation)
    reconciles: bool = True
    fleet_ref: str | None = None  # the 4000…-…… / 20……… fleet reference
    raw_tail: list[str] = field(default_factory=list)

    @property
    def amount(self) -> float:
        """The single non-zero side of the line (debit or credit)."""
        return self.debit if self.debit else self.credit


def _num(tok: str) -> float:
    return float(tok.replace(",", ""))


def _parse_date(y2: str, mm: str, dd: str) -> dt.date:
    return dt.date(2000 + int(y2), int(mm), int(dd))


def classify(item_text: str, doc_type: str) -> str:
    """Map a record's item/doc-type text to a posting category (handoff table)."""
    t = f"{item_text} {doc_type}".upper()
    if "OP.BAL" in t or "CL.BAL" in t:
        return CAT_OPENING
    # Specific sub-types FIRST: several of these are billed as "Billing
    # doc.transfer" too, so only a genuine PRODUCT SUPPLY INVOICE is a purchase.
    if "TDS CREDIT NOTE" in t:
        return CAT_TDS
    if "FLEET" in t:
        return CAT_FLEET
    if "ECOLLECTION" in t or "E COLLECTION" in t:
        return CAT_COLLECTION
    if "K1 PARTICIPATION" in t or "K1PARTICIPATION" in t:
        return CAT_K1
    if "LICENSE FEE" in t or "SSLF" in t or "LICENCE FEE" in t:
        return CAT_LICENSE
    if "DEALER MARGIN" in t:
        return CAT_DEALERMARGIN
    if "NFR" in t or "BALTRNSFR" in t:
        return CAT_NFR
    if "INTREST" in t or "INTEREST" in t or "INT./" in t or "INT/" in t:
        return CAT_INTEREST
    if "PRODUCT SUPPLY INVOICE" in t:
        return CAT_PURCHASE
    return CAT_UNKNOWN


def extract_text(pdf_path: str) -> str:
    """Extract the PAD text (lazy pymupdf import)."""
    import pymupdf

    doc = pymupdf.open(pdf_path)
    try:
        return "".join(page.get_text() for page in doc)
    finally:
        doc.close()


def opening_balance(text: str) -> float | None:
    m = re.search(r"Opening Balance:\s*Rs\s*(-?[\d,]+\.\d{2})", text)
    return _num(m.group(1)) if m else None


def _window_numbers(lines: list[str], lo: int, hi: int) -> list[tuple[int, float]]:
    """``(line_index, value)`` for every numeric token in ``lines[lo:hi]``,
    splitting merged tokens like ``0 2000000.00`` into two."""
    out: list[tuple[int, float]] = []
    for i in range(lo, hi):
        for tok in _NUM_RE.findall(lines[i]):
            out.append((i, _num(tok)))
    return out


def _lock_money(nums: list[tuple[int, float]], prev: float
                ) -> tuple[float, float, float, int] | None:
    """Find (debit, credit, balance, balance_line) in a record's number stream by
    the reconciliation identity ``balance == prev + debit - credit``.

    Scans left to right and returns the FIRST balance that satisfies it with the
    two money tokens immediately before it — so the record's own balance is found
    before any numbers that belong to the next record's header.
    """
    vals = [v for _, v in nums]
    for k in range(2, len(vals)):
        debit, credit, balance = vals[k - 2], vals[k - 1], vals[k]
        if abs(round(prev + debit - credit, 2) - balance) < 0.005:
            return debit, credit, balance, nums[k][0]
    return None


def parse(text: str) -> tuple[list[PadRecord], dict]:
    """Parse the PAD text into records + a reconciliation summary.

    Returns ``(records, summary)`` where summary carries opening/closing balances
    and whether the rebuilt chain ties out.
    """
    lines = [ln.strip() for ln in text.splitlines()]
    date_idx = [i for i, ln in enumerate(lines) if _DATE_RE.match(ln)]

    opening = opening_balance(text)
    records: list[PadRecord] = []

    prev_balance = opening if opening is not None else 0.0
    header_start = 0
    for n, di in enumerate(date_idx):
        next_di = date_idx[n + 1] if n + 1 < len(date_idx) else len(lines)
        header_lines = [x for x in lines[header_start:di] if x]
        item_text = " ".join(header_lines)

        # Skip the opening/closing balance pseudo rows (nothing to post).
        u = item_text.upper()
        if "OP.BAL" in u or "CL.BAL" in u:
            header_start = di + 1
            continue

        m = _DATE_RE.match(lines[di])
        date = _parse_date(m.group(3), m.group(2), m.group(1))

        nums = _window_numbers(lines, di + 1, next_di)
        locked = _lock_money(nums, prev_balance)
        if locked:
            debit, credit, balance, bal_line = locked
            reconciles = True
            calc = balance
        else:
            # Fall back to the last three numbers; flag as a reconciliation break.
            vals = [v for _, v in nums]
            debit, credit, balance = (vals[-3:] + [0.0, 0.0, prev_balance])[:3] \
                if len(vals) >= 3 else (0.0, 0.0, vals[-1] if vals else prev_balance)
            bal_line = nums[-1][0] if nums else di
            calc = round(prev_balance + debit - credit, 2)
            reconciles = abs(calc - balance) < 0.005

        category = classify(item_text, item_text)
        doc_m = _DOCNO_RE.search(item_text)
        fleet_m = re.search(r"\b(4000\d+[-R]\d+|400\d{6,})\b", item_text)

        rec = PadRecord(
            index=len(records), category=category, doc_type=item_text,
            item_text=item_text, doc_number=doc_m.group(1) if doc_m else None,
            date=date, debit=debit, credit=credit, balance=balance,
            calc_balance=calc, reconciles=reconciles,
            fleet_ref=fleet_m.group(1) if fleet_m else None,
            raw_tail=lines[di + 1:bal_line + 1],
        )
        records.append(rec)
        prev_balance = balance
        header_start = bal_line + 1

    postable = [r for r in records if r.category != CAT_OPENING]
    summary = {
        "opening": opening,
        "n_records": len(records),
        "n_postable": len(postable),
        "closing_stated": records[-1].balance if records else None,
        "reconciles": all(r.reconciles for r in records),
        "first_break": next((r.index for r in records if not r.reconciles), None),
    }
    return records, summary
