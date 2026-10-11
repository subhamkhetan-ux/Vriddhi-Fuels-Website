// =====================================================================
// Shree Shyam Fleet (/fleet/) config
// ---------------------------------------------------------------------
// The fleet app has its OWN Supabase project (not the ledger's). Paste
// that project's URL and its publishable (anon) key below — both are
// meant to be public: nothing can be read without signing in, and only
// logins added with fleet_add_member() get in. Never put the
// service_role / secret key here.
//
// Leave them empty and the page explains the setup and offers the demo.
// =====================================================================
window.FLEET_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
};
