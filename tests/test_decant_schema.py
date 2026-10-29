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
REMOVE = os.path.join(ROOT, "supabase", "decant-remove-from-payments.sql")


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
    assert tables.split(",") == ["dec_config", "dec_invoices", "dec_live", "dec_sessions", "dec_tank_state",
                                 "dec_vehicles"]                     # dec_shots too: no realtime


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


def test_the_days_screenshots_any_phone_can_share(pg):
    pg.ok("delete from dec_shots;")
    pg.ok("insert into dec_shots (id, day, readings, path, source) values "
          "('1-a', '2026-10-13', '{\"T2\": {\"readingAt\": \"2026-10-13T18:01:58+05:30\", \"volume\": 19143.31}}',"
          " '2026-10-13/1-a.jpg', 'phone');", anon=True)
    assert pg.ok("select readings->'T2'->>'volume' from dec_shots where day = '2026-10-13';", anon=True) == "19143.31"
    pg.ok("delete from dec_shots where day < '2026-10-14';", anon=True)     # the next day's tidy
    assert pg.ok("select count(*) from dec_shots;", anon=True) == "0"


STORAGE_STUB = """
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id serial primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant all on storage.objects to anon, authenticated;
grant usage on all sequences in schema storage to anon, authenticated;
"""


def test_screenshot_files_go_in_a_private_bucket_where_supabase_has_storage(pg):
    pg.ok(STORAGE_STUB)
    schema = open(SCHEMA, encoding="utf-8").read()
    pg.ok(schema)
    pg.ok(schema)                              # still safe to run twice
    assert pg.ok("select public::text || ',' || file_size_limit from storage.buckets where id = 'dec-shots';") == "false,3145728"
    pg.ok("insert into storage.objects (bucket_id, name) values ('dec-shots', '2026-10-13/1-a.jpg');", anon=True)
    assert pg.ok("select count(*) from storage.objects;", anon=True) == "1"
    pg.fails("insert into storage.objects (bucket_id, name) values ('other', 'x.jpg');", anon=True)


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
    # each stock keeps where it came from, for the internal audit
    pg.ok("""
      insert into dec_sessions (id, invoice_no, tt_no, status, data) values
        ('h4', 'I4', 'OD23U8210', 'done', '{"tanks": [{"tank": "T3", "litres": 4000,
           "before": {"volume": 9989.83, "source": "photo-edited", "screenVolume": 9998.83, "dip": 98.7, "checks": {"x": 1}},
           "after": {"volume": 13990, "source": "litres"}}]}');
    """)
    t = pg.json("select data->'tanks'->0 from dec_history where id = 'h4';", anon=True)
    assert t["before"] == {"volume": 9989.83, "source": "photo-edited", "screenVolume": 9998.83, "dip": 98.7}
    assert t["after"] == {"volume": 13990, "source": "litres"}


def test_single_config_row(pg):
    pg.fails("insert into dec_config (id) values (2);")


def test_remove_from_payments_refuses_the_decant_project(pg):
    _reset(pg)
    pg.ok("insert into dec_tank_state (tank_id, reading) values ('T1', '{\"volume\": 1}') "
          "on conflict (tank_id) do update set reading = excluded.reading;")
    before = pg.ok("select count(*) from dec_tank_state;")
    out = pg.fails(open(REMOVE, encoding="utf-8").read())
    assert "decanting app's own project" in str(out)
    assert pg.ok("select count(*) from dec_tank_state;") == before        # nothing removed
    assert pg.ok("select to_regclass('public.dec_months') is not null;") == "t"


def test_remove_from_payments_touches_only_the_dec_tables(pg):
    _reset(pg)
    pg.ok("delete from dec_tank_state;")
    if pg.ok("select to_regclass('storage.objects') is not null;") == "t":   # only an empty bucket goes
        pg.ok("delete from storage.objects where bucket_id = 'dec-shots';")
    # a stand-in for the payments project's own tables
    pg.ok("create table if not exists pay_rows (id int primary key); insert into pay_rows values (1) on conflict do nothing;")
    remove = open(REMOVE, encoding="utf-8").read()
    pg.ok(remove)
    pg.ok(remove)                                          # safe to run twice
    assert pg.ok("select coalesce(string_agg(relname, ','), '') from pg_class where relname like 'dec\\_%';") == ""
    assert pg.ok("select count(*) from pg_proc where proname = 'dec_purge_old';") == "0"
    assert pg.ok("select count(*) from pay_rows;") == "1"
    if pg.ok("select to_regclass('storage.buckets') is not null;") == "t":   # the storage stub, if made
        assert pg.ok("select count(*) from storage.buckets where id = 'dec-shots';") == "0"
        assert pg.ok("select count(*) from pg_policies where policyname = 'dec_shots_files';") == "0"
    pg.ok(open(SCHEMA, encoding="utf-8").read())           # put the schema back for any later test


# ---- the owner's login: the Log and Reports tabs -------------------------------
OWNER, OTHER = "00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000b2"


def test_only_a_login_on_the_owners_list_is_the_owner(pg):
    pg.ok(f"insert into auth.users (id, email) values ('{OWNER}', 'Owner@example.com'), ('{OTHER}', 'other@example.com') on conflict do nothing;"
          "delete from dec_owners;")
    assert pg.ok("select dec_add_owner('nobody@example.com')").startswith("No login")
    assert "Added owner@example.com" in pg.ok("select dec_add_owner('OWNER@example.com')")
    me = lambda who, email: pg.json("select dec_whoami()", user=who, email=email)   # noqa: E731
    assert me(OWNER, "owner@example.com") == {"email": "owner@example.com", "owner": True}
    assert me(OTHER, "other@example.com")["owner"] is False                  # a login, not the owner's
    assert pg.json("select dec_whoami()", anon=True)["owner"] is False         # the public key alone
    # the list and its functions: SQL Editor only
    pg.fails("select count(*) from dec_owners", user=OWNER, email="owner@example.com")
    pg.fails("select dec_add_owner('other@example.com')", user=OWNER, email="owner@example.com")
    pg.fails("select dec_add_owner('other@example.com')", anon=True)
    # decanting stays open to the public key
    pg.ok("insert into dec_invoices (invoice_no) values ('INV-OWN') on conflict do nothing", anon=True)
    assert "Removed" in pg.ok("select dec_remove_owner('owner@example.com')")
    assert me(OWNER, "owner@example.com")["owner"] is False
    pg.ok("delete from dec_invoices where invoice_no = 'INV-OWN'")
