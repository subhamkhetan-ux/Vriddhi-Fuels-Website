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
