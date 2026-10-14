"""Tank stock stage 1: AnyDesk screenshot -> Telegram, with fakes only."""
import json
import os
from pathlib import Path
import threading

import pytest

from tank_stock import capture as cap, run, telegram


class FakeResponse:
    def __init__(self, ok=True):
        self.body = json.dumps({"ok": ok}).encode()
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def read(self):
        return self.body


@pytest.fixture(autouse=True)
def no_session_queue(monkeypatch, tmp_path):
    monkeypatch.setattr(run, "QUEUE", tmp_path / "no-queue")


@pytest.fixture(autouse=True)
def xtrapower_bot(monkeypatch, tmp_path):
    """The XtraPower bot's token and chat id, as use-xtrapower-bot.sh copies them."""
    bot = tmp_path / "tank-telegram.json"
    bot.write_text(json.dumps({"token": "123:abc", "chat_id": "42"}))
    monkeypatch.setattr(telegram, "BOT_FILE", bot)
    for var in ("TANK_TELEGRAM_TOKEN", "TANK_TELEGRAM_CHAT"):
        monkeypatch.delenv(var, raising=False)
    return bot


def test_screenshot_goes_to_the_xtrapower_bot_as_a_document(monkeypatch):
    sent = []
    monkeypatch.setattr(telegram.urllib.request, "urlopen",
                        lambda req, timeout: sent.append(req) or FakeResponse())
    assert telegram.send_photo(b"\x89PNGdata", "caption here")
    req = sent[0]
    assert req.full_url == "https://api.telegram.org/bot123:abc/sendDocument"
    assert b'name="chat_id"\r\n\r\n42' in req.data and b"\x89PNGdata" in req.data
    assert b'filename="tank-stock.png"' in req.data and b"caption here" in req.data


def test_without_the_bot_file_nothing_is_sent(monkeypatch, capsys, xtrapower_bot):
    xtrapower_bot.unlink()
    monkeypatch.setenv("TELEGRAM_TOKEN", "1:payment")   # the payment agent's bot is never used
    monkeypatch.setenv("TELEGRAM_CHAT", "1")
    monkeypatch.setattr(telegram.urllib.request, "urlopen", lambda *a, **k: pytest.fail("sent"))
    assert telegram.send_text("x") is False
    assert "use-xtrapower-bot.sh" in capsys.readouterr().out


def test_telegram_refusal_is_explained_in_the_log(monkeypatch, capsys):
    import io, urllib.error
    body = io.BytesIO(json.dumps({"ok": False, "description": "Bad Request: chat not found"}).encode())

    def refuse(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, body)
    monkeypatch.setattr(telegram.urllib.request, "urlopen", refuse)
    assert telegram.send_text("x") is False
    out = capsys.readouterr().out
    assert "chat not found" in out and "123:abc" not in out


def test_delivery_is_reported_masked(monkeypatch, capsys):
    sent = []
    monkeypatch.setattr(telegram, "_reported", False)

    class Resp(FakeResponse):
        def __init__(self, url):
            result = ({"username": "XtraPowerAlertBot"} if url.endswith("getMe")
                      else {"chat": {"type": "private", "first_name": "Subham"}})
            self.body = json.dumps({"ok": True, "result": result}).encode()
    monkeypatch.setattr(telegram.urllib.request, "urlopen",
                        lambda req, timeout: sent.append(req.full_url) or Resp(req.full_url))
    assert telegram.send_text("x")
    assert sent[0] == "https://api.telegram.org/bot123:abc/sendMessage"
    out = capsys.readouterr().out
    assert "XtraPower bot" in out and "@Xt…ot" in out and "private" in out and "'Su…am'" in out
    assert "XtraPowerAlertBot" not in out and "Subham" not in out and "123:abc" not in out


def test_tank_specific_secrets_override_the_bot_file(monkeypatch, capsys):
    sent = []
    monkeypatch.setenv("TANK_TELEGRAM_TOKEN", "9:tank")
    monkeypatch.setenv("TANK_TELEGRAM_CHAT", "99")
    monkeypatch.setattr(telegram, "_reported", False)

    class Resp(FakeResponse):
        def __init__(self, url):
            result = ({"username": "VriddhiStockBot"} if url.endswith("getMe")
                      else {"chat": {"type": "private", "first_name": "Subham"}})
            self.body = json.dumps({"ok": True, "result": result}).encode()
    monkeypatch.setattr(telegram.urllib.request, "urlopen",
                        lambda req, timeout: sent.append(req.full_url) or Resp(req.full_url))
    assert telegram.send_text("x")
    assert sent[0] == "https://api.telegram.org/bot9:tank/sendMessage"
    out = capsys.readouterr().out
    assert "TANK_TELEGRAM_*" in out and "@Vr…ot" in out and "private" in out and "'Su…am'" in out
    assert "VriddhiStockBot" not in out and "Subham" not in out


@pytest.mark.parametrize(("raw", "message"), [
    ("", "ANYDESK_IDS"), ("12; rm -rf /", "AnyDesk number or alias"),
])
def test_ids_are_checked_before_anything_starts(raw, message):
    with pytest.raises(cap.CaptureError, match=message):
        cap.parse_ids(raw)


def test_both_ids_are_read_in_any_common_format():
    assert cap.parse_ids("123 456 789, 987654321\n123456789") == ["123456789", "987654321"]


def test_missing_password_stops_before_connecting(monkeypatch):
    monkeypatch.setattr(cap.shutil, "which", lambda tool: f"/usr/bin/{tool}")
    monkeypatch.setattr(cap.subprocess, "Popen", lambda *a, **k: pytest.fail("must not start anything"))
    with pytest.raises(cap.CaptureError, match="ANYDESK_PASSWORD"):
        cap.capture(["123456789"], "")


def test_missing_tools_point_to_the_setup_script(monkeypatch):
    monkeypatch.setattr(cap.shutil, "which", lambda tool: None)
    with pytest.raises(cap.CaptureError, match="infra/anydesk/setup.sh"):
        cap.capture(["123456789"], "pw")


class FakeProc:
    pid = 0
    def poll(self):
        return 0


def _fake_session(monkeypatch, tmp_path, online):
    """Fake display/AnyDesk: only the ``online`` ID opens a session window."""
    monkeypatch.setattr(cap, "LAST_ID", tmp_path / "last-id")
    monkeypatch.setattr(cap.shutil, "which", lambda tool: f"/usr/bin/{tool}")
    monkeypatch.setattr(cap.subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(cap.time, "sleep", lambda s: None)
    tried = []
    def connect(anydesk_id, password, env, wait, log_path=None, before=None):
        tried.append(anydesk_id)
        return FakeProc(), (("7", "session", 1920, 1050) if anydesk_id == online else None)
    monkeypatch.setattr(cap, "_connect", connect)
    monkeypatch.setattr(cap, "_session_bus", lambda env: None)
    monkeypatch.setattr(cap, "_frontend", lambda env, log: FakeProc())
    monkeypatch.setattr(cap, "ensure_tank_status", lambda shoot, click, **kw: (shoot(), "already on Tank Status"))
    monkeypatch.setattr(cap, "_run", lambda *a, **k: "")
    monkeypatch.setattr(cap, "windows", lambda env: [])
    monkeypatch.setattr(cap.subprocess, "run", lambda *a, **k: type("R", (), {"stdout": b"\x89PNGx"})())
    return tried


def test_the_online_id_is_used_and_remembered_first_next_time(monkeypatch, tmp_path):
    tried = _fake_session(monkeypatch, tmp_path, online="222222222")
    png, _, used, page = cap.capture(["111111111", "222222222"], "pw")
    assert png.startswith(b"\x89PNG") and used == 2 and tried == ["111111111", "222222222"]
    tried.clear()
    cap.capture(["111111111", "222222222"], "pw")
    assert tried == ["222222222"]                       # last good ID first, no wasted wait


def test_no_online_id_is_a_clear_failure_with_what_each_attempt_showed(monkeypatch, tmp_path):
    _fake_session(monkeypatch, tmp_path, online=None)
    with pytest.raises(cap.CaptureError, match="None of the 2 AnyDesk IDs") as err:
        cap.capture(["111111111", "222222222"], "pw")
    assert [a["position"] for a in err.value.attempts] == [1, 2]
    assert all(a["png"].startswith(b"\x89PNG") for a in err.value.attempts)
    assert "main window process" in err.value.trace


def test_anydesk_main_window_is_not_mistaken_for_a_session(monkeypatch):
    main = ("5", "AnyDesk", 1000, 700)
    seen = iter([[main], [main], [main, ("9", "Remote", 1920, 1050)]])
    monkeypatch.setattr(cap, "windows", lambda env: next(seen))
    monkeypatch.setattr(cap.time, "sleep", lambda s: None)

    class Client(FakeProc):
        stdin = type("In", (), {"write": lambda self, b: None, "close": lambda self: None})()
    monkeypatch.setattr(cap.subprocess, "Popen", lambda *a, **k: Client())
    monkeypatch.setattr(cap, "_screenshot", lambda env: b"")       # (nothing for OCR: judged by the window)
    _, session = cap._connect("123456789", "pw", {}, wait=60)
    assert session[0] == "9"


def test_trace_report_reads_anydesk_logs(monkeypatch, tmp_path):
    trace = tmp_path / "anydesk.trace"
    trace.write_text("info  frontend  Connecting to 123\nerror  license denied\n")
    monkeypatch.setattr(cap, "TRACES", (trace,))
    log = tmp_path / "front.txt"
    log.write_text("Gtk-WARNING cannot open display")
    report = cap._trace(log, FakeProc(), None)
    assert "exited with 0" in report and "license denied" in report and "cannot open display" in report
    assert "session bus: none" in report


def test_failed_attempts_go_to_telegram_not_the_log(monkeypatch, capsys):
    monkeypatch.setenv("ANYDESK_IDS", "123456789")
    attempt = {"position": 1, "id": "123456789", "png": b"\x89PNG", "output": "license prompt",
               "windows": [("1", "AnyDesk 123456789", 400, 300)]}
    monkeypatch.setattr(run, "capture", lambda i, p: (_ for _ in ()).throw(
        cap.CaptureError("None of the 1 AnyDesk IDs opened a session", [attempt], "trace text")))
    photos, files = [], []
    monkeypatch.setattr(run.telegram, "send_file", lambda data, name, ctype, caption: files.append(name) or True)
    monkeypatch.setattr(run.telegram, "send_text", lambda t: True)
    monkeypatch.setattr(run.telegram, "send_photo", lambda png, caption: photos.append(caption) or True)
    assert run.main(["--capture"]) == 1
    assert "ID #1 (123456789)" in photos[0] and "license prompt" in photos[0]
    out = capsys.readouterr()
    assert "1 of 1 attempt report(s) delivered; AnyDesk trace sent" in out.out
    assert files == ["anydesk-trace.txt"]
    assert "123456789" not in out.out + out.err and "license prompt" not in out.out + out.err


def test_run_keeps_titles_and_password_out_of_the_log(monkeypatch, capsys):
    monkeypatch.setenv("ANYDESK_IDS", "111 111 111, 123 456 789")
    monkeypatch.setenv("ANYDESK_PASSWORD", "s3cret")
    seen = {}
    monkeypatch.setattr(run, "capture", lambda ids, pw: (seen.update(ids=ids, pw=pw) or b"\x89PNG",
                                                         [("1", "IOCL-PC 123456789", 1920, 1050)], 2,
                                                         "already on Tank Status"))
    monkeypatch.setattr(run.telegram, "send_photo", lambda png, caption: seen.update(caption=caption) or True)
    assert run.main(["--capture"]) == 0
    out = capsys.readouterr()
    assert seen["ids"] == ["111111111", "123456789"] and seen["pw"] == "s3cret"
    assert "ID #2 (123456789)" in seen["caption"]                   # private Telegram caption
    assert "via ID #2 of 2" in out.out and "already on Tank Status" in seen["caption"]
    assert "123456789" not in out.out + out.err and "s3cret" not in out.out + out.err


def test_a_failed_capture_is_reported_privately(monkeypatch):
    monkeypatch.setenv("ANYDESK_IDS", "123456789")
    monkeypatch.setattr(run, "capture", lambda i, p: (_ for _ in ()).throw(cap.CaptureError("no session")))
    texts = []
    monkeypatch.setattr(run.telegram, "send_text", lambda t: texts.append(t) or True)
    assert run.main(["--capture"]) == 1 and "no session" in texts[0]


TRACE = """\
  error 2026-10-13 12:04:22.214         ad   main  24198  24198   base.dyn_library - Unable to load library libpipewire-0.3.so
explode 2026-10-13 12:04:22.214         ad   main  24198  24198   app.common_path - The logged in user differs from the (non-root) user this process runs as. Process UID: 1002 , logged in UID: 0
  crash 2026-10-13 12:04:22.214         ad   main  24198  24198   backtrace - Process crashed
  error 2026-10-13 11:21:23.301       gsvc    dns  20349  20477   anynet.dns_resolver - DNS name couldn't be resolved
   info 2026-10-13 12:04:22.199         ad   main  24198  24198   main - Command Line params: '834626021 --with-password'
"""


def test_public_diagnosis_gives_the_reason_without_ids(monkeypatch):
    def fake_run(cmd, env, timeout=15):
        if cmd[:2] == ["loginctl", "list-sessions"]:
            return "  c1 1002 runner seat0 tty7\n"
        if cmd[:2] == ["loginctl", "show-session"]:
            return "Name=runner\nSeat=seat0\nActive=yes\n"
        if cmd[:2] == ["loginctl", "show-seat"]:
            return "c1\n"
        return "runner   tty7  2026-10-13 12:00\n" if cmd == ["who"] else ""
    monkeypatch.setattr(cap, "_run", fake_run)
    lines = cap.diagnosis(TRACE)
    text = "\n".join(lines)
    assert "login session c1: Name=runner Seat=seat0 Active=yes" in text
    assert "logged in (who): runner" in text and "seat0 active session: c1" in text
    assert "The logged in user differs" in text and "libpipewire" in text
    assert "DNS" not in text and "834626021" not in text


def test_failure_log_prints_the_diagnosis(monkeypatch, capsys):
    monkeypatch.setenv("ANYDESK_IDS", "123456789")
    monkeypatch.setattr(run, "capture", lambda i, p: (_ for _ in ()).throw(
        cap.CaptureError("None of the 1 AnyDesk IDs opened a session", [], TRACE)))
    monkeypatch.setattr(run, "diagnosis", lambda trace: ["AnyDesk: masked reason"])
    for name in ("send_text", "send_file"):
        monkeypatch.setattr(run.telegram, name, lambda *a: True)
    assert run.main(["--capture"]) == 1
    assert "  AnyDesk: masked reason" in capsys.readouterr().out


def test_capture_is_handed_to_the_login_session_and_relayed(monkeypatch, tmp_path, capsys):
    queue = tmp_path / "queue"
    queue.mkdir()
    monkeypatch.setattr(run, "QUEUE", queue)
    monkeypatch.setenv("ANYDESK_IDS", "123456789")
    monkeypatch.setenv("ANYDESK_PASSWORD", "s3cret")
    seen = {}

    def session():                      # what the monitor's queue_loop does
        while not list(queue.glob("*.req")):
            pass
        req = next(queue.glob("*.req"))
        job = str(req)[:-4]
        seen["workdir"] = req.read_text()
        seen["mode"] = oct(Path(job + ".env").stat().st_mode & 0o777)
        req.unlink()
        monkeypatch.setattr(run, "capture_and_report", lambda: print("Captured via ID #1") or 0)
        seen["env"] = run.main(["--in-session", job]) == 0 and dict(ids=os.environ["ANYDESK_IDS"])
        Path(job + ".log").write_text("Captured via ID #1\n")
        Path(job + ".rc.tmp").write_text("0\n")
        os.replace(job + ".rc.tmp", job + ".rc")      # atomic, as the script's mv

    worker = threading.Thread(target=session)
    worker.start()
    monkeypatch.setattr(run.time, "sleep", lambda s: None)
    assert run.main(["--capture"]) == 0
    worker.join()
    out = capsys.readouterr().out
    assert "Captured via ID #1" in out and "s3cret" not in out
    assert seen["mode"] == "0o600" and seen["workdir"] == os.getcwd() and seen["env"]["ids"] == "123456789"
    assert list(queue.iterdir()) == []               # secrets file and request cleaned up


def test_a_session_that_never_answers_fails_clearly(monkeypatch, tmp_path, capsys):
    queue = tmp_path / "queue"
    queue.mkdir()
    monkeypatch.setattr(run, "QUEUE", queue)
    monkeypatch.setenv("ANYDESK_PASSWORD", "s3cret")
    assert run.via_session(wait=0) == 1
    assert "systemctl status tank-stock-session" in capsys.readouterr().err
    assert list(queue.iterdir()) == []


def _words(*texts):
    return [(t, 100 * i, 500, 60, 12) for i, t in enumerate(texts)]


def _connect_rig(monkeypatch, screens):
    """_connect with a session window that shows, in turn, ``screens`` (OCR words)."""
    main, sess = ("5", "AnyDesk", 1000, 700), ("9", "123 456 789", 1920, 1050)
    monkeypatch.setattr(cap, "windows", lambda env: [main, sess])
    monkeypatch.setattr(cap.time, "sleep", lambda s: None)
    monkeypatch.setattr(cap, "_screenshot", lambda env: b"\x89PNG")
    shown = iter(screens)
    monkeypatch.setattr(cap, "ocr", lambda png, *a, **k: next(shown, screens[-1]))
    runs = []
    monkeypatch.setattr(cap, "_run", lambda cmd, env: runs.append(cmd) or "")

    class Client(FakeProc):
        stdin = type("In", (), {"write": lambda self, b: None, "close": lambda self: None})()
    monkeypatch.setattr(cap.subprocess, "Popen", lambda *a, **k: Client())
    return runs, {"5"}


def test_an_offline_id_that_opens_a_session_window_is_not_taken_for_connected(monkeypatch):
    offline = _words("Client", "Offline", "This", "desk", "is", "not", "available.", "Power", "on", "Retry", "Cancel")
    runs, main = _connect_rig(monkeypatch, [offline, offline])
    client, session = cap._connect("111111111", "pw", {}, wait=60, before=main)
    assert session is None and client.said == "client offline"
    assert any(c[:2] == ["xdotool", "mousemove"] and c[-2:] == ["click", "1"] for c in runs)   # Cancel
    assert ["xdotool", "windowclose", "9"] in runs                                             # and its tab


def test_while_anydesk_is_still_connecting_it_waits_for_the_pcs_screen(monkeypatch):
    runs, main = _connect_rig(monkeypatch, [_words("Waiting", "for", "image"), _words("FuelTrans", "Monitoring")])
    client, session = cap._connect("222222222", "pw", {}, wait=60, before=main)
    assert session[0] == "9" and client.said == ""


def test_the_other_id_is_tried_when_the_first_shows_client_offline(monkeypatch, tmp_path):
    monkeypatch.setattr(cap, "LAST_ID", tmp_path / "last-id")
    monkeypatch.setattr(cap.shutil, "which", lambda tool: f"/usr/bin/{tool}")
    monkeypatch.setattr(cap.subprocess, "Popen", lambda *a, **k: FakeProc())
    monkeypatch.setattr(cap.time, "sleep", lambda s: None)
    monkeypatch.setattr(cap, "_session_bus", lambda env: None)
    monkeypatch.setattr(cap, "_frontend", lambda env, log: FakeProc())
    monkeypatch.setattr(cap, "ensure_tank_status", lambda shoot, click, **kw: (shoot(), "already on Tank Status"))
    monkeypatch.setattr(cap, "_run", lambda *a, **k: "")
    monkeypatch.setattr(cap, "windows", lambda env: [])
    monkeypatch.setattr(cap.subprocess, "run", lambda *a, **k: type("R", (), {"stdout": b"\x89PNGx"})())
    tried = []

    def connect(anydesk_id, password, env, wait, log_path=None, before=None):
        tried.append(anydesk_id)
        client = FakeProc()
        client.said = "client offline" if anydesk_id == "111111111" else ""
        return client, (None if client.said else ("7", "session", 1920, 1050))
    monkeypatch.setattr(cap, "_connect", connect)
    (tmp_path / "last-id").write_text("111111111")                  # the one that worked last, now offline
    png, _, used, _ = cap.capture(["111111111", "222222222"], "pw")
    assert tried == ["111111111", "222222222"] and used == 2
    assert (tmp_path / "last-id").read_text().strip() == "222222222"


def test_when_neither_id_connects_the_error_says_what_anydesk_showed(monkeypatch, tmp_path):
    tried = _fake_session(monkeypatch, tmp_path, online=None)

    def connect(anydesk_id, password, env, wait, log_path=None, before=None):
        tried.append(anydesk_id)
        client = FakeProc()
        client.said = "client offline"
        return client, None
    monkeypatch.setattr(cap, "_connect", connect)
    with pytest.raises(cap.CaptureError, match="ID 1: AnyDesk said “client offline”; ID 2"):
        cap.capture(["111111111", "222222222"], "pw")
