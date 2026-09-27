"""Tests for supabase/decant-schema.sql on a throwaway local Postgres.

Uses the same stubbed-Supabase harness as test_ledger_schema.py (anon role,
plus the realtime publication this schema adds tables to). All data is made
up. Skipped when Postgres isn't installed.
"""
import os
import shutil
import subprocess
import tempfile

import pytest

from tests.test_ledger_schema import SUPABASE_STUB, Pg, _free_port, _pg_bin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "supabase", "decant-schema.sql")


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
    base = tempfile.mkdtemp(prefix="decant-pg-")
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


def _reset(pg):
    pg.ok("delete from dec_sessions; delete from dec_photos; delete from dec_invoices;"
          "update dec_config set data = '{}'::jsonb;")


def test_anon_key_can_read_and_write(pg):
    _reset(pg)
    pg.ok("insert into dec_invoices (invoice_no, tt_no, lines, chambers) values "
          "('7011294526', 'OD23U8210', '[{\"column_key\":\"HSD\",\"qty_kl\":17}]',"
          " '[{\"no\":1,\"qty_kl\":5}]');", anon=True)
    pg.ok("insert into dec_sessions (id, invoice_no, status, data) values "
          "('s1', '7011294526', 'decanting', '{\"tanks\":[]}');", anon=True)
    pg.ok("insert into dec_tank_state (tank_id, reading) values ('T2', '{\"volume\":14973.71}') "
          "on conflict (tank_id) do update set reading = excluded.reading;", anon=True)
    assert pg.ok("select count(*) from dec_invoices;", anon=True) == "1"
    assert pg.ok("select data->>'tanks' from dec_sessions where id = 's1';", anon=True) == "[]"
    pg.ok("select dec_purge_old();", anon=True)            # callable with the public key


def test_realtime_publication_skips_photos(pg):
    tables = pg.ok("select string_agg(tablename, ',' order by tablename) from pg_publication_tables "
                   "where pubname = 'supabase_realtime';")
    assert tables.split(",") == ["dec_config", "dec_invoices", "dec_sessions", "dec_tank_state",
                                 "dec_vehicles"]


def test_purge_keeps_one_month_and_open_work(pg):
    _reset(pg)
    pg.ok("""
      insert into dec_sessions (id, invoice_no, status, created_at, completed_at) values
        ('old-done',   'A', 'done',      now() - interval '40 days', now() - interval '40 days'),
        ('old-cancel', 'A', 'cancelled', now() - interval '35 days', now() - interval '35 days'),
        ('recent',     'B', 'done',      now() - interval '20 days', now() - interval '20 days'),
        ('stuck-open', 'C', 'settling',  now() - interval '50 days', null);
      insert into dec_photos (id, session_id, kind, created_at) values
        ('p-old',    'old-done', 'before', now() - interval '40 days'),
        ('p-recent', 'recent',   'after',  now() - interval '20 days'),
        ('p-open',   'stuck-open','before', now() - interval '50 days'),
        ('p-stock',  null,       'stock',  now() - interval '33 days');
      insert into dec_invoices (invoice_no, created_at) values
        ('A', now() - interval '60 days'),
        ('C', now() - interval '60 days'),
        ('D', now() - interval '20 days');
      select dec_purge_old();
    """)
    assert pg.ok("select string_agg(id, ',' order by id) from dec_sessions;") == "recent,stuck-open"
    assert pg.ok("select string_agg(id, ',' order by id) from dec_photos;") == "p-open,p-recent"
    # 'A' is old and closed; 'C' still has an open decantation; 'D' is recent
    assert pg.ok("select string_agg(invoice_no, ',' order by invoice_no) from dec_invoices;") == "C,D"


def test_retention_days_setting(pg):
    _reset(pg)
    pg.ok("""
      update dec_config set data = '{"settings": {"retentionDays": 60}}'::jsonb;
      insert into dec_sessions (id, status, created_at, completed_at) values
        ('d45', 'done', now() - interval '45 days', now() - interval '45 days'),
        ('d70', 'done', now() - interval '70 days', now() - interval '70 days');
      select dec_purge_old();
    """)
    assert pg.ok("select string_agg(id, ',') from dec_sessions;") == "d45"
    # nonsense values fall back to a month
    pg.ok("""
      update dec_config set data = '{"settings": {"retentionDays": "lots"}}'::jsonb;
      select dec_purge_old();
    """)
    assert pg.ok("select count(*) from dec_sessions;") == "0"


def test_single_config_row(pg):
    pg.fails("insert into dec_config (id) values (2);")
