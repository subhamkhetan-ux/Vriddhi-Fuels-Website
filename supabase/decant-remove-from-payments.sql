-- =====================================================================
-- Take the decanting tables OUT of the payments Supabase project
-- ---------------------------------------------------------------------
-- The decanting app (/decant/) has its own project now. Only if
-- decant-schema.sql was ever run in the PAYMENTS project: run this there
-- (SQL Editor → paste → Run) to remove the dec_* tables, views and function,
-- and the screenshot bucket's policy and bucket. It touches nothing else, and
-- is safe to run when they were never created.
--
-- It refuses to run where the decant tables hold any data: that is the
-- decanting app's own project, and nothing is removed there.
-- =====================================================================
do $$
declare n bigint := 0; t text;
begin
  foreach t in array array['dec_invoices', 'dec_sessions', 'dec_tank_state'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then
        raise exception 'public.% has % rows: this is the decanting app''s own project. Nothing was removed.', t, n;
      end if;
    end if;
  end loop;
end $$;

drop view if exists public.dec_history;
drop view if exists public.dec_months;
drop function if exists public.dec_purge_old(), public.dec_whoami(), public.dec_add_owner(text),
  public.dec_remove_owner(text);
drop table if exists public.dec_invoices, public.dec_sessions, public.dec_photos,
  public.dec_tank_state, public.dec_vehicles, public.dec_config, public.dec_shots, public.dec_owners, public.dec_live;

-- the screenshot bucket (Supabase only)
do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  if exists (select 1 from pg_policies
              where schemaname = 'storage' and tablename = 'objects' and policyname = 'dec_shots_files') then
    execute 'drop policy dec_shots_files on storage.objects';
  end if;
  begin
    delete from storage.buckets b where b.id = 'dec-shots'
       and not exists (select 1 from storage.objects o where o.bucket_id = 'dec-shots');
  exception when others then
    raise notice 'Delete the empty dec-shots bucket in Storage instead (%).', sqlerrm;
  end;
end $$;
