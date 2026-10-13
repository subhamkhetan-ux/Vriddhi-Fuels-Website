"""launch.py overrides used by the server install (infra/xtrapower)."""

from xtrapower import launch


def test_chrome_override_wins_when_it_exists(tmp_path, monkeypatch):
    chrome = tmp_path / "chrome"
    chrome.write_text("")
    monkeypatch.setenv("XTRAPOWER_CHROME", str(chrome))
    assert launch.find_chrome() == str(chrome)


def test_missing_chrome_override_is_not_silently_replaced(tmp_path, monkeypatch):
    monkeypatch.setenv("XTRAPOWER_CHROME", str(tmp_path / "absent"))
    assert launch.find_chrome() is None


def test_extra_flags_are_passed_before_the_portal_url(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(launch.subprocess, "Popen", lambda args, **kw: calls.append(args))
    monkeypatch.setenv("XTRAPOWER_CHROME_FLAGS", "--no-sandbox --password-store=basic")
    launch.launch_account("chrome", {"label": "A", "customer_id": "1", "cdp_port": 9222}, str(tmp_path))
    args = calls[0]
    assert args[-3:] == ["--no-sandbox", "--password-store=basic", launch.PORTAL_URL]
    assert "--remote-debugging-port=9222" in args


def test_no_extra_flags_by_default(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(launch.subprocess, "Popen", lambda args, **kw: calls.append(args))
    monkeypatch.delenv("XTRAPOWER_CHROME_FLAGS", raising=False)
    launch.launch_account("chrome", {"label": "A", "customer_id": "1", "cdp_port": 9222}, str(tmp_path))
    assert calls[0][-2:] == ["--new-window", launch.PORTAL_URL]
