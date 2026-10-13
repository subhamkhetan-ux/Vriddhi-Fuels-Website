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


def test_screenshot_goes_to_telegram_as_a_document(monkeypatch):
    sent = []
    monkeypatch.setenv("TELEGRAM_TOKEN", "123:abc")
    monkeypatch.setenv("TELEGRAM_CHAT", "42")
    monkeypatch.setattr(telegram.urllib.request, "urlopen",
                        lambda req, timeout: sent.append(req) or FakeResponse())
    assert telegram.send_photo(b"\x89PNGdata", "caption here")
    req = sent[0]
    assert req.full_url == "https://api.telegram.org/bot123:abc/sendDocument"
    assert b'name="chat_id"\r\n\r\n42' in req.data and b"\x89PNGdata" in req.data
    assert b'filename="tank-stock.png"' in req.data and b"caption here" in req.data


def test_without_telegram_nothing_is_sent(monkeypatch, capsys):
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    assert telegram.send_text("x") is False
    assert "not configured" in capsys.readouterr().out


@pytest.mark.parametrize(("anydesk_id", "password", "message"), [
    ("", "pw", "ANYDESK_ID"), ("12; rm -rf /", "pw", "ANYDESK_ID"), ("123456789", "", "ANYDESK_PASSWORD"),
])
def test_capture_checks_its_inputs_before_connecting(monkeypatch, anydesk_id, password, message):
    monkeypatch.setattr(cap.shutil, "which", lambda tool: f"/usr/bin/{tool}")
    monkeypatch.setattr(cap.subprocess, "Popen", lambda *a, **k: pytest.fail("must not start anything"))
    with pytest.raises(cap.CaptureError, match=message):
        cap.capture(anydesk_id, password)


def test_missing_tools_point_to_the_setup_script(monkeypatch):
    monkeypatch.setattr(cap.shutil, "which", lambda tool: None)
    with pytest.raises(cap.CaptureError, match="infra/anydesk/setup.sh"):
        cap.capture("123456789", "pw")


def test_run_keeps_titles_and_password_out_of_the_log(monkeypatch, capsys):
    monkeypatch.setenv("ANYDESK_ID", "123 456 789")
    monkeypatch.setenv("ANYDESK_PASSWORD", "s3cret")
    seen = {}
    monkeypatch.setattr(run, "capture", lambda i, p: (seen.update(id=i, pw=p) or b"\x89PNG",
                                                       [("1", "IOCL-PC 123456789", 1920, 1050)]))
    monkeypatch.setattr(run.telegram, "send_photo", lambda png, caption: seen.update(caption=caption) or True)
    assert run.main(["--capture"]) == 0
    out = capsys.readouterr()
    assert seen["id"] == "123 456 789" and seen["pw"] == "s3cret"
    assert "IOCL-PC 123456789 1920x1050" in seen["caption"]          # private Telegram caption
    assert "123456789" not in out.out + out.err and "s3cret" not in out.out + out.err


def test_a_failed_capture_is_reported_privately(monkeypatch):
    monkeypatch.setattr(run, "capture", lambda i, p: (_ for _ in ()).throw(cap.CaptureError("no session")))
    texts = []
    monkeypatch.setattr(run.telegram, "send_text", lambda t: texts.append(t) or True)
    assert run.main(["--capture"]) == 1 and "no session" in texts[0]
