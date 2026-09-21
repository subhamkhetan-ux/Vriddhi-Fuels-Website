"""Tests for the credit/dues invoice ingest (all IOCL invoices, any truck)."""

import types

from agent import credit
from tests.test_invoice import INVOICE_TEXT


class FakeMail:
    def __init__(self, msg_id, pdfs, internal_ms=1000, pdf_names=None):
        self.msg_id = msg_id
        self.internal_ms = internal_ms
        self.pdfs = pdfs
        self.pdf_names = pdf_names or []


def _pdf_to_text(mapping):
    return lambda pdf: mapping[pdf]


def test_rows_from_mail_extracts_any_truck():
    # A different TT than our own — still captured (unlike consignment notes).
    other = INVOICE_TEXT.replace("OD23U8210", "OD23X9999")
    mail = FakeMail("m1", [b"pdf"])
    rows, _obs = credit._rows_from_mail(mail, _pdf_to_text({b"pdf": other}))
    assert len(rows) == 1
    assert rows[0]["invoice_no"] == "7010195291"
    assert rows[0]["tt_no"] == "OD23X9999"
    assert rows[0]["amount"] == 2159219
    assert rows[0]["invoice_date"] == "26/08/2026"


def test_rows_from_mail_dedupes_same_invoice_in_one_mail():
    mail = FakeMail("m2", [b"a", b"b"])
    rows, _obs = credit._rows_from_mail(mail, _pdf_to_text({b"a": INVOICE_TEXT, b"b": INVOICE_TEXT}))
    assert len(rows) == 1  # same invoice_no in two PDFs -> one row


def test_rows_from_mail_keys_on_pdf_filename():
    # The SAP entry number = the PDF filename, and it wins over the text-parsed
    # number, so a resend (which may format the text differently) still collapses.
    mail = FakeMail("m5", [b"pdf"], pdf_names=["7010999999.pdf"])
    rows, obs = credit._rows_from_mail(mail, _pdf_to_text({b"pdf": INVOICE_TEXT}))
    assert len(rows) == 1
    assert rows[0]["invoice_no"] == "7010999999"        # from the filename, not the text
    assert obs and all(o["invoice_no"] == "7010999999" for o in obs)


def test_rows_from_mail_resent_invoice_same_filename_counts_once():
    # Same invoice PDF twice (same filename), even if the text differs slightly —
    # keyed on the SAP entry number, so it's a single row.
    other_amount = INVOICE_TEXT.replace("2159219", "2159220")
    mail = FakeMail("m6", [b"a", b"b"], pdf_names=["7010195291.pdf", "7010195291.pdf"])
    rows, _obs = credit._rows_from_mail(mail, _pdf_to_text({b"a": INVOICE_TEXT, b"b": other_amount}))
    assert len(rows) == 1
    assert rows[0]["invoice_no"] == "7010195291"


def test_rows_from_mail_skips_unparseable():
    mail = FakeMail("m3", [b"junk"])
    rows, obs = credit._rows_from_mail(mail, _pdf_to_text({b"junk": "nothing useful"}))
    assert rows == [] and obs == []


def test_rows_from_mail_yields_per_product_price_observations():
    from tests.test_invoice import MULTI_INVOICE_TEXT
    mail = FakeMail("m4", [b"pdf"])
    _rows, obs = credit._rows_from_mail(mail, _pdf_to_text({b"pdf": MULTI_INVOICE_TEXT}))
    by = {o["col_key"]: o for o in obs}
    assert set(by) == {"MS | EBMS", "HSD"}
    assert by["MS | EBMS"]["price"] == round(524764 / 5, 2)
    assert by["HSD"]["price"] == round(1668487 / 17, 2)
    assert by["HSD"]["as_of"] == "2026-09-03"       # dd/mm/yyyy -> ISO for newest-wins
    assert by["MS | EBMS"]["invoice_no"] == "7010493378"


def test_dmy_to_iso():
    assert credit._dmy_to_iso("03/09/2026") == "2026-09-03"
    assert credit._dmy_to_iso("bad") == ""


def test_run_skips_when_supabase_disabled(monkeypatch):
    import agent.supabase_sync as ss
    monkeypatch.setattr(ss, "enabled", lambda: False)
    created, errors = credit.run({})
    assert created == 0
    assert errors == []


def test_upsert_fuel_invoices_disabled(monkeypatch):
    import agent.supabase_sync as ss
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    assert ss.upsert_fuel_invoices([{"invoice_no": "7010195291", "amount": 1}]) == 0


def test_upsert_fuel_invoices_shape(monkeypatch):
    import agent.supabase_sync as ss
    monkeypatch.setenv("SUPABASE_URL", "https://real.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "realkey")
    captured = {}

    def fake_request(method, path, key, url, body=None, prefer=None):
        captured["path"] = path
        captured["body"] = body
        captured["prefer"] = prefer
        return None

    monkeypatch.setattr(ss, "_request", fake_request)
    n = ss.upsert_fuel_invoices([
        {"invoice_no": "7010195291", "invoice_date": "26/08/2026", "tt_no": "OD23U8210",
         "amount": 2159219, "gmail_msg_id": "m1"},
        {"invoice_no": None, "amount": 5},   # dropped (no PK)
    ])
    assert n == 1
    assert "on_conflict=invoice_no" in captured["path"]
    assert "ignore-duplicates" in captured["prefer"]
    assert set(captured["body"][0]) == {
        "invoice_no", "invoice_date", "tt_no", "amount", "gmail_msg_id"}
