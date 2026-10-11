-- =====================================================================
-- Shree Shyam Fleet (/fleet/) cloud store
-- ---------------------------------------------------------------------
-- The fleet app's OWN Supabase project (not the ledger's). Paste this
-- whole file into that project's SQL Editor and press Run. Safe to run
-- again: later updates add to this file, and re-running is how you upgrade.
--
-- Who can see the data
--   * The public (anon / publishable) key can't read or call anything.
--   * A login alone isn't enough either: the login must also be on the
--     fleet_members list, which only this SQL Editor can change.
--       1. Authentication → Users → Add user (email + password)
--       2. Run:  select fleet_add_member('you@example.com');
--
-- What is stored: the figures the app reads from the Trip Register
-- workbook (trips, SSFC ledger rows, HSD fills, urea, rates), one row per
-- upload — the newest 10 are kept; and the app's Setup (each route's
-- distance, driver salary and diesel, which vehicles count in the tyre /
-- fastag analysis), one row.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------
create table if not exists public.fleet_members (
  user_id  uuid primary key,
  email    text not null,
  added_at timestamptz not null default now()
);

create or replace function public.fleet_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from public.fleet_members m where m.user_id = auth.uid());
$$;

create or replace function public.fleet_assert_member()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.fleet_is_member() then
    raise exception 'This login is not on the fleet members list.'
      using errcode = '42501',
            hint = 'In the SQL Editor run: select fleet_add_member(''your login email'');';
  end if;
end $$;

-- SQL Editor only: allow / remove a login.
create or replace function public.fleet_add_member(p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text;
begin
  select u.id, u.email into v_id, v_email
  from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
  if v_id is null then
    return 'No login with that email yet. Create it under Authentication → Users first.';
  end if;
  insert into public.fleet_members (user_id, email) values (v_id, v_email)
  on conflict (user_id) do update set email = excluded.email;
  return 'Added ' || v_email || ' to the fleet members.';
end $$;

create or replace function public.fleet_remove_member(p_email text)
returns text language plpgsql security definer set search_path = public as $$
begin
  delete from public.fleet_members where lower(email) = lower(btrim(p_email));
  if not found then return 'That email was not on the list.'; end if;
  return 'Removed ' || btrim(p_email) || ' from the fleet members.';
end $$;

alter table public.fleet_members enable row level security;
revoke all on public.fleet_members from public, anon, authenticated;
grant select on public.fleet_members to authenticated;
drop policy if exists fleet_members_read on public.fleet_members;
create policy fleet_members_read on public.fleet_members for select to authenticated
  using ((select public.fleet_is_member()));

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.fleet_uploads (
  id          bigint generated always as identity primary key,
  file_name   text not null default '',
  latest_trip date,
  counts      jsonb not null default '{}'::jsonb,
  payload     jsonb not null,
  by_email    text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists fleet_uploads_created_idx on public.fleet_uploads (created_at desc);

alter table public.fleet_uploads enable row level security;
revoke all on public.fleet_uploads from public, anon;
grant select, insert, delete on public.fleet_uploads to authenticated;
drop policy if exists fleet_uploads_members on public.fleet_uploads;
create policy fleet_uploads_members on public.fleet_uploads for all to authenticated
  using ((select public.fleet_is_member())) with check ((select public.fleet_is_member()));

-- The Setup tab: one row of settings (routes, vehicles, options)
create table if not exists public.fleet_settings (
  id          int primary key default 1 check (id = 1),
  value       jsonb not null default '{}'::jsonb,
  by_email    text not null default '',
  updated_at  timestamptz not null default now()
);
alter table public.fleet_settings enable row level security;
revoke all on public.fleet_settings from public, anon;
grant select, insert, update on public.fleet_settings to authenticated;
drop policy if exists fleet_settings_members on public.fleet_settings;
create policy fleet_settings_members on public.fleet_settings for all to authenticated
  using ((select public.fleet_is_member())) with check ((select public.fleet_is_member()));

-- ---------------------------------------------------------------------
-- App functions (called from /fleet/ with supabase.rpc)
-- ---------------------------------------------------------------------
create or replace function public.fleet_whoami()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('user_id', auth.uid(),
                            'email', coalesce(auth.jwt() ->> 'email', ''),
                            'member', public.fleet_is_member());
$$;

-- the newest upload: { meta: {...}, payload: {...} } or null
create or replace function public.fleet_latest()
returns jsonb language plpgsql stable set search_path = public as $$
declare v jsonb;
begin
  perform public.fleet_assert_member();
  select jsonb_build_object(
           'meta', jsonb_build_object('id', u.id, 'file_name', u.file_name, 'latest_trip', u.latest_trip,
                                      'counts', u.counts, 'by_email', u.by_email, 'created_at', u.created_at),
           'payload', u.payload)
    into v
    from public.fleet_uploads u
   order by u.created_at desc, u.id desc
   limit 1;
  return v;
end $$;

create or replace function public.fleet_save(p_file_name text, p_payload jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v public.fleet_uploads;
begin
  perform public.fleet_assert_member();
  if p_payload is null or jsonb_typeof(p_payload -> 'trips') <> 'array' or jsonb_array_length(p_payload -> 'trips') = 0 then
    raise exception 'Nothing to save: the upload has no trips.';
  end if;
  insert into public.fleet_uploads (file_name, latest_trip, counts, payload, by_email)
  values (coalesce(p_file_name, ''),
          nullif(p_payload ->> 'latest', '')::date,
          jsonb_build_object('trips', jsonb_array_length(p_payload -> 'trips'),
                             'hsd', coalesce(jsonb_array_length(p_payload -> 'hsd'), 0),
                             'urea', coalesce(jsonb_array_length(p_payload -> 'urea'), 0)),
          p_payload,
          coalesce(auth.jwt() ->> 'email', ''))
  returning * into v;
  -- keep the newest 10
  delete from public.fleet_uploads
   where id in (select id from public.fleet_uploads order by created_at desc, id desc offset 10);
  return jsonb_build_object('id', v.id, 'file_name', v.file_name, 'latest_trip', v.latest_trip,
                            'counts', v.counts, 'by_email', v.by_email, 'created_at', v.created_at);
end $$;

create or replace function public.fleet_uploads_list(p_limit int default 10)
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform public.fleet_assert_member();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'file_name', u.file_name, 'latest_trip', u.latest_trip,
                                        'counts', u.counts, 'by_email', u.by_email, 'created_at', u.created_at)
                     order by u.created_at desc, u.id desc)
      from (select * from public.fleet_uploads order by created_at desc, id desc limit greatest(1, least(p_limit, 50))) u), '[]'::jsonb);
end $$;

create or replace function public.fleet_settings_get()
returns jsonb language plpgsql stable set search_path = public as $$
begin
  perform public.fleet_assert_member();
  return coalesce((select jsonb_build_object('value', value, 'by_email', by_email, 'updated_at', updated_at)
                     from public.fleet_settings where id = 1),
                  jsonb_build_object('value', '{}'::jsonb));
end $$;

create or replace function public.fleet_settings_save(p_value jsonb)
returns jsonb language plpgsql set search_path = public as $$
begin
  perform public.fleet_assert_member();
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'Settings must be an object.';
  end if;
  insert into public.fleet_settings (id, value, by_email, updated_at)
  values (1, p_value, coalesce(auth.jwt() ->> 'email', ''), now())
  on conflict (id) do update set value = excluded.value, by_email = excluded.by_email, updated_at = now();
  return public.fleet_settings_get();
end $$;

-- ---------------------------------------------------------------------
-- Who may call what: the app's functions for logins (they check the
-- members list themselves); adding / removing members from the SQL Editor only
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'fleet\_%'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname in ('fleet_add_member', 'fleet_remove_member') then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
