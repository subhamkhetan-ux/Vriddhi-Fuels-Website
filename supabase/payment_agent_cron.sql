-- =====================================================================
-- Keep the payment agent running on time (Supabase-driven trigger)
-- ---------------------------------------------------------------------
-- GitHub throttles scheduled workflows, so the every-20-min cron in
-- .github/workflows/payment-agent.yml often runs hours late. This uses
-- Supabase's own scheduler (pg_cron) to POST GitHub's "run workflow"
-- API every 15 minutes, which is NOT throttled — so ingest stays timely.
--
-- ONE-TIME SETUP. Run this whole file once in Supabase -> SQL Editor,
-- after replacing the token placeholder in step 2. Safe to re-run (it
-- won't duplicate the schedule); to change the token later, see the note
-- at the bottom.
-- =====================================================================

-- 1) Extensions (both ship with Supabase; enabling is idempotent).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Store the GitHub token in Supabase Vault (encrypted at rest).
--    Replace REPLACE_WITH_YOUR_GITHUB_TOKEN with the fine-grained token
--    you create (Actions: Read and write, this repo only). Runs once;
--    re-running leaves an existing secret untouched.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'github_pat_payment_agent') then
    perform vault.create_secret(
      'REPLACE_WITH_YOUR_GITHUB_TOKEN',
      'github_pat_payment_agent',
      'Fine-grained GitHub PAT (Actions: read/write) to trigger the payment agent workflow'
    );
  end if;
end $$;

-- 3) The trigger function — reads the token from Vault and calls GitHub's
--    workflow_dispatch endpoint. SECURITY DEFINER so it can read the vault;
--    execute is revoked from the API roles so only the cron job can run it
--    (the token is never exposed through PostgREST).
create or replace function public.trigger_payment_agent()
returns void
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  tok text;
begin
  select decrypted_secret into tok
    from vault.decrypted_secrets
   where name = 'github_pat_payment_agent';
  if tok is null then
    raise notice 'github_pat_payment_agent secret not found; skipping';
    return;
  end if;
  perform net.http_post(
    url     := 'https://api.github.com/repos/subhamkhetan-ux/Vriddhi-Fuels-Website/actions/workflows/payment-agent.yml/dispatches',
    body    := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization',        'Bearer ' || tok,
      'Accept',               'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent',           'vriddhi-supabase-cron',
      'Content-Type',         'application/json'
    )
  );
end;
$$;

revoke execute on function public.trigger_payment_agent() from anon, authenticated, public;

-- 4) Schedule it every 15 minutes (unschedule first so re-runs don't stack).
do $$
begin
  perform cron.unschedule('payment-agent-trigger');
exception when others then null;   -- not scheduled yet: ignore
end $$;

select cron.schedule('payment-agent-trigger', '*/15 * * * *',
                     $$ select public.trigger_payment_agent(); $$);

-- ---------------------------------------------------------------------
-- Handy checks / maintenance:
--   -- fire it once now to test:
--        select public.trigger_payment_agent();
--   -- see the schedule:
--        select jobname, schedule, active from cron.job;
--   -- see recent run results (did the POST go out?):
--        select * from cron.job_run_details order by start_time desc limit 5;
--   -- change the token later:
--        select vault.update_secret(
--          (select id from vault.secrets where name='github_pat_payment_agent'),
--          'NEW_TOKEN');
--   -- stop the auto-trigger:
--        select cron.unschedule('payment-agent-trigger');
-- =====================================================================
