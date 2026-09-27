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
--   dec_config      shared settings (tanks, tolerance, retention, dip chart).
--
-- Log retention: finished decantations and photos older than the app's
-- "Keep the log for" setting (default 31 days — one month) are purged by
-- dec_purge_old(),
-- which the app calls on load. Same personal-owner model as the payments
-- tables: the anon key may read/write these tables (RLS policy below).
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
  note         text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
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

-- ---- one-month log: purge finished decantations, their photos, old invoices ----
create or replace function public.dec_purge_old()
returns void language plpgsql security definer as $$
declare
  keep_days integer;
  cutoff    timestamptz;
begin
  -- the app keeps its settings under data.settings (Settings → "Keep the log for")
  select case when data->'settings'->>'retentionDays' ~ '^\d+$'
              then (data->'settings'->>'retentionDays')::integer end
    into keep_days
    from public.dec_config where id = 1;
  if keep_days is null or keep_days < 7 then keep_days := 31; end if;
  cutoff := now() - make_interval(days => keep_days);

  delete from public.dec_sessions
   where status in ('done', 'cancelled')
     and coalesce(completed_at, updated_at, created_at) < cutoff;
  -- photos go with their decantation (or on age, for standalone stock photos)
  delete from public.dec_photos p
   where p.created_at < cutoff
     and (p.session_id is null
          or not exists (select 1 from public.dec_sessions s where s.id = p.session_id));
  -- invoices a little later than the log, unless a decantation is still open on one
  delete from public.dec_invoices i
   where i.created_at < cutoff - interval '14 days'
     and not exists (select 1 from public.dec_sessions s
                      where s.invoice_no = i.invoice_no
                        and s.status not in ('done', 'cancelled'));
end $$;

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
