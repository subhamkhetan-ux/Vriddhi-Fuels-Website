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

# Header label -> canonical column. Matched case-insensitively as substrings, in
# this order — so a "Dr/Cr" indicator or a bare "Amount" column is recognised
# before the looser withdrawal/deposit patterns ("debit", "^dr") can claim it.
_COL_PATTERNS = {
    "drcr": [r"^(dr\s*/\s*cr|cr\s*/\s*dr|debit\s*/\s*credit|credit\s*/\s*debit|"
             r"(txn|tran|transaction)?\s*type)$"],
    "amount": [r"^(txn|tran|transaction)?\s*amount\s*(\((inr|rs\.?|₹)?\s*\))?$"],
    "date": [r"^date$", r"transaction date", r"txn date", r"^tran date",
             r"^post(ing)? date$", r"^book(ing)? date$"],
    "narration": [r"narration", r"transaction remarks", r"particulars", r"description",
                  r"remarks", r"^details$", r"transaction details"],
    "ref": [r"chq", r"cheque", r"ref\.?\s*no", r"reference"],
    "withdrawal": [r"withdrawal", r"debit", r"^dr\b", r"paid", r"withdrawl"],
    "deposit": [r"deposit", r"credit", r"^cr\b", r"received"],
    "balance": [r"balance", r"closing bal"],
}
_DATE_FORMATS = ["%d/%m/%y", "%d/%m/%Y", "%d-%m-%Y", "%d-%m-%y",
                 "%d-%b-%Y", "%d-%b-%y", "%d/%b/%Y", "%d/%b/%y",
                 "%d-%B-%Y", "%d/%B/%Y", "%d %b %Y", "%d %b %y", "%d %B %Y",
                 "%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d", "%Y/%m/%d"]
_EXCEL_EPOCH = dt.date(1899, 12, 30)


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


def _balance(v) -> float:
    """A running balance. Overdraft statements may print "50,000.00 Dr" (owed to
    the bank = negative) / "1,000.00 Cr", or "(50,000.00)"."""
    s = str(v if v is not None else "").strip()
    n = abs(_num(v)) if s else 0.0
    if re.search(r"\bdr\.?$", s, re.I) or (s.startswith("(") and s.endswith(")")):
        return -n
    if re.search(r"\bcr\.?$", s, re.I):
        return n
    return _num(v)


def _parse_date(v) -> dt.date | None:
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        # An Excel date serial that reached us as a plain number.
        if 20000 <= v <= 80000 and float(v).is_integer():
            return _EXCEL_EPOCH + dt.timedelta(days=int(v))
        return None
    s = re.split(r"\s+\d{1,2}:\d{2}", str(v).strip())[0].strip()    # drop a time part
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
        book = xlrd.open_workbook(path)
        sh = book.sheet_by_index(0)

        def val(r, c):
            cell = sh.cell(r, c)
            if cell.ctype == xlrd.XL_CELL_DATE:          # a real date cell, not text
                return xlrd.xldate_as_datetime(cell.value, book.datemode)
            return cell.value
        return [[val(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]
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
                "withdrawal" in cols or "deposit" in cols or "amount" in cols):
            return i, cols
    return None


def detect_account(path: str) -> str | None:
    """Return the statement's own account ledger, read from the header/metadata
    ABOVE the transaction table only — an account number inside a transaction
    narration (a transfer's destination) must not be mistaken for the owner."""
    grid = _read_grid(path)
    found = _find_header(grid)
    top = grid[:found[0]] if found else grid
    hits = accounts_named([c for row in top for c in row])
    return next(iter(hits)) if len(hits) == 1 else None      # none, or ambiguous


def accounts_named(cells) -> set:
    """Our own account ledgers named in these cells. A number counts only when it
    is whole within ONE cell (spaces/hyphens inside it are fine; Excel may have
    dropped leading zeros), or masked (``XXXXXXXX5893``) when its visible tail
    fits exactly one of our accounts — never digits glued across cells."""
    from .classify import OWN_ACCOUNTS
    found = set()
    for c in cells:
        if c is None:
            continue
        s = str(int(c)) if isinstance(c, float) and c.is_integer() else str(c)
        runs = set(re.findall(r"\d+", s))
        runs |= {re.sub(r"\D", "", m) for m in re.findall(r"\d[\d \-]*\d", s)}
        for acct, ledger in OWN_ACCOUNTS.items():
            if any(r == acct or (r.lstrip("0") and r.lstrip("0") == acct.lstrip("0"))
                   for r in runs):
                found.add(ledger)
        for m in re.finditer(r"[Xx*]{3,}[\s-]*(\d{4,})", s):
            tail = [led for acct, led in OWN_ACCOUNTS.items() if acct.endswith(m.group(1))]
            if len(tail) == 1:
                found.add(tail[0])
    return found


def _direction(amount_cell, drcr_cell):
    """(withdrawal, deposit) for a single-Amount-column statement, from a Dr/Cr
    indicator column, a Dr/Cr suffix on the amount, or the amount's sign. Returns
    (None, None) when the direction can't be told (decided later by the balance)."""
    amt = _num(amount_cell)
    ind = str(drcr_cell or "").strip().upper()
    raw = str(amount_cell or "").strip().upper()
    if ind.startswith(("D", "W")) or re.search(r"\bDR\.?$", raw) or amt < 0:
        return abs(amt), 0.0
    if ind.startswith(("C", "R")) or re.search(r"\bCR\.?$", raw):
        return 0.0, abs(amt)
    return (None, None) if amt else (0.0, 0.0)


def _chain(rows: list[dict]) -> int:
    """Check the running-balance identity row by row (balance-only rows such as
    an opening balance just seed it); fill each transaction's ``calc``/``ok``.
    Rows whose direction is unknown take it from the balance change. Returns the
    number of transactions that tie out."""
    prev, ok = None, 0
    for r in rows:
        if r["wd"] is None:                      # amount column, direction unknown
            if prev is not None and abs(abs(r["bal"] - prev) - r["amt"]) < 0.05:
                r["wd"], r["dep"] = (0.0, r["amt"]) if r["bal"] > prev else (r["amt"], 0.0)
            else:
                r["wd"], r["dep"] = 0.0, 0.0
                r["unknown"] = True
        if r["wd"] == 0 and r["dep"] == 0 and not r.get("unknown"):
            if r["has_bal"]:
                prev = r["bal"]                  # opening / closing / balance-only line
            continue
        calc = round(prev - r["wd"] + r["dep"], 2) if prev is not None else r["bal"]
        r["calc"] = calc
        r["ok"] = not r.get("unknown") and (prev is None or abs(calc - r["bal"]) < 0.05)
        ok += r["ok"]
        if r["has_bal"]:
            prev = r["bal"]
    return ok


def parse_excel(path: str) -> tuple[list[BankRow], dict]:
    grid = _read_grid(path)
    found = _find_header(grid)
    if not found:
        return [], {"error": "could not find a statement header row"}
    hdr, cols = found

    raw_rows: list[dict] = []
    for i in range(hdr + 1, len(grid)):
        raw = grid[i]

        def cell(name):
            j = cols.get(name)
            return raw[j] if j is not None and j < len(raw) else None

        date = _parse_date(cell("date"))
        if date is None:
            continue  # footer / blank / legend line
        if "withdrawal" in cols or "deposit" in cols:
            wd, dep = abs(_num(cell("withdrawal"))), abs(_num(cell("deposit")))
            amt = wd or dep
        else:                                    # one Amount column (+ maybe Dr/Cr)
            wd, dep = _direction(cell("amount"), cell("drcr"))
            amt = abs(_num(cell("amount")))
        bal_cell = cell("balance")
        raw_rows.append({
            "date": date, "wd": wd, "dep": dep, "amt": amt,
            "bal": _balance(bal_cell), "has_bal": str(bal_cell or "").strip() != "",
            "narration": str(cell("narration") or "").strip(),
            "ref": str(cell("ref") or "").strip()})

    # Some exports list the newest transaction first. If the balance chain only
    # ties out read bottom-up, read it that way (always oldest first after this).
    fwd = [dict(r) for r in raw_rows]
    n_fwd = _chain(fwd)
    rev = [dict(r) for r in reversed(raw_rows)]
    n_rev = _chain(rev)
    chosen = rev if n_rev > n_fwd else fwd

    rows: list[BankRow] = []
    for r in chosen:
        if "calc" not in r:                      # balance-only line, not a transaction
            continue
        rows.append(BankRow(
            index=len(rows), date=r["date"], narration=r["narration"], ref=r["ref"],
            withdrawal=r["wd"], deposit=r["dep"], balance=r["bal"],
            calc_balance=r["calc"], reconciles=r["ok"]))

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
