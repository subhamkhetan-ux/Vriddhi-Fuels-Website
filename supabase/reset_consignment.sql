-- =====================================================================
-- ONE-TIME reset of consignment notes — restart numbering at 047.
-- ---------------------------------------------------------------------
-- The first agent run after the feature shipped swept up 10 days of IOC
-- invoices and auto-created 14 notes (serials 047-060). We want numbering
-- to start fresh at 047 = invoice 7010221545, with everything older left
-- alone (already covered by the manual notes up to 046).
--
-- RUN THIS ONCE in Supabase -> SQL Editor, BEFORE merging the PR that adds
-- the `min_invoice_no` anchor. Order matters:
--   1. Run this file (clears the 14 notes, resets the counter to 47).
--   2. Merge the PR / let the agent run — it then creates ONLY the note for
--      invoice 7010221545 as serial 047, and 048+ for newer invoices.
-- =====================================================================

-- Wipe every auto-created note.
delete from public.pay_consignment_notes;

-- Reset the serial counter so the next note is 047.
update public.pay_consignment_seq set next_val = 47 where id = 1;
-- (If the counter row somehow doesn't exist yet, create it.)
insert into public.pay_consignment_seq (id, next_val)
  values (1, 47)
  on conflict (id) do update set next_val = 47;
