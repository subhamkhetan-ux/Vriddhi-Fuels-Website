from agent import supabase_sync


def test_disabled_without_env(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    assert supabase_sync.enabled() is False
    assert supabase_sync.fetch_aliases() == {}
    assert supabase_sync.fetch_done_entry_ids() == set()
    assert supabase_sync.fetch_customers() == []
    assert supabase_sync.upsert_rows([{"entry_id": "x"}]) == 0


def test_fetch_customers_maps_names(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://real.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "realkey")
    monkeypatch.setattr(supabase_sync, "_request",
                        lambda *a, **k: [{"name": "A.K.V. Logistics"}, {"name": "Blue Bird"}, {"name": None}])
    assert supabase_sync.fetch_customers() == ["A.K.V. Logistics", "Blue Bird"]


def test_fetch_customers_swallows_errors(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://real.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "realkey")
    def boom(*a, **k):
        raise RuntimeError("network down")
    monkeypatch.setattr(supabase_sync, "_request", boom)
    assert supabase_sync.fetch_customers() == []


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


def test_mail_replaces_a_typed_in_fuel_invoice_only(monkeypatch):
    """The mail inserts if absent, then overwrites only a row typed in by hand
    (source=manual) — never one from the mail or an uploaded PDF."""
    from agent import supabase_sync
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "k")
    calls = []
    monkeypatch.setattr(supabase_sync, "_request",
                        lambda method, path, key, url, body=None, prefer=None: calls.append((method, path, body)))
    n = supabase_sync.upsert_fuel_invoices([{"invoice_no": "7011294526", "invoice_date": "26/09/2026",
                                             "tt_no": "OD23U8210", "amount": 2193251, "gmail_msg_id": "m1"}])
    assert n == 1
    assert calls[0][0] == "POST" and calls[0][1] == "pay_fuel_invoices?on_conflict=invoice_no"
    method, path, body = calls[1]
    assert method == "PATCH"
    assert path == "pay_fuel_invoices?invoice_no=eq.7011294526&source=eq.manual"
    assert body == {"invoice_date": "26/09/2026", "tt_no": "OD23U8210", "amount": 2193251,
                    "gmail_msg_id": "m1", "source": None}


def test_a_failing_typed_in_replace_doesnt_fail_the_ingest(monkeypatch):
    from agent import supabase_sync
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "k")

    def req(method, path, key, url, body=None, prefer=None):
        if method == "PATCH":
            raise RuntimeError("column source does not exist")
    monkeypatch.setattr(supabase_sync, "_request", req)
    assert supabase_sync.upsert_fuel_invoices([{"invoice_no": "7011294526", "amount": 1}]) == 1
