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
  serial_num     integer not null,          -- 47
  serial_str     text    not null,          -- 'VF/CN2627/047'
  invoice_no     text,
  invoice_date   text,                       -- dd/mm/yyyy from the invoice
  reporting_date text,                        -- top "Date"; app-editable, defaults to invoice_date
  tt_no          text,
  product        text,                        -- raw product description from the invoice
  column_key     text,                        -- template column: 'HSD' | 'XtraGreen HSD' | 'MS | EBMS' | 'LSHFHSD'
  qty            text,                         -- e.g. '22'
  value          bigint,                       -- value of goods, rupees
  status         text    default 'pending',    -- 'pending' | 'done'
  created_at     timestamptz default now(),
  done_at        timestamptz
);

create index if not exists pay_consignment_notes_pending_idx
  on public.pay_consignment_notes (status);
create index if not exists pay_consignment_notes_done_at_idx
  on public.pay_consignment_notes (done_at);

-- ---- monotonic serial counter (never resets, survives purges) ---------
create table if not exists public.pay_consignment_seq (
  id       smallint primary key default 1,
  next_val integer  not null,
  constraint pay_consignment_seq_single check (id = 1)
);
-- Next note after VF/CN2627/046 is 047. Only seeds on first install.
insert into public.pay_consignment_seq (id, next_val)
  values (1, 47)
  on conflict (id) do nothing;

-- Atomically claim a consignment note for one invoice. Idempotent by `id`:
-- if the note already exists it is returned unchanged (no serial consumed),
-- otherwise the next serial is pulled from the counter and the row inserted.
-- This makes agent retries safe — a serial is only ever spent on a genuinely
-- new invoice, so the numbers stay gap-free and monotonic.
create or replace function public.pay_claim_consignment(
  p_id           text,
  p_gmail_msg_id text,
  p_invoice_no   text,
  p_invoice_date text,
  p_tt_no        text,
  p_product      text,
  p_column_key   text,
  p_qty          text,
  p_value        bigint
) returns public.pay_consignment_notes
language plpgsql security definer as $$
declare
  rec      public.pay_consignment_notes;
  v_serial integer;
begin
  select * into rec from public.pay_consignment_notes where id = p_id;
  if found then
    return rec;
  end if;
  update public.pay_consignment_seq
     set next_val = next_val + 1
   where id = 1
   returning next_val - 1 into v_serial;
  insert into public.pay_consignment_notes
    (id, gmail_msg_id, serial_num, serial_str, invoice_no, invoice_date,
     reporting_date, tt_no, product, column_key, qty, value, status)
  values
    (p_id, p_gmail_msg_id, v_serial,
     'VF/CN2627/' || lpad(v_serial::text, 3, '0'),
     p_invoice_no, p_invoice_date, p_invoice_date, p_tt_no, p_product,
     p_column_key, p_qty, p_value, 'pending')
  returning * into rec;
  return rec;
end $$;

-- ---- keep only the latest 5 notes (storage cap) ----------------------
-- Deletes everything except the 5 highest serials, so at most 5 consignment
-- notes are ever stored. The serial counter (pay_consignment_seq) is separate
-- and never resets, so numbers keep incrementing even as old notes drop off.
create or replace function public.pay_consignment_purge_old()
returns void language sql security definer as $$
  delete from public.pay_consignment_notes
  where serial_num not in (
    select serial_num from public.pay_consignment_notes
    order by serial_num desc
    limit 5
  );
$$;

-- ---- RLS + realtime (same personal-owner model as above) -------------
alter table public.pay_consignment_notes enable row level security;
alter table public.pay_consignment_seq   enable row level security;

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
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.pay_consignment_notes;
  exception when duplicate_object then null; end;
end $$;
