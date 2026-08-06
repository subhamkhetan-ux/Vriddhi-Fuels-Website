// =====================================================================
// Vriddhi Fuels — Payment Entry app configuration
// ---------------------------------------------------------------------
// The customer list now comes from a Tally **Master.xml** you upload in the
// app (the ledgers under "Sundry Debtors" — the same source the Tally app
// uses). That upload is authoritative and works offline.
//
// DATA_URL below is OPTIONAL. It's the same Google Apps Script feed that
// powers the Master Ledger dashboard; when reachable it supplies each
// customer's past payment amounts (used only for the "unusual amount" check)
// and acts as a fallback name source before any Master.xml has been uploaded.
// Leave it as-is, change it, or set it to "" to disable the feed entirely.
// =====================================================================
window.VRIDDHI_PAY_CONFIG = {
  DATA_URL: "https://script.google.com/macros/s/AKfycbzNC2KNGSZgeaQzKa9YJt7J3VCknQAbPXuFp3q8Vzeuo7J6CEkY6yg_uGclCqwqglmQsg/exec",
};
