"""A sheet as plain 2-D lists, plus the small cell helpers the reporter uses.

``Grid.values[r][c]`` is Excel cell (r+1, c+1); ``Grid.formulas`` has the same
shape and holds the formula text (``"=SUM(B2:B9)"``) where a cell has one.
Grids are read-only snapshots — build a new one rather than editing ``values``.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass, field


@dataclass
class Grid:
    name: str
    values: list
    formulas: list | None = None
    ncols: int = field(init=False)

    def __post_init__(self) -> None:
        # Worked out once: ncols is read inside per-cell loops, and recomputing
        # it there made a 5,000-row sheet take ~20 seconds instead of a blink.
        self.ncols = max((len(r) for r in self.values if r is not None), default=0)

    @property
    def nrows(self) -> int:
        return len(self.values)

    def v(self, r: int, c: int):
        if 0 <= r < len(self.values):
            row = self.values[r]
            if row is not None and 0 <= c < len(row):
                return row[c]
        return None

    def f(self, r: int, c: int) -> str | None:
        if self.formulas and 0 <= r < len(self.formulas):
            row = self.formulas[r]
            if row is not None and 0 <= c < len(row):
                x = row[c]
                if isinstance(x, str) and x.startswith("="):
                    return x
        return None


def col_letter(c: int) -> str:
    """0-based column index -> Excel letters (0 -> A, 26 -> AA)."""
    s, n = "", c + 1
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def col_index(letters: str) -> int:
    """Excel letters -> 0-based column index ("A" -> 0)."""
    n = 0
    for ch in letters.strip().upper():
        if not "A" <= ch <= "Z":
            raise ValueError(f"not a column letter: {letters!r}")
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def a1(r: int, c: int) -> str:
    """0-based (row, col) -> "B5"."""
    return f"{col_letter(c)}{r + 1}"


def is_blank(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and not (
        isinstance(v, float) and math.isnan(v))


def norm(s) -> str:
    """Lower-case, punctuation to spaces, whitespace collapsed ("P.O. No." -> "p o no")."""
    s = re.sub(r"[^0-9a-z#+]+", " ", str(s or "").lower())
    return " ".join(s.split())


_NUMLIKE = re.compile(r"^\s*[-+]?[\d,]*\.?\d+\s*$")


def is_label(v) -> bool:
    """A short piece of text that could be a column header."""
    return isinstance(v, str) and 0 < len(v.strip()) <= 60 and not _NUMLIKE.match(v)


_DATE_FORMATS = ("%d/%m/%Y", "%d/%m/%y", "%d.%m.%Y", "%d.%m.%y", "%d-%m-%Y",
                 "%d-%m-%y", "%Y-%m-%d", "%d-%b-%Y", "%d-%b-%y", "%d %b %Y",
                 "%d %b %y", "%d %B %Y", "%d-%B-%Y", "%b %d, %Y")


def to_date(v) -> dt.date | None:
    """A date from a datetime or a date-looking string, else None."""
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s or len(s) > 20 or not any(ch.isdigit() for ch in s):
            return None
        for fmt in _DATE_FORMATS:
            try:
                return dt.datetime.strptime(s, fmt).date()
            except ValueError:
                continue
    return None


def clean_number(n):
    """12000.0 -> 12000; other numbers unchanged."""
    return int(n) if float(n).is_integer() and abs(n) < 1e15 else n


def display(v):
    """A JSON-friendly version of a cell value (dates as dd/mm/yyyy)."""
    if isinstance(v, dt.datetime):
        if v.hour or v.minute or v.second:
            return v.strftime("%d/%m/%Y %H:%M")
        return v.strftime("%d/%m/%Y")
    if isinstance(v, dt.date):
        return v.strftime("%d/%m/%Y")
    if isinstance(v, dt.time):
        return v.strftime("%H:%M")
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return clean_number(round(v, 6))
    if isinstance(v, (str, int, bool)) or v is None:
        return v
    return str(v)
