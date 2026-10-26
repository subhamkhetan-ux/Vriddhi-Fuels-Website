"""Synthetic PAD reports only: never keep real statements or login details here."""
from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal
import io
import re
from pathlib import Path
import shutil
from types import SimpleNamespace

import pytest

from iocl_portal import captcha
from iocl_portal.statement import IST, PortalError, other_deductions, parse_statement, signed_amount
from iocl_portal.sync import payments_config, save_balance, save_deductions, save_opening

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
    # (only when the statement couldn't give the day's opening itself)
    balance = replace(parse(), generated_at=NOW.replace(hour=hour, minute=minute), opening=None,
                      opening_why="no single OP.BAL.in Comp Code row")
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


def _png(width=150, height=40):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buf, "PNG")
    return buf.getvalue()


def test_ocr_votes_on_cleaned_images_locally(monkeypatch):
    """Every read uses a cleaned copy of the image and local Tesseract only."""
    monkeypatch.setattr(captcha.shutil, "which", lambda _: "/usr/bin/tesseract")
    assert len(captcha.CLEAN_READS) == 4
    reads = iter(["ABCDEF\n", "ABCDEF", "ABC", "abcdef"])
    def run(command, **kwargs):
        assert command[:3] == ["/usr/bin/tesseract", "stdin", "stdout"]
        assert kwargs["input"].startswith(b"\x89PNG") and kwargs["input"] != original
        assert kwargs["env"]["OMP_THREAD_LIMIT"] == "1"
        return SimpleNamespace(returncode=0, stdout=next(reads).encode())
    original = _png()
    monkeypatch.setattr(captcha.subprocess, "run", run)
    assert captcha.captcha_votes(original) == ["ABCDEF", "ABCDEF"]   # malformed reads dropped
    reads = iter(["ABCDEF"] * 4)
    assert captcha.solve_text_captcha(original) == "ABCDEF"
    reads = iter(["ABCDEF"] * 3 + ["ABCDEX"])
    with pytest.raises(PortalError, match="No login was submitted"):
        captcha.solve_text_captcha(original)


@pytest.mark.parametrize(("votes", "answer"), [
    (["ABCDEF"] * 4, "ABCDEF"),                  # all four reads agree
    (["ABCDEF"] * 3, None),                      # one read failed
    (["ABCDEF"] * 3 + ["ABCDEX"], None),         # one read disagrees
    ([], None),
])
def test_an_answer_needs_every_read_to_agree(votes, answer):
    assert captcha.pick_answer(votes) == answer


def test_unclear_captcha_stops_before_login(monkeypatch):
    monkeypatch.setattr(captcha, "captcha_votes", lambda png, length: ["ABCDEF"] * 3 + ["ABCDEX"] * 3)
    with pytest.raises(PortalError, match="No login was submitted"):
        captcha.solve_text_captcha(_png())


def test_cleaning_keeps_a_valid_enlarged_png():
    from PIL import Image
    out = captcha.clean_captcha(_png(), 4, 240, 13, -0.15)
    image = Image.open(io.BytesIO(out))
    assert image.mode == "L" and image.height == 40 * 4 + 40 and image.width > 150 * 4
    with pytest.raises(PortalError, match="decoded"):
        captcha.clean_captcha(b"not-an-image", 4, 200, 7, 0)

FIXTURES = Path(__file__).parent / "fixtures" / "iocl_captcha"


@pytest.mark.skipif(not shutil.which("tesseract"), reason="needs local Tesseract")
def test_reader_on_hand_labelled_live_captchas():
    """29 real e-Mitra CAPTCHAs, named by their answer. Guards future tuning:
    as tuned, 22 are read, 6 declined (safe) and 1 misread (italic J as I)."""
    samples = sorted(FIXTURES.glob("*.png"))
    assert len(samples) == 29
    results = [captcha.pick_answer(captcha.captcha_votes(p.read_bytes())) for p in samples]
    correct = sum(r == p.stem for r, p in zip(results, samples))
    wrong = [(p.stem, r) for r, p in zip(results, samples) if r and r != p.stem]
    assert correct >= 22 and len(wrong) <= 1, (correct, wrong)


def test_report_check_failures_explain_what_was_seen_without_account_data():
    from iocl_portal import statement
    text = ("Customer PAD Balance Customer:- KHETAN FUELS (999999) Report Generated On : 13/10/2026 14:05:09 "
            "From 12-Oct-2026 To 13-Oct-2026 Closing balance: Rs. -1,23,45,678.00")
    hint = statement._timestamp_hint(re.sub(r"\s+", " ", text))
    assert hint == "Generated On : 13/10/2026 14:05:09"
    rows = [["Item Text", "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"], ["KHETAN FUELS"],
            ["Invoice 9100012345", "1,00,000.00", "0", "-5,00,000.00"]]
    table = statement._table_hint(rows)
    assert "Balance (Rs.)" in table and "KHETAN" not in table and "9100012345" not in table
    assert "row widths [1, 4]" in table


def test_live_timestamp_format_is_read():
    """e-Mitra prints "Report Generated Date/Time:-Tue Oct 13 2026 2:06:11 pm"."""
    live = REPORT.replace("Report Generated Date/Time: Tue Oct 13 2026 6:59:04 AM",
                          "Report Generated Date/Time:-Tue Oct 13 2026 6:59:04 am")
    assert parse(live).generated_at == parse().generated_at


class _Clock:
    """datetime for iocl_portal.run: now() is fixed."""
    def __init__(self, at):
        self.at = at

    def now(self, tz=None):
        return self.at


def _opening_run(monkeypatch, *, started, opening_rows, report_at=None, mode="--opening", **change):
    """Run --opening with a stand-in browser and Payments; -> (exit code, writes, logged in?)."""
    import sys as _sys
    from iocl_portal import run as runmod, sync
    monkeypatch.setenv("IOCL_EMITRA_USERNAME", "user")
    monkeypatch.setenv("IOCL_EMITRA_PASSWORD", "pw")
    monkeypatch.setenv("IOCL_CUSTOMER_CODE", "999999")
    monkeypatch.setattr(runmod, "datetime", _Clock(started))
    monkeypatch.setattr(runmod, "payments_config", lambda: ("https://payments.example", "key"))
    monkeypatch.setattr(runmod, "launch_options", lambda: {})
    balance = replace(parse(), generated_at=report_at or started, **change)
    seen = {"login": False}

    class Portal:
        def __init__(self, page, selectors=None):
            pass

        def open(self):
            pass

        def login(self, *a, **k):
            seen["login"] = True

        def navigate_pad(self):
            pass

        def read_balance(self, customer):
            return balance
    monkeypatch.setattr(runmod, "PortalBrowser", Portal)
    page = SimpleNamespace(new_page=lambda: None, close=lambda: None)
    browser = SimpleNamespace(new_context=lambda **k: page, close=lambda: None)
    pw = SimpleNamespace(chromium=SimpleNamespace(launch=lambda **k: browser))

    class Ctx:
        def __enter__(self):
            return pw

        def __exit__(self, *a):
            return False
    monkeypatch.setitem(_sys.modules, "playwright.sync_api", SimpleNamespace(sync_playwright=Ctx))
    writes, balances = [], {}

    def transport(method, url, key, path, body=None):
        if path.startswith("pay_credit_opening?"):
            if method == "POST":
                writes.append(("opening", body[0]))
                opening_rows[:] = body
            return list(opening_rows)
        if method == "POST":
            writes.append(("balance", body[0]))
            balances[body[0]["id"]] = body[0]
            return body
        return [next(reversed(balances.values()))] if balances else []
    # (their transport is bound when they're defined: hand it in)
    monkeypatch.setattr(runmod, "save_balance", lambda b, config: sync.save_balance(b, config=config, transport=transport))
    monkeypatch.setattr(runmod, "save_opening", lambda b, config: sync.save_opening(b, config=config, transport=transport))
    monkeypatch.setattr(runmod, "opening_saved", lambda day, config: sync.opening_saved(day, config=config, transport=transport))
    monkeypatch.setattr(runmod, "save_deductions", lambda b, config: 0)
    return runmod.main([mode]), writes, seen["login"]


def test_a_late_opening_run_takes_the_opening_from_the_statement(monkeypatch, capsys):
    late = NOW.replace(hour=4, minute=39)
    code, writes, logged_in = _opening_run(monkeypatch, started=late, opening_rows=[])
    assert code == 0 and logged_in
    assert writes[0][0] == "opening" and writes[0][1]["day"] == "2026-10-13"
    assert (writes[0][1]["amount"], writes[0][1]["sign"]) == ("15000.00", "CR")
    assert "opening saved from the statement" in capsys.readouterr().out


def test_a_late_opening_run_without_a_provable_opening_saves_the_balance_and_says_why(monkeypatch, capsys):
    late = NOW.replace(hour=4, minute=39)
    code, writes, logged_in = _opening_run(monkeypatch, started=late, opening_rows=[], opening=None,
                                           opening_why="the running balance doesn't add up entry by entry")
    assert code == 1 and logged_in
    assert [w[0] for w in writes] == ["balance"]            # no opening, but the balance is saved
    err = capsys.readouterr().err
    assert "started at 04:39 IST, after the 00:30–02:00 window" in err and "GitHub started the scheduled run late" in err
    assert "balance was still checked: saved" in err and "doesn't add up entry by entry" in err


def test_an_ordinary_check_fills_in_a_missing_opening(monkeypatch, capsys):
    midday = NOW.replace(hour=13, minute=7)
    code, writes, _ = _opening_run(monkeypatch, started=midday, opening_rows=[], mode="--sync")
    assert code == 0 and writes[0][0] == "opening"
    # and says nothing about it when the opening is already there
    saved = [dict(writes[0][1])]
    code, writes, _ = _opening_run(monkeypatch, started=midday, opening_rows=saved, mode="--sync")
    assert code == 0 and writes == []
    assert capsys.readouterr().out.splitlines()[-1] == "PASS: IOCL PAD check completed: unchanged."
    # without a provable opening, an ordinary check doesn't fail over it
    code, writes, _ = _opening_run(monkeypatch, started=midday, opening_rows=[], mode="--sync", opening=None)
    assert code == 0 and [w[0] for w in writes] == ["balance"]


def test_a_later_try_finds_the_opening_saved_and_doesnt_log_in(monkeypatch, capsys):
    on_time = NOW.replace(hour=1, minute=13)
    saved = [{"day": "2026-10-13", "amount": "15000.00", "sign": "CR", "updated_at": "2026-10-13T00:33:10+05:30"}]
    code, writes, logged_in = _opening_run(monkeypatch, started=on_time, opening_rows=saved)
    assert code == 0 and not logged_in and writes == []
    assert "already saved" in capsys.readouterr().out


def test_an_opening_run_in_the_window_saves_both(monkeypatch, capsys):
    on_time = NOW.replace(hour=0, minute=33)
    code, writes, logged_in = _opening_run(monkeypatch, started=on_time, opening_rows=[])
    assert code == 0 and logged_in and [w[0] for w in writes] == ["opening"]
    # (the new opening is the latest balance the Credit tab shows: no snapshot needed)
    assert "opening saved from the statement; balance unchanged" in capsys.readouterr().out


def test_a_late_run_after_an_earlier_try_saved_the_opening_passes(monkeypatch):
    late = NOW.replace(hour=1, minute=59, second=50)
    saved = [{"day": "2026-10-13", "amount": "15000.00", "sign": "CR", "updated_at": "2026-10-13T00:33:10+05:30"}]
    # started in the window, but the report came after 02:00
    code, writes, _ = _opening_run(monkeypatch, started=late, opening_rows=[], opening=None,
                                   report_at=NOW.replace(hour=2, minute=0, second=30))
    assert code == 1                                         # nothing saved it: a real miss
    code, writes, _ = _opening_run(monkeypatch, started=NOW.replace(hour=4), opening_rows=saved, opening=None)
    assert code == 0 and writes == []                       # (the balance is the opening's: unchanged)


def test_the_opening_is_tried_four_times_inside_its_window():
    import yaml
    wf = yaml.safe_load((Path(__file__).resolve().parents[1] / ".github/workflows/iocl-pad-balance.yml").read_text())
    crons = [c["cron"] for c in wf[True]["schedule"]]
    opening = [c for c in crons if c != "7 */3 * * *"]
    assert len(opening) == 4
    for c in opening:
        minute, hour = map(int, c.split()[:2])
        ist = (hour * 60 + minute + 330) % 1440
        assert 30 <= ist < 120 and minute != 0, c             # 00:30–02:00 IST, never on the hour
    step = next(s for s in wf["jobs"]["balance"]["steps"] if s.get("name", "").startswith("Read company-code"))
    assert "github.event.schedule != '7 */3 * * *' && 'opening'" in step["env"]["IOCL_MODE"]


def statement(entries, closing):
    """A yesterday (12.10) to today (13.10) table: OP.BAL 10,000 DR, the entries, CL.BAL."""
    return ([["Plant", "Item Text", "Date", "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"],
             ["", "OP.BAL.in Comp Code:", "12.10.26", "0", "0", "10000.00"]]
            + [["", text, day, dr, cr, bal] for text, day, dr, cr, bal in entries]
            + [["", "CL.BAL.in Comp Code:", "13.10.26", "0", "0", closing],
               ["", "Open Delivery value in all CCA:", "", "0", "0", "500.00"]])


@pytest.mark.parametrize(("entries", "closing", "opening"), [
    # entries yesterday only: today's opening is the CL.BAL figure
    ([("Customer collection", "12.10.26", "0", "25000.00", "-15000.00")], "-15000.00", Decimal("-15000.00")),
    # entries today too: the balance after yesterday's last entry
    ([("Customer collection", "12.10.26", "0", "25000.00", "-15000.00"),
      ("Invoice", "13.10.26", "8000.00", "0", "-7000.00")], "-7000.00", Decimal("-15000.00")),
    # nothing yesterday, entries today: yesterday's OP.BAL carried over
    ([("Invoice", "13.10.26", "8000.00", "", "18000.00")], "18000.00", Decimal("10000.00")),
    # nothing at all
    ([], "10000.00", Decimal("10000.00")),
])
def test_todays_opening_is_the_balance_after_yesterdays_last_entry(entries, closing, opening):
    b = parse(table_rows=statement(entries, closing))
    assert b.opening == opening and b.opening_why == ""


@pytest.mark.parametrize(("entries", "closing", "why"), [
    ([("Customer collection", "12.10.26", "0", "25000.00", "-14000.00")], "-14000.00", "doesn't add up entry by entry"),
    ([("Invoice", "13.10.26", "8000.00", "0", "18000.00"), ("Collection", "12.10.26", "0", "1000.00", "17000.00")],
     "17000.00", "aren't in date order"),
    ([("Invoice", "11.10.26", "8000.00", "0", "18000.00")], "18000.00", "isn't yesterday or today"),
    ([("Invoice", "13.10.26", "8000.00", "0", "18000.00")], "18500.00", "don't add up to CL.BAL"),
])
def test_an_opening_the_statement_doesnt_prove_is_not_used(entries, closing, why):
    b = parse(table_rows=statement(entries, closing))
    assert b.opening is None and why in b.opening_why
    assert b.amount == abs(Decimal(closing))                   # (the balance itself is still read)


def test_without_its_columns_or_op_bal_row_the_statement_gives_no_opening():
    no_op = [r for r in statement([], "10000.00") if not r[1].startswith("OP.BAL")]
    no_op.insert(1, ["", "Something", "12.10.26", "0", "0", "10000.00"])
    assert "OP.BAL" in parse(table_rows=no_op).opening_why
    odd = statement([], "10000.00")
    odd[0] = ["Plant", "Item Text", "When", "Amount 1", "Amount 2", "Balance (Rs.)"]
    assert "columns weren't recognised" in parse(table_rows=odd).opening_why


def test_an_opening_from_the_night_reading_says_why_the_statement_didnt_give_it(monkeypatch, capsys):
    code, writes, _ = _opening_run(monkeypatch, started=NOW.replace(hour=0, minute=33), opening_rows=[],
                                   opening=None, opening_why="no single OP.BAL.in Comp Code row")
    assert code == 0 and writes[0][0] == "opening"
    out = capsys.readouterr().out
    assert "from the 00:30-02:00 reading (the statement didn't prove it: no single OP.BAL.in Comp Code row)" in out
    assert "15000" not in out                                   # no amounts in the public log


# The live layout: Plant, Item Text, Document Type, Document Number, Date,
# Material Group, Quantity, Unit, Debit, Credit, Balance. A same-day payment
# (4,227,703.50) is larger than the licence fee, so the balance alone can't show it.
LEDGER_HEADER = ["Plant", "Item Text", "Document Type", "Document Number", "Date", "Material Group",
                 "Quantity", "Unit", "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"]


def ledger():
    def e(plant, text, kind, doc, dr, cr, bal, day="13.10.26"):
        return [plant, text, kind, doc, day, "BULK-HSD" if plant else "", "22.000" if plant else "",
                "KL" if plant else "", dr, cr, bal]
    return [LEDGER_HEADER,
            ["", "OP.BAL.in Comp Code:", "", "", "13.10.26", "", "", "", "0", "0", "7887000.77"],
            e("", "HDFC261026 HDFC0000240_502001", "Customer ECollection", "", "0", "4200000.00", "3687000.77"),
            e("Test Terminal", "7012322266 ': LICENSE FEE (SSLF) RECOVERY", "Billing doc.transfer",
              "7012322266 ': LICENSE FEE (SSLF) RECOVERY", "284138.27", "0", "3971139.04"),
            e("Test Terminal", "7012342781 ': PRODUCT SUPPLY INVOICE - SALES", "Billing doc.transfer",
              "7012342781 ': PRODUCT SUPPLY INVOICE - SALES", "2159219.00", "0", "6130358.04"),
            e("", "4000484887-0003703 20261026002847", "Fleet- Card Posting", "", "0", "27703.50", "6102654.54"),
            ["", "CL.BAL.in Comp Code:", "", "", "13.10.26", "", "", "", "0", "0", "6102654.54"],
            ["", "Open Delivery value in all CCA :", "", "", "", "", "", "", "0", "0", "4322.50"]]


def test_the_ledger_marks_a_licence_fee_hidden_by_a_same_day_payment():
    b = parse(table_rows=ledger())
    assert b.amount == Decimal("6102654.54") and b.opening == Decimal("7887000.77")
    rows = other_deductions(b)
    assert len(rows) == 1                                        # the invoice and the credits are not deductions
    assert rows[0]["amount"] == "284138.27" and rows[0]["at"] == "2026-10-13T12:00:00+05:30"
    assert rows[0]["reason"] == "LICENSE FEE (SSLF) RECOVERY (PAD doc 7012322266)"
    assert rows[0]["id"].startswith("iocl-ded-") and other_deductions(parse(table_rows=ledger())) == rows
    # a debit whose document is a known invoice is never a deduction
    assert other_deductions(b, frozenset({"7012322266"})) == []


def test_an_unproved_statement_marks_no_deductions():
    bad = ledger()
    bad[3][-1] = "3971139.05"                                    # running balance off by a paisa
    b = parse(table_rows=bad)
    assert b.opening is None and other_deductions(b) == []


def _deduction_store(invoices=(), existing=()):
    store, calls = {r["id"]: dict(r) for r in existing}, []

    def transport(method, url, key, path, body=None):
        calls.append((method, path))
        if path.startswith("pay_fuel_invoices?"):
            return [{"invoice_no": n} for n in invoices]
        if method == "POST":
            for r in body:
                store.setdefault(r["id"], dict(r))
            return body
        if "id=in." in path:
            return [r for r in store.values() if r["id"] in path]
        return list(store.values())
    return store, calls, transport


def test_deductions_are_saved_once_and_read_back():
    b = parse(table_rows=ledger())
    store, calls, transport = _deduction_store()
    assert save_deductions(b, config=("https://p", "k"), transport=transport) == 1
    (row,) = store.values()
    assert row["reason"].startswith("LICENSE FEE (SSLF) RECOVERY") and row["amount"] == "284138.27"
    assert save_deductions(b, config=("https://p", "k"), transport=transport) == 0     # rerun: no duplicate
    assert [c for c in calls if c[0] == "POST"] == [("POST", "pay_other_deductions?on_conflict=id")]


def test_a_deduction_already_confirmed_by_hand_or_an_invoice_is_not_added():
    b = parse(table_rows=ledger())
    hand = {"id": "manual-1", "at": "2026-10-13T06:30:00+00:00", "amount": 284138.27}
    store, calls, transport = _deduction_store(existing=[hand])
    assert save_deductions(b, config=("https://p", "k"), transport=transport) == 0 and len(store) == 1
    store, calls, transport = _deduction_store(invoices=["7012322266"])
    assert save_deductions(b, config=("https://p", "k"), transport=transport) == 0 and not store


def test_no_debits_means_no_payments_request():
    def no_network(*a, **k):
        raise AssertionError("no request expected")
    assert save_deductions(parse(), config=("https://p", "k"), transport=no_network) == 0
