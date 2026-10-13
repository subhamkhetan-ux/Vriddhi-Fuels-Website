"""Synthetic PAD reports only: never keep real statements or login details here."""
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest

from iocl_portal import captcha
from iocl_portal.statement import IST, PortalError, parse_statement, signed_amount
from iocl_portal.sync import payments_config, save_balance, save_opening

NOW = datetime(2026, 10, 13, 7, 0, tzinfo=IST)
REPORT = """
Customer:- TEST FUEL OUTLET (999999)
Controlling Office:- Test Office
Report Generated Date/Time: Tue Oct 13 2026 6:59:04 AM
From 12-Oct-2026 To 13-Oct-2026
Opening Balance: Rs. 10000.00
Closing balance: Rs. -14500.00
"""


def rows(amount="-15000.00"):
    return [
        ["Plant", "Item Text", "Date", "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"],
        ["", "OP.BAL.in Comp Code:", "12.10.26", "0", "0", "10000.00"],
        ["", "Customer collection", "12.10.26", "0", "25000.00", amount],
        ["", "CL.BAL.in Comp Code:", "13.10.26", "0", "0", amount],
        ["", "Open Delivery value in all CCA:", "", "0", "0", "500.00"],
    ]


def parse(text=REPORT, table_rows=None, now=NOW):
    return parse_statement(text, table_rows=rows() if table_rows is None else table_rows,
                           customer="999999", today=now.date(), now=now)


def test_company_row_excludes_open_deliveries_and_footer():
    balance = parse()
    assert balance.amount == Decimal("15000.00")
    assert balance.sign == "CR"
    assert balance.amount != Decimal("14500.00")
    row = balance.row()
    assert row["at"] == "2026-10-13T01:29:04+00:00"
    assert row["amount"] == "15000.00"
    assert "excluding open deliveries" in row["raw"]
    # Footer changes have no effect on the selected company-code amount.
    assert parse(REPORT.replace("-14500.00", "99999.00")) == balance


@pytest.mark.parametrize(("amount", "absolute", "sign"), [
    ("16000.25", "16000.25", "DR"), ("0.00", "0.00", "DR"),
    ("−23,45,678.90", "2345678.90", "CR"), ("5,000.10 CR", "5000.10", "CR"),
    ("Rs. 700.50 DR", "700.50", "DR"),
])
def test_company_amount_sign_and_grouping(amount, absolute, sign):
    balance = parse(table_rows=rows(amount))
    assert (balance.amount, balance.sign) == (Decimal(absolute), sign)


@pytest.mark.parametrize("amount", ["1,23.00", "1.000,00", "--50.00", "-50.00 DR",
                                   "NaN", "", "100.005", "1000000000001.00"])
def test_rejects_ambiguous_money(amount):
    with pytest.raises(PortalError):
        signed_amount(amount)


@pytest.mark.parametrize("case", ["missing_company", "duplicate_company", "not_above_delivery",
                                  "missing_delivery", "wrong_header", "missing_cell"])
def test_rejects_unverified_table_even_when_footer_exists(case):
    table = rows()
    if case == "missing_company":
        table.pop(3)
    elif case == "duplicate_company":
        table.insert(3, table[3].copy())
    elif case == "not_above_delivery":
        table.insert(4, ["", "Other total", "", "0", "0", "500.00"])
    elif case == "missing_delivery":
        table.pop()
    elif case == "wrong_header":
        table[0][-1] = "Credit (Rs.)"
    else:
        table[3].pop()
    with pytest.raises(PortalError):
        parse(table_rows=table)


@pytest.mark.parametrize("text", [
    REPORT.replace("999999", "888888"),
    REPORT + " Customer:- ANOTHER OUTLET (888888)",
    REPORT.replace("To 13-Oct", "To 12-Oct"),
    REPORT.replace("From 12-Oct", "From 01-Oct"),
    REPORT.replace("6:59:04 AM", "6:00:04 AM"),
    REPORT.replace("6:59:04 AM", "7:05:04 AM"),
    REPORT.replace("Report Generated Date/Time", "Unknown timestamp"),
    REPORT + " From 11-Oct-2026 To 13-Oct-2026",
])
def test_rejects_wrong_account_period_or_stale_report(text):
    with pytest.raises(PortalError):
        parse(text)


def test_sync_only_writes_changes_and_reads_back_saved_balance():
    storage, calls = {}, []

    def transport(method, url, key, path, body=None):
        calls.append((method, path))
        if path.startswith("pay_credit_opening?"):
            return []
        if method == "POST":
            record = body[0]
            assert path == "pay_credit_balances?on_conflict=id"
            if record["id"] in storage:
                return []
            storage[record["id"]] = record
            return body
        if "order=" not in path:
            assert "id=eq.iocl-pad-" in path
        return [next(reversed(storage.values()))] if storage else []

    balance = parse()
    cfg = ("https://payments.example", "test-key")
    assert save_balance(balance, config=cfg, transport=transport) == "saved"
    assert save_balance(balance, config=cfg, transport=transport) == "unchanged"
    assert len(storage) == 1
    # A new report timestamp alone must not add a duplicate balance.
    newer = replace(balance, generated_at=balance.generated_at + timedelta(minutes=30))
    assert save_balance(newer, config=cfg, transport=transport) == "unchanged"
    assert len(storage) == 1
    changed = replace(newer, sign="DR")
    assert save_balance(changed, config=cfg, transport=transport) == "saved"
    assert len(storage) == 2
    changed_again = replace(changed, amount=Decimal("14000.00"),
                            generated_at=changed.generated_at + timedelta(minutes=10))
    assert save_balance(changed_again, config=cfg, transport=transport) == "saved"
    assert len(storage) == 3
    assert len([method for method, _ in calls if method == "POST"]) == 3


@pytest.mark.parametrize(("field", "value"), [
    ("id", "wrong-id"), ("amount", "14500.00"), ("sign", "DR"),
    ("at", "2026-10-13T02:00:00Z"), ("amount", "NaN"),
])
def test_sync_fails_if_payments_readback_does_not_match(field, value):
    balance = parse()
    wrong = {**balance.row(), field: value}
    def transport(method, url, key, path, body=None):
        if method == "POST":
            return body
        return [wrong] if "id=eq." in path else []
    with pytest.raises(PortalError, match="matching balance"):
        save_balance(balance, config=("https://payments.example", "key"), transport=transport)


def test_same_balance_as_latest_opening_does_not_add_snapshot():
    balance = parse()
    opening = {"day": balance.to_date.isoformat(), "amount": "15000", "sign": "CR"}
    # Yesterday's snapshot differs, but the newer opening is authoritative.
    older = replace(balance, amount=Decimal("10000"), generated_at=NOW - timedelta(days=1)).row()
    def transport(method, url, key, path, body=None):
        assert method == "GET"
        return [opening] if path.startswith("pay_credit_opening?") else [older]
    assert save_balance(balance, config=("https://payments.example", "key"), transport=transport) == "unchanged"


def test_newer_payment_observation_is_not_replaced_by_older_report():
    balance = parse()
    newer = replace(balance, amount=Decimal("100"), generated_at=NOW + timedelta(minutes=5)).row()
    def transport(method, url, key, path, body=None):
        assert method == "GET"
        return [] if path.startswith("pay_credit_opening?") else [newer]
    with pytest.raises(PortalError, match="newer observation"):
        save_balance(balance, config=("https://payments.example", "key"), transport=transport)


def test_daily_opening_is_saved_for_ist_day_once_and_manual_changes_survive():
    observed = NOW.replace(hour=0, minute=30)
    balance = replace(parse(), generated_at=observed)
    saved, writes = [], []
    def transport(method, url, key, path, body=None):
        assert path.startswith("pay_credit_opening?")
        if method == "POST":
            assert path.endswith("on_conflict=day")
            writes.append(body[0])
            saved[:] = body
        return saved
    cfg = ("https://payments.example", "key")
    assert save_opening(balance, config=cfg, transport=transport) == "opening_saved"
    assert writes[0] == {"day": "2026-10-13", "amount": "15000.00", "sign": "CR",
                         "updated_at": "2026-10-13T00:30:00+05:30"}
    assert save_opening(balance, config=cfg, transport=transport) == "opening_exists"
    saved[0]["amount"] = "12345.00"  # manual correction in the app
    assert save_opening(balance, config=cfg, transport=transport) == "opening_exists"
    assert saved[0]["amount"] == "12345.00" and len(writes) == 1


@pytest.mark.parametrize(("hour", "minute"), [(0, 0), (0, 29), (2, 0), (12, 30)])
def test_opening_cannot_be_taken_at_wrong_time(hour, minute):
    balance = replace(parse(), generated_at=NOW.replace(hour=hour, minute=minute))
    def no_network(*args):
        pytest.fail("Out-of-window opening must stop before database calls")
    with pytest.raises(PortalError, match="outside 00:30"):
        save_opening(balance, config=("https://payments.example", "key"), transport=no_network)


def test_payments_config_reuses_app_connection_and_rejects_partial_override(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    url, key = payments_config()
    assert url.startswith("https://") and key
    monkeypatch.setenv("SUPABASE_URL", "https://other.example")
    with pytest.raises(PortalError, match="both SUPABASE"):
        payments_config()


def tsv(answer="ABCDEF", confidence="90"):
    return f"level\tconf\ttext\n1\t-1\t\n5\t{confidence}\t{answer}\n"


@pytest.mark.parametrize(("answer", "confidence"), [("ABCDEF", "10"), ("ABC?EF", "99"),
                                                     ("ABCDE", "99"), ("ABCDEF", "bad")])
def test_ocr_rejects_uncertain_or_malformed_reads(answer, confidence):
    assert captcha.ocr_candidate(tsv(answer, confidence)) is None


def test_ocr_requires_agreement_without_sending_images_away(monkeypatch):
    monkeypatch.setattr(captcha.shutil, "which", lambda _: "/usr/bin/tesseract")
    outputs = iter(["ABCDEF", "ABCDEF", "ABCDEX"])
    def run(command, **kwargs):
        assert command[:3] == ["/usr/bin/tesseract", "stdin", "stdout"]
        assert kwargs["input"] == b"synthetic-image"
        return SimpleNamespace(returncode=0, stdout=tsv(next(outputs)).encode())
    monkeypatch.setattr(captcha.subprocess, "run", run)
    assert captcha.solve_text_captcha(b"synthetic-image") == "ABCDEF"
    outputs = iter(["ABCDEF", "ABCDEX", "ABCDEY"])
    with pytest.raises(PortalError, match="No login was submitted"):
        captcha.solve_text_captcha(b"synthetic-image")
