// =====================================================================
// Vriddhi Fuels — Ledger app (/ledger/) config
// ---------------------------------------------------------------------
// The ledger has its OWN Supabase project (not the one /payments or any
// other app uses). Paste that project's URL and its publishable (anon)
// key below — both are meant to be public: nothing can be read without
// signing in, and only logins added with ledger_add_member() get in.
// Never put the service_role / secret key here.
//
// Leave them empty and the page explains the setup and offers the demo.
// =====================================================================
window.LEDGER_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
};
