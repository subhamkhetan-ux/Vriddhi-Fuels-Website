"""Unit tests for the XtraPower monitor's browser-free logic."""

import time

from xtrapower import parse, state


# ---- amount parsing -------------------------------------------------------

def test_normalize_amount_handles_rupee_and_grouping():
    assert parse.normalize_amount("₹1,00,000.00") == 100000.0
    assert parse.normalize_amount("100,000.00") == 100000.0
    assert parse.normalize_amount("Rs. 39.31") == 39.31
    assert parse.normalize_amount("  0.00 ") == 0.0
    assert parse.normalize_amount("-500") == -500.0


def test_normalize_amount_none_when_no_number():
    assert parse.normalize_amount(None) is None
    assert parse.normalize_amount("—") is None
    assert parse.normalize_amount("CCMS") is None


# ---- CCMS extraction ------------------------------------------------------

HEADERS = ["Card Group", "Balance Info", "CCMS", "Status"]
ROWS = [["Fleet A", "info", "₹1,00,000.00", "Active"]]


def test_find_ccms_by_header():
    assert parse.find_ccms(HEADERS, ROWS) == "₹1,00,000.00"


def test_find_ccms_is_header_wording_tolerant():
    assert parse.find_ccms(["CCMS Balance"], [["₹39.31"]]) == "₹39.31"


def test_find_ccms_skips_non_numeric_rows():
    rows = [["Fleet A", "info", "", "Active"], ["Fleet B", "info", "₹200.00", "Active"]]
    assert parse.find_ccms(HEADERS, rows) == "₹200.00"


def test_find_ccms_none_when_absent():
    assert parse.find_ccms(["A", "B"], [["1", "2"]]) is None


# ---- change detection -----------------------------------------------------

def test_ccms_changed_ignores_formatting():
    assert parse.ccms_changed("₹1,00,000.00", "₹100000") is False


def test_ccms_changed_true_on_real_move():
    assert parse.ccms_changed("₹100.00", "₹200.00") is True


def test_first_reading_is_baseline_not_change():
    assert parse.ccms_changed(None, "₹100.00") is False


def test_change_direction():
    assert parse.change_direction("₹100", "₹200") == "credited"
    assert parse.change_direction("₹200", "₹100") == "debited"
    assert parse.change_direction("A", "B") == "changed"


# ---- logout / WAF detection ----------------------------------------------

def test_detect_logout_on_session_expired():
    assert parse.detect_logout("Your session has expired. Please login again.", "https://beta.iocxtrapower.com/x")


def test_detect_logout_on_login_url_with_prompt():
    assert parse.detect_logout("Customer ID Password", "https://beta.iocxtrapower.com/login")


def test_detect_logout_false_on_balance_screen():
    assert parse.detect_logout("Balance Info CCMS ₹100", "https://beta.iocxtrapower.com/financials") is False


def test_detect_waf_block():
    txt = "The requested URL was rejected. Please consult with your administrator. Your support ID is: 12345"
    assert parse.detect_waf_block(txt) is True
    assert parse.detect_waf_block("Balance Info") is False


# ---- state + error de-dup -------------------------------------------------

def test_state_roundtrip(tmp_path):
    p = str(tmp_path / "state.json")
    data = state.load(p)
    acct = state.account(data, "1005218882")
    acct["ccms"] = "₹100.00"
    state.save(p, data)

    reloaded = state.load(p)
    assert state.account(reloaded, "1005218882")["ccms"] == "₹100.00"


def test_error_dedup_alerts_once_then_cools_down():
    acct = {}
    now = time.time()
    # first occurrence always alerts
    assert state.should_alert_error(acct, "logged-out", now, 1800)
    state.record_error(acct, "logged-out", now, "iso")
    # same signature within cooldown → suppressed
    assert state.should_alert_error(acct, "logged-out", now + 60, 1800) is False
    # after cooldown → alerts again
    assert state.should_alert_error(acct, "logged-out", now + 1801, 1800)


def test_error_dedup_new_signature_alerts_immediately():
    acct = {}
    now = time.time()
    state.record_error(acct, "logged-out", now, "iso")
    assert state.should_alert_error(acct, "chrome-unreachable", now + 5, 1800)


def test_clear_error_resets_dedup():
    acct = {}
    now = time.time()
    state.record_error(acct, "logged-out", now, "iso")
    state.clear_error(acct)
    assert state.should_alert_error(acct, "logged-out", now + 1, 1800)


# ---- monitor orchestration (fakes, no real browser) -----------------------

import asyncio

from xtrapower import browser as browser_mod
from xtrapower import monitor


class _CapturingTelegram:
    def __init__(self):
        self.messages = []
        self.configured = True

    def send(self, text):
        self.messages.append(text)
        return True


class _FakePool:
    """Stands in for BrowserPool. `page` is whatever find_portal_page returns."""

    def __init__(self, page, raise_on_find=False):
        self._page = page
        self._raise = raise_on_find
        self.dropped = []

    async def find_portal_page(self, port):
        if self._raise:
            raise ConnectionRefusedError("no chrome on port")
        return self._page

    def drop(self, port):
        self.dropped.append(port)


def _reading(headers, rows, text="Balance Info", url="https://beta.iocxtrapower.com/fin"):
    return browser_mod.Reading(url=url, text=text, headers=headers, rows=rows)


def _run_check(monkeypatch, pool, readings, click_ok=True):
    """Drive one check_account with scripted read_page results."""
    seq = list(readings)

    async def fake_read_page(page, settle_ms=1500):
        return seq.pop(0)

    async def fake_click(page, timeout_ms=8000):
        return click_ok

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)

    tg = _CapturingTelegram()
    st = {"accounts": {}}
    acct_cfg = {"label": "Test", "customer_id": "999", "cdp_port": 9222}
    asyncio.run(monitor.check_account(pool, acct_cfg, st, tg))
    return tg, st


def test_check_baseline_then_change(tmp_path, monkeypatch):
    page = object()
    pool = _FakePool(page)
    hdr = ["CCMS"]
    # cycle 1: pre-read (settle 0) + post-click read → baseline
    tg, st = _run_check(monkeypatch, pool,
                        [_reading(hdr, [["₹100.00"]]), _reading(hdr, [["₹100.00"]])])
    assert tg.messages == []                      # baseline is silent
    assert st["accounts"]["999"]["ccms"] == "₹100.00"

    # cycle 2: value moved up → one credited alert
    tg2, _ = _run_check(monkeypatch, _FakePool(page),
                        [_reading(hdr, [["₹100.00"]]), _reading(hdr, [["₹250.00"]])])
    # reuse prior state
    st2 = {"accounts": {"999": {"ccms": "₹100.00"}}}
    seq = [_reading(hdr, [["₹100.00"]]), _reading(hdr, [["₹250.00"]])]

    async def fake_read_page(page, settle_ms=1500):
        return seq.pop(0)

    async def fake_click(page, timeout_ms=8000):
        return True

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    tgc = _CapturingTelegram()
    asyncio.run(monitor.check_account(_FakePool(page), {"label": "Test", "customer_id": "999", "cdp_port": 9222}, st2, tgc))
    assert len(tgc.messages) == 1
    assert "credited" in tgc.messages[0]
    assert st2["accounts"]["999"]["ccms"] == "₹250.00"


def test_check_alerts_on_chrome_unreachable(monkeypatch):
    pool = _FakePool(None, raise_on_find=True)
    tg = _CapturingTelegram()
    st = {"accounts": {}}
    asyncio.run(monitor.check_account(pool, {"label": "T", "customer_id": "9", "cdp_port": 9222}, st, tg))
    assert len(tg.messages) == 1
    assert "debug port" in tg.messages[0]
    assert pool.dropped == [9222]


def test_check_alerts_on_logout(monkeypatch):
    page = object()
    pool = _FakePool(page)
    tg, st = _run_check(monkeypatch, pool,
                        [_reading([], [], text="Your session has expired. Please login again.")])
    assert len(tg.messages) == 1
    assert "logged out" in tg.messages[0].lower() or "session" in tg.messages[0].lower()


def test_check_alerts_on_waf_block(monkeypatch):
    page = object()
    pool = _FakePool(page)
    waf = "The requested URL was rejected. Please consult with your administrator. Your support ID is: 1"
    tg, st = _run_check(monkeypatch, pool, [_reading([], [], text=waf)])
    assert len(tg.messages) == 1
    assert "firewall" in tg.messages[0].lower()


def test_check_alerts_when_search_button_missing(monkeypatch):
    page = object()
    pool = _FakePool(page)
    tg, st = _run_check(monkeypatch, pool, [_reading(["CCMS"], [["₹1"]])], click_ok=False)
    assert len(tg.messages) == 1
    assert "Search" in tg.messages[0]


def test_check_alerts_when_ccms_unreadable(monkeypatch):
    page = object()
    pool = _FakePool(page)
    tg, st = _run_check(monkeypatch, pool,
                        [_reading(["Other"], [["x"]]), _reading(["Other"], [["x"]])])
    assert len(tg.messages) == 1
    assert "CCMS" in tg.messages[0]
