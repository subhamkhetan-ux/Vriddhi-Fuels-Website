"""Parser tests. The HDFC body is the owner's real credit-alert format; the
ICICI body approximates one until a real sample is available. Re-check the
patterns against your own alert emails and adjust config.py if wording differs."""

from agent.config import HDFC, ICICI
from agent.parser import normalize_date, parse, parse_amount

# Real HDFC credit alert (account ending 1010).
HDFC_BODY = (
    "Dear Customer,\n"
    "You have received a credit in your HDFC Bank account.\n"
    "Details of the transaction:\n"
    "Amount received: INR 41,97,180.00\n"
    "Account: XX1010\n"
    "Date: 25-AUG-2026\n"
    "Reference Details: RTGS Cr-SBIN0018956-DBL SIARMAL COAL MINES PRIVATE LIM"
    "-VRIDDHI FUELS-SBINR52026082540174673"
)

# A debit alert on the same account — must be ignored.
HDFC_DEBIT = (
    "Dear Customer,\n"
    "Rs. 10,000.00 has been debited from your HDFC Bank account XX1010 on "
    "25-AUG-2026. Info: UPI-somebody."
)

# A credit for the OTHER HDFC account (2542) — must be ignored.
HDFC_OTHER_ACCT = (
    "Dear Customer,\n"
    "You have received a credit in your HDFC Bank account.\n"
    "Amount received: INR 5,000.00\n"
    "Account: XX2542\n"
    "Date: 25-AUG-2026\n"
    "Reference Details: NEFT Cr-ICIC0000123-SOME OTHER PARTY-VRIDDHI FUELS-REF123"
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
    assert parse_amount("INR 41,97,180.00") == 4197180.0


def test_normalize_date_variants():
    assert normalize_date("15-06-2025") == "15/06/2025"
    assert normalize_date("15/06/25") == "15/06/25"
    assert normalize_date("16-Jun-2025") == "16/06/2025"
    assert normalize_date("25-AUG-2026") == "25/08/2026"


def test_hdfc_credit_1010_parses():
    r = parse(HDFC, "You have received a credit", HDFC_BODY)
    assert r.ok, r.error
    assert r.bank == "HDFC"
    assert r.amount == 4197180.0
    assert r.date_str == "25/08/2026"
    assert r.date_serial is not None
    assert "DBL SIARMAL COAL MINES" in r.raw_payer
    assert r.mode == "HDFC 1010"   # fixed account tag, not the payment rail


def test_hdfc_debit_is_ignored():
    r = parse(HDFC, "debit alert", HDFC_DEBIT)
    assert not r.ok
    assert r.ignore is True         # dropped entirely, never queued


def test_hdfc_other_account_is_ignored():
    r = parse(HDFC, "You have received a credit", HDFC_OTHER_ACCT)
    assert not r.ok
    assert r.ignore is True         # account 2542, not 1010


def test_icici_alert_parses():
    r = parse(ICICI, "Account credited", ICICI_BODY)
    assert r.ok, r.error
    assert r.bank == "ICICI"
    assert r.amount == 5000.0
    assert r.date_str == "16/06/2025"
    assert "RAKESH KUMAR" in r.raw_payer


def test_parse_failure_keeps_raw_text_not_ok():
    # Passes the gate (credit for 1010) but the amount/payer can't be read ->
    # a debuggable review row, not an ignore.
    body = ("You have received a credit in your HDFC Bank account.\n"
            "Account: XX1010\nDate: 25-AUG-2026\n(no amount line, no reference)")
    r = parse(HDFC, "credit", body)
    assert not r.ok
    assert r.ignore is False
    assert r.raw_text
    assert "amount" in r.error
