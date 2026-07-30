-- =====================================================================
-- VRIDDHI FUELS — Tanker Loading app schema
-- Run this in the SQL Editor of a DEDICATED Supabase project (separate
-- from the indent-app and tally-app projects). Safe to re-run.
--
-- Design:
--  * Every signed-in employee shares ONE live dataset of loading events —
--    a save on one phone appears on every other phone instantly (Supabase
--    realtime).
--  * Data is kept for the LAST 7 DAYS ONLY. This is enforced three ways so
--    it holds no matter what:
--      1. The read policy only exposes rows from the last 7 days, so older
--         rows are invisible even before they are deleted.
--      2. Every insert opportunistically deletes rows older than 7 days,
--         and the app calls loading_purge() on open.
--      3. If pg_cron is available it also purges on a schedule.
--  * Clients get read-only table access; every write goes through a
--    SECURITY DEFINER function that checks sign-in.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------
create table if not exists public.loading_events (
  id         uuid primary key default gen_random_uuid(),
  vehicle    text not null,
  -- 'load' = diesel added to chambers; 'dispatch' = tanker sent for sale (emptied).
  -- A tanker's current fill = sum of 'load' events since its latest 'dispatch'.
  kind       text not null default 'load' check (kind in ('load','dispatch')),
  -- chambers: [{"name":"C1","qty":3985}, ...]
  chambers   jsonb not null,
  total      numeric(12,2) not null check (total > 0),
  by_name    text not null default '',  -- who did it (for accountability)
  remark     text not null default '',  -- free text; on a dispatch this is "sold to"
  created_by uuid,
  created_at timestamptz not null default now()  -- server time; never the client clock
);
-- add columns if an earlier version of this table already exists
alter table public.loading_events add column if not exists kind   text not null default 'load';
alter table public.loading_events add column if not exists remark text not null default '';

create index if not exists loading_events_created_idx on public.loading_events(created_at desc);

-- ---------------------------------------------------------------------
-- Tankers (shared, editable from the app's Manage screen)
-- ---------------------------------------------------------------------
create table if not exists public.loading_vehicles (
  plate      text primary key,
  caps       jsonb not null,      -- [3985,3985,3985]
  color      text not null default '',
  created_at timestamptz not null default now()
);
-- seed the known tankers (safe to re-run; only inserts missing ones)
insert into public.loading_vehicles (plate, caps, color) values
  ('OD23A3710', '[3985,3985,3985]',      '#1f6f8b'),
  ('OR15R1110', '[3985,3985,3985]',      '#2d7d46'),
  ('OR15R5510', '[3985,3985,3985]',      '#8a5a1e'),
  ('OR15R9360', '[4485,4485,4485,4485]', '#6a3d8c')
on conflict (plate) do nothing;

-- ---------------------------------------------------------------------
-- Business-day closes ("End Day"). The financial day ends at the morning
-- shift change (variable time), not midnight. Pressing "End Day" the next
-- morning books all still-open records under the PREVIOUS calendar date.
-- close_date is the primary key, so a given day can be ended only once
-- (guards against multiple presses in a day). Dates are computed in IST.
-- ---------------------------------------------------------------------
create table if not exists public.loading_day_closes (
  close_date date primary key,
  closed_at  timestamptz not null default now(),
  closed_by  uuid
);

-- ---------------------------------------------------------------------
-- Row Level Security: signed-in users can READ the last 7 days only; no
-- direct writes (all mutations go through the RPCs below).
-- (authenticated/anon already exist on Supabase; created here only when the
-- schema is loaded into a plain Postgres, e.g. for testing.)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

alter table public.loading_events enable row level security;
alter table public.loading_vehicles enable row level security;
alter table public.loading_day_closes enable row level security;

drop policy if exists loading_events_read on public.loading_events;
create policy loading_events_read on public.loading_events
  for select to authenticated
  using (created_at >= now() - interval '7 days');

drop policy if exists loading_vehicles_read on public.loading_vehicles;
create policy loading_vehicles_read on public.loading_vehicles
  for select to authenticated using (true);

drop policy if exists loading_day_closes_read on public.loading_day_closes;
create policy loading_day_closes_read on public.loading_day_closes
  for select to authenticated
  using (close_date >= ((now() at time zone 'Asia/Kolkata')::date) - 30);

-- ---------------------------------------------------------------------
-- Helper
-- ---------------------------------------------------------------------
create or replace function public._loading_auth() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- RPCs (the client's only write path)
-- ---------------------------------------------------------------------

-- Record one event (a 'load' or a 'dispatch'). Also drops anything older than
-- 7 days so the table never grows past a week.
-- Drop earlier versions (4-arg pre-'kind', 5-arg pre-'remark') so there is no overload.
drop function if exists public.loading_add(text, jsonb, numeric, text);
drop function if exists public.loading_add(text, jsonb, numeric, text, text);
create or replace function public.loading_add(
  p_vehicle text, p_chambers jsonb, p_total numeric, p_by text, p_kind text, p_remark text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  perform _loading_auth();
  if coalesce(p_vehicle,'') = '' then raise exception 'Vehicle required'; end if;
  if p_chambers is null or jsonb_array_length(p_chambers) = 0 then
    raise exception 'At least one chamber is required';
  end if;
  if p_total is null or p_total <= 0 then raise exception 'Total must be positive'; end if;
  if coalesce(p_kind,'load') not in ('load','dispatch') then raise exception 'Bad kind'; end if;

  insert into loading_events (vehicle, kind, chambers, total, by_name, remark, created_by)
  values (p_vehicle, coalesce(p_kind,'load'), p_chambers, p_total, coalesce(p_by,''),
          coalesce(p_remark,''), auth.uid())
  returning id into rid;

  delete from loading_events where created_at < now() - interval '7 days';
  return rid;
end $$;

-- Delete a (recent) event. Any signed-in employee may correct a mistake.
create or replace function public.loading_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_auth();
  delete from loading_events
    where id = p_id and created_at >= now() - interval '7 days';
  if not found then
    raise exception 'Record not found or older than 7 days';
  end if;
end $$;

-- Explicit purge (the app calls this on open). Returns rows removed.
create or replace function public.loading_purge() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _loading_auth();
  delete from loading_events where created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;

-- Danger zone: clear ALL loading & sale records (empties every tanker).
-- Tankers themselves are kept. WHERE is required by Supabase's pg_safeupdate.
create or replace function public.loading_clear_all() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _loading_auth();
  delete from loading_events where id is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Add / remove a shared tanker (Manage screen).
create or replace function public.loading_vehicle_add(p_plate text, p_caps jsonb, p_color text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_auth();
  if coalesce(trim(p_plate),'') = '' then raise exception 'Vehicle number required'; end if;
  if p_caps is null or jsonb_array_length(p_caps) = 0 then raise exception 'At least one chamber is required'; end if;
  insert into loading_vehicles (plate, caps, color)
  values (upper(trim(p_plate)), p_caps, coalesce(p_color,''))
  on conflict (plate) do update set caps = excluded.caps, color = excluded.color;
end $$;

create or replace function public.loading_vehicle_remove(p_plate text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_auth();
  delete from loading_vehicles where plate = p_plate;
end $$;

-- End Day: book the just-finished business day under the PREVIOUS calendar date
-- (IST). Allowed once per day — the close_date primary key makes a second press
-- the same day fail. Returns the date the day was booked under.
create or replace function public.loading_end_day() returns text
language plpgsql security definer set search_path = public as $$
declare cd date;
begin
  perform _loading_auth();
  cd := ((now() at time zone 'Asia/Kolkata')::date) - 1;   -- yesterday, in IST
  if exists (select 1 from loading_day_closes where close_date = cd) then
    raise exception 'This day has already been ended';
  end if;
  insert into loading_day_closes (close_date, closed_by) values (cd, auth.uid());
  delete from loading_day_closes where close_date < ((now() at time zone 'Asia/Kolkata')::date) - 30;
  return to_char(cd, 'YYYY-MM-DD');
end $$;

-- ---------------------------------------------------------------------
-- Grants: RPCs for signed-in users only (Supabase-specific; skipped
-- gracefully on a plain Postgres used for testing).
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on all functions in schema public from public, anon;
    grant execute on function
      public.loading_add(text, jsonb, numeric, text, text, text),
      public.loading_delete(uuid),
      public.loading_purge(),
      public.loading_clear_all(),
      public.loading_vehicle_add(text, jsonb, text),
      public.loading_vehicle_remove(text),
      public.loading_end_day()
    to authenticated;
  end if;
end $$;

-- Realtime: broadcast changes so every device updates at once (safe to re-run).
do $$
begin
  begin
    alter publication supabase_realtime add table public.loading_events;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.loading_vehicles;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.loading_day_closes;
  exception when others then null;
  end;
end $$;

-- Optional belt-and-suspenders: if pg_cron is installed, purge hourly too.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'loading_purge_hourly', '0 * * * *',
      $q$ delete from public.loading_events where created_at < now() - interval '7 days' $q$
    );
  end if;
exception when others then null;
end $$;
