"""Tests for bank voucher generation + the orchestrator's transfer pairing."""

import datetime as dt

from bank_tally import generate as G
from bank_tally import run as R
from bank_tally.statement import BankRow


def _row(idx, date, narr, wd=0.0, dep=0.0, bal=0.0):
    return BankRow(index=idx, date=date, narration=narr, ref="",
                   withdrawal=wd, deposit=dep, balance=bal)


def test_receipt_signs_and_balance():
    v = G.make_receipt("20260805", 302220.0, "HDFC BANK C/A - 59217010101010",
                       "Aryan Ispat & Power Private Ltd.")
    assert G.voucher_balances(v)
    import re
    leds = dict(re.findall(
        r"<ALLLEDGERENTRIES\.LIST>.*?<LEDGERNAME>([^<]*)</LEDGERNAME>.*?<AMOUNT>(-?[\d.]+)</AMOUNT>",
        v, re.S))
    assert leds["Aryan Ispat & Power Private Ltd."] == "302220.00"    # party Cr
    assert leds["HDFC BANK C/A - 59217010101010"] == "-302220.00"     # bank Dr
    assert "<GUID>" not in v and "<VOUCHERNUMBER>" not in v


def test_payment_signs():
    import re
    v = G.make_payment("20260805", 3134.0, "ICICI BANK LTD", "Salary")
    leds = dict(re.findall(
        r"<ALLLEDGERENTRIES\.LIST>.*?<LEDGERNAME>([^<]*)</LEDGERNAME>.*?<AMOUNT>(-?[\d.]+)</AMOUNT>",
        v, re.S))
    assert leds["Salary"] == "-3134.00"          # expense Dr
    assert leds["ICICI BANK LTD"] == "3134.00"   # bank Cr


def test_contra_reverse_direction_no_clobber():
    # OD -> C/A: the two-banks swap must not collide.
    import re
    v = G.make_contra("20260805", 500000.0, "HDFC BANK OD A/C - 50200110712542",
                      "HDFC BANK C/A - 59217010101010")
    assert G.voucher_balances(v)
    leds = dict(re.findall(
        r"<ALLLEDGERENTRIES\.LIST>.*?<LEDGERNAME>([^<]*)</LEDGERNAME>.*?<AMOUNT>(-?[\d.]+)</AMOUNT>",
        v, re.S))
    assert leds["HDFC BANK OD A/C - 50200110712542"] == "500000.00"    # source Cr
    assert leds["HDFC BANK C/A - 59217010101010"] == "-500000.00"      # dest Dr


def test_transfer_pairing_makes_one_contra():
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010",
          [_row(0, d, "IB FUNDS TRANSFER DR-50200110712542-VRIDDHI FUELS", wd=1275000)])
    od = ("HDFC BANK OD A/C - 50200110712542",
          [_row(0, d, "IB FUNDS TRANSFER CR-59217010101010-VRIDDHI FUELS", dep=1275000)])
    vouchers, review, summary = R.process([ca, od], customers=[], aliases={})
    # One Contra for the pair, not two.
    assert summary["counts"]["Contra"] == 1
    assert all(G.voucher_balances(v) for v in vouchers)


def test_iocl_payment_skipped_in_process():
    d = dt.date(2026, 8, 5)
    od = ("HDFC BANK OD A/C - 50200110712542",
          [_row(0, d, "RTGS DR-SBIN0009995-INDIAN OIL CORPORATION LIMITED-X", wd=2000000)])
    vouchers, review, summary = R.process([od], customers=[], aliases={})
    assert summary["skipped_iocl"] == 1
    assert summary["n_vouchers"] == 0


def test_cgtms_unpaired_transfer_posts_as_contra():
    # A CGTMS leg with no matching pair still posts (destination known = OD).
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010",
          [_row(0, d, "IB FUNDS TRANSFER DR-CGTMS-VRIDDHI FUELS", wd=800000)])
    vouchers, review, summary = R.process([ca], customers=[], aliases={})
    assert summary["counts"]["Contra"] == 1
    assert review == []
    assert all(G.voucher_balances(v) for v in vouchers)


def test_drop_review_row_clears_it_from_review():
    # An unresolved line (goes to review) can be dropped so it stops nagging;
    # it was never in the export anyway.
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010",
          [_row(0, d, "NEFT CR-RBIS0GOODEP-ODISHA SARKAR-VRIDDHIFUELS-RBISH1", dep=23980)])
    vouchers, review, summary = R.process([ca], customers=[], aliases={})
    assert summary["n_review"] == 1 and summary["n_vouchers"] == 0
    key = review[0]["key"]
    vouchers2, review2, summary2 = R.process([ca], customers=[], aliases={}, dropped={key})
    assert summary2["n_review"] == 0          # no longer nagging
    assert summary2["n_dropped"] == 1
    assert review2[0]["dropped"] is True      # still returned, flagged, for restore
    assert vouchers2 == []


def test_drop_excludes_entry_from_export():
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010",
          [_row(0, d, "NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN", dep=141036)])
    customers = ["Keshav Minerals"]
    vouchers, review, summary = R.process([ca], customers=customers, aliases={})
    assert summary["n_vouchers"] == 1
    key = summary["entries"][0]["key"]
    # Drop it -> excluded from export.
    vouchers2, review2, summary2 = R.process([ca], customers=customers, aliases={},
                                             dropped={key})
    assert summary2["n_vouchers"] == 0
    assert summary2["n_dropped"] == 1
    assert vouchers2 == []
    assert summary2["entries"][0]["dropped"] is True
