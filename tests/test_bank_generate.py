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
    # The "&" in the ledger name is XML-escaped (else Tally drops the voucher).
    assert leds["Aryan Ispat &amp; Power Private Ltd."] == "302220.00"    # party Cr
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


def test_every_voucher_gets_a_unique_number():
    import re
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010", [
        _row(0, d, "NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN", dep=141036),
        _row(1, d, "NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN", dep=50000),
        _row(2, dt.date(2026, 8, 6), "NEFT DR-X-SALARY PAYMENT", wd=3000),
    ])
    vouchers, review, summary = R.process([ca], customers=["Keshav Minerals"], aliases={})
    nums = [re.search(r"<VOUCHERNUMBER>([^<]*)</VOUCHERNUMBER>", v).group(1) for v in vouchers]
    assert len(nums) == len(set(nums)) == 3            # unique per voucher
    assert nums[0] == "BR/20260805/01" and nums[1] == "BR/20260805/02"
    assert any(n.startswith("BP/20260806/") for n in nums)
    # the number is also exposed on the entries for the audit
    assert all(e["voucher_no"] for e in summary["entries"])


def test_reconciliation_holds_with_resolved_rows():
    # Regression: resolving a review row removes it from `classified`; n_lines must
    # still count it, or the reconciliation falsely reports a MISMATCH.
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010", [
        _row(0, d, "NEFT CR-RBIS0GOODEP-ODISHA SARKAR-VRIDDHIFUELS-R1", dep=23980),
        _row(1, d, "NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN", dep=141036),
    ])
    _, review, _ = R.process([ca], customers=["Keshav Minerals"], aliases={})
    key = review[0]["key"]
    v, r2, s = R.process([ca], customers=["Keshav Minerals"], aliases={},
                         resolved={key: "JYOTI RANJAN DASH"})
    assert s["n_lines"] == 2
    assert s["lines_accounted"] == 2
    assert s["accounted_ok"] is True


def test_ledger_names_with_ampersand_are_escaped():
    # A bare "&" makes the file invalid XML; Tally then silently skips the voucher
    # (and a chunk around it). Every substituted name must be XML-escaped.
    import re
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010", [
        _row(0, d, "RTGS CR-KKBK-ARYAN ISPAT AND POWER PRIVATE LI-VRIDDHI FUELS", dep=302220),
    ])
    vouchers, review, summary = R.process(
        [ca], customers=["Aryan Ispat & Power Private Ltd."], aliases={})
    env = G.build_envelope(vouchers)
    assert re.search(r"&(?!amp;|lt;|gt;|quot;|apos;|#)", env) is None   # no bare &
    assert "Aryan Ispat &amp; Power Private Ltd." in env


def test_vouchers_use_dedicated_bank_types():
    v = G.make_receipt("20260805", 100.0, "HDFC BANK C/A - 59217010101010",
                       "Keshav Minerals")
    assert 'VCHTYPE="Bank Receipt"' in v
    assert "<VOUCHERTYPENAME>Bank Receipt</VOUCHERTYPENAME>" in v
    assert G.voucher_balances(v)
    p = G.make_payment("20260805", 100.0, "ICICI BANK LTD", "Salary")
    assert 'VCHTYPE="Bank Payment"' in p
    c = G.make_contra("20260805", 100.0, "HDFC BANK C/A - 59217010101010",
                      "HDFC BANK OD A/C - 50200110712542")
    assert 'VCHTYPE="Bank Contra"' in c


def test_reconciliation_accounts_for_every_line():
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010", [
        _row(0, d, "NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN", dep=141036),
        _row(1, d, "RTGS DR-SBIN0009995-INDIAN OIL CORPORATION LIMITED-X", wd=2000000),
        _row(2, d, "NEFT CR-UTIB0000240-SIMAR INFRASTRUCTURES LTD-VRIDDHI FUELS", dep=137940),
    ])
    od = ("HDFC BANK OD A/C - 50200110712542",
          [_row(0, d, "IB FUNDS TRANSFER CR-59217010101010-VRIDDHI FUELS", dep=141036)])
    vouchers, review, summary = R.process([ca, od], customers=["Keshav Minerals"], aliases={})
    # 4 lines: 1 receipt + 1 IOCL skip + 1 review + 1 (paired OD leg with... none here)
    assert summary["accounted_ok"] is True
    assert summary["lines_accounted"] == summary["n_lines"] == 4
    assert summary["skipped_iocl"] == 1
    assert len(summary["skipped"]) == 1


def test_vouchers_emit_in_statement_order():
    # A cash-deposit (Contra) sits between two other lines; the export must keep
    # statement order, not group all Contras first.
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010", [
        _row(0, d, "NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN", dep=141036),
        _row(1, d, "CASH DEPOSIT BY SELF", dep=50000),
        _row(2, d, "NEFT DR-X-SALARY PAYMENT", wd=3000),
    ])
    vouchers, review, summary = R.process([ca], customers=["Keshav Minerals"], aliases={})
    types = [e["type"] for e in summary["entries"]]
    assert types == ["Receipt", "Contra", "Payment"]      # row order, not type order


def test_resolve_force_review_row_by_key_adds_receipt():
    # ODISHA SARKAR ignores aliases; a per-transaction resolution must still
    # add the voucher and clear it from review.
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010",
          [_row(0, d, "NEFT CR-RBIS0GOODEP-ODISHA SARKAR-VRIDDHIFUELS-RBISH1", dep=23980)])
    vouchers, review, summary = R.process([ca], customers=[], aliases={})
    assert summary["n_review"] == 1 and summary["n_vouchers"] == 0
    key = review[0]["key"]
    v2, r2, s2 = R.process([ca], customers=[], aliases={},
                           resolved={key: "JYOTI RANJAN DASH"})
    assert s2["n_review"] == 0 and s2["n_vouchers"] == 1
    assert s2["entries"][0]["type"] == "Receipt"
    assert s2["entries"][0]["counter_ledger"] == "JYOTI RANJAN DASH"
    assert all(G.voucher_balances(v) for v in v2)


def test_resolve_unpaired_transfer_by_key_to_bank_makes_contra():
    d = dt.date(2026, 8, 5)
    ca = ("HDFC BANK C/A - 59217010101010",
          [_row(0, d, "IB FUNDS TRANSFER DR-VRIDDHI FUELS", wd=500000)])
    vouchers, review, summary = R.process([ca], customers=[], aliases={})
    assert summary["n_review"] == 1                 # unpaired self-transfer
    key = review[0]["key"]
    dest = "HDFC BANK OD A/C - 50200110712542"
    v2, r2, s2 = R.process([ca], customers=[], aliases={}, resolved={key: dest})
    assert s2["n_review"] == 0 and s2["counts"]["Contra"] == 1
    assert s2["entries"][0]["counter_ledger"] == dest
    assert all(G.voucher_balances(v) for v in v2)


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
