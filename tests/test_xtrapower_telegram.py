"""Telegram /status and /logs: parsing, replies, and the getUpdates loop.

Standard library only (no Playwright, no network): Telegram is replaced by a
fake ``_urlopen`` and a fake client that records what would be sent.
"""

import io
import json
import logging
import urllib.error
from datetime import datetime, timezone

import pytest

from xtrapower import telegram_bot as tb

NOW = 1_800_000_000.0
TOKEN = "123456789:AAEabcdefghijklmnopqrstuvwxyzWXYZ"


def _iso(epoch):
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


def _msg(uid, text, chat=42, date=NOW):
    return {"update_id": uid, "message": {"chat": {"id": chat}, "date": date, "text": text}}


# ---- parsing ---------------------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("/status", ("status", "")),
    ("/status@XtraBot", ("status", "")),
    ("Status", ("status", "")),
    ("/logs 30", ("logs", "30")),
    ("/log", ("logs", "")),
    ("/start", ("help", "")),
    ("/whatever", ("help", "")),
    ("hello there", None),
    ("", None),
    (None, None),
])
def test_parse_command(text, expected):
    assert tb.parse_command(text) == expected


def test_select_commands_answers_only_our_chat_and_skips_old_messages():
    updates = [
        _msg(10, "/status"),
        _msg(11, "/status", chat=999),               # a stranger
        _msg(12, "/logs", date=NOW - 3600),          # sent while the monitor was off
        _msg(13, "just chatting"),
        {"update_id": 14, "channel_post": {"text": "/status"}},
    ]
    cmds, offset = tb.select_commands(updates, "42", NOW - 60, None)
    assert cmds == [("status", "")]
    assert offset == 15                               # everything acknowledged


def test_select_commands_keeps_offset_when_nothing_new():
    assert tb.select_commands([], "42", NOW, 7) == ([], 7)


@pytest.mark.parametrize("arg,n", [("", 15), ("40", 40), ("500", 50), ("0", 1), ("x", 15)])
def test_log_count(arg, n):
    assert tb.log_count(arg) == n


def test_ago_and_duration():
    assert tb.ago(10) == "just now"
    assert tb.ago(5 * 60) == "5 min ago"
    assert tb.ago(2 * 3600) == "2 h ago"
    assert tb.ago(2 * 3600 + 300) == "2 h 5 min ago"
    assert tb.ago(3 * 86400) == "3 days ago"
    assert tb.duration(30) == "under a minute"
    assert tb.duration(3 * 3600 + 600) == "3 h 10 min"
    assert tb.duration(86400 + 3600) == "1 day 1 h"


# ---- /status -----------------------------------------------------------------------

def _snap(**over):
    snap = {
        "started": NOW - 3 * 3600,
        "last_end": NOW - 30,
        "poll": 120,
        "accounts": [
            {"label": "Shyam", "key": "1001", "watch": True},
            {"label": "Ember <Coal>", "key": "2002", "watch": True},
            {"label": "Spare", "key": "3003", "watch": False},
        ],
        "ready": {"1001": True},
        "state": {"accounts": {
            "1001": {"ccms": "₹1,00,000.00", "updated_at": _iso(NOW - 90)},
            "2002": {"last_error": "logged-out", "last_error_at": _iso(NOW - 600)},
        }},
    }
    snap.update(over)
    return snap


def test_status_when_healthy():
    text = tb.format_status(_snap(), NOW)
    assert text.startswith("🟢")
    assert "Up 3 h · last check just now · checks every 2 min" in text
    assert "✅ <b>Shyam</b> — watching" in text
    assert "CCMS ₹1,00,000.00 · read 1 min ago" in text
    assert "⏳ <b>Ember &lt;Coal&gt;</b>" in text           # names are HTML-escaped
    assert "⚠️ Logged out · 10 min ago" in text
    assert "⚪ <b>Spare</b> — off" in text


def test_status_before_the_first_check_finishes():
    assert tb.format_status(_snap(last_end=None), NOW).startswith("🟡")


def test_status_warns_when_checks_have_stalled():
    text = tb.format_status(_snap(last_end=NOW - 1800), NOW)
    assert text.startswith("🟠") and "may be stuck" in text and "30 min ago" in text


def test_status_with_no_accounts():
    assert "No accounts" in tb.format_status(_snap(accounts=[], ready={}), NOW)


# ---- /logs ---------------------------------------------------------------------------

def test_logs_are_escaped_and_wrapped():
    text = tb.format_logs(["a <b> & c", "second"], 15)
    assert "Last 2 log lines" in text
    assert "<pre>a &lt;b&gt; &amp; c\nsecond</pre>" in text


def test_logs_are_trimmed_to_one_message_keeping_the_newest():
    lines = [f"{i:04d} " + "x" * 200 for i in range(50)]
    text = tb.format_logs(lines, 50)
    assert len(text) <= tb.MAX_MESSAGE_CHARS
    assert "trimmed" in text and "0049 " in text and "0000 " not in text


def test_logs_when_empty():
    assert "No log lines yet" in tb.format_logs([], 15)


def test_log_buffer_keeps_recent_info_lines():
    buf = tb.LogBuffer(capacity=3)
    lg = logging.getLogger("xtrapower.test-buffer")
    lg.setLevel(logging.DEBUG)
    lg.addHandler(buf)
    try:
        lg.debug("too chatty")
        for i in range(5):
            lg.info("line %d", i)
    finally:
        lg.removeHandler(buf)
    tail = buf.tail(10)
    assert [t.split(" INFO ")[1] for t in tail] == ["line 2", "line 3", "line 4"]
    assert buf.tail(1)[0].endswith("line 4") and buf.tail(0) == []


# ---- the listener ----------------------------------------------------------------------

class FakeTG:
    def __init__(self, token=TOKEN, chat_id="42"):
        self.token, self.chat_id, self.sent = token, chat_id, []

    def send(self, text):
        self.sent.append(text)
        return True


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def telegram(monkeypatch):
    """Queue getUpdates results; records each request's URL and form."""
    calls, queue = [], []

    def fake_urlopen(req, timeout=None):
        calls.append((req.full_url, dict(p.split("=", 1) for p in req.data.decode().split("&"))))
        item = queue.pop(0) if queue else []
        if isinstance(item, Exception):
            raise item
        return FakeResp(json.dumps({"ok": True, "result": item}).encode())

    monkeypatch.setattr(tb, "_urlopen", fake_urlopen)
    return calls, queue


def _listener(tg, logs=None):
    logs = logs or tb.LogBuffer()
    return tb.CommandListener(lambda: tg, lambda: _snap(), logs, NOW - 3600, long_poll=1)


def test_poll_once_answers_and_acknowledges(telegram):
    calls, queue = telegram
    tg = FakeTG()
    lis = _listener(tg)
    queue.append([_msg(5, "/status", date=NOW), _msg(6, "/status", chat=7, date=NOW)])
    assert lis.poll_once() == 1
    assert len(tg.sent) == 1 and "XtraPower monitor is running" in tg.sent[0]
    assert calls[0][0] == f"{tb.API_BASE}/bot{TOKEN}/getUpdates"
    assert "offset" not in calls[0][1]
    assert lis.poll_once() == 0
    assert calls[1][1]["offset"] == "7"                # both updates acknowledged


def test_poll_once_logs_and_help(telegram):
    _, queue = telegram
    tg, buf = FakeTG(), tb.LogBuffer()
    buf.emit(logging.LogRecord("x", logging.INFO, __file__, 1, "Shyam: CCMS 5", None, None))
    queue.append([_msg(1, "/logs 5", date=NOW), _msg(2, "/nope", date=NOW)])
    assert _listener(tg, buf).poll_once() == 2
    assert "Shyam: CCMS 5" in tg.sent[0] and tg.sent[1] == tb.HELP_TEXT


def test_poll_once_does_nothing_until_telegram_is_set_up(telegram):
    calls, _ = telegram
    assert _listener(FakeTG(token="PUT-YOUR-BOTFATHER-TOKEN-HERE")).poll_once() is None
    assert _listener(FakeTG(chat_id=None)).poll_once() is None
    assert calls == []


def test_a_new_token_starts_from_scratch(telegram):
    calls, queue = telegram
    tg = FakeTG()
    lis = _listener(tg)
    queue.append([_msg(9, "hi", date=NOW)])
    lis.poll_once()
    tg.token = "987654321:BBEabcdefghijklmnopqrstuvwxyzWXYZ"
    lis.poll_once()
    assert "offset" not in calls[1][1] and "987654321" in calls[1][0]


def test_a_broken_reply_does_not_stop_the_listener(telegram):
    _, queue = telegram
    tg = FakeTG()
    lis = tb.CommandListener(lambda: tg, lambda: 1 / 0, tb.LogBuffer(), NOW - 3600, long_poll=1)
    queue.append([_msg(1, "/status", date=NOW)])
    assert lis.poll_once() == 1
    assert "Couldn't build that reply (ZeroDivisionError)" in tg.sent[0]


class _Stop(BaseException):      # not caught by the listener's own `except Exception`
    pass


def test_run_forever_reports_a_conflict_once_and_keeps_going(telegram, monkeypatch, caplog):
    _, queue = telegram
    tg = FakeTG()
    conflict = urllib.error.HTTPError("u", 409, "Conflict", {}, None)
    queue.extend([conflict, conflict, [_msg(1, "/status", date=NOW)]])
    sleeps = []

    def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) > 2:
            raise _Stop

    monkeypatch.setattr(tb.time, "sleep", fake_sleep)
    lis = _listener(tg)
    orig = lis.poll_once

    def poll_then_stop():
        if not queue:
            raise _Stop
        return orig()

    lis.poll_once = poll_then_stop
    with caplog.at_level(logging.INFO, logger="xtrapower.telegram"):
        with pytest.raises(_Stop):
            lis.run_forever()
    assert sleeps == [60, 60]
    assert sum("409 Conflict" in r.message for r in caplog.records) == 1
    assert any("working again" in r.message for r in caplog.records)
    assert len(tg.sent) == 1


def test_run_forever_survives_network_errors(telegram, monkeypatch):
    _, queue = telegram
    queue.append(OSError("no route"))
    sleeps = []

    def fake_sleep(seconds):
        sleeps.append(seconds)
        raise _Stop

    monkeypatch.setattr(tb.time, "sleep", fake_sleep)
    lis = _listener(FakeTG())
    with pytest.raises(_Stop):
        lis.run_forever()
    assert sleeps == [15] and "OSError" in lis._last_problem
