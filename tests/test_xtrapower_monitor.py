"""XtraPower monitor orchestration tests (fakes, no real browser).

These import xtrapower.browser/monitor, which import Playwright. Playwright is
only in xtrapower/requirements.txt, not the repo's root requirements.txt, so
skip cleanly when it is absent - otherwise one failed import aborts the whole
pytest run and no other app's tests execute.
"""

import pytest

pytest.importorskip("playwright.async_api")

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
        return seq.pop(0) if len(seq) > 1 else seq[0]       # (the page stays as it last was)

    async def fake_click(page, timeout_ms=8000):
        return click_ok

    async def fake_nav(page, labels):
        return None

    async def fake_dismiss(page):
        return None

    async def fake_goto(page, url):
        return False

    async def fake_capture(page, prefix):
        return None

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)
    monkeypatch.setattr(monitor.browser, "dismiss_popup", fake_dismiss)
    monkeypatch.setattr(monitor.browser, "goto_url", fake_goto)
    monkeypatch.setattr(monitor.browser, "capture_debug", fake_capture)

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


def test_unreadable_ccms_alerts_when_ready_only_after_two_checks(monkeypatch):
    monkeypatch.setattr(monitor, "CCMS_WAIT_SECONDS", 0.2)
    page, st, ready = object(), {"accounts": {}}, {"999": True}
    other = [_reading(["Other"], [["x"]]), _reading(["Other"], [["x"]])]
    tg, st, ready = _run_check(monkeypatch, _FakePool(page), other, ready=ready, st=st)
    assert tg.messages == [] and ready["999"] is True              # one slow refresh: nothing yet
    tg, st, ready = _run_check(monkeypatch, _FakePool(page), other, ready=ready, st=st)
    assert len(tg.messages) == 1 and "CCMS" in tg.messages[0] and "2 checks in a row" in tg.messages[0]


def test_a_results_table_that_fills_in_late_is_read(monkeypatch):
    monkeypatch.setattr(monitor, "CCMS_WAIT_SECONDS", 5)
    page = object()
    empty = _reading(HDR, [])
    tg, st, ready = _run_check(monkeypatch, _FakePool(page),
                               [_reading(HDR, [["₹100.00"]]), empty, empty, _reading(HDR, [["₹100.00"]])],
                               ready={"999": True}, st={"accounts": {"999": {"ccms": "₹100.00"}}})
    assert tg.messages == [] and st["accounts"]["999"]["ccms"] == "₹100.00"


def test_a_clean_read_starts_the_miss_count_again(monkeypatch):
    monkeypatch.setattr(monitor, "CCMS_WAIT_SECONDS", 0.2)
    page, st, ready = object(), {"accounts": {}}, {"999": True}
    other = [_reading(["Other"], [["x"]]), _reading(["Other"], [["x"]])]
    good = [_reading(HDR, [["₹100.00"]]), _reading(HDR, [["₹100.00"]])]
    for readings in (other, good, other):
        tg, st, ready = _run_check(monkeypatch, _FakePool(page), readings, ready=ready, st=st)
        assert tg.messages == []


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

    async def fake_dismiss(page):
        return None

    async def fake_goto(page, url):
        return False

    async def fake_capture(page, prefix):
        return None

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "do_login", fake_do_login)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)
    monkeypatch.setattr(monitor.browser, "dismiss_popup", fake_dismiss)
    monkeypatch.setattr(monitor.browser, "goto_url", fake_goto)
    monkeypatch.setattr(monitor.browser, "capture_debug", fake_capture)

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
    assert calls["login"] == 1
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


def test_autologin_captcha_asks_for_human(monkeypatch):
    page = object()
    st = {"accounts": {}}
    tg, st, ready, calls = _run_login_check(
        monkeypatch, _FakePool(page), [LOGOUT], login_status="captcha", st=st)
    assert calls["login"] == 1
    assert len(tg.messages) == 1 and "recaptcha" in tg.messages[0].lower()
    assert ready.get("999") is not True


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


# ---- resilience: remembered balance URL + fallback ladder ------------------

def test_balance_url_is_learned_from_a_good_read(monkeypatch):
    """After a clean read we remember where the table lives, for later cycles."""
    page = object()
    url = "https://beta.iocxtrapower.com/financials/balance-info"
    tg, st, ready = _run_check(
        monkeypatch, _FakePool(page),
        [_reading(HDR, [["₹100.00"]], url=url), _reading(HDR, [["₹100.00"]], url=url)])
    assert st["accounts"]["999"]["balance_url"] == url


def test_ladder_falls_back_to_remembered_url(monkeypatch):
    """Search missing -> dismiss -> jump to the remembered URL -> Search works."""
    page = object()
    url = "https://beta.iocxtrapower.com/financials/balance-info"
    st = {"accounts": {"999": {"ccms": "₹100.00", "balance_url": url}}}
    seq = [_reading(HDR, [["₹100.00"]]), _reading(HDR, [["₹250.00"]])]
    clicks = [False, False, True]          # rung 1 no, rung 2 no, after goto yes
    visited = []

    async def fake_read_page(page, settle_ms=1500):
        return seq.pop(0)

    async def fake_click(page, timeout_ms=8000):
        return clicks.pop(0) if clicks else True

    async def fake_goto(page, u):
        visited.append(u)
        return True

    async def fake_dismiss(page):
        return None

    async def fake_nav(page, labels):
        raise AssertionError("menu walk should not be needed when the URL is known")

    async def fake_capture(page, prefix):
        return None

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "goto_url", fake_goto)
    monkeypatch.setattr(monitor.browser, "dismiss_popup", fake_dismiss)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)
    monkeypatch.setattr(monitor.browser, "capture_debug", fake_capture)

    tg = _CapturingTelegram()
    asyncio.run(monitor.check_account(
        _FakePool(page), {"label": "T", "customer_id": "999", "cdp_port": 9222},
        st, tg, {"999": True}))
    assert visited == [url]                       # jumped straight there
    assert len(tg.messages) == 1 and "credited" in tg.messages[0]


def test_nav_failure_captures_debug(monkeypatch):
    """When every rung fails we save a capture and name it in the alert."""
    page = object()
    captured = []

    async def fake_read_page(page, settle_ms=1500):
        return _reading([], [], text="Balance Info")

    async def fake_click(page, timeout_ms=8000):
        return False

    async def fake_capture(page, prefix):
        captured.append(prefix)
        return prefix + ".png"

    async def fake_noop(page, *a, **k):
        return None

    async def fake_goto(page, u):
        return False

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "capture_debug", fake_capture)
    monkeypatch.setattr(monitor.browser, "dismiss_popup", fake_noop)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_noop)
    monkeypatch.setattr(monitor.browser, "goto_url", fake_goto)

    tg = _CapturingTelegram()
    asyncio.run(monitor.check_account(
        _FakePool(page), {"label": "T", "customer_id": "999", "cdp_port": 9222},
        {"accounts": {}}, tg, {"999": True}))
    assert captured, "a debug capture should have been saved"
    assert len(tg.messages) == 1 and ".png" in tg.messages[0]


def test_fresh_account_jumps_to_default_balance_url(monkeypatch):
    """On a fresh run (no learned balance_url), the ladder still jumps straight
    to the default Balance Info route instead of only walking the menu — so the
    first hand-over needs no manual sidebar navigation."""
    gotos = []
    dashboard = _reading(["CCMS"], [], text="Dashboard", url="https://beta.iocxtrapower.com/dashboard")

    async def fake_read_page(page, settle_ms=1500):
        return dashboard

    async def fake_click(page, timeout_ms=8000):
        return False                    # Search never present -> ladder descends

    async def fake_nav(page, labels):
        return None

    async def fake_dismiss(page):
        return None

    async def fake_goto(page, url):
        gotos.append(url)
        return True

    async def fake_capture(page, prefix):
        return None

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)
    monkeypatch.setattr(monitor.browser, "dismiss_popup", fake_dismiss)
    monkeypatch.setattr(monitor.browser, "goto_url", fake_goto)
    monkeypatch.setattr(monitor.browser, "capture_debug", fake_capture)

    tg = _CapturingTelegram()
    st = {"accounts": {}}               # fresh: no learned balance_url
    acct_cfg = {"label": "Test", "customer_id": "999", "cdp_port": 9222}
    asyncio.run(monitor.check_account(_FakePool(object()), acct_cfg, st, tg, {}))
    assert browser_mod.DEFAULT_BALANCE_URL in gotos


def test_config_balance_url_overrides_default(monkeypatch):
    """A per-account balance_url in config is used ahead of the built-in default."""
    gotos = []
    dashboard = _reading(["CCMS"], [], text="Dashboard", url="https://beta.iocxtrapower.com/dashboard")

    async def fake_read_page(page, settle_ms=1500):
        return dashboard

    async def fake_click(page, timeout_ms=8000):
        return False

    async def fake_nav(page, labels):
        return None

    async def fake_dismiss(page):
        return None

    async def fake_goto(page, url):
        gotos.append(url)
        return True

    async def fake_capture(page, prefix):
        return None

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)
    monkeypatch.setattr(monitor.browser, "dismiss_popup", fake_dismiss)
    monkeypatch.setattr(monitor.browser, "goto_url", fake_goto)
    monkeypatch.setattr(monitor.browser, "capture_debug", fake_capture)

    tg = _CapturingTelegram()
    acct_cfg = {"label": "T", "customer_id": "999", "cdp_port": 9222,
                "balance_url": "https://beta.iocxtrapower.com/Custom/Route"}
    asyncio.run(monitor.check_account(_FakePool(object()), acct_cfg, {"accounts": {}}, tg, {}))
    assert "https://beta.iocxtrapower.com/Custom/Route" in gotos
    assert browser_mod.DEFAULT_BALANCE_URL not in gotos


def test_deep_link_waits_for_form_then_skips_menu_walk(monkeypatch):
    """After jumping to the Balance Info URL, the monitor waits for the Search
    form to render and clicks it — so it does NOT fall back to walking the menu
    (the visible 'weird clicks')."""
    called = {"wait": 0, "nav": 0}

    class _Pg:
        url = "https://beta.iocxtrapower.com/Transactions/BalanceInfo"

    reading = _reading(["CCMS"], [["₹100.00"]])
    cs = {"n": 0}

    async def fake_read_page(p, settle_ms=1500):
        return reading

    async def fake_click(p, timeout_ms=8000):
        cs["n"] += 1
        return cs["n"] >= 3          # rungs 1-2 fail; the click after goto works

    async def fake_goto(p, url):
        return True

    async def fake_dismiss(p):
        return None

    async def fake_nav(p, labels):
        called["nav"] += 1

    async def fake_wait(p, timeout_ms=12000):
        called["wait"] += 1
        return True

    async def fake_capture(p, prefix):
        return None

    monkeypatch.setattr(monitor.browser, "read_page", fake_read_page)
    monkeypatch.setattr(monitor.browser, "click_search", fake_click)
    monkeypatch.setattr(monitor.browser, "goto_url", fake_goto)
    monkeypatch.setattr(monitor.browser, "dismiss_popup", fake_dismiss)
    monkeypatch.setattr(monitor.browser, "navigate_to_balance", fake_nav)
    monkeypatch.setattr(monitor.browser, "wait_for_balance_form", fake_wait)
    monkeypatch.setattr(monitor.browser, "capture_debug", fake_capture)

    tg = _CapturingTelegram()
    acct_cfg = {"label": "T", "customer_id": "999", "cdp_port": 9222}
    asyncio.run(monitor.check_account(_FakePool(_Pg()), acct_cfg, {"accounts": {}}, tg, {}))
    assert called["wait"] == 1       # waited for the form after the deep link
    assert called["nav"] == 0        # never walked the menu


# ---- config hot-reload (edits from the account manager apply live) ---------

def _cfg_file(tmp_path, accounts, token="111:aaa"):
    import json as _json
    path = tmp_path / "config.json"
    path.write_text(_json.dumps({"poll_seconds": 120, "telegram": {"token": token, "chat_id": "1"},
                                 "accounts": accounts}), encoding="utf-8")
    return str(path)


def test_reload_picks_up_edits_and_resets_unwatched_handover(tmp_path):
    from xtrapower.notify import Telegram
    a = {"label": "A", "customer_id": "1", "cdp_port": 9222, "watch": True}
    b = {"label": "B", "customer_id": "2", "cdp_port": 9223, "watch": True}
    path = _cfg_file(tmp_path, [a, b])
    cfg = monitor.load_config(path)
    tg = Telegram("111:aaa", "1")
    ready = {"1": True, "2": True}

    path = _cfg_file(tmp_path, [a, {**b, "watch": False}])          # B switched off
    cfg, tg2, err = monitor.reload_config(path, cfg, tg, ready)
    assert err is None
    assert [x["watch"] for x in cfg["accounts"]] == [True, False]
    assert ready == {"1": True}                 # B goes back through the quiet hand-over
    assert tg2 is tg                            # telegram unchanged -> same client


def test_reload_keeps_running_on_a_broken_file(tmp_path):
    from xtrapower.notify import Telegram
    path = _cfg_file(tmp_path, [{"label": "A", "customer_id": "1", "cdp_port": 9222}])
    cfg = monitor.load_config(path)
    tg = Telegram("111:aaa", "1")
    with open(path, "w", encoding="utf-8") as f:
        f.write('{ "accounts": [ broken')
    same, tg2, err = monitor.reload_config(path, cfg, tg, {"1": True})
    assert same is cfg and tg2 is tg
    assert err and "not valid JSON" in err


def test_reload_rebuilds_telegram_when_the_token_changes(tmp_path):
    from xtrapower.notify import Telegram
    acct = [{"label": "A", "customer_id": "1", "cdp_port": 9222}]
    path = _cfg_file(tmp_path, acct)
    cfg = monitor.load_config(path)
    tg = Telegram("111:aaa", "1")
    path = _cfg_file(tmp_path, acct, token="222:bbb")
    cfg, tg2, _ = monitor.reload_config(path, cfg, tg, {})
    assert tg2 is not tg and tg2.token == "222:bbb"


def test_a_check_that_hangs_is_stopped_and_the_others_still_run(monkeypatch, tmp_path):
    """A page that stops answering mid-login must not stop the monitor."""
    monkeypatch.setattr(monitor, "CHECK_TIMEOUT_SECONDS", 0.2)
    checked = []

    async def check(pool, acct_cfg, st, tg, ready):
        checked.append(acct_cfg["label"])
        if acct_cfg["label"] == "Stuck":
            await asyncio.sleep(60)                      # e.g. evaluate() behind a dialog

    monkeypatch.setattr(monitor, "check_account", check)
    tg, pool, ready = _CapturingTelegram(), _FakePool(None), {"1": True}
    cfg = {"accounts": [{"label": "Stuck", "customer_id": "1", "cdp_port": 9222},
                        {"label": "Fine", "customer_id": "2", "cdp_port": 9223}]}
    asyncio.run(monitor.run_cycle(pool, cfg, str(tmp_path / "state.json"), tg, ready))
    assert checked == ["Stuck", "Fine"]                  # the next account still ran
    assert pool.dropped == [9222] and ready["1"] is False
    assert len(tg.messages) == 1 and "The check got stuck" in tg.messages[0]
    asyncio.run(monitor.run_cycle(pool, cfg, str(tmp_path / "state.json"), tg, ready))
    assert len(tg.messages) == 1                         # (not again within the cooldown)


def test_portal_dialogs_are_dismissed_so_the_page_never_freezes():
    events = {}

    class Page:
        url = "https://beta.iocxtrapower.com/login"

        def on(self, name, fn):
            events[name] = fn

    class Dialog:
        type, message = "alert", "Session expired"
        dismissed = False

        async def dismiss(self):
            Dialog.dismissed = True

    pool = browser_mod.BrowserPool()
    page = Page()
    assert pool._watch(page) is page and pool._watch(page) is page and "dialog" in events

    async def go():
        events["dialog"](Dialog())
        await asyncio.sleep(0)
    asyncio.run(go())
    assert Dialog.dismissed


def test_a_tab_that_hangs_twice_is_replaced_with_a_fresh_one(monkeypatch, tmp_path):
    monkeypatch.setattr(monitor, "CHECK_TIMEOUT_SECONDS", 0.1)

    async def stuck(pool, acct_cfg, st, tg, ready):
        await asyncio.sleep(60)
    monkeypatch.setattr(monitor, "check_account", stuck)
    fresh = []

    class Pool(_FakePool):
        async def fresh_page(self, port, url):
            fresh.append((port, url))

    pool, tg, path = Pool(None), _CapturingTelegram(), str(tmp_path / "state.json")
    cfg = {"accounts": [{"label": "Stuck", "customer_id": "1", "cdp_port": 9222}]}
    asyncio.run(monitor.run_cycle(pool, cfg, path, tg, {}))
    assert fresh == []                                    # once: just tried again
    asyncio.run(monitor.run_cycle(pool, cfg, path, tg, {}))
    assert fresh == [(9222, browser_mod.PORTAL_URL)]       # twice: a new tab


def test_accounts_are_checked_side_by_side(monkeypatch, tmp_path):
    import time as _time

    async def slow(pool, acct_cfg, st, tg, ready):
        await asyncio.sleep(0.3)
    monkeypatch.setattr(monitor, "check_account", slow)
    cfg = {"accounts": [{"label": n, "customer_id": n, "cdp_port": 9222 + i} for i, n in enumerate("AB")]}
    t0 = _time.monotonic()
    asyncio.run(monitor.run_cycle(_FakePool(None), cfg, str(tmp_path / "s.json"), _CapturingTelegram(), {}))
    assert _time.monotonic() - t0 < 0.55                  # not 0.6 s one after the other


def test_a_page_script_that_never_returns_is_given_up(monkeypatch):
    monkeypatch.setattr(browser_mod, "EVAL_TIMEOUT_S", 0.05)
    class Frame:
        def evaluate(self, js, arg=None):
            return asyncio.sleep(60)

    async def go():
        try:
            await browser_mod._eval(Frame(), "() => 1", timeout=0.05)
        except (asyncio.TimeoutError, TimeoutError):
            return "gave up"
    assert asyncio.run(go()) == "gave up"
    # and every helper that runs a script carries on rather than hanging
    assert asyncio.run(asyncio.wait_for(browser_mod.click_text(type("P", (), {
        "main_frame": Frame(), "frames": []})(), ["Search"]), 30)) is False


def test_a_chrome_window_that_never_opens_is_told_once_with_the_reason(monkeypatch, tmp_path):
    status = tmp_path / "launch-status.json"
    status.write_text('{"999": {"ok": false, "message": "Chromium closed at once (exit code 21): Missing X server"}}')
    monkeypatch.setattr(monitor, "LAUNCH_STATUS", str(status))
    st = {"accounts": {}}
    pool = _FakePool(None, raise_on_find=True)
    for _ in range(monitor.UNREACHABLE_ALERT_AFTER - 1):
        tg, st, ready = _run_check(monkeypatch, pool, [], st=st)
        assert tg.messages == []                                   # quiet at first: you may be starting it
    tg, st, ready = _run_check(monkeypatch, pool, [], st=st)
    assert len(tg.messages) == 1 and "isn't running on the server" in tg.messages[0]
    assert "Missing X server" in tg.messages[0]
    tg, st, ready = _run_check(monkeypatch, pool, [], st=st)
    assert tg.messages == []                                       # not again on every check


def test_the_reason_is_only_given_for_a_launch_that_failed(monkeypatch, tmp_path):
    status = tmp_path / "launch-status.json"
    status.write_text('{"1": {"ok": true, "message": "open"}, "2": {"ok": false, "message": "no"}}')
    monkeypatch.setattr(monitor, "LAUNCH_STATUS", str(status))
    assert monitor.launch_problem("1") == "" and monitor.launch_problem("2") == "no"
    assert monitor.launch_problem("3") == ""
    monkeypatch.setattr(monitor, "LAUNCH_STATUS", str(tmp_path / "absent.json"))
    assert monitor.launch_problem("2") == ""
