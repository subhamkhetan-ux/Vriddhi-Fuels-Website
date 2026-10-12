// =====================================================================
// Vriddhi Fuels — Jarvis (/jarvis/) config
// ---------------------------------------------------------------------
// Jarvis's OWN Supabase project (vriddhi-jarvis): its login and what
// follows you across devices (settings, the recent conversation). Schema:
// supabase/jarvis-schema.sql. The apps' data stays in the apps' own
// projects — Jarvis reads their config.js files (loaded by index.html).
// Both values are public by design; never put a secret key here.
//
// MAC: the Mac side (XtraPower monitor, Mac scripts through the bridge in
// jarvis/bridge/). Off: those operations and the Mac status are hidden.
// To switch it on: run supabase/jarvis-mac-schema.sql in this project,
// set MAC: true, and start the bridge on the Mac (jarvis/README.md).
//
// BRAIN_URL: the optional Claude brain's Edge Function; empty = this
// project's /functions/v1/jarvis-brain. Jarvis works without it.
// =====================================================================
window.JARVIS_CONFIG = {
  SUPABASE_URL: "https://otazjsvffvfortrmdred.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_v2UjE6N_Kg-aIpu_aZMF5g_O19E8JES",
  MAC: false,
  BRAIN_URL: "",
};
