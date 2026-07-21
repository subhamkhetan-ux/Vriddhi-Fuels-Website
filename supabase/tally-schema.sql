-- =====================================================================
-- VRIDDHI FUELS — Tally Voucher App schema
-- Run this in the SQL Editor of a DEDICATED Supabase project (separate
-- from the indent-app project). Safe to re-run.
--
-- Design:
--  * All signed-in employees share one live dataset (vouchers, parties,
--    series counters, prices) — changes appear on every device instantly
--    via Supabase realtime.
--  * Invoice numbers are assigned SERVER-SIDE inside an advisory lock, so
--    two employees saving at the same moment can never get the same number.
--    Numbers are gap-free: the next number is the smallest unused number
--    above the per-series baseline; deleting a voucher (or moving it to a
--    different series while editing) frees its number for reuse.
--  * Clients get read-only table access; every write goes through a
--    SECURITY DEFINER function that validates and audits the change.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.tally_settings (
  id         int     primary key default 1 check (id = 1),
  company    text    not null default 'VRIDDHI FUELS (2026-27)',
  auto_clear boolean not null default false  -- clear vouchers older than 2 days on open
);
-- add the column if an earlier version of this table already exists
alter table public.tally_settings add column if not exists auto_clear boolean not null default false;

create table if not exists public.tally_series (
  key      text primary key check (key in ('hsd','ms','xg')),
  baseline text not null,          -- "last invoice number used" (import/Settings)
  rate     numeric(10,2) not null  -- today's price ₹/LTR
);

create table if not exists public.tally_parties (
  name            text primary key,
  gstin           text,   -- party GST details (from the Master import) so
  reg_type        text,   -- exported vouchers carry correct GST information
  state           text,
  place_of_supply text,
  pincode         text,
  country         text
);
-- add the columns if an earlier version of this table already exists
alter table public.tally_parties add column if not exists gstin           text;
alter table public.tally_parties add column if not exists reg_type        text;
alter table public.tally_parties add column if not exists state           text;
alter table public.tally_parties add column if not exists place_of_supply text;
alter table public.tally_parties add column if not exists pincode         text;
alter table public.tally_parties add column if not exists country         text;

create table if not exists public.tally_vouchers (
  id          uuid primary key default gen_random_uuid(),
  series      text not null references public.tally_series(key),
  number      text not null,
  date        date not null,
  party       text not null,
  vehicle     text not null default '',
  qty         numeric(14,3) not null,
  rate        numeric(10,2) not null,
  item_amt    numeric(14,2) not null,
  party_amt   numeric(14,2) not null,
  roff        numeric(8,2)  not null default 0,
  status      text not null default 'pending'
              check (status in ('pending','exported','history')),
  source      text not null default 'app' check (source in ('app','tally')),
  exported_at timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (series, number)
);

create index if not exists tally_vouchers_status_idx on public.tally_vouchers(status);
create index if not exists tally_vouchers_series_idx on public.tally_vouchers(series);
create index if not exists tally_vouchers_date_idx   on public.tally_vouchers(date desc);

-- Seed (values verified from the client's real daybook, Apr–Jul 2026)
insert into public.tally_settings (id) values (1) on conflict do nothing;
insert into public.tally_series (key, baseline, rate) values
  ('hsd', '1639',  100.74),
  ('ms',  'MS319', 109.01),
  ('xg',  'XG6',   106.34)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Row Level Security: signed-in users can read everything; no direct
-- writes (all mutations go through the RPCs below, which run as owner).
-- (Roles exist on Supabase already; created here only when the schema is
-- loaded into a plain Postgres, e.g. for testing.)
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

alter table public.tally_settings enable row level security;
alter table public.tally_series   enable row level security;
alter table public.tally_parties  enable row level security;
alter table public.tally_vouchers enable row level security;

drop policy if exists tally_settings_read on public.tally_settings;
create policy tally_settings_read on public.tally_settings
  for select to authenticated using (true);
drop policy if exists tally_series_read on public.tally_series;
create policy tally_series_read on public.tally_series
  for select to authenticated using (true);
drop policy if exists tally_parties_read on public.tally_parties;
create policy tally_parties_read on public.tally_parties
  for select to authenticated using (true);
drop policy if exists tally_vouchers_read on public.tally_vouchers;
create policy tally_vouchers_read on public.tally_vouchers
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

create or replace function public._tally_auth() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
end $$;

-- numeric part of an invoice number ('MS319' -> 319); -1 when none
create or replace function public._tally_numpart(n text) returns bigint
language sql immutable as $$
  select coalesce(nullif(substring(coalesce(n,'') from '(\d+)\s*$'), '')::bigint, -1)
$$;

-- Next free number for a series: smallest unused number above the baseline,
-- preserving the baseline's prefix and zero-padding. Caller must hold the
-- per-series advisory lock.
create or replace function public._tally_next_number(s text) returns text
language plpgsql security definer set search_path = public as $$
declare
  base   text;
  pfx    text;
  digits text;
  n      bigint;
  cand   text;
begin
  select baseline into base from tally_series where key = s;
  if base is null then
    raise exception 'Unknown series %', s;
  end if;
  digits := substring(base from '(\d+)\s*$');
  if digits is null then
    return base || '1';
  end if;
  pfx := regexp_replace(base, '\d+\s*$', '');
  n := digits::bigint;
  loop
    n := n + 1;
    cand := pfx || case when length(n::text) < length(digits)
                        then lpad(n::text, length(digits), '0')
                        else n::text end;
    exit when not exists (select 1 from tally_vouchers where series = s and number = cand);
  end loop;
  return cand;
end $$;

-- Advance a series' baseline to the highest number among the given voucher
-- ids, so exported/cleared numbers are never handed out again.
create or replace function public._tally_bump_baselines(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  update tally_series ts set baseline = best.number
  from (
    select distinct on (series) series, number
    from tally_vouchers
    where id = any(p_ids)
    order by series, _tally_numpart(number) desc
  ) best
  where ts.key = best.series
    and _tally_numpart(best.number) > _tally_numpart(ts.baseline);
end $$;

-- ---------------------------------------------------------------------
-- RPCs (the client's only write path)
-- ---------------------------------------------------------------------

-- Create (p_id null) or edit (p_id set) a voucher. Numbers are assigned
-- here, atomically; an edited voucher keeps its number unless the series
-- changed; edits always return the voucher to 'pending'.
create or replace function public.tally_save_voucher(
  p_id uuid, p_series text, p_date date, p_party text, p_vehicle text,
  p_qty numeric, p_rate numeric, p_item_amt numeric, p_party_amt numeric,
  p_roff numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v   tally_vouchers;
  num text;
  rid uuid;
begin
  perform _tally_auth();
  if coalesce(p_party,'') = '' then raise exception 'Party is required'; end if;
  if p_qty is null  or p_qty  <= 0 then raise exception 'Quantity must be positive'; end if;
  if p_rate is null or p_rate <= 0 then raise exception 'Rate must be positive'; end if;
  if p_item_amt is null or p_item_amt <= 0 then raise exception 'Amount must be positive'; end if;
  if abs(p_party_amt - (p_item_amt + coalesce(p_roff,0))) > 0.011 then
    raise exception 'Totals do not balance';
  end if;

  perform pg_advisory_xact_lock(hashtext('tally_series_' || p_series));

  if p_id is null then
    num := _tally_next_number(p_series);
    insert into tally_vouchers
      (series, number, date, party, vehicle, qty, rate, item_amt, party_amt, roff, created_by)
    values
      (p_series, num, p_date, p_party, coalesce(p_vehicle,''), p_qty, p_rate,
       p_item_amt, p_party_amt, coalesce(p_roff,0), auth.uid())
    returning id into rid;
    -- today's price is set only via Settings / daybook import, never as a
    -- side effect of saving a voucher (a customer's own rate must not move
    -- the shared default price)
  else
    select * into v from tally_vouchers
      where id = p_id and status in ('pending','exported') for update;
    if not found then
      raise exception 'Voucher not found or no longer editable';
    end if;
    if v.series = p_series then num := v.number;
    else num := _tally_next_number(p_series);
    end if;
    update tally_vouchers set
      series = p_series, number = num, date = p_date, party = p_party,
      vehicle = coalesce(p_vehicle,''), qty = p_qty, rate = p_rate,
      item_amt = p_item_amt, party_amt = p_party_amt, roff = coalesce(p_roff,0),
      status = 'pending', exported_at = null, updated_at = now()
    where id = p_id;
    rid := p_id;
  end if;

  -- inline-added parties become part of the shared list
  insert into tally_parties (name) values (p_party) on conflict do nothing;

  return jsonb_build_object('id', rid, 'number', num);
end $$;

-- A voucher can be deleted while it is still pending or exported (not once
-- moved to history). Its number is not reused unless it was never exported.
create or replace function public.tally_delete_voucher(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _tally_auth();
  delete from tally_vouchers where id = p_id and status in ('pending','exported');
  if not found then
    raise exception 'Voucher not found or already moved to old vouchers';
  end if;
end $$;

-- Exports are whole-day and repeatable: marking updates the timestamp on
-- every included voucher, whether or not it was exported before. The
-- baseline advances so these numbers are permanently reserved.
create or replace function public.tally_mark_exported(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _tally_auth();
  update tally_vouchers set status = 'exported', exported_at = now(), updated_at = now()
    where id = any(p_ids) and status in ('pending','exported');
  get diagnostics n = row_count;
  perform _tally_bump_baselines(p_ids);
  return n;
end $$;

drop function if exists public.tally_clear_exported();

-- Optional cleanup after a day is confirmed imported in Tally: move that
-- day's app vouchers to old vouchers. Numbers are reserved (baseline bumped).
create or replace function public.tally_move_day(p_date date) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _tally_auth();
  perform _tally_bump_baselines(array(
    select id from tally_vouchers where date = p_date and status in ('pending','exported')));
  update tally_vouchers set status = 'history', updated_at = now()
    where date = p_date and status in ('pending','exported');
  get diagnostics n = row_count;
  return n;
end $$;

-- Auto-clear: remove vouchers dated before the cutoff, reserving their
-- numbers first so they are never reused.
create or replace function public.tally_autoclear(p_cutoff date) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _tally_auth();
  perform _tally_bump_baselines(array(select id from tally_vouchers where date < p_cutoff));
  delete from tally_vouchers where date < p_cutoff;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.tally_set_autoclear(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _tally_auth();
  update tally_settings set auto_clear = coalesce(p_on, false) where id = 1;
end $$;

-- Danger zone: clear ALL vouchers (numbering baselines are kept so the next
-- number continues where Tally left off).
create or replace function public.tally_reset_vouchers() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _tally_auth();
  perform _tally_bump_baselines(array(select id from tally_vouchers));
  delete from tally_vouchers;
  get diagnostics n = row_count;
  return n;
end $$;

-- Danger zone: clear the whole customer list.
create or replace function public.tally_reset_parties() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _tally_auth();
  delete from tally_parties;
  get diagnostics n = row_count;
  return n;
end $$;

-- Bulk-load parsed daybook vouchers (source='tally', status='history').
-- Duplicates (same series+number) are skipped; baselines advance to the
-- highest number seen; rates follow the latest voucher per series.
create or replace function public.tally_import_daybook(p_vouchers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r        jsonb;
  added    jsonb := '{"hsd":0,"ms":0,"xg":0}'::jsonb;
  dupes    int := 0;
  sk       text;
  new_p    int := 0;
  best     text;
begin
  perform _tally_auth();

  for r in select * from jsonb_array_elements(coalesce(p_vouchers,'[]'::jsonb)) loop
    sk := r->>'seriesKey';
    if sk not in ('hsd','ms','xg') then continue; end if;
    begin
      insert into tally_vouchers
        (series, number, date, party, vehicle, qty, rate, item_amt, party_amt, roff,
         status, source, created_by)
      values
        (sk, r->>'number', (r->>'dateISO')::date, r->>'party',
         coalesce(r->>'vehicle',''), (r->>'qty')::numeric, (r->>'rate')::numeric,
         (r->>'amount')::numeric, (r->>'amount')::numeric, 0,
         'history', 'tally', auth.uid());
      added := jsonb_set(added, array[sk], to_jsonb((added->>sk)::int + 1));
      if not exists (select 1 from tally_parties where name = r->>'party') then
        insert into tally_parties (name) values (r->>'party') on conflict do nothing;
        new_p := new_p + 1;
      end if;
    exception when unique_violation then
      dupes := dupes + 1;
    end;
  end loop;

  -- advance baselines to the highest number now present
  for sk in select key from tally_series loop
    select number into best from tally_vouchers
      where series = sk order by _tally_numpart(number) desc limit 1;
    if best is not null then
      update tally_series set baseline = best
        where key = sk and _tally_numpart(baseline) < _tally_numpart(best);
    end if;
  end loop;

  -- today's price = rate of the latest voucher per series in this file
  update tally_series ts set rate = latest.rate
  from (
    select distinct on (x->>'seriesKey')
           x->>'seriesKey' as key, (x->>'rate')::numeric as rate
    from jsonb_array_elements(coalesce(p_vouchers,'[]'::jsonb)) x
    where (x->>'rate')::numeric > 0
    order by x->>'seriesKey', (x->>'dateISO')::date desc, _tally_numpart(x->>'number') desc
  ) latest
  where ts.key = latest.key;

  return jsonb_build_object('added', added, 'dupes', dupes, 'newParties', new_p);
end $$;

drop function if exists public.tally_import_master(text[]);

-- Additive merge: add the master's Sundry Debtors that are not already in the
-- list; existing customers are never removed (re-upload only adds new ones).
-- GST details are refreshed for every debtor in the file, existing included.
-- p_parties: jsonb array of {name, gstin, regType, state, place, pincode, country}
create or replace function public.tally_import_master(p_parties jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare added int;
begin
  perform _tally_auth();
  if p_parties is null or jsonb_array_length(p_parties) = 0 then
    raise exception 'No customers in list';
  end if;

  with src as (
    select distinct on (x->>'name')
      x->>'name' as name, nullif(x->>'gstin','') as gstin,
      nullif(x->>'regType','') as reg_type, nullif(x->>'state','') as state,
      nullif(x->>'place','') as place_of_supply,
      nullif(x->>'pincode','') as pincode, nullif(x->>'country','') as country
    from jsonb_array_elements(p_parties) x
    where coalesce(x->>'name','') <> ''
  ), ins as (
    insert into tally_parties as tp (name, gstin, reg_type, state, place_of_supply, pincode, country)
      select name, gstin, reg_type, state, place_of_supply, pincode, country from src
    on conflict (name) do update set
      gstin = excluded.gstin, reg_type = excluded.reg_type, state = excluded.state,
      place_of_supply = excluded.place_of_supply, pincode = excluded.pincode,
      country = excluded.country
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into added from ins;

  return jsonb_build_object('added', added, 'removed', 0,
    'total', (select count(*) from tally_parties));
end $$;

create or replace function public.tally_add_party(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _tally_auth();
  if coalesce(trim(p_name),'') = '' then raise exception 'Name required'; end if;
  insert into tally_parties (name) values (trim(p_name)) on conflict do nothing;
end $$;

create or replace function public.tally_remove_party(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _tally_auth();
  delete from tally_parties where name = p_name;
end $$;

create or replace function public.tally_save_settings(p_company text, p_series jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare sk text;
begin
  perform _tally_auth();
  if coalesce(trim(p_company),'') = '' then raise exception 'Company required'; end if;
  update tally_settings set company = trim(p_company) where id = 1;
  for sk in select key from tally_series loop
    if p_series ? sk then
      if coalesce(trim(p_series->sk->>'last'),'') = '' then
        raise exception 'Last invoice number required for %', sk;
      end if;
      if (p_series->sk->>'rate')::numeric <= 0 then
        raise exception 'Price must be positive for %', sk;
      end if;
      update tally_series
        set baseline = trim(p_series->sk->>'last'),
            rate = (p_series->sk->>'rate')::numeric
        where key = sk;
    end if;
  end loop;
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
      public.tally_save_voucher(uuid, text, date, text, text, numeric, numeric, numeric, numeric, numeric),
      public.tally_delete_voucher(uuid),
      public.tally_mark_exported(uuid[]),
      public.tally_move_day(date),
      public.tally_autoclear(date),
      public.tally_set_autoclear(boolean),
      public.tally_reset_vouchers(),
      public.tally_reset_parties(),
      public.tally_import_daybook(jsonb),
      public.tally_import_master(jsonb),
      public.tally_add_party(text),
      public.tally_remove_party(text),
      public.tally_save_settings(text, jsonb)
    to authenticated;
  end if;
end $$;

-- Realtime: broadcast changes on all four tables (safe to re-run).
do $$
begin
  begin
    alter publication supabase_realtime add table public.tally_vouchers;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.tally_parties;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.tally_series;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.tally_settings;
  exception when others then null;
  end;
end $$;
