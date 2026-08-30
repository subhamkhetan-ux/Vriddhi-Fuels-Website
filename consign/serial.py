"""Local, idempotent consignment-note serial assignment.

The /payments pipeline numbers its notes off a Supabase sequence. This app is
standalone, so it keeps its own counter in the app's data file and hands out one
serial per invoice number. Assignment is idempotent: the same invoice number
always maps back to the same serial, so re-scanning the folder — or the same
invoice appearing as two PDFs — never spends a new number.
"""

from __future__ import annotations

SERIAL_PREFIX = "VF/CN2627/"


def format_serial(num: int) -> str:
    """Render a serial number as ``VF/CN2627/047`` (min 3 digits, zero-padded)."""
    return f"{SERIAL_PREFIX}{int(num):03d}"


def assign(state: dict, invoice_no: str) -> tuple[int, str]:
    """Return ``(serial_num, serial_str)`` for ``invoice_no``, assigning the next
    number the first time it is seen and returning the same one thereafter.

    ``state`` is mutated in place. Its shape::

        {"next_serial": 47, "issued": {"7010221545": 47, ...}}

    The caller owns persistence (write ``state`` back to disk after a scan).
    """
    invoice_no = str(invoice_no)
    issued = state.setdefault("issued", {})
    if invoice_no in issued:
        num = int(issued[invoice_no])
        return num, format_serial(num)

    num = int(state.get("next_serial", 47))
    issued[invoice_no] = num
    state["next_serial"] = num + 1
    return num, format_serial(num)
