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


def test_ccms_increased_only_on_credit():
    assert parse.ccms_increased("₹100.00", "₹250.00") is True       # credit
    assert parse.ccms_increased("₹250.00", "₹100.00") is False      # debit → quiet
    assert parse.ccms_increased("₹1,00,000.00", "₹100000") is False  # reformat, same value
    assert parse.ccms_increased(None, "₹100.00") is False           # baseline
    assert parse.ccms_increased("A", "B") is True                   # changed, direction unknown


# ---- logout / WAF detection ----------------------------------------------

def test_detect_logout_on_session_expired():
    assert parse.detect_logout("Your session has expired. Please login again.", "https://beta.iocxtrapower.com/x")


def test_detect_logout_on_login_url_with_prompt():
    assert parse.detect_logout("Customer ID Password", "https://beta.iocxtrapower.com/login")


def test_detect_logout_on_fresh_login_url_without_visible_prompt():
    # Fresh login page: placeholders aren't visible text, but the URL gives it away.
    assert parse.detect_logout(
        "Sign In New Here? Need Help?",
        "https://beta.iocxtrapower.com/account/login?returnUrl=%2F") is True


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


def _run_check(monkeypatch, pool, readings, click_ok=True, ready=None, st=None, cid="999"):
    """Drive one check_account with scripted read_page results.

    ``ready`` is the per-run hand-over dict; pass ``{cid: True}`` to simulate an
    account that has already been handed over (past the quiet waiting phase).
    """
    seq = list(readings)

    async def fake_read_page(page, settle_ms=1500):
        return seq.pop(0)

    async def fake_click(page, timeout_ms=8000):
        return click_ok

    async def fake_nav(page, labels):
        return None

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)

    tg = _CapturingTelegram()
    st = st if st is not None else {"accounts": {}}
    ready = ready if ready is not None else {}
    acct_cfg = {"label": "Test", "customer_id": cid, "cdp_port": 9222}
    asyncio.run(monitor.check_account(pool, acct_cfg, st, tg, ready))
    return tg, st, ready


HDR = ["CCMS"]


def test_handover_confirms_then_credits(monkeypatch):
    """First clean read → ✅ 'now watching'; a later increase → 🟢 credit."""
    page = object()
    ready, st = {}, {"accounts": {}}

    # Cycle 1 (not yet ready): confirmation, not a credit alert, and it baselines.
    tg1, st, ready = _run_check(monkeypatch, _FakePool(page),
                                [_reading(HDR, [["₹100.00"]]), _reading(HDR, [["₹100.00"]])],
                                ready=ready, st=st)
    assert len(tg1.messages) == 1
    assert "now watching" in tg1.messages[0].lower()
    assert ready["999"] is True
    assert st["accounts"]["999"]["ccms"] == "₹100.00"

    # Cycle 2 (now ready): value up → exactly one credited alert.
    tg2, st, ready = _run_check(monkeypatch, _FakePool(page),
                                [_reading(HDR, [["₹100.00"]]), _reading(HDR, [["₹250.00"]])],
                                ready=ready, st=st)
    assert len(tg2.messages) == 1
    assert "credited" in tg2.messages[0]
    assert st["accounts"]["999"]["ccms"] == "₹250.00"


def test_handover_flags_offline_credit(monkeypatch):
    """A credit that landed while the monitor was off is reported on hand-over."""
    page = object()
    st = {"accounts": {"999": {"ccms": "₹100.00"}}}   # last-known from a prior run
    tg, st, ready = _run_check(monkeypatch, _FakePool(page),
                               [_reading(HDR, [["₹500.00"]]), _reading(HDR, [["₹500.00"]])],
                               ready={}, st=st)
    assert len(tg.messages) == 1
    assert "now watching" in tg.messages[0].lower()
    assert "credited since last check" in tg.messages[0].lower()
    assert ready["999"] is True


def test_not_logged_in_is_quiet_until_handover(monkeypatch):
    """A not-yet-logged-in window waits quietly — no alert while ready is unset."""
    page = object()
    tg, st, ready = _run_check(monkeypatch, _FakePool(page),
                               [_reading([], [], text="Customer ID Password",
                                         url="https://beta.iocxtrapower.com/login")],
                               ready={})
    assert tg.messages == []               # quiet
    assert ready.get("999") is not True


def test_decrease_does_not_alert_when_ready(monkeypatch):
    page = object()
    st = {"accounts": {"999": {"ccms": "₹250.00"}}}
    tg, st, ready = _run_check(monkeypatch, _FakePool(page),
                               [_reading(HDR, [["₹250.00"]]), _reading(HDR, [["₹100.00"]])],
                               ready={"999": True}, st=st)
    assert tg.messages == []                            # debit → no alert
    assert st["accounts"]["999"]["ccms"] == "₹100.00"   # but value still refreshed


def test_logout_after_handover_alerts_and_drops_to_waiting(monkeypatch):
    """Once watching, a session drop alerts once and returns to quiet waiting."""
    page = object()
    ready = {"999": True}
    tg, st, ready = _run_check(monkeypatch, _FakePool(page),
                               [_reading([], [], text="Your session has expired. Please login again.")],
                               ready=ready)
    assert len(tg.messages) == 1
    assert "session" in tg.messages[0].lower() or "logged out" in tg.messages[0].lower()
    assert ready["999"] is False                        # back to awaiting, quiet next time


def test_chrome_unreachable_quiet_before_handover_alerts_after(monkeypatch):
    # Before hand-over: quiet.
    pool1 = _FakePool(None, raise_on_find=True)
    tg1, _, ready = _run_check(monkeypatch, pool1, [], ready={}, cid="9")
    assert tg1.messages == []
    assert pool1.dropped == [9222]

    # After hand-over: the same condition is a real alert.
    pool2 = _FakePool(None, raise_on_find=True)
    tg2, _, ready = _run_check(monkeypatch, pool2, [], ready={"9": True}, cid="9")
    assert len(tg2.messages) == 1
    assert "debug port" in tg2.messages[0]
    assert ready["9"] is False


def test_waf_block_alerts_even_before_handover(monkeypatch):
    page = object()
    waf = "The requested URL was rejected. Please consult with your administrator. Your support ID is: 1"
    tg, st, ready = _run_check(monkeypatch, _FakePool(page), [_reading([], [], text=waf)], ready={})
    assert len(tg.messages) == 1
    assert "firewall" in tg.messages[0].lower()


def test_missing_search_alerts_when_ready(monkeypatch):
    page = object()
    tg, st, ready = _run_check(monkeypatch, _FakePool(page), [_reading(HDR, [["₹1"]])],
                               click_ok=False, ready={"999": True})
    assert len(tg.messages) == 1
    assert "Search" in tg.messages[0]


def test_unreadable_ccms_alerts_when_ready(monkeypatch):
    page = object()
    tg, st, ready = _run_check(monkeypatch, _FakePool(page),
                               [_reading(["Other"], [["x"]]), _reading(["Other"], [["x"]])],
                               ready={"999": True})
    assert len(tg.messages) == 1
    assert "CCMS" in tg.messages[0]


# ---- auto re-login (credentials configured) -------------------------------

def _run_login_check(monkeypatch, pool, readings, *, login_status="ok", ready=None, st=None, cid="999"):
    """check_account with credentials set and browser.do_login stubbed.

    ``login_status`` is one of browser.LOGIN_OK / LOGIN_CAPTCHA / LOGIN_FAILED.
    """
    seq = list(readings)
    calls = {"login": 0, "nav": 0}

    async def fake_read_page(page, settle_ms=1500):
        return seq.pop(0)

    async def fake_click(page, timeout_ms=8000):
        return True

    async def fake_do_login(page, user, pw):
        calls["login"] += 1
        return login_status

    async def fake_nav(page, labels):
        calls["nav"] += 1

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "do_login", fake_do_login)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)

    tg = _CapturingTelegram()
    st = st if st is not None else {"accounts": {}}
    ready = ready if ready is not None else {}
    acct = {"label": "Test", "customer_id": cid, "cdp_port": 9222,
            "username": "u", "password": "p"}
    asyncio.run(monitor.check_account(pool, acct, st, tg, ready))
    return tg, st, ready, calls


LOGOUT = browser_mod.Reading(url="https://beta.iocxtrapower.com/login",
                             text="Your session has expired. Please login again.",
                             headers=[], rows=[])


def test_autologin_recovers_and_confirms(monkeypatch):
    page = object()
    tg, st, ready, calls = _run_login_check(
        monkeypatch, _FakePool(page),
        [LOGOUT, _reading(HDR, [["₹100.00"]])],   # pre=logged out, post-relogin=good
        login_status="ok")
    assert calls["login"] == 1 and calls["nav"] == 1
    assert len(tg.messages) == 1 and "now watching" in tg.messages[0].lower()
    assert ready["999"] is True
    assert st["accounts"]["999"]["ccms"] == "₹100.00"


def test_autologin_failure_alerts(monkeypatch):
    page = object()
    tg, st, ready, calls = _run_login_check(
        monkeypatch, _FakePool(page), [LOGOUT], login_status="failed")
    assert calls["login"] == 1
    assert len(tg.messages) == 1 and "didn't go through" in tg.messages[0].lower()
    assert ready.get("999") is not True


def test_autologin_captcha_asks_for_human_and_backs_off(monkeypatch):
    page = object()
    st = {"accounts": {}}
    tg, st, ready, calls = _run_login_check(
        monkeypatch, _FakePool(page), [LOGOUT], login_status="captcha", st=st)
    assert calls["login"] == 1
    assert len(tg.messages) == 1 and "recaptcha" in tg.messages[0].lower()
    assert ready.get("999") is not True
    # 10-min back-off recorded so we don't re-tick the box every cycle
    assert st["accounts"]["999"].get("captcha_until_epoch", 0) > 0


def test_autologin_midcycle_recovery_is_silent(monkeypatch):
    """Already watching; session drops mid-refresh; silent recovery, value same."""
    page = object()
    st = {"accounts": {"999": {"ccms": "₹100.00"}}}
    tg, st, ready, calls = _run_login_check(
        monkeypatch, _FakePool(page),
        [_reading(HDR, [["₹100.00"]]), LOGOUT, _reading(HDR, [["₹100.00"]])],
        login_status="ok", ready={"999": True}, st=st)
    assert calls["login"] == 1
    assert tg.messages == []                       # silent recovery, no ✅ spam
    assert ready["999"] is True


def test_autologin_midcycle_recovery_reports_credit(monkeypatch):
    """A credit that lands right around a mid-cycle re-login is still reported."""
    page = object()
    st = {"accounts": {"999": {"ccms": "₹100.00"}}}
    tg, st, ready, calls = _run_login_check(
        monkeypatch, _FakePool(page),
        [_reading(HDR, [["₹100.00"]]), LOGOUT, _reading(HDR, [["₹500.00"]])],
        login_status="ok", ready={"999": True}, st=st)
    assert len(tg.messages) == 1 and "credited" in tg.messages[0]
    assert st["accounts"]["999"]["ccms"] == "₹500.00"


def test_no_creds_still_quiet_on_logout(monkeypatch):
    """Without credentials, a logout stays quiet before hand-over (unchanged)."""
    page = object()
    tg, st, ready = _run_check(monkeypatch, _FakePool(page), [LOGOUT], ready={})
    assert tg.messages == []
