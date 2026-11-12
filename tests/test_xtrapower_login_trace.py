"""A login that doesn't go through says why, in the log (/logs on Telegram):
what the login page shows, and what became of the requests it made after
Sign In: answered (and how), refused, or left hanging. Never the password.

A real Chromium against a stand-in login page; skipped without Playwright's
browser.
"""

import asyncio
import http.server
import logging
import os
import threading
import time

import pytest

pytest.importorskip("playwright.async_api")
from playwright.async_api import async_playwright  # noqa: E402

from xtrapower import browser  # noqa: E402

PASSWORD = "S3cret-pass!"

PAGE = """<!doctype html><html><body>
<form onsubmit="return false">
  <input id="email"><input id="password" type="password">
  <button id="normal" type="button">Sign In</button>
</form>
<div id="out"></div>
<script>
document.getElementById('normal').onclick = async () => {
  const out = document.getElementById('out');
  out.innerHTML = '<span>Loading...</span>';
  setTimeout(() => { if (!window.answered) out.insertAdjacentHTML('beforeend',
    '<div role="dialog">Trouble login: Having Trouble Logging in ? Please press Ctrl + Shift + R</div>'); }, 2000);
  const r = await fetch('/api/login' + location.search, { method: 'POST',
    body: JSON.stringify({ u: document.getElementById('email').value, p: document.getElementById('password').value }) });
  window.answered = true;
  if (r.ok) { location.href = '/dashboard'; return; }
  out.innerHTML = '<div role="alert">Invalid User ID or password</div>';
};
</script></body></html>"""


class _Portal(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/html"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/account/login"):
            self._send(200, PAGE)
        else:
            self._send(200, "<html><body>Dashboard</body></html>")

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if "mode=hang" in self.path:
            time.sleep(25)                       # (the portal not answering)
            return
        if "mode=deny" in self.path:
            self._send(401, '{"error":"invalid"}', "application/json")
        else:
            self._send(200, '{"ok":true}', "application/json")


@pytest.fixture(scope="module")
def portal():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Portal)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def _login(portal, mode, monkeypatch):
    monkeypatch.setattr(browser, "PORTAL_HINT", "127.0.0.1")
    monkeypatch.setattr(browser, "PORTAL_URL", f"{portal}/account/login?mode={mode}")

    async def run():
        async with async_playwright() as p:
            exe = os.environ.get("PW_CHROMIUM") or ("/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None)
            try:
                b = await p.chromium.launch(executable_path=exe, args=["--no-sandbox"])
            except Exception as exc:  # noqa: BLE001
                pytest.skip(f"no Chromium here: {exc}")
            page = await b.new_page()
            await page.goto(f"{portal}/account/login?mode={mode}")
            try:
                return await browser.do_login(page, "1005218882", PASSWORD)
            finally:
                await b.close()
    return asyncio.run(run())


def test_a_login_the_portal_never_answers_says_so(portal, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="xtrapower.browser")
    assert _login(portal, "hang", monkeypatch) == browser.LOGIN_FAILED
    text = caplog.text
    assert "still on the login page" in text and "'loading': True" in text
    assert "Trouble login" in text                                   # the portal's own box
    assert "'user_id_chars': 10" in text and "'password_chars': 12" in text   # (the form was filled)
    assert "/api/login -> no answer after" in text                   # the call that hung
    assert PASSWORD not in text and "mode=hang" not in text          # no password, no query string


def test_a_refused_login_shows_the_status_and_the_message(portal, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="xtrapower.browser")
    assert _login(portal, "deny", monkeypatch) == browser.LOGIN_FAILED
    text = caplog.text
    assert "/api/login -> HTTP 401" in text
    assert "Invalid User ID or password" in text
    assert PASSWORD not in text


def test_a_login_that_works_logs_nothing_more(portal, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="xtrapower.browser")
    assert _login(portal, "ok", monkeypatch) == browser.LOGIN_OK
    assert "still on the login page" not in caplog.text and "login: request" not in caplog.text
