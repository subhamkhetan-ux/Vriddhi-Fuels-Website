"""Tests for the IOCL PAD -> Tally importer (iocl_tally/).

The fixture is a synthetic, structure-faithful slice of a PAD statement (real
figures are the user's private data and are not committed). It reproduces the
awkward cases the parser must survive: multi-line wrapped cells, a merged
``0 2000.00`` debit/credit line, a split quantity, and every posting category —
with a running balance that ties out so the reconciliation lock is exercised.
"""

import datetime as dt

from iocl_tally import pad_parser as P
from iocl_tally import xml_generator as G
from iocl_tally import run as R

# opening -1000.00; each record's stated balance = prev + debit - credit.
PAD_TEXT = "\n".join([
    "Opening Balance: Rs -1000.00",
    "Customer: VRIDDHI FUELS (338821)",
    "Date: 01-Jul-2026 To 05-Jul-2026",
    "OP.BAL.in Comp Code:", "01.07.26", "0", "0", "-1000.00",
    # 1) TDS credit memo 100.00 (credit) -> -1100.00
    " TDS Credit note-", "7008000001", "Customer", "credit memo",
    "01.07.26", "0", "100.00", "-1100.00",
    # 2) K1 debit memo 50.00 (debit) -> -1050.00
    "K1 PARTICIPATION", "FEE", "Customer", "debit memo",
    "01.07.26", "50.00", "0", "-1050.00",
    # 3) ECollection 2000.00 (credit, merged line) -> -3050.00
    "HDFC12345", "HDFC0000240_5020011", "0712542", "Customer", "ECollection",
    "02.07.26", "0 2000.00", "-3050.00",
    # 4) Product supply invoice 1500.00 (debit, split qty) -> -1550.00
    "Jharsuguda", "Terminal", "7008000004 ':", "PRODUCT SUPPLY", "INVOICE - SALES",
    "Billing", "doc.transfer", "7008000004", "': PRODUCT", "SUPPLY", "INVOICE -",
    "SALES", "02.07.26", "BULK-", "HSD", "22.00", "0", "KL", "1500.00", "0",
    "-1550.00",
    # 5) Fleet 25.00 (credit) -> -1575.00
    "4000484887-0003209", "20260701019616", "Fleet- Card", "Posting",
    "02.07.26", "0", "25.00", "-1575.00",
    # 6) License fee (SSLF) 200.00 (debit) via Billing doc.transfer -> -1375.00
    "Jharsuguda", "Terminal", "7008000006 ':", "LICENSE FEE (SSLF) RECOVERY",
    "Billing", "doc.transfer", "02.07.26", "200.00", "0", "-1375.00",
    # 7) Interest (misspelled) 20.00 (debit) -> -1355.00
    "Int./JUL/2026", "Cust IntrestManual", "03.07.26", "20.00", "0", "-1355.00",
    # Closing header carries the open-delivery add-on (+10.00); the CL.BAL row
    # itself just restates the last transactional balance.
    "Closing Balance: Rs -1345.00",
    "CL.BAL.in Comp Code:", "05.07.26", "0", "0", "-1355.00",
])


def test_reconciles_and_counts():
    recs, summ = P.parse(PAD_TEXT)
    assert summ["reconciles"] is True
    assert summ["first_break"] is None
    cats = [r.category for r in recs]
    assert cats.count(P.CAT_TDS) == 1
    assert cats.count(P.CAT_K1) == 1
    assert cats.count(P.CAT_COLLECTION) == 1
    assert cats.count(P.CAT_PURCHASE) == 1
    assert cats.count(P.CAT_FLEET) == 1
    assert cats.count(P.CAT_LICENSE) == 1
    assert cats.count(P.CAT_INTEREST) == 1
    assert P.CAT_UNKNOWN not in cats


def test_merged_and_split_lines_parse():
    recs, _ = P.parse(PAD_TEXT)
    coll = next(r for r in recs if r.category == P.CAT_COLLECTION)
    assert coll.credit == 2000.00 and coll.debit == 0.0
    purc = next(r for r in recs if r.category == P.CAT_PURCHASE)
    assert purc.debit == 1500.00 and purc.credit == 0.0


def test_opening_and_closing_rows_skipped():
    recs, summ = P.parse(PAD_TEXT)
    assert all(r.category != P.CAT_OPENING for r in recs)
    assert summ["n_postable"] == 7


def test_doc_number_extracted():
    recs, _ = P.parse(PAD_TEXT)
    tds = next(r for r in recs if r.category == P.CAT_TDS)
    assert tds.doc_number == "7008000001"


def test_classify_variants():
    assert P.classify("TDS Credit note- 7008", "credit memo") == P.CAT_TDS
    assert P.classify("Fleet- Card Posting", "") == P.CAT_FLEET
    assert P.classify("Customer ECollection", "") == P.CAT_COLLECTION
    assert P.classify("LICENSE FEE (SSLF) RECOVERY Billing", "") == P.CAT_LICENSE
    assert P.classify("YVR464- Dealer Margin", "Billing doc.transfer") == P.CAT_DEALERMARGIN
    assert P.classify("PRODUCT SUPPLY INVOICE - SALES", "") == P.CAT_PURCHASE
    assert P.classify("2200_NFR NFRBaltrnsfrtoRO", "") == P.CAT_NFR


# ---- generator -------------------------------------------------------------

def test_journal_balances_and_strips_identity():
    v = G.make_journal("TDS", "20260701", 1754.10, reference="7008273332")
    assert G.voucher_balances(v) is True
    for gone in ("<GUID>", "<VOUCHERNUMBER>", "<ALTERID>", "REMOTEID=", "VCHKEY="):
        assert gone not in v
    assert "<DATE>20260701</DATE>" in v
    assert "<REFERENCE>7008273332</REFERENCE>" in v


def test_journal_amount_signs_preserved():
    import re
    v = G.make_journal("TDS", "20260701", 500.00)
    amts = re.findall(r"<ALLLEDGERENTRIES\.LIST>.*?<AMOUNT>(-?[\d.]+)</AMOUNT>", v, re.S)
    assert set(amts) == {"-500.00", "500.00"}   # party Dr, counter Cr


def test_collection_ca_uses_ca_template():
    v = G.make_journal("COLLECTION", "20260701", 10000.0, collection_to_ca=True)
    assert "HDFC BANK C/A - 59217010101010" in v
    assert "HDFC BANK OD A/C - 50200110712542" not in v


def test_every_journal_template_balances():
    for cat in G.JOURNAL_TEMPLATES:
        v = G.make_journal(cat, "20260701", 1234.56)
        assert G.voucher_balances(v), cat


# ---- orchestrator ----------------------------------------------------------

def test_process_generates_journals_skips_purchases():
    recs, vouchers, review, summary = R.process(PAD_TEXT)
    # 7 postable: 6 journals generated, 1 purchase skipped.
    assert summary["n_vouchers"] == 6
    assert summary["skipped_purchases"] == 1
    assert summary["reconciles"] is True
    assert summary["open_delivery_addon"] == 10.00
    purchase_rows = [r for r in review if r["category"] == "PURCHASE"]
    assert purchase_rows and purchase_rows[0]["status"] == "SKIPPED"
    assert all(G.voucher_balances(v) for v in vouchers)


def test_envelope_wraps_all_vouchers():
    _, vouchers, _, _ = R.process(PAD_TEXT)
    env = G.build_envelope(vouchers)
    assert env.count("<TALLYMESSAGE") == len(vouchers)
    assert "<TALLYREQUEST>Import Data</TALLYREQUEST>" in env
    assert "VRIDDHI FUELS (2026-27)" in env
