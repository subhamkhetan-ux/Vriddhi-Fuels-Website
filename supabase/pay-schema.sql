-- =====================================================================
-- VRIDDHI FUELS — Payment Entry App schema  (app lives at /pay)
-- Run this once in the SQL Editor of your Supabase project. Safe to re-run.
--
-- Design:
--  * Two small tables shared across every device via Supabase realtime:
--      - pay_entries  : the exported-payment history (the "Old entries" list).
--                       Its whole point is to make duplicate exports IMPOSSIBLE
--                       across devices — entry_key is unique, so the same
--                       payment (date + customer + amount) can only exist once.
--      - pay_masters  : the customer list snapshot (from an uploaded Tally
--                       Master.xml), so uploading on one device updates all.
--  * The exported history AUTO-CLEARS after 7 days: pay_purge_old() deletes
--    rows older than 7 days, and clients also filter reads to the last 7 days.
--  * This is a personal/owner tool with no login, so the public anon key may
--    read/write these two tables (guarded by RLS below). If you later want it
--    locked to signed-in users, change `to anon, authenticated` to
--    `to authenticated` and add Supabase Auth in the app.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- Exported-payment history. entry_key = "<serial>|<normalised customer>|<amount>".
create table if not exists public.pay_entries (
  entry_key   text        primary key,
  serial      integer,
  date_str    text,
  customer    text        not null,
  amount      numeric     not null,
  mode        text        default '',
  exported_at timestamptz not null default now()
);
create index if not exists pay_entries_exported_at_idx on public.pay_entries (exported_at);

-- Customer list snapshot (single row) from the uploaded Tally Master.xml.
create table if not exists public.pay_masters (
  id         integer     primary key default 1 check (id = 1),
  names      jsonb       not null default '[]'::jsonb,
  count      integer     not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 7-day auto-clear
-- ---------------------------------------------------------------------
-- Clients call this on load; it also runs nightly if pg_cron is enabled (below).
create or replace function public.pay_purge_old() returns void
language sql security definer set search_path = public as $$
  delete from public.pay_entries where exported_at < now() - interval '7 days';
$$;
grant execute on function public.pay_purge_old() to anon, authenticated;

-- Optional: schedule a nightly purge (needs the pg_cron extension enabled).
-- create extension if not exists pg_cron;
-- select cron.schedule('pay_purge_old_daily', '0 3 * * *', $$ select public.pay_purge_old(); $$);

-- ---------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------
alter table public.pay_entries enable row level security;
alter table public.pay_masters enable row level security;

drop policy if exists pay_entries_all on public.pay_entries;
create policy pay_entries_all on public.pay_entries
  for all to anon, authenticated using (true) with check (true);

drop policy if exists pay_masters_all on public.pay_masters;
create policy pay_masters_all on public.pay_masters
  for all to anon, authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- Realtime — deliver INSERT/UPDATE/DELETE to every device
-- ---------------------------------------------------------------------
do $$
begin
  begin execute 'alter publication supabase_realtime add table public.pay_entries'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.pay_masters'; exception when duplicate_object then null; end;
end $$;
