"""Cash fuel sales (MS / HSD / XG) -> Tally Sales vouchers (fleet_tally/cash.py)."""

import base64
import datetime as dt
import re
from decimal import Decimal

import pytest

from fleet_tally import cash as K


def _field(v, tag):
    return re.search(rf"<{tag}>([^<]*)</{tag}>", v).group(1)


def _norm(v):
    v = K._strip_identity(v)
    v = re.sub(r"<NUMBERINGSTYLE>[^<]*</NUMBERINGSTYLE>", "", v)
    return [line.strip() for line in v.splitlines() if line.strip()]


@pytest.mark.parametrize("prod", ["MS", "HSD", "XG"])
def test_template_regenerates_itself_exactly(prod):
    # Each template is a real exported voucher; rebuilding it from its own date,
    # quantity, price and number must give the same voucher.
    tpl = K._read_template(K.PRODUCTS[prod]["file"])
    date = _field(tpl, "DATE")
    qty = Decimal(_field(tpl, "ACTUALQTY").split()[0])
    rate = Decimal(_field(tpl, "RATE").split("/")[0])
    gen = K.make_cash_sale(prod, date, qty, rate, _field(tpl, "VOUCHERNUMBER"))
    k = K.PRODUCTS[prod]
    # MS is imported as its own type "Cash MS"; otherwise identical to the real one.
    gen = gen.replace(f'"{k["vchtype"]}"', f'"{k.get("tpl_vchtype", k["vchtype"])}"') \
             .replace(f'>{k["vchtype"]}<', f'>{k.get("tpl_vchtype", k["vchtype"])}<')
    assert _norm(gen) == _norm(tpl)


def test_ms_is_imported_as_cash_ms_not_ms_cash():
    v = K.make_cash_sale("MS", "20261001", Decimal("10"), Decimal("109.01"), "Cash/MS/1Oct2026")
    assert 'VCHTYPE="Cash MS"' in v
    assert _field(v, "VOUCHERTYPENAME") == "Cash MS" == _field(v, "VCHSTATUSVOUCHERTYPE")
    assert "MS Cash" not in v                      # the hand-entered type is never touched


def test_cash_ms_number_is_the_date():
    assert K.voucher_number("MS", dt.date(2026, 10, 1)) == "Cash/MS/1Oct2026"
    assert K.voucher_number("MS", dt.date(2026, 12, 25)) == "Cash/MS/25Dec2026"
    assert K.voucher_number("MS", dt.date(2027, 3, 9)) == "Cash/MS/9Mar2027"
    assert K.voucher_number("HSD", dt.date(2026, 10, 1)) == "Cash/HSD/1Oct2026"
    assert K.voucher_number("XG", dt.date(2026, 11, 30)) == "Cash/XG/30Nov2026"


def test_cash_sale_fields_and_balance():
    v = K.make_cash_sale("MS", "20261005", Decimal("250.500"), Decimal("109.01"), "Cash/MS/5Oct2026")
    assert _field(v, "DATE") == "20261005" and _field(v, "EFFECTIVEDATE") == "20261005"
    assert _field(v, "VOUCHERNUMBER") == "Cash/MS/5Oct2026"
    assert _field(v, "VOUCHERTYPENAME") == "Cash MS"
    assert _field(v, "NUMBERINGSTYLE") == "Automatic (Manual Override)"
    assert _field(v, "STOCKITEMNAME") == "Motor Spirit"
    assert v.count("<ACTUALQTY> 250.500 LTR</ACTUALQTY>") == 2      # line + batch
    assert "<RATE>109.01/LTR</RATE>" in v
    amt = "27307.01"                                                # 250.5 x 109.01 = 27307.005
    assert v.count(f"<AMOUNT>{amt}</AMOUNT>") == 3                 # line, batch, SALE (MS)
    assert f"<AMOUNT>-{amt}</AMOUNT>" in v                         # Dr Cash
    assert "<LEDGERNAME>SALE (MS)</LEDGERNAME>" in v and K.cash_balances(v)
    for tag in ("GUID", "ALTERID", "MASTERID", "VOUCHERKEY", "VOUCHERRETAINKEY"):
        assert f"<{tag}>" not in v
    assert "REMOTEID=" not in v and "VCHKEY=" not in v


def test_amount_rounds_half_up_like_the_books():
    v = K.make_cash_sale("HSD", "20261001", Decimal("0.5"), Decimal("100.01"), "Cash/HSD/1Oct2026")
    assert "<AMOUNT>50.01</AMOUNT>" in v           # 50.005 -> 50.01 (not banker's 50.00)
    assert "<RATE>100.01/LTR</RATE>" in v
    v = K.make_cash_sale("XG", "20261001", Decimal("1"), Decimal("106.345"), "Cash/XG/1Oct2026")
    assert "<RATE>106.345/LTR</RATE>" in v and "<AMOUNT>106.35</AMOUNT>" in v
    assert "<LEDGERNAME>SALE (HSD)</LEDGERNAME>" in v      # XG posts to SALE (HSD), as in the books


def _workbook(tmp_path, tabs):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, rows in tabs.items():
        ws = wb.create_sheet(name)
        ws.append([f"Cash sales — {name}"])
        ws.append([])
        ws.append(["Date", "Quantity (LTR)", "Price (Rs/LTR)"])
        for r in rows:
            ws.append(r)
    p = tmp_path / "cash.xlsx"
    wb.save(str(p))
    return str(p)


def test_workbook_rows_and_checks(tmp_path):
    p = _workbook(tmp_path, {
        "MS": [[dt.date(2026, 10, 2), 120.5, 109.01], [dt.date(2026, 10, 1), 356.67, 109.01]],
        "Diesel": [["03/10/2026", "29.5", "100.74"], ["04/10/2026", 0, 100.74],
                   ["05/10/2026", 10, 30000], ["bad", 1, 100]],
        "XG": [],
        "Notes": [],
    })
    rows, problems = K.read_workbook(p)
    by = {(r.product, r.index): r for r in rows}
    assert by[("MS", 2)].qty == Decimal("356.67") and by[("MS", 2)].price == Decimal("109.01")
    assert by[("HSD", 1)].date == dt.date(2026, 10, 3) and not by[("HSD", 1)].error
    assert "more than zero" in by[("HSD", 2)].error
    assert "looks wrong" in by[("HSD", 3)].error         # the day's total typed as price
    assert "date" in by[("HSD", 4)].error
    # A tab with content but no recognisable product is reported, not guessed.
    assert problems == ["sheet 'Notes': can't tell the product — name the tab MS, HSD or XG"]


def test_every_product_numbered_by_its_date(tmp_path):
    p = _workbook(tmp_path, {
        "MS": [[dt.date(2026, 10, 2), 100, 109.01], [dt.date(2026, 10, 1), 200, 109.01]],
        "HSD": [[dt.date(2026, 10, 1), 50, 100.74], [dt.date(2026, 10, 3), 10, 100.74]],
        "XG": [[dt.date(2026, 10, 3), 5, 106.34]],
    })
    rows, _ = K.read_workbook(p)
    vouchers, entries, summary = K.process(rows)
    nos = {(e["product"], e["date"]): e["voucher_no"] for e in entries}
    assert nos == {("MS", "01-10-2026"): "Cash/MS/1Oct2026", ("MS", "02-10-2026"): "Cash/MS/2Oct2026",
                   ("HSD", "01-10-2026"): "Cash/HSD/1Oct2026", ("HSD", "03-10-2026"): "Cash/HSD/3Oct2026",
                   ("XG", "03-10-2026"): "Cash/XG/3Oct2026"}
    assert all(e["status"] == "ok" for e in entries)
    # Same date, different products -> different numbers, each in its own type.
    assert [_field(v, "VOUCHERTYPENAME") for v in vouchers] == \
        ["Cash MS", "Cash MS", "HSD CASH", "HSD CASH", "XG CASH"]
    assert summary["products"]["MS"]["first"] == "Cash/MS/1Oct2026"
    assert summary["products"]["HSD"]["last"] == "Cash/HSD/3Oct2026"
    assert summary["n_vouchers"] == 5 and summary["all_balance"]
    assert summary["products"]["MS"]["total_amount"] == "32703.00"             # 300 x 109.01


@pytest.mark.parametrize("prod", ["MS", "HSD", "XG"])
def test_two_rows_on_one_day_cannot_share_a_number(tmp_path, prod):
    p = _workbook(tmp_path, {prod: [[dt.date(2026, 10, 1), 100, 104.5],
                                    [dt.date(2026, 10, 1), 20, 104.5],
                                    [dt.date(2026, 10, 2), 50, 104.5]]})
    rows, _ = K.read_workbook(p)
    vouchers, entries, summary = K.process(rows)
    assert [e["voucher_no"] for e in entries] == [f"Cash/{prod}/1Oct2026", "", f"Cash/{prod}/2Oct2026"]
    assert entries[1]["status"] == "error" and "combine" in entries[1]["note"]
    assert len(vouchers) == 2


def test_server_cash_run_writes_xml(tmp_path, monkeypatch):
    from fleet_tally import server as SV
    monkeypatch.setattr(SV, "DATA_PATH", str(tmp_path / "data.json"))
    monkeypatch.setattr(SV, "OUT_DIR", str(tmp_path / "out"))
    p = _workbook(tmp_path, {"MS": [[dt.date(2026, 10, 1), 100, 109.01]],
                             "HSD": [[dt.date(2026, 10, 1), 30, 100.74]]})
    b64 = "data:;base64," + base64.b64encode(open(p, "rb").read()).decode()
    res = SV.run_cash({"name": "cash.xlsx", "b64": b64})
    assert res["summary"]["n_vouchers"] == 2
    xml = open(tmp_path / "out" / "cash_sales.xml", encoding="utf-8").read()
    assert "<VOUCHERNUMBER>Cash/MS/1Oct2026</VOUCHERNUMBER>" in xml and 'VCHTYPE="Cash MS"' in xml
    assert "<VOUCHERNUMBER>Cash/HSD/1Oct2026</VOUCHERNUMBER>" in xml and "<TALLYMESSAGE" in xml
    assert 'VCHTYPE="HSD CASH"' in xml
    assert set(SV.cash_view()["products"]) == {"MS", "HSD", "XG"}
