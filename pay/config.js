// =====================================================================
// Vriddhi Fuels — Payment Entry app configuration
// ---------------------------------------------------------------------
// DATA_URL is the same Google Apps Script Web App that powers the Master
// Ledger dashboard (repo root /index.html). It returns every sheet as JSON,
// including "Master Paid" — this app reads the canonical customer list from
// it (Master Paid column F ∪ column B ∪ the customer ledgers) so partial
// names can be resolved to their exact canonical spelling.
//
// It must end in /exec (NOT /dev). Paste your own here if it ever changes.
// =====================================================================
window.VRIDDHI_PAY_CONFIG = {
  DATA_URL: "https://script.google.com/macros/s/AKfycbzNC2KNGSZgeaQzKa9YJt7J3VCknQAbPXuFp3q8Vzeuo7J6CEkY6yg_uGclCqwqglmQsg/exec",
};
