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
  -- PERSISTENT current fill + all-time totals, so a loaded-but-unsold tanker
  -- never resets when its detailed load events age out of the 7-day window.
  fill         jsonb   not null default '{}'::jsonb,  -- {"C1":3985,"C2":1500,...}
  total_loaded numeric not null default 0,            -- all-time litres loaded
  total_sold   numeric not null default 0,            -- all-time litres sold
  created_at timestamptz not null default now()
);
-- add the columns if an earlier version of this table already exists
alter table public.loading_vehicles add column if not exists fill         jsonb   not null default '{}'::jsonb;
alter table public.loading_vehicles add column if not exists total_loaded numeric not null default 0;
alter table public.loading_vehicles add column if not exists total_sold   numeric not null default 0;
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
-- Web-push subscriptions — one row per phone (endpoint) per employee.
-- Used by the `loading-notify` edge function to alert everyone EXCEPT the
-- person who pressed the button. (No FK to auth.users — like closed_by above,
-- so this file still loads into a plain Postgres for testing.)
-- ---------------------------------------------------------------------
create table if not exists public.loading_push_subs (
  endpoint   text primary key,
  user_id    uuid not null,
  by_name    text not null default '',
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_loading_push_user on public.loading_push_subs(user_id);
-- Refreshed every time a phone re-registers (which is every app open), so a
-- row that stops being refreshed is a device that no longer exists.
alter table public.loading_push_subs
  add column if not exists seen_at timestamptz not null default now();

-- ---------------------------------------------------------------------
-- Customers / destinations (RTD master) — the only choices offered in the
-- "Sold to" box when a tanker is sent for sale. rtd_km = round-trip km per
-- trip. Customers that share a non-empty `grp` are one group company and
-- always carry the SAME RTD (changing one changes the whole group).
-- ---------------------------------------------------------------------
create table if not exists public.loading_destinations (
  name       text primary key,
  rtd_km     numeric not null default 0 check (rtd_km >= 0),
  grp        text not null default '',
  sort       int  not null default 0,
  created_at timestamptz not null default now()
);
-- seed from the RTD master sheet (safe to re-run; only inserts missing ones)
insert into public.loading_destinations (name, rtd_km, grp, sort) values
  ('Shyam Metalics',                   36,  '',                1),
  ('SMC Unit 1',                       16,  '',                2),
  ('SMC Unit 2',                       20,  '',                3),
  ('Orissa Metaliks',                  30,  '',                4),
  ('Lakhanpur Group Companies',        70,  'Lakhanpur Group', 5),
  ('DBL - Siarmal',                    140, '',                6),
  ('Aryan Ispat & Power Private Ltd.', 30,  '',                7)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- Trips — one row per "Sent for sale", kept PERMANENTLY (loading_events is
-- trimmed to 7 days, which is too short for a monthly trip report). The id is
-- the dispatch event's id, so deleting that event (while it is still within
-- the 7-day window) removes its trip too. `dest` is the customer it went to;
-- its RTD is looked up from loading_destinations when reporting.
-- ---------------------------------------------------------------------
create table if not exists public.loading_trips (
  id         uuid primary key,
  vehicle    text not null,
  total      numeric(12,2) not null default 0,
  dest       text not null default '',
  by_name    text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists loading_trips_created_idx on public.loading_trips(created_at desc);
-- back-fill trips from the sales still inside the 7-day window (safe to re-run)
insert into public.loading_trips (id, vehicle, total, dest, by_name, created_at)
  select id, vehicle, total, remark, by_name, created_at
    from public.loading_events where kind = 'dispatch'
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Tanker fuel log (mileage calculator) — kept permanently.
-- One row each time a tanker's own diesel tank is refilled (they are run to
-- almost dry first): the reading at that moment, the litres put in and — for
-- tankers with a dip stick — the stock found in the tank BEFORE refilling, in
-- Anguls (1 Angul = 16 L). `odometer` holds the km reading; for a tanker that
-- works off its fuel-dispenser meter (OD15AF5510) it holds that meter reading.
-- Diesel used between two refills = previous litres + previous stock − stock now.
-- ---------------------------------------------------------------------
create table if not exists public.loading_fuel_logs (
  id          uuid primary key default gen_random_uuid(),
  vehicle     text not null,
  reading_at  timestamptz not null default now(),
  odometer    numeric(14,2) not null check (odometer >= 0),
  litres      numeric(12,2) not null default 0 check (litres >= 0),
  anguls      numeric(8,2) check (anguls is null or anguls >= 0),  -- dip before refilling; null = not taken
  stock_l     numeric(10,2) check (stock_l is null or stock_l >= 0), -- litres in the tank before refilling (as entered)
  note        text not null default '',
  by_name     text not null default '',
  created_by  uuid,
  created_at  timestamptz not null default now()
);
alter table public.loading_fuel_logs add column if not exists anguls numeric(8,2);
-- stock is stored in litres as entered, so changing the Angul size later never
-- rewrites the diesel-used figures of past refills
alter table public.loading_fuel_logs add column if not exists stock_l numeric(10,2);

-- ---------------------------------------------------------------------
-- Shared app settings (key → JSON value), e.g. {"angul_l":16} — litres per
-- Angul on the dip stick — and {"alert_pct":15} — how far below a tanker's
-- normal mileage a refill must be to be flagged.
-- ---------------------------------------------------------------------
create table if not exists public.loading_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.loading_settings (key, value) values
  ('angul_l', '16'), ('alert_pct', '15'), ('reserve_l', '40')
on conflict (key) do nothing;
create index if not exists loading_fuel_logs_vehicle_idx on public.loading_fuel_logs(vehicle, reading_at);

-- ---------------------------------------------------------------------
-- Who may do what: ADMIN vs STAFF
--  * Staff (every login not listed below as admin) may only add loadings,
--    send tankers for sale, see the last 7 days of history, End Day in the
--    morning window and switch notifications on/off for their phone. They
--    cannot edit or delete anything, and cannot read trips, the fuel / mileage
--    log or the settings.
--  * Admins can do everything, change staff passwords (via the loading-admin
--    edge function) and log every staff phone out at once.
-- The email is the Supabase login, i.e. <username>@vriddhi.local.
-- ---------------------------------------------------------------------
create table if not exists public.loading_roles (
  email      text primary key,                      -- lower-case login email
  role       text not null check (role in ('admin','staff')),
  updated_at timestamptz not null default now()
);
-- Emails are stored lower-case whatever case they are typed in (Supabase
-- logins are case-insensitive), so 'SKhetan@…' and 'skhetan@…' are one login.
create or replace function public._loading_roles_norm() returns trigger
language plpgsql as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;
drop trigger if exists loading_roles_norm on public.loading_roles;
create trigger loading_roles_norm before insert or update on public.loading_roles
  for each row execute function public._loading_roles_norm();
-- tidy rows typed with capitals before this existed (keep the admin one if a
-- login appears twice in different case)
delete from public.loading_roles r using public.loading_roles o
 where r.email <> o.email and lower(r.email) = lower(o.email)
   and (r.role = 'staff' and o.role = 'admin' or r.role = o.role and r.email > o.email);
update public.loading_roles set email = lower(trim(email)) where email <> lower(trim(email));

-- >>> Make YOUR login the admin: uncomment, put your username, run once. <<<
-- insert into public.loading_roles (email, role) values ('yourname@vriddhi.local', 'admin')
--   on conflict (email) do update set role = 'admin';

-- "Log out all staff devices": any STAFF session that signed in before
-- staff_epoch is refused everywhere (reads return nothing, writes fail), and
-- the app signs that phone out the moment it sees the change (realtime).
create table if not exists public.loading_auth_state (
  id          int primary key default 1 check (id = 1),
  staff_epoch timestamptz
);
insert into public.loading_auth_state (id) values (1) on conflict (id) do nothing;

-- Push notifications are for ADMIN phones only. Each registered phone carries
-- its login's email; staff phones are removed here, and a login that stops
-- being admin loses its phones at once (trigger below), so the loading-notify
-- function only ever reaches admins. Staff actions still notify the admins.
alter table public.loading_push_subs add column if not exists email text not null default '';
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'auth' and table_name = 'users') then
    execute $q$ update public.loading_push_subs s set email = lower(u.email)
                  from auth.users u where u.id = s.user_id and s.email = '' $q$;
  end if;
end $$;
delete from public.loading_push_subs s
 where not exists (select 1 from public.loading_roles r where r.role = 'admin' and r.email = s.email);
create or replace function public._loading_roles_push_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' or new.role <> 'admin' or new.email <> old.email then
    delete from loading_push_subs where email = old.email;
  end if;
  return null;
end $$;
drop trigger if exists loading_roles_push_cleanup on public.loading_roles;
create trigger loading_roles_push_cleanup after update or delete on public.loading_roles
  for each row execute function public._loading_roles_push_cleanup();

-- plpgsql (not sql) so this file still loads into a plain Postgres for testing.
create or replace function public._loading_email() returns text
language plpgsql stable as $$
begin
  return lower(coalesce(auth.jwt() ->> 'email', ''));
end $$;

create or replace function public._loading_is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (select 1 from loading_roles where lower(email) = _loading_email() and role = 'admin');
end $$;

-- When this session signed in. Supabase access tokens carry the sign-in time
-- in the "amr" claim, and it stays the same when the token is refreshed
-- (unlike "iat"), which is what makes a forced logout stick.
create or replace function public._loading_signed_in_at() returns timestamptz
language plpgsql stable as $$
declare j jsonb := auth.jwt(); t bigint;
begin
  if jsonb_typeof(j -> 'amr') = 'array' then
    select min((a ->> 'timestamp')::bigint) into t from jsonb_array_elements(j -> 'amr') a where a ? 'timestamp';
  end if;
  if t is null then t := (j ->> 'iat')::bigint; end if;
  return to_timestamp(coalesce(t, 0));
end $$;

-- Is this a signed-in session that hasn't been logged out by the admin?
create or replace function public._loading_session_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare ep timestamptz;
begin
  if auth.uid() is null then return false; end if;
  if _loading_is_admin() then return true; end if;
  select staff_epoch into ep from loading_auth_state where id = 1;
  return ep is null or date_trunc('second', ep) <= _loading_signed_in_at();
end $$;

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
alter table public.loading_push_subs enable row level security;
alter table public.loading_destinations enable row level security;
alter table public.loading_trips enable row level security;
alter table public.loading_fuel_logs enable row level security;
alter table public.loading_settings enable row level security;
alter table public.loading_roles enable row level security;
alter table public.loading_auth_state enable row level security;

-- A phone may only ever see or touch its own owner's subscriptions. The edge
-- function reads every row with the service-role key, which bypasses RLS.
-- Unlike the read policies above this one names auth.uid(), which a policy
-- expression resolves at creation time — so it is skipped on a plain Postgres
-- that has no auth schema (testing), exactly like the realtime block below.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    drop policy if exists loading_push_own on public.loading_push_subs;
    create policy loading_push_own on public.loading_push_subs
      for all to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

drop policy if exists loading_events_read on public.loading_events;
create policy loading_events_read on public.loading_events
  for select to authenticated
  using (created_at >= now() - interval '7 days' and public._loading_session_ok());

drop policy if exists loading_vehicles_read on public.loading_vehicles;
create policy loading_vehicles_read on public.loading_vehicles
  for select to authenticated using (public._loading_session_ok());

drop policy if exists loading_day_closes_read on public.loading_day_closes;
create policy loading_day_closes_read on public.loading_day_closes
  for select to authenticated
  using (close_date >= ((now() at time zone 'Asia/Kolkata')::date) - 30 and public._loading_session_ok());

-- customers are needed by everyone (the "Sold to" list); trips, the fuel log
-- and the settings are ADMIN-only
drop policy if exists loading_destinations_read on public.loading_destinations;
create policy loading_destinations_read on public.loading_destinations
  for select to authenticated using (public._loading_session_ok());

drop policy if exists loading_trips_read on public.loading_trips;
create policy loading_trips_read on public.loading_trips
  for select to authenticated using (public._loading_is_admin());

-- the logout time is not secret — every phone watches it to sign itself out
drop policy if exists loading_auth_state_read on public.loading_auth_state;
create policy loading_auth_state_read on public.loading_auth_state
  for select to authenticated using (true);

drop policy if exists loading_roles_read on public.loading_roles;
create policy loading_roles_read on public.loading_roles
  for select to authenticated using (public._loading_is_admin());

drop policy if exists loading_settings_read on public.loading_settings;
create policy loading_settings_read on public.loading_settings
  for select to authenticated using (public._loading_is_admin());

drop policy if exists loading_fuel_logs_read on public.loading_fuel_logs;
create policy loading_fuel_logs_read on public.loading_fuel_logs
  for select to authenticated using (public._loading_is_admin());

-- ---------------------------------------------------------------------
-- Helper
-- ---------------------------------------------------------------------
create or replace function public._loading_auth() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  -- the app recognises the SIGNED_OUT prefix and signs the phone out
  if not _loading_session_ok() then
    raise exception 'SIGNED_OUT: you were signed out by the admin — please sign in again';
  end if;
end $$;

create or replace function public._loading_admin() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_auth();
  if not _loading_is_admin() then raise exception 'Admin only'; end if;
end $$;

-- Add (sign +1) or subtract (sign -1) a chambers array [{name,qty}] to a fill
-- object {"C1":qty,...}, clamping at 0 and rounding to 2 dp.
create or replace function public._fill_apply(p_fill jsonb, p_chambers jsonb, p_sign int)
returns jsonb language plpgsql immutable as $$
declare c jsonb; nm text; cur numeric; res jsonb := coalesce(p_fill,'{}'::jsonb);
begin
  for c in select * from jsonb_array_elements(coalesce(p_chambers,'[]'::jsonb)) loop
    nm := c->>'name';
    cur := coalesce((res->>nm)::numeric,0) + p_sign*(c->>'qty')::numeric;
    if cur < 0 then cur := 0; end if;
    res := jsonb_set(res, array[nm], to_jsonb(round(cur,2)));
  end loop;
  return res;
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
  if coalesce(p_kind,'load') <> 'load' and not _loading_is_admin() then raise exception 'Admin only'; end if;

  insert into loading_events (vehicle, kind, chambers, total, by_name, remark, created_by)
  values (p_vehicle, coalesce(p_kind,'load'), p_chambers, p_total, coalesce(p_by,''),
          coalesce(p_remark,''), auth.uid())
  returning id into rid;

  -- keep the tanker's PERSISTENT fill + all-time loaded in sync (loads only)
  if coalesce(p_kind,'load') = 'load' then
    update loading_vehicles
      set fill = _fill_apply(fill, p_chambers, 1),
          total_loaded = round(total_loaded + p_total, 2)
      where plate = p_vehicle;
  end if;

  delete from loading_events where created_at < now() - interval '7 days';
  return rid;
end $$;

-- Sell (empty) a tanker: snapshot its persistent fill into a 'dispatch' event,
-- add to all-time sold, and reset the fill to empty. Fill is server state, so
-- this is independent of the 7-day event window.
create or replace function public.loading_dispatch(p_vehicle text, p_by text, p_remark text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v loading_vehicles; snap jsonb := '[]'::jsonb; tot numeric := 0; k text; val numeric; rid uuid;
begin
  perform _loading_auth();
  select * into v from loading_vehicles where plate = p_vehicle;
  if not found then raise exception 'Unknown tanker'; end if;
  for k, val in select key, value::numeric from jsonb_each_text(coalesce(v.fill,'{}'::jsonb)) order by key loop
    if val > 0 then
      snap := snap || jsonb_build_array(jsonb_build_object('name', k, 'qty', round(val,2)));
      tot := tot + val;
    end if;
  end loop;
  if tot <= 0 then raise exception 'Tanker is already empty'; end if;
  insert into loading_events (vehicle, kind, chambers, total, by_name, remark, created_by)
    values (p_vehicle, 'dispatch', snap, round(tot,2), coalesce(p_by,''), coalesce(p_remark,''), auth.uid())
    returning id into rid;
  update loading_vehicles set fill = '{}'::jsonb, total_sold = round(total_sold + tot, 2) where plate = p_vehicle;
  -- the permanent trip record (same id, same server time) for the trip report
  insert into loading_trips (id, vehicle, total, dest, by_name, created_at)
    select id, vehicle, total, remark, by_name, created_at from loading_events where id = rid
  on conflict (id) do nothing;
  delete from loading_events where created_at < now() - interval '7 days';
  return rid;
end $$;

-- Delete a (recent) event, reversing its effect on the persistent fill/totals.
create or replace function public.loading_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e loading_events;
begin
  perform _loading_admin();
  select * into e from loading_events where id = p_id and created_at >= now() - interval '7 days';
  if not found then raise exception 'Record not found or older than 7 days'; end if;
  if e.kind = 'load' then
    update loading_vehicles set fill = _fill_apply(fill, e.chambers, -1),
      total_loaded = greatest(round(total_loaded - e.total, 2), 0) where plate = e.vehicle;
  elsif e.kind = 'dispatch' then
    update loading_vehicles set fill = _fill_apply(fill, e.chambers, 1),
      total_sold = greatest(round(total_sold - e.total, 2), 0) where plate = e.vehicle;
    delete from loading_trips where id = p_id;   -- an undone sale is not a trip
  end if;
  delete from loading_events where id = p_id;
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
  perform _loading_admin();
  delete from loading_events where id is not null;
  get diagnostics n = row_count;
  update loading_vehicles set fill = '{}'::jsonb, total_loaded = 0, total_sold = 0 where plate is not null;
  delete from loading_trips where id is not null;   -- trips are sale records too
  return n;
end $$;

-- Add / remove a shared tanker (Manage screen).
create or replace function public.loading_vehicle_add(p_plate text, p_caps jsonb, p_color text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_admin();
  if coalesce(trim(p_plate),'') = '' then raise exception 'Vehicle number required'; end if;
  if p_caps is null or jsonb_array_length(p_caps) = 0 then raise exception 'At least one chamber is required'; end if;
  insert into loading_vehicles (plate, caps, color)
  values (upper(trim(p_plate)), p_caps, coalesce(p_color,''))
  on conflict (plate) do update set caps = excluded.caps, color = excluded.color;
end $$;

create or replace function public.loading_vehicle_remove(p_plate text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_admin();
  delete from loading_vehicles where plate = p_plate;
end $$;

-- End Day: book the just-finished business day under the PREVIOUS calendar date
-- (IST). Allowed once per day — the close_date primary key makes a second press
-- the same day fail. Returns the date the day was booked under.
create or replace function public.loading_end_day() returns text
language plpgsql security definer set search_path = public as $$
declare
  ist timestamp := now() at time zone 'Asia/Kolkata';
  mins int := extract(hour from ist)*60 + extract(minute from ist);
  cd date := ist::date - 1;   -- the day being ended (yesterday, in IST)
begin
  perform _loading_auth();
  -- manual End Day is only for the morning shift-change window (5:30–7:30 AM IST)
  if mins < 330 or mins >= 450 then
    raise exception 'End Day is available only between 5:30 and 7:30 AM';
  end if;
  if exists (select 1 from loading_day_closes where close_date = cd) then
    raise exception 'This day has already been ended';
  end if;
  insert into loading_day_closes (close_date, closed_by) values (cd, auth.uid());
  delete from loading_day_closes where close_date < ist::date - 30;
  return to_char(cd, 'YYYY-MM-DD');
end $$;

-- Internal: auto-close any business day whose deadline (8:00 AM IST the next
-- day) has passed and that nobody ended manually. The close is timestamped at
-- that exact 8:00 AM, so business dates come out identical no matter when this
-- runs. No auth check (called by the auth wrapper below and by pg_cron).
create or replace function public._loading_close_due(p_by uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  today_ist date := (now() at time zone 'Asia/Kolkata')::date;
  d date;
  deadline timestamptz;
  n int := 0;
begin
  select coalesce(max(close_date) + 1,
                  (select (min(created_at) at time zone 'Asia/Kolkata')::date from loading_events))
    into d from loading_day_closes;
  if d is null then return 0; end if;
  while d < today_ist loop
    deadline := ((d + 1)::text || ' 07:30:00')::timestamp at time zone 'Asia/Kolkata';
    exit when now() < deadline;
    insert into loading_day_closes (close_date, closed_at, closed_by)
      values (d, deadline, p_by)
      on conflict (close_date) do nothing;
    n := n + 1;
    d := d + 1;
  end loop;
  delete from loading_day_closes where close_date < today_ist - 30;
  return n;
end $$;

-- Client-callable wrapper (the app calls this on open and on a timer).
create or replace function public.loading_close_due() returns int
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_auth();
  return _loading_close_due(auth.uid());
end $$;

-- ---------------------------------------------------------------------
-- Trip report: correct the customer a trip went to (e.g. a wrong pick, or an
-- older free-text "sold to" that isn't in the customer list). Also fixes the
-- remark on the sale record while it is still within the 7-day window.
-- ---------------------------------------------------------------------
create or replace function public.loading_trip_set_dest(p_id uuid, p_dest text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_admin();
  if not exists (select 1 from loading_destinations where name = p_dest) then
    raise exception 'Pick a customer from the list';
  end if;
  update loading_trips set dest = p_dest where id = p_id;
  if not found then raise exception 'Trip not found'; end if;
  update loading_events set remark = p_dest where id = p_id and kind = 'dispatch';
end $$;

-- Customers / RTD master. Saving a customer that belongs to a group sets the
-- SAME RTD on every customer of that group.
create or replace function public.loading_dest_save(p_name text, p_rtd numeric, p_grp text) returns void
language plpgsql security definer set search_path = public as $$
declare nm text := trim(coalesce(p_name,'')); g text := trim(coalesce(p_grp,''));
begin
  perform _loading_admin();
  if nm = '' then raise exception 'Customer name required'; end if;
  if p_rtd is null or p_rtd < 0 then raise exception 'RTD km must be 0 or more'; end if;
  insert into loading_destinations (name, rtd_km, grp, sort)
    values (nm, round(p_rtd,1), g, coalesce((select max(sort) from loading_destinations),0) + 1)
  on conflict (name) do update set rtd_km = excluded.rtd_km, grp = excluded.grp;
  if g <> '' then
    update loading_destinations set rtd_km = round(p_rtd,1) where grp = g;
  end if;
end $$;

create or replace function public.loading_dest_remove(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_admin();
  delete from loading_destinations where name = p_name;
end $$;

-- Mileage: record a refill of the tanker's own diesel tank with the reading.
-- (Earlier drafts of this function had other arguments — drop them so there is
-- exactly one.)
drop function if exists public.loading_fuel_add(text, timestamptz, numeric, numeric, boolean, text, text);
drop function if exists public.loading_fuel_add(text, timestamptz, numeric, numeric, numeric, text, text);
create or replace function public.loading_fuel_add(
  p_vehicle text, p_reading_at timestamptz, p_odometer numeric, p_litres numeric,
  p_anguls numeric, p_stock_l numeric, p_note text, p_by text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  perform _loading_admin();
  if coalesce(p_vehicle,'') = '' then raise exception 'Vehicle required'; end if;
  if p_odometer is null or p_odometer < 0 then raise exception 'Reading required'; end if;
  if p_litres is null or p_litres < 0 then raise exception 'Litres must be 0 or more'; end if;
  if p_anguls is not null and p_anguls < 0 then raise exception 'Anguls must be 0 or more'; end if;
  if p_stock_l is not null and p_stock_l < 0 then raise exception 'Stock must be 0 or more'; end if;
  insert into loading_fuel_logs (vehicle, reading_at, odometer, litres, anguls, stock_l, note, by_name, created_by)
    values (p_vehicle, coalesce(p_reading_at, now()), round(p_odometer,2), round(p_litres,2),
            round(p_anguls,2), round(p_stock_l,2), coalesce(p_note,''), coalesce(p_by,''), auth.uid())
    returning id into rid;
  return rid;
end $$;

-- Change a shared setting (only the known keys, with sane values).
create or replace function public.loading_setting_set(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v numeric;
begin
  perform _loading_admin();
  if p_key not in ('angul_l','alert_pct','reserve_l') then raise exception 'Unknown setting'; end if;
  v := (p_value #>> '{}')::numeric;
  if p_key = 'angul_l'   and (v is null or v <= 0 or v > 1000) then raise exception 'Litres per Angul must be between 0 and 1000'; end if;
  if p_key = 'alert_pct' and (v is null or v < 1 or v > 90)  then raise exception 'Alert percent must be between 1 and 90'; end if;
  if p_key = 'reserve_l' and (v is null or v < 0 or v > 2000) then raise exception 'Reserve must be between 0 and 2000 litres'; end if;
  insert into loading_settings (key, value, updated_at) values (p_key, to_jsonb(v), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

create or replace function public.loading_fuel_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_admin();
  delete from loading_fuel_logs where id = p_id;
end $$;

-- ---------------------------------------------------------------------
-- Who am I? The app calls this on sign-in and on every refresh: it decides
-- what the phone shows, and a staff phone that has been logged out by the
-- admin sees ok = false and signs itself out. `admins` = how many admin logins
-- exist (0 means nobody has been made admin yet).
-- ---------------------------------------------------------------------
create or replace function public.loading_whoami() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object(
    'email',  _loading_email(),
    'role',   case when _loading_is_admin() then 'admin' else 'staff' end,
    'ok',     _loading_session_ok(),
    'admins', (select count(*) from loading_roles where role = 'admin'));
end $$;

-- Admin: log every STAFF phone out now. Their next request is refused and the
-- app shows the sign-in screen; admins stay signed in.
create or replace function public.loading_logout_staff() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz := now();
begin
  perform _loading_admin();
  update loading_auth_state set staff_epoch = t where id = 1;
  return t;
end $$;

-- ---------------------------------------------------------------------
-- MILEAGE & DIESEL FORECAST (the tanker's OWN tank) — robust model.
-- Same rules as the app (loading/index.html, "MILEAGE MODEL"); keep in step.
--
--  Entries: a refill = dip taken BEFORE filling + litres filled; a stock
--  check = a dip alone (0 filled). The tank is never dipped after filling.
--  Points: entries whose stock is known (a dip; for OD15AF5510 a refill counts
--  as run dry). A refill without its dip adds its litres but isn't a point.
--  Per point: odo, and C = litres filled before it − its stock. Between two
--  points: distance = Δodo, diesel used = ΔC.
--  Mileage: over the newest 12 points, every pair's distance ÷ diesel; pairs
--  outside 0.5–10 km/L (OD15AF5510: 2–2000 L dispensed per litre) are
--  dropped as impossible; the rest give a DISTANCE-WEIGHTED MEDIAN. None until
--  the longest sound pair spans ≥ 100 km (3,000 L) and ≥ 25 L.
--  In tank now: from the last point — its stock + every litre filled since −
--  the distance since ÷ mileage − the trips sold since the last entry
--  (customer RTD km ÷ mileage; OD15AF5510: litres sold ÷ dispensed-per-litre).
-- Staff can't read the fuel log; these functions return only the answers.
-- OD15AF5510 is named here as in the app (METER_VEHICLES) — keep them in step.
-- ---------------------------------------------------------------------
create or replace function public._loading_fuel_points(p_vehicle text, p_meter boolean, p_al numeric)
returns table (odo numeric, c numeric, stk numeric, reading_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.odometer, e.fb - e.stk, e.stk, e.reading_at, e.created_at from (
    select odometer, reading_at, created_at,
           case when stock_l is not null then stock_l
                when anguls is not null then anguls * p_al
                when p_meter and litres > 0 then 0 end as stk,
           coalesce(sum(litres) over (order by reading_at, created_at
                                      rows between unbounded preceding and 1 preceding), 0) as fb
      from loading_fuel_logs where vehicle = p_vehicle) e
  where e.stk is not null
$$;

create or replace function public._loading_fuel_state(p_vehicle text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  al numeric; res numeric;
  meter boolean := upper(regexp_replace(coalesce(p_vehicle,''), '[^A-Za-z0-9]', '', 'g')) = 'OD15AF5510';
  lo numeric; hi numeric; minspan numeric;
  mpl numeric; q1 numeric; q3 numeric; span numeric; maxu numeric; n int;
  k record; l loading_fuel_logs; filled numeric; after_last numeric; after_fill numeric;
  km numeric := 0; lit numeric := 0; trips int := 0; unknown int := 0; burnt numeric; stock numeric;
begin
  select (value #>> '{}')::numeric into al  from loading_settings where key = 'angul_l';
  select (value #>> '{}')::numeric into res from loading_settings where key = 'reserve_l';
  al := coalesce(al, 16); res := coalesce(res, 40);
  lo := case when meter then 2 else 0.5 end;  hi := case when meter then 2000 else 10 end;
  minspan := case when meter then 3000 else 100 end;

  with p as (select * from _loading_fuel_points(p_vehicle, meter, al) order by reading_at desc, created_at desc limit 12),
  pr as (select b.odo - a.odo as d, b.c - a.c as u
           from p a join p b on (a.reading_at, a.created_at) < (b.reading_at, b.created_at)),
  ok as (select d, u, d / u as r from pr where d > 0 and u > 0 and d / u between lo and hi),
  ag as (select max(d) as span, max(u) as maxu, sum(d) as tw from ok),
  ord as (select r, sum(d) over (order by r, d) as cw from ok)
  select (select r from ord where cw >= ag.tw * 0.5  order by r limit 1),
         (select r from ord where cw >= ag.tw * 0.25 order by r limit 1),
         (select r from ord where cw >= ag.tw * 0.75 order by r limit 1),
         ag.span, ag.maxu, (select count(*) from p)
    into mpl, q1, q3, span, maxu, n from ag;
  if mpl is not null and (span < minspan or maxu < 25) then mpl := null; end if;   -- not enough data yet

  select * into l from loading_fuel_logs where vehicle = p_vehicle order by reading_at desc, created_at desc limit 1;
  if found then
    select coalesce(sum(d.rtd_km), 0), coalesce(sum(t.total), 0), count(*), count(*) filter (where d.name is null and not meter)
      into km, lit, trips, unknown
      from loading_trips t
      left join loading_destinations d on lower(trim(d.name)) = lower(trim(t.dest))
     where t.vehicle = p_vehicle and t.created_at > l.reading_at;
    select * into k from _loading_fuel_points(p_vehicle, meter, al) order by reading_at desc, created_at desc limit 1;
    if found and mpl > 0 then                -- no point with a known dip yet, or no mileage: unknown
      select coalesce(sum(litres), 0) into filled from loading_fuel_logs
       where vehicle = p_vehicle and (reading_at, created_at) >= (k.reading_at, k.created_at);
      after_last := k.stk + filled - greatest(0, l.odometer - k.odo) / mpl;
      after_fill := round(greatest(0, after_last), 1);
      burnt := round((case when meter then lit else km end) / mpl, 1);
      stock := round(least(greatest(0, after_last - burnt), k.stk + filled), 1);
    end if;
  end if;
  return jsonb_build_object(
    'vehicle', p_vehicle, 'meter', meter, 'mileage', round(mpl::numeric, 3), 'stretches', coalesce(n, 0),
    'spread', case when mpl > 0 then round(((q3 - q1) / mpl)::numeric, 3) end, 'span', round(span, 1),
    'last_at', l.reading_at, 'after_fill', after_fill, 'trips_since', trips, 'km_since', km,
    'unknown_trips', unknown, 'burnt', burnt, 'stock_now', stock, 'reserve', res);
end $$;

-- Every tanker's diesel now (home screen). Anyone signed in.
create or replace function public.loading_fuel_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _loading_auth();
  return coalesce((select jsonb_agg(_loading_fuel_state(plate) order by plate) from loading_vehicles), '[]'::jsonb);
end $$;

-- Forecast for one sale, before it is confirmed: what this trip will burn and
-- whether the tanker should be refilled. advice = ok | refill_after |
-- refill_before | unknown.
create or replace function public.loading_fuel_forecast(p_vehicle text, p_dest text, p_total numeric)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare st jsonb; mpl numeric; rtd numeric; need numeric; stock numeric; after numeric; res numeric; adv text;
begin
  perform _loading_auth();
  st := _loading_fuel_state(p_vehicle);
  mpl := (st ->> 'mileage')::numeric; stock := (st ->> 'stock_now')::numeric; res := (st ->> 'reserve')::numeric;
  select rtd_km into rtd from loading_destinations where lower(trim(name)) = lower(trim(coalesce(p_dest,'')));
  if mpl > 0 then
    need := round(case when (st ->> 'meter')::boolean then coalesce(p_total, 0) else coalesce(rtd, 0) end / mpl, 1);
  end if;
  if need is null or stock is null then adv := 'unknown';
  else
    after := round(stock - need, 1);
    adv := case when after < 0 then 'refill_before' when after < res then 'refill_after' else 'ok' end;
  end if;
  return st || jsonb_build_object('dest', p_dest, 'rtd', rtd, 'need', need, 'after', after, 'advice', adv,
    'trips_left', case when need > 0 and after is not null and after > res then floor((after - res) / need) end);
end $$;

-- ---------------------------------------------------------------------
-- Web push: register / forget this phone. Keyed on the browser's endpoint,
-- so re-registering the same phone updates its keys instead of piling up.
-- ---------------------------------------------------------------------
create or replace function public.loading_push_save(
  p_endpoint text, p_p256dh text, p_auth text, p_by text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_admin();                  -- notifications are for admin phones only
  if coalesce(p_endpoint,'') = '' or coalesce(p_p256dh,'') = '' or coalesce(p_auth,'') = '' then
    raise exception 'Incomplete push subscription';
  end if;
  insert into loading_push_subs (endpoint, user_id, by_name, p256dh, auth, seen_at, email)
    values (p_endpoint, auth.uid(), coalesce(p_by,''), p_p256dh, p_auth, now(), _loading_email())
  on conflict (endpoint) do update
    set user_id = excluded.user_id, by_name = excluded.by_name,
        p256dh  = excluded.p256dh,  auth    = excluded.auth,
        seen_at = now(), email = excluded.email;
  -- A phone that re-subscribes gets a NEW endpoint, and the row for its old one
  -- lives on for ever. Those dead rows are still accepted by the push service,
  -- so they inflate the "sent" count while delivering to nobody. Every phone
  -- refreshes seen_at each time the app opens, so anything untouched for a
  -- month is genuinely gone.
  delete from loading_push_subs
   where user_id = auth.uid() and seen_at < now() - interval '30 days';
end $$;

create or replace function public.loading_push_drop(p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _loading_auth();
  delete from loading_push_subs where endpoint = p_endpoint and user_id = auth.uid();
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
      public.loading_dispatch(text, text, text),
      public.loading_delete(uuid),
      public.loading_purge(),
      public.loading_clear_all(),
      public.loading_vehicle_add(text, jsonb, text),
      public.loading_vehicle_remove(text),
      public.loading_end_day(),
      public.loading_close_due(),
      public.loading_push_save(text, text, text, text),
      public.loading_push_drop(text),
      public.loading_trip_set_dest(uuid, text),
      public.loading_dest_save(text, numeric, text),
      public.loading_dest_remove(text),
      public.loading_fuel_add(text, timestamptz, numeric, numeric, numeric, numeric, text, text),
      public.loading_setting_set(text, jsonb),
      public.loading_whoami(),
      public.loading_logout_staff(),
      public.loading_fuel_status(),
      public.loading_fuel_forecast(text, text, numeric),
      -- called by the read policies, which run as the signed-in user
      public._loading_session_ok(),
      public._loading_is_admin(),
      public.loading_fuel_delete(uuid)
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
  begin
    alter publication supabase_realtime add table public.loading_trips;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.loading_destinations;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.loading_fuel_logs;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.loading_settings;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.loading_auth_state;
  exception when others then null;
  end;
end $$;

-- Optional belt-and-suspenders: if pg_cron is installed, purge hourly and run
-- the 8 AM auto-close hourly too (so days close on time even if nobody opens
-- the app; the close is timestamped at the 8 AM deadline regardless of when it
-- runs, so business dates are unaffected).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'loading_purge_hourly', '0 * * * *',
      $q$ delete from public.loading_events where created_at < now() - interval '7 days' $q$
    );
    perform cron.schedule(
      'loading_close_due_hourly', '5 * * * *',
      $q$ select public._loading_close_due(null) $q$
    );
  end if;
exception when others then null;
end $$;
