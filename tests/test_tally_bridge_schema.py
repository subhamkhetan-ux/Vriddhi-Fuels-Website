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
    o["alter_id"], o["deleted"] = 1, False
    # An older Tally version (a restore) is refused for that voucher only, and reported back.
    result = db.json(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([o, tally_object('next-guid', dict(a, number='MS10003'))]))})", anon=True)
    assert len(result["rejected"]) == 1 and "moved backwards" in result["rejected"][0]["error"]
    assert db.ok("select bridge_state from tally_vouchers where bridge_guid='inbound-guid'") == "deleted"
    assert db.ok("select count(*) from tally_vouchers where bridge_guid='next-guid'") == "1"


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


def test_failed_readback_takes_tallys_invoice_and_unreadable_edits_say_why(db):
    db.ok("update tally_bridge_jobs set state='superseded' where state in ('pending','leased')")
    v = create(db)
    j = device(db, "claim")
    db.ok(f"select tally_bridge_begin_write('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}')", anon=True)
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}','conflict','{{}}','Invoice could not be read yet')", anon=True)
    send = lambda o: db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([o]))})", anon=True)
    a = dict(series="hsd", number=v["number"], date="2026-10-19", party="Changed in Tally", vehicle="", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0)
    o = tally_object("readback-guid", a, alter=5)
    send(o)  # differs from the web copy: the uncertain posting stays for review
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "conflict"
    # "Use Tally version" on a posting never linked takes the invoice Tally holds under its number.
    db.ok(f"select tally_bridge_control('use_tally','{v['id']}')", user=OWNER)
    row = db.json(f"select to_jsonb(v) from tally_vouchers v where id='{v['id']}'")
    assert row["bridge_guid"] == "readback-guid" and row["bridge_state"] == "awaiting_tally"
    assert "readback-guid" in device(db, "heartbeat", "'online','','test'")["refresh_guids"]
    send(o)
    row = db.json(f"select to_jsonb(v) from tally_vouchers v where id='{v['id']}'")
    assert row["bridge_state"] == "synced" and row["party"] == "Changed in Tally"
    # An edit the app cannot hold is labelled with Tally's reason, and can be read again.
    unreadable = dict(o, alter_id=6, data=dict(o["data"], app_voucher=None, unreadable="Extra ledger in Tally: Freight"))
    send(unreadable)
    row = db.json(f"select to_jsonb(v) from tally_vouchers v where id='{v['id']}'")
    assert row["bridge_state"] == "unsupported" and row["bridge_note"] == "Extra ledger in Tally: Freight"
    db.ok(f"select tally_bridge_control('use_tally','{v['id']}')", user=OWNER)
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "awaiting_tally"
    send(dict(o, alter_id=7))  # corrected in Tally
    row = db.json(f"select to_jsonb(v) from tally_vouchers v where id='{v['id']}'")
    assert row["bridge_state"] == "synced" and row["bridge_note"] is None
    # Vouchers older bridges marked unsupported (no reason) are read again after the SQL rerun.
    db.ok(f"update tally_vouchers set bridge_state='unsupported' where id='{v['id']}'")
    db.ok((ROOT / "supabase/tally-bridge.sql").read_text())
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "awaiting_tally"
    send(dict(o, alter_id=8))
    assert "Only a voucher that needs review" in db.fails(f"select tally_bridge_control('use_tally','{v['id']}')", user=OWNER)


def test_deleted_or_retyped_in_tally_leaves_the_app_and_a_return_restores_it(db):
    send = lambda *o: db.json(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps(list(o)))})", anon=True)
    state = lambda n: db.json(f"select jsonb_build_object('state',bridge_state,'note',bridge_note) from tally_vouchers where number='{n}'")
    a = dict(series="hsd", number="77001", date="2026-10-19", party="Gone Co", vehicle="", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0)
    o = tally_object("gone-guid", a, alter=3)
    send(o)
    assert state("77001")["state"] == "synced"
    # Deleted in Tally: the PC sends what it stored, marked deleted.
    send(dict(o, deleted=True))
    assert state("77001") == {"state": "deleted", "note": "Deleted in Tally"}
    send(dict(o, alter_id=4))  # back in Tally (a deletion undone by a restore of the same day)
    assert state("77001")["state"] == "synced"
    # A deletion the PC found by GUID without a stored copy keeps the cloud's data.
    send(dict(kind="Voucher", guid="gone-guid", alter_id=0, master_id=0, data={}, deleted=True))
    assert state("77001") == {"state": "deleted", "note": "Deleted in Tally"}
    assert db.json("select data from tally_bridge_objects where guid='gone-guid'")["number"] == "77001"
    send(dict(o, alter_id=5))
    # Changed to another voucher type in Tally (a cash sale): no longer a fuel voucher here.
    send(dict(o, alter_id=6, deleted=True, data=dict(o["data"], voucher_type="Sales", app_voucher=None)))
    assert state("77001") == {"state": "deleted", "note": "Moved to Sales in Tally"}


def test_postings_that_never_reached_tally_go_back_to_the_queue_or_can_be_corrected(db):
    db.ok("update tally_bridge_jobs set state='superseded' where state in ('pending','leased','error','conflict')")
    finish = lambda j, state, result, detail: db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}','{state}',{lit(json.dumps(result))},{lit(detail)})", anon=True)
    begin = lambda j: db.ok(f"select tally_bridge_begin_write('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}')", anon=True)
    v = create(db)
    # The company was closed between the check and the posting: nothing was sent.
    j = device(db, "claim"); begin(j)
    finish(j, "retry", {"not_written": True}, "Waiting for the company")
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "queued"
    assert db.ok(f"select state||','||write_started from tally_bridge_jobs where id='{j['id']}'") == "pending,false"
    # Tally refused it (and the PC confirmed nothing changed): correctable, retried by itself later.
    j = device(db, "claim"); begin(j)
    finish(j, "error", {"not_written": True}, "Tally refused it")
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "needs_edit"
    assert db.ok(f"select tally_bridge_claim('{TOKEN}','{INSTANCE}') is null", anon=True) == "t"  # not straight away
    db.ok(f"update tally_bridge_jobs set updated_at=now()-interval '4 minutes' where id='{j['id']}'")
    again = device(db, "claim")
    assert again["id"] == j["id"] and not again["recover_only"]
    # While Tally is checking it, it cannot be deleted; once refused again, it can.
    assert "checking this voucher" in db.fails(f"select tally_delete_voucher('{v['id']}')", user=OWNER)
    finish(again, "error", {}, "Ledger missing")
    db.ok(f"select tally_delete_voucher('{v['id']}')", user=OWNER)
    assert db.ok(f"select state from tally_bridge_jobs where id='{j['id']}'") == "superseded"
    # An uncertain posting is looked up again by itself, never re-posted.
    v = create(db)
    j = device(db, "claim"); begin(j)
    finish(j, "conflict", {}, "Uncertain outcome")
    assert "bridge history" in db.fails(f"select tally_delete_voucher('{v['id']}')", user=OWNER)
    db.ok(f"update tally_bridge_jobs set updated_at=now()-interval '11 minutes' where id='{j['id']}'")
    again = device(db, "claim")
    assert again["id"] == j["id"] and again["recover_only"]
    finish(again, "conflict", {}, "Still uncertain")
    db.ok(f"update tally_bridge_jobs set state='superseded' where id='{j['id']}'")


def test_renumbering_lets_the_tally_invoice_with_the_old_number_join_the_app(db):
    db.ok("update tally_bridge_jobs set state='superseded' where state in ('pending','leased','error','conflict')")
    v = create(db)
    j = device(db, "claim")
    # An employee made the same number in Tally first; the web voucher was not posted.
    a = dict(series="hsd", number=v["number"], date="2026-10-19", party="Made in Tally", vehicle="", qty=5, rate=100, item_amt=500, party_amt=500, roff=0)
    db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([tally_object('taken-guid', a, alter=9)]))})", anon=True)
    db.ok(f"select tally_bridge_finish('{TOKEN}','{INSTANCE}','{j['id']}','{j['lease_token']}','conflict','{{}}','Already exists in Tally')", anon=True)
    db.ok(f"select tally_bridge_control('renumber','{v['id']}')", user=OWNER)
    adopted = db.json(f"select to_jsonb(t) from tally_vouchers t where number='{v['number']}'")
    assert adopted["bridge_guid"] == "taken-guid" and adopted["party"] == "Made in Tally" and adopted["source"] == "tally"
    assert db.ok(f"select number from tally_vouchers where id='{v['id']}'") != v["number"]
    assert db.ok(f"select count(*) from tally_bridge_jobs where voucher_id='{adopted['id']}'") == "0"  # nothing posted back
    twin = tally_object('twin-guid', dict(a, party='Typed twice'), alter=10)
    result = db.json(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([twin]))})", anon=True)
    assert "is in Tally twice" in result["rejected"][0]["error"]
    assert db.ok(f"select party from tally_vouchers where number='{v['number']}'") == "Made in Tally"
    db.ok("update tally_bridge_jobs set state='superseded' where state in ('pending','leased')")


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


def test_import_chunk_stays_fast_with_thousands_of_tally_vouchers_stored(db):
    """Supabase cancels a statement after ~8 s; a 500-voucher DayBook chunk must stay well under."""
    import time
    db.ok("update tally_bridge_config set active=true where id=1")
    db.ok("""insert into tally_bridge_objects(kind,guid,alter_id,master_id,data)
      select 'Voucher','perf-'||i,i,i,jsonb_build_object('light',i%2=0,'voucher_type','HSD CREDIT','number','P'||i,'date','20261001',
        'xml',repeat('<LEDGERENTRIES.LIST><AMOUNT>1.00</AMOUNT></LEDGERENTRIES.LIST>',150),
        'app_voucher',case when i%2=1 then jsonb_build_object('series','hsd','number','P'||i,'date','2026-10-01','party','Perf',
          'vehicle','','qty',1,'rate',100,'item_amt',100,'party_amt',100,'roff',0) end)
      from generate_series(1,6000) i on conflict do nothing""")
    chunk = [dict(series="hsd", number=f"P{i}") for i in range(1, 501)]
    started = time.monotonic()
    result = daybook(db, *chunk)
    elapsed = time.monotonic() - started
    assert result["added"]["hsd"] == 500
    assert db.ok("select count(*) from tally_vouchers where number like 'P%' and bridge_guid like 'perf-%'") == "500"
    assert elapsed < 3, f"500-voucher import took {elapsed:.1f}s"



def test_switching_the_bridge_off_and_on_keeps_the_app_independent(db):
    db.ok("update tally_bridge_devices set revoked=false where id=(select id from tally_bridge_devices order by created_at desc limit 1)")
    db.ok("select tally_bridge_control('on')", user=OWNER)
    db.ok("update tally_bridge_jobs set state='superseded' where state in ('pending','leased')")
    v = create(db)
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "queued"
    db.ok("select tally_bridge_control('off')", user=OWNER)
    # Back in the day's XML; nothing left for the PC to post; edits and deletes are free.
    assert db.ok(f"select bridge_state from tally_vouchers where id='{v['id']}'") == "unlinked"
    assert db.ok(f"select count(*) from tally_bridge_jobs where voucher_id='{v['id']}' and state<>'superseded'") == "0"
    assert db.ok(f"select tally_bridge_claim('{TOKEN}','{INSTANCE}') is null", anon=True) == "t"
    edit(db, v["id"], 1300)
    assert db.ok(f"select count(*) from tally_bridge_jobs where voucher_id='{v['id']}' and state='pending'") == "0"
    a = dict(series="hsd", number=v["number"], date="2026-10-19", party="Changed in Tally", vehicle="", qty=10, rate=100, item_amt=1000, party_amt=1000, roff=0)
    db.ok(f"select tally_bridge_ingest('{TOKEN}','{INSTANCE}',{lit(json.dumps([tally_object('off-guid', a, alter=5)]))})", anon=True)
    assert db.ok(f"select party from tally_vouchers where id='{v['id']}'") == "Test Debtor"  # an older PC cannot change it
    db.ok(f"select tally_delete_voucher('{v['id']}')", user=OWNER)  # it has bridge job history
    # DayBook import updates every voucher while off, linked ones too, like before the bridge.
    assert daybook(db, dict(series="hsd", number="88001", party="From DayBook"))["updated"] == 1
    assert db.ok("select party from tally_vouchers where number='88001'") == "From DayBook"
    # Switching on posts nothing by itself; vouchers saved from then on are queued.
    db.ok("select tally_bridge_control('on')", user=OWNER)
    w = create(db)
    assert db.ok(f"select bridge_state from tally_vouchers where id='{w['id']}'") == "queued"
    db.ok("select tally_bridge_control('revoke')", user=OWNER)
    assert db.ok("select active from tally_bridge_config") == "f"
    assert "Pair a PC first" in db.fails("select tally_bridge_control('on')", user=OWNER)
