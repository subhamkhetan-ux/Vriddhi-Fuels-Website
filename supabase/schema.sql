-- =====================================================================
-- Vriddhi Fuels — Indent Management: Postgres schema for Supabase
-- =====================================================================
-- Design principles (see requirements §4, §6):
--   * Server-side timestamps only (DEFAULT now(), never trust client clock).
--   * Append-only audit log: no UPDATE/DELETE allowed, even for admins.
--   * All mutations go through SECURITY DEFINER RPCs so that permission
--     checks and audit writes ALWAYS happen atomically in one transaction.
--   * Reads are governed by RLS SELECT policies (customer sees own only).
--
-- Run this whole file once in the Supabase SQL editor (or via `supabase db
-- push`). Safe to re-run: it is written to be idempotent where practical.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
do $$ begin
  create type user_role     as enum ('customer','employee','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type product_type  as enum ('Petrol','Diesel','XtraGreen');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_type    as enum ('Litres','Amount');
exception when duplicate_object then null; end $$;

do $$ begin
  create type indent_status as enum ('Awaiting','Pending','Delivered','Cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type audit_event   as enum ('created','approved','rejected','modified',
                                     'cancelled','delivered','statement_sent',
                                     'statement_acknowledged','statement_disputed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- Profile table mirrors auth.users (1:1). id == auth.users.id.
-- Login identity is `username` (a handle the admin gives the customer);
-- `phone` is now just optional contact info.
create table if not exists public.app_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,          -- login handle, e.g. rajfleet01
  name        text not null,
  phone       text unique,                   -- optional contact number
  role        user_role not null default 'customer',
  is_blocked  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Saved vehicles per customer (quick-pick). §9.3
create table if not exists public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.app_users(id) on delete cascade,
  vehicle_no  text not null,                 -- stored normalized (uppercase-hyphenated)
  created_at  timestamptz not null default now(),
  unique (customer_id, vehicle_no)
);

-- Human-readable sequential indent code: IND-0001, IND-0002, ...
create sequence if not exists public.indent_code_seq;

create table if not exists public.indents (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- IND-0001
  customer_id uuid not null references public.app_users(id),
  created_by  uuid not null references public.app_users(id),
  vehicle_no  text not null,
  product     product_type not null,
  order_type  order_type   not null,
  value       numeric(12,2) not null check (value > 0),
  status      indent_status not null,
  handled_by  uuid references public.app_users(id),
  handled_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_indents_customer on public.indents(customer_id);
create index if not exists idx_indents_status   on public.indents(status);
create index if not exists idx_indents_created  on public.indents(created_at desc);

-- Append-only audit log — THE proof engine. §4, §6.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  indent_id   uuid references public.indents(id),
  event       audit_event not null,
  actor_id    uuid references public.app_users(id),
  actor_role  user_role,
  before      jsonb,
  after       jsonb,
  note        text,                          -- e.g. "Amount changed 3000 -> 2500"
  user_agent  text,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_indent on public.audit_log(indent_id, created_at);

-- Monthly statements sent to customers. §5.4
create table if not exists public.statements (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.app_users(id),
  period_month  int  not null,               -- 1..12
  period_year   int  not null,
  indent_ids    uuid[] not null default '{}',
  total_litres  numeric(12,2) not null default 0,
  total_amount  numeric(12,2) not null default 0,
  sent_at       timestamptz not null default now(),
  ack_status    text not null default 'pending', -- pending | confirmed | disputed
  ack_at        timestamptz,
  unique (customer_id, period_month, period_year)
);

-- Single-row business settings. §5.4 Settings screen.
create table if not exists public.settings (
  id            int primary key default 1 check (id = 1),
  business_name text not null default 'Vriddhi Fuels',
  products      text[] not null default array['Petrol','Diesel','XtraGreen'],
  summary_time  text not null default '21:00',   -- IST HH:MM for daily summary
  updated_at    timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------

-- Current caller's profile row (or null). Used by RLS + RPCs.
create or replace function public.me()
returns public.app_users
language sql stable security definer set search_path = public as $$
  select * from public.app_users where id = auth.uid();
$$;

create or replace function public.my_role()
returns user_role
language sql stable security definer set search_path = public as $$
  select role from public.app_users where id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('employee','admin')
                   from public.app_users where id = auth.uid()), false);
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin'
                   from public.app_users where id = auth.uid()), false);
$$;

-- Normalize an Indian vehicle number to UPPERCASE-HYPHENATED. §4
--   e.g. "wb 12 ab 1234" / "WB12AB1234" -> "WB-12-AB-1234"
create or replace function public.normalize_vehicle(v text)
returns text
language plpgsql immutable as $$
declare
  m text[];
begin
  if v is null then return null; end if;
  v := upper(regexp_replace(v, '[^A-Za-z0-9]', '', 'g'));
  m := regexp_match(v, '^([A-Z]{2})([0-9]{1,2})([A-Z]{1,3})([0-9]{1,4})$');
  if m is null then
    -- Not a recognised pattern: return the cleaned form, caller may still reject.
    return v;
  end if;
  return m[1] || '-' || m[2] || '-' || m[3] || '-' || m[4];
end $$;

create or replace function public.is_valid_vehicle(v text)
returns boolean
language sql immutable as $$
  select upper(regexp_replace(coalesce(v,''), '[^A-Za-z0-9]', '', 'g'))
         ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{1,4}$';
$$;

-- Write one audit row. Called only from SECURITY DEFINER RPCs below.
create or replace function public._audit(
  p_indent uuid, p_event audit_event, p_before jsonb, p_after jsonb,
  p_note text, p_ua text, p_ip text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log(indent_id, event, actor_id, actor_role,
                               before, after, note, user_agent, ip)
  values (p_indent, p_event, auth.uid(), public.my_role(),
          p_before, p_after, p_note, p_ua, p_ip);
end $$;

-- ---------------------------------------------------------------------
-- Mutation RPCs (all SECURITY DEFINER; enforce permissions + audit)
-- ---------------------------------------------------------------------

-- Place an indent.
--   p_customer null  -> self-service (customer or staff ordering for self)
--   p_customer set   -> staff logging on behalf; result status = 'Awaiting'
create or replace function public.place_indent(
  p_vehicle text, p_product product_type, p_order_type order_type,
  p_value numeric, p_customer uuid default null,
  p_ua text default null, p_ip text default null)
returns public.indents
language plpgsql security definer set search_path = public as $$
declare
  caller public.app_users := public.me();
  target uuid;
  on_behalf boolean;
  new_status indent_status;
  veh text;
  rec public.indents;
begin
  if caller.id is null then raise exception 'Not authenticated'; end if;
  if not caller.is_active then raise exception 'Account is inactive'; end if;

  on_behalf := p_customer is not null and p_customer <> caller.id;

  if on_behalf then
    -- Only the admin/owner may log on behalf; employees cannot create indents.
    if caller.role <> 'admin' then
      raise exception 'Only the owner can log an indent on behalf of a customer';
    end if;
    target := p_customer;
    new_status := 'Awaiting';                 -- needs customer approval
  else
    -- Self-service placement is for customers only.
    if caller.role <> 'customer' then
      raise exception 'Only customers can place their own indent';
    end if;
    target := caller.id;
    -- Blocked customers cannot place. §4 Blocked customers
    if caller.is_blocked then
      raise exception 'Your account is blocked. Please contact us.';
    end if;
    new_status := 'Pending';                  -- self-placed = confirmed
  end if;

  if p_value is null or p_value <= 0 then raise exception 'Value must be > 0'; end if;
  -- Vehicle number is optional. If given, it must be valid; if blank, store null.
  if p_vehicle is null or btrim(p_vehicle) = '' then
    veh := null;
  elsif not public.is_valid_vehicle(p_vehicle) then
    raise exception 'Invalid vehicle number: %', p_vehicle;
  else
    veh := public.normalize_vehicle(p_vehicle);
  end if;

  insert into public.indents(code, customer_id, created_by, vehicle_no,
                             product, order_type, value, status)
  values ('IND-' || lpad(nextval('public.indent_code_seq')::text, 4, '0'),
          target, caller.id, veh, p_product, p_order_type, p_value, new_status)
  returning * into rec;

  -- Remember the vehicle for the customer's quick-pick list (only if given).
  if veh is not null then
    insert into public.vehicles(customer_id, vehicle_no)
    values (target, veh) on conflict do nothing;
  end if;

  perform public._audit(rec.id, 'created', null, to_jsonb(rec),
    case when on_behalf then 'Logged on behalf by staff (awaiting approval)'
         else 'Placed by customer' end, p_ua, p_ip);
  return rec;
end $$;

-- Customer approves an indent that staff logged on their behalf.
create or replace function public.approve_indent(
  p_id uuid, p_ua text default null, p_ip text default null)
returns public.indents
language plpgsql security definer set search_path = public as $$
declare caller public.app_users := public.me(); old public.indents; rec public.indents;
begin
  select * into old from public.indents where id = p_id;
  if old.id is null then raise exception 'Indent not found'; end if;
  if caller.id <> old.customer_id then raise exception 'You can only approve your own indent'; end if;
  if caller.is_blocked then raise exception 'Your account is blocked. Please contact us.'; end if;
  if old.status <> 'Awaiting' then raise exception 'Indent is not awaiting approval'; end if;

  update public.indents set status='Pending', updated_at=now()
    where id = p_id returning * into rec;
  perform public._audit(p_id, 'approved', to_jsonb(old), to_jsonb(rec),
    'Customer approved', p_ua, p_ip);
  return rec;
end $$;

create or replace function public.reject_indent(
  p_id uuid, p_ua text default null, p_ip text default null)
returns public.indents
language plpgsql security definer set search_path = public as $$
declare caller public.app_users := public.me(); old public.indents; rec public.indents;
begin
  select * into old from public.indents where id = p_id;
  if old.id is null then raise exception 'Indent not found'; end if;
  if caller.id <> old.customer_id then raise exception 'You can only reject your own indent'; end if;
  if old.status <> 'Awaiting' then raise exception 'Indent is not awaiting approval'; end if;

  update public.indents set status='Cancelled', handled_by=caller.id, handled_at=now(),
    updated_at=now() where id = p_id returning * into rec;
  perform public._audit(p_id, 'rejected', to_jsonb(old), to_jsonb(rec),
    'Customer rejected', p_ua, p_ip);
  return rec;
end $$;

-- Cancel an open indent (Awaiting or Pending).
--   customer: own only.  admin: any open.  employees CANNOT cancel.
create or replace function public.cancel_indent(
  p_id uuid, p_ua text default null, p_ip text default null)
returns public.indents
language plpgsql security definer set search_path = public as $$
declare caller public.app_users := public.me(); old public.indents; rec public.indents;
begin
  select * into old from public.indents where id = p_id;
  if old.id is null then raise exception 'Indent not found'; end if;
  if old.status not in ('Awaiting','Pending') then raise exception 'Only open indents can be cancelled'; end if;
  if caller.role = 'customer' then
    if caller.id <> old.customer_id then raise exception 'You can only cancel your own indent'; end if;
    if caller.is_blocked then raise exception 'Your account is blocked. Please contact us.'; end if;
  elsif caller.role <> 'admin' then
    raise exception 'Not permitted';   -- employees cannot cancel
  end if;

  update public.indents set status='Cancelled', handled_by=caller.id, handled_at=now(),
    updated_at=now() where id = p_id returning * into rec;
  perform public._audit(p_id, 'cancelled', to_jsonb(old), to_jsonb(rec),
    'Cancelled by ' || caller.role, p_ua, p_ip);
  return rec;
end $$;

-- Modify vehicle/product/order_type/value of an open indent.
create or replace function public.modify_indent(
  p_id uuid, p_vehicle text, p_product product_type, p_order_type order_type,
  p_value numeric, p_ua text default null, p_ip text default null)
returns public.indents
language plpgsql security definer set search_path = public as $$
declare
  caller public.app_users := public.me(); old public.indents; rec public.indents;
  veh text; note text;
begin
  select * into old from public.indents where id = p_id;
  if old.id is null then raise exception 'Indent not found'; end if;
  if old.status not in ('Awaiting','Pending') then raise exception 'Only open indents can be modified'; end if;
  if caller.role = 'customer' then
    if caller.id <> old.customer_id then raise exception 'You can only modify your own indent'; end if;
    if caller.is_blocked then raise exception 'Your account is blocked. Please contact us.'; end if;
  elsif caller.role not in ('employee','admin') then
    raise exception 'Not permitted';
  end if;
  if p_value is null or p_value <= 0 then raise exception 'Value must be > 0'; end if;
  -- Vehicle optional (see place_indent).
  if p_vehicle is null or btrim(p_vehicle) = '' then
    veh := null;
  elsif not public.is_valid_vehicle(p_vehicle) then
    raise exception 'Invalid vehicle number: %', p_vehicle;
  else
    veh := public.normalize_vehicle(p_vehicle);
  end if;

  note := 'Modified';
  if old.value <> p_value or old.order_type <> p_order_type then
    note := note || format('; %s %s -> %s %s',
      old.order_type, trim(to_char(old.value,'FM999999990.00')),
      p_order_type, trim(to_char(p_value,'FM999999990.00')));
  end if;
  if old.product <> p_product then note := note || format('; product %s -> %s', old.product, p_product); end if;
  if old.vehicle_no is distinct from veh then note := note || format('; vehicle %s -> %s', coalesce(old.vehicle_no,'—'), coalesce(veh,'—')); end if;

  update public.indents set vehicle_no=veh, product=p_product, order_type=p_order_type,
    value=p_value, updated_at=now() where id = p_id returning * into rec;
  perform public._audit(p_id, 'modified', to_jsonb(old), to_jsonb(rec), note, p_ua, p_ip);
  return rec;
end $$;

-- Drop the earlier 3-arg version so re-running doesn't leave an ambiguous overload.
drop function if exists public.deliver_indent(uuid, text, text);

-- Mark delivered (staff only). Delivery allowed from Awaiting too, but flagged.
-- p_delivered: the quantity/amount actually delivered, in the indent's own unit
-- (litres or ₹). NULL = fully delivered (uses the ordered value). A smaller
-- value = partial delivery; the invoice bills the delivered amount.
create or replace function public.deliver_indent(
  p_id uuid, p_delivered numeric default null,
  p_ua text default null, p_ip text default null)
returns public.indents
language plpgsql security definer set search_path = public as $$
declare caller public.app_users := public.me(); old public.indents; rec public.indents; note text; dv numeric;
begin
  if not public.is_staff() then raise exception 'Only staff can mark delivered'; end if;
  select * into old from public.indents where id = p_id;
  if old.id is null then raise exception 'Indent not found'; end if;
  if old.status not in ('Awaiting','Pending') then raise exception 'Indent is not open'; end if;

  dv := coalesce(p_delivered, old.value);
  if dv <= 0 then raise exception 'Delivered quantity must be > 0'; end if;

  if dv < old.value then
    note := format('Partially delivered: %s of %s %s',
      trim(to_char(dv,'FM999999990.00')), trim(to_char(old.value,'FM999999990.00')), old.order_type);
  else
    note := 'Delivered (full)';
  end if;
  if old.status = 'Awaiting' then
    note := note || ' — WITHOUT CUSTOMER APPROVAL (weaker proof)';  -- §6.6
  end if;

  update public.indents set status='Delivered', delivered_value=dv,
    handled_by=caller.id, handled_at=now(), updated_at=now()
    where id = p_id returning * into rec;
  perform public._audit(p_id, 'delivered', to_jsonb(old), to_jsonb(rec), note, p_ua, p_ip);
  perform public._create_invoice(p_id, false);   -- auto-generate the invoice
  return rec;
end $$;

-- Customer acknowledges / disputes a monthly statement. §5.4 / §6.5
create or replace function public.ack_statement(
  p_id uuid, p_confirm boolean, p_ua text default null, p_ip text default null)
returns public.statements
language plpgsql security definer set search_path = public as $$
declare caller public.app_users := public.me(); st public.statements;
begin
  select * into st from public.statements where id = p_id;
  if st.id is null then raise exception 'Statement not found'; end if;
  if caller.id <> st.customer_id then raise exception 'Not your statement'; end if;
  if st.ack_status <> 'pending' then raise exception 'Statement already resolved'; end if;

  update public.statements
    set ack_status = case when p_confirm then 'confirmed' else 'disputed' end,
        ack_at = now()
    where id = p_id returning * into st;
  perform public._audit(null,
    case when p_confirm then 'statement_acknowledged' else 'statement_disputed' end,
    null, to_jsonb(st),
    case when p_confirm then 'Customer confirmed statement' else 'Customer disputed statement' end,
    p_ua, p_ip);
  return st;
end $$;

-- Admin: block / unblock a customer. §5.4
create or replace function public.set_blocked(p_customer uuid, p_blocked boolean)
returns public.app_users
language plpgsql security definer set search_path = public as $$
declare rec public.app_users;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.app_users set is_blocked = p_blocked where id = p_customer returning * into rec;
  if rec.id is null then raise exception 'User not found'; end if;
  return rec;
end $$;

-- Admin: deactivate / reactivate an account. §5.4
create or replace function public.set_active(p_user uuid, p_active boolean)
returns public.app_users
language plpgsql security definer set search_path = public as $$
declare rec public.app_users;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  update public.app_users set is_active = p_active where id = p_user returning * into rec;
  if rec.id is null then raise exception 'User not found'; end if;
  return rec;
end $$;

-- Admin: generate + send a monthly statement for a customer. §5.4
create or replace function public.send_statement(
  p_customer uuid, p_month int, p_year int,
  p_ua text default null, p_ip text default null)
returns public.statements
language plpgsql security definer set search_path = public as $$
declare
  st public.statements; ids uuid[]; tl numeric; ta numeric;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;

  select coalesce(array_agg(id), '{}'),
         coalesce(sum(value) filter (where order_type='Litres'),0),
         coalesce(sum(value) filter (where order_type='Amount'),0)
    into ids, tl, ta
  from public.indents
  where customer_id = p_customer
    and status = 'Delivered'
    -- Attribute to the 6am-to-6am shift day: shift date = IST time minus 6h.
    and extract(month from ((created_at at time zone 'Asia/Kolkata') - interval '6 hours')) = p_month
    and extract(year  from ((created_at at time zone 'Asia/Kolkata') - interval '6 hours')) = p_year;

  insert into public.statements(customer_id, period_month, period_year,
                                indent_ids, total_litres, total_amount)
  values (p_customer, p_month, p_year, ids, tl, ta)
  on conflict (customer_id, period_month, period_year)
  do update set indent_ids = excluded.indent_ids,
                total_litres = excluded.total_litres,
                total_amount = excluded.total_amount,
                sent_at = now(), ack_status = 'pending', ack_at = null
  returning * into st;

  perform public._audit(null, 'statement_sent', null, to_jsonb(st),
    format('Statement %s/%s sent', p_month, p_year), p_ua, p_ip);
  return st;
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.app_users  enable row level security;
alter table public.vehicles   enable row level security;
alter table public.indents    enable row level security;
alter table public.audit_log  enable row level security;
alter table public.statements enable row level security;
alter table public.settings   enable row level security;

-- app_users: everyone reads own row; staff read all (needed to pick a customer).
drop policy if exists app_users_read on public.app_users;
create policy app_users_read on public.app_users for select
  using (id = auth.uid() or public.is_staff());

-- vehicles: customer reads own; staff read all (for on-behalf pick).
drop policy if exists vehicles_read on public.vehicles;
create policy vehicles_read on public.vehicles for select
  using (customer_id = auth.uid() or public.is_staff());

-- indents: customer sees own; staff see all. (Writes are via RPCs only.)
drop policy if exists indents_read on public.indents;
create policy indents_read on public.indents for select
  using (customer_id = auth.uid() or public.is_staff());

-- audit_log: customer sees rows for their own indents; staff see all.
-- No INSERT/UPDATE/DELETE policy => append-only from the app's side; the
-- _audit() SECURITY DEFINER function is the ONLY writer.
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select
  using (
    public.is_staff() or
    exists (select 1 from public.indents i
            where i.id = audit_log.indent_id and i.customer_id = auth.uid())
  );

-- statements: customer sees own; admin sees all.
drop policy if exists statements_read on public.statements;
create policy statements_read on public.statements for select
  using (customer_id = auth.uid() or public.is_admin());

-- settings: any authenticated user may read; only admin updates (via policy).
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select using (auth.uid() is not null);
drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for update
  using (public.is_admin()) with check (public.is_admin());

-- Hard guarantee that the audit log is append-only: block UPDATE/DELETE for
-- everyone, including table owner via a trigger (belt-and-braces beyond RLS).
create or replace function public.block_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;

drop trigger if exists trg_audit_no_update on public.audit_log;
create trigger trg_audit_no_update before update or delete on public.audit_log
  for each row execute function public.block_audit_mutation();

-- ---------------------------------------------------------------------
-- Grants: expose RPCs to authenticated users.
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant execute on all functions in schema public to authenticated;
-- Clients READ tables directly (filtered by RLS) but never write them directly:
-- all writes go through the SECURITY DEFINER RPCs above. So grant SELECT only.
grant select on public.app_users, public.vehicles, public.indents,
                 public.audit_log, public.statements, public.settings
  to authenticated;
grant usage, select on sequence public.indent_code_seq to authenticated;

-- ...but the internal audit writer must NOT be directly callable, or a user
-- could forge audit rows. The SECURITY DEFINER mutation RPCs call it as the
-- function owner, so revoking it from clients does not break them.
revoke execute on function public._audit(uuid, audit_event, jsonb, jsonb, text, text, text)
  from public, authenticated;

-- =====================================================================
-- BOOTSTRAP THE FIRST ADMIN (run once, after creating an auth user)
-- ---------------------------------------------------------------------
-- 1. In Supabase Dashboard > Authentication > Users, "Add user" with:
--       email:    <username>@vriddhi.local  (e.g. owner@vriddhi.local)
--       password: <the password, min 6 chars> (Supabase requires >= 6)
--    Copy the new user's UUID.
-- 2. Run (replace the UUID and username):
--
--    insert into public.app_users (id, username, name, role)
--    values ('00000000-0000-0000-0000-000000000000',
--            'owner', 'Owner', 'admin');
--
-- After that, the admin can create every other user from inside the app
-- (which calls the admin-create-user edge function). See README.
-- =====================================================================


-- =====================================================================
-- DAILY PRICES + INVOICES  (added after v1 — safe to re-run)
-- =====================================================================

-- Vehicle number is optional now; partial deliveries record what was delivered.
alter table public.indents alter column vehicle_no drop not null;
alter table public.indents add column if not exists delivered_value numeric(12,2);

-- Shift date helper: the 6am-to-6am business day (IST) as a plain date.
create or replace function public.shift_date(p_ts timestamptz)
returns date language sql immutable as $$
  select ((p_ts at time zone 'Asia/Kolkata') - interval '6 hours')::date;
$$;

-- Business details for the invoice (CREDIT MEMO) header.
alter table public.settings add column if not exists address    text;
alter table public.settings add column if not exists gst_no     text;
alter table public.settings add column if not exists contact    text;
alter table public.settings add column if not exists mobile     text;
alter table public.settings add column if not exists email      text;
alter table public.settings add column if not exists state_name text;
alter table public.settings add column if not exists state_code text;

-- Seed the real Vriddhi Fuels letterhead (only fills blanks; never clobbers
-- values the admin has already edited).
update public.settings set business_name='VRIDDHI FUELS (2026-27)'
  where id=1 and (business_name is null or business_name='Vriddhi Fuels');
update public.settings set address=E'AT-KHERWAL PO- BADMAL\nDIST- JHARSUGUDA, 768202\nODISHA'
  where id=1 and address is null;
update public.settings set gst_no='21AATFV8250A1Z8' where id=1 and gst_no is null;
update public.settings set mobile='9937344411'        where id=1 and mobile is null;
update public.settings set email='subhamkhetan@gmail.com' where id=1 and email is null;
update public.settings set state_name='Odisha'        where id=1 and state_name is null;
update public.settings set state_code='21'            where id=1 and state_code is null;

-- Append-only price history. A price "takes effect" on its effective_date
-- (a shift date) and carries forward until a newer one is entered — so a
-- skipped day automatically keeps the previous day's rate.
create table if not exists public.product_prices (
  id             uuid primary key default gen_random_uuid(),
  product        product_type not null,
  price          numeric(10,2) not null check (price > 0),   -- ₹ per litre, tax-inclusive
  effective_date date not null,
  created_by     uuid references public.app_users(id),
  created_at     timestamptz not null default now()
);
create index if not exists idx_prices_product_date
  on public.product_prices(product, effective_date desc, created_at desc);

-- Latest price for a product effective on/before a given date (carry-forward).
create or replace function public.price_on(p_product product_type, p_date date)
returns numeric language sql stable set search_path = public as $$
  select price from public.product_prices
  where product = p_product and effective_date <= p_date
  order by effective_date desc, created_at desc
  limit 1;
$$;

-- Today's effective price per product, and whether it was set today.
create or replace function public.current_prices()
returns table(product product_type, price numeric, effective_date date, set_today boolean)
language sql stable security definer set search_path = public as $$
  with d as (select public.shift_date(now()) as today),
  prods as (select unnest(enum_range(null::product_type)) as product)
  select p.product,
    (select pp.price from public.product_prices pp, d
      where pp.product = p.product and pp.effective_date <= d.today
      order by pp.effective_date desc, pp.created_at desc limit 1),
    (select pp.effective_date from public.product_prices pp, d
      where pp.product = p.product and pp.effective_date <= d.today
      order by pp.effective_date desc, pp.created_at desc limit 1),
    exists(select 1 from public.product_prices pp, d
      where pp.product = p.product and pp.effective_date = d.today)
  from prods p;
$$;

-- Admin sets today's price for a product (inserts a new history row).
create or replace function public.set_price(p_product product_type, p_price numeric)
returns public.product_prices
language plpgsql security definer set search_path = public as $$
declare rec public.product_prices;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_price is null or p_price <= 0 then raise exception 'Price must be > 0'; end if;
  insert into public.product_prices(product, price, effective_date, created_by)
  values (p_product, p_price, public.shift_date(now()), auth.uid())
  returning * into rec;
  return rec;
end $$;

-- Sequential invoice numbers: INV-0001, INV-0002, ...
create sequence if not exists public.invoice_code_seq;

create table if not exists public.invoices (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,             -- INV-0001
  indent_id     uuid not null unique references public.indents(id),
  customer_id   uuid not null references public.app_users(id),
  product       product_type not null,
  order_type    order_type   not null,
  ordered_value numeric(12,2) not null,           -- litres or ₹ as originally ordered
  rate          numeric(10,2),                    -- ₹/L used (null if no price yet)
  litres        numeric(12,3),                    -- computed litres
  amount        numeric(12,2),                    -- ₹ total (tax-inclusive)
  issued_by     uuid references public.app_users(id),
  issued_at     timestamptz not null default now()
);
create index if not exists idx_invoices_customer on public.invoices(customer_id);

-- Internal: create (or, with force, refresh) the invoice for an indent.
-- Uses the rate effective on the delivery shift date. Never raises on a
-- missing price — it stores a rate-less invoice the admin can regenerate.
create or replace function public._create_invoice(p_indent uuid, p_force boolean)
returns public.invoices
language plpgsql security definer set search_path = public as $$
declare i public.indents; inv public.invoices; r numeric; l numeric; a numeric; d date; basis numeric;
begin
  select * into i from public.indents where id = p_indent;
  if i.id is null then raise exception 'Indent not found'; end if;
  select * into inv from public.invoices where indent_id = p_indent;
  if inv.id is not null and not p_force then return inv; end if;

  d := public.shift_date(coalesce(i.handled_at, now()));
  r := public.price_on(i.product, d);
  basis := coalesce(i.delivered_value, i.value);   -- bill the DELIVERED amount
  if i.order_type = 'Litres' then
    l := basis;
    a := case when r is not null then round(basis * r, 2) else null end;
  else
    a := basis;
    l := case when r is not null and r > 0 then round(basis / r, 3) else null end;
  end if;

  if inv.id is null then
    insert into public.invoices(code, indent_id, customer_id, product, order_type,
                                ordered_value, rate, litres, amount, issued_by)
    values ('INV-' || lpad(nextval('public.invoice_code_seq')::text, 4, '0'),
            p_indent, i.customer_id, i.product, i.order_type, basis, r, l, a, auth.uid())
    returning * into inv;
  else
    update public.invoices set ordered_value=basis, rate=r, litres=l, amount=a,
      issued_by=auth.uid(), issued_at=now()
    where id = inv.id returning * into inv;
  end if;
  return inv;
end $$;

-- Staff-callable wrapper (deliver_indent calls _create_invoice directly).
create or replace function public.generate_invoice(p_indent uuid, p_force boolean default false)
returns public.invoices
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Staff only'; end if;
  return public._create_invoice(p_indent, p_force);
end $$;

-- RLS for the new tables.
alter table public.product_prices enable row level security;
alter table public.invoices       enable row level security;

drop policy if exists prices_read on public.product_prices;
create policy prices_read on public.product_prices for select
  using (auth.uid() is not null);          -- rate-of-day is visible to all users

drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select
  using (customer_id = auth.uid() or public.is_staff());

-- Grants (these functions/tables are created after the blanket grant above).
grant select on public.product_prices, public.invoices to authenticated;
grant update on public.settings to authenticated;   -- RLS still limits writes to admin
grant execute on function
  public.shift_date(timestamptz),
  public.price_on(product_type, date),
  public.current_prices(),
  public.set_price(product_type, numeric),
  public.generate_invoice(uuid, boolean)
  to authenticated;
-- Internal invoice writer must not be directly callable (like _audit).
revoke execute on function public._create_invoice(uuid, boolean) from public, authenticated;


-- =====================================================================
-- ADMIN: reset / start afresh
-- ---------------------------------------------------------------------
-- Permanently wipes all transactional history — indents, invoices, the
-- append-only audit trail, and statements — and resets numbering. KEEPS
-- users, saved vehicles, product prices, and business settings. Intended
-- for clearing test data before go-live. Requires typing the exact word.
-- TRUNCATE (not DELETE) is used so it bypasses the audit append-only
-- trigger and resets identities in one shot.
-- =====================================================================
create or replace function public.reset_indent_history(p_confirm text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  if p_confirm is distinct from 'RESET' then
    raise exception 'Confirmation text does not match. Type RESET to confirm.';
  end if;

  truncate table public.invoices, public.audit_log, public.statements,
                 public.indents restart identity;

  alter sequence public.indent_code_seq  restart with 1;
  alter sequence public.invoice_code_seq restart with 1;
end $$;

grant execute on function public.reset_indent_history(text) to authenticated;


-- =====================================================================
-- CUSTOMER: fuel-receipt acknowledgement (per invoice)
-- ---------------------------------------------------------------------
-- After delivery, the customer acknowledges that the fuel was received.
-- Each acknowledgement writes an audit row (with device metadata) so the
-- customer cannot later deny taking the fuel. Supports one-click bulk
-- acknowledgement of many invoices (e.g. a whole day) via an id array.
-- =====================================================================
-- ack_status: 'pending' | 'acknowledged' | 'disputed' (problem reported).
alter table public.invoices add column if not exists ack_status text not null default 'pending';
alter table public.invoices add column if not exists ack_at     timestamptz;
alter table public.invoices add column if not exists ack_note   text;  -- problem description

create or replace function public.acknowledge_invoices(
  p_ids uuid[], p_ua text default null, p_ip text default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare caller public.app_users := public.me(); rec record; n integer := 0;
begin
  if caller.id is null then raise exception 'Not authenticated'; end if;
  for rec in
    select * from public.invoices
    where id = any(p_ids) and customer_id = caller.id and ack_status = 'pending'
  loop
    update public.invoices set ack_status='acknowledged', ack_at=now() where id = rec.id;
    perform public._audit(rec.indent_id, 'approved', null,
      jsonb_build_object('invoice', rec.code, 'ack', 'acknowledged'),
      'FUEL RECEIPT ACKNOWLEDGED by customer — invoice ' || rec.code, p_ua, p_ip);
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function public.acknowledge_invoices(uuid[], text, text) to authenticated;

-- Customer reports a problem with a delivery instead of acknowledging it. This
-- flags the invoice to the owner (ack_status='disputed') and records the reason
-- in the audit trail, so the customer is unblocked without it counting as an
-- acknowledgement.
create or replace function public.report_invoice_problem(
  p_id uuid, p_reason text default null, p_ua text default null, p_ip text default null)
returns public.invoices
language plpgsql security definer set search_path = public as $$
declare caller public.app_users := public.me(); inv public.invoices; reason text;
begin
  select * into inv from public.invoices where id = p_id;
  if inv.id is null then raise exception 'Invoice not found'; end if;
  if caller.id <> inv.customer_id then raise exception 'Not your invoice'; end if;
  if inv.ack_status = 'acknowledged' then raise exception 'Already acknowledged'; end if;
  reason := nullif(btrim(coalesce(p_reason,'')), '');

  update public.invoices set ack_status='disputed', ack_at=now(), ack_note=reason
    where id = p_id returning * into inv;
  perform public._audit(inv.indent_id, 'rejected', null,
    jsonb_build_object('invoice', inv.code, 'ack', 'disputed', 'reason', reason),
    'PROBLEM REPORTED by customer — invoice ' || inv.code || coalesce(': ' || reason, ''),
    p_ua, p_ip);
  return inv;
end $$;

grant execute on function public.report_invoice_problem(uuid, text, text, text) to authenticated;

-- Owner resolves a reported problem so it leaves the "reported" list.
alter table public.invoices add column if not exists resolution text;

create or replace function public.resolve_dispute(
  p_id uuid, p_resolution text, p_ua text default null, p_ip text default null)
returns public.invoices
language plpgsql security definer set search_path = public as $$
declare inv public.invoices; res text;
begin
  if not public.is_admin() then raise exception 'Admin only'; end if;
  select * into inv from public.invoices where id = p_id;
  if inv.id is null then raise exception 'Invoice not found'; end if;
  if inv.ack_status <> 'disputed' then raise exception 'Only reported problems can be resolved'; end if;
  res := coalesce(nullif(btrim(coalesce(p_resolution,'')),''), 'Resolved');

  update public.invoices set ack_status='resolved', resolution=res, ack_at=now()
    where id = p_id returning * into inv;
  perform public._audit(inv.indent_id, 'approved', null,
    jsonb_build_object('invoice', inv.code, 'ack', 'resolved', 'resolution', res),
    'DISPUTE RESOLVED by owner — invoice ' || inv.code || ': ' || res, p_ua, p_ip);
  return inv;
end $$;

grant execute on function public.resolve_dispute(uuid, text, text, text) to authenticated;


-- =====================================================================
-- WEB PUSH: device subscriptions
-- ---------------------------------------------------------------------
-- Each device stores its Web Push subscription here. The `notify` edge
-- function (service role) reads these to send pushes: new indents -> staff,
-- deliveries -> the customer. See supabase/functions/notify + README.
-- =====================================================================
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.app_users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_push_user on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.push_subscriptions to authenticated;

