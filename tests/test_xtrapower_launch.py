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


import os
import socket
import subprocess
import sys

import pytest

linux = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux profile locks")


@linux
def test_a_lock_left_by_a_killed_chromium_is_removed(tmp_path):
    profile = tmp_path / "1"
    profile.mkdir()
    dead = subprocess.Popen(["true"]); dead.wait()
    os.symlink(f"{socket.gethostname()}-{dead.pid}", profile / "SingletonLock")
    os.symlink("/tmp/nowhere", profile / "SingletonSocket")
    assert launch.clear_stale_lock(str(profile))
    assert not os.path.lexists(profile / "SingletonLock") and not os.path.lexists(profile / "SingletonSocket")


@linux
def test_a_lock_whose_pid_now_belongs_to_another_program_is_removed(tmp_path):
    profile = tmp_path / "1"
    profile.mkdir()
    os.symlink(f"{socket.gethostname()}-{os.getpid()}", profile / "SingletonLock")   # (pytest: not Chromium)
    assert launch.clear_stale_lock(str(profile))


@linux
def test_a_chromium_really_using_the_profile_keeps_its_lock_unless_it_hung(tmp_path):
    profile = tmp_path / "1"
    profile.mkdir()
    chrome = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", f"--user-data-dir={profile}"],
                              start_new_session=True)
    try:
        os.symlink(f"{socket.gethostname()}-{chrome.pid}", profile / "SingletonLock")
        assert not launch.clear_stale_lock(str(profile))
        assert os.path.lexists(profile / "SingletonLock")
        assert launch.clear_stale_lock(str(profile), kill_hung=True)       # its port is closed: it hung
        assert chrome.wait(timeout=10) is not None
    finally:
        chrome.kill()


def test_a_window_that_closes_at_once_says_why(tmp_path, monkeypatch):
    chrome = tmp_path / "chrome"
    chrome.write_text("#!/bin/sh\necho '[1:1:ERROR:ozone_platform_x11.cc] Missing X server or $DISPLAY' >&2\nexit 1\n")
    chrome.chmod(0o755)
    monkeypatch.setattr(launch, "port_open", lambda port: False)
    r = launch.launch_account(str(chrome), {"label": "A", "customer_id": "1", "cdp_port": 9299}, str(tmp_path), wait=5)
    assert not r["ok"] and "closed at once (exit code 1)" in r["message"] and "Missing X server" in r["message"]
    launch.write_status(str(tmp_path / "s.json"), {"1": r})
    import json
    assert json.loads((tmp_path / "s.json").read_text())["1"]["ok"] is False


def test_an_open_window_is_not_started_twice(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(launch.subprocess, "Popen", lambda args, **kw: calls.append(args))
    monkeypatch.setattr(launch, "port_open", lambda port: True)
    r = launch.launch_account("chrome", {"label": "A", "customer_id": "1", "cdp_port": 9222}, str(tmp_path), wait=5)
    assert r["ok"] and calls == []
