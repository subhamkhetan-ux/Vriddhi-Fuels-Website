"""Cloud-ingest tests. Gmail is mocked; everything else is the real pipeline."""

import agent.gmail_client as gmail_client
from agent import run, state_store
from agent.gmail_client import Alert

CUSTOMERS = ["DBL Siarmal Coal Mines Private Limited", "Reliance Petro Marketing"]


def _hdfc_credit(payer, amount="41,97,180.00", acct="XX1010", msg="m1", ms=1_700_000_000_000):
    body = (
        "You have received a credit in your HDFC Bank account.\n"
        f"Amount received: INR {amount}\n"
        f"Account: {acct}\nDate: 25-AUG-2026\n"
        f"Reference Details: RTGS Cr-SBIN0018956-{payer}-VRIDDHI FUELS-SBINR52026"
    )
    return Alert(msg_id=msg, internal_ms=ms, subject="You have received a credit", body=body)


MATCH = _hdfc_credit("DBL SIARMAL COAL MINES PRIVATE LIM", msg="m-match", ms=1_700_000_000_000)
UNKNOWN = _hdfc_credit("TOTALLY UNKNOWN PARTY PRIVATE LIM", amount="9,000.00",
                       msg="m-unknown", ms=1_700_000_100_000)
DEBIT = Alert(msg_id="m-debit", internal_ms=1_700_000_200_000, subject="debit alert",
              body="Rs. 500.00 has been debited from your HDFC Bank account XX1010.")
OTHER_ACCT = _hdfc_credit("SOME OTHER PARTY", acct="XX2542", msg="m-2542", ms=1_700_000_300_000)


def _seed(tmp_path, monkeypatch):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    for name in ("QUEUE_PATH", "SEEN_PATH", "ALIASES_PATH", "CUSTOMERS_PATH"):
        monkeypatch.setattr(state_store, name,
                            str(state_dir / (name.split("_")[0].lower() + ".json")))
    monkeypatch.setattr(run, "HISTORY_PATH", str(state_dir / "history.json"))
    state_store.save_customers(CUSTOMERS)
    state_store.save_aliases({})
    monkeypatch.setenv("GMAIL_TOKEN_BANK2", '{"fake":"token"}')


def _account():
    from agent.config import HDFC
    return {"id": "bank2", "profile": HDFC, "token_env": "GMAIL_TOKEN_BANK2"}


def _mock_gmail(monkeypatch, alerts):
    monkeypatch.setattr(gmail_client, "build_service", lambda token: object())
    monkeypatch.setattr(gmail_client, "fetch_alerts",
                        lambda svc, q, after, seen, **k: alerts)


def test_ingest_matches_and_reviews(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    _mock_gmail(monkeypatch, [MATCH, UNKNOWN])
    queue, seen = [], {}
    q, r = run.process_account(_account(), CUSTOMERS, {}, {}, queue, seen)
    assert (q, r) == (2, 1)

    by_id = {row["gmail_msg_id"]: row for row in queue}
    assert by_id["m-match"]["status"] == "matched"
    assert by_id["m-match"]["customer"] == "DBL Siarmal Coal Mines Private Limited"
    assert by_id["m-match"]["mode"] == "HDFC 1010"
    assert by_id["m-unknown"]["status"] == "review"
    assert by_id["m-unknown"]["customer"] is None


def test_debit_and_other_account_ignored(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    _mock_gmail(monkeypatch, [MATCH, DEBIT, OTHER_ACCT])
    queue, seen = [], {}
    q, r = run.process_account(_account(), CUSTOMERS, {}, {}, queue, seen)
    assert (q, r) == (1, 0)                 # only the 1010 credit queued
    assert len(queue) == 1
    assert queue[0]["gmail_msg_id"] == "m-match"
    # ...but the mark still advanced past the ignored ones, so they never recur
    assert seen["bank2"]["high_water"] == OTHER_ACCT.internal_ms


def test_ingest_is_idempotent(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    _mock_gmail(monkeypatch, [MATCH, UNKNOWN])
    queue, seen = [], {}
    run.process_account(_account(), CUSTOMERS, {}, {}, queue, seen)
    q2, r2 = run.process_account(_account(), CUSTOMERS, {}, {}, queue, seen)
    assert (q2, r2) == (0, 0)
    assert len(queue) == 2


def test_alias_makes_unknown_auto_match(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    from agent.matcher import alias_key
    aliases = {alias_key("TOTALLY UNKNOWN PARTY PRIVATE LIM"): "Reliance Petro Marketing"}
    _mock_gmail(monkeypatch, [UNKNOWN])
    queue, seen = [], {}
    run.process_account(_account(), CUSTOMERS, aliases, {}, queue, seen)
    assert queue[0]["status"] == "matched"
    assert queue[0]["customer"] == "Reliance Petro Marketing"
    assert queue[0]["match_tier"] == "alias"


def test_outlier_amount_downgraded_to_review(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    from agent.normalize import norm
    history = {norm("DBL Siarmal Coal Mines Private Limited"): [1000, 1200, 1100, 900]}
    _mock_gmail(monkeypatch, [MATCH])       # ~4.2M vs a ~1100 history
    queue, seen = [], {}
    run.process_account(_account(), CUSTOMERS, {}, history, queue, seen)
    assert queue[0]["status"] == "review"
    assert queue[0]["flags"]["outlier"] is True


# ---- transfers between our own accounts (e.g. ICICI 5893 -> 4716) are dropped ----
from agent.config import ICICI  # noqa: E402


def _icici_credit(info, acct="XX716"):
    return Alert(msg_id="m-icici", internal_ms=1_700_000_400_000, subject="Account credited",
                 body=("Dear Customer,\nGreetings from ICICI Bank.\n"
                       f"Your ICICI Bank Account {acct} has been credited with Rs. 5,00,000.00 on "
                       f"10-Nov-26. Info: {info}."))


def _row(alert, profile=ICICI, customers=None, aliases=None):
    return run._row_from_alert("bank1", profile, alert,
                               customers or CUSTOMERS + ["DG VRIDDHI FUELS", "VRIDDHI FUELS CAR"],
                               aliases or {}, {})


def test_credit_from_our_own_firm_is_dropped():
    for info in ["NEFT-ICICN52026111000123-VRIDDHI FUELS",
                 "IMPS-631412345678-M/S VRIDDHI FUELS",
                 "RTGS-ICICR52026111000999-VRIDDHI FUELS PROP"]:
        assert _row(_icici_credit(info)) is None, info


def test_own_transfer_dropped_even_with_a_learned_alias():
    # a name once resolved by hand must not bring own transfers back
    assert _row(_icici_credit("NEFT-ICICN52026111000123-VRIDDHI FUELS"),
                aliases={"vriddhi fuels": "DG VRIDDHI FUELS"}) is None


def test_credit_naming_account_5893_in_info_is_dropped():
    assert _row(_icici_credit("INF/INFT/038912345678/XXXXXXXX5893/Fund transfer")) is None


def test_customers_with_our_name_in_theirs_still_count():
    row = _row(_icici_credit("NEFT-SBIN52026111000123-DG VRIDDHI FUELS"))
    assert row is not None and row["customer"] == "DG VRIDDHI FUELS"


def test_hdfc_rtgs_naming_us_as_beneficiary_still_counts():
    # every HDFC RTGS reference reads "...-<REMITTER>-VRIDDHI FUELS-<UTR>"
    from agent.config import HDFC
    row = _row(MATCH, profile=HDFC)
    assert row is not None and row["status"] == "matched"


def test_an_info_number_merely_ending_5893_unmasked_still_counts():
    row = _row(_icici_credit("RTGS-CNRBR52026111069875893-DBL SIARMAL COAL MINES PRIVATE LIM"))
    assert row is not None and row["status"] == "matched"


# The real alert for a transfer from ICICI 5893 into 4716 (11-Nov-26): ICICI's
# internal-transfer Info format. Its payer used to be unreadable -> a parse error.
REAL_5893_TRANSFER = Alert(
    msg_id="m-inft", internal_ms=1_700_000_500_000, subject="Account credited",
    body=("Dear Customer,\n\nGreetings from ICICI Bank.\n\n"
          "Your ICICI Bank Account XX716 has been credited with Rs. 25,00,000.00 on 11-Nov-26. "
          "Info: INF*INFT*046676550281*VRIDDHI FUELS."))


def test_real_inft_transfer_from_our_own_account_is_dropped():
    assert _row(REAL_5893_TRANSFER) is None


def test_inft_credit_from_a_customer_is_read_and_matched():
    for info in ["INF*INFT*046676550281*RELIANCE PETRO MARKETING",
                 "INF*INFT*046528602791*DIESEL*RELIANCE PETRO MARKETING",   # payer's remark first
                 "INF/INFT/046676550281/RELIANCE PETRO MARKETING",
                 "INF/INFT/046528602791/DIESEL/RELIANCE PETRO MARKETING",
                 "MMT*IMPS*631412345678*RELIANCE PETRO MARKETING"]:
        row = _row(_icici_credit(info))
        assert row is not None and row["match_tier"] != "parse_error", info
        assert row["raw_payer"].strip() == "RELIANCE PETRO MARKETING", info
        assert row["customer"] == "Reliance Petro Marketing" and row["status"] == "matched", info


def test_inft_with_a_remark_and_our_name_last_is_still_our_own():
    assert _row(_icici_credit("INF*INFT*046676550281*FUND TRANSFER*VRIDDHI FUELS")) is None


def test_bill_pay_inft_with_no_name_stays_for_review():
    row = _row(_icici_credit("BIL*INFT*FHU0853112*"))
    assert row is not None and row["status"] == "review"


# ---- reading the payer from any field of the details (new wordings) ----
SCAN_CUSTOMERS = CUSTOMERS + ["Orissa Metaliks Private Limited", "Ekdant Logistic", "DG VRIDDHI FUELS"]


def _scan(info, aliases=None, past=None, amount="11,92,806.00"):
    alert = Alert(msg_id="m-scan", internal_ms=1_700_000_600_000, subject="Account credited",
                  body=("Dear Customer,\nGreetings from ICICI Bank.\n"
                        f"Your ICICI Bank Account XX716 has been credited with Rs. {amount} on "
                        f"11-Nov-26. Info: {info}."))
    return run._row_from_alert("bank1", ICICI, alert, SCAN_CUSTOMERS, aliases or {}, {}, past)


def test_the_reported_alert_matches_the_customer():
    row = _scan("INF*INFT*046675779021*DIESEL*ORISSA METALIKS")
    assert row["status"] == "matched" and row["customer"] == "Orissa Metaliks Private Limited"


def test_a_wording_no_pattern_knows_is_read_from_its_fields():
    for info in ["XYZ*PAYMENT*ORISSA METALIKS*REF 1234",          # name in the middle
                 "TRF FROM ORISSA METALIKS PVT LTD AC XXXX1234",    # name inside a phrase
                 "NEFT CR ICIC0001234 EKDANT LOGIS"]:               # the bank cut it short
        row = _scan(info)
        assert row["status"] == "matched", (info, row)
        assert row["match_tier"] == "info_scan"
    assert _scan("TRF FROM ORISSA METALIKS PVT LTD AC XXXX1234")["customer"] == "Orissa Metaliks Private Limited"


def test_a_name_resolved_before_is_found_in_any_field():
    row = _scan("ABC*XFER*99887766*OML STEEL", aliases={"oml steel": "Orissa Metaliks Private Limited"})
    assert row["status"] == "matched" and row["customer"] == "Orissa Metaliks Private Limited"


def test_a_lone_remark_word_never_names_a_customer():
    # "COAL" occurs only in "DBL Siarmal Coal Mines…" — still not proof
    row = _scan("INF*INFT*046675779021*COAL*SOMEONE NEW")
    assert row["status"] == "review" and row["customer"] is None


def test_two_customers_named_is_left_for_review():
    row = _scan("XYZ*ORISSA METALIKS*EKDANT LOGISTIC")
    assert row["status"] == "review" and {"Orissa Metaliks Private Limited", "Ekdant Logistic"} <= set(row["candidates"])


def test_unknown_name_but_a_regular_amount_is_suggested_not_matched():
    past = run.past_amounts([{"status": "matched", "customer": "Orissa Metaliks Private Limited", "amount": 1192806.0}] * 3)
    row = _scan("INF*INFT*046675779021*NEW TRADE NAME", past=past)
    assert row["status"] == "review" and row["customer"] is None
    assert row["candidates"][0] == "Orissa Metaliks Private Limited"
    assert row["flags"]["amount_hint"] == "Orissa Metaliks Private Limited"
    # an amount two customers have paid suggests neither
    past2 = run.past_amounts([{"status": "matched", "customer": c, "amount": 1192806.0}
                              for c in ["Orissa Metaliks Private Limited", "Ekdant Logistic"]])
    assert "amount_hint" not in _scan("INF*INFT*046675779021*NEW TRADE NAME", past=past2)["flags"]


def test_an_unreadable_payer_with_amount_and_date_is_a_review_row_not_a_parse_error():
    row = _scan("BIL*INFT*FHU0853112*")
    assert row["status"] == "review" and row["match_tier"] != "parse_error"
    assert row["amount"] == 1192806.0 and row["raw_text"]


def test_hdfc_rtgs_still_matches_by_its_pattern():
    from agent.config import HDFC
    row = run._row_from_alert("bank2", HDFC, MATCH, SCAN_CUSTOMERS, {}, {}, None)
    assert row["status"] == "matched" and row["match_tier"] != "info_scan"


def test_transaction_codes_dont_make_suggestions():
    # "BIL" sits inside "Automo-BIL-e": a code, not a name
    alert = Alert(msg_id="m-bil", internal_ms=1_700_000_700_000, subject="Account credited",
                  body=("Your ICICI Bank Account XX716 has been credited with Rs. 13,000.00 on "
                        "26-Aug-26. Info: BIL*INFT*FHU0853112*."))
    row = run._row_from_alert("bank1", ICICI, alert, SCAN_CUSTOMERS + ["MA Automobile"], {}, {}, None)
    assert "MA Automobile" not in row["candidates"]


def test_a_payer_set_to_always_ignore_is_dropped():
    from agent.matcher import IGNORE_ALIAS
    alert = Alert(msg_id="m-ign", internal_ms=1_700_000_800_000, subject="You have received a credit",
                  body=("You have received a credit in your HDFC Bank account.\nAmount received: INR 15,805.00\n"
                        "Account: XX1010\nDate: 19-AUG-2026\n"
                        "Reference Details: NEFT Cr-RBIS0GOOR01-ODISHA SARKAR-VRIDDHI FUELS-RBI123"))
    from agent.config import HDFC
    assert run._row_from_alert("bank2", HDFC, alert, SCAN_CUSTOMERS, {"odisha sarkar": IGNORE_ALIAS}, {}) is None
    row = run._row_from_alert("bank2", HDFC, alert, SCAN_CUSTOMERS, {}, {})
    assert row is not None and row["status"] == "review"           # without the setting: for review


def test_suggestions_put_the_ledger_paid_before_first():
    cust = SCAN_CUSTOMERS + ["Sunil Kumar Khetan Transaction", "Sunil Kumar Khetan-Debtors"]
    alert = _icici_credit("NEFT-HDFCN52026102300123-SUNIL KUMAR KHETAN")
    counts = run.payment_counts([{"status": "matched", "customer": "Sunil Kumar Khetan-Debtors"}] * 3)
    row = run._row_from_alert("bank1", ICICI, alert, cust, {}, {}, None, counts)
    assert row["status"] == "review" and row["candidates"][0] == "Sunil Kumar Khetan-Debtors"
