// =====================================================================
// Vriddhi Fuels — Tanker Decanting app config
// ---------------------------------------------------------------------
// SUPABASE_URL + SUPABASE_ANON_KEY: the SAME project as the /payments
// app — its cloud agent reads every IndianOil invoice from mail and
// writes it (with the truck's chamber table) to dec_invoices, which this
// app lists. Run supabase/decant-schema.sql once (SQL Editor) to create
// the dec_* tables. The anon (publishable) key is safe to ship; access
// is guarded by RLS. Never put a service_role / secret key here.
// =====================================================================
window.VRIDDHI_DECANT_CONFIG = {
  SUPABASE_URL: "https://ycqvpqnbiqeldayglqgk.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Zd1fhvQlfxPvWTS7HRcnSQ_Vc9El2IC",
};
