"""Tests for supabase/jarvis-schema.sql (Jarvis's own project: members, the
state that syncs across devices) and jarvis-mac-schema.sql (the optional Mac
command queue), on a throwaway local Postgres with Supabase's auth stubbed as
in test_ledger_schema.py. Only Jarvis members get anything; the public key and
other logins get nothing.

Skipped when Postgres isn't installed.
"""
import os
import shutil
import subprocess
import tempfile

import pytest

from tests.test_ledger_schema import OWNER, STRANGER, SUPABASE_STUB, Pg, _free_port, _pg_bin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JARVIS = os.path.join(ROOT, "supabase", "jarvis-schema.sql")
MAC = os.path.join(ROOT, "supabase", "jarvis-mac-schema.sql")


@pytest.fixture(scope="module")
def db():
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not (initdb and pg_ctl and shutil.which("psql")):
        pytest.skip("PostgreSQL is not installed")
    as_pg = []
    if os.geteuid() == 0:
        if not shutil.which("runuser"):
            pytest.skip("running as root without runuser")
        as_pg = ["runuser", "-u", "postgres", "--"]
    base = tempfile.mkdtemp(prefix="jarvis-pg-")
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
    pg = Pg(sock, port)
    try:
        pg.ok(SUPABASE_STUB)
        for f in (JARVIS, MAC):
            sql = open(f, encoding="utf-8").read()
            pg.ok(sql)
            pg.ok(sql)                         # safe to run twice
        pg.ok("insert into auth.users values "
              f"('{OWNER}', 'owner@example.com'), ('{STRANGER}', 'stranger@example.com');")
        # the first login to claim Jarvis becomes its owner
        assert pg.json("select jarvis_claim_owner();", user=OWNER, email="owner@example.com")["member"] is True
        yield pg
    finally:
        subprocess.run(as_pg + [pg_ctl, "-D", data, "-m", "fast", "stop"], capture_output=True)
        shutil.rmtree(base, ignore_errors=True)


def owner(db, sql):
    return db.json(sql, user=OWNER, email="owner@example.com")


def test_public_key_and_strangers_get_nothing(db):
    assert "permission denied" in db.fails("select jarvis_send('xtrapower.status');", anon=True)
    assert "permission denied" in db.fails("select * from jarvis_commands;", anon=True)
    err = db.fails("select jarvis_send('xtrapower.status');", user=STRANGER, email="stranger@example.com")
    assert "Jarvis members" in err
    err = db.fails("select jarvis_bridge_poll('mac');", user=STRANGER, email="stranger@example.com")
    assert "Jarvis members" in err
    # members only reach the tables through the functions
    assert "permission denied" in db.fails("select * from jarvis_commands;", user=OWNER, email="owner@example.com")


def test_send_poll_finish_round_trip(db):
    cid = owner(db, "select to_jsonb(jarvis_send('xtrapower.watch', '{\"account\": \"ember\", \"watch\": true}'));")
    cmd = owner(db, f"select jarvis_command({cid});")
    assert cmd["status"] == "queued" and cmd["args"] == {"account": "ember", "watch": True}

    # another bridge name doesn't see it
    assert owner(db, "select coalesce(jarvis_bridge_poll('office'), 'null'::jsonb);") is None
    got = owner(db, "select jarvis_bridge_poll('mac', '{\"version\": 1}');")
    assert got["id"] == cid and got["action"] == "xtrapower.watch"
    assert owner(db, f"select jarvis_command({cid});")["status"] == "running"
    # already taken: the next poll gets nothing
    assert owner(db, "select coalesce(jarvis_bridge_poll('mac'), 'null'::jsonb);") is None

    db.ok(f"select jarvis_bridge_finish({cid}, true, '{{\"text\": \"watching Ember\"}}', null);",
          user=OWNER, email="owner@example.com")
    done = owner(db, f"select jarvis_command({cid});")
    assert done["status"] == "done" and done["result"] == {"text": "watching Ember"}

    owner(db, "select coalesce(jarvis_bridge_poll('mac', '{\"version\": 1}'), 'null'::jsonb);")  # a check-in, nothing queued
    bridges = owner(db, "select jarvis_bridges_list();")
    mac = next(b for b in bridges if b["name"] == "mac")
    assert mac["online"] is True and mac["info"] == {"version": 1}


def test_failures_and_stale_commands(db):
    cid = owner(db, "select to_jsonb(jarvis_send('xtrapower.start'));")
    owner(db, "select jarvis_bridge_poll('mac');")
    db.ok(f"select jarvis_bridge_finish({cid}, false, null, 'no .venv');", user=OWNER, email="owner@example.com")
    failed = owner(db, f"select jarvis_command({cid});")
    assert failed["status"] == "failed" and failed["error"] == "no .venv"

    old = owner(db, "select to_jsonb(jarvis_send('xtrapower.stop'));")
    db.ok(f"update jarvis_commands set created_at = now() - interval '11 minutes' where id = {old};")
    assert owner(db, "select coalesce(jarvis_bridge_poll('mac'), 'null'::jsonb);") is None
    assert owner(db, f"select jarvis_command({old});")["status"] == "expired"


def test_bad_action_names_are_refused(db):
    err = db.fails("select jarvis_send('rm -rf /');", user=OWNER, email="owner@example.com")
    assert "jarvis_commands_action" in err
    err = db.fails("select jarvis_send('x', '[1,2]');", user=OWNER, email="owner@example.com")
    assert "jarvis_commands_args" in err


def test_only_the_first_login_can_claim_jarvis(db):
    err = db.fails("select jarvis_claim_owner();", user=STRANGER, email="stranger@example.com")
    assert "already has an owner" in err
    me = db.json("select jarvis_whoami();", user=STRANGER, email="stranger@example.com")
    assert me["member"] is False and me["has_owner"] is True
    assert "permission denied" in db.fails("select jarvis_add_member('stranger@example.com');",
                                           user=OWNER, email="owner@example.com")      # SQL Editor only
    assert "permission denied" in db.fails("select jarvis_claim_owner();", anon=True)


def test_state_follows_the_owner(db):
    empty = owner(db, "select jarvis_state_get();")
    assert empty["settings"] == {} and empty["history"] == []
    db.ok("""select jarvis_state_save('{"settings": {"lang": "hi-IN", "speak": true},
             "history": [{"role": "me", "text": "tank stock"}], "memory": {"customer": "Keshav"}}'::jsonb);""",
          user=OWNER, email="owner@example.com")
    db.ok("""select jarvis_state_save('{"history": [{"role": "me", "text": "sales today"}]}'::jsonb);""",
          user=OWNER, email="owner@example.com")                     # only the history changes
    st = owner(db, "select jarvis_state_get();")
    assert st["settings"] == {"lang": "hi-IN", "speak": True}
    assert st["history"] == [{"role": "me", "text": "sales today"}]
    assert st["memory"] == {"customer": "Keshav"}
    err = db.fails("select jarvis_state_get();", user=STRANGER, email="stranger@example.com")
    assert "Jarvis members" in err
    err = db.fails("""select jarvis_state_save('{"history": {"x": 1}}'::jsonb);""", user=OWNER, email="owner@example.com")
    assert "history must be a list" in err
    assert "permission denied" in db.fails("select * from jarvis_state;", user=OWNER, email="owner@example.com")
