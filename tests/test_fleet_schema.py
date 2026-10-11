"""Tests for supabase/fleet-schema.sql on a throwaway local Postgres.

The fleet app lives in the ledger's Supabase project and uses its member
list, so the ledger schema runs first. Checks: the public key gets nothing,
a login that isn't a ledger member gets nothing, a member can save and read
back, only the newest 10 uploads are kept. All data is made up. Skipped when
Postgres isn't installed.
"""
import json
import os
import shutil
import subprocess
import tempfile

import pytest

from tests.test_ledger_schema import OWNER, STRANGER, SUPABASE_STUB, Pg, _free_port, _pg_bin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, "supabase", "ledger-schema.sql")
FLEET = os.path.join(ROOT, "supabase", "fleet-schema.sql")


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
    base = tempfile.mkdtemp(prefix="fleet-pg-")
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
        db.ok(SUPABASE_STUB)
        # the fleet schema needs the ledger's member list first
        err = db.fails(open(FLEET, encoding="utf-8").read())
        assert "ledger-schema.sql" in err
        db.ok(open(LEDGER, encoding="utf-8").read())
        fleet = open(FLEET, encoding="utf-8").read()
        db.ok(fleet)
        db.ok(fleet)                           # safe to run twice
        db.ok("insert into auth.users values "
              f"('{OWNER}', 'owner@example.com'), ('{STRANGER}', 'stranger@example.com');")
        db.ok("select ledger_add_member('owner@example.com');")
        yield db
    finally:
        subprocess.run(as_pg + [pg_ctl, "-D", data, "-m", "fast", "stop"], capture_output=True)
        shutil.rmtree(base, ignore_errors=True)


def payload(n=1, latest="2026-06-05"):
    return {"version": 1, "latest": latest,
            "trips": [{"row": 3 + i, "trip": f"T{i:03d}/DEMO", "veh": "XX01A1001"} for i in range(n)],
            "hsd": [{"date": "2026-06-01", "veh": "XX01A1001", "qty": 100}], "urea": []}


def save(db, p, user=OWNER, email="owner@example.com"):
    body = json.dumps(p).replace("'", "''")
    return db.json(f"select fleet_save('Trip_Register.xlsm', '{body}'::jsonb);", user=user, email=email)


def test_public_key_and_strangers_get_nothing(pg):
    assert "permission denied" in pg.fails("select * from fleet_uploads;", anon=True)
    assert "permission denied" in pg.fails("select fleet_latest();", anon=True)
    who = pg.json("select fleet_whoami();", user=STRANGER, email="stranger@example.com")
    assert who["member"] is False
    assert "not on the ledger members list" in pg.fails("select fleet_latest();", user=STRANGER, email="stranger@example.com")
    assert "not on the ledger members list" in pg.fails(
        "select fleet_save('x', '{\"trips\":[{\"row\":1}]}'::jsonb);", user=STRANGER, email="stranger@example.com")
    # even a direct insert is refused by row-level security
    assert pg.fails("insert into fleet_uploads (payload) values ('{}');", user=STRANGER, email="stranger@example.com")


def test_member_saves_and_reads_back(pg):
    assert pg.json("select fleet_whoami();", user=OWNER, email="owner@example.com")["member"] is True
    meta = save(pg, payload(3))
    assert meta["counts"] == {"trips": 3, "hsd": 1, "urea": 0}
    assert meta["latest_trip"] == "2026-06-05"
    assert meta["by_email"] == "owner@example.com"
    got = pg.owner("select fleet_latest();")
    assert got["meta"]["id"] == meta["id"]
    assert got["payload"]["trips"][2]["trip"] == "T002/DEMO"
    # the stranger still can't see it through the table
    assert pg.ok("select count(*) from fleet_uploads;", user=STRANGER, email="stranger@example.com") == "0"


def test_empty_upload_is_refused(pg):
    assert "no trips" in pg.fails("select fleet_save('x', '{\"trips\":[]}'::jsonb);", user=OWNER, email="owner@example.com")


def test_keeps_the_newest_ten(pg):
    for i in range(12):
        save(pg, payload(1 + i))
    rows = pg.owner("select fleet_uploads_list(50);")
    assert len(rows) == 10
    assert rows[0]["counts"]["trips"] == 12
    assert pg.owner("select fleet_latest();")["payload"]["trips"][-1]["trip"] == "T011/DEMO"


def test_settings_members_only_one_row(pg):
    assert pg.owner("select fleet_settings_get();") == {"value": {}}
    value = {"routes": [{"port": "Demo Port", "dest": "Demo Plant", "km": 500, "salary": 9000, "diesel": 400}],
             "vehicles": {"XX01A1001": {"tyre": False}}}
    body = json.dumps(value).replace("'", "''")
    got = pg.owner(f"select fleet_settings_save('{body}'::jsonb);")
    assert got["value"] == value and got["by_email"] == "owner@example.com"
    pg.owner("select fleet_settings_save('{\"routes\": []}'::jsonb);")
    assert pg.ok("select count(*) from fleet_settings;") == "1"
    assert pg.owner("select fleet_settings_get();")["value"] == {"routes": []}
    assert "must be an object" in pg.fails("select fleet_settings_save('[1]'::jsonb);", user=OWNER, email="owner@example.com")
    assert "not on the ledger members list" in pg.fails("select fleet_settings_get();", user=STRANGER, email="stranger@example.com")
    assert "permission denied" in pg.fails("select * from fleet_settings;", anon=True)
    assert pg.ok("select count(*) from fleet_settings;", user=STRANGER, email="stranger@example.com") == "0"
