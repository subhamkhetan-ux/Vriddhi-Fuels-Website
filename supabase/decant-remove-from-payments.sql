-- =====================================================================
-- Take the decanting tables OUT of the payments Supabase project
-- ---------------------------------------------------------------------
-- The decanting app (/decant/) has its own project now. Only if
-- decant-schema.sql was ever run in the PAYMENTS project: run this there
-- (SQL Editor → paste → Run) to remove the dec_* tables, view and function.
-- It touches nothing else, and is safe to run when they were never created.
-- =====================================================================
drop view if exists public.dec_history;
drop function if exists public.dec_purge_old();
drop table if exists public.dec_invoices, public.dec_sessions, public.dec_photos,
  public.dec_tank_state, public.dec_vehicles, public.dec_config;
