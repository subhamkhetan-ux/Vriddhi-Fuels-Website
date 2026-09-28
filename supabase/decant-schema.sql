-- =====================================================================
-- Vriddhi Fuels — Tanker Decanting app (/decant/) cloud store
-- ---------------------------------------------------------------------
-- Run in the decanting app's OWN Supabase project (SQL Editor → paste → Run)
-- — NOT the payments project, which this app must never load. Its URL and
-- publishable key go in decant/config.js. Safe to re-run.
-- (Ran it in the payments project before? decant-remove-from-payments.sql
-- takes the dec_* tables out of there again.)
--
--   dec_invoices    every IOCL invoice with its chamber table. The payment
--                   agent (GitHub Actions, agent/decant.py) inserts these from
--                   the invoice mail; the app can also add one by hand or from
--                   an uploaded PDF. Insert-if-absent, so app edits stick.
--   dec_sessions    one decantation: a tank truck emptying chambers into one or
--                   more tanks, with the stock before / after and the variation.
--                   The app keeps the details in `data` (jsonb) so it can grow
--                   without schema changes.
--   dec_tank_state  the latest known reading per tank (the stock strip).
--   dec_vehicles    trucks' chamber layouts — no longer used by the app (our
--                   own TTs are in Settings; transport TTs have standard
--                   layouts). Left in place; nothing reads or writes it.
--   dec_config      shared settings (tanks, tolerance, dip chart, our own TTs,
--                   the transport TT layouts) and the indents placed (for the
--                   Plan tab).
--   dec_history     (a view) finished decantations, compact — what the FY
--                   reports read for the months the phone doesn't keep.
--
-- Retention: decantations and invoices are kept for this financial year and
-- the last (for the FY reports); dec_purge_old() does it and the app calls it
-- on load. Screenshots are only read on the phone — never stored (the
-- dec_photos table of the first version is dropped). Personal-owner model:
-- the publishable (anon) key may read/write these tables (RLS policy below);
-- the payments agent writes the invoices with it too.
-- =====================================================================

create table if not exists public.dec_invoices (
  invoice_no   text primary key,          -- SAP entry number ('M-…' for a hand-entered one)
  invoice_date text,                       -- dd/mm/yyyy
  invoice_time text,                       -- HH:MM
  tt_no        text,
  lines        jsonb default '[]'::jsonb,  -- [{product, column_key, qty_kl, compartments, density15, terminal_tank, value}]
  chambers     jsonb default '[]'::jsonb,  -- [{no, pl_cm, dip_cm, qty_kl}]
  density15    numeric,
  seals        text,
  origin       text,
  amount       numeric,
  gmail_msg_id text,
  source       text default 'agent',       -- 'agent' | 'manual' | 'pdf'
  dismissed    boolean default false,      -- hidden from "to decant" (not ours / already done)
  dismiss_reason text,                     -- 'outside' (decanted outside the app) | 'not_ours' | 'deleted'
  note         text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
-- added after the first version (safe to re-run)
alter table public.dec_invoices add column if not exists dismiss_reason text;
create index if not exists dec_invoices_created_idx on public.dec_invoices (created_at desc);
create index if not exists dec_invoices_tt_idx on public.dec_invoices (tt_no);

create table if not exists public.dec_sessions (
  id           text primary key,           -- client-generated
  invoice_no   text,
  tt_no        text,
  status       text default 'draft',       -- draft | decanting | settling | done | cancelled
  data         jsonb default '{}'::jsonb,  -- plan, per-tank readings and results, checks, photo ids
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  completed_at timestamptz
);
create index if not exists dec_sessions_created_idx on public.dec_sessions (created_at desc);
create index if not exists dec_sessions_invoice_idx on public.dec_sessions (invoice_no);

-- screenshots aren't kept (the first version stored them here)
drop table if exists public.dec_photos;

create table if not exists public.dec_tank_state (
  tank_id    text primary key,             -- 'T1' … 'T4'
  reading    jsonb,                        -- {volume, ullage, height_mm, water, density, density_tc, temp, reading_at, source}
  updated_at timestamptz default now()
);

create table if not exists public.dec_vehicles (
  tt_no      text primary key,
  chambers   jsonb default '[]'::jsonb,    -- [{no, qty_kl, dip_cm, pl_cm}]
  note       text,
  updated_at timestamptz default now()
);

create table if not exists public.dec_config (
  id         smallint primary key default 1,
  data       jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  constraint dec_config_single check (id = 1)
);
insert into public.dec_config (id) values (1) on conflict (id) do nothing;

-- ---- keep two financial years ----
-- Decantations and invoices are kept for this financial year and the last,
-- so the reports can show "this FY"; a decantation still open stays.
create or replace function public.dec_purge_old()
returns void language plpgsql security definer as $$
declare
  today     date := (now() at time zone 'Asia/Kolkata')::date;
  fy_start  date;
  keep_from timestamptz;
begin
  fy_start := make_date(case when extract(month from today) >= 4
                             then extract(year from today)::int
                             else extract(year from today)::int - 1 end, 4, 1);
  keep_from := (fy_start - interval '1 year')::timestamp at time zone 'Asia/Kolkata';

  delete from public.dec_sessions
   where status in ('done', 'cancelled')
     and coalesce(completed_at, updated_at, created_at) < keep_from;
  delete from public.dec_invoices i
   where i.created_at < keep_from
     and not exists (select 1 from public.dec_sessions s
                      where s.invoice_no = i.invoice_no
                        and s.status not in ('done', 'cancelled'));
end $$;

-- ---- dec_history: finished decantations, compact, for the FY reports ----
-- The phone keeps this month and last; for "This FY" / "All" the app reads the
-- older months from this view — only what the reports need (no screenshots,
-- no OCR details), so a whole year is a small download. Each stock keeps where
-- it came from (screenshot / dip / typed litres, and a corrected screenshot's
-- own figure) for the internal audit.
create or replace view public.dec_history with (security_invoker = true) as
select s.id, s.invoice_no, s.tt_no, s.status, s.created_at, s.updated_at, s.completed_at,
       jsonb_build_object(
         'compact',    true,
         'decantedAt', s.data->'decantedAt',
         'startedAt',  s.data->'startedAt',
         'plan',       coalesce(s.data->'plan', '[]'::jsonb),
         'tanks', coalesce((
           select jsonb_agg(jsonb_build_object(
                    'tank', t->'tank', 'tankNo', t->'tankNo', 'product', t->'product',
                    'chambers', t->'chambers', 'litres', t->'litres', 'salesL', t->'salesL',
                    'pricePerL', t->'pricePerL',
                    'before', jsonb_strip_nulls(jsonb_build_object('volume', t->'before'->'volume', 'source', t->'before'->'source',
                                'dip', t->'before'->'dip', 'screenVolume', t->'before'->'screenVolume')),
                    'after',  jsonb_strip_nulls(jsonb_build_object('volume', t->'after'->'volume', 'source', t->'after'->'source',
                                'dip', t->'after'->'dip', 'screenVolume', t->'after'->'screenVolume'))))
             from jsonb_array_elements(
                    case when jsonb_typeof(s.data->'tanks') = 'array' then s.data->'tanks' else '[]'::jsonb end) t),
           '[]'::jsonb)) as data
  from public.dec_sessions s
 where s.status = 'done';
grant select on public.dec_history to anon, authenticated;

-- ---- RLS: personal owner tool, the anon key may read/write these tables ----
do $$
declare t text;
begin
  foreach t in array array[
    'dec_invoices','dec_sessions','dec_tank_state','dec_vehicles','dec_config'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where policyname = t || '_all') then
      execute format(
        'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
        t || '_all', t);
    end if;
  end loop;
end $$;

-- ---- realtime ----
do $$
declare t text;
begin
  foreach t in array array[
    'dec_invoices','dec_sessions','dec_tank_state','dec_vehicles','dec_config'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- Optional: purge nightly regardless of app use (needs pg_cron enabled).
-- select cron.schedule('dec_purge_old', '30 2 * * *', $$ select public.dec_purge_old(); $$);
