// =====================================================================
// Vriddhi Fuels — Payment Entry app configuration
// ---------------------------------------------------------------------
// CUSTOMER LIST comes from a Tally **Master.xml** you upload in the app
// (the ledgers under "Sundry Debtors" — same source as the Tally app).
//
// CLOUD SYNC (optional): set SUPABASE_URL + SUPABASE_ANON_KEY to keep the
// exported-entries history AND the customer list consistent across all your
// devices in real time (see SETUP.md — run supabase/pay-schema.sql once).
// The anon key is safe to ship in the client; access is guarded by RLS.
// Leave the PASTE_… placeholders to run the app purely on-device (localStorage).
//
// DATA_URL (optional): the Master Ledger Apps Script feed. When reachable it
// supplies each customer's past payment amounts (for the "unusual amount"
// check) and a fallback name source before any Master.xml is uploaded. Set to
// "" to disable it.
// =====================================================================
window.VRIDDHI_PAY_CONFIG = {
  SUPABASE_URL: "PASTE_YOUR_SUPABASE_URL_HERE",
  SUPABASE_ANON_KEY: "PASTE_YOUR_SUPABASE_ANON_KEY_HERE",
  DATA_URL: "https://script.google.com/macros/s/AKfycbzNC2KNGSZgeaQzKa9YJt7J3VCknQAbPXuFp3q8Vzeuo7J6CEkY6yg_uGclCqwqglmQsg/exec",
};
