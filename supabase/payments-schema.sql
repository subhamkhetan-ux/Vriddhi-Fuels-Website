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
