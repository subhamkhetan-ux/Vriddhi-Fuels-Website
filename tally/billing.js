/* =====================================================================
 * Vriddhi Fuels — Tanker billing module for the Tally Voucher app.
 * ---------------------------------------------------------------------
 * This is the billing (customer invoice) logic, moved into the Tally app
 * so a printable bill can be produced straight from a voucher — every
 * field pre-filled: the voucher supplies date / vehicle / quantity /
 * price / amount and the product, and the customer's address, GSTIN,
 * P.O. number and payment block come from the Tanker Billing sheet
 * (`state/tanker_billing.json`, refreshed hourly by the sync Action).
 *
 * Pure logic + data loading, no DOM — so it also runs under Node for
 * testing. Exposed as window.VFBilling.
 *
 * The standalone /tanker/ app is untouched and keeps working; both apps
 * read the same JSON. A bill raised from a voucher takes that voucher's
 * invoice number, so the bill and the Tally invoice carry one reference
 * and the tanker app's own running counter is left alone.
 * ===================================================================== */
(function (global) {
"use strict";

var HSD = "High Speed Diesel";
// Density-/Seal No- appear together only for full loads in the reference
// exports (9000/12000 shown, 3000 hidden) — same cut-offs as /tanker/.
var DENSITY_MIN = 3000, SEAL_MIN = 3000;

var DATA_URL  = "../state/tanker_billing.json";
var LS_DATA   = "vf_tally_billing_v1";   // offline copy of the sheet data
var LS_BILLNO = "vf_last_billno";        // the /tanker/ app's counter (read-only here)

// Tally series -> the product name used on the bill and in the rate tables
var PRODUCT_BY_SERIES = { hsd: HSD, ms: "Motor Spirit", xg: "XtraGreen Diesel" };

/* ---------------- formatting (identical to the /tanker/ app) ---------------- */

// Indian digit grouping, rupees only (the bill never prints paise).
function inr(n){
  n = Math.trunc(Math.abs(n));
  var s = String(n);
  if (s.length <= 3) return s;
  var last3 = s.slice(-3);
  var rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return rest + "," + last3;
}

// YYYY-MM-DD -> DD/MM/YY (the format on the Excel bill)
function fmtDate(iso){
  if (!iso) return "";
  var p = String(iso).split("-");
  if (p.length !== 3) return "";
  return p[2] + "/" + p[1] + "/" + p[0].slice(2);
}

/* ---------------- customer matching ---------------- */

// A Tally ledger name and the billing sheet's company name are typed by
// hand in two different places, so compare them loosely: case, spacing,
// punctuation and the usual "M/s / Private / Limited / &" variations are
// normalised away before matching.
function normName(s){
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bm\s*\/\s*s\b/g, " ")
    .replace(/\bmessrs\b/g, " ")
    .replace(/\bprivate\b/g, "pvt")
    .replace(/\blimited\b/g, "ltd")
    .replace(/\bcompany\b/g, "co")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The sheet customer for a Tally party ledger, or null when there is no
// unambiguous match (the bill screen then asks the user to pick one).
function findCustomer(data, partyName){
  if (!data || !data.customers) return null;
  var target = normName(partyName);
  if (!target) return null;
  var i, c;
  for (i = 0; i < data.customers.length; i++){
    c = data.customers[i];
    if (normName(c.company) === target) return c;
  }
  // fall back to a prefix match, but only when exactly one customer fits
  var hits = [];
  for (i = 0; i < data.customers.length; i++){
    c = data.customers[i];
    var n = normName(c.company);
    if (n && (n.indexOf(target) === 0 || target.indexOf(n) === 0)) hits.push(c);
  }
  return hits.length === 1 ? hits[0] : null;
}

// The sheet's rate for this customer + product: the customer's tier rate
// for diesel, the flat product rate otherwise. null when not on file.
function sheetRate(data, cust, product){
  if (product === HSD) return (cust && cust.hsd_rate != null) ? cust.hsd_rate : null;
  var r = data && data.product_rates ? data.product_rates[product] : undefined;
  return r === undefined ? null : r;
}

function productForSeries(seriesKey){
  return PRODUCT_BY_SERIES[seriesKey] || HSD;
}

/* ---------------- the bill model ---------------- */

// o = {customer, name, product, dateISO, billNo, vehicle, qty, price,
//      amount (optional — defaults to trunc(qty x price)), poNo (optional)}
// Returns the model consumed by both the SVG preview and TankerDocx.build.
function buildModel(o){
  o = o || {};
  var cust  = o.customer || null;
  var qty   = Number(o.qty) || 0;
  var price = Number(o.price) || 0;
  var amount = (o.amount === null || o.amount === undefined || o.amount === "")
    ? Math.trunc(qty * price)
    : Math.trunc(Number(o.amount) || 0);

  // P.O. No. comes from the customer but stays editable on the bill.
  var poVal = String(o.poNo === null || o.poNo === undefined
    ? (cust ? (cust.po_no || "") : "") : o.poNo).trim();
  var poLabel = cust && cust.po_label ? cust.po_label : "";
  if (!poLabel && poVal) poLabel = "P.O. No.:";

  var addr = (cust && cust.address) || [];
  var isHSD = o.product === HSD;

  return {
    date: fmtDate(o.dateISO),
    product: o.product || "",
    name: cust ? cust.company : String(o.name || ""),
    address: [addr[0] || "", addr[1] || "", addr[2] || ""],
    poLabel: poLabel, poVal: poVal,
    density: isHSD && qty > DENSITY_MIN,
    seal:    isHSD && qty > SEAL_MIN,
    payment: (cust && cust.payment) ? cust.payment.slice(0, 5) : [],
    row: {
      date: fmtDate(o.dateISO),
      bill: String(o.billNo === null || o.billNo === undefined ? "" : o.billNo).trim(),
      vehicle: String(o.vehicle || "").toUpperCase(),
      qty: qty ? String(Math.trunc(qty)) : "",
      price: price ? price.toFixed(2) : "",
      amount: amount ? "₹" + inr(amount) : ""
    },
    images: {}
  };
}

/* ---------------- bill numbering ----------------
   A bill raised here carries the voucher's own invoice number, so the bill
   and the Tally invoice share one reference. This is only the fallback for
   the case where a voucher has no number yet: the standalone /tanker/
   app's running counter, read but never written, so that app's own
   numbering is left exactly as it is. */

function nextBillNo(){
  var last;
  try { last = parseInt(global.localStorage.getItem(LS_BILLNO) || "0", 10) || 0; }
  catch(e){ return ""; }
  return last ? String(last + 1) : "";
}

/* ---------------- data loading ---------------- */

var cachedData = null, pendingLoad = null;

function cacheLocally(json){
  try { global.localStorage.setItem(LS_DATA, JSON.stringify(json)); } catch(e){}
}
function readLocalCache(){
  try {
    var s = global.localStorage.getItem(LS_DATA);
    if (!s) return null;
    var d = JSON.parse(s);
    return (d && d.customers) ? d : null;
  } catch(e){ return null; }
}

// Resolves with the billing sheet data. The network copy wins; the last
// good copy in localStorage keeps the bill screen usable offline.
function load(force){
  if (cachedData && !force) return Promise.resolve(cachedData);
  if (pendingLoad && !force) return pendingLoad;
  pendingLoad = global.fetch(DATA_URL, { cache: "no-store" })
    .then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(d){
      if (!d || !d.customers) throw new Error("unexpected data format");
      cachedData = d;
      cacheLocally(d);
      return d;
    })
    .catch(function(err){
      var local = readLocalCache();
      if (local){ cachedData = local; return local; }
      pendingLoad = null;
      throw err;
    });
  return pendingLoad;
}

global.VFBilling = {
  HSD: HSD,
  DENSITY_MIN: DENSITY_MIN,
  SEAL_MIN: SEAL_MIN,
  PRODUCT_BY_SERIES: PRODUCT_BY_SERIES,
  inr: inr,
  fmtDate: fmtDate,
  normName: normName,
  findCustomer: findCustomer,
  sheetRate: sheetRate,
  productForSeries: productForSeries,
  buildModel: buildModel,
  nextBillNo: nextBillNo,
  load: load,
  cached: function(){ return cachedData; }
};

})(typeof window !== "undefined" ? window : globalThis);
