"""Tests for supabase/loading-schema.sql's diesel estimate on a throwaway local Postgres.

The tanker's own diesel (home cards, sale forecast) must show from its first
refill on — the same figures as the app's model (tests/loading_web/estimate.test.mjs).
Uses the stubbed-Supabase harness of test_ledger_schema.py. All data is made up.
Skipped when Postgres isn't installed.
"""
import json
import os
import shutil
import subprocess
import tempfile

import pytest

from tests.test_ledger_schema import SUPABASE_STUB, Pg, _free_port, _pg_bin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "supabase", "loading-schema.sql")


@pytest.fixture(scope="module")
def pg():
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not (initdb and pg_ctl and shutil.which("psql")):
        pytest.skip("PostgreSQL is not installed")
    as_pg = []
    if os.geteuid() == 0:                      # postgres refuses to run as root
        if not shutil.which("runuser"):
            pytest.skip("running as root without runuser")
        as_pg = ["runuser", "-u", "postgres", "--"]
    base = tempfile.mkdtemp(prefix="loading-pg-")
    os.chmod(base, 0o777)
    data, sock = os.path.join(base, "data"), os.path.join(base, "sock")
    os.makedirs(sock)
    os.chmod(sock, 0o777)
    port = _free_port()
    try:
        subprocess.run(as_pg + [initdb, "-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8",
                                "--locale=C.UTF-8"], check=True, capture_output=True)
        subprocess.run(as_pg + [pg_ctl, "-D", data, "-w", "-l", os.path.join(base, "log"),
                                "-o", f"-k {sock} -p {port} -c listen_addresses=''", "start"],
                       check=True, capture_output=True)
    except (subprocess.CalledProcessError, OSError) as exc:
        shutil.rmtree(base, ignore_errors=True)
        pytest.skip(f"couldn't start a local Postgres: {exc}")
    db = Pg(sock, port)
    try:
        db.ok(SUPABASE_STUB + "\ncreate publication supabase_realtime;\n")
        schema = open(SCHEMA, encoding="utf-8").read()
        db.ok(schema)
        db.ok(schema)                          # safe to run twice
        yield db
    finally:
        subprocess.run(as_pg + [pg_ctl, "-D", data, "-m", "fast", "stop"], capture_output=True)
        shutil.rmtree(base, ignore_errors=True)


T0 = "timestamptz '2026-10-01 06:00+00'"


def _fuel(pg, rows):
    pg.ok("delete from loading_fuel_logs; delete from loading_trips;")
    for v, hours, odo, litres, anguls in rows:
        pg.ok("insert into loading_fuel_logs (vehicle, reading_at, odometer, litres, anguls) values "
              f"('{v}', {T0} + interval '{hours} hours', {odo}, {litres}, {'null' if anguls is None else anguls})")


def _state(pg, v):
    return pg.json(f"select _loading_fuel_advice(_loading_fuel_state('{v}'), 'DBL - Siarmal', 0)")


# a tanker with a settled mileage: 600 km on 268 L each time = 2.2388 km/L
SETTLED = [("OR15R1110", 0, 0, 300, 2), ("OR15R1110", 24, 600, 300, 4), ("OR15R1110", 48, 1200, 300, 6)]


def test_first_refill_after_an_undipped_one_shows_own_diesel(pg):
    # previous refill typed without its dip (run dry); now 450 km on, 12.5 Anguls (200 L) in the tank, 150 L filled
    _fuel(pg, [("OD23A3710", 0, 1000, 300, None), ("OD23A3710", 30, 1450, 150, 12.5)])
    s = _state(pg, "OD23A3710")
    assert s["mileage_src"] == "recent"
    assert abs(float(s["mileage"]) - 4.5) < 0.001
    assert float(s["stock_now"]) == 350
    assert s["advice"] == "ok"
    # a 140 km trip sold since burns 140 / 4.5 L
    pg.ok(f"insert into loading_trips (id, vehicle, total, dest, created_at) values "
          f"(gen_random_uuid(), 'OD23A3710', 12000, 'DBL - Siarmal', {T0} + interval '31 hours')")
    assert abs(float(_state(pg, "OD23A3710")["stock_now"]) - 318.9) < 0.05


def test_two_dipped_refills_too_close_for_any_mileage(pg):
    _fuel(pg, [("OD23A3710", 0, 1000, 300, 2), ("OD23A3710", 5, 1080, 20, 19)])
    s = _state(pg, "OD23A3710")
    assert s["mileage"] is None and s["mileage_src"] is None
    assert float(s["stock_now"]) == 324                                  # dip + litres, nothing burnt since
    assert s["advice"] == "unknown"
    pg.ok(f"insert into loading_trips (id, vehicle, total, dest, created_at) values "
          f"(gen_random_uuid(), 'OD23A3710', 12000, 'Shyam Metalics', {T0} + interval '6 hours')")
    assert _state(pg, "OD23A3710")["stock_now"] is None                  # a trip since, no mileage: unknown


def test_fleet_mileage_comes_before_a_first_figure(pg):
    _fuel(pg, SETTLED + [("OD23A3710", 0, 1000, 300, None), ("OD23A3710", 30, 1450, 150, 12.5)])
    s = _state(pg, "OD23A3710")
    assert s["mileage_src"] == "fleet"
    assert abs(float(s["mileage"]) - 600 / 268) < 0.001
    assert float(s["stock_now"]) == 350


def test_only_a_first_refill_goes_by_the_fleet_mileage(pg):
    _fuel(pg, SETTLED + [("OR15R9360", 2, 5000, 300, 2)])
    s = _state(pg, "OR15R9360")
    assert s["mileage_src"] == "fleet"
    assert abs(float(s["mileage"]) - 600 / 268) < 0.001
    assert float(s["stock_now"]) == 332
    _fuel(pg, SETTLED + [("OR15R9360", 2, 5000, 300, None)])            # no dip: counted as run dry
    assert float(_state(pg, "OR15R9360")["stock_now"]) == 300


def test_settled_mileage_and_meter_tanker_unchanged(pg):
    _fuel(pg, SETTLED + [("OD15AF5510", 1, 100000, 40, None)])
    s = _state(pg, "OR15R1110")
    assert s["mileage_src"] == "own"
    assert abs(float(s["mileage"]) - 600 / 268) < 0.001
    assert s["spread"] is not None
    m = _state(pg, "OD15AF5510")                                         # never borrows the big tankers' mileage
    assert m["mileage"] is None and m["advice"] == "unknown"
    assert float(m["stock_now"]) == 40                                   # just refilled (from dry): its litres


def test_no_entries_no_figure(pg):
    _fuel(pg, [])
    s = _state(pg, "OD23A3710")
    assert s["mileage"] is None and s["stock_now"] is None and s["mileage_src"] is None


# ---------------------------------------------------------------------------
# App = database on random, messy logs: missing dips, entries saved twice,
# odometers with an extra digit or going back, litres typed ×10, stock checks,
# trips to a customer not in the list. tests/loading_web/fuzz_cases.mjs makes
# them and says what the app's model shows for each tanker.
# ---------------------------------------------------------------------------
FUZZ = os.path.join(ROOT, "tests", "loading_web", "fuzz_cases.mjs")


def _fuzz_cases(n, seed):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    out = subprocess.run([node, FUZZ, str(n), str(seed)], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def _num(v):
    return None if v is None else float(v)


def _sql(v):
    return "null" if v is None else repr(float(v))


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_database_says_what_the_app_says_on_messy_logs(pg, seed):
    bad = []
    for case in _fuzz_cases(60, seed):
        sql = ["delete from loading_fuel_logs; delete from loading_trips;"]
        for r in case["rows"]:
            sql.append("insert into loading_fuel_logs (vehicle, reading_at, odometer, litres, anguls, stock_l, created_at) values "
                       f"('{r['plate']}', to_timestamp({r['ts']} / 1000.0), {_sql(r['odo'])}, {_sql(r['litres'])}, "
                       f"{_sql(r['anguls'])}, {_sql(r['stock_l'])}, to_timestamp({r['cts']}));")
        for t in case["trips"]:
            sql.append("insert into loading_trips (id, vehicle, total, dest, created_at) values "
                       f"(gen_random_uuid(), '{t['plate']}', {_sql(t['total'])}, '{t['dest']}', to_timestamp({t['ts']} / 1000.0));")
        plates = list(case["expect"])
        sql.append("select jsonb_object_agg(p, _loading_fuel_state(p)) from unnest(array["
                   + ",".join(f"'{p}'" for p in plates) + "]) p;")
        got = pg.json("\n".join(sql))
        for p in plates:
            a, d = case["expect"][p], got[p]
            am, dm, ast, dst = _num(a.get("mileage")), _num(d.get("mileage")), _num(a.get("stock_now")), _num(d.get("stock_now"))
            same = ((am is None) == (dm is None) and (am is None or abs(am - dm) <= 0.002)
                    and (a.get("mileage_src") or None) == d.get("mileage_src")
                    and (ast is None) == (dst is None) and (ast is None or abs(ast - dst) <= 0.11)
                    and a["trips_since"] == d["trips_since"] and a["unknown_trips"] == d["unknown_trips"])
            if not same:
                bad.append((case["seed"], p, {k: a.get(k) for k in ("mileage", "mileage_src", "stock_now", "trips_since", "unknown_trips")},
                            {k: d.get(k) for k in ("mileage", "mileage_src", "stock_now", "trips_since", "unknown_trips")}))
    assert not bad, f"{len(bad)} differ, e.g. {bad[:3]}"


# ---------------------------------------------------------------------------
# Invoice tagging: ledger bills tagged to trips. A bill can sit on one trip
# only, everything is admin-only, and a trip that goes takes its tags along.
# ---------------------------------------------------------------------------
ADMIN = "00000000-0000-0000-0000-00000000000a"
STAFF = "00000000-0000-0000-0000-00000000000b"
TRIP1 = "10000000-0000-0000-0000-000000000001"
TRIP2 = "10000000-0000-0000-0000-000000000002"


def _admin(pg, sql):
    return pg.ok(sql, user=ADMIN, email="boss@vriddhi.local")


def _bill(no, qty, **over):
    b = {"bill_key": f"HSD|2026-27|{no}", "product": "HSD", "bill_no": str(no), "sale_date": "2026-10-02",
         "bill_vehicle": "OD-23-A-3710", "customer": "Demo Metals Ltd", "customer_key": "demo metals ltd",
         "qty": qty, "amount": None if qty is None else qty * 99.5}
    b.update(over)
    return b


def _tag(pg, trip, bills, mode="manual"):
    arg = json.dumps(bills).replace("'", "''")
    return _admin(pg, f"select loading_invoice_tag('{trip}', '{arg}'::jsonb, '{mode}', 'boss')")


@pytest.fixture
def trips(pg):
    pg.ok("insert into loading_roles (email, role) values ('boss@vriddhi.local', 'admin') on conflict (email) do update set role = 'admin';"
          "insert into loading_roles (email, role) values ('ramesh@vriddhi.local', 'staff') on conflict (email) do update set role = 'staff';"
          "delete from loading_invoice_tags; delete from loading_dest_links; delete from loading_trip_checks; delete from loading_trips;"
          f"insert into loading_trips (id, vehicle, total, dest, created_at) values "
          f"('{TRIP1}', 'OD23A3710', 12000, 'Shyam Metalics', {T0}),"
          f"('{TRIP2}', 'OR15R1110', 11955, 'Orissa Metaliks', {T0} + interval '2 hours');")


def test_a_trip_is_tagged_with_several_bills(pg, trips):
    assert _tag(pg, TRIP1, [_bill(101, 4000), _bill(102, 4000), _bill(103, 4000)]) == "3"
    rows = pg.json("select jsonb_agg(jsonb_build_array(bill_no, vehicle, qty, mode) order by bill_no) from loading_invoice_tags")
    assert rows == [["101", "OD23A3710", 4000, "manual"], ["102", "OD23A3710", 4000, "manual"], ["103", "OD23A3710", 4000, "manual"]]
    # the same bill on the same trip again only refreshes its figures
    assert _tag(pg, TRIP1, [_bill(101, 3990)]) == "1"
    assert pg.ok("select qty from loading_invoice_tags where bill_no = '101'") == "3990.00"


def test_a_bill_cannot_be_on_two_trips(pg, trips):
    _tag(pg, TRIP1, [_bill(201, 4000)])
    err = pg.fails(f"select loading_invoice_tag('{TRIP2}', '{json.dumps([_bill(202, 4000), _bill(201, 4000)])}'::jsonb, 'manual', 'boss')",
                   user=ADMIN, email="boss@vriddhi.local")
    assert "already tagged to another trip" in err and "OD23A3710" in err
    # all or nothing: 202 was not kept either
    assert pg.ok("select count(*) from loading_invoice_tags") == "1"


def test_untag_and_a_deleted_trip_takes_its_tags(pg, trips):
    _tag(pg, TRIP1, [_bill(301, 6000), _bill(302, 6000)])
    _admin(pg, "select loading_invoice_untag('HSD|2026-27|301')")
    assert pg.ok("select count(*) from loading_invoice_tags") == "1"
    assert "not tagged" in pg.fails("select loading_invoice_untag('HSD|2026-27|301')", user=ADMIN, email="boss@vriddhi.local")
    pg.ok(f"delete from loading_trips where id = '{TRIP1}'")
    assert pg.ok("select count(*) from loading_invoice_tags") == "0"


def test_tagging_checks_its_input(pg, trips):
    assert "Trip not found" in pg.fails(f"select loading_invoice_tag(gen_random_uuid(), '{json.dumps([_bill(1, 1)])}'::jsonb, 'manual', '')",
                                        user=ADMIN, email="boss@vriddhi.local")
    assert "at least one bill" in pg.fails(f"select loading_invoice_tag('{TRIP1}', '[]'::jsonb, 'manual', '')",
                                           user=ADMIN, email="boss@vriddhi.local")
    assert "no litres" in pg.fails(f"select loading_invoice_tag('{TRIP1}', '{json.dumps([_bill(1, None)])}'::jsonb, 'manual', '')",
                                   user=ADMIN, email="boss@vriddhi.local")


def test_tags_and_links_are_admin_only(pg, trips):
    _tag(pg, TRIP1, [_bill(401, 12000)])
    _admin(pg, "select loading_dest_link_set('demo metals ltd', 'Demo Metals Ltd', 'Shyam Metalics')")
    staff = dict(user=STAFF, email="ramesh@vriddhi.local")
    assert pg.ok("select count(*) from loading_invoice_tags", **staff) == "0"
    assert pg.ok("select count(*) from loading_dest_links", **staff) == "0"
    assert "Admin only" in pg.fails(f"select loading_invoice_tag('{TRIP2}', '{json.dumps([_bill(402, 1)])}'::jsonb, 'manual', '')", **staff)
    assert "Admin only" in pg.fails("select loading_invoice_untag('HSD|2026-27|401')", **staff)
    assert "Admin only" in pg.fails("select loading_dest_link_set('x', 'X', 'Shyam Metalics')", **staff)
    assert _admin(pg, "select count(*) from loading_invoice_tags") == "1"
    assert _admin(pg, "select count(*) from loading_dest_links") == "1"


def test_links_need_a_customer_from_the_list(pg, trips):
    _admin(pg, "select loading_dest_link_set('demo metals ltd', 'Demo Metals Ltd', 'SMC Unit 1');"
               "select loading_dest_link_set('demo metals ltd', 'Demo Metals Ltd', 'SMC Unit 2');")
    assert _admin(pg, "select count(*) from loading_dest_links where customer_key = 'demo metals ltd'") == "2"
    assert "from the list" in pg.fails("select loading_dest_link_set('x', 'X', 'Nobody Ltd')", user=ADMIN, email="boss@vriddhi.local")
    _admin(pg, "select loading_dest_link_remove('demo metals ltd', 'SMC Unit 2')")
    assert _admin(pg, "select count(*) from loading_dest_links") == "1"


def test_invoice_check_settings(pg, trips):
    _admin(pg, "select loading_setting_set('tag_from', '\"2026-10-01\"'::jsonb);"
               "select loading_setting_set('tag_tol_l', '30'::jsonb);"
               "select loading_setting_set('tag_over_l', '80'::jsonb);"
               "select loading_setting_set('tag_auto', '1'::jsonb);")
    got = pg.json("select jsonb_object_agg(key, value) from loading_settings where key like 'tag_%'")
    assert got == {"tag_from": "2026-10-01", "tag_tol_l": 30, "tag_over_l": 80, "tag_auto": 1}
    admin = dict(user=ADMIN, email="boss@vriddhi.local")
    assert "start date" in pg.fails("select loading_setting_set('tag_from', '\"soon\"'::jsonb)", **admin)
    assert "Tolerance" in pg.fails("select loading_setting_set('tag_tol_l', '-1'::jsonb)", **admin)
    assert "Tolerance" in pg.fails("select loading_setting_set('tag_over_l', '5000'::jsonb)", **admin)
    assert "Auto-tag" in pg.fails("select loading_setting_set('tag_auto', '2'::jsonb)", **admin)


def test_mark_a_trip_as_checked(pg, trips):
    _admin(pg, f"select loading_trip_check('{TRIP1}', 'Settled outside the ledger', 'boss')")
    assert pg.json("select jsonb_agg(jsonb_build_array(note, by_name)) from loading_trip_checks") == [["Settled outside the ledger", "boss"]]
    _admin(pg, f"select loading_trip_check('{TRIP1}', 'Billed on a manual invoice', 'boss')")     # marking again updates the reason
    assert pg.ok("select note from loading_trip_checks") == "Billed on a manual invoice"
    admin = dict(user=ADMIN, email="boss@vriddhi.local")
    assert "why" in pg.fails(f"select loading_trip_check('{TRIP2}', '  ', 'boss')", **admin)
    assert "Trip not found" in pg.fails("select loading_trip_check(gen_random_uuid(), 'x', 'boss')", **admin)
    staff = dict(user=STAFF, email="ramesh@vriddhi.local")
    assert pg.ok("select count(*) from loading_trip_checks", **staff) == "0"
    assert "Admin only" in pg.fails(f"select loading_trip_check('{TRIP2}', 'x', '')", **staff)
    assert "Admin only" in pg.fails(f"select loading_trip_uncheck('{TRIP1}')", **staff)
    _admin(pg, f"select loading_trip_uncheck('{TRIP1}')")
    assert pg.ok("select count(*) from loading_trip_checks") == "0"
    _admin(pg, f"select loading_trip_check('{TRIP2}', 'ok', 'boss')")
    pg.ok(f"delete from loading_trips where id = '{TRIP2}'")                                  # goes with its trip
    assert pg.ok("select count(*) from loading_trip_checks") == "0"
