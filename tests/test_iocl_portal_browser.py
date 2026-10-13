"""Exercise the menu flow against an in-memory synthetic portal, never IOCL."""
from datetime import datetime
from decimal import Decimal
import os
from pathlib import Path
import shutil

import pytest

from iocl_portal.browser import PortalBrowser
from iocl_portal.statement import IST, PortalError

playwright_api = pytest.importorskip("playwright.sync_api")
ORIGIN = "https://portal.example"
NOW = datetime(2026, 10, 13, 7, 0, tzinfo=IST)
HTML = r"""<!DOCTYPE html><html><body>
<form id="loginForm">
  <label>Username <input name="username" autocomplete="username"></label>
  <label>Password <input name="password" type="password"></label>
  <img id="captcha_image" alt="CAPTCHA" width="180" height="50"
       src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='50'%3E%3Ctext x='5' y='35' font-size='30'%3EABCDEF%3C/text%3E%3C/svg%3E">
  <label>CAPTCHA <input name="captcha"></label><button>Login</button>
</form>
<div id="home" hidden>
  <a id="account" href="#">Account Information</a>
  <a id="padLink" href="#" hidden>PAD Statement</a>
</div><main id="report"></main>
<script>
window.loginCount = 0;
document.querySelector('#loginForm').onsubmit = e => {
  e.preventDefault(); window.loginCount++;
  const data = new FormData(e.target);
  if (data.get('username') !== '999999' || data.get('password') !== 'fixture-only' || data.get('captcha') !== 'ABCDEF') return;
  e.target.hidden = true; document.querySelector('#home').hidden = false;
};
document.querySelector('#account').onclick = e => {
  e.preventDefault(); document.querySelector('#padLink').hidden = false;
};
document.querySelector('#padLink').onclick = e => {
  e.preventDefault();
  document.querySelector('#report').innerHTML = `
    <h2>Customer PAD Balance</h2>
    <label for="fromDate">From Date:</label><input id="fromDate" readonly>
    <label for="toDate">To Date:</label><input id="toDate">
    <button id="view">View</button><div id="statement"></div>`;
  document.querySelector('#view').onclick = () => {
    window.requestedDates = [document.querySelector('#fromDate').value, document.querySelector('#toDate').value];
    document.querySelector('#statement').innerHTML = `
      <p>Customer:- TEST OUTLET (999999)</p>
      <p>Report Generated Date/Time: Tue Oct 13 2026 6:59:04 AM</p>
      <p>From 12-Oct-2026 To 13-Oct-2026</p>
      <table><thead><tr><th>Item Text</th><th>Debit (Rs.)</th><th>Credit (Rs.)</th><th>Balance (Rs.)</th></tr></thead>
      <tbody>
        <tr><td>OP.BAL.in Comp Code:</td><td>0</td><td>0</td><td>10000.00</td></tr>
        <tr><td>CL.BAL.in Comp Code:</td><td>0</td><td>0</td><td>-15000.00</td></tr>
        <tr><td>Open Delivery value in all CCA:</td><td>0</td><td>0</td><td>500.00</td></tr>
      </tbody></table><p>Closing balance: Rs. -14500.00</p>`;
  };
};
</script></body></html>"""


@pytest.fixture
def page():
    with playwright_api.sync_playwright() as p:
        executable = os.environ.get("IOCL_CHROMIUM_EXECUTABLE") or shutil.which("chromium")
        if not executable and not Path(p.chromium.executable_path).is_file():
            pytest.skip("Install Playwright Chromium to run the portal browser tests")
        browser = p.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}))
        context = browser.new_context()
        def route(request):
            if request.request.url == ORIGIN + "/ioconline/iocExStart.jsp":
                request.fulfill(status=200, content_type="text/html", body=HTML)
            else:
                request.abort()
        context.route("**/*", route)
        yield context.new_page()
        context.close()
        browser.close()


def test_login_menus_dates_and_company_balance(page):
    calls = []
    def solver(png, *, length):
        assert png.startswith(b"\x89PNG") and length == 6
        calls.append(1)
        return "ABCDEF"
    portal = PortalBrowser(page, origin=ORIGIN, captcha_solver=solver, timeout=1)
    portal.open()
    portal.login("999999", "fixture-only")
    portal.navigate_pad()
    balance = portal.read_balance(customer="999999", now=NOW)
    assert (balance.amount, balance.sign) == (Decimal("15000.00"), "CR")
    assert page.evaluate("window.requestedDates") == ["12-10-2026", "13-10-2026"]
    assert page.evaluate("window.loginCount") == 1
    assert calls == [1]


def test_uncertain_captcha_does_not_enter_credentials_or_submit(page):
    calls = []
    def solver(*args, **kwargs):
        calls.append(1)
        raise PortalError("CAPTCHA needs a person")
    portal = PortalBrowser(page, origin=ORIGIN, captcha_solver=solver, timeout=1)
    portal.open()
    with pytest.raises(PortalError, match="CAPTCHA needs a person"):
        portal.login("999999", "fixture-only")
    assert len(calls) == 3                       # three fresh CAPTCHAs, then stop
    assert page.locator("input[name=password]").input_value() == ""
    assert not page.evaluate("window.loginCount")


def test_an_unclear_captcha_is_swapped_for_a_fresh_one_before_login(page):
    answers = iter([PortalError("CAPTCHA needs a person"), "ABCDEF"])
    def solver(*args, **kwargs):
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer
    portal = PortalBrowser(page, origin=ORIGIN, captcha_solver=solver, timeout=1)
    portal.open()
    portal.login("999999", "fixture-only")
    assert page.evaluate("window.loginCount") == 1


def test_other_captcha_errors_are_not_retried(page):
    calls = []
    def solver(*args, **kwargs):
        calls.append(1)
        raise PortalError("Install Tesseract OCR to read the portal's text CAPTCHA.")
    portal = PortalBrowser(page, origin=ORIGIN, captcha_solver=solver, timeout=1)
    portal.open()
    with pytest.raises(PortalError, match="Install Tesseract"):
        portal.login("999999", "fixture-only")
    assert len(calls) == 1


def test_rejected_login_is_not_retried(page):
    portal = PortalBrowser(page, origin=ORIGIN, captcha_solver=lambda *a, **k: "WRONGX", timeout=0.3)
    portal.open()
    with pytest.raises(PortalError, match="Only one login was submitted"):
        portal.login("999999", "fixture-only")
    assert page.evaluate("window.loginCount") == 1


@pytest.mark.parametrize(("now", "expected_from", "expected_to"), [
    (datetime(2026, 10, 13, 0, 30, tzinfo=IST), "12-10-2026", "13-10-2026"),
    (datetime(2027, 1, 1, 0, 30, tzinfo=IST), "31-12-2026", "01-01-2027"),
    (datetime(2028, 3, 1, 0, 30, tzinfo=IST), "29-02-2028", "01-03-2028"),
])
def test_blank_statement_keeps_yesterday_to_today_dates_at_boundaries(page, now, expected_from, expected_to):
    portal = PortalBrowser(page, origin=ORIGIN, captcha_solver=lambda *a, **k: "ABCDEF", timeout=0.3)
    portal.open()
    portal.login("999999", "fixture-only")
    portal.navigate_pad()
    page.evaluate("""() => {
      document.querySelector('#view').onclick = () => {
        window.requestedDates = [document.querySelector('#fromDate').value, document.querySelector('#toDate').value];
        document.querySelector('#statement').innerHTML = '';
      };
    }""")
    with pytest.raises(PortalError, match="report did not appear"):
        portal.read_balance(customer="999999", now=now)
    assert page.evaluate("window.requestedDates") == [expected_from, expected_to]


def test_captcha_sampling_saves_images_and_reads_without_typing(page, tmp_path, monkeypatch):
    from iocl_portal import run
    reads = []

    def fake_reads(png, *, length):
        assert png.startswith(b"\x89PNG") and length == 6
        reads.append(1)
        return [{"psm": 7, "answer": None,
                 "tsv": "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth"
                        "\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t31.5\tAB3DEF\n"}]

    monkeypatch.setattr(run, "ocr_reads", fake_reads)
    portal = PortalBrowser(page, origin=ORIGIN, timeout=1)
    portal.open()
    assert run.sample_captchas(portal, tmp_path, length=6, count=3) == 3
    report = __import__("json").loads((tmp_path / "report.json").read_text())
    assert [s["file"] for s in report["samples"]] == ["captcha-1.png", "captcha-2.png", "captcha-3.png"]
    assert report["samples"][0]["reads"][0]["words"] == [{"conf": "31.5", "text": "AB3DEF"}]
    assert report["captcha_image"]["id"] == "captcha_image" and report["captcha_input"]["name"] == "captcha"
    assert (tmp_path / "login-page.png").read_bytes().startswith(b"\x89PNG") and len(reads) == 3
    # Nothing was typed or submitted.
    assert page.evaluate("window.loginCount || 0") == 0
    assert page.locator("input[name=username]").input_value() == ""


def test_report_diagnostics_describe_pages_without_account_data(page):
    portal = PortalBrowser(page, origin=ORIGIN, captcha_solver=lambda *a, **k: "ABCDEF", timeout=1)
    portal.open()
    portal.login("999999", "fixture-only")
    portal.navigate_pad()
    seen = portal.report_diagnostics()
    assert seen.startswith("page https://portal.example/ioconline/iocExStart.jsp text=")
    assert "has=" in seen and "PADtitle" in seen
    assert "999999" not in seen and "fixture-only" not in seen
