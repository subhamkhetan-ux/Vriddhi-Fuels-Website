"""Pure logic for turning log-requested queue rows into Master-Paid entries.

No Excel, no network, no clock — everything here is a plain function so the whole
posting decision (what to write, what to skip, what events to emit) is unit-
testable with fakes. ``mac_agent`` injects the real Excel writer, Supabase sink
and seen-store; the tests inject fakes.

The Master-Paid shape matches ``agent/xlsx_writer.py`` and the ``/pay`` app
exactly (spec §3): column A a real date shown dd/mm/yyyy, B the canonical
customer, C a plain amount, D "<BANK> <RAIL>".
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Protocol

# Excel's 1900 date system counts days since 1899-12-30 (the same epoch the app
# and xlsx_writer use). Converting the stored serial back to a real date lets the
# Excel writer store an actual date value, not text.
_EXCEL_EPOCH_ORD = dt.date(1899, 12, 30).toordinal()


def serial_to_date(serial: int) -> dt.date:
    """Excel date serial -> ``datetime.date`` (inverse of the app's serialToDMY)."""
    return dt.date.fromordinal(_EXCEL_EPOCH_ORD + int(serial))


def row_to_entry(row: dict) -> dict:
    """Map one queue row to the four Master-Paid values (plus its id)."""
    return {
        "entry_id": row["entry_id"],
        "date": serial_to_date(row["date_serial"]),
        "customer": (row.get("customer") or "").strip(),
        "amount": float(row["amount"]),
        "mode": (row.get("mode") or "").strip(),
    }


def is_postable(row: dict, already_posted: Any) -> bool:
    """A row is safe to write only if it's a resolved, complete, unseen entry.

    ``already_posted`` is anything supporting ``in`` (a set, or the seen-store).
    The server query already narrows to ``log_requested & not yet logged``; this
    is a defensive second gate so a malformed or already-written row can never
    reach Excel.
    """
    if row.get("entry_id") in already_posted:
        return False
    if row.get("status") != "matched":
        return False
    if not row.get("customer"):
        return False
    if row.get("date_serial") is None or row.get("amount") is None:
        return False
    return True


def select_postable(rows: list[dict], already_posted: Any) -> list[dict]:
    """Rows safe to write, in date order. ``already_posted`` supports ``in``."""
    out = [r for r in rows if is_postable(r, already_posted)]
    out.sort(key=lambda r: (int(r["date_serial"]), str(r.get("customer") or "")))
    return out


class Writer(Protocol):
    def append(self, entry: dict) -> None: ...


class Seen(Protocol):
    def __contains__(self, entry_id: str) -> bool: ...
    def add(self, entry_id: str) -> None: ...


class Sink(Protocol):
    def mark_logged(self, entry_id: str) -> None: ...
    def event(self, kind: str, **fields: Any) -> None: ...


def post_batch(rows: list[dict], writer: Writer, seen: Seen, sink: Sink) -> int:
    """Write each postable row into Excel, once, in date order.

    Ordering (critical for idempotency): append to Excel first, then record the
    id in the local seen-store, then stamp it logged in Supabase, then emit the
    ``posted`` event. So a crash between steps can at worst re-attempt a row that
    was written but not yet recorded — which the seen-store on the next run turns
    into a skip only once it's recorded, and Supabase's ``logged_at`` guard backs
    it up. A row that fails to write is never recorded and is retried next loop.

    Returns the number of rows actually posted.
    """
    postable = select_postable(rows, seen)

    posted = 0
    for row in postable:
        entry = row_to_entry(row)
        if entry["entry_id"] in seen:
            continue
        try:
            writer.append(entry)
        except Exception as ex:  # Excel closed, workbook locked, sheet missing…
            sink.event(
                "error",
                entry_id=entry["entry_id"],
                customer=entry["customer"],
                amount=entry["amount"],
                mode=entry["mode"],
                detail=_short(str(ex)),
            )
            # Stop the batch on a writer failure: if Excel is unavailable for one
            # row it's unavailable for all, and stopping keeps ordering intact.
            break
        seen.add(entry["entry_id"])
        sink.mark_logged(entry["entry_id"])
        sink.event(
            "posted",
            entry_id=entry["entry_id"],
            customer=entry["customer"],
            amount=entry["amount"],
            mode=entry["mode"],
        )
        posted += 1

    if posted:
        sink.event("caught_up", detail=f"{posted} entr{'y' if posted == 1 else 'ies'} logged")
    return posted


def _short(text: str, limit: int = 300) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"
