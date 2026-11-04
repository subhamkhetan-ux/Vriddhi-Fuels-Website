-- =====================================================================
-- Vriddhi Fuels — Payments app (Gmail credit-alert queue) cloud store
-- ---------------------------------------------------------------------
-- The GitHub Actions agent writes each parsed bank credit into
-- `pay_credit_queue`; the /payments web app reads the pending ones,
-- lets the user resolve "review" names (saving them to
-- `pay_credit_aliases`, which the agent reads back to auto-match), and
-- marks rows exported. Exported rows drop off the pending list but stay
-- for 7 days, then auto-purge.
--
-- Safe to re-run. Mirrors the pay-schema.sql model (anon access + RLS +
-- realtime), so it can live in the same Supabase project.
-- =====================================================================

-- ---- the credit queue -------------------------------------------------
create table if not exists public.pay_credit_queue (
  entry_id     text primary key,          -- stable id (hash of gmail msg id)
  gmail_msg_id text,
  account      text,
  bank         text,
  mode         text,                       -- column-D remarks, e.g. "HDFC 1010"
  date_str     text,
  date_serial  bigint,                     -- Excel serial for Master Paid col A
  amount       numeric,
  raw_payer    text,
  customer     text,                        -- canonical name once matched
  candidates   jsonb  default '[]'::jsonb,  -- review candidates
  match_tier   text,
  status       text   default 'review',    -- 'matched' | 'review'
  flags        jsonb  default '{}'::jsonb,
  raw_text     text,                        -- kept for parse-failure debugging
  queued_at    timestamptz default now(),
  exported     boolean default false,
  exported_at  timestamptz
);

create index if not exists pay_credit_queue_pending_idx
  on public.pay_credit_queue (exported, status);
create index if not exists pay_credit_queue_exported_at_idx
  on public.pay_credit_queue (exported_at);

-- ---- Mac logging agent: which rows to push into Master Paid, and when ---
-- Set by the /payments app when you tap "Log to Excel"; the always-on Mac
-- daemon (local_agent/) posts only rows with log_requested=true it hasn't yet
-- logged (logged_at is null), then stamps logged_at + exported. Adding these
-- with "if not exists" keeps this file safe to re-run on an existing install.
alter table public.pay_credit_queue
  add column if not exists log_requested    boolean default false;
alter table public.pay_credit_queue
  add column if not exists log_requested_at timestamptz;
alter table public.pay_credit_queue
  add column if not exists logged_at        timestamptz;

create index if not exists pay_credit_queue_tolog_idx
  on public.pay_credit_queue (log_requested, logged_at);

-- ---- the learned alias table -----------------------------------------
create table if not exists public.pay_credit_aliases (
  alias_key  text primary key,             -- normalized, noise-stripped remitter
  canonical  text not null,                -- canonical customer name
  updated_at timestamptz default now()
);

-- ---- 7-day purge of exported rows ------------------------------------
create or replace function public.pay_credit_purge_old()
returns void language sql security definer as $$
  delete from public.pay_credit_queue
  where exported = true and exported_at < now() - interval '7 days';
$$;

-- ---- RLS: personal owner tool, anon key may read/write these tables ---
alter table public.pay_credit_queue   enable row level security;
alter table public.pay_credit_aliases enable row level security;

do $$
begin
  -- queue
  if not exists (select 1 from pg_policies where policyname = 'pay_credit_queue_all') then
    create policy pay_credit_queue_all on public.pay_credit_queue
      for all to anon, authenticated using (true) with check (true);
  end if;
  -- aliases
  if not exists (select 1 from pg_policies where policyname = 'pay_credit_aliases_all') then
    create policy pay_credit_aliases_all on public.pay_credit_aliases
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

-- ---- realtime: push changes to connected apps ------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.pay_credit_queue;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.pay_credit_aliases;
  exception when duplicate_object then null; end;
end $$;

-- Optional: purge nightly regardless of app use (needs pg_cron enabled).
-- select cron.schedule('pay_credit_purge_old', '0 2 * * *',
--                      $$ select public.pay_credit_purge_old(); $$);


-- =====================================================================
-- Mac logging-agent activity feed
-- ---------------------------------------------------------------------
-- The always-on Mac daemon (local_agent/) reports every action here: a
-- 'posted' row when it writes a payment into Master Paid, an 'error' when it
-- can't (Excel closed, workbook locked), a periodic 'heartbeat' so the app can
-- show the agent online, and 'caught_up' after draining a batch. The /payments
-- app subscribes to this table for its Activity feed and online/offline pill.
-- =====================================================================
create table if not exists public.pay_agent_events (
  id         bigint generated by default as identity primary key,
  kind       text not null,               -- 'posted'|'error'|'heartbeat'|'caught_up'
  entry_id   text,                          -- the queue row this refers to (if any)
  customer   text,
  amount     numeric,
  mode       text,
  detail     text,                          -- free-text (error message, batch note)
  created_at timestamptz default now()
);

create index if not exists pay_agent_events_created_idx
  on public.pay_agent_events (created_at desc);

-- keep the feed light: drop events older than 7 days (app calls this on load)
create or replace function public.pay_agent_events_purge_old()
returns void language sql security definer as $$
  delete from public.pay_agent_events where created_at < now() - interval '7 days';
$$;

alter table public.pay_agent_events enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'pay_agent_events_all') then
    create policy pay_agent_events_all on public.pay_agent_events
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.pay_agent_events;
  exception when duplicate_object then null; end;
end $$;


-- =====================================================================
-- Consignment notes (Indian Oil invoices for own TT OD23U8210)
-- ---------------------------------------------------------------------
-- The agent detects each new IOC tax invoice in the HDFC Gmail, extracts
-- the fields, pulls the next serial from `pay_consignment_seq`, and
-- inserts a `pending` row here. The /payments app lists pending notes,
-- lets the user set the reporting date (top "Date"), and generates the
-- Word .docx client-side from payments/consignment_template.docx. Marking
-- a note done drops it off the list (kept 7 days, then purged).
-- =====================================================================

create table if not exists public.pay_consignment_notes (
  id             text primary key,          -- stable id (hash of gmail msg id)
  gmail_msg_id   text,
  serial_num     integer not null,          -- printed number, restarts each FY (1, 2, …)
  lifetime_num   integer,                    -- total-trips index, never resets across FYs
  serial_str     text    not null,          -- 'VF/CN2627/047'
  invoice_no     text,
  invoice_date   text,                       -- dd/mm/yyyy from the invoice
  reporting_date text,                        -- top "Date"; app-editable, defaults to invoice_date
  tt_no          text,
  product        text,                        -- raw description of the FIRST product on the invoice
  column_key     text,                        -- first product's template column: 'HSD' | 'XtraGreen HSD' | 'MS | EBMS' | 'LSHFHSD'
  qty            text,                         -- first product's qty, e.g. '22'
  columns        jsonb   default '{}'::jsonb,  -- per-column qty for multi-product loads, e.g. {"MS | EBMS":"5","HSD":"17"}
  value          bigint,                       -- value of goods, rupees (grand total across products)
  status         text    default 'pending',    -- 'pending' | 'done'
  created_at     timestamptz default now(),
  done_at        timestamptz
);

create index if not exists pay_consignment_notes_pending_idx
  on public.pay_consignment_notes (status);
create index if not exists pay_consignment_notes_done_at_idx
  on public.pay_consignment_notes (done_at);

-- Back-fill for installs created before multi-product support: `create table
-- if not exists` above won't add a new column to an existing table, so add it
-- explicitly. Harmless (no-op) on a fresh install.
alter table public.pay_consignment_notes
  add column if not exists columns jsonb default '{}'::jsonb;

-- Loading terminal for the note's "Place of Origin" (added later; back-fills to
-- NULL, and the app then shows the default Jharsuguda terminal for old rows).
alter table public.pay_consignment_notes
  add column if not exists origin text;

-- Lifetime index (total trips ever). Added when the printed serial began
-- restarting per financial year; for FY 2026-27 rows the per-FY number and the
-- lifetime number coincide, so back-fill from serial_num.
alter table public.pay_consignment_notes
  add column if not exists lifetime_num integer;
update public.pay_consignment_notes
   set lifetime_num = serial_num
 where lifetime_num is null;

-- ---- serial counters -------------------------------------------------------
-- Two counters, both survive purges:
--   * pay_consignment_seq   — LIFETIME total, never resets. Its value-1 is the
--     count of notes issued to date; each note stores it as lifetime_num.
--   * pay_consignment_fy_seq — per financial year; the PRINTED serial restarts
--     at 1 each FY (VF/CN2728/001, 002, …), read straight off the note.
create table if not exists public.pay_consignment_seq (
  id       smallint primary key default 1,
  next_val integer  not null,
  constraint pay_consignment_seq_single check (id = 1)
);
-- Next note after VF/CN2627/046 is 047. Only seeds on first install.
insert into public.pay_consignment_seq (id, next_val)
  values (1, 47)
  on conflict (id) do nothing;

create table if not exists public.pay_consignment_fy_seq (
  fy_code  text primary key,          -- '2728' for FY 2027-28
  next_val integer not null
);
-- Seed the CURRENT financial year (2026-27) from the lifetime counter so its
-- numbering continues without a jump — already-issued 047, 048… keep their
-- numbers. A brand-new FY gets a fresh row starting at 1 on its first note.
insert into public.pay_consignment_fy_seq (fy_code, next_val)
  select '2627', next_val from public.pay_consignment_seq where id = 1
  on conflict (fy_code) do nothing;

-- The financial-year code ('2627', '2728', …) for a dd/mm/yyyy invoice date.
-- Indian FY runs 1 Apr – 31 Mar: Apr–Dec belong to that year's FY, Jan–Mar to
-- the FY that began the previous April. Falls back to today's FY if the date is
-- missing or unparseable.
create or replace function public.pay_consignment_fy_code(p_invoice_date text)
returns text language plpgsql stable as $$
declare
  d  date;
  ys int;   -- financial-year start year
begin
  begin
    d := to_date(nullif(trim(p_invoice_date), ''), 'DD/MM/YYYY');
  exception when others then
    d := null;
  end;
  if d is null then d := current_date; end if;
  ys := case when extract(month from d) >= 4
             then extract(year from d)::int
             else extract(year from d)::int - 1 end;
  return lpad((ys % 100)::text, 2, '0') || lpad(((ys + 1) % 100)::text, 2, '0');
end $$;

-- ---- one note per invoice number, forever ----------------------------
-- Every invoice that has been issued a note is recorded here, and this table
-- is never purged: the notes list keeps only the latest 5, but an invoice whose
-- note dropped off it (a resent IOCL mail, a PDF uploaded again in the app, a
-- mail that arrives after the PDF) still finds its note here and is never given
-- a second one. The primary key makes a second note for the same invoice
-- impossible even if two claims race.

-- The invoice's key: its 10-digit IOCL number (70xxxxxxxx) wherever it appears
-- in what was passed (a file name, padded text), else the trimmed text.
create or replace function public.pay_invoice_key(p text)
returns text language sql immutable as $$
  select coalesce(substring(p from '70[0-9]{8}'), nullif(trim(p), ''))
$$;

create table if not exists public.pay_consignment_issued (
  invoice_no   text primary key,             -- pay_invoice_key() of the invoice
  note_id      text,
  serial_str   text,
  serial_num   integer,
  lifetime_num integer,
  invoice_date text,
  tt_no        text,
  -- true: recorded from the notes still stored when this table was added. Notes
  -- purged before then left no record, so an invoice OLDER than every legacy
  -- row may already have had one — pay_claim_consignment won't issue those.
  legacy       boolean default false,
  issued_at    timestamptz default now()
);
insert into public.pay_consignment_issued
  (invoice_no, note_id, serial_str, serial_num, lifetime_num, invoice_date, tt_no, legacy, issued_at)
select distinct on (k) k, id, serial_str, serial_num, lifetime_num, invoice_date, tt_no, true, created_at
  from (select n.*, public.pay_invoice_key(n.invoice_no) as k from public.pay_consignment_notes n) x
 where k is not null
 order by k, coalesce(lifetime_num, serial_num)
on conflict (invoice_no) do nothing;

alter table public.pay_consignment_issued enable row level security;
-- the app reads it (to say "already issued as …"); only the claim RPC writes it
revoke insert, update, delete, truncate on public.pay_consignment_issued from anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'pay_consignment_issued_read') then
    create policy pay_consignment_issued_read on public.pay_consignment_issued
      for select to anon, authenticated using (true);
  end if;
end $$;

-- Atomically claim a consignment note for one invoice. Never more than one
-- note per invoice number: an existing note (by id, or by invoice number) is
-- returned unchanged, and an invoice issued before whose note has since been
-- purged comes back as that note's record (status 'done', not re-inserted) —
-- no serial is consumed either way. Only a genuinely new invoice pulls the next
-- serial, so the numbers stay gap-free and monotonic.
-- Drop the earlier signatures so the new one below fully replaces them (a
-- changed argument list would otherwise create another overload): the original
-- pre-multi-product one, and the multi-product one before p_origin was added.
drop function if exists public.pay_claim_consignment(
  text, text, text, text, text, text, text, text, bigint);
drop function if exists public.pay_claim_consignment(
  text, text, text, text, text, text, text, text, bigint, jsonb);

create or replace function public.pay_claim_consignment(
  p_id           text,
  p_gmail_msg_id text,
  p_invoice_no   text,
  p_invoice_date text,
  p_tt_no        text,
  p_product      text,
  p_column_key   text,
  p_qty          text,
  p_value        bigint,
  p_columns      jsonb default '{}'::jsonb,
  p_origin       text  default null
) returns public.pay_consignment_notes
language plpgsql security definer as $$
declare
  rec        public.pay_consignment_notes;
  iss        public.pay_consignment_issued;
  v_key      text := public.pay_invoice_key(p_invoice_no);
  v_floor    numeric;
  v_fy       text;
  v_fynum    integer;   -- printed number within the financial year
  v_lifetime integer;   -- total-trips index across all years
begin
  if v_key is null then
    raise exception 'pay_claim_consignment: the invoice number is required';
  end if;
  -- One claim at a time (they are rare): the mail agent and a PDF upload for
  -- the same invoice can't both get past the checks below.
  perform 1 from public.pay_consignment_seq where id = 1 for update;

  select * into rec from public.pay_consignment_notes where id = p_id;
  if found then return rec; end if;
  select * into rec from public.pay_consignment_notes
   where public.pay_invoice_key(invoice_no) = v_key
   order by coalesce(lifetime_num, serial_num) limit 1;
  if found then return rec; end if;

  select * into iss from public.pay_consignment_issued where invoice_no = v_key;
  if found then
    -- issued already; its note has dropped off the list. Report it, never re-issue.
    rec.id := coalesce(iss.note_id, p_id);
    rec.serial_str := iss.serial_str;  rec.serial_num := iss.serial_num;
    rec.lifetime_num := iss.lifetime_num;
    rec.invoice_no := v_key;  rec.invoice_date := iss.invoice_date;  rec.tt_no := iss.tt_no;
    rec.status := 'done';  rec.created_at := iss.issued_at;  rec.done_at := iss.issued_at;
    return rec;
  end if;

  if v_key ~ '^[0-9]+$' then
    select min(invoice_no::numeric) into v_floor
      from public.pay_consignment_issued where legacy and invoice_no ~ '^[0-9]+$';
    if v_floor is not null and v_key::numeric < v_floor then
      raise exception 'invoice % is older than the consignment-note records (from %) — it may already have had a note, so none is issued', v_key, v_floor::text;
    end if;
  end if;

  v_fy := public.pay_consignment_fy_code(p_invoice_date);
  -- lifetime counter (total trips ever)
  update public.pay_consignment_seq
     set next_val = next_val + 1
   where id = 1
   returning next_val - 1 into v_lifetime;
  -- per-FY counter — the printed serial restarts at 1 each financial year. Make
  -- sure the row exists (first note of a new FY), then take the next number.
  insert into public.pay_consignment_fy_seq (fy_code, next_val)
    values (v_fy, 1)
    on conflict (fy_code) do nothing;
  update public.pay_consignment_fy_seq
     set next_val = next_val + 1
   where fy_code = v_fy
   returning next_val - 1 into v_fynum;
  insert into public.pay_consignment_notes
    (id, gmail_msg_id, serial_num, lifetime_num, serial_str, invoice_no, invoice_date,
     reporting_date, tt_no, product, column_key, qty, columns, value, origin, status)
  values
    (p_id, p_gmail_msg_id, v_fynum, v_lifetime,
     'VF/CN' || v_fy || '/' || lpad(v_fynum::text, 3, '0'),
     v_key, p_invoice_date, p_invoice_date, p_tt_no, p_product,
     p_column_key, p_qty, coalesce(p_columns, '{}'::jsonb), p_value, p_origin, 'pending')
  returning * into rec;
  -- the permanent record (its primary key refuses a second note for this invoice)
  insert into public.pay_consignment_issued
    (invoice_no, note_id, serial_str, serial_num, lifetime_num, invoice_date, tt_no)
  values (v_key, rec.id, rec.serial_str, rec.serial_num, rec.lifetime_num, rec.invoice_date, rec.tt_no);
  return rec;
end $$;

-- ---- keep only the latest 5 notes (storage cap) ----------------------
-- Deletes everything except the 5 most recent notes, so at most 5 are ever
-- stored. Ordered by lifetime_num (true recency) because the printed serial_num
-- now restarts each financial year. The counters are separate and never reset,
-- so numbering continues even as old notes drop off.
create or replace function public.pay_consignment_purge_old()
returns void language sql security definer as $$
  delete from public.pay_consignment_notes
  where id not in (
    select id from public.pay_consignment_notes
    order by coalesce(lifetime_num, serial_num) desc
    limit 5
  );
$$;

-- ---- RLS + realtime (same personal-owner model as above) -------------
alter table public.pay_consignment_notes  enable row level security;
alter table public.pay_consignment_seq    enable row level security;
alter table public.pay_consignment_fy_seq enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'pay_consignment_notes_all') then
    create policy pay_consignment_notes_all on public.pay_consignment_notes
      for all to anon, authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'pay_consignment_seq_all') then
    create policy pay_consignment_seq_all on public.pay_consignment_seq
      for all to anon, authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'pay_consignment_fy_seq_all') then
    create policy pay_consignment_fy_seq_all on public.pay_consignment_fy_seq
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.pay_consignment_notes;
  exception when duplicate_object then null; end;
end $$;

-- =====================================================================
-- Customer roster (Sundry Debtors from Tally)
-- ---------------------------------------------------------------------
-- The canonical customer list both the matcher (cloud) and the app use.
-- Seeded from state/customers.json, but the app's "Update customer list"
-- upload (a Tally Master.xml -> Sundry Debtors parse) REPLACES this table,
-- so it's the live source of truth across devices. The cloud agent reads
-- it too (falling back to the committed customers.json when empty), so a
-- roster update reaches matching on the next run with no code deploy.
-- =====================================================================
create table if not exists public.pay_customers (
  name       text primary key,           -- exact canonical customer name
  updated_at timestamptz default now()
);

-- Atomically replace the whole roster with a new set of names (used by the
-- Tally-XML upload). One transaction, so the app never reads a half-written
-- roster. Blank/duplicate names are dropped; an empty input is ignored (a
-- guard against wiping the list from a bad upload).
create or replace function public.pay_replace_customers(p_names text[])
returns integer language plpgsql security definer as $$
declare
  n integer;
begin
  if p_names is null or array_length(p_names, 1) is null then
    return (select count(*)::integer from public.pay_customers);
  end if;
  -- `where true` clears every row while satisfying Supabase's safeupdate guard,
  -- which rejects an unqualified DELETE ("DELETE requires a WHERE clause").
  delete from public.pay_customers where true;
  insert into public.pay_customers (name)
    select distinct btrim(x)
    from unnest(p_names) as x
    where btrim(coalesce(x, '')) <> ''
    on conflict (name) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

alter table public.pay_customers enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'pay_customers_all') then
    create policy pay_customers_all on public.pay_customers
      for all to anon, authenticated using (true) with check (true);
  end if;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.pay_customers;
  exception when duplicate_object then null; end;
end $$;

-- =====================================================================
-- Credit facility & dues tracker (IOCL fuel account)
-- ---------------------------------------------------------------------
-- The /payments "Credit" section tracks the IOCL credit facility: a
-- limit, a T+2 (editable) working-day repayment schedule, the day's
-- invoices (auto-summed from mail by the agent, all trucks), and manual
-- balance snapshots (DR = owed, CR = in credit). The dues table applies
-- the latest balance oldest-invoices-first (FIFO) to show what's still
-- owed and by when. Everything is anon+RLS+realtime like the rest.
-- =====================================================================

-- Editable settings (singleton row)
create table if not exists public.pay_credit_config (
  id             smallint primary key default 1,
  credit_limit   numeric  default 8500000,   -- 85 lakhs; editable
  repayment_days integer  default 2,          -- T+2 working days; editable
  hsd_price      numeric,                      -- current HSD ₹/KL after VAT (editable)
  ms_price       numeric,                      -- current MS  ₹/KL after VAT (editable)
  updated_at     timestamptz default now(),
  constraint pay_credit_config_single check (id = 1)
);
insert into public.pay_credit_config (id) values (1) on conflict (id) do nothing;
-- back-fill the price columns for installs created before the ordering calculator
alter table public.pay_credit_config add column if not exists hsd_price numeric;
alter table public.pay_credit_config add column if not exists ms_price  numeric;

-- Every IOCL fuel invoice (ALL trucks), idempotent by invoice number.
-- The agent upserts these; the app sums them per invoice_date.
create table if not exists public.pay_fuel_invoices (
  invoice_no   text primary key,
  invoice_date text,                          -- dd/mm/yyyy from the invoice
  tt_no        text,
  amount       numeric,                       -- invoice grand total, rupees
  gmail_msg_id text,
  created_at   timestamptz default now()
);
create index if not exists pay_fuel_invoices_date_idx
  on public.pay_fuel_invoices (invoice_date);
-- Where a row came from: null = the mail (the agent), 'pdf' = uploaded in the
-- app, 'manual' = typed in from the paper invoice (no PDF to be had). The mail,
-- when it does arrive, replaces a 'manual' row's figures with the invoice's own.
alter table public.pay_fuel_invoices add column if not exists source text;

-- Current after-VAT price per KL for each product, derived by the agent from
-- each invoice's per-product "Total for material" ÷ qty. Newest invoice wins,
-- so the price auto-updates when IOCL revises it. The app's ordering calculator
-- reads this (a manual price in pay_credit_config overrides it if set).
create table if not exists public.pay_fuel_prices (
  col_key      text primary key,              -- 'MS | EBMS' | 'HSD' | 'XtraGreen HSD' | 'LSHFHSD'
  price_per_kl numeric,
  as_of        text,                           -- ISO date of the invoice it came from
  invoice_no   text,
  updated_at   timestamptz default now()
);

-- Manual correction of a day's invoice total (a missed / misread mail).
-- When present it overrides the summed auto total for that day.
create table if not exists public.pay_fuel_day_overrides (
  day        text primary key,                -- dd/mm/yyyy
  amount     numeric,
  note       text,
  updated_at timestamptz default now()
);

-- Opening balance recorded per day (the morning anchor). Lets the dues math
-- re-baseline each day instead of relying on the full invoice history.
create table if not exists public.pay_credit_opening (
  day        text primary key,                -- ISO yyyy-mm-dd
  amount     numeric,                          -- absolute figure
  sign       text,                             -- 'DR' (owed) | 'CR' (in credit)
  updated_at timestamptz default now()
);

-- Balance snapshots (pasted by hand as they update through the day).
create table if not exists public.pay_credit_balances (
  id         text primary key,                -- client-generated id
  at         timestamptz default now(),       -- when this balance was observed
  amount     numeric,                         -- absolute figure
  sign       text,                            -- 'DR' (owed) | 'CR' (in credit)
  raw        text,                            -- the pasted message, for audit
  created_at timestamptz default now()
);
create index if not exists pay_credit_balances_at_idx
  on public.pay_credit_balances (at desc);

-- Bank open/closed confirmations for dates that aren't auto-known
-- (Sundays + 2nd/4th Saturdays are computed; festivals are confirmed here).
create table if not exists public.pay_bank_holidays (
  day        text primary key,                -- ISO yyyy-mm-dd
  is_holiday boolean,                         -- true = closed, false = confirmed open
  note       text,
  updated_at timestamptz default now()
);

-- Confirmed non-invoice PAD debits (licence-fee recovery, interest, misc fees).
-- The app detects an unexplained balance gap, asks the user to confirm it, and
-- stores it here with a reason so it reconciles alongside invoices.
create table if not exists public.pay_other_deductions (
  id         text primary key,                -- client-generated id
  at         timestamptz default now(),       -- when it was confirmed / applied
  amount     numeric,                         -- rupees debited
  reason     text,                            -- user's remark (why)
  created_at timestamptz default now()
);
create index if not exists pay_other_deductions_at_idx
  on public.pay_other_deductions (at desc);

-- Keep only ~7 days of credit history (older is not useful once cleared). The
-- app calls this on load. Uses IST for "today". Keeps prices (current) and bank
-- holidays (future-relevant).
create or replace function public.pay_fuel_purge_old()
returns void language sql security definer as $$
  delete from public.pay_fuel_invoices
   where invoice_date ~ '^\d{1,2}/\d{1,2}/\d{4}$'
     and to_date(invoice_date, 'DD/MM/YYYY') < ((now() at time zone 'Asia/Kolkata')::date - 7);
  delete from public.pay_fuel_day_overrides
   where day ~ '^\d{1,2}/\d{1,2}/\d{4}$'
     and to_date(day, 'DD/MM/YYYY') < ((now() at time zone 'Asia/Kolkata')::date - 7);
  delete from public.pay_credit_opening
   where day ~ '^\d{4}-\d{2}-\d{2}$'
     and day::date < ((now() at time zone 'Asia/Kolkata')::date - 7);
  delete from public.pay_credit_balances
   where at < now() - interval '7 days';
  delete from public.pay_other_deductions
   where at < now() - interval '7 days';
$$;

alter table public.pay_credit_config       enable row level security;
alter table public.pay_fuel_invoices       enable row level security;
alter table public.pay_fuel_prices          enable row level security;
alter table public.pay_fuel_day_overrides  enable row level security;
alter table public.pay_credit_opening      enable row level security;
alter table public.pay_credit_balances     enable row level security;
alter table public.pay_bank_holidays       enable row level security;
alter table public.pay_other_deductions    enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'pay_credit_config','pay_fuel_invoices','pay_fuel_prices','pay_fuel_day_overrides',
    'pay_credit_opening','pay_credit_balances','pay_bank_holidays','pay_other_deductions'] loop
    if not exists (select 1 from pg_policies where policyname = t || '_all') then
      execute format(
        'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
        t || '_all', t);
    end if;
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'pay_credit_config','pay_fuel_invoices','pay_fuel_prices','pay_fuel_day_overrides',
    'pay_credit_opening','pay_credit_balances','pay_bank_holidays','pay_other_deductions'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;
