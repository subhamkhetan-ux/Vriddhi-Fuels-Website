// =====================================================================
// Vriddhi Fuels — Tally Voucher app configuration
// ---------------------------------------------------------------------
// This app uses its OWN dedicated Supabase project (separate from the
// indent app). Create the project, run supabase/tally-schema.sql in its
// SQL Editor, then paste the values below (Project Settings → API).
//
// SUPABASE_URL is the BASE project URL (no /rest/v1/ suffix).
// SUPABASE_ANON_KEY is the PUBLIC key (anon / sb_publishable_...). It is
// safe to ship in the client; access is guarded by sign-in, Row Level
// Security and the SECURITY DEFINER RPCs. Never put the sb_secret_ /
// service_role key here.
//
// While these are left as placeholders the app runs in single-device
// mode (no login, data stays in this browser only).
// =====================================================================
window.VRIDDHI_TALLY_CONFIG = {
  SUPABASE_URL: "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE",
  SUPABASE_ANON_KEY: "PASTE_YOUR_SUPABASE_ANON_KEY_HERE",
};
