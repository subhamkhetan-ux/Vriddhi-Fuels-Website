"""Customer price memory: the last price per customer/product outlives the vouchers (real PostgreSQL)."""
import json
import pathlib

import pytest

from tests.test_ledger_schema import OWNER, pg  # isolated temporary server, Supabase auth/roles stub
from tests.test_tally_bridge_schema import INSTANCE, TOKEN, lit, pair, tally_object

ROOT = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def db(pg):
    schema = (ROOT / "supabase/tally-schema.sql").read_text()
    pg.ok(schema)
    pg.ok(schema)  # migrations can be rerun
    pg.ok((ROOT / "supabase/tally-bridge.sql").read_text())
    return pg


def save(db, party, rate, date="2026-10-19", series="hsd", rid=None):
    qty, amt = 10, round(rate * 10, 2)
    args = f"{lit(rid) if rid else 'null'},'{series}','{date}',{lit(party)},'',{qty},{rate},{amt},{amt},0"
    return db.json(f"select tally_save_voucher({args});", user=OWNER)


def memory(db, party, series="hsd"):
    out = db.ok(f"select coalesce(json_agg(json_build_array(date::text, rate::float, number) order by date),'[]') "
                f"from tally_customer_prices where party={lit(party)} and series='{series}'")
    return [tuple(r) for r in json.loads(out)]


def test_price_is_remembered_per_customer_product_and_day(db):
    first = save(db, "Price Co", 95.5, "2026-08-01")
    save(db, "Price Co", 96.0, "2026-08-01")              # the day's last invoice wins
    save(db, "Price Co", 101.25, "2026-08-01", series="ms")
    assert memory(db, "Price Co") == [("2026-08-01", 96.0, str(int(first["number"]) + 1))]
    assert memory(db, "Price Co", "ms")[0][1] == 101.25
    later = save(db, "Price Co", 97.0, "2026-09-15")
    assert [r[1] for r in memory(db, "Price Co")] == [96.0, 97.0]
    # an edit of the invoice re-prices its day; moving its date moves the price
    save(db, "Price Co", 98.0, "2026-09-16", rid=later["id"])
    assert memory(db, "Price Co") == [("2026-08-01", 96.0, str(int(first["number"]) + 1)), ("2026-09-16", 98.0, later["number"])]
    # exporting / moving to old vouchers does not touch it
    db.ok(f"select tally_mark_exported(array['{later['id']}']::uuid[])", user=OWNER)
    db.ok("select tally_move_day('2026-09-16')", user=OWNER)
    assert memory(db, "Price Co")[-1] == ("2026-09-16", 98.0, later["number"])
    # correcting an old voucher re-prices it too
    db.ok(f"select tally_edit_history_voucher('{later['id']}','2026-09-16','Price Co','',10,98.5,985,985,0)", user=OWNER)
    assert memory(db, "Price Co")[-1][1] == 98.5


def test_memory_outlives_auto_clear_and_reset_but_not_a_deleted_voucher(db):
    kept = save(db, "Long Gap Ltd", 92.0, "2026-01-10")
    db.ok("select tally_autoclear('2026-06-01')", user=OWNER)
    assert db.ok(f"select count(*) from tally_vouchers where id='{kept['id']}'") == "0"
    assert memory(db, "Long Gap Ltd") == [("2026-01-10", 92.0, kept["number"])]
    save(db, "Reset Ltd", 93.0, "2026-10-20")
    db.ok("select tally_reset_vouchers()", user=OWNER)
    assert memory(db, "Reset Ltd")[0][1] == 93.0 and memory(db, "Long Gap Ltd")[0][1] == 92.0
    # a voucher deleted by hand (a mistake) takes its price with it
    wrong = save(db, "Oops Ltd", 50.0, "2026-10-21")
    db.ok(f"select tally_delete_voucher('{wrong['id']}')", user=OWNER)
    assert memory(db, "Oops Ltd") == []


def test_daybook_import_and_tally_deletion_keep_the_memory_in_step(db):
    rows = [dict(seriesKey="xg", number=f"XG{n}", dateISO=d, party="Imported Co", vehicle="", qty=10, rate=r, amount=r * 10)
            for n, d, r in ((501, "2026-04-02", 104.0), (502, "2026-04-02", 105.0), (503, "2026-05-07", 106.5))]
    db.json(f"select tally_import_daybook({lit(json.dumps(rows))})", user=OWNER)
    assert memory(db, "Imported Co", "xg") == [("2026-04-02", 105.0, "XG502"), ("2026-05-07", 106.5, "XG503")]
    # the bridge: an invoice cancelled in Tally gives back the earlier price of the day
    pair(db)
    a = dict(series="xg", number="XG502", date="2026-04-02", party="Imported Co", vehicle="", qty=10, rate=105, item_amt=1050, party_amt=1050, roff=0)
    o = tally_object("price-guid", a)
    db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([o]))})", anon=True)
    o["alter_id"], o["deleted"] = 2, True
    db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([o]))})", anon=True)
    assert db.ok("select bridge_state from tally_vouchers where number='XG502'") == "deleted"
    assert memory(db, "Imported Co", "xg")[0] == ("2026-04-02", 104.0, "XG501")
    # a re-run of the schema keeps what is remembered
    db.ok((ROOT / "supabase/tally-schema.sql").read_text())
    assert memory(db, "Imported Co", "xg")[0] == ("2026-04-02", 104.0, "XG501")
    # signed-in users read it; nobody writes it directly
    assert db.ok("select count(*) > 0 from tally_customer_prices", user=OWNER) == "t"
    assert "row-level security" in db.fails("insert into tally_customer_prices values ('X','hsd','2026-01-01',1,'1')", user=OWNER)
    assert db.ok("select count(*) from tally_customer_prices", anon=True) == "0"   # RLS: nothing for the signed-out


def test_an_earlier_invoice_imported_later_does_not_override_the_days_last_price(db):
    def imp(number, rate):
        row = dict(seriesKey="ms", number=number, dateISO="2026-06-10", party="Order Co", vehicle="", qty=10, rate=rate, amount=rate * 10)
        db.json(f"select tally_import_daybook({lit(json.dumps([row]))})", user=OWNER)
    imp("MS801", 108.0)
    imp("MS800", 107.0)
    assert memory(db, "Order Co", "ms") == [("2026-06-10", 108.0, "MS801")]
    # re-pricing the day's last invoice follows it
    imp("MS801", 108.5)
    assert memory(db, "Order Co", "ms") == [("2026-06-10", 108.5, "MS801")]


def test_master_import_keeps_what_tally_prints_on_the_customers_vouchers(db):
    parties = [{"name": "Sample Customer A Private Limited", "gstin": "21ZZZZZ1000Z1Z0", "regType": "Regular", "state": "Odisha",
                "place": "Odisha", "pincode": "700001", "country": "India", "address": ["Plot 1", "Demo Road"],
                "pan": "ZZZZZ1000Z", "vatDealerType": "Regular"},
               {"name": "Walk-in Buyer", "address": [], "pan": ""}]
    db.json(f"select tally_import_master({lit(json.dumps(parties))})", user=OWNER)
    a = db.json("select to_jsonb(p) from tally_parties p where name='Sample Customer A Private Limited'")
    assert a["address"] == ["Plot 1", "Demo Road"] and a["pan"] == "ZZZZZ1000Z" and a["vat_dealer_type"] == "Regular"
    b = db.json("select to_jsonb(p) from tally_parties p where name='Walk-in Buyer'")
    assert b["address"] is None and b["pan"] is None
