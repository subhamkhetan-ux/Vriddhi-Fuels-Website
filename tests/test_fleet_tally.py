"""Tests for the fleet-card / TDS settlement journal tool."""

import datetime as dt
import re

from fleet_tally import generate as G
from fleet_tally import run as R
from fleet_tally.parse import Row, _rows_from_grid


def _ledgers(v):
    out = []
    for m in re.finditer(r"<ALLLEDGERENTRIES\.LIST>(.*?)</ALLLEDGERENTRIES\.LIST>", v, re.S):
        b = m.group(1)
        led = re.search(r"<LEDGERNAME>([^<]*)</LEDGERNAME>", b).group(1)
        pos = re.search(r"<ISDEEMEDPOSITIVE>([^<]*)</ISDEEMEDPOSITIVE>", b).group(1)
        amt = re.search(r"<AMOUNT>(-?[\d.]+)</AMOUNT>", b).group(1)
        out.append((led, pos, amt))
    return out


def test_fleet_journal_direction_and_balance():
    v = G.make_fleet_journal("20260815", "Shree Shyam Logistics", 250000.0)
    leds = _ledgers(v)
    assert (G.FLEET_LEDGER, "Yes", "-250000.00") in leds      # Fleet Card Posting Dr
    assert ("Shree Shyam Logistics", "No", "250000.00") in leds   # customer Cr
    assert G.voucher_balances(v)
    assert "<GUID>" not in v and "<VOUCHERNUMBER>" not in v and "VCHKEY=" not in v


def test_tds_journal_direction_and_balance():
    v = G.make_tds_journal("20260815", "Keshav Minerals", 1209.0)
    leds = _ledgers(v)
    assert (G.TDS_LEDGER, "Yes", "-1209.00") in leds          # TDS RECEIVABLE Dr
    assert ("Keshav Minerals", "No", "1209.00") in leds       # customer Cr
    assert G.voucher_balances(v)
    # For TDS the party ledger is the customer.
    assert "<PARTYLEDGERNAME>Keshav Minerals</PARTYLEDGERNAME>" in v
    assert "<GUID>" not in v and "<VOUCHERNUMBER>" not in v


def test_customer_ampersand_is_escaped_both_kinds():
    for mk in (G.make_fleet_journal, G.make_tds_journal):
        env = G.build_envelope([mk("20260815", "Sudarshan Minerals & Logistics", 500.0)])
        assert re.search(r"&(?!amp;|lt;|gt;|quot;|apos;|#)", env) is None
        assert "Sudarshan Minerals &amp; Logistics" in env


def test_envelope_wraps_each_voucher_in_tallymessage():
    env = G.build_envelope([G.make_fleet_journal("20260801", "A B C Ltd", 100.0),
                            G.make_tds_journal("20260802", "X Y Z Ltd", 200.0)])
    assert env.count("<TALLYMESSAGE") == 2 == env.count("</TALLYMESSAGE>")
    assert env.count("<VOUCHER ") == 2


def test_fleet_and_tds_are_independent():
    fleet = [Row(1, dt.date(2026, 8, 1), "Cust A", 1000.0)]
    tds = [Row(1, dt.date(2026, 8, 2), "Cust B", 50.0)]
    # both
    _, _, s = R.process(fleet, tds, customers=["Cust A", "Cust B"])
    assert s["fleet"]["n_vouchers"] == 1 and s["tds"]["n_vouchers"] == 1
    assert s["n_vouchers"] == 2 and s["all_balance"]
    # fleet only (TDS absent)
    _, _, s2 = R.process(fleet, None, customers=["Cust A"])
    assert s2["fleet"]["n_vouchers"] == 1 and s2["tds"]["n_vouchers"] == 0
    # TDS only (fleet absent)
    _, _, s3 = R.process(None, tds, customers=["Cust B"])
    assert s3["tds"]["n_vouchers"] == 1 and s3["fleet"]["n_vouchers"] == 0


def test_process_flags_unknown_customer_but_still_posts():
    rows = [Row(1, dt.date(2026, 8, 1), "Known Cust", 1000.0),
            Row(2, dt.date(2026, 8, 2), "Typo Custt", 2000.0)]
    vouchers, entries, summary = R.process(rows, None, customers=["Known Cust"])
    assert summary["n_vouchers"] == 2 and summary["all_balance"]
    assert summary["fleet"]["n_ok"] == 1 and summary["fleet"]["n_unknown"] == 1
    st = {e["customer"]: e["status"] for e in entries}
    assert st["Known Cust"] == "ok" and st["Typo Custt"] == "unknown-customer"


def test_process_holds_back_unparseable_rows():
    rows = [Row(1, dt.date(2026, 8, 1), "Cust A", 1000.0),
            Row(2, None, "Cust B", 500.0, error="unreadable date")]
    vouchers, entries, summary = R.process(rows, None, customers=["Cust A", "Cust B"])
    assert summary["n_vouchers"] == 1 and summary["n_error"] == 1


def test_detect_kind_from_note_and_filename():
    from fleet_tally.parse import detect_kind
    fleet_grid = [["Fleet card (XtraPower) settlements — Dr Fleet Card Posting", None, None],
                  ["Date", "Customer Name", "Amount"]]
    tds_grid = [["TDS receivable — Dr TDS RECEIVABLE - DEBTORS", None, None],
                ["Date", "Customer Name", "Amount"]]
    plain = [["Date", "Customer Name", "Amount"]]
    assert detect_kind("anything.xlsx", fleet_grid) == "fleet"
    assert detect_kind("anything.xlsx", tds_grid) == "tds"
    # filename alone is enough when the sheet has no note
    assert detect_kind("my TDS aug.xlsx", plain) == "tds"
    assert detect_kind("fleet_aug.xlsx", plain) == "fleet"
    # genuinely ambiguous -> None (fall back to the drop zone)
    assert detect_kind("data.xlsx", plain) is None


def test_parser_finds_columns_any_order():
    grid = [
        ["XtraPower settlements", None, None],
        ["Amount", "Date", "Customer Name"],
        [250000, "15-08-2026", "Shree Shyam Logistics"],
        [None, None, None],
        ["1,00,000", "16/08/2026", "Keshav Minerals"],
    ]
    rows = _rows_from_grid(grid)
    assert len(rows) == 2
    assert rows[0].customer == "Shree Shyam Logistics" and rows[0].amount == 250000.0
    assert rows[0].date == dt.date(2026, 8, 15)
    assert rows[1].amount == 100000.0


# ---- Mappings tab: sheet name -> ledger, posting ledgers, company ----------

def test_alias_posts_to_mapped_ledger_and_clears_unknown():
    rows = [Row(1, dt.date(2026, 8, 1), "SHREE SHYAM LOGISTIC", 100.0)]
    known = ["Shree Shyam Logistics"]
    _, entries, summ = R.process(rows, [], known)
    assert entries[0]["status"] == "unknown-customer"
    v, entries, summ = R.process(rows, [], known,
                                 aliases={R.alias_key(" Shree  Shyam Logistic "):
                                          "Shree Shyam Logistics"})
    assert entries[0]["status"] == "ok" and entries[0]["mapped"]
    assert entries[0]["customer"] == "SHREE SHYAM LOGISTIC"
    assert ("Shree Shyam Logistics", "No", "100.00") in _ledgers(v[0])


def test_posting_ledger_override_and_company():
    v = G.make_journal("fleet", "20260801", "Keshav Minerals", 50.0,
                       posting_ledger="Fleet Card Posting 2027-28")
    leds = _ledgers(v)
    assert ("Fleet Card Posting 2027-28", "Yes", "-50.00") in leds
    assert G.voucher_balances(v)
    env = G.build_envelope([v], "VRIDDHI FUELS (2027-28)")
    assert "<SVCURRENTCOMPANY>VRIDDHI FUELS (2027-28)</SVCURRENTCOMPANY>" in env
    assert G.DEFAULT_COMPANY in G.build_envelope([v])


def test_fleet_mapping_ops_store_locally(tmp_path, monkeypatch):
    import pytest
    from fleet_tally import server as SV
    monkeypatch.setattr(SV, "DATA_PATH", str(tmp_path / "data.json"))
    monkeypatch.setattr(SV, "_UPLOADED_LEDGERS", [str(tmp_path / "ledgers.json")])
    SV.mapping_op({"op": "set_alias", "name": "Ember Coal Benefication",
                   "ledger": "My Customer Ltd", "allow_unknown": True})
    SV.mapping_op({"op": "posting", "kind": "tds", "ledger": "TDS X",
                   "allow_unknown": True})
    d = SV.load_data()
    assert d["aliases"] == {"ember coal benefication": "My Customer Ltd"}
    assert d["posting"] == {"tds": "TDS X"}
    with pytest.raises(SV.MappingError) as ei:
        SV.mapping_op({"op": "set_alias", "name": "Some Name", "ledger": "Unknown Ledger"})
    assert ei.value.extra.get("unknown_ledger")
    SV.mapping_op({"op": "delete_alias", "key": "ember coal benefication"})
    SV.mapping_op({"op": "posting", "kind": "tds", "ledger": ""})   # back to default
    assert SV.load_data()["aliases"] == {} and SV.load_data()["posting"] == {}


def test_master_upload_shared_and_used_for_unknown_check(tmp_path, monkeypatch):
    from fleet_tally import server as SV
    mine, other = tmp_path / "fleet.json", tmp_path / "bank.json"
    monkeypatch.setattr(SV, "LEDGERS_PATH", str(mine))
    monkeypatch.setattr(SV, "_UPLOADED_LEDGERS", [str(mine), str(other)])
    xml = ('<ENVELOPE><LEDGER NAME="Brand New Customer &amp; Co"></LEDGER>'
           '<LEDGER NAME="Keshav Minerals"></LEDGER></ENVELOPE>')
    names = SV.parse_master_xml(b"\xff\xfe" + xml.encode("utf-16-le"))
    assert names == ["Brand New Customer & Co", "Keshav Minerals"]
    SV.save_ledgers(names)
    other.write_text('["Uploaded In Bank App"]')
    led = SV.tally_ledgers()
    assert "Brand New Customer & Co" in led and "Uploaded In Bank App" in led
    assert SV.n_uploaded_ledgers() == 3
    assert SV._known("brand new customer & co") == "Brand New Customer & Co"


def test_new_customer_kept_as_is_is_no_longer_flagged():
    rows = [Row(1, dt.date(2026, 8, 1), "Brand New Transport Co", 700.0),
            Row(2, dt.date(2026, 8, 2), "brand new  transport co", 300.0)]
    known = ["Keshav Minerals"]
    _, entries, summ = R.process(rows, [], known)
    assert summ["n_unknown"] == 2
    # "New customer" in the app = a mapping of the name to itself.
    _, entries, summ = R.process(rows, [], known,
                                 aliases={R.alias_key("Brand New Transport Co"):
                                          "Brand New Transport Co"})
    assert summ["n_unknown"] == 0 and all(e["status"] == "ok" for e in entries)
