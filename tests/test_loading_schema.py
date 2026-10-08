"""Tests for supabase/loading-schema.sql's diesel estimate on a throwaway local Postgres.

The tanker's own diesel (home cards, sale forecast) must show from its first
refill on — the same figures as the app's model (tests/loading_web/estimate.test.mjs).
Uses the stubbed-Supabase harness of test_ledger_schema.py. All data is made up.
Skipped when Postgres isn't installed.
"""
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
    _fuel(pg, SETTLED + [("OD23A3710", 0, 1000, 300, None), ("OD23A3710", 30, 1450, 150, 12.5)])
    s = _state(pg, "OD23A3710")
    assert s["mileage_src"] == "recent"
    assert abs(float(s["mileage"]) - 4.5) < 0.001
    assert float(s["stock_now"]) == 350
    assert s["advice"] == "ok"
    # a 140 km trip sold since burns 140 / 4.5 L
    pg.ok(f"insert into loading_trips (id, vehicle, total, dest, created_at) values "
          f"(gen_random_uuid(), 'OD23A3710', 12000, 'DBL - Siarmal', {T0} + interval '31 hours')")
    assert abs(float(_state(pg, "OD23A3710")["stock_now"]) - 318.9) < 0.05


def test_two_dipped_refills_too_close_for_a_settled_mileage(pg):
    _fuel(pg, [("OD23A3710", 0, 1000, 300, 2), ("OD23A3710", 5, 1080, 20, 19)])
    s = _state(pg, "OD23A3710")
    assert s["mileage_src"] == "recent"
    assert abs(float(s["mileage"]) - 80 / 28) < 0.001
    assert float(s["stock_now"]) == 324


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
    assert m["mileage"] is None and m["stock_now"] is None and m["advice"] == "unknown"


def test_no_entries_no_figure(pg):
    _fuel(pg, [])
    s = _state(pg, "OD23A3710")
    assert s["mileage"] is None and s["stock_now"] is None and s["mileage_src"] is None
