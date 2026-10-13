"""Invoice events reach the PAD workflow even if other ingest work fails."""
import pytest

from agent import consignment, credit, decant, run, state_store, supabase_sync


@pytest.mark.parametrize(("detected", "failed", "expected"), [
    (True, False, "true"), (True, True, "true"), (False, False, "false"),
])
def test_ingest_exports_invoice_signal_without_business_data(monkeypatch, tmp_path, detected, failed, expected):
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(run, "ACCOUNTS", [])
    monkeypatch.setattr(run, "_load_history", lambda: {})
    for name, result in [("load_customers", ["Test Outlet"]), ("load_aliases", {}),
                         ("load_queue", []), ("load_seen", {})]:
        monkeypatch.setattr(state_store, name, lambda result=result: result)
    monkeypatch.setattr(state_store, "save_queue", lambda _: None)
    monkeypatch.setattr(state_store, "save_seen", lambda _: None)
    monkeypatch.setattr(supabase_sync, "fetch_customers", lambda: [])
    monkeypatch.setattr(supabase_sync, "fetch_aliases", lambda: {})
    monkeypatch.setattr(supabase_sync, "fetch_done_entry_ids", lambda: set())
    monkeypatch.setattr(supabase_sync, "enabled", lambda: False)
    monkeypatch.setattr(consignment, "run", lambda _: (0, []))
    monkeypatch.setattr(decant, "run", lambda _: (0, []))
    monkeypatch.setattr(run, "notify", lambda _: None)
    def ingest(seen, *, on_detected):
        if detected:
            on_detected()
        if failed:
            raise RuntimeError("fixture database error")
        return (1 if detected else 0), []
    monkeypatch.setattr(credit, "run", ingest)
    assert run.main() == (1 if failed else 0)
    assert output.read_text() == f"iocl_invoices_detected={expected}\n"


def test_detected_invoice_signals_before_database_failure(monkeypatch):
    from types import SimpleNamespace
    from agent import gmail_client
    monkeypatch.setattr(supabase_sync, "enabled", lambda: True)
    monkeypatch.setattr(credit, "_account_token_env", lambda: "FIXTURE_GMAIL_TOKEN")
    monkeypatch.setenv("FIXTURE_GMAIL_TOKEN", "fixture-only")
    monkeypatch.setattr(gmail_client, "build_service", lambda _: object())
    mail = SimpleNamespace(msg_id="test-message", internal_ms=1000)
    monkeypatch.setattr(gmail_client, "fetch_invoice_mails", lambda *a: [mail])
    monkeypatch.setattr(credit, "_rows_from_mail", lambda *a: ([{"invoice_no": "999999"}], []))
    calls = []
    def write(rows):
        assert calls == ["detected"]
        raise RuntimeError("fixture database failure")
    monkeypatch.setattr(supabase_sync, "upsert_fuel_invoices", write)
    with pytest.raises(RuntimeError, match="fixture database failure"):
        credit.run({}, on_detected=lambda: calls.append("detected"))
    assert calls == ["detected"]
