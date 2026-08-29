"""Write Master-Paid entries into ``Master Ledger.xlsm`` via the real Excel app.

We drive Excel itself (through xlwings) rather than rewriting the file with a
library, because the ledger is a macro-enabled workbook full of formulas, spill
ranges and other sheets. Letting Excel do the write means none of that is touched.

The Master Paid sheet already has **pre-formatted blank rows** waiting to be
filled — the agent does NOT append a fresh row at the bottom. For each entry it
finds the first row whose Date cell (column A) is empty and writes into it,
leaving that row's existing formatting/formulas intact (values only; a cell's
number format is set only if it was still "General"). When the pre-made blank
rows run out, it adds one more row — and if Master Paid is a real Excel Table
(ListObject), it extends the table so the new row keeps the table's formatting.

Verified against the real ``Master Ledger.xlsm``: Master Paid is the Excel Table
``MasterPaid`` (ref ``A1:D650``, header row 1), columns A–D = Date / Customer /
Amount Paid / Payment Mode, with pre-formatted blank rows waiting below the data.
The blank cells already carry the ledger's own formats (Date ``dd/mm/yy``, Amount
``"₹"#,##0.00``), so we write values only and leave those formats alone.

Column layout (confirmed A–D, Date first):
  A  date          real date value (the row's own dd/mm/yy format is kept)
  B  customer      canonical name
  C  amount        number with decimals (the row's own ₹#,##0.00 format is kept)
  D  mode          "<BANK> <RAIL>", e.g. "HDFC NEFT"

xlwings is Mac/Windows-only and needs Excel installed, so it's imported lazily:
the pure ``poster`` code and its tests never import Excel. The tiny bit of pure
logic (finding the first blank row) is factored out and unit-tested directly.
"""

from __future__ import annotations

import datetime as dt

# Fallback formats, matched to the ledger — applied ONLY to a cell that is still
# "General" (e.g. a freshly-extended row past the pre-formatted blanks). Existing
# blank rows keep their own formats untouched.
DATE_FMT = "dd/mm/yy"
AMOUNT_FMT = '"₹"#,##0.00'
DATE_COL, CUST_COL, AMOUNT_COL, MODE_COL = 1, 2, 3, 4  # A, B, C, D


class ExcelUnavailable(RuntimeError):
    """Raised when Excel or the workbook can't be reached (closed, locked,
    sheet missing). The daemon treats this as 'retry later', never as 'done'."""


def _is_blank(value) -> bool:
    """A Date cell counts as an available (blank) row when it holds no value."""
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    return False


def first_blank_offset(date_values: list) -> int:
    """Index of the first blank Date in ``date_values`` (a column read top-down).

    Returns ``len(date_values)`` when every row is filled — the caller reads that
    as "no blank rows left, add one more". Pure and unit-tested; the xlwings glue
    just feeds it the Date column of the data region.
    """
    for i, v in enumerate(date_values):
        if _is_blank(v):
            return i
    return len(date_values)


class ExcelWriter:
    """Fills one entry at a time into the next blank row, saving after each, so a
    mid-batch failure leaves every already-written row safely persisted.

    Attaches to the workbook if Excel already has it open (the common case — you
    keep the ledger open), otherwise opens it. Excel stays open between calls."""

    def __init__(self, ledger_path: str, sheet_name: str = "Master Paid") -> None:
        self.ledger_path = ledger_path
        self.sheet_name = sheet_name
        self._xw = None
        self._book = None

    # ---- workbook / sheet plumbing -----------------------------------

    def _ensure_book(self):
        try:
            import xlwings as xw
        except ImportError as ex:  # pragma: no cover - environment-specific
            raise ExcelUnavailable(
                "xlwings is not installed — run `pip install xlwings` on the Mac"
            ) from ex

        self._xw = xw
        if self._book is not None:
            try:
                _ = self._book.name  # still alive?
                return self._book
            except Exception:
                self._book = None

        import os

        target = os.path.abspath(self.ledger_path)
        try:
            for app in xw.apps:
                for bk in app.books:
                    try:
                        if os.path.abspath(bk.fullname) == target:
                            self._book = bk
                            return bk
                    except Exception:
                        continue
            self._book = xw.Book(self.ledger_path)  # opens (attaches if already open)
            return self._book
        except Exception as ex:
            raise ExcelUnavailable(f"can't open {self.ledger_path}: {ex}") from ex

    def _sheet(self):
        book = self._ensure_book()
        try:
            return book.sheets[self.sheet_name]
        except Exception as ex:
            raise ExcelUnavailable(
                f"sheet '{self.sheet_name}' not found in {self.ledger_path}: {ex}"
            ) from ex

    def _find_table(self, sheet):
        """The Master Paid Excel Table (ListObject) if there is one — the table
        whose data starts in column A. Returns the xlwings Table or None (a plain
        formatted range). Any table-API hiccup degrades to the plain path."""
        try:
            for tbl in sheet.tables:
                try:
                    if tbl.range.column == DATE_COL:
                        return tbl
                except Exception:
                    continue
        except Exception:
            return None
        return None

    # ---- locating the next blank row ---------------------------------

    def _target_row_plain(self, sheet) -> int:
        """First blank Date row in a plain (non-Table) sheet.

        Uses End(xlUp) from the bottom of column A: it lands on the last row that
        actually has a Date, so the row after it is the first pre-formatted blank
        row — and, once those are used up, the row just below the data (a new
        row). Robust to any title/blank rows *above* the ledger."""
        last_cell_row = sheet.cells.last_cell.row
        last_with_date = sheet.range((last_cell_row, DATE_COL)).end("up").row
        return last_with_date + 1

    def _target_row_table(self, sheet, table) -> int:
        """First blank Date row inside a Table, extending it by one row if full."""
        body = None
        try:
            body = table.data_body_range
        except Exception:
            body = None

        if body is None:
            # Empty table: first data row is right under the header.
            return table.range.row + table.range.rows.count

        start_row = body.row
        dates = body.columns[0].value  # Date column of the body, top-down
        if not isinstance(dates, list):
            dates = [dates]  # single-row body comes back as a scalar

        off = first_blank_offset(dates)
        if off < len(dates):
            return start_row + off

        # No blank rows left — extend the table by one row so the new row keeps
        # the table's formatting, then target that new last row.
        try:
            rng = table.range
            table.resize(rng.resize(rng.rows.count + 1, rng.columns.count))
        except Exception as ex:
            raise ExcelUnavailable(f"couldn't extend Master Paid table: {ex}") from ex
        return table.range.last_cell.row

    # ---- the write ---------------------------------------------------

    def append(self, entry: dict) -> None:
        """Write one entry into the next blank Master-Paid row, then save.

        Values only: the blank row's own number formats are preserved (a format is
        applied only if the cell was still "General", e.g. a freshly-extended
        row), so we never override the ledger's own date/amount formatting."""
        sheet = self._sheet()
        try:
            table = self._find_table(sheet)
            r = self._target_row_table(sheet, table) if table else self._target_row_plain(sheet)

            date_val = entry["date"]
            if isinstance(date_val, dt.date) and not isinstance(date_val, dt.datetime):
                date_val = dt.datetime(date_val.year, date_val.month, date_val.day)

            self._set(sheet, r, DATE_COL, date_val, DATE_FMT)
            self._set(sheet, r, CUST_COL, entry["customer"], None)
            self._set(sheet, r, AMOUNT_COL, float(entry["amount"]), AMOUNT_FMT)
            self._set(sheet, r, MODE_COL, entry["mode"], None)

            self._book.save()
        except ExcelUnavailable:
            raise
        except Exception as ex:
            raise ExcelUnavailable(f"failed writing to Master Paid: {ex}") from ex

    @staticmethod
    def _set(sheet, row: int, col: int, value, fmt: str | None) -> None:
        """Write a value, and apply ``fmt`` only if the cell is still General so a
        pre-formatted blank row keeps its own format."""
        cell = sheet.range((row, col))
        cell.value = value
        if fmt:
            try:
                if str(cell.number_format).strip().lower() in ("general", "@", ""):
                    cell.number_format = fmt
            except Exception:
                cell.number_format = fmt  # setting is harmless if the read failed
