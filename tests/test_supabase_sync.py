from agent import supabase_sync


def test_disabled_without_env(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    assert supabase_sync.enabled() is False
    assert supabase_sync.fetch_aliases() == {}
    assert supabase_sync.upsert_rows([{"entry_id": "x"}]) == 0


def test_disabled_with_placeholder(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://PASTE_ME.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "PASTE_KEY")
    assert supabase_sync.enabled() is False


def test_row_payload_shape():
    row = {
        "entry_id": "abc", "gmail_msg_id": "m1", "account": "bank2", "bank": "HDFC",
        "mode": "HDFC 1010", "date_str": "25/08/2026", "date_serial": 46259,
        "amount": 4197180.0, "raw_payer": "DBL SIARMAL", "customer": "Dbl-Siarmal",
        "candidates": ["Dbl-Siarmal"], "match_tier": "substring", "status": "matched",
        "flags": {"outlier": False}, "queued_at": "2026-08-26T04:44:39+00:00",
    }
    p = supabase_sync._row_payload(row)
    assert p["entry_id"] == "abc"
    assert p["date_serial"] == 46259
    assert p["status"] == "matched"
    assert p["candidates"] == ["Dbl-Siarmal"]
    # only the expected columns are present
    assert set(p) == {
        "entry_id", "gmail_msg_id", "account", "bank", "mode", "date_str",
        "date_serial", "amount", "raw_payer", "customer", "candidates",
        "match_tier", "status", "flags", "raw_text", "queued_at"}
