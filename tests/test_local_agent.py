"""Tests for the always-on Mac logging daemon (``local_agent``).

Excel itself can't run in CI, so the Excel append is behind an interface and we
inject a fake writer. Everything tested here is the daemon's decision logic:
row -> Master-Paid mapping, the postable gate, the post loop's ordering and
idempotency, event emission, and the on-disk seen-store guard.
"""

import datetime as dt

import pytest

from agent.serial import EPOCH, date_to_serial
from local_agent import poster
from local_agent.seen_store import SeenStore


# ---- fakes ------------------------------------------------------------

class FakeWriter:
    def __init__(self, fail_ids=None):
        self.written = []
        self.fail_ids = set(fail_ids or [])

    def append(self, entry):
        if entry["entry_id"] in self.fail_ids:
            raise RuntimeError("Excel not open")
        self.written.append(entry)


class FakeSink:
    def __init__(self):
        self.logged = []
        self.events = []

    def mark_logged(self, entry_id):
        self.logged.append(entry_id)

    def event(self, kind, **fields):
        self.events.append({"kind": kind, **fields})

    def kinds(self):
        return [e["kind"] for e in self.events]


def _row(entry_id, *, customer="A.K.V. Logistics", amount=1000, serial=45900,
         status="matched", mode="HDFC NEFT"):
    return {
        "entry_id": entry_id, "customer": customer, "amount": amount,
        "date_serial": serial, "status": status, "mode": mode,
    }


# ---- serial <-> date --------------------------------------------------

def test_serial_to_date_matches_agent_epoch():
    d = dt.date(2026, 8, 29)
    serial = date_to_serial(d)                 # agent's forward conversion
    assert poster.serial_to_date(serial) == d  # daemon's inverse round-trips

def test_serial_to_date_known_epoch_day():
    # serial 1 is 1899-12-31 (day after the 1899-12-30 epoch).
    assert poster.serial_to_date(1) == EPOCH + dt.timedelta(days=1)


# ---- row_to_entry -----------------------------------------------------

def test_row_to_entry_shapes_all_four_columns():
    e = poster.row_to_entry(_row("a1", amount="1500.0", mode=" HDFC UPI "))
    assert e["entry_id"] == "a1"
    assert isinstance(e["date"], dt.date)
    assert e["customer"] == "A.K.V. Logistics"
    assert e["amount"] == 1500.0 and isinstance(e["amount"], float)
    assert e["mode"] == "HDFC UPI"           # stripped

def test_row_to_entry_tolerates_missing_mode_and_customer_ws():
    e = poster.row_to_entry({"entry_id": "a2", "customer": "  X Ltd ",
                             "amount": 5, "date_serial": 45900})
    assert e["customer"] == "X Ltd" and e["mode"] == ""


# ---- postable gate ----------------------------------------------------

def test_select_postable_excludes_review_seen_and_incomplete():
    rows = [
        _row("ok"),
        _row("review", status="review"),        # not resolved
        _row("nocust", customer=""),             # no canonical name
        {"entry_id": "noamt", "customer": "Y", "date_serial": 1, "status": "matched"},
        _row("already"),                          # in seen
    ]
    out = poster.select_postable(rows, {"already"})
    assert [r["entry_id"] for r in out] == ["ok"]

def test_select_postable_sorts_by_date_then_customer():
    rows = [
        _row("late", serial=45901, customer="B"),
        _row("early2", serial=45900, customer="Z"),
        _row("early1", serial=45900, customer="A"),
    ]
    out = poster.select_postable(rows, set())
    assert [r["entry_id"] for r in out] == ["early1", "early2", "late"]


# ---- post_batch: happy path, idempotency, failure --------------------

def test_post_batch_writes_marks_and_emits_in_order():
    rows = [_row("a1", customer="A", serial=45900),
            _row("a2", customer="B", serial=45901)]
    w, sink, seen = FakeWriter(), FakeSink(), set()
    n = poster.post_batch(rows, w, seen, sink)
    assert n == 2
    assert [e["entry_id"] for e in w.written] == ["a1", "a2"]
    assert sink.logged == ["a1", "a2"]
    assert seen == {"a1", "a2"}
    assert sink.kinds() == ["posted", "posted", "caught_up"]

def test_post_batch_skips_already_seen():
    rows = [_row("a1"), _row("a2")]
    w, sink, seen = FakeWriter(), FakeSink(), {"a1"}
    n = poster.post_batch(rows, w, seen, sink)
    assert n == 1
    assert [e["entry_id"] for e in w.written] == ["a2"]
    assert "a1" not in sink.logged

def test_post_batch_stops_and_reports_on_writer_failure():
    # a2 fails to write: a1 is committed, a2 is not marked/seen, and an error
    # event carries the reason. a2 will be retried on the next loop.
    rows = [_row("a1", serial=45900), _row("a2", serial=45901)]
    w, sink, seen = FakeWriter(fail_ids={"a2"}), FakeSink(), set()
    n = poster.post_batch(rows, w, seen, sink)
    assert n == 1
    assert seen == {"a1"}
    assert sink.logged == ["a1"]
    assert "error" in sink.kinds()
    err = next(e for e in sink.events if e["kind"] == "error")
    assert err["entry_id"] == "a2" and "Excel not open" in err["detail"]

def test_post_batch_no_rows_emits_nothing():
    w, sink, seen = FakeWriter(), FakeSink(), set()
    assert poster.post_batch([_row("r", status="review")], w, seen, sink) == 0
    assert sink.events == []


# ---- seen-store persistence ------------------------------------------

def test_seen_store_persists_across_instances(tmp_path):
    path = str(tmp_path / "sub" / "posted.json")   # nested dir created on write
    s = SeenStore(path)
    assert "x1" not in s
    s.add("x1")
    s.add("x1")                                      # idempotent
    s2 = SeenStore(path)                             # reload from disk
    assert "x1" in s2

def test_seen_store_survives_corrupt_file(tmp_path):
    path = tmp_path / "posted.json"
    path.write_text("not json{")
    s = SeenStore(str(path))
    assert "anything" not in s                       # starts empty, no crash
    s.add("ok")
    assert "ok" in SeenStore(str(path))
