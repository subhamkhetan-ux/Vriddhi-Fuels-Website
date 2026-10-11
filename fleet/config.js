// =====================================================================
// Shree Shyam Fleet (/fleet/) config
// ---------------------------------------------------------------------
// The fleet app lives in the LEDGER's Supabase project (same logins, its
// own fleet_* table — see supabase/fleet-schema.sql), so these are the
// same two values as ledger/config.js. Both are meant to be public:
// nothing can be read without signing in with a ledger member login.
// Never put the service_role / secret key here.
// =====================================================================
window.FLEET_CONFIG = {
  SUPABASE_URL: "https://behousmsujnlspwdxyas.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_BeflN_phUuD6BT_ZmAdDsw_tou7vxUa",
};
