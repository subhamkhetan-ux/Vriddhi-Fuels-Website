-- =====================================================================
-- Vriddhi Fuels — Jarvis (/jarvis/) — the Mac command queue (OPTIONAL)
-- ---------------------------------------------------------------------
-- Only needed when the Mac side is switched on (JARVIS_CONFIG.MAC = true).
-- Run it in the JARVIS project after jarvis-schema.sql: only Jarvis members
-- (jarvis_is_member) can send or pick up a command. Safe to run again.
--
-- What it is for: things that can only happen on the Mac — start / stop the
-- XtraPower monitor, watch an account, open its Chrome window, run a script
-- the owner has whitelisted there. Jarvis (phone or computer) queues a
-- command; the Jarvis bridge on the Mac (jarvis/bridge/) asks for the next
-- one every few seconds, runs it and posts the result. The bridge only runs
-- actions it knows itself — a command here is a request, never code.
--
--   jarvis_commands  one row per request (queued → running → done / failed;
--                    expired if no bridge picked it up within 10 minutes)
--   jarvis_bridges   each bridge's last check-in (so Jarvis can say "the Mac
--                    is offline" instead of waiting)
--
-- The tables are reachable only through the jarvis_* functions below.
-- =====================================================================

create table if not exists public.jarvis_commands (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  created_email text not null default '',
  target       text not null default 'mac',
  action       text not null,
  args         jsonb not null default '{}'::jsonb,
  status       text not null default 'queued',
  claimed_by   text,
  claimed_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb,
  error        text,
  constraint jarvis_commands_action check (action ~ '^[a-z0-9_.:-]{1,64}$'),
  constraint jarvis_commands_target check (target ~ '^[a-z0-9_.-]{1,40}$'),
  constraint jarvis_commands_args check (jsonb_typeof(args) = 'object' and length(args::text) <= 8000),
  constraint jarvis_commands_status check (status in ('queued', 'running', 'done', 'failed', 'expired'))
);
create index if not exists jarvis_commands_queue on public.jarvis_commands (target, status, id);

create table if not exists public.jarvis_bridges (
  name     text primary key,
  seen_at  timestamptz not null default now(),
  email    text not null default '',
  info     jsonb not null default '{}'::jsonb
);

alter table public.jarvis_commands enable row level security;
alter table public.jarvis_bridges enable row level security;
revoke all on public.jarvis_commands from public, anon, authenticated;
revoke all on public.jarvis_bridges from public, anon, authenticated;


-- ---------------------------------------------------------------------
-- Jarvis (the app): send a command, read it back, see the bridges
-- ---------------------------------------------------------------------
create or replace function public.jarvis_send(p_action text, p_args jsonb default '{}'::jsonb, p_target text default 'mac')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform jarvis_assert_member();
  insert into jarvis_commands (action, args, target, created_email)
  values (lower(btrim(p_action)), coalesce(p_args, '{}'::jsonb), lower(btrim(coalesce(p_target, 'mac'))),
          coalesce(auth.jwt() ->> 'email', ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.jarvis_command(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform jarvis_assert_member();
  select jsonb_build_object('id', c.id, 'action', c.action, 'args', c.args, 'target', c.target,
                            'status', c.status, 'created_at', c.created_at, 'claimed_at', c.claimed_at,
                            'finished_at', c.finished_at, 'result', c.result, 'error', c.error)
    into v from jarvis_commands c where c.id = p_id;
  return v;
end $$;

create or replace function public.jarvis_bridges_list()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform jarvis_assert_member();
  return coalesce((select jsonb_agg(jsonb_build_object('name', b.name, 'seen_at', b.seen_at, 'info', b.info,
                                                        'online', b.seen_at > now() - interval '45 seconds')
                                    order by b.name)
                   from jarvis_bridges b), '[]'::jsonb);
end $$;


-- ---------------------------------------------------------------------
-- The bridge (on the Mac): check in + take the next command, then finish it
-- ---------------------------------------------------------------------
create or replace function public.jarvis_bridge_poll(p_name text default 'mac', p_info jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text := lower(btrim(coalesce(p_name, 'mac')));
  v jarvis_commands;
begin
  perform jarvis_assert_member();
  if v_name !~ '^[a-z0-9_.-]{1,40}$' then
    raise exception 'Bridge name: letters, digits, dot, dash or underscore (up to 40).';
  end if;
  insert into jarvis_bridges (name, seen_at, email, info)
  values (v_name, now(), coalesce(auth.jwt() ->> 'email', ''), coalesce(p_info, '{}'::jsonb))
  on conflict (name) do update set seen_at = now(), email = excluded.email, info = excluded.info;

  -- housekeeping: a request nobody picked up in 10 minutes is stale (the
  -- owner shouldn't find the monitor starting hours later); one that has been
  -- "running" for 15 minutes lost its bridge; finished ones go after 7 days
  update jarvis_commands set status = 'expired', finished_at = now(),
         error = 'No bridge picked this up within 10 minutes.'
   where target = v_name and status = 'queued' and created_at < now() - interval '10 minutes';
  update jarvis_commands set status = 'failed', finished_at = now(),
         error = 'The bridge stopped before it finished.'
   where target = v_name and status = 'running' and claimed_at < now() - interval '15 minutes';
  delete from jarvis_commands where created_at < now() - interval '7 days';

  select * into v from jarvis_commands
   where target = v_name and status = 'queued'
   order by id limit 1
   for update skip locked;
  if v.id is null then return null; end if;
  update jarvis_commands set status = 'running', claimed_by = v_name, claimed_at = now() where id = v.id;
  return jsonb_build_object('id', v.id, 'action', v.action, 'args', v.args, 'created_at', v.created_at,
                            'created_email', v.created_email);
end $$;

create or replace function public.jarvis_bridge_finish(p_id bigint, p_ok boolean, p_result jsonb default null, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform jarvis_assert_member();
  update jarvis_commands
     set status = case when p_ok then 'done' else 'failed' end,
         finished_at = now(),
         result = p_result,
         error = left(p_error, 2000)
   where id = p_id and status = 'running';
end $$;

do $$
declare f text;
begin
  foreach f in array array['jarvis_send(text, jsonb, text)', 'jarvis_command(bigint)', 'jarvis_bridges_list()',
                           'jarvis_bridge_poll(text, jsonb)', 'jarvis_bridge_finish(bigint, boolean, jsonb, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
