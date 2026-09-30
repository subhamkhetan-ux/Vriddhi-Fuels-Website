"""Tests for the bank-statement tool (bank_tally/) — parser + classifier.

Real statements are private; the Excel test builds a tiny in-memory workbook,
and the classifier tests use synthetic HDFC-style narrations.
"""

import pytest

from bank_tally import classify as C
from bank_tally import statement as S


# ---- remitter extraction ---------------------------------------------------

def test_extract_remitter_neft():
    n = "NEFT CR-ICIC0SF0002-ORISSA METALIKS PRIVATE LIMITED-VRIDDHI FUELS-IN426"
    assert C.extract_remitter(n) == "ORISSA METALIKS PRIVATE LIMITED"


def test_extract_remitter_imps_stops_at_bank_tag():
    n = "IMPS-619018473341-BHARAT LOGISTICS-UTIB-XXXXXXXXXXX6993-DIESEL"
    assert C.extract_remitter(n) == "BHARAT LOGISTICS"


def test_extract_remitter_upi_is_first_field():
    n = "UPI-BALAJI TRADING-BALAJITRADING73@OKSBI-UBIN0535401-619143938120"
    assert C.extract_remitter(n) == "BALAJI TRADING"


def test_extract_remitter_rtgs():
    n = "RTGS CR-KKBK0000958-ARYAN ISPAT AND POWER PRIVATE LI-VRIDDHI FUELS-KKBKR"
    assert C.extract_remitter(n) == "ARYAN ISPAT AND POWER PRIVATE LI"


# ---- classification --------------------------------------------------------

CUSTOMERS = ["Orissa Metaliks Private Limited", "Keshav Minerals", "Ekdant Logistic"]


def _row(narr, deposit=0.0, withdrawal=0.0):
    return S.BankRow(index=0, date=None, narration=narr, ref="",
                     withdrawal=withdrawal, deposit=deposit, balance=0.0)


def test_classify_contra_to_own_account():
    cl = C.classify(_row("IB FUNDS TRANSFER DR-50200110712542-VRIDDHI FUELS",
                         withdrawal=100000), CUSTOMERS)
    assert cl.vtype == C.CONTRA
    assert cl.counter_ledger == "HDFC BANK OD A/C - 50200110712542"


def test_classify_cash_deposit_is_contra_to_cash():
    cl = C.classify(_row("CASH DEPOSIT BY - SELF - JHARSUGUDA", deposit=600000),
                    CUSTOMERS)
    assert cl.vtype == C.CONTRA and cl.counter_ledger == "Cash"


def test_classify_iocl_payment_is_skipped():
    # IOCL payments are posted by the PAD tool; the bank tool skips them to avoid
    # double-counting.
    cl = C.classify(_row("RTGS DR-SBIN0009995-INDIAN OIL CORPORATION LIMITED-NETBANK",
                         withdrawal=2000000), CUSTOMERS)
    assert cl.skip is True
    assert cl.counter_ledger == "M/s Indian Oil Corporation Limited"


def test_staff_payment_maps_to_salary():
    # Bank truncates the name; first+last prefix still matches the staff list.
    for narr in ["MMT/IMPS/618308468876/BULD74167560/NarendraPr/UTIB0003650",
                 "MMT/IMPS/618308468897/BULD74167560/BikramSahu/SBIN0013615",
                 "MMT/IMPS/618308468941/BULD74167560/GokulaBhok/UBIN0572411"]:
        cl = C.classify(_row(narr, withdrawal=7500), CUSTOMERS)
        assert cl.vtype == C.PAYMENT and cl.counter_ledger == "Salary", narr


def test_resolved_alias_applies_both_directions():
    from agent.matcher import alias_key
    aliases = {alias_key("BHARAT LOGISTICS"): "Shivaay Logistics",
               alias_key("CARD BILL PAYMENT"): "HDFC Corporate Credit Card 7311"}
    # receipt side
    rc = C.classify(_row("IMPS-618-BHARAT LOGISTICS-UTIB-XXXX6993", deposit=20000),
                    CUSTOMERS, aliases)
    assert rc.vtype == C.RECEIPT and rc.counter_ledger == "Shivaay Logistics"
    # payment side (card)
    pc = C.classify(_row("IB BILLPAY DR-HDFCYC-463918XXXXXX7113", withdrawal=565399),
                    CUSTOMERS, aliases)
    assert pc.vtype == C.PAYMENT and pc.counter_ledger == "HDFC Corporate Credit Card 7311"


def test_cms_extracts_payer_name():
    assert C.extract_remitter("CMS/ CMS5835842331/SMEL STEEL STRUCTURAL PRIVATE") \
        == "SMEL STEEL STRUCTURAL PRIVATE"


def test_interest_debited_keyword():
    cl = C.classify(_row("INTEREST DEBITED TILL 31-JUL-2026", withdrawal=194675), CUSTOMERS)
    assert cl.vtype == C.PAYMENT and cl.counter_ledger == "Interest Paid"


def test_non_staff_payment_still_reviews():
    cl = C.classify(_row("INF/NEFT/IN42/HDFC0000763/SOME SUPPLIER CO", withdrawal=5000),
                    CUSTOMERS)
    assert cl.counter_ledger is None


def test_classify_receipt_matches_customer():
    cl = C.classify(_row("NEFT CR-SBIN0009678-KESHAV MINERALS-VRIDDHI FUELS-SBIN",
                         deposit=141036), CUSTOMERS)
    assert cl.vtype == C.RECEIPT
    assert cl.counter_ledger == "Keshav Minerals"


def test_classify_receipt_unmatched_goes_to_review():
    cl = C.classify(_row("NEFT CR-UTIB0000240-SIMAR INFRASTRUCTURES LTD-VRIDDHI FUELS-U",
                         deposit=137940), CUSTOMERS)
    assert cl.vtype == C.RECEIPT
    assert cl.counter_ledger is None            # needs review
    assert cl.counterparty_raw == "SIMAR INFRASTRUCTURES LTD"


def test_classify_receipt_rule_pine_labs():
    cl = C.classify(_row("NEFT CR-UTIB0000361-PINE LABS PRIVATE LIMITED-NODAL ACCOUNT-VRIDDHI FUELS",
                         deposit=15111), CUSTOMERS)
    assert cl.counter_ledger == "Pine Labs Nodal Account"


def test_alias_resolves_unmatched():
    from agent.matcher import alias_key
    aliases = {alias_key("SIMAR INFRASTRUCTURES LTD"): "Simar Infrastructure LTD"}
    cl = C.classify(_row("NEFT CR-UTIB0000240-SIMAR INFRASTRUCTURES LTD-VRIDDHI FUELS-U",
                         deposit=137940), CUSTOMERS, aliases=aliases)
    assert cl.counter_ledger == "Simar Infrastructure LTD"


def test_alias_to_bank_ledger_is_ignored():
    # A payee alias must never resolve to an own bank ledger — that turns an
    # unrelated payment into a phantom cross-account transfer (the "bbg -> HDFC
    # BANK C/A" bug that inflated CA by 75000).
    from agent.matcher import alias_key
    aliases = {alias_key("BBG"): "HDFC BANK C/A - 59217010101010"}
    cl = C.classify(_row("803258437-RFVRIDDHI FUEL-BBG", withdrawal=75000),
                    CUSTOMERS, aliases)
    # The bank-ledger alias is ignored; the row does NOT post to a bank ledger.
    assert cl.counter_ledger != "HDFC BANK C/A - 59217010101010"


def test_cgtms_self_transfer_routes_to_od():
    # A CGTMS self-transfer is our HDFC OD account (50200110712542).
    cl = C.classify(_row("IB FUNDS TRANSFER CR-CGTMS-VRIDDHI FUELS", deposit=1275000),
                    CUSTOMERS)
    assert cl.vtype == C.CONTRA
    assert cl.counter_ledger == "HDFC BANK OD A/C - 50200110712542"


def test_odisha_sarkar_always_reviews_even_with_alias():
    # ODISHA SARKAR belongs to different ledgers per transaction (JYOTI RANJAN vs
    # OIC FS Jharsuguda), so it must always go to review — even if an alias was
    # saved by mistake.
    from agent.matcher import alias_key
    aliases = {alias_key("ODISHA SARKAR"): "JYOTI RANJAN DASH"}
    cl = C.classify(_row("RTGS DR-SBIN0009995-ODISHA SARKAR-VRIDDHI FUELS-X",
                         withdrawal=50000), CUSTOMERS, aliases=aliases)
    assert cl.counter_ledger is None
    assert cl.tier == "force-review"


# ---- excel parsing + reconciliation ----------------------------------------

def test_parse_excel_reconciles(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Date", "Narration", "Chq./Ref.No.", "Value Dt",
               "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"])
    # opening 1000; +500 -> 1500; -200 -> 1300; +100 -> 1400
    ws.append(["01/07/26", "NEFT CR-X-ACME-VRIDDHI FUELS-1", "R1", "01/07/26", "", 500, 1500])
    ws.append(["02/07/26", "IB FUNDS TRANSFER DR-50200110712542-VRIDDHI FUELS", "R2",
               "02/07/26", 200, "", 1300])
    ws.append(["03/07/26", "IMPS-1-BOB-VRIDDHI FUELS-2", "R3", "03/07/26", "", 100, 1400])
    p = tmp_path / "stmt.xlsx"
    wb.save(str(p))
    rows, summ = S.parse_excel(str(p))
    assert summ["reconciles"] is True
    assert summ["n_rows"] == 3
    assert rows[0].deposit == 500 and rows[1].withdrawal == 200
    assert summ["opening"] == 1000.0 and summ["closing"] == 1400.0


def test_ledger_suggestions_include_own_banks():
    # The resolve dropdown must offer our own bank accounts + Cash so a contra /
    # unpaired transfer can be pointed at the other account.
    from bank_tally.server import ledger_suggestions
    sug = set(ledger_suggestions())
    assert "Cash" in sug
    assert "HDFC BANK C/A - 59217010101010" in sug
    assert "HDFC BANK OD A/C - 50200110712542" in sug
    assert "ICICI BANK LTD" in sug


def test_parse_master_xml_extracts_ledgers():
    from bank_tally.server import parse_master_xml
    xml = ('<ENVELOPE><TALLYMESSAGE>'
           '<LEDGER NAME="Aryan Ispat &amp; Power Private Ltd." RESERVEDNAME=""></LEDGER>'
           '</TALLYMESSAGE><TALLYMESSAGE>'
           '<LEDGER NAME="Keshav Minerals"></LEDGER></TALLYMESSAGE>'
           '<LEDGER NAME="Keshav Minerals"></LEDGER></ENVELOPE>')   # dup
    # UTF-8 and UTF-16 (Tally's usual export) both parse; the & is unescaped; dupes drop.
    for raw in (xml.encode("utf-8"), b"\xff\xfe" + xml.encode("utf-16-le")):
        names = parse_master_xml(raw)
        assert "Aryan Ispat & Power Private Ltd." in names
        assert names.count("Keshav Minerals") == 1


# ---- Mappings tab: alias add / edit / delete / restore ---------------------

@pytest.fixture
def alias_store(tmp_path, monkeypatch):
    """Point the server's alias/ledger files at a temp dir (never the real ones)."""
    import json
    from bank_tally import server as SV
    shipped = tmp_path / "bank_aliases.json"
    shipped.write_text(json.dumps({"bharat logistics": "Shivaay Logistics",
                                   "keshav": "Keshav Minerals"}))
    ledgers = tmp_path / "tally_ledgers.json"
    ledgers.write_text(json.dumps(["Shivaay Logistics", "Keshav Minerals",
                                   "Ekdant Logistic", "Salary"]))
    monkeypatch.setattr(SV, "COMMITTED_ALIASES", str(shipped))
    monkeypatch.setattr(SV, "COMMITTED_LEDGERS", str(ledgers))
    monkeypatch.setattr(SV, "DATA_PATH", str(tmp_path / "data.json"))
    monkeypatch.setattr(SV, "LEDGERS_PATH", str(tmp_path / "ledgers.json"))
    monkeypatch.setattr(SV, "_STATEMENTS", [])
    return SV, shipped


def test_alias_add_edit_delete_local_only(alias_store):
    SV, shipped = alias_store
    before = shipped.read_text()
    key = SV.set_alias("M/S EKDANT LOGISTIC PVT LTD", "ekdant logistic")
    a = SV.load_aliases()
    assert a[key] == "Ekdant Logistic"            # snapped to the Tally spelling
    SV.set_alias("", "Salary", key=key)           # edit the ledger
    assert SV.load_aliases()[key] == "Salary"
    SV.delete_alias(key)
    assert key not in SV.load_aliases()
    assert shipped.read_text() == before          # shipped table never rewritten


def test_delete_and_restore_shipped_alias(alias_store):
    SV, _ = alias_store
    SV.delete_alias("keshav")
    assert "keshav" not in SV.load_aliases()
    view = SV.aliases_view()
    assert [d["key"] for d in view["deleted"]] == ["keshav"]
    SV.restore_alias("keshav")
    assert SV.load_aliases()["keshav"] == "Keshav Minerals"
    # Edit a shipped one -> local override; restore -> back to shipped.
    SV.set_alias("", "Ekdant Logistic", key="bharat logistics")
    row = {r["key"]: r for r in SV.aliases_view()["aliases"]}["bharat logistics"]
    assert row["source"] == "edited" and row["shipped_ledger"] == "Shivaay Logistics"
    SV.restore_alias("bharat logistics")
    assert SV.load_aliases()["bharat logistics"] == "Shivaay Logistics"


def test_readding_deleted_shipped_alias_clears_tombstone(alias_store):
    SV, _ = alias_store
    SV.delete_alias("keshav")
    SV.save_alias("KESHAV", "Keshav Minerals")    # e.g. re-learned in review
    assert SV.load_aliases()["keshav"] == "Keshav Minerals"


def test_rename_alias_moves_it(alias_store):
    SV, _ = alias_store
    new = SV.set_alias("BHARAT LOGISTICS CO", "Shivaay Logistics",
                       old_key="bharat logistics")
    a = SV.load_aliases()
    assert new in a and "bharat logistics" not in a


def test_alias_validation(alias_store):
    SV, _ = alias_store
    with pytest.raises(SV.AliasError):             # our own bank -> never
        SV.set_alias("SOME PARTY", "HDFC BANK C/A - 59217010101010")
    with pytest.raises(SV.AliasError):
        SV.set_alias("SOME PARTY", "cash")
    with pytest.raises(SV.AliasError):             # always-review name
        SV.set_alias("ODISHA SARKAR", "Keshav Minerals")
    with pytest.raises(SV.AliasError):             # too short to be safe
        SV.set_alias("AB", "Keshav Minerals")
    with pytest.raises(SV.AliasError) as ei:       # unknown ledger -> ask first
        SV.set_alias("SOME PARTY", "Nonexistent Ledger")
    assert ei.value.extra.get("unknown_ledger")
    k = SV.set_alias("SOME PARTY", "Nonexistent Ledger", allow_unknown=True)
    assert SV.load_aliases()[k] == "Nonexistent Ledger"


def test_aliases_view_lists_names_in_loaded_statements(alias_store, monkeypatch):
    SV, _ = alias_store
    rows = [_row("IMPS-619018473341-BHARAT LOGISTICS-UTIB-XXXXXXXXXXX6993-DIESEL",
                 deposit=5000),
            _row("NEFT CR-ICIC0SF0002-UNKNOWN TRADERS-VRIDDHI FUELS-IN426",
                 deposit=700)]
    monkeypatch.setattr(SV, "_STATEMENTS", [("HDFC BANK C/A - 59217010101010", rows)])
    view = SV.aliases_view()
    names = {n["key"]: n for n in view["names"]}
    assert names["bharat logistics"]["ledger"] == "Shivaay Logistics"
    assert names["bharat logistics"]["has_alias"] is True
    unknown = [n for n in view["names"] if n["ledger"] is None]
    assert unknown and unknown[0]["name"] == "UNKNOWN TRADERS"
    seen = {r["key"]: r["seen"] for r in view["aliases"]}
    assert seen["bharat logistics"] == 1
