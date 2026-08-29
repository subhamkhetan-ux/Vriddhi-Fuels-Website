"""Append Master-Paid rows into ``Master Ledger.xlsm`` via the real Excel app.

We drive Excel itself (through xlwings) rather than rewriting the file with a
library, because the ledger is a macro-enabled workbook full of formulas, spill
ranges and other sheets. Letting Excel do the write means none of that is touched
— we only add rows to the bottom of the Master Paid sheet.

xlwings is Mac/Windows-only and needs Excel installed, so it's imported lazily:
the pure ``poster`` code and its tests never import this module.

Cell shapes mirror ``agent/xlsx_writer.py`` exactly:
  A  date          real date value, number-format dd/mm/yyyy
  B  customer      canonical name
  C  amount        plain number, number-format #,##0
  D  mode          "<BANK> <RAIL>", e.g. "HDFC NEFT"
"""

from __future__ import annotations

import datetime as dt

DATE_FMT = "dd/mm/yyyy"
AMOUNT_FMT = "#,##0"


class ExcelUnavailable(RuntimeError):
    """Raised when Excel or the workbook can't be reached (closed, locked,
    sheet missing). The daemon treats this as 'retry later', never as 'done'."""


class ExcelWriter:
    """Appends one entry at a time, saving after each, so a mid-batch failure
    leaves every already-written row safely persisted.

    Attaches to the workbook if Excel already has it open (the common case — you
    keep the ledger open), otherwise opens it. Excel stays open between calls."""

    def __init__(self, ledger_path: str, sheet_name: str = "Master Paid") -> None:
        self.ledger_path = ledger_path
        self.sheet_name = sheet_name
        self._xw = None
        self._book = None

    def _ensure_book(self):
        try:
            import xlwings as xw
        except ImportError as ex:  # pragma: no cover - environment-specific
            raise ExcelUnavailable(
                "xlwings is not installed — run `pip install xlwings` on the Mac"
            ) from ex

        self._xw = xw
        # Reuse an already-attached book if it's still alive.
        if self._book is not None:
            try:
                _ = self._book.name
                return self._book
            except Exception:
                self._book = None

        import os

        target = os.path.abspath(self.ledger_path)
        # Prefer a workbook that's already open in a running Excel (don't spawn a
        # second instance); fall back to opening it ourselves.
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

    def append(self, entry: dict) -> None:
        """Write one entry at the first empty row of Master Paid, then save."""
        sheet = self._sheet()
        try:
            # Last used row in column A, then the row after it.
            last_cell_row = sheet.cells.last_cell.row
            last = sheet.range((last_cell_row, 1)).end("up").row
            r = last + 1

            date_val = entry["date"]
            if isinstance(date_val, dt.date) and not isinstance(date_val, dt.datetime):
                date_val = dt.datetime(date_val.year, date_val.month, date_val.day)

            sheet.range((r, 1)).value = date_val
            sheet.range((r, 1)).number_format = DATE_FMT
            sheet.range((r, 2)).value = entry["customer"]
            sheet.range((r, 3)).value = float(entry["amount"])
            sheet.range((r, 3)).number_format = AMOUNT_FMT
            sheet.range((r, 4)).value = entry["mode"]

            self._book.save()
        except ExcelUnavailable:
            raise
        except Exception as ex:
            raise ExcelUnavailable(f"failed writing to Master Paid: {ex}") from ex
