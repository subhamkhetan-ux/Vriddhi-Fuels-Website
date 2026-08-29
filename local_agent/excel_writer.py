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
    """Opens the ledger on demand, fills entries into the next blank rows, saves,
    then closes/quits Excel again — so you don't keep the ledger or Excel open.

    A batch is bracketed by ``open_session()`` / ``close_session()``: open once,
    ``append`` each row (writing + saving as it goes, so a mid-batch failure still
    leaves earlier rows persisted), then close. The close is polite:

      - if the workbook was ALREADY open (you're using it), it's left open;
      - if this writer opened it, the workbook is closed;
      - if this writer also had to launch Excel, Excel is quit — but only when no
        other workbooks remain, so it never quits an Excel you're using.
    """

    def __init__(self, ledger_path: str, sheet_name: str = "Master Paid") -> None:
        self.ledger_path = ledger_path
        self.sheet_name = sheet_name
        self._xw = None
        self._app = None
        self._book = None
        self._we_launched_app = False
        self._we_opened_book = False

    # ---- session: open on demand, close/quit when done ----------------

    def open_session(self) -> None:
        """Make ``self._book`` point at the ledger, launching Excel / opening the
        workbook only as needed, and remembering what we opened so we can undo it
        in ``close_session``."""
        try:
            import xlwings as xw
        except ImportError as ex:  # pragma: no cover - environment-specific
            raise ExcelUnavailable(
                "xlwings is not installed — run `pip install xlwings` on the Mac"
            ) from ex
        self._xw = xw

        import os

        target = os.path.abspath(self.ledger_path)
        self._app = None
        self._book = None
        self._we_launched_app = False
        self._we_opened_book = False

        try:
            # 1) Already open somewhere? Attach and leave it as we found it.
            for app in xw.apps:
                for bk in app.books:
                    try:
                        if os.path.abspath(bk.fullname) == target:
                            self._app, self._book = app, bk
                            return
                    except Exception:
                        continue

            # 2) Reuse a running Excel if there is one, else launch it hidden.
            if xw.apps.count > 0:
                self._app = xw.apps.active
            else:
                self._app = xw.App(visible=False, add_book=False)
                self._we_launched_app = True

            try:
                self._app.display_alerts = False
            except Exception:
                pass

            self._book = self._app.books.open(target)
            self._we_opened_book = True
        except ExcelUnavailable:
            raise
        except Exception as ex:
            # If we launched Excel just now but failed to open the book, don't
            # leave a stray hidden Excel behind.
            if self._we_launched_app and self._app is not None:
                try:
                    self._app.quit()
                except Exception:
                    pass
            self._app = self._book = None
            self._we_launched_app = self._we_opened_book = False
            raise ExcelUnavailable(f"can't open {self.ledger_path}: {ex}") from ex

    def close_session(self) -> None:
        """Save, then undo exactly what ``open_session`` opened (see class doc)."""
        if self._book is None:
            self._app = None
            return
        try:
            try:
                self._book.save()
            except Exception:
                pass
            if self._we_opened_book:
                try:
                    self._book.close()
                except Exception:
                    pass
            if self._we_launched_app and self._app is not None:
                try:
                    if len(self._app.books) == 0:
                        self._app.quit()
                except Exception:
                    pass
        finally:
            self._app = self._book = None
            self._we_launched_app = self._we_opened_book = False

    def _sheet(self):
        if self._book is None:
            raise ExcelUnavailable("no Excel session open (internal error)")
        try:
            return self._book.sheets[self.sheet_name]
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
