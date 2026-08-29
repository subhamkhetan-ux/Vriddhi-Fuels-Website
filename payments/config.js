// =====================================================================
// Vriddhi Fuels — Payments (Gmail credit-alert review) app config
// ---------------------------------------------------------------------
// This app reads the bank credits the cloud agent has queued, lets you
// resolve any unmatched names, and exports the confirmed ones to a
// Master-Paid .xlsx — all from the browser, no terminal.
//
// SUPABASE_URL + SUPABASE_ANON_KEY: the same project the /pay app uses.
// Run supabase/payments-schema.sql once (SQL Editor) to create the two
// tables. The anon key is safe to ship; access is guarded by RLS.
//
// CUSTOMERS_URL: where to read the canonical customer list for the
// review autocomplete. Defaults to the committed state/customers.json
// served alongside the site.
//
// MASTER_XML_URL (optional): point this at a Tally "Masters" XML export
// (a committed .xml, e.g. "../state/master.xml") to use Tally as the single
// source of truth for customer names — the app reads the <LEDGER> masters
// from it instead of customers.json. Leave it empty ("") to keep using the
// JSON list. See state/master.sample.xml for the expected shape.
// =====================================================================
window.VRIDDHI_PAYMENTS_CONFIG = {
  SUPABASE_URL: "https://ycqvpqnbiqeldayglqgk.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_Zd1fhvQlfxPvWTS7HRcnSQ_Vc9El2IC",
  CUSTOMERS_URL: "../state/customers.json",
  MASTER_XML_URL: "",
};
