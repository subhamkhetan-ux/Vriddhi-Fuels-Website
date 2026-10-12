-- =====================================================================
-- Vriddhi Fuels — Jarvis (/jarvis/) — its own Supabase project
-- ---------------------------------------------------------------------
-- Jarvis keeps the apps' data in the apps' own projects (it reads and
-- writes them directly). This project only holds what is Jarvis's own, so
-- it follows the owner from phone to computer:
--   jarvis_members  who may use Jarvis (the first login to claim it is the
--                   owner; more with jarvis_add_member in the SQL Editor)
--   jarvis_state    per login: settings, the recent conversation and the
--                   built-in brain's memory of it
-- Everything is reached through the jarvis_* functions below; the tables
-- themselves are closed. Safe to run again.
-- (The Mac command queue is separate: jarvis-mac-schema.sql, optional.)
-- =====================================================================

create table if not exists public.jarvis_members (
  user_id  uuid primary key,
  email    text not null default '',
  owner    boolean not null default false,
  added_at timestamptz not null default now()
);

create table if not exists public.jarvis_state (
  user_id    uuid primary key,
  settings   jsonb not null default '{}'::jsonb,
  history    jsonb not null default '[]'::jsonb,
  memory     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint jarvis_state_size check (length(settings::text) + length(history::text) + length(memory::text) <= 400000)
);

alter table public.jarvis_members enable row level security;
alter table public.jarvis_state enable row level security;
revoke all on public.jarvis_members from public, anon, authenticated;
revoke all on public.jarvis_state from public, anon, authenticated;

create or replace function public.jarvis_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from public.jarvis_members m where m.user_id = auth.uid());
$$;

create or replace function public.jarvis_assert_member()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.jarvis_is_member() then
    raise exception 'This login is not on the Jarvis members list.'
      using errcode = '42501',
            hint = 'In the SQL Editor run: select jarvis_add_member(''their login email'');';
  end if;
end $$;

-- who am I, and does Jarvis have an owner yet?
create or replace function public.jarvis_whoami()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('user_id', auth.uid(),
                            'email', coalesce(auth.jwt() ->> 'email', ''),
                            'member', public.jarvis_is_member(),
                            'has_owner', exists (select 1 from public.jarvis_members));
$$;

-- The first login to ask becomes the owner. Once there is an owner nobody
-- else can claim — more people are added with jarvis_add_member.
create or replace function public.jarvis_claim_owner()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  lock table public.jarvis_members in exclusive mode;
  if exists (select 1 from public.jarvis_members) then
    if public.jarvis_is_member() then return public.jarvis_whoami(); end if;
    raise exception 'Jarvis already has an owner. Ask them to add this login.' using errcode = '42501';
  end if;
  insert into public.jarvis_members (user_id, email, owner)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), true);
  return public.jarvis_whoami();
end $$;

-- SQL Editor only: allow / remove a login.
create or replace function public.jarvis_add_member(p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text;
begin
  select u.id, u.email into v_id, v_email from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
  if v_id is null then return 'No login with that email yet. Create it under Authentication → Users first.'; end if;
  insert into public.jarvis_members (user_id, email) values (v_id, v_email)
  on conflict (user_id) do update set email = excluded.email;
  return 'Added ' || v_email || ' to Jarvis.';
end $$;

create or replace function public.jarvis_remove_member(p_email text)
returns text language plpgsql security definer set search_path = public as $$
begin
  delete from public.jarvis_members where lower(email) = lower(btrim(p_email));
  if not found then return 'That email was not on the list.'; end if;
  return 'Removed ' || btrim(p_email) || ' from Jarvis.';
end $$;

-- ---- the state that follows the owner across devices -------------------------
create or replace function public.jarvis_state_get()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform jarvis_assert_member();
  select jsonb_build_object('settings', s.settings, 'history', s.history, 'memory', s.memory, 'updated_at', s.updated_at)
    into v from jarvis_state s where s.user_id = auth.uid();
  return coalesce(v, jsonb_build_object('settings', '{}'::jsonb, 'history', '[]'::jsonb, 'memory', '{}'::jsonb, 'updated_at', null));
end $$;

-- p_patch: any of {settings, history, memory}; each given part replaces the saved one
create or replace function public.jarvis_state_save(p_patch jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_at timestamptz := now();
begin
  perform jarvis_assert_member();
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'Bad state.'; end if;
  if p_patch ? 'history' and jsonb_typeof(p_patch -> 'history') <> 'array' then raise exception 'history must be a list.'; end if;
  insert into jarvis_state (user_id, settings, history, memory, updated_at)
  values (auth.uid(), coalesce(p_patch -> 'settings', '{}'::jsonb), coalesce(p_patch -> 'history', '[]'::jsonb),
          coalesce(p_patch -> 'memory', '{}'::jsonb), v_at)
  on conflict (user_id) do update set
    settings = case when p_patch ? 'settings' then p_patch -> 'settings' else jarvis_state.settings end,
    history  = case when p_patch ? 'history'  then p_patch -> 'history'  else jarvis_state.history end,
    memory   = case when p_patch ? 'memory'   then p_patch -> 'memory'   else jarvis_state.memory end,
    updated_at = v_at;
  return v_at;
end $$;

do $$
declare f text;
begin
  -- the app's calls: every one checks the caller is a member (or, for the
  -- claim, that Jarvis has no owner yet)
  foreach f in array array['jarvis_whoami()', 'jarvis_claim_owner()', 'jarvis_state_get()', 'jarvis_state_save(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- helpers used inside the functions above, and the SQL Editor's own
  foreach f in array array['jarvis_is_member()', 'jarvis_assert_member()', 'jarvis_add_member(text)', 'jarvis_remove_member(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
