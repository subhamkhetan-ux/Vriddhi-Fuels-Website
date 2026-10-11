-- =====================================================================
-- Shree Shyam Fleet (/fleet/) cloud store
-- ---------------------------------------------------------------------
-- Run this in the SQL Editor of the LEDGER's Supabase project (the one
-- in ledger/config.js), after supabase/ledger-schema.sql. The fleet app
-- uses the same logins: whoever is on ledger_members can use it, nobody
-- else (and nothing is readable with the public key).
--
-- It only adds the fleet_* table and functions below; nothing the ledger
-- uses is changed. Safe to run again.
--
-- What is stored: the figures the app reads from the Trip Register
-- workbook (trips, SSFC ledger rows, HSD fills, urea, rates), one row per
-- upload. The newest 10 uploads are kept.
-- =====================================================================

do $$
begin
  if to_regprocedure('public.ledger_is_member()') is null then
    raise exception 'Run supabase/ledger-schema.sql in this project first (the fleet app uses the ledger''s member list).';
  end if;
end $$;

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
  using ((select public.ledger_is_member())) with check ((select public.ledger_is_member()));

-- ---------------------------------------------------------------------
-- App functions (called from /fleet/ with supabase.rpc)
-- ---------------------------------------------------------------------
create or replace function public.fleet_whoami()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('user_id', auth.uid(),
                            'email', coalesce(auth.jwt() ->> 'email', ''),
                            'member', public.ledger_is_member());
$$;

-- the newest upload: { meta: {...}, payload: {...} } or null
create or replace function public.fleet_latest()
returns jsonb language plpgsql stable set search_path = public as $$
declare v jsonb;
begin
  perform public.ledger_assert_member();
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
  perform public.ledger_assert_member();
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
  perform public.ledger_assert_member();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'file_name', u.file_name, 'latest_trip', u.latest_trip,
                                        'counts', u.counts, 'by_email', u.by_email, 'created_at', u.created_at)
                     order by u.created_at desc, u.id desc)
      from (select * from public.fleet_uploads order by created_at desc, id desc limit greatest(1, least(p_limit, 50))) u), '[]'::jsonb);
end $$;

revoke all on function public.fleet_whoami(), public.fleet_latest(), public.fleet_save(text, jsonb), public.fleet_uploads_list(int) from public, anon;
grant execute on function public.fleet_whoami(), public.fleet_latest(), public.fleet_save(text, jsonb), public.fleet_uploads_list(int) to authenticated;
