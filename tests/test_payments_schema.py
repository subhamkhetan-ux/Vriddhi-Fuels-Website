"""supabase/payments-schema.sql: never a second consignment note for one invoice.

Runs the schema on a throwaway local Postgres (the stubbed-Supabase harness of
test_ledger_schema.py). Skipped when Postgres isn't installed. Data is made up.
"""
import os
import shutil
import subprocess
import tempfile

import pytest

from tests.test_ledger_schema import SUPABASE_STUB, Pg, _free_port, _pg_bin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = open(os.path.join(ROOT, "supabase", "payments-schema.sql"), encoding="utf-8").read()


@pytest.fixture
def pg():
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not (initdb and pg_ctl and shutil.which("psql")):
        pytest.skip("PostgreSQL is not installed")
    as_pg = []
    if os.geteuid() == 0:                      # postgres refuses to run as root
        if not shutil.which("runuser"):
            pytest.skip("running as root without runuser")
        as_pg = ["runuser", "-u", "postgres", "--"]
    base = tempfile.mkdtemp(prefix="payments-pg-")
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
        yield db
    finally:
        subprocess.run(as_pg + [pg_ctl, "-D", data, "-m", "fast", "stop"], capture_output=True)
        shutil.rmtree(base, ignore_errors=True)


def claim(pg, invoice_no, note_id=None, date="04/11/2026", **kw):
    """Claim as the app does (anon key); returns 'serial|status|lifetime'."""
    nid = note_id or f"id-{invoice_no}"
    return pg.ok(
        "select serial_str || '|' || status || '|' || lifetime_num from pay_claim_consignment("
        f"'{nid}', null, '{invoice_no}', '{date}', 'OD23U8210', 'HSD-BSVI [PDRP]', 'HSD', '22', 2159219);",
        anon=True, **kw).splitlines()[-1]


def counter(pg):
    return pg.ok("select next_val from pay_consignment_seq where id = 1;")


def test_one_note_per_invoice_whatever_the_path(pg):
    pg.ok(SCHEMA)
    pg.ok(SCHEMA)                                           # safe to run twice
    assert claim(pg, "7011300001") == "VF/CN2627/047|pending|47"
    # the late mail (same id), a PDF upload keyed differently, a file name: all the same note
    assert claim(pg, "7011300001") == "VF/CN2627/047|pending|47"
    assert claim(pg, "7011300001", note_id="some-other-id") == "VF/CN2627/047|pending|47"
    assert claim(pg, " 7011300001.pdf ", note_id="third-id") == "VF/CN2627/047|pending|47"
    assert counter(pg) == "48"
    assert pg.ok("select count(*) from pay_consignment_notes;") == "1"
    assert claim(pg, "7011300002") == "VF/CN2627/048|pending|48"


def test_a_note_that_dropped_off_the_list_is_never_issued_again(pg):
    pg.ok(SCHEMA)
    for n in range(1, 8):
        claim(pg, f"70113000{n:02d}")                       # 047 … 053
    pg.ok("select pay_consignment_purge_old();")
    assert pg.ok("select count(*) from pay_consignment_notes;") == "5"
    before = counter(pg)
    # IOCL resends invoice 1 (its note 047 was purged): reported, not re-issued
    assert claim(pg, "7011300001", note_id="resent") == "VF/CN2627/047|done|47"
    assert claim(pg, "7011300002") == "VF/CN2627/048|done|48"
    assert counter(pg) == before
    assert pg.ok("select count(*) from pay_consignment_notes;") == "5"   # nothing re-inserted
    # a dismissed note stays dismissed and isn't re-issued either
    pg.ok("update pay_consignment_notes set status = 'done' where invoice_no = '7011300007';")
    assert claim(pg, "7011300007", note_id="again") == "VF/CN2627/053|done|53"


def test_the_ledger_refuses_a_second_note_even_written_directly(pg):
    pg.ok(SCHEMA)
    claim(pg, "7011300001")
    pg.fails("insert into pay_consignment_issued (invoice_no) values ('7011300001');")
    pg.fails("insert into pay_consignment_issued (invoice_no) values ('7011399999');", anon=True)
    pg.fails("delete from pay_consignment_issued;", anon=True)
    assert pg.ok("select count(*) from pay_consignment_issued;", anon=True) == "1"   # the app can read it


def test_an_existing_install_records_its_notes_and_guards_older_invoices(pg):
    # an install from before the ledger: 5 notes left after purges (047–051 gone)
    pg.ok(SCHEMA.split("-- ---- one note per invoice number, forever")[0])
    pg.ok("insert into pay_consignment_notes (id, serial_num, lifetime_num, serial_str, invoice_no, invoice_date, status) values "
          + ",".join(f"('n{n}', {n}, {n}, 'VF/CN2627/0{n}', '70114000{n}', '01/11/2026', 'pending')" for n in range(52, 57))
          + "; update pay_consignment_seq set next_val = 57; update pay_consignment_fy_seq set next_val = 57;")
    pg.ok(SCHEMA)                                           # the update
    assert pg.ok("select count(*) from pay_consignment_issued where legacy;") == "5"
    assert claim(pg, "7011400052", note_id="resent") == "VF/CN2627/052|pending|52"
    # older than every recorded note: it may have been one of 047–051 — refused
    ok, _, err = pg.run("select pay_claim_consignment('x', null, '7011400040', '01/11/2026', 'OD23U8210', 'HSD', 'HSD', '22', 1);", anon=True)
    assert not ok and "may already have had a note" in err
    assert counter(pg) == "57"
    assert claim(pg, "7011400060") == "VF/CN2627/057|pending|57"         # newer ones go on as usual
