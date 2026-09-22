"""Local, idempotent consignment-note serial assignment.

The /payments pipeline numbers its notes off a Supabase sequence. This app is
standalone, so it keeps its own counters in the app's data file and hands out one
serial per invoice number. Assignment is idempotent: the same invoice number
always maps back to the same serial, so re-scanning the folder — or the same
invoice appearing as two PDFs — never spends a new number.

Two counters, mirroring the Supabase design:
  * the PRINTED serial restarts at 1 each Indian financial year (1 Apr–31 Mar),
    so ``VF/CN2728/001`` reads as the first trip of FY 2027-28; and
  * a lifetime index (never resets) records the total trips to date.
"""

from __future__ import annotations

import datetime as _dt


def fy_code(invoice_date: str | None = None) -> str:
    """Financial-year code ('2627', '2728', …) for a ``dd/mm/yyyy`` date. Apr–Dec
    belong to that year's FY, Jan–Mar to the FY that began the previous April.
    Falls back to today's FY when the date is missing or unparseable."""
    d: _dt.date | None = None
    if invoice_date:
        try:
            d = _dt.datetime.strptime(str(invoice_date).strip(), "%d/%m/%Y").date()
        except ValueError:
            d = None
    if d is None:
        d = _dt.date.today()
    ys = d.year if d.month >= 4 else d.year - 1        # financial-year start year
    return f"{ys % 100:02d}{(ys + 1) % 100:02d}"


def _serial_str(fy: str, num: int) -> str:
    return f"VF/CN{fy}/{int(num):03d}"


def format_serial(num: int, invoice_date: str | None = None) -> str:
    """Render a serial as ``VF/CN2627/047`` (min 3 digits); the prefix follows the
    financial year of ``invoice_date``."""
    return _serial_str(fy_code(invoice_date), num)


def _migrate(state: dict) -> dict:
    """Upgrade the older single-counter state in place. Old shape::

        {"next_serial": 47, "issued": {"701…": 47, ...}}

    becomes a lifetime counter plus a per-FY counter, treating every previously
    issued note as FY 2026-27 (all earlier notes predate the rollover)."""
    if "next_serial" in state and "lifetime_next" not in state:
        nv = int(state.get("next_serial", 47))
        state["lifetime_next"] = nv
        state.setdefault("fy_next", {})["2627"] = nv
        old = state.get("issued", {}) or {}
        state["issued"] = {
            k: (v if isinstance(v, dict)
                else {"num": int(v), "lifetime": int(v), "fy": "2627"})
            for k, v in old.items()
        }
        state.pop("next_serial", None)
    state.setdefault("lifetime_next", 47)
    state.setdefault("fy_next", {})
    state.setdefault("issued", {})
    return state


def assign(state: dict, invoice_no: str,
           invoice_date: str | None = None) -> tuple[int, str]:
    """Return ``(serial_num, serial_str)`` for ``invoice_no``, assigning the next
    number the first time it is seen and returning the same one thereafter.

    ``serial_num`` is the PRINTED number, which restarts at 1 each financial year;
    the lifetime index is stored alongside in ``state`` (see ``lifetime_of``). The
    financial year comes from ``invoice_date``.

    ``state`` is mutated in place. Its shape::

        {"lifetime_next": 47,
         "fy_next": {"2627": 47, "2728": 1},
         "issued": {"701…": {"num": 47, "lifetime": 47, "fy": "2627"}}}

    The caller owns persistence (write ``state`` back to disk after a scan).
    """
    invoice_no = str(invoice_no)
    _migrate(state)
    issued = state["issued"]
    rec = issued.get(invoice_no)
    if rec is not None:
        if not isinstance(rec, dict):
            rec = {"num": int(rec), "lifetime": int(rec), "fy": "2627"}
            issued[invoice_no] = rec
        return rec["num"], _serial_str(rec["fy"], rec["num"])

    fy = fy_code(invoice_date)
    lifetime = int(state["lifetime_next"])
    fynum = int(state["fy_next"].get(fy, 1))
    issued[invoice_no] = {"num": fynum, "lifetime": lifetime, "fy": fy}
    state["lifetime_next"] = lifetime + 1
    state["fy_next"][fy] = fynum + 1
    return fynum, _serial_str(fy, fynum)


def lifetime_of(state: dict, invoice_no: str) -> int | None:
    """The lifetime (total-trips) index assigned to ``invoice_no``, or ``None`` if
    it hasn't been issued a serial yet."""
    rec = (state.get("issued") or {}).get(str(invoice_no))
    if isinstance(rec, dict):
        return rec.get("lifetime")
    if rec is not None:
        return int(rec)          # legacy row: lifetime == printed number
    return None
