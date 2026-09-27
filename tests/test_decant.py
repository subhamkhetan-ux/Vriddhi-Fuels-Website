"""Tests for the /decant invoice feed (agent/decant.py and its own Supabase project)."""

import re
from pathlib import Path

from agent import decant, invoice
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


DEC = ("https://decant-project.supabase.co", "sb_publishable_dec")


def _wire(monkeypatch, mails, stored, ready=True):
    import agent.gmail_client as gc
    monkeypatch.setenv("GMAIL_TOKEN_BANK2", '{"email":"x","app_password":"y"}')
    monkeypatch.setattr(decant, "project", lambda: (DEC, ""))
    monkeypatch.setattr(decant, "table_ready", lambda cfg: ready)
    monkeypatch.setattr(gc, "build_service", lambda token: object())
    monkeypatch.setattr(gc, "fetch_invoice_mails", lambda *a, **k: mails)
    monkeypatch.setattr(gc, "pdf_to_text", lambda pdf: CHAMBER_INVOICE_TEXT)

    def store(cfg, rows):
        assert cfg == DEC
        stored.extend(rows)
        return len(rows)
    monkeypatch.setattr(decant, "store", store)


def test_run_stores_and_advances_cursor(monkeypatch):
    stored, seen = [], {}
    _wire(monkeypatch, [FakeMail("m9", [b"p"], internal_ms=5000, pdf_names=["7011294526.pdf"])], stored)
    sent, errors = decant.run(seen)
    assert (sent, errors) == (1, [])
    assert stored[0]["invoice_no"] == "7011294526"
    assert seen["decant_invoices"]["high_water"] == 5000
    assert seen["decant_invoices"]["ids"] == ["m9"]


def test_a_new_project_back_fills(monkeypatch):
    # the cursor left by the first version (payments project, no "project" key)
    seen = {"decant_invoices": {"high_water": 1_790_482_006_000, "ids": ["old"]}}   # as left on main
    stored, asked = [], []
    _wire(monkeypatch, [FakeMail("m9", [b"p"], internal_ms=5000, pdf_names=["7011294526.pdf"])], stored)
    import agent.gmail_client as gc
    monkeypatch.setattr(gc, "fetch_invoice_mails", lambda service, q, after_ms, ids: asked.append((after_ms, ids)) or
                        [FakeMail("m9", [b"p"], internal_ms=5000, pdf_names=["7011294526.pdf"])])
    assert decant.run(seen) == (1, [])
    after_ms, ids = asked[0]
    assert after_ms < 1_790_482_006_000 and ids == set()   # looked back again, not from the old cursor
    assert seen["decant_invoices"] == {"high_water": 5000, "ids": ["m9"], "project": DEC[0]}
    # the next run carries on from there
    asked.clear()
    decant.run(seen)
    assert asked[0] == (5000, {"m9"})


def test_run_keeps_cursor_when_supabase_write_fails(monkeypatch):
    seen = {}
    _wire(monkeypatch, [FakeMail("m9", [b"p"], internal_ms=5000)], [])
    monkeypatch.setattr(decant, "store", lambda cfg, rows: 0)
    sent, errors = decant.run(seen)
    assert sent == 0 and errors                       # reported …
    assert seen["decant_invoices"]["high_water"] == 0  # … and retried next run


def test_run_skips_quietly_until_schema_exists(monkeypatch):
    seen = {}
    _wire(monkeypatch, [FakeMail("m9", [b"p"], internal_ms=5000)], [], ready=False)
    assert decant.run(seen) == (0, [])
    assert "decant_invoices" not in seen                # cursor untouched -> back-fills later


def test_store_is_insert_if_absent_with_the_publishable_key(monkeypatch):
    sent = []

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b""
    monkeypatch.setattr(decant.urllib.request, "urlopen", lambda req, timeout: sent.append((req, timeout)) or Resp())
    row = decant.invoice_row("m1", invoice.extract_fields(CHAMBER_INVOICE_TEXT), "7011294526")
    row["junk"] = "dropped"
    assert decant.store(DEC, [row, {"invoice_no": None}]) == 1
    req, timeout = sent[0]
    assert req.full_url == "https://decant-project.supabase.co/rest/v1/dec_invoices?on_conflict=invoice_no"
    assert req.get_method() == "POST" and timeout == 20
    headers = {k.lower(): v for k, v in req.header_items()}
    assert headers["apikey"] == "sb_publishable_dec"
    assert "authorization" not in headers              # new-style keys go in apikey only
    assert "ignore-duplicates" in headers["prefer"]
    import json
    assert set(json.loads(req.data)[0]) == set(decant.COLUMNS)


def _config(tmp_path, url, key):
    f = tmp_path / "config.js"
    f.write_text(f'window.VRIDDHI_DECANT_CONFIG = {{\n  SUPABASE_URL: "{url}",\n  SUPABASE_ANON_KEY: "{key}",\n}};\n')
    return f


def test_project_from_the_app_config(monkeypatch, tmp_path):
    for env in (decant.URL_ENV, decant.KEY_ENV):
        monkeypatch.delenv(env, raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://payments.supabase.co")
    monkeypatch.setattr(decant, "APP_CONFIG", _config(tmp_path, "https://decant-project.supabase.co/", "sb_publishable_dec"))
    assert decant.project() == (DEC, "")
    # placeholders: not set up yet -> the feed is skipped, nothing is sent anywhere
    monkeypatch.setattr(decant, "APP_CONFIG", _config(tmp_path, "PASTE_YOUR_PROJECT_URL", "PASTE_KEY"))
    cfg, why = decant.project()
    assert cfg is None and "no Supabase project" in why
    assert decant.run({}) == (0, [])
    # never the payments project
    monkeypatch.setattr(decant, "APP_CONFIG", _config(tmp_path, "https://Payments.supabase.co", "sb_publishable_pay"))
    cfg, why = decant.project()
    assert cfg is None and "payments project" in why
    # secrets win over the file
    monkeypatch.setenv(decant.URL_ENV, "https://other.supabase.co")
    monkeypatch.setenv(decant.KEY_ENV, "sb_secret_x")
    assert decant.project() == (("https://other.supabase.co", "sb_secret_x"), "")


def test_repo_decant_config_is_not_the_payments_project():
    root = Path(__file__).resolve().parent.parent
    url = lambda f: re.search(r'SUPABASE_URL\s*:\s*"([^"]*)"', (root / f).read_text(encoding="utf-8")).group(1)
    assert url("decant/config.js").rstrip("/") != url("payments/config.js").rstrip("/")
