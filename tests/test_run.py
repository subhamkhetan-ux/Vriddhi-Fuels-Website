"""Cloud-ingest tests. Gmail is mocked; everything else is the real pipeline."""

import agent.gmail_client as gmail_client
from agent import run, state_store
from agent.gmail_client import Alert

CUSTOMERS = ["Sudarshan Minerals And Logistics", "Reliance Petro Marketing"]

HDFC_MATCH = Alert(
    msg_id="m-hdfc-1",
    internal_ms=1_700_000_000_000,
    subject="Credit alert",
    body=("Rs. 1,25,000.00 is credited to your account XX1234 on 15-06-2025 "
          "by M/S SUDARSHAN MINERALS AND LOG Ref no NEFT CIT123."),
)
HDFC_UNKNOWN = Alert(
    msg_id="m-hdfc-2",
    internal_ms=1_700_000_100_000,
    subject="Credit alert",
    body=("Rs. 9,000.00 is credited to your account XX1234 on 16-06-2025 "
          "by M/S TOTALLY UNKNOWN PARTY Ref no NEFT CIT999."),
)


def _seed(tmp_path, monkeypatch):
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    for name in ("QUEUE_PATH", "SEEN_PATH", "ALIASES_PATH", "CUSTOMERS_PATH"):
        monkeypatch.setattr(state_store, name,
                            str(state_dir / (name.split("_")[0].lower() + ".json")))
    monkeypatch.setattr(run, "HISTORY_PATH", str(state_dir / "history.json"))
    state_store.save_customers(CUSTOMERS)
    state_store.save_aliases({})
    monkeypatch.setenv("GMAIL_TOKEN_BANK1", '{"fake":"token"}')


def _account():
    from agent.config import HDFC
    return {"id": "bank1", "profile": HDFC, "token_env": "GMAIL_TOKEN_BANK1"}


def test_ingest_matches_and_reviews(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    monkeypatch.setattr(gmail_client, "build_service", lambda token: object())
    monkeypatch.setattr(gmail_client, "fetch_alerts",
                        lambda svc, q, after, seen, **k: [HDFC_MATCH, HDFC_UNKNOWN])

    queue, seen = [], {}
    q, r = run.process_account(_account(), CUSTOMERS, {}, {}, queue, seen)
    assert (q, r) == (2, 1)

    by_id = {row["gmail_msg_id"]: row for row in queue}
    assert by_id["m-hdfc-1"]["status"] == "matched"
    assert by_id["m-hdfc-1"]["customer"] == "Sudarshan Minerals And Logistics"
    assert by_id["m-hdfc-2"]["status"] == "review"
    assert by_id["m-hdfc-2"]["customer"] is None
    # high-water mark advanced to the newest alert
    assert seen["bank1"]["high_water"] == HDFC_UNKNOWN.internal_ms


def test_ingest_is_idempotent(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    monkeypatch.setattr(gmail_client, "build_service", lambda token: object())
    monkeypatch.setattr(gmail_client, "fetch_alerts",
                        lambda svc, q, after, seen, **k: [HDFC_MATCH, HDFC_UNKNOWN])

    queue, seen = [], {}
    run.process_account(_account(), CUSTOMERS, {}, {}, queue, seen)
    # same alerts re-delivered: no new rows, mark unchanged
    q2, r2 = run.process_account(_account(), CUSTOMERS, {}, {}, queue, seen)
    assert (q2, r2) == (0, 0)
    assert len(queue) == 2


def test_alias_makes_unknown_auto_match(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    from agent.matcher import alias_key
    aliases = {alias_key("M/S TOTALLY UNKNOWN PARTY"): "Reliance Petro Marketing"}
    monkeypatch.setattr(gmail_client, "build_service", lambda token: object())
    monkeypatch.setattr(gmail_client, "fetch_alerts",
                        lambda svc, q, after, seen, **k: [HDFC_UNKNOWN])

    queue, seen = [], {}
    run.process_account(_account(), CUSTOMERS, aliases, {}, queue, seen)
    assert queue[0]["status"] == "matched"
    assert queue[0]["customer"] == "Reliance Petro Marketing"
    assert queue[0]["match_tier"] == "alias"


def test_outlier_amount_downgraded_to_review(tmp_path, monkeypatch):
    _seed(tmp_path, monkeypatch)
    from agent.normalize import norm
    history = {norm("Sudarshan Minerals And Logistics"): [1000, 1200, 1100, 900]}
    monkeypatch.setattr(gmail_client, "build_service", lambda token: object())
    monkeypatch.setattr(gmail_client, "fetch_alerts",
                        lambda svc, q, after, seen, **k: [HDFC_MATCH])  # 125000 vs ~1100

    queue, seen = [], {}
    run.process_account(_account(), CUSTOMERS, {}, history, queue, seen)
    assert queue[0]["status"] == "review"
    assert queue[0]["flags"]["outlier"] is True
