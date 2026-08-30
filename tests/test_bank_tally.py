"""Tests for the bank-statement tool (bank_tally/) — parser + classifier.

Real statements are private; the Excel test builds a tiny in-memory workbook,
and the classifier tests use synthetic HDFC-style narrations.
"""

import pytest

from bank_tally import classify as C
from bank_tally import statement as S


# ---- remitter extraction ---------------------------------------------------

def test_extract_remitter_neft():
    n = "NEFT CR-ICIC0SF0002-ORISSA METALIKS PRIVATE LIMITED-VRIDDHI FUELS-IN426"
    assert C.extract_remitter(n) == "ORISSA METALIKS PRIVATE LIMITED"


def test_extract_remitter_imps_stops_at_bank_tag():
    n = "IMPS-619018473341-BHARAT LOGISTICS-UTIB-XXXXXXXXXXX6993-DIESEL"
    assert C.extract_remitter(n) == "BHARAT LOGISTICS"


def test_extract_remitter_upi_is_first_field():
    n = "UPI-BALAJI TRADING-BALAJITRADING73@OKSBI-UBIN0535401-619143938120"
    assert C.extract_remitter(n) == "BALAJI TRADING"


def test_extract_remitter_rtgs():
    n = "RTGS CR-KKBK0000958-ARYAN ISPAT AND POWER PRIVATE LI-VRIDDHI FUELS-KKBKR"
    assert C.extract_remitter(n) == "ARYAN ISPAT AND POWER PRIVATE LI"


# ---- classification --------------------------------------------------------

CUSTOMERS = ["Orissa Metaliks Private Limited", "Keshav Minerals", "Ekdant Logistic"]


def _row(narr, deposit=0.0, withdrawal=0.0):
    return S.BankRow(index=0, date=None, narration=narr, ref="",
                     withdrawal=withdrawal, deposit=deposit, balance=0.0)


def test_classify_contra_to_own_account():
    cl = C.classify(_row("IB FUNDS TRANSFER DR-50200110712542-VRIDDHI FUELS",
                         withdrawal=100000), CUSTOMERS)
    assert cl.vtype == C.CONTRA
    assert cl.counter_ledger == "HDFC BANK OD A/C - 50200110712542"


def test_classify_cash_deposit_is_contra_to_cash():
    cl = C.classify(_row("CASH DEPOSIT BY - SELF - JHARSUGUDA", deposit=600000),
                    CUSTOMERS)
    assert cl.vtype == C.CONTRA and cl.counter_ledger == "Cash"


def test_classify_iocl_payment_is_skipped():
    # IOCL payments are posted by the PAD tool; the bank tool skips them to avoid
    # double-counting.
    cl = C.classify(_row("RTGS DR-SBIN0009995-INDIAN OIL CORPORATION LIMITED-NETBANK",
                         withdrawal=2000000), CUSTOMERS)
    assert cl.skip is True
    assert cl.counter_ledger == "M/s Indian Oil Corporation Limited"


def test_staff_payment_maps_to_salary():
    # Bank truncates the name; first+last prefix still matches the staff list.
    for narr in ["MMT/IMPS/618308468876/BULD74167560/NarendraPr/UTIB0003650",
                 "MMT/IMPS/618308468897/BULD74167560/BikramSahu/SBIN0013615",
                 "MMT/IMPS/618308468941/BULD74167560/GokulaBhok/UBIN0572411"]:
        cl = C.classify(_row(narr, withdrawal=7500), CUSTOMERS)
        assert cl.vtype == C.PAYMENT and cl.counter_ledger == "Salary", narr


def test_resolved_alias_applies_both_directions():
    from agent.matcher import alias_key
    aliases = {alias_key("BHARAT LOGISTICS"): "Shivaay Logistics",
               alias_key("CARD BILL PAYMENT"): "HDFC Corporate Credit Card 7311"}
    # receipt side
    rc = C.classify(_row("IMPS-618-BHARAT LOGISTICS-UTIB-XXXX6993", deposit=20000),
                    CUSTOMERS, aliases)
    assert rc.vtype == C.RECEIPT and rc.counter_ledger == "Shivaay Logistics"
    # payment side (card)
    pc = C.classify(_row("IB BILLPAY DR-HDFCYC-463918XXXXXX7113", withdrawal=565399),
                    CUSTOMERS, aliases)
    assert pc.vtype == C.PAYMENT and pc.counter_ledger == "HDFC Corporate Credit Card 7311"


def test_cms_extracts_payer_name():
    assert C.extract_remitter("CMS/ CMS5835842331/SMEL STEEL STRUCTURAL PRIVATE") \
        == "SMEL STEEL STRUCTURAL PRIVATE"


def test_interest_debited_keyword():
    cl = C.classify(_row("INTEREST DEBITED TILL 31-JUL-2026", withdrawal=194675), CUSTOMERS)
    assert cl.vtype == C.PAYMENT and cl.counter_ledger == "Interest Paid"


def test_non_staff_payment_still_reviews():
    cl = C.classify(_row("INF/NEFT/IN42/HDFC0000763/SOME SUPPLIER CO", withdrawal=5000),
                    CUSTOMERS)
    assert cl.counter_ledger is None


def test_classify_receipt_matches_customer():
    cl = C.classify(_row("NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN",
                         deposit=141036), CUSTOMERS)
    assert cl.vtype == C.RECEIPT
    assert cl.counter_ledger == "Keshav Minerals"


def test_classify_receipt_unmatched_goes_to_review():
    cl = C.classify(_row("NEFT CR-UTIB0000240-SIMAR INFRASTRUCTURES LTD-VRIDDHI FUELS-U",
                         deposit=137940), CUSTOMERS)
    assert cl.vtype == C.RECEIPT
    assert cl.counter_ledger is None            # needs review
    assert cl.counterparty_raw == "SIMAR INFRASTRUCTURES LTD"


def test_classify_receipt_rule_pine_labs():
    cl = C.classify(_row("NEFT CR-UTIB0000361-PINE LABS PRIVATE LIMITED-NODAL ACCOUNT-VRIDDHI FUELS",
                         deposit=15111), CUSTOMERS)
    assert cl.counter_ledger == "Pine Labs Nodal Account"


def test_alias_resolves_unmatched():
    from agent.matcher import alias_key
    aliases = {alias_key("SIMAR INFRASTRUCTURES LTD"): "Simar Infrastructure LTD"}
    cl = C.classify(_row("NEFT CR-UTIB0000240-SIMAR INFRASTRUCTURES LTD-VRIDDHI FUELS-U",
                         deposit=137940), CUSTOMERS, aliases=aliases)
    assert cl.counter_ledger == "Simar Infrastructure LTD"


def test_cgtms_self_transfer_routes_to_od():
    # A CGTMS self-transfer is our HDFC OD account (50200110712542).
    cl = C.classify(_row("IB FUNDS TRANSFER CR-CGTMS-VRIDDHI FUELS", deposit=1275000),
                    CUSTOMERS)
    assert cl.vtype == C.CONTRA
    assert cl.counter_ledger == "HDFC BANK OD A/C - 50200110712542"


def test_odisha_sarkar_always_reviews_even_with_alias():
    # ODISHA SARKAR belongs to different ledgers per transaction (JYOTI RANJAN vs
    # OIC FS Jharsuguda), so it must always go to review — even if an alias was
    # saved by mistake.
    from agent.matcher import alias_key
    aliases = {alias_key("ODISHA SARKAR"): "JYOTI RANJAN DASH"}
    cl = C.classify(_row("RTGS DR-SBIN0009995-ODISHA SARKAR-VRIDDHI FUELS-X",
                         withdrawal=50000), CUSTOMERS, aliases=aliases)
    assert cl.counter_ledger is None
    assert cl.tier == "force-review"


# ---- excel parsing + reconciliation ----------------------------------------

def test_parse_excel_reconciles(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Date", "Narration", "Chq./Ref.No.", "Value Dt",
               "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"])
    # opening 1000; +500 -> 1500; -200 -> 1300; +100 -> 1400
    ws.append(["01/07/26", "NEFT CR-X-ACME-VRIDDHI FUELS-1", "R1", "01/07/26", "", 500, 1500])
    ws.append(["02/07/26", "IB FUNDS TRANSFER DR-50200110712542-VRIDDHI FUELS", "R2",
               "02/07/26", 200, "", 1300])
    ws.append(["03/07/26", "IMPS-1-BOB-VRIDDHI FUELS-2", "R3", "03/07/26", "", 100, 1400])
    p = tmp_path / "stmt.xlsx"
    wb.save(str(p))
    rows, summ = S.parse_excel(str(p))
    assert summ["reconciles"] is True
    assert summ["n_rows"] == 3
    assert rows[0].deposit == 500 and rows[1].withdrawal == 200
    assert summ["opening"] == 1000.0 and summ["closing"] == 1400.0
