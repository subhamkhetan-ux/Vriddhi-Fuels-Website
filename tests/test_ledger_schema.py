"""Tests for supabase/ledger-schema.sql, run on a throwaway local Postgres.

Supabase's auth pieces (the anon / authenticated roles, auth.uid(),
auth.jwt() and auth.users) are stubbed, so the schema's row-level security
is checked for real: the public key gets nothing, and a login only sees
data once it is on ledger_members.

All data here is made up. Skipped when Postgres isn't installed.
"""
import glob
import json
import os
import shutil
import socket
import subprocess
import tempfile
import uuid

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "supabase", "ledger-schema.sql")

# What a Supabase project already has before the schema runs.
SUPABASE_STUB = r"""
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Supabase grants everything new in `public` to these roles by default;
-- the schema has to take it back.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
"""

OWNER = str(uuid.UUID(int=1))
STRANGER = str(uuid.UUID(int=2))


def _pg_bin(name):
    found = shutil.which(name)
    if found:
        return found
    hits = sorted(glob.glob(f"/usr/lib/postgresql/*/bin/{name}"))
    return hits[-1] if hits else None


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Pg:
    def __init__(self, sock, port):
        self.sock, self.port = sock, port

    def run(self, sql, *, user=None, email="", anon=False):
        """Run SQL in one session; returns (ok, stdout, stderr)."""
        head = ""
        if anon:
            head = "set role anon;\n"
        elif user:
            claims = json.dumps({"sub": user, "email": email}).replace("'", "''")
            head = ("set role authenticated;\n"
                    f"do $$ begin perform set_config('request.jwt.claim.sub', '{user}', false);"
                    f" perform set_config('request.jwt.claims', '{claims}', false); end $$;\n")
        proc = subprocess.run(
            ["psql", "-h", self.sock, "-p", str(self.port), "-U", "postgres", "-d", "postgres",
             "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
            input=head + sql, capture_output=True, text=True)
        return proc.returncode == 0, proc.stdout.strip(), proc.stderr.strip()

    def ok(self, sql, **kw):
        good, out, err = self.run(sql, **kw)
        assert good, err
        return out

    def json(self, sql, **kw):
        return json.loads(self.ok(sql, **kw).splitlines()[-1])

    def fails(self, sql, **kw):
        good, out, err = self.run(sql, **kw)
        assert not good, f"expected an error, got: {out}"
        return err

    def owner(self, sql):
        return self.json(sql, user=OWNER, email="owner@example.com")


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
    base = tempfile.mkdtemp(prefix="ledger-pg-")
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
        schema = open(SCHEMA, encoding="utf-8").read()
        db.ok(schema)
        db.ok(schema)                          # safe to run twice
        db.ok("insert into auth.users values "
              f"('{OWNER}', 'owner@example.com'), ('{STRANGER}', 'stranger@example.com');")
        yield db
    finally:
        subprocess.run(as_pg + [pg_ctl, "-D", data, "-m", "fast", "stop"], capture_output=True)
        shutil.rmtree(base, ignore_errors=True)


def payload(**over):
    """A small made-up Master Ledger extract."""
    p = {
        "groups": [
            {"code": "Demo_Bulk", "title": "Demo Power — Bulk Ledger", "kind": "po",
             "units": [], "period_from": "2026-04-01", "opening": 1000, "opening_by_unit": {}},
            {"code": "Twin_Bulk", "title": "Twin Steel — Bulk Ledger", "kind": "po_units",
             "units": ["UNIT 1", "UNIT 2"], "period_from": "2026-04-01", "opening": 0,
             "opening_by_unit": {"UNIT 1": 0, "UNIT 2": 0}},
            {"code": "Crew_Bulk", "title": "Crew Group", "kind": "group", "units": [],
             "period_from": "2026-04-01", "opening": 0, "opening_by_unit": {}},
        ],
        "customers": [
            {"name": "Demo Power Ltd", "bulk_group": "Demo_Bulk", "gstin": "22AAAAA0000A1Z5"},
            {"name": "Twin Steel Ltd", "bulk_group": "Twin_Bulk"},
            {"name": "Crew One Logistics", "bulk_group": "Crew_Bulk"},
            {"name": "Retail Roadways", "ledger": "Roadways"},
        ],
        "sales": [
            {"product": "HSD", "bill_no": "1", "sale_date": "2026-04-01", "vehicle": "OD01A1111",
             "qty": 1000, "rate": 90, "amount": 90000, "customer": "Demo Power Ltd", "seq": 2,
             "po_mode": "auto"},
            {"product": "HSD", "bill_no": "2", "sale_date": "2026-04-01", "vehicle": "OD01A2222",
             "qty": 500, "rate": 90, "amount": 45000, "customer": "Twin Steel Ltd", "seq": 3,
             "unit": "UNIT 1", "po_mode": "fixed", "po_fixed": "OLD-PO", "tds": 12},
            {"product": "HSD", "bill_no": "3", "sale_date": "2026-04-02", "vehicle": "OD01A3333",
             "qty": 200, "rate": 90, "amount": 18000, "customer": "retail  roadways", "seq": 4},
            {"product": "MS", "bill_no": "1", "sale_date": "2026-04-01", "vehicle": "OD01B1111",
             "qty": 10, "rate": 100, "amount": 1000, "customer": "Retail Roadways", "seq": 2},
            {"product": "OTHER", "bill_no": "LUBE/001", "sale_date": "2026-04-03", "amount": 700,
             "customer": "Lube Only Buyer", "item": "Engine oil", "seq": 2},
            {"product": "MS", "bill_no": "2", "sale_date": "2026-04-06", "vehicle": "OD01B2222",
             "qty": 3, "rate": 100, "amount": 300, "customer": "Walk In Cash", "seq": 3},
            # the same bill twice in the workbook: kept once
            {"product": "HSD", "bill_no": "3", "sale_date": "2026-04-02", "vehicle": "DUP",
             "qty": 1, "rate": 1, "amount": 1, "customer": "Retail Roadways", "seq": 99},
        ],
        "payments": [
            {"pay_date": "2026-04-05", "customer": "Demo Power Ltd", "amount": 50000,
             "mode": "HDFC 1010", "seq": 2},
            {"pay_date": "2026-04-06", "customer": "Payment Only Person", "amount": 300, "seq": 3},
        ],
        "pos": [
            {"group_code": "Demo_Bulk", "unit": "", "po_no": "PO-A", "allotted": 5000, "seq": 1},
            {"group_code": "Demo_Bulk", "unit": "", "po_no": "PO-B", "allotted": 3000, "seq": 2},
            {"group_code": "Twin_Bulk", "unit": "UNIT 1", "po_no": "T1-1", "allotted": 800, "seq": 1},
            {"group_code": "Nope_Bulk", "unit": "", "po_no": "X", "allotted": 1, "seq": 1},
        ],
        "opening": [
            {"customer": "Retail Roadways", "month": "2026-04-01", "amount": 2500},
        ],
    }
    p.update(over)
    return p


def call(name, *args):
    rendered = []
    for a in args:
        if a is None:
            rendered.append("null")
        elif isinstance(a, (dict, list)):
            rendered.append("'" + json.dumps(a).replace("'", "''") + "'::jsonb")
        elif isinstance(a, (int, float)):
            rendered.append(str(a))
        else:
            rendered.append("'" + str(a).replace("'", "''") + "'")
    return f"select public.{name}({', '.join(rendered)});"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def test_norm_and_fy(pg):
    assert pg.ok("select ledger_norm(E'  M/s  Demo\\u00a0Power\\tLtd ')") == "m/s demo power ltd"
    assert pg.ok("select ledger_fy('2026-04-01')") == "2026-27"
    assert pg.ok("select ledger_fy('2027-03-31')") == "2026-27"
    assert pg.ok("select ledger_fy('2026-03-31')") == "2025-26"
    assert pg.ok("select ledger_fy('2099-12-01')") == "2099-00"


# ---------------------------------------------------------------------------
# who can see what
# ---------------------------------------------------------------------------
def test_public_key_gets_nothing(pg):
    err = pg.fails("select count(*) from ledger_sales;", anon=True)
    assert "permission denied" in err
    err = pg.fails("select ledger_summary();", anon=True)
    assert "permission denied" in err
    err = pg.fails("select * from ledger_members;", anon=True)
    assert "permission denied" in err


def test_login_must_be_a_member(pg):
    err = pg.fails("select ledger_summary();", user=STRANGER, email="stranger@example.com")
    assert "not on the ledger members list" in err
    who = pg.json("select ledger_whoami();", user=STRANGER, email="stranger@example.com")
    assert who == {"user_id": STRANGER, "email": "stranger@example.com", "member": False}
    # a login can't add itself
    err = pg.fails("select ledger_add_member('stranger@example.com');",
                   user=STRANGER, email="stranger@example.com")
    assert "permission denied" in err
    err = pg.fails("insert into ledger_members values "
                   f"('{STRANGER}', 'stranger@example.com');",
                   user=STRANGER, email="stranger@example.com")
    assert "permission denied" in err


def test_add_member_from_sql_editor(pg):
    assert pg.ok("select ledger_add_member('nobody@example.com');").startswith("No login")
    assert pg.ok("select ledger_add_member(' OWNER@example.com ');") == \
        "Added owner@example.com to the ledger members."
    assert pg.owner("select ledger_whoami();")["member"] is True


# ---------------------------------------------------------------------------
# Master Ledger upload
# ---------------------------------------------------------------------------
def test_master_import(pg):
    pg.ok("select ledger_add_member('owner@example.com');")
    res = pg.owner(call("ledger_import_master", "Master Ledger.xlsm", payload()))
    assert res["groups"] == 3
    assert res["sales_new"] == 6 and res["sales_updated"] == 0      # duplicate bill kept once
    assert res["payments"] == 2
    assert res["pos_new"] == 3                                       # unknown group skipped
    assert res["opening"] == 1
    # customers: 4 named + "Walk In Cash" from the MS sheet ("retail  roadways" is the
    # same key); names only on Other Sale or Master Paid aren't customers, like Excel
    assert res["customers_new"] == 5

    custs = {c["name"]: c for c in pg.owner(call("ledger_customers_list"))}
    assert set(custs) == {"Crew One Logistics", "Demo Power Ltd", "Retail Roadways",
                          "Twin Steel Ltd", "Walk In Cash"}
    assert custs["Retail Roadways"]["ledger"] == "Roadways"
    assert custs["Retail Roadways"]["bills"] == 2
    assert custs["Demo Power Ltd"]["gstin"] == "22AAAAA0000A1Z5"

    # a stranger with a login still sees no rows
    assert pg.ok("select count(*) from ledger_sales;",
                 user=STRANGER, email="stranger@example.com") == "0"
    err = pg.fails("insert into ledger_sales (product, fy, bill_no, sale_date, customer, customer_key)"
                   " values ('HSD', '', 'X', '2026-04-01', 'x', 'x');",
                   user=STRANGER, email="stranger@example.com")
    assert "row-level security" in err

    summary = pg.owner(call("ledger_summary"))
    assert summary["sales"]["HSD"]["bills"] == 3
    assert summary["needs_ledger"] == 1                               # Walk In Cash
    assert summary["last_master_import"]["file_name"] == "Master Ledger.xlsm"


def test_reupload_policies(pg):
    # the app sets a unit, a PO choice and a ledger name ...
    data = pg.owner(call("ledger_po_data", "Demo_Bulk"))
    bill1 = data["bills"][0]
    pg.owner(call("ledger_bill_update", bill1["id"], {"po_mode": "fixed", "po_fixed": "APP-PO"}))
    walk = next(c for c in pg.owner(call("ledger_customers_list")) if c["name"] == "Walk In Cash")
    pg.owner(call("ledger_customer_update", walk["id"], {"ledger": "Cash"}))
    pg.owner(call("ledger_po_save", {"group_code": "Demo_Bulk", "po_no": "APP-NEW",
                                     "allotted": 100}))

    # ... then Excel changes things and the workbook is uploaded again
    p = payload()
    p["sales"][0].update({"qty": 1100, "amount": 99000, "po_mode": "fixed", "po_fixed": "XL-PO"})
    p["sales"][1].update({"unit": "UNIT 2", "tds": 15, "remarks": "short by 2 L"})
    p["customers"].append({"name": "Walk In Cash", "ledger": "Walkin"})
    p["payments"] = p["payments"][:1]
    p["pos"][0]["allotted"] = 9999                                  # already in the app
    p["pos"].append({"group_code": "Demo_Bulk", "unit": "", "po_no": "PO-C", "allotted": 700, "seq": 3})
    p["opening"][0]["amount"] = 2600
    res = pg.owner(call("ledger_import_master", "Master Ledger v2.xlsm", p))
    assert res["sales_new"] == 0 and res["sales_updated"] == 6
    assert res["payments"] == 1 and res["pos_new"] == 1

    sale = pg.owner("select to_jsonb(s) from ledger_sales s where product = 'HSD' and bill_no = '1';")
    assert float(sale["qty"]) == 1100                                # Excel's figures win
    assert sale["po_mode"] == "fixed" and sale["po_fixed"] == "APP-PO"  # the app's PO choice stays
    twin = pg.owner("select to_jsonb(s) from ledger_sales s where product = 'HSD' and bill_no = '2';")
    assert twin["unit"] == "UNIT 1"                                  # unit only fills blanks
    assert float(twin["tds"]) == 15 and twin["remarks"] == "short by 2 L"
    assert pg.owner("select to_jsonb(ledger) from ledger_customers where name = 'Walk In Cash';") == "Cash"
    assert pg.ok("select count(*) from ledger_payments;") == "1"
    pos = pg.owner(call("ledger_po_data", "Demo_Bulk"))["pos"]
    assert [(p["po_no"], float(p["allotted"])) for p in pos] == \
        [("PO-A", 5000), ("PO-B", 3000), ("APP-NEW", 100), ("PO-C", 700)]
    assert pg.ok("select amount from ledger_opening;") == "2600"


# ---------------------------------------------------------------------------
# DayBook import
# ---------------------------------------------------------------------------
def test_daybook_import(pg):
    rows = [
        {"product": "HSD", "bill_no": "3", "sale_date": "2026-04-02", "vehicle": "X", "qty": 5,
         "rate": 1, "amount": 5, "customer": "Retail Roadways"},               # already there
        {"product": "HSD", "bill_no": "4", "sale_date": "2026-04-07", "vehicle": "OD02C4444",
         "qty": 300, "rate": 91, "amount": 27300, "customer": "Demo Power Ltd"},
        {"product": "HSD", "bill_no": "5", "sale_date": "2026-04-07", "vehicle": "OD02C5555",
         "qty": 50, "rate": 91, "amount": 4550, "customer": "Brand New Movers"},
        {"product": "XG", "bill_no": "XG1", "sale_date": "2026-04-07", "vehicle": "",
         "qty": 20, "rate": 95, "amount": 1900, "customer": "Brand New Movers"},
        {"product": "HSD", "bill_no": "4", "sale_date": "2026-04-07", "vehicle": "again",
         "qty": 1, "rate": 1, "amount": 1, "customer": "Demo Power Ltd"},      # twice in the file
        {"product": "HSD", "bill_no": "1", "sale_date": "2027-04-01", "vehicle": "NEWFY",
         "qty": 10, "rate": 99, "amount": 990, "customer": "Demo Power Ltd"},  # bill 1 of next FY
        {"product": "BAD", "bill_no": "9", "sale_date": "2026-04-07", "customer": "x"},
    ]
    before = pg.owner(call("ledger_existing_bills", rows))
    assert before == ["HSD|2026-27|3"]
    res = pg.owner(call("ledger_import_daybook", "DayBook 07-04-26.xlsx", rows))
    assert res["rows"] == 6
    assert res["inserted"] == {"HSD": 3, "XG": 1}
    assert res["duplicates"] == 2
    assert res["new_customers"] == ["Brand New Movers"]

    seqs = pg.ok("select string_agg(bill_no || ':' || seq, ',' order by seq) from ledger_sales"
                 " where product = 'HSD';")
    assert seqs == "1:2,2:3,3:4,4:6,5:7,1:10"     # continues after the last row, in file order
    day = pg.owner(call("ledger_sales_day", None))
    assert day["date"] == "2027-04-01"
    day = pg.owner(call("ledger_sales_day", "2026-04-07"))
    assert [(b["product"], b["bill_no"]) for b in day["bills"]] == [("HSD", "4"), ("HSD", "5"), ("XG", "XG1")]
    imports = pg.owner(call("ledger_imports_list", 5))
    assert imports[0]["kind"] == "daybook" and imports[0]["counts"]["duplicates"] == 2


# ---------------------------------------------------------------------------
# PO lists, bills and customers
# ---------------------------------------------------------------------------
def test_po_data_scope(pg):
    data = pg.owner(call("ledger_po_data", None))
    assert [g["code"] for g in data["groups"]] == ["Crew_Bulk", "Demo_Bulk", "Twin_Bulk"]
    # only diesel bills of PO groups from their period start
    assert sorted((b["group"], b["bill_no"]) for b in data["bills"]) == \
        [("Demo_Bulk", "1"), ("Demo_Bulk", "1"), ("Demo_Bulk", "4"), ("Twin_Bulk", "2")]


def test_po_editing(pg):
    err = pg.fails(call("ledger_po_save", {"group_code": "Demo_Bulk", "po_no": "po-a",
                                            "allotted": 1}), user=OWNER, email="owner@example.com")
    assert "already in this list" in err
    err = pg.fails(call("ledger_po_save", {"group_code": "Demo_Bulk", "po_no": " "}),
                   user=OWNER, email="owner@example.com")
    assert "Enter the PO number" in err

    def order():
        return [p["po_no"] for p in pg.owner(call("ledger_po_data", "Demo_Bulk"))["pos"]]

    last = pg.owner(call("ledger_po_data", "Demo_Bulk"))["pos"][-1]
    pg.ok(call("ledger_po_move", last["id"], -1), user=OWNER, email="owner@example.com")
    assert order() == ["PO-A", "PO-B", "PO-C", "APP-NEW"]
    first = pg.owner(call("ledger_po_data", "Demo_Bulk"))["pos"][0]
    pg.ok(call("ledger_po_move", first["id"], -1), user=OWNER, email="owner@example.com")
    assert order() == ["PO-A", "PO-B", "PO-C", "APP-NEW"]              # already first
    saved = pg.owner(call("ledger_po_save", {"id": first["id"], "po_no": "PO-A1", "allotted": 4000}))
    assert saved["po_no"] == "PO-A1" and float(saved["allotted"]) == 4000
    pg.ok(call("ledger_po_delete", saved["id"]), user=OWNER, email="owner@example.com")
    assert order() == ["PO-B", "PO-C", "APP-NEW"]


def test_bill_and_customer_updates(pg):
    bill = pg.owner("select to_jsonb(s) from ledger_sales s where product = 'HSD' and bill_no = '4';")
    res = pg.owner(call("ledger_bill_update", bill["id"], {"unit": " unit 2 "}))
    assert res["unit"] == "UNIT 2" and res["po_user_set"] is False
    res = pg.owner(call("ledger_bill_update", bill["id"], {"po_mode": "auto"}))
    assert res["po_mode"] == "auto" and res["po_fixed"] == "" and res["po_user_set"] is True
    err = pg.fails(call("ledger_bill_update", bill["id"], {"po_mode": "maybe"}),
                   user=OWNER, email="owner@example.com")
    assert "auto or fixed" in err

    custs = {c["name"]: c for c in pg.owner(call("ledger_customers_list"))}
    err = pg.fails(call("ledger_customer_update", custs["Brand New Movers"]["id"], {"ledger": "roadways"}),
                   user=OWNER, email="owner@example.com")
    assert "already used by Retail Roadways" in err
    res = pg.owner(call("ledger_customer_update", custs["Brand New Movers"]["id"],
                        {"ledger": "Movers", "archived": True}))
    assert res["ledger"] == "Movers" and res["archived"] is True


# ---------------------------------------------------------------------------
# Phase 2: Tanker Master, slip heading, bills of a date range
# ---------------------------------------------------------------------------
def test_tanker_master_settings_and_sales_range(pg):
    p = payload()
    p["tanker"] = [
        {"company": "Demo Power Ltd", "hsd_rate": 90.5, "address": ["At- Demo", "Testpur", ""],
         "payment": ["Payment Details:", "A/c 0000", "", "", ""], "po_label": "P.O. No.:", "po_no": "",
         "price_tier": "Bulk"},
        {"company": "Twin Steel Ltd, UNIT I", "hsd_rate": 90, "address": [], "payment": []},
        {"company": "Demo Power Ltd", "hsd_rate": 1},                     # listed twice: first kept
    ]
    p["settings"] = {"slip_header": {"title": "CREDIT MEMO", "mobile": "Mob : 1", "lines": ["DEMO FUELS"]}}
    res = pg.owner(call("ledger_import_master", "Master Ledger v3.xlsm", p))
    assert res["tanker"] == 2
    tanker = pg.owner(call("ledger_tanker_list"))
    assert [(t["company"], float(t["hsd_rate"])) for t in tanker] == [("Demo Power Ltd", 90.5), ("Twin Steel Ltd, UNIT I", 90)]
    assert tanker[0]["address"] == ["At- Demo", "Testpur", ""]
    assert pg.owner(call("ledger_setting_get", "slip_header"))["lines"] == ["DEMO FUELS"]
    assert pg.ok("select ledger_setting_get('nothing') is null;", user=OWNER, email="owner@example.com") == "t"

    # an upload without a Tanker Master sheet leaves it alone
    res = pg.owner(call("ledger_import_master", "Master Ledger v4.xlsm", payload()))
    assert res["tanker"] == 0 and len(pg.owner(call("ledger_tanker_list"))) == 2

    bills = pg.owner(call("ledger_sales_range", "2026-04-01", "2026-04-02"))
    assert [(b["product"], b["bill_no"]) for b in bills] == [("HSD", "1"), ("HSD", "2"), ("HSD", "3"), ("MS", "1")]
    assert bills[1]["unit"] == "UNIT 1"
    err = pg.fails(call("ledger_sales_range", "2026-04-02", "2026-04-01"), user=OWNER, email="owner@example.com")
    assert "From date on or before" in err
    err = pg.fails(call("ledger_sales_range", "2026-04-01", "2027-06-01"), user=OWNER, email="owner@example.com")
    assert "at most 400 days" in err
    assert "permission denied" in pg.fails("select ledger_tanker_list();", anon=True)
    assert pg.ok("select count(*) from ledger_tanker_customers;", user=STRANGER, email="stranger@example.com") == "0"


def test_slip_stamp_setting(pg):
    pg.ok(call("ledger_setting_set", "slip_stamp", {"data_url": "data:image/png;base64,AA"}), user=OWNER, email="owner@example.com")
    assert pg.owner(call("ledger_setting_get", "slip_stamp"))["data_url"].startswith("data:image/png")
    err = pg.fails(call("ledger_setting_set", "slip_header", {"x": 1}), user=OWNER, email="owner@example.com")
    assert "Unknown setting" in err
    err = pg.fails(call("ledger_setting_set", "slip_stamp", {"data_url": "x" * 800000}), user=OWNER, email="owner@example.com")
    assert "too big" in err
    pg.ok("select ledger_setting_set('slip_stamp', null);", user=OWNER, email="owner@example.com")
    assert pg.ok("select ledger_setting_get('slip_stamp') is null;", user=OWNER, email="owner@example.com") == "t"
    assert "permission denied" in pg.fails("select ledger_setting_set('slip_stamp', null);", anon=True)
