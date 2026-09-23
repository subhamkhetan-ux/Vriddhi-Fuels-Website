"""Unit tests for the XtraPower monitor's browser-free logic.

Deliberately free of Playwright so they run with only the repo's root
requirements.txt. The browser-driven orchestration tests live in
test_xtrapower_monitor.py and skip themselves when Playwright is absent.
"""

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
