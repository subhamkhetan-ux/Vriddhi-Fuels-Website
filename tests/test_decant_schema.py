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
    pg.ok("delete from dec_sessions; delete from dec_invoices;"
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


def test_purge_keeps_two_fys(pg):
    _reset(pg)
    pg.ok("""
      insert into dec_sessions (id, invoice_no, status, created_at, completed_at) values
        ('ancient',    'A', 'done',      now() - interval '800 days', now() - interval '800 days'),
        ('ancient-x',  'A', 'cancelled', now() - interval '790 days', now() - interval '790 days'),
        ('last-month', 'B', 'done',      now() - interval '40 days',  now() - interval '40 days'),
        ('stuck-open', 'C', 'settling',  now() - interval '900 days', null);
      insert into dec_invoices (invoice_no, created_at) values
        ('A', now() - interval '800 days'),
        ('C', now() - interval '900 days'),
        ('D', now() - interval '200 days');
      select dec_purge_old();
    """)
    # two FYs are kept (so "this FY" works); older ones go, open work stays
    assert pg.ok("select string_agg(id, ',' order by id) from dec_sessions;") == "last-month,stuck-open"
    assert pg.ok("select string_agg(invoice_no, ',' order by invoice_no) from dec_invoices;") == "C,D"


def test_screenshots_are_not_kept(pg):
    assert pg.ok("select to_regclass('public.dec_photos') is null;") == "t"


def test_dismiss_reason_column(pg):
    _reset(pg)
    pg.ok("insert into dec_invoices (invoice_no, dismissed, dismiss_reason) values ('Z', true, 'outside');", anon=True)
    assert pg.ok("select dismiss_reason from dec_invoices where invoice_no = 'Z';", anon=True) == "outside"


def test_history_view_is_compact(pg):
    _reset(pg)
    pg.ok("""
      insert into dec_sessions (id, invoice_no, tt_no, status, data) values
        ('h1', 'I1', 'OD23U8210', 'done', '{"decantedAt": "2026-05-02T10:00:00Z", "plan": [{"no": 1, "tank": "T2"}],
           "tanks": [{"tank": "T2", "tankNo": 2, "product": "HSD", "chambers": [1], "litres": 5000, "salesL": 12,
                      "before": {"volume": 9000.5, "checks": {"sum": {"ok": true}}, "photoId": "P1"},
                      "after": {"volume": 13990, "confidence": "high"}}],
           "invoice": {"lines": [{"qty_kl": 5}]}, "checks": ["lots of text"]}'),
        ('h2', 'I2', 'OD23U8210', 'decanting', '{}'),
        ('h3', 'I3', 'OD23U8210', 'done', '{"tanks": "not a list"}');
    """)
    # only finished decantations, readable with the public key
    assert pg.ok("select string_agg(id, ',' order by id) from dec_history;", anon=True) == "h1,h3"
    assert pg.json("select data from dec_history where id = 'h1';", anon=True) == {
        "compact": True, "decantedAt": "2026-05-02T10:00:00Z", "startedAt": None,
        "plan": [{"no": 1, "tank": "T2"}],
        "tanks": [{"tank": "T2", "tankNo": 2, "product": "HSD", "chambers": [1], "litres": 5000, "salesL": 12,
                   "pricePerL": None, "before": {"volume": 9000.5}, "after": {"volume": 13990}}],
    }
    assert pg.json("select data->'tanks' from dec_history where id = 'h3';", anon=True) == []


def test_single_config_row(pg):
    pg.fails("insert into dec_config (id) values (2);")
