"""Tank stock stage 1: AnyDesk screenshot -> Telegram, with fakes only."""
import json

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
    def connect(anydesk_id, password, env, wait, log_path=None):
        tried.append(anydesk_id)
        return FakeProc(), (("7", "session", 1920, 1050) if anydesk_id == online else None)
    monkeypatch.setattr(cap, "_connect", connect)
    monkeypatch.setattr(cap, "_run", lambda *a, **k: "")
    monkeypatch.setattr(cap, "windows", lambda env: [])
    monkeypatch.setattr(cap.subprocess, "run", lambda *a, **k: type("R", (), {"stdout": b"\x89PNGx"})())
    return tried


def test_the_online_id_is_used_and_remembered_first_next_time(monkeypatch, tmp_path):
    tried = _fake_session(monkeypatch, tmp_path, online="222222222")
    png, _, used = cap.capture(["111111111", "222222222"], "pw")
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


def test_failed_attempts_go_to_telegram_not_the_log(monkeypatch, capsys):
    monkeypatch.setenv("ANYDESK_IDS", "123456789")
    attempt = {"position": 1, "id": "123456789", "png": b"\x89PNG", "output": "license prompt",
               "windows": [("1", "AnyDesk 123456789", 400, 300)]}
    monkeypatch.setattr(run, "capture", lambda i, p: (_ for _ in ()).throw(
        cap.CaptureError("None of the 1 AnyDesk IDs opened a session", [attempt])))
    photos = []
    monkeypatch.setattr(run.telegram, "send_text", lambda t: True)
    monkeypatch.setattr(run.telegram, "send_photo", lambda png, caption: photos.append(caption) or True)
    assert run.main(["--capture"]) == 1
    assert "ID #1 (123456789)" in photos[0] and "license prompt" in photos[0]
    out = capsys.readouterr()
    assert "1 of 1 attempt report(s) delivered" in out.out
    assert "123456789" not in out.out + out.err and "license prompt" not in out.out + out.err


def test_run_keeps_titles_and_password_out_of_the_log(monkeypatch, capsys):
    monkeypatch.setenv("ANYDESK_IDS", "111 111 111, 123 456 789")
    monkeypatch.setenv("ANYDESK_PASSWORD", "s3cret")
    seen = {}
    monkeypatch.setattr(run, "capture", lambda ids, pw: (seen.update(ids=ids, pw=pw) or b"\x89PNG",
                                                         [("1", "IOCL-PC 123456789", 1920, 1050)], 2))
    monkeypatch.setattr(run.telegram, "send_photo", lambda png, caption: seen.update(caption=caption) or True)
    assert run.main(["--capture"]) == 0
    out = capsys.readouterr()
    assert seen["ids"] == ["111111111", "123456789"] and seen["pw"] == "s3cret"
    assert "ID #2 (123456789)" in seen["caption"]                   # private Telegram caption
    assert "via ID #2 of 2" in out.out
    assert "123456789" not in out.out + out.err and "s3cret" not in out.out + out.err


def test_a_failed_capture_is_reported_privately(monkeypatch):
    monkeypatch.setenv("ANYDESK_IDS", "123456789")
    monkeypatch.setattr(run, "capture", lambda i, p: (_ for _ in ()).throw(cap.CaptureError("no session")))
    texts = []
    monkeypatch.setattr(run.telegram, "send_text", lambda t: texts.append(t) or True)
    assert run.main(["--capture"]) == 1 and "no session" in texts[0]
