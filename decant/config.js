// =====================================================================
// Vriddhi Fuels — Tanker Decanting app config
// ---------------------------------------------------------------------
// This app has its OWN Supabase project — never the payments one, so it
// can't use up the payments project's free-tier limits. Set it up once:
//   1. supabase.com → New project (free plan is fine).
//   2. SQL Editor → paste supabase/decant-schema.sql → Run.
//   3. Project Settings → API Keys: paste the Project URL and the
//      publishable key below.
// The payments agent then also stores every IndianOil invoice here (it
// reads this file), and the app syncs across phones. While these are left
// as placeholders the app works on this phone only.
//
// SUPABASE_URL is the base project URL (no /rest/v1/ suffix).
// SUPABASE_ANON_KEY is the PUBLIC key (sb_publishable_... / anon). It is
// safe to ship; access is guarded by RLS. Never put a secret or
// service_role key here.
// =====================================================================
window.VRIDDHI_DECANT_CONFIG = {
  SUPABASE_URL: "PASTE_DECANT_PROJECT_URL",
  SUPABASE_ANON_KEY: "PASTE_DECANT_PUBLISHABLE_KEY",
};
