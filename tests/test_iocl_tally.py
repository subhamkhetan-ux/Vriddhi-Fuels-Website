"""Tests for the IOCL PAD -> Tally importer (iocl_tally/).

The fixture is a synthetic, structure-faithful slice of a PAD statement (real
figures are the user's private data and are not committed). It reproduces the
awkward cases the parser must survive: multi-line wrapped cells, a merged
``0 2000.00`` debit/credit line, a split quantity, and every posting category —
with a running balance that ties out so the reconciliation lock is exercised.
"""

import datetime as dt

from iocl_tally import invoice_parser as IP
from iocl_tally import pad_parser as P
from iocl_tally import xml_generator as G
from iocl_tally import run as R

# Synthetic 2-product IOCL tax invoice (structure-faithful; real invoices are
# private). EBMS 5 KL + HSD 17 KL, matching the awkward decoys of the real one.
INVOICE_2PROD = """\
AC4  31A
7010117417
SAP Entry no.
13262466
OD23U8210
T.T.No.
25-Aug-26
Date
Item  Material Code / Material Description
Quantity Unit
Total
10
16733   EBMS [PDRP]
5.000
KL
2710 12 41.
             BASIC DESTINATION PRICE
5.000
KL
81994.360
KL
409971.80
JIN6   A/R Vat Payable
28.000
%
114792.10
Total for material
524763.90
20
50703   HSD-BSVI [PDRP]
17.000
KL
2710 19 44*
             BASIC DESTINATION PRICE
17.000
KL
79150.260
KL
1345554.42
JIN6   A/R Vat Payable
24.000
%
322933.06
Total for material
1668487.48
ZRND  Rounding Difference
-0.38
Total
2193251.00
"""

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


# ---- invoice parser + purchase generator -----------------------------------

def test_invoice_parser_two_products():
    iv = IP.parse_invoice(INVOICE_2PROD)
    assert iv.invoice_no == "7010117417"
    assert iv.tt_no == "OD23U8210"
    assert len(iv.products) == 2
    ms = next(p for p in iv.products if p.stock_item == "Motor Spirit")
    hsd = next(p for p in iv.products if p.stock_item == "High Speed Diesel")
    assert (ms.qty_kl, ms.base_value, ms.vat_amount) == (5.0, 409971.80, 114792.10)
    assert ms.vat_ledger == "MS VAT"
    assert (hsd.qty_kl, hsd.base_value, hsd.vat_amount) == (17.0, 1345554.42, 322933.06)
    assert iv.zrnd == -0.38 and iv.total == 2193251.00
    # base + VAT + rounding reconstructs the invoice total to the paise.
    assert round(iv.base_total + iv.vat_total + iv.zrnd, 2) == iv.total


def test_make_purchase_two_products_balances_and_matches_totals():
    import re
    iv = IP.parse_invoice(INVOICE_2PROD)
    v = G.make_purchase(iv, "20260825", reference="7010117417")
    assert v is not None
    assert G.purchase_balances(v) is True
    for gone in ("<GUID>", "<VOUCHERNUMBER>", "REMOTEID=", "VCHKEY="):
        assert gone not in v
    assert "<DATE>20260825</DATE>" in v
    assert "<REFERENCE>7010117417</REFERENCE>" in v
    # party credited the grand total; both stock items present.
    party = re.search(
        r"<LEDGERNAME>M/s Indian Oil Corporation Limited</LEDGERNAME>.*?<AMOUNT>([\d.]+)</AMOUNT>",
        v, re.S).group(1)
    assert party == "2193251.00"
    assert "High Speed Diesel" in v and "Motor Spirit" in v
    # base + VAT amounts from the invoice appear on the inventory entries.
    assert "-409971.80" in v and "-114792.10" in v
    assert "-1345554.42" in v and "-322933.06" in v


def test_tt_numbering_format_and_idempotent():
    st = {"next_tt": 131, "issued": {}}
    assert G.assign_tt(st, "7010099224") == "TT131"
    assert G.assign_tt(st, "7010117417") == "TT132"
    assert G.assign_tt(st, "7010099224") == "TT131"   # same doc -> same number
    assert st["next_tt"] == 133                         # not spent again
    assert G.format_tt(63) == "TT063"


def test_make_purchase_emits_voucher_number():
    iv = IP.parse_invoice(INVOICE_2PROD)
    v = G.make_purchase(iv, "20260825", reference="7010117417", voucher_number="TT131")
    assert "<VOUCHERNUMBER>TT131</VOUCHERNUMBER>" in v


def test_process_numbers_purchases_sequentially():
    inv = {"7008000004": IP.Invoice(
        invoice_no="7008000004", date="02-Jul-26", tt_no="OD23U8210",
        products=[IP.Product("50703", "HSD-BSVI [PDRP]", "High Speed Diesel",
                             "HSD VAT", 22.0, 1209.68, 24.0, 290.32)],
        zrnd=0.0, total=1500.00)}
    tt = {"next_tt": 131, "issued": {}}
    _, vouchers, review, _ = R.process(PAD_TEXT, invoices=inv, tt_state=tt)
    pv = [v for v in vouchers if "<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>" in v]
    assert pv and "<VOUCHERNUMBER>TT131</VOUCHERNUMBER>" in pv[0]
    assert tt["issued"]["7008000004"] == 131


def test_make_purchase_single_product_balances():
    iv = IP.Invoice(
        invoice_no="7010000001", date="25-Aug-26", tt_no="OD23U8210",
        products=[IP.Product("50703", "HSD-BSVI [PDRP]", "High Speed Diesel",
                             "HSD VAT", 22.0, 1741305.72, 24.0, 417913.37)],
        zrnd=-0.09, total=2159219.00)
    v = G.make_purchase(iv, "20260825", reference="7010000001")
    assert v is not None and G.purchase_balances(v)


def test_unsupported_product_mix_skipped():
    # MS-only single has no exported template -> None (caller skips + flags).
    iv = IP.Invoice(
        invoice_no="7010000002", date="25-Aug-26", tt_no="OD23U8210",
        products=[IP.Product("16733", "EBMS [PDRP]", "Motor Spirit", "MS VAT",
                             5.0, 409971.80, 28.0, 114792.10)],
        zrnd=0.0, total=524763.90)
    assert G.make_purchase(iv, "20260825", reference="x") is None


def test_process_generates_purchase_when_invoice_matches():
    # An invoice whose total matches the PAD purchase debit (1500.00) generates.
    inv = {"7008000004": IP.Invoice(
        invoice_no="7008000004", date="02-Jul-26", tt_no="OD23U8210",
        products=[IP.Product("50703", "HSD-BSVI [PDRP]", "High Speed Diesel",
                             "HSD VAT", 22.0, 1209.68, 24.0, 290.32)],
        zrnd=0.0, total=1500.00)}
    _, vouchers, review, summary = R.process(PAD_TEXT, invoices=inv)
    prow = next(r for r in review if r["category"] == "PURCHASE")
    assert prow["status"] == "OK"
    assert summary["counts"].get("PURCHASE") == 1
    assert all(G.purchase_balances(v) for v in vouchers
               if "<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>" in v)


def test_normalize_dir_unescapes_and_expands():
    # Terminal-escaped paste (spaces + tildes) -> real path.
    esc = r"/Users/x/Library/Mobile\ Documents/com\~apple\~CloudDocs/Vriddhi\ Fuels"
    assert R.normalize_dir(esc) == "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Vriddhi Fuels"
    # surrounding quotes are dropped
    assert R.normalize_dir('"/tmp/a b"') == "/tmp/a b"
    assert R.normalize_dir("") == ""


def test_load_invoices_recurses_subfolders(tmp_path):
    # An invoice sitting in a month subfolder is still found.
    import pytest
    pymupdf = pytest.importorskip("pymupdf")  # needs the PDF lib
    month = tmp_path / "2026" / "August 2026"
    month.mkdir(parents=True)
    doc = pymupdf.open()
    doc.new_page().insert_text((40, 50), INVOICE_2PROD, fontsize=8)
    doc.save(str(month / "challan.pdf"))
    doc.close()
    idx = R.load_invoices(str(tmp_path))          # point at the 2026 parent
    assert "7010117417" in idx


def test_process_flags_invoice_total_mismatch():
    # Invoice total != PAD amount -> flagged, never silently posted.
    inv = {"7008000004": IP.Invoice(
        invoice_no="7008000004", date="02-Jul-26", tt_no="OD23U8210",
        products=[IP.Product("50703", "HSD-BSVI [PDRP]", "High Speed Diesel",
                             "HSD VAT", 22.0, 1741305.72, 24.0, 417913.37)],
        zrnd=-0.09, total=2159219.00)}
    _, _, review, _ = R.process(PAD_TEXT, invoices=inv)
    prow = next(r for r in review if r["category"] == "PURCHASE")
    assert prow["status"] == "SKIPPED" and "!=" in prow["note"]
