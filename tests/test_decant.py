"""Tests for the /decant invoice feed (agent/decant.py + its Supabase upsert)."""

from agent import decant, invoice, supabase_sync
from tests.test_credit import FakeMail
from tests.test_invoice import CHAMBER_INVOICE_TEXT, INVOICE_TEXT


def _pdf_to_text(mapping):
    return lambda pdf: mapping[pdf]


def test_row_carries_lines_chambers_and_header_fields():
    mail = FakeMail("m1", [b"pdf"], pdf_names=["7011294526.pdf"])
    rows = decant.rows_from_mail(mail, _pdf_to_text({b"pdf": CHAMBER_INVOICE_TEXT}))
    assert len(rows) == 1
    r = rows[0]
    assert r["invoice_no"] == "7011294526"
    assert (r["invoice_date"], r["invoice_time"], r["tt_no"]) == ("26/09/2026", "14:15", "OD23U8210")
    assert [(ln["column_key"], ln["qty_kl"], ln["compartments"]) for ln in r["lines"]] == [
        ("MS | EBMS", 5.0, [1]), ("HSD", 17.0, [2, 3, 4, 5])]
    assert r["lines"][1]["density15"] == 829.3
    assert r["lines"][0]["value"] == 524764
    assert [c["qty_kl"] for c in r["chambers"]] == [5.0, 5.0, 4.0, 4.0, 4.0]
    assert r["source"] == "agent" and r["gmail_msg_id"] == "m1"
    assert r["seals"].startswith("439 & 440")


def test_any_truck_and_resends_collapse():
    other = CHAMBER_INVOICE_TEXT.replace("OD23U8210", "OD23X9999")
    mail = FakeMail("m2", [b"a", b"b"], pdf_names=["7011294526.pdf", "7011294526.pdf"])
    rows = decant.rows_from_mail(mail, _pdf_to_text({b"a": other, b"b": other}))
    assert len(rows) == 1 and rows[0]["tt_no"] == "OD23X9999"


def test_unusable_pdf_is_skipped():
    mail = FakeMail("m3", [b"junk"])
    assert decant.rows_from_mail(mail, _pdf_to_text({b"junk": "not an invoice"})) == []


def test_invoice_without_chamber_table_still_listed():
    # Older layout: no chamber table — the app falls back to the truck's saved chambers.
    mail = FakeMail("m4", [b"pdf"])
    rows = decant.rows_from_mail(mail, _pdf_to_text({b"pdf": INVOICE_TEXT}))
    assert rows and rows[0]["chambers"] == [] and rows[0]["lines"][0]["qty_kl"] == 22.0


def _wire(monkeypatch, mails, stored, ready=True):
    import agent.gmail_client as gc
    monkeypatch.setenv("GMAIL_TOKEN_BANK2", '{"email":"x","app_password":"y"}')
    monkeypatch.setattr(supabase_sync, "enabled", lambda: True)
    monkeypatch.setattr(supabase_sync, "decant_table_ready", lambda: ready)
    monkeypatch.setattr(gc, "build_service", lambda token: object())
    monkeypatch.setattr(gc, "fetch_invoice_mails", lambda *a, **k: mails)
    monkeypatch.setattr(gc, "pdf_to_text", lambda pdf: CHAMBER_INVOICE_TEXT)

    def upsert(rows):
        stored.extend(rows)
        return len(rows)
    monkeypatch.setattr(supabase_sync, "upsert_decant_invoices", upsert)


def test_run_stores_and_advances_cursor(monkeypatch):
    stored, seen = [], {}
    _wire(monkeypatch, [FakeMail("m9", [b"p"], internal_ms=5000, pdf_names=["7011294526.pdf"])], stored)
    sent, errors = decant.run(seen)
    assert (sent, errors) == (1, [])
    assert stored[0]["invoice_no"] == "7011294526"
    assert seen["decant_invoices"]["high_water"] == 5000
    assert seen["decant_invoices"]["ids"] == ["m9"]


def test_run_keeps_cursor_when_supabase_write_fails(monkeypatch):
    seen = {}
    _wire(monkeypatch, [FakeMail("m9", [b"p"], internal_ms=5000)], [])
    monkeypatch.setattr(supabase_sync, "upsert_decant_invoices", lambda rows: 0)
    sent, errors = decant.run(seen)
    assert sent == 0 and errors                       # reported …
    assert seen["decant_invoices"]["high_water"] == 0  # … and retried next run


def test_run_skips_quietly_until_schema_exists(monkeypatch):
    seen = {}
    _wire(monkeypatch, [FakeMail("m9", [b"p"], internal_ms=5000)], [], ready=False)
    assert decant.run(seen) == (0, [])
    assert "decant_invoices" not in seen                # cursor untouched -> back-fills later


def test_upsert_payload_is_insert_if_absent(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://real.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "realkey")
    calls = []
    monkeypatch.setattr(supabase_sync, "_request",
                        lambda method, path, key, url, body=None, prefer=None:
                        calls.append((method, path, body, prefer)))
    row = decant.invoice_row("m1", invoice.extract_fields(CHAMBER_INVOICE_TEXT), "7011294526")
    row["junk"] = "dropped"
    assert supabase_sync.upsert_decant_invoices([row, {"invoice_no": None}]) == 1
    method, path, body, prefer = calls[0]
    assert (method, path) == ("POST", "dec_invoices?on_conflict=invoice_no")
    assert "ignore-duplicates" in prefer
    assert set(body[0]) == set(supabase_sync.DECANT_INVOICE_COLUMNS)


def test_disabled_without_env(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    assert supabase_sync.decant_table_ready() is False
    assert supabase_sync.upsert_decant_invoices([{"invoice_no": "x"}]) == 0
    assert decant.run({}) == (0, [])
