"""Edge cases for the three Tally import tools (bank / IOCL PAD / fleet).

Each test pins down a way the tools could otherwise post a wrong, duplicated or
silently-misrouted voucher — or break when a new bank account is added. All data
here is synthetic.
"""

import datetime as dt
import re

import pytest

from bank_tally import classify as C
from bank_tally import run as BR
from bank_tally import statement as S
from fleet_tally import parse as FP
from fleet_tally import run as FR
from iocl_tally import run as IR
from iocl_tally import xml_generator as IG

CUSTOMERS = ["Keshav Minerals", "Orissa Metaliks Private Limited"]
CA, OD = "HDFC BANK C/A - 59217010101010", "HDFC BANK OD A/C - 50200110712542"
ICICI, ICICI_OD = "ICICI BANK LTD", "ICICI OD A/c - 046805005893"


def _row(narr, deposit=0.0, withdrawal=0.0, date=dt.date(2026, 10, 1), balance=0.0, i=0):
    return S.BankRow(index=i, date=date, narration=narr, ref="",
                     withdrawal=withdrawal, deposit=deposit, balance=balance)


def _xlsx(tmp_path, rows, name="s.xlsx"):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    p = tmp_path / name
    wb.save(str(p))
    return str(p)


@pytest.fixture(autouse=True)
def _clean_registry():
    C.configure_accounts({})
    IG.CUSTOM_RULES[:] = []
    IG.EXTRA_COLLECTION_ROUTES[:] = []
    IG.LEDGER_RENAMES.clear()
    yield
    C.configure_accounts({})
    IG.CUSTOM_RULES[:] = []
    IG.EXTRA_COLLECTION_ROUTES[:] = []
    IG.LEDGER_RENAMES.clear()


# ============================ BANK: reading statements ======================

HDR = ["Date", "Narration", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]


def test_account_not_detected_from_digits_split_across_cells(tmp_path):
    # "04680500" + "5893" from two different header cells is NOT our ICICI OD.
    p = _xlsx(tmp_path, [["Customer ID", "04680500"], ["Branch", "5893"], [],
                         HDR, ["01/10/2026", "x", 1, "", 9]])
    assert S.detect_account(p) is None


def test_account_detected_with_spaces_or_masking(tmp_path):
    p = _xlsx(tmp_path, [["Account No :", "0468 0500 5893"], [], HDR,
                         ["01/10/2026", "x", 1, "", 9]])
    assert S.detect_account(p) == ICICI_OD
    p = _xlsx(tmp_path, [["Account Number: XXXXXXXX5893"], [], HDR,
                         ["01/10/2026", "x", 1, "", 9]], "m.xlsx")
    assert S.detect_account(p) == ICICI_OD


def test_two_own_accounts_in_header_is_ambiguous(tmp_path):
    p = _xlsx(tmp_path, [["Account No", "046805005893"], ["Linked a/c", "046805004716"], [],
                         HDR, ["01/10/2026", "x", 1, "", 9]])
    assert S.detect_account(p) is None


def test_opening_and_zero_rows_are_not_transactions(tmp_path):
    p = _xlsx(tmp_path, [HDR,
                         ["01/10/2026", "OPENING BALANCE", "", "", 1000],
                         ["01/10/2026", "NEFT CR-X-ACME-VRIDDHI FUELS", "", 500, 1500],
                         ["02/10/2026", "CLOSING BALANCE", 0, 0, 1500]])
    rows, summ = S.parse_excel(p)
    assert [r.amount for r in rows] == [500.0]
    assert summ["reconciles"] is True and summ["opening"] == 1000.0


def test_newest_first_statement_is_put_in_date_order(tmp_path):
    p = _xlsx(tmp_path, [HDR,
                         ["03/10/2026", "C", "", 100, 1400],
                         ["02/10/2026", "B", 200, "", 1300],
                         ["01/10/2026", "A", "", 500, 1500]])
    rows, summ = S.parse_excel(p)
    assert [r.narration for r in rows] == ["A", "B", "C"]
    assert summ["reconciles"] is True and [r.index for r in rows] == [0, 1, 2]


def test_dr_cr_suffixed_overdraft_balances(tmp_path):
    p = _xlsx(tmp_path, [HDR,
                         ["01/10/2026", "A", 50000, "", "50,000.00 Dr"],
                         ["02/10/2026", "B", "", 20000, "30,000.00 Dr"],
                         ["03/10/2026", "C", "", 40000, "10,000.00 Cr"]])
    rows, summ = S.parse_excel(p)
    assert [r.balance for r in rows] == [-50000.0, -30000.0, 10000.0]
    assert summ["reconciles"] is True


def test_single_amount_column_with_dr_cr_indicator(tmp_path):
    p = _xlsx(tmp_path, [["Txn Date", "Description", "Amount", "Dr/Cr", "Balance"],
                         ["01/10/2026", "A", "500.00", "CR", 1500],
                         ["02/10/2026", "B", "200.00", "DR", 1300]])
    rows, summ = S.parse_excel(p)
    assert [(r.deposit, r.withdrawal) for r in rows] == [(500.0, 0.0), (0.0, 200.0)]
    assert summ["reconciles"] is True


def test_excel_serial_and_spelled_out_dates(tmp_path):
    p = _xlsx(tmp_path, [HDR,
                         [46296, "serial", "", 100, 100],
                         ["02 Oct 2026", "spaced", "", 100, 200],
                         ["03/10/2026 10:15:00", "with time", "", 100, 300],
                         ["04.10.2026", "dotted", "", 100, 400]])
    rows, _ = S.parse_excel(p)
    assert [r.date for r in rows] == [dt.date(2026, 10, 1), dt.date(2026, 10, 2),
                                      dt.date(2026, 10, 3), dt.date(2026, 10, 4)]


# ============================ BANK: classifying ============================

def test_own_account_number_inside_a_longer_reference_is_not_a_transfer():
    cl = C.classify(_row("UPI-ACME TRADERS-REF91046805004716-PAYMENT", deposit=500), CUSTOMERS)
    assert cl.vtype != C.CONTRA


def test_statement_never_transfers_to_itself():
    # Interest credited to the OD names the OD's own number — not a Contra to itself.
    row = _row("INT.COLL:046805005893:SEP-2026", withdrawal=1200)
    cl = C.classify(row, CUSTOMERS, statement_ledger=ICICI_OD)
    assert not (cl.vtype == C.CONTRA and cl.counter_ledger == ICICI_OD)


def test_ifsc_pins_a_self_transfer_to_the_only_account_at_that_bank():
    C.configure_accounts({"123456789012": "SBI CA - 9012"})
    cl = C.classify(_row("NEFT CR-SBIN0001234-VRIDDHI FUELS-VRIDDHI FUELS", deposit=900), CUSTOMERS)
    assert cl.vtype == C.CONTRA and cl.counter_ledger == "SBI CA - 9012"
    # Two ICICI accounts (C/A + OD): an ICICI IFSC can't say which.
    cl = C.classify(_row("NEFT CR-ICIC0000468-VRIDDHI FUELS-VRIDDHI FUELS", deposit=900), CUSTOMERS)
    assert cl.counter_ledger is None


# ============================ BANK: run / pairing ===========================

def _entries(statements, **kw):
    vouchers, review, summary = BR.process(statements, CUSTOMERS, **kw)
    return vouchers, review, summary


def test_pairing_uses_account_hints_with_many_accounts():
    d = dt.date(2026, 10, 1)
    w_ca = _row("IB FUNDS TRANSFER DR-50200110712542-VRIDDHI FUELS", withdrawal=100000, date=d)
    w_ic = _row("NEFT DR-ICIC0000468-VRIDDHI FUELS", withdrawal=100000, date=d)
    d_icod = _row("NEFT CR-ICIC0000468-VRIDDHI FUELS-VRIDDHI FUELS", deposit=100000, date=d)
    d_od = _row("IB FUNDS TRANSFER CR-59217010101010-VRIDDHI FUELS", deposit=100000, date=d)
    _, review, summary = _entries([(CA, [w_ca]), (ICICI, [w_ic]),
                                   (ICICI_OD, [d_icod]), (OD, [d_od])])
    pairs = {(e["account"], e["counter_ledger"]) for e in summary["entries"] if e["type"] == "Contra"}
    assert pairs == {(CA, OD), (ICICI, ICICI_OD)}
    assert summary["accounted_ok"] and not review


def test_transfer_credited_next_day_still_pairs():
    w = _row("NEFT DR-ICIC0000468-VRIDDHI FUELS", withdrawal=75000, date=dt.date(2026, 9, 30))
    d = _row("NEFT CR-HDFC0000240-VRIDDHI FUELS-VRIDDHI FUELS", deposit=75000,
             date=dt.date(2026, 10, 1))
    _, review, summary = _entries([(CA, [w]), (ICICI, [d])])
    contras = [e for e in summary["entries"] if e["type"] == "Contra"]
    assert len(contras) == 1 and contras[0]["srclines"] == 2 and not review
    assert contras[0]["account"] == CA and contras[0]["counter_ledger"] == ICICI


def test_overlapping_statements_of_one_account_are_deduplicated():
    a = _row("NEFT CR-X-ACME-VRIDDHI FUELS", deposit=500, balance=1500, i=0)
    b = _row("NEFT CR-X-ZORBA-VRIDDHI FUELS", deposit=300, balance=1800,
             date=dt.date(2026, 10, 2), i=1)
    c = _row("NEFT CR-X-QUIX-VRIDDHI FUELS", deposit=200, balance=2000,
             date=dt.date(2026, 10, 3), i=0)
    merged, dupes = BR.merge_statements([(CA, [a, b]), (CA, [S.BankRow(**vars(b)), c])])
    assert dupes == 1
    assert [(led, [r.narration for r in rows]) for led, rows in merged] == \
        [(CA, [a.narration, b.narration, c.narration])]


def test_identical_rows_in_one_statement_both_post_with_distinct_keys():
    r1 = _row("SMS CHARGES", withdrawal=17.7, balance=983.3, i=0)
    r2 = _row("SMS CHARGES", withdrawal=17.7, balance=965.6, i=1)
    C.PAYMENT_RULES.append((r"SMS CHARGES", "Bank Charges"))
    try:
        _, review, summary = _entries([(CA, [r1, r2])])
    finally:
        C.PAYMENT_RULES.pop()
    keys = [e["key"] for e in summary["entries"]]
    assert len(keys) == 2 and len(set(keys)) == 2
    merged, dupes = BR.merge_statements([(CA, [r1, r2])])   # same file: not duplicates
    assert dupes == 0 and len(merged[0][1]) == 2


def test_row_that_breaks_the_balance_chain_goes_to_review():
    ok = _row("NEFT CR-X-KESHAV MINERALS-VRIDDHI FUELS", deposit=500, i=0)
    bad = _row("NEFT CR-X-KESHAV MINERALS-VRIDDHI FUELS", deposit=999, i=1,
               date=dt.date(2026, 10, 2))
    bad.reconciles = False
    _, review, summary = _entries([(CA, [ok, bad])])
    assert len(summary["entries"]) == 1
    assert len(review) == 1 and "balance" in review[0]["note"].lower()
    assert summary["accounted_ok"]


# ============================ IOCL PAD =====================================

def _pad(*lines):
    return "\n".join(["Opening Balance: Rs 1000.00", "OP.BAL.in Comp Code:", "01.10.26",
                      "0", "0", "1000.00", *lines])


def test_line_against_its_category_direction_is_not_posted():
    # A Fleet line is always a credit; a debit one (a reversal) must not be
    # posted with the credit shape.
    text = _pad("4000484887-0003209", "20261001000001", "Fleet- Card", "Posting",
                "01.10.26", "250.00", "0", "1250.00")
    _, vouchers, review, _ = IR.process(text, invoices={})
    assert not vouchers
    assert review[0]["status"] == "SKIPPED" and "direction" in review[0]["note"]


def test_zero_amount_line_is_not_posted():
    text = _pad("K1 PARTICIPATION", "FEE", "Customer", "debit memo",
                "01.10.26", "0", "0", "1000.00")
    _, vouchers, review, _ = IR.process(text, invoices={})
    assert not vouchers and review[0]["status"] == "SKIPPED"


def test_collection_into_an_unknown_account_is_not_posted_to_hdfc_od():
    text = _pad("SBIN26100100001", "SBIN0001234_1234 5678 9012", "Customer", "ECollection",
                "01.10.26", "0", "5000.00", "-4000.00")
    _, vouchers, review, _ = IR.process(text, invoices={})
    assert not vouchers
    assert review[0]["status"] == "SKIPPED" and "123456789012" in review[0]["note"]


def test_collection_routes_by_the_receiving_account_not_digits_in_the_utr():
    # The UTR happens to contain "5921701" (the C/A's number) but the money
    # went to the OD.
    tpl, led = IG.collection_route("HDFC59217010000 HDFC0000240_5020011 0712542")
    assert led == OD
    # No account in the item text at all: as before, the OD.
    assert IG.collection_route("HDFC12345 Customer ECollection")[1] == OD


def test_iocl_learns_accounts_registered_in_the_bank_app(tmp_path, monkeypatch):
    import json
    from iocl_tally import server as SV
    bank_data = tmp_path / "bank.json"
    bank_data.write_text(json.dumps({"own_accounts": {"123456789012": "SBI CA - 9012"}}))
    monkeypatch.setattr(SV, "DATA_PATH", str(tmp_path / "iocl.json"))
    monkeypatch.setattr(SV, "BANK_DATA", str(bank_data))
    SV.apply_config()
    assert IG.collection_route("SBIN0001234_1234 5678 9012")[1] == "SBI CA - 9012"
    v = IG.make_journal("COLLECTION", "20261001", 5000.0,
                        collection_item_text="SBIN0001234_123456789012")
    assert "<LEDGERNAME>SBI CA - 9012</LEDGERNAME>" in v and IG.voucher_balances(v)


# ============================ FLEET ========================================

def test_negative_amount_is_an_error_not_a_broken_voucher():
    rows = FP._rows_from_grid([["Date", "Customer Name", "Amount"],
                               ["01/10/2026", "Keshav Minerals", -500]])
    assert rows[0].error and "negative" in rows[0].error
    vouchers, entries, summ = FR.process(rows, [], CUSTOMERS)
    assert not vouchers and summ["n_error"] == 1


def test_fleet_excel_serial_date():
    rows = FP._rows_from_grid([["Date", "Customer Name", "Amount"],
                               [46296, "Keshav Minerals", 500]])
    assert rows[0].date == dt.date(2026, 10, 1) and not rows[0].error


def test_fleet_dates_with_time_or_dots():
    rows = FP._rows_from_grid([["Date", "Customer Name", "Amount"],
                               ["01/10/2026 10:15", "Keshav Minerals", 500],
                               ["02.10.2026", "Keshav Minerals", 500]])
    assert [r.date for r in rows] == [dt.date(2026, 10, 1), dt.date(2026, 10, 2)]
    assert not any(r.error for r in rows)
