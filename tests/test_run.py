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
