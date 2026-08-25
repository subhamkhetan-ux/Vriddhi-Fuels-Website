"""Parser tests. The sample bodies approximate real HDFC / ICICI credit alerts;
they exercise the profile patterns end-to-end. Re-check the patterns against
your own alert emails and adjust config.py if a bank's wording differs."""

from agent.config import HDFC, ICICI
from agent.parser import normalize_date, parse, parse_amount

HDFC_BODY = (
    "Dear Customer, Rs. 1,25,000.00 is successfully credited to your account "
    "XXXXXXXX1234 on 15-06-2025 by M/S SUDARSHAN MINERALS AND LOG Ref no "
    "NEFT CITIN52025061512345. Available balance is Rs. 3,40,000.00."
)

ICICI_BODY = (
    "Dear Customer, Your ICICI Bank Account XX123 has been credited with "
    "INR 5,000.00 on 16-Jun-2025. Info: UPI/512345678901/Payment/RAKESH KUMAR/. "
    "Available balance: INR 22,000.00."
)


def test_parse_amount_strips_separators():
    assert parse_amount("Rs. 1,25,000.00") == 125000.0
    assert parse_amount("INR 5000") == 5000.0
    assert parse_amount("₹1,00,000") == 100000.0


def test_normalize_date_variants():
    assert normalize_date("15-06-2025") == "15/06/2025"
    assert normalize_date("15/06/25") == "15/06/25"
    assert normalize_date("16-Jun-2025") == "16/06/2025"
    assert normalize_date("16 Jun 2025") == "16/06/2025"


def test_hdfc_alert_parses():
    r = parse(HDFC, "Credit alert", HDFC_BODY)
    assert r.ok, r.error
    assert r.bank == "HDFC"
    assert r.amount == 125000.0
    assert r.date_str == "15/06/2025"
    assert r.date_serial is not None
    assert "SUDARSHAN MINERALS AND LOG" in r.raw_payer
    assert r.mode == "HDFC NEFT"


def test_icici_alert_parses():
    r = parse(ICICI, "Account credited", ICICI_BODY)
    assert r.ok, r.error
    assert r.bank == "ICICI"
    assert r.amount == 5000.0
    assert r.date_str == "16/06/2025"
    assert "RAKESH KUMAR" in r.raw_payer
    assert r.mode == "ICICI UPI"


def test_parse_failure_keeps_raw_text_not_ok():
    r = parse(HDFC, "Newsletter", "This email has no amount or payer information.")
    assert not r.ok
    assert r.raw_text  # preserved for debugging
    assert "amount" in r.error
