"""Parse a bank statement (Excel now; PDF later) into transaction rows.

Bank Excel layouts differ, but they share a table with a date, a narration, a
withdrawal/deposit pair (or debit/credit) and a running balance. We locate that
header row by its labels, map the columns, and read the data rows beneath it.

Like the PAD parser, the parse is self-checking: the running balance must satisfy
``balance[i] == balance[i-1] - withdrawal + deposit`` to the paise, so a mis-read
is flagged rather than silently trusted.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field

# Header label -> canonical column. Matched case-insensitively as substrings.
_COL_PATTERNS = {
    "date": [r"^date$", r"transaction date", r"txn date", r"^tran date"],
    "narration": [r"narration", r"transaction remarks", r"particulars", r"description",
                  r"remarks"],
    "ref": [r"chq", r"cheque", r"ref\.?\s*no", r"reference"],
    "withdrawal": [r"withdrawal", r"debit", r"^dr\b", r"paid", r"withdrawl"],
    "deposit": [r"deposit", r"credit", r"^cr\b", r"received"],
    "balance": [r"balance", r"closing bal"],
}
_DATE_FORMATS = ["%d/%m/%y", "%d/%m/%Y", "%d-%m-%Y", "%d-%m-%y",
                 "%d-%b-%Y", "%d-%b-%y", "%d/%b/%Y", "%d/%b/%y",
                 "%d-%B-%Y", "%d/%B/%Y"]


@dataclass
class BankRow:
    index: int
    date: dt.date | None
    narration: str
    ref: str
    withdrawal: float
    deposit: float
    balance: float | None
    calc_balance: float | None = None
    reconciles: bool = True

    @property
    def is_credit(self) -> bool:
        return self.deposit > 0

    @property
    def amount(self) -> float:
        return self.deposit if self.deposit else self.withdrawal


def _num(v) -> float:
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "")
    if s in ("", "-", "NA"):
        return 0.0
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else 0.0


def _parse_date(v) -> dt.date | None:
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = str(v).strip()
    for fmt in _DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _match_col(header: str) -> str | None:
    h = str(header or "").strip().lower()
    if not h:
        return None
    for canon, pats in _COL_PATTERNS.items():
        for p in pats:
            if re.search(p, h):
                return canon
    return None


def _read_grid(path: str) -> list[list]:
    """Return the sheet as a list-of-rows grid (xls via xlrd, xlsx via openpyxl)."""
    if path.lower().endswith(".xls"):
        import xlrd
        sh = xlrd.open_workbook(path).sheet_by_index(0)
        return [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    return [list(row) for row in wb.worksheets[0].iter_rows(values_only=True)]


def _find_header(grid: list[list]) -> tuple[int, dict] | None:
    """Find the header row and its column map ``{canon: col_index}``."""
    for i, row in enumerate(grid):
        cols: dict[str, int] = {}
        for j, cell in enumerate(row):
            canon = _match_col(cell)
            if canon and canon not in cols:
                cols[canon] = j
        if {"date", "narration", "balance"} <= set(cols) and (
                "withdrawal" in cols or "deposit" in cols):
            return i, cols
    return None


def detect_account(path: str) -> str | None:
    """Return the statement's own account ledger, read from the header/metadata
    ABOVE the transaction table only — an account number inside a transaction
    narration (a transfer's destination) must not be mistaken for the owner."""
    from .classify import OWN_ACCOUNTS
    grid = _read_grid(path)
    found = _find_header(grid)
    top = grid[:found[0]] if found else grid
    text = " ".join(str(c) for row in top for c in row if c is not None)
    digits = re.sub(r"\D", "", text)
    for acct, ledger in OWN_ACCOUNTS.items():
        if acct in digits:
            return ledger
    return None


def parse_excel(path: str) -> tuple[list[BankRow], dict]:
    grid = _read_grid(path)
    found = _find_header(grid)
    if not found:
        return [], {"error": "could not find a statement header row"}
    hdr, cols = found

    rows: list[BankRow] = []
    prev_balance: float | None = None
    for i in range(hdr + 1, len(grid)):
        raw = grid[i]

        def cell(name):
            j = cols.get(name)
            return raw[j] if j is not None and j < len(raw) else None

        date = _parse_date(cell("date"))
        if date is None:
            continue  # footer / blank / legend line
        wd, dep = _num(cell("withdrawal")), _num(cell("deposit"))
        bal = _num(cell("balance"))
        narration = str(cell("narration") or "").strip()
        ref = str(cell("ref") or "").strip()

        calc = round(prev_balance - wd + dep, 2) if prev_balance is not None else bal
        reconciles = prev_balance is None or abs(calc - bal) < 0.05
        rows.append(BankRow(
            index=len(rows), date=date, narration=narration, ref=ref,
            withdrawal=wd, deposit=dep, balance=bal,
            calc_balance=calc, reconciles=reconciles))
        prev_balance = bal

    summary = {
        "n_rows": len(rows),
        "opening": round(rows[0].balance - rows[0].deposit + rows[0].withdrawal, 2)
        if rows else None,
        "closing": rows[-1].balance if rows else None,
        "reconciles": all(r.reconciles for r in rows),
        "first_break": next((r.index for r in rows if not r.reconciles), None),
        "total_deposits": round(sum(r.deposit for r in rows), 2),
        "total_withdrawals": round(sum(r.withdrawal for r in rows), 2),
    }
    return rows, summary
