"""Date <-> Excel serial conversion.

Ported verbatim in behaviour from the proven ``toSerial`` in ``pay/index.html``
(and the reference ``vriddhi_pay.py``). Column A of "Master Paid" is a date
*serial* (days since 1899-12-30), never text, so the .xlsx the local half emits
must carry the same integer serials Excel expects.

Rules carried over exactly:
- ``dd/mm/yyyy`` (or ``dd/mm/yy``) input, slash-separated.
- 2-digit year ``< 100`` -> ``2000 + y``.
- Real-calendar validation: 31/02 is rejected, not silently rolled over.
"""

from __future__ import annotations

from datetime import date

# Excel's day 0 is 1899-12-30 (the well-known 1900 leap-year bug baseline).
EPOCH = date(1899, 12, 30)


def to_serial(date_str: str) -> tuple[int | None, bool]:
    """Convert a ``dd/mm/yyyy`` string to an Excel serial.

    Returns ``(serial, valid)``. On any malformed or impossible date returns
    ``(None, False)`` so callers can queue a ``review`` row rather than guess.
    """
    parts = str(date_str).strip().split("/")
    if len(parts) != 3:
        return None, False
    try:
        d, m, y = (int(p) for p in parts)
    except ValueError:
        return None, False
    if y < 100:
        y += 2000
    if not (1 <= m <= 12 and 1 <= d <= 31 and 1900 <= y < 3000):
        return None, False
    try:
        dt = date(y, m, d)  # rejects impossible days (e.g. 31/02)
    except ValueError:
        return None, False
    return (dt - EPOCH).days, True


def serial_to_dmy(serial: int) -> str:
    """Inverse of :func:`to_serial`, formatted ``dd/mm/yy`` for display."""
    from datetime import timedelta

    d = EPOCH + timedelta(days=int(serial))
    return f"{d.day:02d}/{d.month:02d}/{str(d.year)[-2:]}"


def date_to_serial(d: date) -> int:
    """Excel serial for a :class:`datetime.date` (used by parsers that already
    hold a real date object)."""
    return (d - EPOCH).days
