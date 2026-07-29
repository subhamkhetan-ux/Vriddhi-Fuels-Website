// =====================================================================
// Vriddhi Fuels — Tanker Loading app configuration
// ---------------------------------------------------------------------
// This app uses its OWN dedicated Supabase project (separate from the
// indent app and the tally app). Create the project, run
// supabase/loading-schema.sql in its SQL Editor, then paste the values
// below (Project Settings → API).
//
// SUPABASE_URL is the BASE project URL (no /rest/v1/ suffix).
// SUPABASE_ANON_KEY is the PUBLIC key (anon / sb_publishable_...). It is
// safe to ship in the client; access is guarded by sign-in and Row Level
// Security. Never put the sb_secret_ / service_role key here.
//
// While these are left as placeholders the app runs in SINGLE-DEVICE mode
// (no login, data stays in this browser only, kept forever). Fill them in
// to switch to CLOUD mode: every employee signs in, all phones share one
// live list, and data is kept for the last 7 days only.
// =====================================================================
window.VRIDDHI_LOADING_CONFIG = {
  SUPABASE_URL: "PASTE_YOUR_SUPABASE_URL_HERE",
  SUPABASE_ANON_KEY: "PASTE_YOUR_SUPABASE_ANON_KEY_HERE",
};
