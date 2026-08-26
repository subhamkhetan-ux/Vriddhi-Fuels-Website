"""Tests for the consignment-note orchestrator's decision logic — the own-TT
filter, incomplete-parse guard, and idempotent claim — using fakes for Gmail
PDF extraction and Supabase (no network, no PDF libs)."""

import types

import pytest

from agent import consignment
from tests.test_invoice import INVOICE_TEXT


class FakeMail:
    def __init__(self, msg_id, pdfs):
        self.msg_id = msg_id
        self.internal_ms = 1000
        self.pdfs = pdfs


def _pdf_to_text(mapping):
    return lambda pdf: mapping[pdf]


def _fake_supabase(record):
    def claim(note):
        record.append(note)
        return {**note, "serial_str": "VF/CN2627/047"}
    return types.SimpleNamespace(claim_consignment=claim)


def test_handle_mail_claims_own_tt():
    record = []
    mail = FakeMail("m1", [b"pdf-own"])
    n = consignment._handle_mail(
        mail, "OD23U8210", _pdf_to_text({b"pdf-own": INVOICE_TEXT}),
        _fake_supabase(record))
    assert n == 1
    assert len(record) == 1
    assert record[0]["invoice_no"] == "7010195291"
    assert record[0]["tt_no"] == "OD23U8210"


def test_handle_mail_skips_below_min_invoice():
    # Own truck, but the invoice number is below the anchor -> skip, don't claim.
    record = []
    mail = FakeMail("m1b", [b"pdf-old"])
    n = consignment._handle_mail(
        mail, "OD23U8210", _pdf_to_text({b"pdf-old": INVOICE_TEXT}),
        _fake_supabase(record), min_invoice_no="7010221545")
    assert n == 0
    assert record == []


def test_handle_mail_claims_at_or_above_min_invoice():
    # Same invoice bumped to the anchor number -> claimed.
    record = []
    atmin = INVOICE_TEXT.replace("7010195291", "7010221545")
    mail = FakeMail("m1c", [b"pdf-new"])
    n = consignment._handle_mail(
        mail, "OD23U8210", _pdf_to_text({b"pdf-new": atmin}),
        _fake_supabase(record), min_invoice_no="7010221545")
    assert n == 1
    assert record and record[0]["invoice_no"] == "7010221545"


def test_handle_mail_ignores_other_tt():
    record = []
    other = INVOICE_TEXT.replace("OD23U8210", "OD23X9999")
    mail = FakeMail("m2", [b"pdf-other"])
    n = consignment._handle_mail(
        mail, "OD23U8210", _pdf_to_text({b"pdf-other": other}),
        _fake_supabase(record))
    assert n == 0
    assert record == []


def test_handle_mail_raises_on_incomplete_own_tt():
    # Own truck but the value/product are missing -> surface loudly, don't claim.
    broken = "OD23U8210\nT.T.No.\nnothing else useful\n"
    mail = FakeMail("m3", [b"pdf-broken"])
    with pytest.raises(ValueError):
        consignment._handle_mail(
            mail, "OD23U8210", _pdf_to_text({b"pdf-broken": broken}),
            _fake_supabase([]))


def test_run_skips_when_supabase_disabled(monkeypatch):
    # No SUPABASE env -> the whole feature is a quiet no-op.
    import agent.supabase_sync as ss
    monkeypatch.setattr(ss, "enabled", lambda: False)
    created, errors = consignment.run({})
    assert created == 0
    assert errors == []
