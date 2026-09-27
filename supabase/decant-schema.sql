-- =====================================================================
-- Vriddhi Fuels — Tanker Decanting app (/decant/) cloud store
-- ---------------------------------------------------------------------
-- Run once in the SAME Supabase project as the /payments app (SQL Editor →
-- paste → Run). Safe to re-run.
--
--   dec_invoices    every IOCL invoice with its chamber table. The payment
--                   agent (GitHub Actions, agent/decant.py) inserts these from
--                   the invoice mail; the app can also add one by hand or from
--                   an uploaded PDF. Insert-if-absent, so app edits stick.
--   dec_sessions    one decantation: a tank truck emptying chambers into one or
--                   more tanks, with the stock before / after and the variation.
--                   The app keeps the details in `data` (jsonb) so it can grow
--                   without schema changes.
--   dec_photos      the automation screenshots (before / after / stock), as
--                   compressed JPEG data URLs. Fetched on demand, not realtime.
--   dec_tank_state  the latest known reading per tank (the stock strip).
--   dec_vehicles    each truck's chamber layout, learned from its invoices.
--   dec_config      shared settings (tanks, tolerance, retention, dip chart)
--                   and the loads you've ordered next (for the Plan tab).
--   dec_history     (a view) finished decantations, compact — what the FY
--                   reports read for the months the phone doesn't keep.
--
-- Retention: decantations and invoices are kept for this financial year and
-- the last (for the FY reports); screenshots for the app's "Keep the
-- screenshots for" setting (31 days by default). dec_purge_old() does it; the
-- app calls it on load. Same personal-owner model as the payments tables: the
-- anon key may read/write these tables (RLS policy below).
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

create table if not exists public.dec_photos (
  id          text primary key,
  session_id  text,                        -- null for a standalone stock update
  kind        text,                        -- 'before' | 'after' | 'stock'
  data_url    text,                        -- data:image/jpeg;base64,…
  meta        jsonb default '{}'::jsonb,   -- what was read from it
  created_at  timestamptz default now()
);
create index if not exists dec_photos_session_idx on public.dec_photos (session_id);
create index if not exists dec_photos_created_idx on public.dec_photos (created_at);

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

-- ---- keep the numbers for two financial years, the screenshots for a month ----
-- Decantations and invoices (small rows) are kept for this financial year and
-- the last, so the reports can show "this FY". The screenshots — the heavy
-- part — go after the app's "Keep the screenshots for" setting (31 days by
-- default), except those of a decantation that is still open.
create or replace function public.dec_purge_old()
returns void language plpgsql security definer as $$
declare
  keep_days    integer;
  photo_cutoff timestamptz;
  today        date := (now() at time zone 'Asia/Kolkata')::date;
  fy_start     date;
  keep_from    timestamptz;
begin
  -- the app keeps its settings under data.settings
  select case when data->'settings'->>'retentionDays' ~ '^\d+$'
              then (data->'settings'->>'retentionDays')::integer end
    into keep_days
    from public.dec_config where id = 1;
  if keep_days is null or keep_days < 7 then keep_days := 31; end if;
  photo_cutoff := now() - make_interval(days => keep_days);
  fy_start := make_date(case when extract(month from today) >= 4
                             then extract(year from today)::int
                             else extract(year from today)::int - 1 end, 4, 1);
  keep_from := (fy_start - interval '1 year')::timestamp at time zone 'Asia/Kolkata';

  delete from public.dec_sessions
   where status in ('done', 'cancelled')
     and coalesce(completed_at, updated_at, created_at) < keep_from;
  delete from public.dec_photos p
   where p.created_at < photo_cutoff
     and not exists (select 1 from public.dec_sessions s
                      where s.id = p.session_id
                        and s.status not in ('done', 'cancelled'));
  delete from public.dec_invoices i
   where i.created_at < keep_from
     and not exists (select 1 from public.dec_sessions s
                      where s.invoice_no = i.invoice_no
                        and s.status not in ('done', 'cancelled'));
end $$;

-- ---- dec_history: finished decantations, compact, for the FY reports ----
-- The phone keeps this month and last; for "This FY" / "All" the app reads the
-- older months from this view — only what the reports need (no screenshots,
-- no OCR details), so a whole year is a small download.
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
                    'before', jsonb_build_object('volume', t->'before'->'volume'),
                    'after',  jsonb_build_object('volume', t->'after'->'volume')))
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
    'dec_invoices','dec_sessions','dec_photos','dec_tank_state','dec_vehicles','dec_config'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where policyname = t || '_all') then
      execute format(
        'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
        t || '_all', t);
    end if;
  end loop;
end $$;

-- ---- realtime: every table but the (heavy) photos ----
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
