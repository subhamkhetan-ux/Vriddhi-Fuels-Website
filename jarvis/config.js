// =====================================================================
// Vriddhi Fuels — Jarvis (/jarvis/) config
// ---------------------------------------------------------------------
// Jarvis signs in with the LEDGER login and reads the other apps' own
// config.js files, so there is nothing to fill in here for the apps.
//
// BRAIN_URL: the jarvis-brain Edge Function (supabase/functions/jarvis-brain)
// that keeps the Anthropic API key in Supabase. Leave it empty to use the
// one in the ledger project: <ledger SUPABASE_URL>/functions/v1/jarvis-brain
// No secret ever goes in this file.
// =====================================================================
window.JARVIS_CONFIG = {
  BRAIN_URL: "",
};
