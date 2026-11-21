"""Payments to IOCL are checked against the PAD (bank_tally.run.check_iocl_payments).

A payment the PAD shows is skipped (the IOCL tool posts it). One the PAD covers but
does not show — money gone from the bank, not credited in SAP — is posted to the
IOCL ledger with a remark, so the books match the bank. Real shape: 20-Nov-2026, two
Rs 36,00,000 RTGS payments, only one of them on the PAD.
"""

import datetime as dt
import json

import pytest

from bank_tally import classify as C
from bank_tally import run as BR
from bank_tally import statement as S

ICICI, ICICI_OD = "ICICI BANK LTD", "ICICI OD A/c - 046805005893"
IOCL = "M/s Indian Oil Corporation Limited"
D = dt.date(2026, 11, 20)


def _pay(narr, amount, date=D, i=0, balance=0.0):
    return S.BankRow(index=i, date=date, narration=narr, ref="", withdrawal=amount,
                     deposit=0.0, balance=balance)


def _rtgs(utr):
    return f"RTGS/ICICR4{utr}/SBIN0009995/INDIAN OIL CORPORATION LTD OD C"


def _pad(lines, first="2026-11-12", last="2026-11-20"):
    return {"first": first, "last": last, "lines": [
        {"date": d, "amount": a, "text": t + " ICIC0000011_04680500 4716 Customer ECollection"}
        for d, a, t in lines]}


PAD = _pad([("2026-11-20", 3600000.0, "ICIC26112000502005"),
            ("2026-11-19", 3000000.0, "ICIC26111900502010"),
            ("2026-11-13", 150000.0, "IN42631754863070")])


def _check(items, pad=PAD):
    return BR.check_iocl_payments([(n, d, a, t) for n, (d, a, t) in enumerate(items)], pad)


def test_references_agree_across_the_banks_and_iocls_spelling():
    assert BR._utr_keys(_rtgs("2026112000502005")) == {"26112000502005"}
    assert BR._utr_keys("ICIC26112000502005 ICIC0000011_04680500 4716 Customer ECollection") == {"26112000502005"}
    assert BR._utr_keys("INF/NEFT/IN42631754863070/SBIN0009995/IOCL") == BR._utr_keys("IN42631754863070")
    # an IFSC, an account number or a bare number is not a payment reference
    assert BR._utr_keys("SBIN0009995 046805004716 59217010101010 631717482093") == set()


def test_the_credited_payment_is_told_from_an_equal_one_that_was_not():
    sent = [(D, 3600000.0, _rtgs("2026112000501344")),     # from the OD, not credited
            (D, 3600000.0, _rtgs("2026112000502005"))]     # from the C/A, on the PAD
    assert _check(sent) == {0: "missing", 1: "in_pad"}
    assert _check(sent[::-1]) == {0: "in_pad", 1: "missing"}          # order in the statement is irrelevant


def test_without_a_reference_the_same_amount_within_two_days_matches():
    assert _check([(dt.date(2026, 11, 18), 3000000.0, "NEFT TO INDIAN OIL")]) == {0: "in_pad"}    # 1 day
    assert _check([(dt.date(2026, 11, 17), 3000000.0, "NEFT TO INDIAN OIL")]) == {0: "in_pad"}    # 2 days
    assert _check([(dt.date(2026, 11, 16), 3000000.0, "NEFT TO INDIAN OIL")]) == {0: "missing"}   # 3 days
    assert _check([(D, 3000001.0, "NEFT TO INDIAN OIL")]) == {0: "missing"}                       # other amount


def test_two_different_references_are_two_payments():
    # Only the OD's payment is in this run; the PAD's 3.6M line carries another reference.
    assert _check([(D, 3600000.0, _rtgs("2026112000501344"))]) == {0: "missing"}


def test_a_pad_line_is_used_once():
    two = [(D, 150000.0, "NEFT INDIAN OIL"), (D, 150000.0, "NEFT INDIAN OIL")]
    pad = _pad([("2026-11-20", 150000.0, "")])
    assert sorted(_check(two, pad).values()) == ["in_pad", "missing"]


def test_dates_the_pad_does_not_cover_are_not_judged():
    assert _check([(dt.date(2026, 11, 21), 5.0, "x")]) == {0: "unchecked"}        # after the PAD
    assert _check([(dt.date(2026, 11, 10), 5.0, "x")]) == {0: "unchecked"}        # before it
    assert _check([(dt.date(2026, 11, 12), 5.0, "x")]) == {0: "missing"}          # first day counts
    assert _check([(D, 5.0, "x")]) == {0: "missing"}                              # last day counts


def _run(rows_by_account, pad=PAD, **kw):
    return BR.process(rows_by_account, [], {}, iocl_pad=pad, **kw)


def test_a_payment_missing_from_the_pad_is_posted_to_iocl_with_a_remark():
    od = [_pay(_rtgs("2026112000501344"), 3600000.0)]
    ca = [_pay(_rtgs("2026112000502005"), 3600000.0)]
    other = _pay("MMT/IMPS/631811538099/ChandanSahu/CBIN0281623", 3000.0, i=1)      # staff -> Salary
    vouchers, review, summary = _run([(ICICI_OD, od), (ICICI, ca + [other])])
    flagged = [e for e in summary["entries"] if e.get("flag")]
    assert len(flagged) == 1
    (e,) = flagged
    assert (e["type"], e["account"], e["counter_ledger"], e["amount"]) == ("Payment", ICICI_OD, IOCL, "3600000.00")
    assert e["narration"].startswith("PAID TO IOCL - NOT IN SAP/PAD (PAD TO 20-11-26)")
    assert "ICICR42026112000501344" in e["narration"]                # the bank's own words follow
    assert e["voucher_no"] == "BPI/20261120/01"                       # its own series
    xml = next(v for v in vouchers if "BPI/20261120/01" in v)
    assert "<NARRATION>PAID TO IOCL" in xml and IOCL in xml and "<LEDGERNAME>ICICI OD A/c - 046805005893</LEDGERNAME>" in xml
    # the payment the PAD shows is still left to the PAD tool; the other payment is untouched
    assert summary["skipped_iocl"] == 1 and summary["accounted_ok"]
    assert {k: summary["iocl"][k] for k in ("checked", "in_pad", "missing", "unchecked")} == \
        {"checked": True, "in_pad": 1, "missing": 1, "unchecked": 0}
    normal = [x for x in summary["entries"] if not x.get("flag")]
    assert [x["voucher_no"] for x in normal] == ["BP/20261120/01"]    # numbering not disturbed


def test_without_a_pad_every_payment_to_iocl_is_skipped_as_before():
    od = [_pay(_rtgs("2026112000501344"), 3600000.0)]
    vouchers, review, summary = BR.process([(ICICI_OD, od)], [], {})
    assert not vouchers and summary["skipped_iocl"] == 1
    assert summary["iocl"] == {"checked": False, "skipped": 1}


def test_a_saved_pick_cannot_override_the_pad_check():
    od = _pay(_rtgs("2026112000501344"), 3600000.0)
    ca = _pay(_rtgs("2026112000502005"), 3600000.0)
    picks = {BR.entry_key(ICICI_OD, od.date, od.amount, od.narration): "Some Other Ledger",
             BR.entry_key(ICICI, ca.date, ca.amount, ca.narration): IOCL}
    _, _, summary = _run([(ICICI_OD, [od]), (ICICI, [ca])], resolved=picks)
    (e,) = summary["entries"]
    assert e["flag"] and e["counter_ledger"] == IOCL                 # remark kept, IOCL ledger kept
    assert summary["skipped_iocl"] == 1                              # the credited one still skipped


def test_a_dropped_flagged_payment_stays_dropped():
    od = _pay(_rtgs("2026112000501344"), 3600000.0)
    key = BR.entry_key(ICICI_OD, od.date, od.amount, od.narration)
    vouchers, _, summary = _run([(ICICI_OD, [od])], dropped={key})
    assert not vouchers and summary["entries"][0]["dropped"]


# ---- the Bank app reads the PAD the IOCL app saved; later it says what to delete ----

@pytest.fixture
def bank_server(tmp_path, monkeypatch):
    from bank_tally import server as SV
    monkeypatch.setattr(SV, "DATA_PATH", str(tmp_path / "bank.json"))
    monkeypatch.setattr(SV, "IOCL_DATA", str(tmp_path / "iocl.json"))
    monkeypatch.setattr(SV, "OUT_DIR", str(tmp_path / "out"))
    monkeypatch.setattr(SV, "COMMITTED_ALIASES", str(tmp_path / "none.json"))
    monkeypatch.setattr(SV, "CUSTOMERS", str(tmp_path / "none.json"))
    monkeypatch.setattr(SV, "_OTHER_UPLOADS", [])
    return SV, tmp_path


def test_a_missing_or_malformed_pad_means_no_check(bank_server):
    SV, tmp = bank_server
    assert SV.load_iocl_pad() is None
    (tmp / "iocl.json").write_text(json.dumps({"pad": {"first": "x"}}))
    assert SV.load_iocl_pad() is None
    (tmp / "iocl.json").write_text(json.dumps({"pad": PAD}))
    assert SV.load_iocl_pad() == PAD


def test_a_flagged_payment_that_later_shows_in_the_pad_asks_for_its_voucher_to_be_deleted(bank_server):
    SV, tmp = bank_server
    od = _pay(_rtgs("2026112000501344"), 3600000.0)
    SV._STATEMENTS = [(ICICI_OD, [od])]
    # 1. the PAD does not show it -> posted with a remark, remembered
    (tmp / "iocl.json").write_text(json.dumps({"pad": _pad([])}))
    first = SV._process_and_write()["summary"]
    assert [e["voucher_no"] for e in first["entries"] if e["flag"]] == ["BPI/20261120/01"]
    assert first["iocl"]["now_in_pad"] == []
    again = SV._process_and_write()["summary"]                         # re-import: same voucher
    assert [e["voucher_no"] for e in again["entries"] if e["flag"]] == ["BPI/20261120/01"]
    # 2. IOCL credits it: the next PAD lists it -> no bank voucher, and a reminder
    (tmp / "iocl.json").write_text(json.dumps({"pad": _pad([("2026-11-20", 3600000.0, "ICIC26112000501344")])}))
    later = SV._process_and_write()["summary"]
    assert not later["entries"] and later["skipped_iocl"] == 1
    (note,) = later["iocl"]["now_in_pad"]
    assert (note["voucher_no"], note["amount"], note["date"]) == ("BPI/20261120/01", "3600000.00", "20-11-2026")
    assert SV._process_and_write()["summary"]["iocl"]["now_in_pad"] == [note]      # stays until dismissed
    # 3. dismissed
    SV.ack_iocl_flagged(note["key"])
    assert SV._process_and_write()["summary"]["iocl"]["now_in_pad"] == []


def test_iocl_app_saves_the_pad_it_processed(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0, "tests")
    import test_iocl_tally as T
    from iocl_tally import server as IS
    monkeypatch.setattr(IS, "DATA_PATH", str(tmp_path / "data.json"))
    monkeypatch.setattr(IS, "OUT_DIR", str(tmp_path / "out"))
    IS.generate(T.PAD_TEXT, "", 96)
    pad = json.loads((tmp_path / "data.json").read_text())["pad"]
    assert (pad["first"], pad["last"]) == ("2026-07-01", "2026-07-03")
    assert pad["lines"] == [{"date": "2026-07-02", "amount": 2000.0, "text": pad["lines"][0]["text"]}]
    assert "ECollection" in pad["lines"][0]["text"]
