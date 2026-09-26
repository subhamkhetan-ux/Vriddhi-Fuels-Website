-- =====================================================================
-- Vriddhi Fuels — Ledger app (/ledger/) cloud store
-- ---------------------------------------------------------------------
-- Paste this whole file into the SQL Editor of the Supabase project you
-- made for the ledger app and press Run. It is safe to run again: later
-- phases add to this file, and re-running it is how you upgrade.
--
-- Use its own project, not one of the projects your other apps use, so
-- nothing about those apps changes.
--
-- Who can see the data
--   * The public (anon / publishable) key can't read or call anything.
--   * A login alone isn't enough either: the login must also be on the
--     ledger_members list, which only this SQL Editor can change.
--       1. Authentication → Users → Add user (email + password)
--       2. Run:  select ledger_add_member('you@example.com');
--
-- Every read and write goes through the ledger_* functions below, so each
-- import is one all-or-nothing transaction.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Customer names match the way Excel matches them (case-insensitive),
-- and also ignore stray/double spaces. ledger/js/util.js normKey() is
-- the same rule in the browser.
create or replace function public.ledger_norm(p text)
returns text language sql immutable as $$
  select lower(btrim(regexp_replace(coalesce(p, ''), '[\t\n\v\f\r  ]+', ' ', 'g')));
$$;

-- Indian financial year of a date: 2026-04-01 .. 2027-03-31 -> '2026-27'.
-- Tally restarts bill numbers every April, so a bill is unique per
-- product + financial year + bill number.
create or replace function public.ledger_fy(p date)
returns text language sql immutable as $$
  select case when p is null then null else
    y::text || '-' || lpad(((y + 1) % 100)::text, 2, '0') end
  from (select case when extract(month from p) >= 4 then extract(year from p)::int
                    else extract(year from p)::int - 1 end as y) t;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- Logins allowed to use the ledger app (changed only from the SQL Editor).
create table if not exists public.ledger_members (
  user_id  uuid primary key,
  email    text not null,
  added_at timestamptz not null default now()
);

-- Every customer the app has seen (from sales, payments or the ledger).
create table if not exists public.ledger_customers (
  id           bigint generated always as identity primary key,
  name         text not null,                      -- Tally name, as in the sale sheets
  customer_key text not null unique,               -- ledger_norm(name)
  ledger       text,                               -- ledger (tab) name, e.g. 'SSM'; null = none yet
  no_ledger    boolean not null default false,     -- you said this customer needs no ledger
  bulk_group   text,                               -- the *_Bulk ledger it is billed through
  gstin        text not null default '',
  archived     boolean not null default false,     -- "Bulk Delete Ledger": hidden, history kept
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per *_Bulk sheet.
--   kind 'po'       : one PO list (most Bulk sheets)
--   kind 'po_units' : one PO list per unit (UNIT 1 / UNIT 2)
--   kind 'group'    : a group ledger of several billing names, without POs
create table if not exists public.ledger_bulk_groups (
  code            text primary key,                -- the sheet name, e.g. 'SMC_Bulk'
  title           text not null default '',
  kind            text not null check (kind in ('po', 'po_units', 'group')),
  units           text[] not null default '{}',
  period_from     date,                            -- the sheet's "period from" date
  opening         numeric,                         -- opening balance
  opening_by_unit jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

-- HSD / MS / XG sales (one row per Tally bill) and Other Sale bills.
create table if not exists public.ledger_sales (
  id           bigint generated always as identity primary key,
  product      text not null check (product in ('HSD', 'MS', 'XG', 'OTHER')),
  fy           text not null,                      -- set by trigger from sale_date
  bill_no      text not null,
  sale_date    date not null,
  vehicle      text not null default '',
  qty          numeric,
  rate         numeric,
  amount       numeric,
  customer     text not null,
  customer_key text not null,                      -- set by trigger from customer
  item         text not null default '',           -- Other Sale: product name
  seq          bigint not null default 0,          -- order within the product (sheet row / DayBook order)
  -- The per-bill cells you fill in on a *_Bulk sheet:
  unit         text not null default '',           -- 'UNIT 1' / 'UNIT 2' (unit-wise PO lists)
  po_mode      text not null default 'auto' check (po_mode in ('auto', 'fixed')),
  po_fixed     text not null default '',           -- the PO when po_mode = 'fixed' ('' = no PO)
  po_user_set  boolean not null default false,     -- chosen in the app: uploads never change it
  tds          numeric,
  shortage     numeric,
  remarks      text not null default '',
  source       text not null default 'daybook' check (source in ('daybook', 'master_ledger')),
  import_id    bigint,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (product, fy, bill_no)
);
create index if not exists ledger_sales_customer_idx on public.ledger_sales (customer_key, sale_date);
create index if not exists ledger_sales_date_idx on public.ledger_sales (sale_date);

-- Payments (Master Paid). TDS / shortage / remarks come from the payment
-- rows of the *_Bulk sheets.
create table if not exists public.ledger_payments (
  id           bigint generated always as identity primary key,
  pay_date     date not null,
  customer     text not null,
  customer_key text not null,                      -- set by trigger from customer
  amount       numeric not null,
  mode         text not null default '',
  source       text not null check (source in ('master_ledger', 'payments_app', 'manual')),
  source_ref   text,
  seq          bigint not null default 0,
  tds          numeric,
  shortage     numeric,
  remarks      text not null default '',
  import_id    bigint,
  created_at   timestamptz not null default now()
);
create unique index if not exists ledger_payments_ref_uidx
  on public.ledger_payments (source, source_ref) where source_ref is not null;
create index if not exists ledger_payments_customer_idx on public.ledger_payments (customer_key, pay_date);

-- PO lists. A diesel bill gets the FIRST PO in its list that still has
-- enough litres left, so the order of the list matters (seq).
create table if not exists public.ledger_po (
  id         bigint generated always as identity primary key,
  group_code text not null references public.ledger_bulk_groups (code) on delete cascade,
  unit       text not null default '',             -- '' for single-list groups
  po_no      text not null,
  allotted   numeric not null default 0,           -- litres
  seq        int not null default 0,
  note       text not null default '',
  source     text not null default 'app' check (source in ('app', 'master_ledger')),
  created_at timestamptz not null default now()
);
create unique index if not exists ledger_po_uidx on public.ledger_po (group_code, unit, upper(po_no));

-- Month-opening balances (the Outstanding sheet's monthly table).
create table if not exists public.ledger_opening (
  customer_key text not null,                      -- set by trigger from customer
  month        date not null,                      -- first day of the month
  customer     text not null,
  amount       numeric not null,
  source       text not null default 'master_ledger',
  updated_at   timestamptz not null default now(),
  primary key (customer_key, month)
);

-- One row per upload (Master Ledger or DayBook), with what it changed.
create table if not exists public.ledger_imports (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('master_ledger', 'daybook')),
  file_name  text not null default '',
  counts     jsonb not null default '{}'::jsonb,
  by_email   text not null default '',
  created_at timestamptz not null default now()
);

-- Tanker Master (the workbook's Customers table): who gets a Daily Tanker
-- Bill, and the address / payment lines printed on it. Replaced by every
-- Master Ledger upload that has the sheet.
create table if not exists public.ledger_tanker_customers (
  company    text primary key,
  hsd_rate   numeric,
  address    text[] not null default '{}',
  payment    text[] not null default '{}',
  po_label   text not null default '',
  po_no      text not null default '',
  price_tier text not null default '',
  seq        int not null default 0,
  updated_at timestamptz not null default now()
);

-- App settings (e.g. the fuel-slip heading from the HSD Bill sheet).
create table if not exists public.ledger_settings (
  key        text primary key,
  value      jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- Derived columns (kept in step by triggers)
-- ---------------------------------------------------------------------
create or replace function public.ledger_sales_derive() returns trigger
language plpgsql as $$
begin
  new.bill_no := btrim(new.bill_no);
  new.fy := public.ledger_fy(new.sale_date);
  new.customer := btrim(new.customer);
  new.customer_key := public.ledger_norm(new.customer);
  new.unit := upper(btrim(coalesce(new.unit, '')));
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ledger_sales_derive on public.ledger_sales;
create trigger ledger_sales_derive before insert or update on public.ledger_sales
  for each row execute function public.ledger_sales_derive();

create or replace function public.ledger_payments_derive() returns trigger
language plpgsql as $$
begin
  new.customer := btrim(new.customer);
  new.customer_key := public.ledger_norm(new.customer);
  return new;
end $$;
drop trigger if exists ledger_payments_derive on public.ledger_payments;
create trigger ledger_payments_derive before insert or update on public.ledger_payments
  for each row execute function public.ledger_payments_derive();

create or replace function public.ledger_customers_derive() returns trigger
language plpgsql as $$
begin
  new.name := btrim(new.name);
  new.customer_key := public.ledger_norm(new.name);
  return new;
end $$;
drop trigger if exists ledger_customers_derive on public.ledger_customers;
create trigger ledger_customers_derive before insert or update on public.ledger_customers
  for each row execute function public.ledger_customers_derive();

create or replace function public.ledger_opening_derive() returns trigger
language plpgsql as $$
begin
  new.customer := btrim(new.customer);
  new.customer_key := public.ledger_norm(new.customer);
  return new;
end $$;
drop trigger if exists ledger_opening_derive on public.ledger_opening;
create trigger ledger_opening_derive before insert or update on public.ledger_opening
  for each row execute function public.ledger_opening_derive();

create or replace function public.ledger_po_derive() returns trigger
language plpgsql as $$
begin
  new.po_no := btrim(new.po_no);
  new.unit := upper(btrim(coalesce(new.unit, '')));
  return new;
end $$;
drop trigger if exists ledger_po_derive on public.ledger_po;
create trigger ledger_po_derive before insert or update on public.ledger_po
  for each row execute function public.ledger_po_derive();


-- ---------------------------------------------------------------------
-- Members and row-level security
-- ---------------------------------------------------------------------
create or replace function public.ledger_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from public.ledger_members m where m.user_id = auth.uid());
$$;

create or replace function public.ledger_assert_member()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.ledger_is_member() then
    raise exception 'This login is not on the ledger members list.'
      using errcode = '42501',
            hint = 'In the SQL Editor run: select ledger_add_member(''your login email'');';
  end if;
end $$;

-- SQL Editor only: allow / remove a login.
create or replace function public.ledger_add_member(p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text;
begin
  select u.id, u.email into v_id, v_email
  from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
  if v_id is null then
    return 'No login with that email yet. Create it under Authentication → Users first.';
  end if;
  insert into public.ledger_members (user_id, email) values (v_id, v_email)
  on conflict (user_id) do update set email = excluded.email;
  return 'Added ' || v_email || ' to the ledger members.';
end $$;

create or replace function public.ledger_remove_member(p_email text)
returns text language plpgsql security definer set search_path = public as $$
begin
  delete from public.ledger_members where lower(email) = lower(btrim(p_email));
  if not found then return 'That email was not on the list.'; end if;
  return 'Removed ' || btrim(p_email) || ' from the ledger members.';
end $$;

do $$
declare t text;
begin
  foreach t in array array['ledger_customers', 'ledger_bulk_groups', 'ledger_sales', 'ledger_payments',
                           'ledger_po', 'ledger_opening', 'ledger_imports', 'ledger_settings',
                           'ledger_tanker_customers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_members', t);
    execute format('create policy %I on public.%I for all to authenticated '
                   'using ((select public.ledger_is_member())) with check ((select public.ledger_is_member()))',
                   t || '_members', t);
  end loop;
end $$;

alter table public.ledger_members enable row level security;
revoke all on public.ledger_members from public, anon, authenticated;
grant select on public.ledger_members to authenticated;
drop policy if exists ledger_members_read on public.ledger_members;
create policy ledger_members_read on public.ledger_members for select to authenticated
  using ((select public.ledger_is_member()));


-- ---------------------------------------------------------------------
-- App functions (called from /ledger/ with supabase.rpc)
-- ---------------------------------------------------------------------

create or replace function public.ledger_whoami()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('user_id', auth.uid(),
                            'email', coalesce(auth.jwt() ->> 'email', ''),
                            'member', public.ledger_is_member());
$$;

create or replace function public.ledger_summary()
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  return jsonb_build_object(
    'sales', coalesce((select jsonb_object_agg(product, jsonb_build_object('bills', n, 'last', last))
                       from (select product, count(*) as n, max(sale_date) as last
                             from ledger_sales group by product) t), '{}'::jsonb),
    'last_sale_date', (select max(sale_date) from ledger_sales),
    'payments', (select count(*) from ledger_payments),
    'customers', (select count(*) from ledger_customers where not archived),
    'needs_ledger', (select count(*) from ledger_customers
                     where not archived and ledger is null and bulk_group is null and not no_ledger),
    'groups', (select count(*) from ledger_bulk_groups),
    'pos', (select count(*) from ledger_po),
    'last_import', (select to_jsonb(i) from ledger_imports i order by id desc limit 1),
    'last_master_import', (select to_jsonb(i) from ledger_imports i
                           where kind = 'master_ledger' order by id desc limit 1)
  );
end $$;

-- Which of these bills are already in the app? keys: [{product, bill_no, sale_date}]
-- Returns ["HSD|2026-27|1234", ...]
create or replace function public.ledger_existing_bills(p_keys jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  return coalesce((
    select jsonb_agg(distinct s.product || '|' || s.fy || '|' || s.bill_no)
    from jsonb_to_recordset(coalesce(p_keys, '[]'::jsonb)) as k(product text, bill_no text, sale_date date)
    join ledger_sales s on s.product = k.product
                       and s.fy = ledger_fy(k.sale_date)
                       and s.bill_no = btrim(k.bill_no)
  ), '[]'::jsonb);
end $$;

-- "Import Sales": the rows parsed from a Tally DayBook. Bills already in
-- the app are skipped, like the macro; new customer names are added to
-- the customer list (with no ledger name yet).
-- rows: [{product, bill_no, sale_date, vehicle, qty, rate, amount, customer}]
create or replace function public.ledger_import_daybook(p_file_name text, p_rows jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_import    bigint;
  v_total     int;
  v_inserted  jsonb;
  v_customers jsonb;
  v_counts    jsonb;
begin
  perform ledger_assert_member();
  insert into ledger_imports (kind, file_name, by_email)
  values ('daybook', coalesce(p_file_name, ''), coalesce(auth.jwt() ->> 'email', ''))
  returning id into v_import;

  with x as (
    select btrim(coalesce(e ->> 'customer', '')) as customer
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as e
    where e ->> 'product' in ('HSD', 'MS', 'XG')
      and nullif(e ->> 'sale_date', '') is not null
      and btrim(coalesce(e ->> 'bill_no', '')) <> ''
  ), ins as (
    insert into ledger_customers (name, customer_key)
    select distinct on (ledger_norm(customer)) customer, ledger_norm(customer)
    from x where ledger_norm(customer) <> ''
    order by ledger_norm(customer), customer
    on conflict (customer_key) do nothing
    returning name
  )
  select coalesce(jsonb_agg(name order by name), '[]'::jsonb) into v_customers from ins;

  with e as (
    select t.v, t.n
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(v, n)
  ), valid as (
    select e.v ->> 'product' as product,
           btrim(coalesce(e.v ->> 'bill_no', '')) as bill_no,
           (e.v ->> 'sale_date')::date as sale_date,
           btrim(coalesce(e.v ->> 'vehicle', '')) as vehicle,
           (e.v ->> 'qty')::numeric as qty,
           (e.v ->> 'rate')::numeric as rate,
           (e.v ->> 'amount')::numeric as amount,
           btrim(coalesce(e.v ->> 'customer', '')) as customer,
           e.n
    from e
    where e.v ->> 'product' in ('HSD', 'MS', 'XG')
      and nullif(e.v ->> 'sale_date', '') is not null
      and btrim(coalesce(e.v ->> 'bill_no', '')) <> ''
      and btrim(coalesce(e.v ->> 'customer', '')) <> ''
  ), base as (
    select product, max(seq) as m from ledger_sales group by product
  ), ins as (
    insert into ledger_sales (product, fy, bill_no, sale_date, vehicle, qty, rate, amount,
                              customer, customer_key, seq, source, import_id)
    select v.product, ledger_fy(v.sale_date), v.bill_no, v.sale_date, v.vehicle, v.qty, v.rate, v.amount,
           v.customer, ledger_norm(v.customer), coalesce(b.m, 0) + v.n, 'daybook', v_import
    from valid v left join base b on b.product = v.product
    order by v.n
    on conflict (product, fy, bill_no) do nothing
    returning product
  )
  select (select count(*) from valid),
         coalesce((select jsonb_object_agg(product, n)
                   from (select product, count(*) as n from ins group by product) t), '{}'::jsonb)
  into v_total, v_inserted;

  v_counts := jsonb_build_object(
    'rows', v_total,
    'inserted', v_inserted,
    'duplicates', v_total - coalesce((select sum(value::int) from jsonb_each_text(v_inserted)), 0),
    'new_customers', v_customers);
  update ledger_imports set counts = v_counts where id = v_import;
  return v_counts || jsonb_build_object('import_id', v_import);
end $$;

-- "Upload Master Ledger": copies what the app needs from the workbook.
--   * Sales, payments, opening balances and bulk-ledger settings follow
--     Excel (Excel is where you enter them today).
--   * TDS / shortage / remarks on a bill follow Excel whenever Excel has
--     a value.
--   * Customers' ledger names, bulk ledger and GSTIN, the PO lists and a
--     bill's Unit / PO belong to the app after the first upload: later
--     uploads only fill in blanks and add POs the app doesn't have yet.
create or replace function public.ledger_import_master(p_file_name text, p_payload jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_import    bigint;
  v_counts    jsonb;
  v_groups    int;
  v_cust_new  int;
  v_sales_new int;
  v_sales_upd int;
  v_pay       int;
  v_po_new    int;
  v_open      int;
  v_tanker    int := 0;
begin
  perform ledger_assert_member();
  insert into ledger_imports (kind, file_name, by_email)
  values ('master_ledger', coalesce(p_file_name, ''), coalesce(auth.jwt() ->> 'email', ''))
  returning id into v_import;

  -- 1) Bulk ledgers
  insert into ledger_bulk_groups as g (code, title, kind, units, period_from, opening, opening_by_unit, updated_at)
  select distinct on (btrim(x.code)) btrim(x.code), coalesce(x.title, ''), x.kind, coalesce(x.units, '{}'),
         x.period_from, x.opening, coalesce(x.opening_by_unit, '{}'::jsonb), now()
  from jsonb_to_recordset(coalesce(p_payload -> 'groups', '[]'::jsonb))
       as x(code text, title text, kind text, units text[], period_from date, opening numeric, opening_by_unit jsonb)
  where btrim(coalesce(x.code, '')) <> '' and x.kind in ('po', 'po_units', 'group')
  order by btrim(x.code)
  on conflict (code) do update set
    title = excluded.title, kind = excluded.kind, units = excluded.units,
    period_from = excluded.period_from, opening = excluded.opening,
    opening_by_unit = excluded.opening_by_unit, updated_at = now();
  get diagnostics v_groups = row_count;

  -- 2) Customers: the ones the workbook names (Outstanding, Customer GST,
  --    Bulk sheets) plus everyone on the HSD / MS / XG sale sheets — the
  --    same names the workbook's "Bulk Add Ledger" check looks at.
  with src as (
    select x.name, x.ledger, x.gstin, x.bulk_group, 0 as pri
    from jsonb_to_recordset(coalesce(p_payload -> 'customers', '[]'::jsonb))
         as x(name text, ledger text, gstin text, bulk_group text)
    union all
    select x.customer, null, null, null, 1
    from jsonb_to_recordset(coalesce(p_payload -> 'sales', '[]'::jsonb)) as x(customer text, product text)
    where x.product in ('HSD', 'MS', 'XG')
  ), agg as (
    select ledger_norm(name) as k,
           (array_agg(btrim(name) order by pri))[1] as name,
           max(nullif(btrim(ledger), '')) as ledger,
           max(nullif(btrim(gstin), '')) as gstin,
           max(nullif(btrim(bulk_group), '')) as bulk_group
    from src where ledger_norm(name) <> '' group by 1
  ), up as (
    insert into ledger_customers as c (name, customer_key, ledger, gstin, bulk_group)
    select name, k, ledger, coalesce(gstin, ''), bulk_group from agg
    on conflict (customer_key) do update set
      ledger = coalesce(c.ledger, excluded.ledger),
      gstin = case when c.gstin = '' then excluded.gstin else c.gstin end,
      bulk_group = coalesce(c.bulk_group, excluded.bulk_group),
      updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_cust_new from up;

  -- 3) Sales
  with src as (
    select distinct on (x.product, ledger_fy(x.sale_date), btrim(x.bill_no)) x.*
    from jsonb_to_recordset(coalesce(p_payload -> 'sales', '[]'::jsonb)) as x(
           product text, bill_no text, sale_date date, vehicle text, qty numeric, rate numeric,
           amount numeric, customer text, item text, seq bigint, unit text, po_mode text,
           po_fixed text, tds numeric, shortage numeric, remarks text)
    where x.sale_date is not null and btrim(coalesce(x.bill_no, '')) <> ''
      and x.product in ('HSD', 'MS', 'XG', 'OTHER') and btrim(coalesce(x.customer, '')) <> ''
    order by x.product, ledger_fy(x.sale_date), btrim(x.bill_no), x.seq
  ), up as (
    insert into ledger_sales as s (product, fy, bill_no, sale_date, vehicle, qty, rate, amount,
                                   customer, customer_key, item, seq, unit, po_mode, po_fixed,
                                   tds, shortage, remarks, source, import_id)
    select product, ledger_fy(sale_date), btrim(bill_no), sale_date, btrim(coalesce(vehicle, '')),
           qty, rate, amount, btrim(customer), ledger_norm(customer), coalesce(item, ''),
           coalesce(seq, 0), upper(btrim(coalesce(unit, ''))),
           case when po_mode = 'fixed' then 'fixed' else 'auto' end,
           btrim(coalesce(po_fixed, '')), tds, shortage, coalesce(remarks, ''), 'master_ledger', v_import
    from src
    on conflict (product, fy, bill_no) do update set
      sale_date = excluded.sale_date, vehicle = excluded.vehicle, qty = excluded.qty,
      rate = excluded.rate, amount = excluded.amount, customer = excluded.customer,
      item = excluded.item, seq = excluded.seq,
      unit = case when s.unit = '' then excluded.unit else s.unit end,
      po_mode = case when s.po_user_set or s.po_mode = 'fixed' then s.po_mode else excluded.po_mode end,
      po_fixed = case when s.po_user_set or s.po_mode = 'fixed' then s.po_fixed else excluded.po_fixed end,
      tds = coalesce(excluded.tds, s.tds),
      shortage = coalesce(excluded.shortage, s.shortage),
      remarks = case when excluded.remarks <> '' then excluded.remarks else s.remarks end,
      updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_sales_new, v_sales_upd from up;

  -- 4) Payments copied from Master Paid are replaced as a whole.
  delete from ledger_payments where source = 'master_ledger';
  insert into ledger_payments (pay_date, customer, customer_key, amount, mode, source, seq,
                               tds, shortage, remarks, import_id)
  select x.pay_date, btrim(x.customer), ledger_norm(x.customer), x.amount, btrim(coalesce(x.mode, '')),
         'master_ledger', coalesce(x.seq, 0), x.tds, x.shortage, coalesce(x.remarks, ''), v_import
  from jsonb_to_recordset(coalesce(p_payload -> 'payments', '[]'::jsonb))
       as x(pay_date date, customer text, amount numeric, mode text, seq bigint,
            tds numeric, shortage numeric, remarks text)
  where x.pay_date is not null and x.amount is not null and btrim(coalesce(x.customer, '')) <> '';
  get diagnostics v_pay = row_count;

  -- 5) PO lists: only POs the app doesn't have yet are added, at the end
  --    of their list and in the workbook's order.
  with src as (
    select distinct on (x.group_code, upper(btrim(coalesce(x.unit, ''))), upper(btrim(x.po_no)))
           x.group_code, upper(btrim(coalesce(x.unit, ''))) as unit, btrim(x.po_no) as po_no,
           coalesce(x.allotted, 0) as allotted, coalesce(x.seq, 0) as seq
    from jsonb_to_recordset(coalesce(p_payload -> 'pos', '[]'::jsonb))
         as x(group_code text, unit text, po_no text, allotted numeric, seq int)
    where btrim(coalesce(x.po_no, '')) <> ''
      and exists (select 1 from ledger_bulk_groups g where g.code = x.group_code)
    order by x.group_code, upper(btrim(coalesce(x.unit, ''))), upper(btrim(x.po_no)), x.seq
  ), fresh as (
    select s.*, row_number() over (partition by s.group_code, s.unit order by s.seq) as rn
    from src s
    where not exists (select 1 from ledger_po p
                      where p.group_code = s.group_code and p.unit = s.unit
                        and upper(p.po_no) = upper(s.po_no))
  )
  insert into ledger_po (group_code, unit, po_no, allotted, seq, source)
  select f.group_code, f.unit, f.po_no, f.allotted,
         coalesce((select max(p.seq) from ledger_po p
                   where p.group_code = f.group_code and p.unit = f.unit), 0) + f.rn,
         'master_ledger'
  from fresh f;
  get diagnostics v_po_new = row_count;

  -- 6) Month-opening balances
  insert into ledger_opening as o (customer_key, month, customer, amount, source, updated_at)
  select distinct on (ledger_norm(x.customer), x.month)
         ledger_norm(x.customer), x.month, btrim(x.customer), x.amount, 'master_ledger', now()
  from jsonb_to_recordset(coalesce(p_payload -> 'opening', '[]'::jsonb))
       as x(customer text, month date, amount numeric)
  where x.month is not null and x.amount is not null and ledger_norm(x.customer) <> ''
  order by ledger_norm(x.customer), x.month
  on conflict (customer_key, month) do update set
    amount = excluded.amount, customer = excluded.customer, source = 'master_ledger', updated_at = now();
  get diagnostics v_open = row_count;

  -- 7) Tanker Master follows Excel (only when the upload has it)
  if jsonb_array_length(coalesce(p_payload -> 'tanker', '[]'::jsonb)) > 0 then
    delete from ledger_tanker_customers where true;
    insert into ledger_tanker_customers (company, hsd_rate, address, payment, po_label, po_no, price_tier, seq)
    select distinct on (btrim(x.company)) btrim(x.company), x.hsd_rate, coalesce(x.address, '{}'),
           coalesce(x.payment, '{}'), coalesce(x.po_label, ''), coalesce(x.po_no, ''),
           coalesce(x.price_tier, ''), t.n::int
    from jsonb_array_elements(p_payload -> 'tanker') with ordinality as t(v, n),
         jsonb_to_record(t.v) as x(company text, hsd_rate numeric, address text[], payment text[],
                                   po_label text, po_no text, price_tier text)
    where btrim(coalesce(x.company, '')) <> ''
    order by btrim(x.company), t.n;
    get diagnostics v_tanker = row_count;
  end if;

  -- 8) Settings read from the workbook (e.g. the fuel-slip heading)
  insert into ledger_settings as st (key, value, updated_at)
  select e.key, e.value, now() from jsonb_each(coalesce(p_payload -> 'settings', '{}'::jsonb)) e
  on conflict (key) do update set value = excluded.value, updated_at = now();

  v_counts := jsonb_build_object(
    'groups', v_groups, 'customers_new', v_cust_new, 'sales_new', v_sales_new,
    'sales_updated', v_sales_upd, 'payments', v_pay, 'pos_new', v_po_new, 'opening', v_open,
    'tanker', v_tanker);
  update ledger_imports set counts = v_counts where id = v_import;
  return v_counts || jsonb_build_object('import_id', v_import);
end $$;

create or replace function public.ledger_customers_list()
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'key', c.customer_key, 'ledger', c.ledger,
             'no_ledger', c.no_ledger, 'bulk_group', c.bulk_group, 'gstin', c.gstin,
             'archived', c.archived, 'created_at', c.created_at,
             'first_sale', st.first_sale, 'last_sale', st.last_sale, 'bills', coalesce(st.bills, 0))
           order by c.name)
    from ledger_customers c
    left join (select customer_key, min(sale_date) as first_sale, max(sale_date) as last_sale,
                      count(*) as bills
               from ledger_sales group by customer_key) st on st.customer_key = c.customer_key
  ), '[]'::jsonb);
end $$;

-- patch keys: ledger, no_ledger, archived, gstin
create or replace function public.ledger_customer_update(p_id bigint, p_patch jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  r        ledger_customers;
  v_ledger text;
  v_other  text;
begin
  perform ledger_assert_member();
  if p_patch ? 'ledger' then
    v_ledger := nullif(btrim(coalesce(p_patch ->> 'ledger', '')), '');
    if v_ledger is not null then
      select name into v_other from ledger_customers
      where lower(ledger) = lower(v_ledger) and id <> p_id limit 1;
      if v_other is not null then
        raise exception 'The ledger name "%" is already used by %.', v_ledger, v_other;
      end if;
    end if;
  end if;
  update ledger_customers c set
    ledger    = case when p_patch ? 'ledger' then v_ledger else c.ledger end,
    no_ledger = case when p_patch ? 'no_ledger' then coalesce((p_patch ->> 'no_ledger')::boolean, false)
                     else c.no_ledger end,
    archived  = case when p_patch ? 'archived' then coalesce((p_patch ->> 'archived')::boolean, false)
                     else c.archived end,
    gstin     = case when p_patch ? 'gstin' then btrim(coalesce(p_patch ->> 'gstin', '')) else c.gstin end,
    updated_at = now()
  where c.id = p_id
  returning * into r;
  if r.id is null then raise exception 'Customer not found.'; end if;
  return to_jsonb(r);
end $$;

-- Everything the PO screens need; PO allocation itself runs in the
-- browser (ledger/js/po.js) with the same rule as the *_Bulk sheets.
create or replace function public.ledger_po_data(p_code text default null)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  return jsonb_build_object(
    'groups', coalesce((select jsonb_agg(to_jsonb(g) order by g.code) from ledger_bulk_groups g
                        where p_code is null or g.code = p_code), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
                                  'id', c.id, 'name', c.name, 'key', c.customer_key,
                                  'group', c.bulk_group, 'archived', c.archived) order by c.name)
                         from ledger_customers c
                         where c.bulk_group is not null and (p_code is null or c.bulk_group = p_code)),
                        '[]'::jsonb),
    'pos', coalesce((select jsonb_agg(to_jsonb(p) order by p.group_code, p.unit, p.seq, p.id)
                     from ledger_po p where p_code is null or p.group_code = p_code), '[]'::jsonb),
    'bills', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', s.id, 'group', c.bulk_group, 'product', s.product,
                                'date', s.sale_date,
                                'bill_no', s.bill_no, 'vehicle', s.vehicle, 'qty', s.qty,
                                'amount', s.amount, 'customer', s.customer, 'unit', s.unit,
                                'po_mode', s.po_mode, 'po_fixed', s.po_fixed,
                                'po_user_set', s.po_user_set, 'seq', s.seq)
                              order by c.bulk_group, s.sale_date,
                                       array_position(array['HSD', 'MS', 'XG'], s.product), s.seq, s.id)
                       from ledger_sales s
                       join ledger_customers c on c.customer_key = s.customer_key
                       join ledger_bulk_groups g on g.code = c.bulk_group
                       where s.product in ('HSD', 'MS', 'XG') and g.kind in ('po', 'po_units')
                         and (g.period_from is null or s.sale_date >= g.period_from)
                         and (p_code is null or g.code = p_code)), '[]'::jsonb)
  );
end $$;

-- Add or edit a PO: {id?, group_code, unit, po_no, allotted, note}
create or replace function public.ledger_po_save(p_po jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  r       ledger_po;
  v_id    bigint := nullif(p_po ->> 'id', '')::bigint;
  v_group text := btrim(coalesce(p_po ->> 'group_code', ''));
  v_unit  text := upper(btrim(coalesce(p_po ->> 'unit', '')));
  v_no    text := btrim(coalesce(p_po ->> 'po_no', ''));
  v_allot numeric := coalesce(nullif(p_po ->> 'allotted', '')::numeric, 0);
begin
  perform ledger_assert_member();
  if v_no = '' then raise exception 'Enter the PO number.'; end if;
  if v_allot < 0 then raise exception 'Allotted litres can''t be negative.'; end if;
  if v_id is null then
    if not exists (select 1 from ledger_bulk_groups where code = v_group) then
      raise exception 'Unknown bulk ledger "%".', v_group;
    end if;
    insert into ledger_po (group_code, unit, po_no, allotted, seq, note, source)
    values (v_group, v_unit, v_no, v_allot,
            coalesce((select max(seq) from ledger_po where group_code = v_group and unit = v_unit), 0) + 1,
            coalesce(p_po ->> 'note', ''), 'app')
    returning * into r;
  else
    update ledger_po set po_no = v_no, allotted = v_allot, note = coalesce(p_po ->> 'note', note)
    where id = v_id
    returning * into r;
    if r.id is null then raise exception 'PO not found.'; end if;
  end if;
  return to_jsonb(r);
exception when unique_violation then
  raise exception 'PO % is already in this list.', v_no;
end $$;

create or replace function public.ledger_po_delete(p_id bigint)
returns void language plpgsql set search_path = public as $$
begin
  perform ledger_assert_member();
  delete from ledger_po where id = p_id;
  if not found then raise exception 'PO not found.'; end if;
end $$;

-- Move a PO up (p_dir < 0) or down (p_dir > 0) its list.
create or replace function public.ledger_po_move(p_id bigint, p_dir int)
returns void language plpgsql set search_path = public as $$
declare
  a     ledger_po;
  a_pos int;
  b_id  bigint;
begin
  perform ledger_assert_member();
  select * into a from ledger_po where id = p_id;
  if a.id is null then raise exception 'PO not found.'; end if;
  with ordered as (
    select id, row_number() over (order by seq, id) as rn
    from ledger_po where group_code = a.group_code and unit = a.unit
  )
  update ledger_po p set seq = o.rn from ordered o where p.id = o.id and p.seq <> o.rn;
  select seq into a_pos from ledger_po where id = p_id;
  select id into b_id from ledger_po
  where group_code = a.group_code and unit = a.unit
    and seq = a_pos + case when p_dir < 0 then -1 else 1 end;
  if b_id is null then return; end if;
  update ledger_po set seq = a_pos + case when p_dir < 0 then -1 else 1 end where id = p_id;
  update ledger_po set seq = a_pos where id = b_id;
end $$;

-- patch keys: unit, po_mode ('auto' | 'fixed'), po_fixed, remarks
create or replace function public.ledger_bill_update(p_id bigint, p_patch jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare r ledger_sales;
begin
  perform ledger_assert_member();
  if p_patch ? 'po_mode' and coalesce(p_patch ->> 'po_mode', '') not in ('auto', 'fixed') then
    raise exception 'The PO choice must be auto or fixed.';
  end if;
  update ledger_sales s set
    unit        = case when p_patch ? 'unit' then upper(btrim(coalesce(p_patch ->> 'unit', ''))) else s.unit end,
    po_mode     = case when p_patch ? 'po_mode' then p_patch ->> 'po_mode' else s.po_mode end,
    po_fixed    = case when p_patch ? 'po_fixed' then btrim(coalesce(p_patch ->> 'po_fixed', ''))
                       when p_patch ->> 'po_mode' = 'auto' then '' else s.po_fixed end,
    po_user_set = case when p_patch ? 'po_mode' or p_patch ? 'po_fixed' then true else s.po_user_set end,
    remarks     = case when p_patch ? 'remarks' then coalesce(p_patch ->> 'remarks', '') else s.remarks end
  where s.id = p_id
  returning * into r;
  if r.id is null then raise exception 'Bill not found.'; end if;
  return jsonb_build_object('id', r.id, 'unit', r.unit, 'po_mode', r.po_mode, 'po_fixed', r.po_fixed,
                            'po_user_set', r.po_user_set, 'remarks', r.remarks);
end $$;

-- The bills of one day (the latest day when p_date is null).
create or replace function public.ledger_sales_day(p_date date default null)
returns jsonb language plpgsql stable set search_path = public as $$
declare d date;
begin
  perform ledger_assert_member();
  d := coalesce(p_date, (select max(sale_date) from ledger_sales));
  return jsonb_build_object(
    'date', d,
    'dates', coalesce((select jsonb_agg(t.sale_date order by t.sale_date desc)
                       from (select distinct sale_date from ledger_sales order by 1 desc limit 120) t),
                      '[]'::jsonb),
    'bills', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', s.id, 'product', s.product, 'bill_no', s.bill_no,
                                'vehicle', s.vehicle, 'qty', s.qty, 'rate', s.rate,
                                'amount', s.amount, 'customer', s.customer, 'item', s.item,
                                'source', s.source)
                              order by s.product, s.seq, s.id)
                       from ledger_sales s where s.sale_date = d), '[]'::jsonb));
end $$;

-- Bills of a date range (Daily Tanker Bill, Print Bills). At most 400 days.
create or replace function public.ledger_sales_range(p_from date, p_to date)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Pick a From date on or before the To date.';
  end if;
  if p_to - p_from > 400 then raise exception 'Pick at most 400 days at a time.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
                     'id', s.id, 'product', s.product, 'bill_no', s.bill_no, 'sale_date', s.sale_date,
                     'vehicle', s.vehicle, 'qty', s.qty, 'rate', s.rate, 'amount', s.amount,
                     'customer', s.customer, 'item', s.item, 'seq', s.seq, 'unit', s.unit)
                   order by s.product, s.seq, s.id)
                   from ledger_sales s where s.sale_date between p_from and p_to), '[]'::jsonb);
end $$;

create or replace function public.ledger_tanker_list()
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.seq, t.company)
                   from ledger_tanker_customers t), '[]'::jsonb);
end $$;

create or replace function public.ledger_setting_get(p_key text)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  return (select value from ledger_settings where key = p_key);
end $$;

create or replace function public.ledger_imports_list(p_limit int default 20)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform ledger_assert_member();
  return coalesce((select jsonb_agg(to_jsonb(i) order by i.id desc)
                   from (select * from ledger_imports order by id desc
                         limit greatest(1, least(coalesce(p_limit, 20), 200))) i), '[]'::jsonb);
end $$;


-- ---------------------------------------------------------------------
-- Function permissions: nothing for anon; the app's functions for
-- logged-in users (who still have to be members); the member list is
-- managed from the SQL Editor only.
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'ledger\_%'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname in ('ledger_add_member', 'ledger_remove_member') then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
