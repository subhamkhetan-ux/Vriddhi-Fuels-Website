"""Real PostgreSQL tests for device capabilities and financial outbox transitions."""
import json
import pathlib
import uuid

import pytest

from tests.test_ledger_schema import OWNER, pg  # isolated temporary server, Supabase auth/roles stub

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOKEN = "a" * 64
INSTANCE = str(uuid.UUID(int=42))
COMPANY_GUID = "company-guid-12345678"


def lit(x):
    return "'" + str(x).replace("'", "''") + "'"


@pytest.fixture(scope="module")
def db(pg):
    pg.ok((ROOT / "supabase/tally-schema.sql").read_text())
    sql = (ROOT / "supabase/tally-bridge.sql").read_text()
    pg.ok(sql)
    pg.ok(sql)  # migrations can be rerun
    return pg


def device(db, fn, args=""):
    return db.json(f"select tally_bridge_{fn}('{TOKEN}','{INSTANCE}'{',' if args else ''}{args});", anon=True)


def create(db, number=None):
    args = "null,'hsd','2026-10-19','Test Debtor','OD01A1234',10,100,1000,1000,0"
    return db.json("select tally_save_voucher(" + args + ");", user=OWNER)


def edit(db, rid, amount=1100):
    return db.json(f"select tally_save_voucher('{rid}','hsd','2026-10-19','Test Debtor','OD01A1234',10,{amount/10},{amount},{amount},0);", user=OWNER)


def pair(db):
    code = db.json("select tally_bridge_pair_code();", user=OWNER)["code"]
    result = db.json(f"select tally_bridge_pair('{code}','{TOKEN}','VRIDDHI FUELS (2026-27)','{COMPANY_GUID}','Test PC');", anon=True)
    device(db, "heartbeat", "'online','','test'")
    db.ok(f"select tally_bridge_ready('{TOKEN}','{INSTANCE}');", anon=True)
    return code, result


def test_capabilities_and_pairing(db):
    assert "permission denied" in db.fails("select * from tally_bridge_devices", user=OWNER)
    assert "permission denied" in db.fails("select * from tally_bridge_jobs", anon=True)
    assert "permission denied" in db.fails("select _tb_hash('secret')", anon=True)
    assert "permission denied" in db.fails("select tally_bridge_pair_code()", anon=True)
    code, result = pair(db)
    assert result["company_guid"] == COMPANY_GUID
    assert "expired or used" in db.fails(f"select tally_bridge_pair('{code}','{'b'*64}','VRIDDHI FUELS (2026-27)','{COMPANY_GUID}','Other PC');", anon=True)
    assert "credential invalid" in db.fails(f"select tally_bridge_claim('wrong','{INSTANCE}');", anon=True)
    assert "Another bridge" in db.fails(f"select tally_bridge_heartbeat('{TOKEN}','{uuid.uuid4()}','online','','test')", anon=True)
    assert "Company is paired" in db.fails("update tally_settings set company='Other'", user=None)


def test_financial_year_company_uses_indian_april_boundary(db):
    # Transaction rollback retains the paired state for the following outbox tests.
    result = db.ok("""begin;
        update tally_bridge_config set active=false where id=1;
        update tally_settings set company='VRIDDHI FUELS ( 2026 - 27 )',company_fy=true where id=1;
        select jsonb_build_array(_tb_company_for_date('2026-03-31'),_tb_company_for_date('2026-04-01'));
        rollback;""")
    assert '["VRIDDHI FUELS (2025-26)", "VRIDDHI FUELS (2026-27)"]' in result
    assert "Financial-year naming is locked" in db.fails("update tally_settings set company_fy=not company_fy where id=1")


def test_outbox_is_atomic_and_edits_supersede_only_unwritten_jobs(db):
    v = create(db)
    j = device(db, "claim")
    assert j["voucher_id"] == v["id"] and not j["recover_only"]
    edit(db, v["id"])
    assert "Voucher changed" in db.fails(f"select tally_bridge_begin_write('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}')", anon=True)
    j = device(db, "claim")
    assert j["revision"] == 2 and j["payload"]["item_amt"] == 1100
    db.ok(f"select tally_bridge_begin_write('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}')", anon=True)
    assert "confirming" in db.fails(f"select tally_save_voucher('{v['id']}','hsd','2026-10-19','Test Debtor','',10,120,1200,1200,0)", user=OWNER)
    assert "bridge history" in db.fails(f"select tally_delete_voucher('{v['id']}')", user=OWNER)
    db.ok(f"update tally_bridge_jobs set lease_until=now()-interval '1 minute' where id='{j['id']}'")
    recovered = device(db, "claim")
    assert recovered["recover_only"] and recovered["state"] == "writing"
    assert recovered["lease_token"] != j["lease_token"]
    result = json.dumps({"guid": "voucher-guid-1", "alter_id": 40})
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{recovered['lease_token']}','done',{lit(result)},'')", anon=True)
    # Lost ACK can be retried, and does not create another job or voucher.
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{recovered['lease_token']}','done',{lit(result)},'')", anon=True)
    assert db.json(f"select to_jsonb(v) from tally_vouchers v where id='{v['id']}'")["bridge_state"] == "synced"


def daybook(db, *rows):
    vouchers = [dict(seriesKey=r.get("series", "ms"), number=r["number"], dateISO="2026-10-19", party=r.get("party", "A"),
                     vehicle="", qty=10, rate=100, amount=r.get("amount", 1000)) for r in rows]
    return db.json(f"select tally_import_daybook({lit(json.dumps(vouchers))})", user=OWNER)


def tally_object(guid, a, alter=1, **extra):
    vt = {"hsd": "HSD CREDIT", "ms": "MS CREDIT", "xg": "XG CREDIT"}[a["series"]]
    return dict(kind="Voucher", guid=guid, alter_id=alter, master_id=1,
                data={"voucher_type": vt, "number": a["number"], "app_voucher": a}, **extra)


def test_inbound_and_conflict_do_not_overwrite_pending_edit(db):
    a = dict(series="ms", number="MS9999", date="2026-10-19", party="A", vehicle="", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0)
    daybook(db, dict(number="MS9999"))
    o = tally_object("inbound-guid", a)
    def ingest():
        o["data"]["number"] = a["number"]
        db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([o]))})", anon=True)
    ingest()
    v = db.json("select to_jsonb(v) from tally_vouchers v where bridge_guid='inbound-guid'")
    assert v["status"] == "history" and v["bridge_state"] == "synced"
    assert db.ok(f"select count(*) from tally_bridge_jobs where voucher_id='{v['id']}'") == "0"
    db.ok(f"select tally_edit_history_voucher('{v['id']}','2026-10-19','Local edit','',10,100,1000,1000,0)", user=OWNER)
    o["alter_id"] = 2
    a["party"] = "Tally edit"
    ingest()
    v = db.json("select to_jsonb(v) from tally_vouchers v where bridge_guid='inbound-guid'")
    assert v["party"] == "Local edit" and v["bridge_state"] == "conflict"
    db.ok(f"select tally_bridge_control('use_tally','{v['id']}')", user=OWNER)
    assert 'Resolve this voucher' in db.fails(f"select tally_edit_history_voucher('{v['id']}','2026-10-19','Racing edit','',10,100,1000,1000,0)",user=OWNER)
    ingest()
    v = db.json("select to_jsonb(v) from tally_vouchers v where bridge_guid='inbound-guid'")
    assert v["party"] == "Tally edit" and v["bridge_state"] == "synced"
    a['number']='MS10000'; o['alter_id']=3
    ingest()
    assert db.ok("select number from tally_vouchers where bridge_guid='inbound-guid'")=='MS10000'
    daybook(db, dict(number='MS10001'))
    other = tally_object('another-inbound-guid', dict(a,number='MS10001'), alter=3)
    db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([other]))})",anon=True)
    a['number']='MS10001'; o['alter_id']=4
    ingest()
    v = db.json("select to_jsonb(v) from tally_vouchers v where bridge_guid='inbound-guid'")
    assert v['number']=='MS10000' and v['bridge_state']=='unsupported'
    assert db.ok("select number from tally_vouchers where bridge_guid='another-inbound-guid'")=='MS10001'
    a['number']='MS10002'; o['alter_id']=5
    ingest()
    assert db.ok("select number from tally_vouchers where bridge_guid='inbound-guid'")=='MS10002'
    o["deleted"] = True
    ingest()
    assert db.ok("select bridge_state from tally_vouchers where bridge_guid='inbound-guid'") == "deleted"
    o["alter_id"] = 1
    assert "moved backwards" in db.fails(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([o]))})", anon=True)


def test_voucher_made_in_tally_joins_the_app_and_masters_are_ignored(db):
    a = dict(series="hsd", number="88001", date="2026-10-19", party="Tally only", vehicle="OD01", qty=10, rate=100, item_amt=999.8, party_amt=1000, roff=0.2)
    master = dict(kind="Ledger", guid="ledger-guid", alter_id=1, master_id=2, data={"name": "Old bridge master", "is_debtor": True})
    db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([tally_object('tally-only-guid', a), master]))})", anon=True)
    v = db.json("select to_jsonb(v) from tally_vouchers v where number='88001'")
    assert v["source"] == "tally" and v["status"] == "history" and v["bridge_guid"] == "tally-only-guid"
    assert v["bridge_state"] == "synced" and float(v["roff"]) == 0.2 and v["vehicle"] == "OD01"
    assert db.ok("select baseline from tally_series where key='hsd'") == "88001"
    assert db.ok("select count(*) from tally_parties where name='Tally only'") == "1"  # usable for bills at once
    assert db.ok("select count(*) from tally_parties where name='Old bridge master'") == "0"
    assert db.ok("select count(*) from tally_bridge_objects where kind<>'Voucher'") == "0"
    assert db.ok(f"select count(*) from tally_bridge_jobs where voucher_id='{v['id']}'") == "0"
    # Import from Tally keeps the bridge's exact copy and posts nothing.
    result = daybook(db, dict(series="hsd", number="88001", party="Stale file", amount=500), dict(series="hsd", number="88002"))
    assert result["kept"] == 1 and result["added"]["hsd"] == 1
    assert db.ok("select party from tally_vouchers where number='88001'") == "Tally only"
    assert db.ok("select bridge_state from tally_vouchers where number='88002'") == "unlinked"
    assert db.ok("select count(*) from tally_bridge_jobs j join tally_vouchers v on v.id=j.voucher_id where v.number in ('88001','88002')") == "0"


def test_posted_voucher_flagged_for_review_is_confirmed_when_tally_matches(db):
    db.ok("update tally_bridge_jobs set state='superseded' where state in ('pending','leased')")
    v = create(db)
    j = device(db, "claim")
    db.ok(f"select tally_bridge_begin_write('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}')", anon=True)
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}','conflict','{{}}','Tally read-back does not match')", anon=True)
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "conflict"
    a = dict(series="hsd", number=v["number"], date="2026-10-19", party="TEST DEBTOR", vehicle="", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0)
    db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([tally_object('posted-guid', a, alter=80068)]))})", anon=True)
    row = db.json(f"select to_jsonb(v) from tally_vouchers v where id='{v['id']}'")
    assert row["bridge_state"] == "synced" and row["bridge_guid"] == "posted-guid" and row["bridge_alter"] == 80068
    assert db.ok(f"select state from tally_bridge_jobs where id='{j['id']}'") == "done"


def test_first_sync_metadata_links_without_changing_values_and_alterations_fetch_details(db):
    daybook(db, dict(series="xg", number="XG7001", party="Kept party", amount=1000))
    light = dict(kind="Voucher", guid="light-guid", alter_id=7, master_id=9,
                 data={"light": True, "voucher_type": "XG CREDIT", "number": "XG7001", "date": "20261019", "cancelled": False})
    send = lambda o: db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([o]))})", anon=True)
    send(light)
    v = db.json("select to_jsonb(v) from tally_vouchers v where number='XG7001'")
    assert v["bridge_guid"] == "light-guid" and v["bridge_alter"] == 7 and v["bridge_state"] == "synced" and v["party"] == "Kept party"
    send(dict(light, alter_id=8))  # altered while unwatched: details are requested
    assert db.ok("select bridge_state from tally_vouchers where number='XG7001'") == "awaiting_tally"
    assert "light-guid" in device(db, "heartbeat", "'online','','test'")["refresh_guids"]
    a = dict(series="xg", number="XG7001", date="2026-10-19", party="Tally party", vehicle="", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0)
    send(tally_object("light-guid", a, alter=8))
    v = db.json("select to_jsonb(v) from tally_vouchers v where number='XG7001'")
    assert v["party"] == "Tally party" and v["bridge_state"] == "synced"
    send(dict(light, alter_id=8))  # a light resend never replaces the details
    assert db.json("select data from tally_bridge_objects where guid='light-guid'")["app_voucher"]["party"] == "Tally party"
    # Import after the bridge saw only metadata: linked by type and number at once.
    send(dict(light, guid="light-guid-2", data=dict(light["data"], number="XG7002")))
    assert daybook(db, dict(series="xg", number="XG7002"))["added"]["xg"] == 1
    assert db.ok("select bridge_guid from tally_vouchers where number='XG7002'") == "light-guid-2"


def test_reports_deduplicate_and_retain_old_result_while_offline(db):
    sql = "select tally_bridge_report('daybook','2026-10-01','2026-10-19','',true)"
    r = db.json(sql, user=OWNER)
    assert r["state"] == "pending" and r["content"] is None
    db.json(sql, user=OWNER)
    assert db.ok(f"select count(*) from tally_bridge_jobs where payload->>'key'='{r['key']}'") == "1"
    j = device(db, "claim")
    assert j["kind"] == "report"
    content = json.dumps({"content": "<table><tr><td>Example</td></tr></table>"})
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}','done',{lit(content)},'')", anon=True)
    r = db.json(sql, user=OWNER)
    assert r["state"] == "pending" and "Example" in r["content"] and r["fetched_at"]
    assert "Invalid report" in db.fails("select tally_bridge_report('arbitrary','2026-10-01','2026-10-19')", user=OWNER)
    assert "Invalid report" in db.fails("select tally_bridge_report('ledger','2026-10-01','2026-10-19',null)", user=OWNER)


def test_prewrite_failure_can_be_edited_and_renumbered_but_uncertain_write_cannot(db):
    # Isolate this scenario from the intentionally pending report in the previous test.
    db.ok("update tally_bridge_jobs set state='superseded' where kind='report' and state='pending'")
    v=create(db); j=device(db,'claim')
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}','conflict','{{}}','Missing master')",anon=True)
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'")=='needs_edit'
    db.ok(f"select tally_bridge_control('renumber','{v['id']}')",user=OWNER)
    row=db.json(f"select to_jsonb(v) from tally_vouchers v where id='{v['id']}'")
    assert row['number']!=v['number'] and row['bridge_state']=='queued'
    j=device(db,'claim')
    db.ok(f"select tally_bridge_begin_write('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}')",anon=True)
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}','conflict','{{}}','Uncertain outcome')",anon=True)
    assert 'may have reached Tally' in db.fails(f"select tally_bridge_control('retry','{v['id']}')",user=OWNER)
    assert 'never been posted' in db.fails(f"select tally_bridge_control('renumber','{v['id']}')",user=OWNER)


def test_base_schema_rerun_keeps_device_grants_and_manual_import_guard(db):
    db.ok((ROOT/'supabase/tally-schema.sql').read_text())
    device(db,'heartbeat',"'online','','test'")
    assert 'Worker instance' in db.fails(f"select tally_bridge_claim('{TOKEN}',null)",anon=True)
    assert db.json("select tally_import_daybook('[]')",user=OWNER)['kept'] == 0  # Import from Tally works while paired
    assert 'permission denied' in db.fails("select tally_bridge_object('Voucher','inbound-guid')",anon=True)
    assert db.json("select tally_bridge_object('Voucher','inbound-guid')",user=OWNER)['guid']=='inbound-guid'


def test_revoke_stops_all_device_access(db):
    db.ok("select tally_bridge_control('revoke')", user=OWNER)
    assert "credential invalid" in db.fails(f"select tally_bridge_claim('{TOKEN}','{INSTANCE}')", anon=True)
