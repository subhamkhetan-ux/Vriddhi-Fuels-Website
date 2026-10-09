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


def test_trips_are_kept_for_good(pg):
    # every sale's "Sold to" stays, however old; old refills are still pruned
    pg.ok("delete from loading_fuel_logs; delete from loading_trips;")
    pg.ok("insert into loading_trips (id, vehicle, total, dest, created_at) values "
          "(gen_random_uuid(), 'OD23A3710', 12000, 'Shyam Metalics', now() - interval '3 years'),"
          "(gen_random_uuid(), 'OD15AF5510', 4000, 'SMC Unit 1', now() - interval '13 months')")
    for v, months in (("OD23A3710", 9), ("OD23A3710", 1)):
        pg.ok("insert into loading_fuel_logs (vehicle, reading_at, odometer, litres, anguls) values "
              f"('{v}', now() - interval '{months} months', {1000 * months}, 300, 2)")
    pg.ok("select _loading_prune_history();")
    assert pg.ok("select count(*) from loading_trips") == "2"
    assert pg.ok("select count(*) from loading_fuel_logs") == "1"
