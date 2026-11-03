// Quotations and Proforma Invoices — the Tanker Billing workbook's
// "Quotation Maker" and "Proforma Invoice" sheets (and its PI Log macro).
//
//   readTankerBilling() — what Quotes → Import takes from the workbook: the
//                         Customers / RateCard / ProductRates / FuelTypes
//                         tables, the XtraPower figures, the Quotation
//                         Maker's inputs, both sheets' fixed wording and
//                         the PI Log
//   quotationCalc()     — every formula of the Quotation Maker
//   proformaCalc()      — every formula of the Proforma Invoice
//   ...Values()         — what each cell of the printed page shows
// Pure: tested in node (tests/ledger_web/quote.test.mjs).

import { LAYOUTS } from './sheet-layouts.js';
import { fyOf } from './util.js';

export const HSD_TIER = 'HSD RSP';
export const PI_PRODUCTS = ['High Speed Diesel (HSD)', 'Motor Spirit (Petrol)', 'XtraGreen Diesel', 'Lubricants'];
const DEFAULT_XP = { points: 40, tds: 0.1, net: 36 };

// ---- small Excel look-alikes ------------------------------------------------
const round2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
export const xlRound = (x, d = 0) => { const k = 10 ** d; const v = Math.abs(Number(x) || 0) * k; return Math.sign(Number(x) || 0) * Math.round(v + 1e-9) / k; };
const fixed = (x, d = 2) => xlRound(x, d).toFixed(d);
const xlTrim = (s) => String(s ?? '').replace(/ +/g, ' ').trim();

// Indian digit grouping: 1234567 -> 12,34,567
export function indian(n, decimals = 0) {
  const v = xlRound(n, decimals);
  const [whole, frac] = Math.abs(v).toFixed(decimals).split('.');
  const g = whole.length <= 3 ? whole : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;
  return `${v < 0 ? '-' : ''}${g}${frac ? `.${frac}` : ''}`;
}

// '2026-11-03' -> '03/11/2026'
export const dmyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// '2026-08-17' -> '17 August 2026' (VBA's Format "d mmmm yyyy")
export const longDate = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');

export function serialToIso(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));
  return d.toISOString().slice(0, 10);
}
function serialToStamp(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return `${new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400) * 1000).toISOString().slice(0, 19)}+05:30`;            // Excel's clock: India time
}

// Valid Up To (G6): the 15th for a PI dated 1st–15th, otherwise month-end.
export function piValidTo(iso) {
  if (!iso) return '';
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (Number(iso.slice(8, 10)) <= 15) return `${iso.slice(0, 7)}-15`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

// The Proforma's "Amount Chargeable (in words)" formula (C27), word for word.
const ONES = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
// INDEX(t, INT(x/10)-1) is 1-based: 20s -> t[1] = Twenty
const twoDigits = (x) => (x < 20 ? ONES[x - 1] : `${TENS[Math.floor(x / 10) - 2]} ${x % 10 === 0 ? '' : ONES[(x % 10) - 1]}`.trim());
export function rupeesInWords(amount) {
  const n = xlRound(amount, 0);
  if (n === 0) return 'Rupees Zero Only';
  const cr = Math.floor(n / 10000000);
  const lk = Math.floor(n / 100000) % 100;
  const th = Math.floor(n / 1000) % 100;
  const hd = Math.floor(n / 100) % 10;
  const rs = n % 100;
  const s = `Rupees ${cr > 0 ? `${twoDigits(cr)} Crore ` : ''}${lk > 0 ? `${twoDigits(lk)} Lakh ` : ''}${th > 0 ? `${twoDigits(th)} Thousand ` : ''}`
    + `${hd > 0 ? `${ONES[hd - 1]} Hundred ` : ''}${rs > 0 ? `${twoDigits(rs)} ` : ''}Only`;
  return s.replace(/ +/g, ' ').trim();
}

// File names, as the macros make them: the customer's first two words
// (a leading "M/s" dropped), then e.g. "PI 17 August 2026".
export function firstTwoWords(name) {
  let t = xlTrim(String(name || '').replace(/[\r\n]/g, ' ')).replace(/\./g, ' ');
  t = xlTrim(t);
  for (;;) {
    const u = t.toUpperCase();
    if (u.startsWith('M/S ') || u.startsWith('M/S.')) t = xlTrim(t.slice(4));
    else if (u.startsWith('MS ')) t = xlTrim(t.slice(3));
    else break;
  }
  return t.split(' ').filter(Boolean).slice(0, 2).join(' ');
}
export const cleanName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-').trim();
export const piFileName = (customer, iso) => `${cleanName(`${firstTwoWords(customer) || 'Customer'} PI ${longDate(iso)}`)}.pdf`;
export const quoteFileName = (customer, iso) => `${cleanName(`${firstTwoWords(customer) || 'Customer'} Quotation ${longDate(iso)}`)}.pdf`;

// ---- rates -------------------------------------------------------------------
// The RSP the sheets use (the workbook's HSD_RSP: RateCard "HSD RSP").
export function hsdRsp(data) {
  if (!data) return null;
  if (data.hsd_rsp != null) return Number(data.hsd_rsp);
  const t = (data.rate_card || []).find((r) => r.tier === HSD_TIER);
  return t ? Number(t.rate) : null;
}

// A customer's HSD rate. With the workbook's own RSP it is the Customers
// table's HSD column; with another RSP typed in, each tier is worked out the
// way its RateCard cell does it — "HSD RSP" is the RSP, a tier written as
// =P2-0.74 follows the RSP, a typed-in rate stays.
export function customerRate(data, cust, rsp = hsdRsp(data)) {
  if (!cust) return null;
  const base = hsdRsp(data);
  const own = cust.hsd_rate != null && cust.hsd_rate !== '' ? Number(cust.hsd_rate) : null;
  if (rsp == null || base == null || Math.abs(rsp - base) < 1e-9) return own;
  const tier = (data.rate_card || []).find((r) => r.tier === cust.price_tier);
  if (!tier) return own;
  if (tier.tier === HSD_TIER) return round2(rsp);
  if (tier.rsp_offset != null) return round2(rsp + Number(tier.rsp_offset));
  return Number(tier.rate);
}

// Rate for a Proforma line: the customer's HSD rate (the sheet's F19) for
// diesel; Motor Spirit / XtraGreen from ProductRates; lubricants typed in.
export function productRate(data, cust, description, rsp) {
  const d = String(description || '').toLowerCase();
  if (/motor spirit|petrol/.test(d)) return numOr((data?.product_rates || {})['Motor Spirit']);
  if (/xtragreen/.test(d)) return numOr((data?.product_rates || {})['XtraGreen Diesel']);
  if (/lubric/.test(d)) return null;
  return customerRate(data, cust, rsp);
}
const numOr = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const isXtraPower = (cust) => /xtrapower/i.test(String((cust && cust.payment && cust.payment[0]) || ''));
const xpOf = (data) => ({ ...DEFAULT_XP, ...((data && data.xp) || {}) });

// "Account No. – 046805004716" -> ['Account No.', '046805004716'] (TEXTBEFORE / TEXTAFTER on "–")
export function splitDash(s) {
  const x = String(s ?? '');
  const i = x.indexOf('–');
  if (i < 0) return [x, ''];
  return [xlTrim(x.slice(0, i)), xlTrim(x.slice(i + 1))];
}

// ---- Quotation Maker ----------------------------------------------------------
// q: {customer (Tanker Master row), date (ISO), valid_till, contact, email, rsp, rate}
export function quotationCalc(data, q) {
  const xp = xpOf(data);
  const rsp = q.rsp != null && q.rsp !== '' ? Number(q.rsp) : hsdRsp(data) || 0;           // I12
  const rate = q.rate != null && q.rate !== '' ? Number(q.rate) : (customerRate(data, q.customer, rsp) || 0);  // I13
  const discount = rsp - rate;                                                             // I14
  const pct = rsp ? discount / rsp : 0;                                                    // I15
  const xtra = isXtraPower(q.customer);                                                   // I16
  const benefit = xtra ? (rate * xp.net) / 10000 : 0;                                      // I17
  const effective = rate - benefit;                                                        // I18
  return { rsp, rate, discount, pct, xtra, benefit, effective, xp };
}

const paren = (v) => (v < 0 ? `(₹${fixed(-v)})` : `₹${fixed(v)}`);                     // \₹0.00;\(\₹0.00\)

export function quotationValues(data, q, texts = {}) {
  const c = quotationCalc(data, q);
  const cust = q.customer;
  const addr = (i) => xlTrim(cust && cust.address ? cust.address[i] : '');
  const pay = (i) => (cust && cust.payment ? cust.payment[i] : '') || '';
  const bank = (i) => splitDash(cust ? pay(i) : '');
  const contact = q.contact ?? '';
  const email = q.email ?? '';
  const v = {
    A5: cust ? cust.company : '',
    A6: addr(0), A7: addr(1), A8: addr(2),
    E5: dmyy(q.date), E6: q.valid_till ?? '',
    A12: `With reference to the above subject, we are pleased to submit our most competitive offer for the supply of genuine IndianOil High-Speed Diesel (HSD) to your site. We offer a flat discount of ₹${fixed(c.discount)} per Litre on the prevailing Retail Selling Price (RSP) at our Retail Outlet, with free doorstep delivery at your site, giving you a net billing price of ₹${fixed(c.rate)} per Litre.${c.xtra ? ` Being an XtraPower customer, you also earn XtraPower points worth approx. ₹${fixed(c.benefit)} per Litre (net of TDS), bringing your effective price down to ₹${fixed(c.effective)} per Litre.` : ''}`,
    A17: '1', A18: '2', A19: '3',
    B17: 'Retail Selling Price (RSP) at our RO',
    D17: paren(c.rsp), D18: paren(-c.discount), D19: paren(c.rate),
    E17: `IOCL RSP as on ${dmyy(q.date)}`,
    E19: c.xtra
      ? { text: `Effective ₹${fixed(c.effective)}/Ltr after XtraPower points (${fixed(c.xp.net, 0)} paise/₹100 net)`, b: 1, i: 0, c: '#008000' }
      : 'Billing rate – FOR your site',
    A26: c.xtra ? 'BANK DETAILS – XTRAPOWER ACCOUNT (100% ADVANCE)' : 'BANK DETAILS FOR PAYMENT (100% ADVANCE – RTGS / NEFT)',
    A27: bank(4)[0], C27: bank(4)[1], A28: bank(1)[0], C28: bank(1)[1],
    A29: bank(2)[0], C29: bank(2)[1], A30: bank(3)[0], C30: bank(3)[1],
    A33: `We trust our offer is in line with your requirement and look forward to receiving your valued order. For orders or any clarification, please call us at ${contact} or write to ${email}.`,
  };
  // the XtraPower row of the price table turns bold green (conditional format on E19:F19)
  return { values: v, calc: c, texts };
}

// ---- Proforma Invoice -----------------------------------------------------------
// p: {pi_no, date, customer (Tanker Master row), po_no, po_date, place, contact,
//     description, hsn, qty, rate, rsp, xp?}
export function proformaCalc(data, p) {
  const xp = { ...xpOf(data), ...(p.xp || {}) };
  const rsp = p.rsp != null && p.rsp !== '' ? Number(p.rsp) : hsdRsp(data) || 0;          // HSD_RSP
  const qty = Number(p.qty) || 0;                                                          // E19
  const rate = p.rate != null && p.rate !== '' ? Number(p.rate) : 0;                      // F19
  const amount = qty ? Math.trunc(xlRound(qty * rate, 6)) : 0;                             // G19 = TRUNC(E19*F19)
  const subTotal = amount;                                                                 // G20 / G23
  const grand = xlRound(subTotal, 0);                                                      // G25
  const roundOff = grand - subTotal;                                                       // G24
  const xtra = isXtraPower(p.customer);
  const points = xtra ? (grand / 100) * (xp.net / 100) : 0;                                // K25
  const effective = qty ? (grand - points) / qty : null;                                   // K26
  const discount = rsp - rate;
  return {
    qty, rate, rsp, amount, subTotal, roundOff, grand, points, effective, discount, xtra, xp,
    validTo: piValidTo(p.date), words: rupeesInWords(grand),
  };
}

export function proformaValues(data, p) {
  const c = proformaCalc(data, p);
  const cust = p.customer;
  const look = (arr, i) => (cust ? (cust[arr] && cust[arr][i]) || ' ' : ' ');               // XLOOKUP(..., " ")
  const benefitLine = c.discount <= 0
    ? `Rate as per prevailing IOCL Retail Selling Price at our RO: Rs.${fixed(c.rate)}/Ltr`
    : `Retail Selling Price at our RO: Rs.${fixed(c.rsp)}/Ltr      Less: Special Discount Rs.${fixed(c.discount)}/Ltr      Net Offer Price: Rs.${fixed(c.rate)}/Ltr`;
  const totalLine = c.discount <= 0
    ? 'Price is revised in line with every IOCL price revision. Delivery at your site is free of cost.'
    : `Total benefit passed on to you on this supply: Rs.${indian(c.qty * c.discount)} (on ${indian(c.qty)} Ltr). Discount is applied on the prevailing IOCL RSP at every price revision.`;
  const xpLine = c.points > 0
    ? `XtraPower Benefit: Earn ${fixed(c.xp.points, 0)} paise of XtraPower points per Rs.100 paid; after ${fixed(c.xp.tds * 100, 0)}% TDS deducted by IOCL, net ${fixed(c.xp.net, 0)} paise per Rs.100 - approx. ${indian(c.points)} points on this supply. Effective price after points: Rs.${fixed(c.effective)}/Ltr.`
    : '';
  const name = cust ? cust.company : '';
  const v = {
    G4: p.pi_no || '', G5: dmyy(p.date), G6: dmyy(c.validTo), G7: p.po_no || '', G8: dmyy(p.po_date || ''),
    G9: p.place ?? '',
    A12: name, A13: look('address', 0), A14: look('address', 1), A15: look('address', 2),
    E12: name, E13: look('address', 0), E14: look('address', 1), E15: look('address', 2),
    E16: p.contact ?? '',
    A19: '1', B19: p.description || '', D19: p.hsn ?? '',
    E19: c.qty ? indian(c.qty) : '', F19: fixed(c.rate), G19: c.qty ? indian(c.amount, 2) : '',
    E20: indian(c.qty), G20: indian(c.subTotal, 2),
    G23: indian(c.subTotal, 2), G24: indian(c.roundOff, 2), G25: `₹${indian(c.grand)}`,
    A24: benefitLine, A25: totalLine, A26: xpLine, C27: c.words,
    A30: look('payment', 1), A31: look('payment', 2), A32: look('payment', 3), A33: look('payment', 4),
  };
  return { values: v, calc: c };
}

// What the PI Log keeps for a PI (WriteLogRow) — plus a copy of the
// customer's address and payment lines, so a reprint shows them as printed.
export function piLogRow(data, p, printedBy = '') {
  const c = proformaCalc(data, p);
  const cust = p.customer;
  return {
    pi_no: String(p.pi_no || '').trim(), pi_date: p.date || null, valid_to: c.validTo || null,
    customer: cust ? cust.company : '', gstin: cust ? (cust.address && cust.address[2]) || ' ' : '',
    place: p.place ?? '', po_no: p.po_no || '', po_date: p.po_date || null,
    description: p.description || '', hsn: String(p.hsn ?? ''), qty: c.qty, rate: c.rate, rsp: c.rsp,
    sub_total: c.subTotal, round_off: c.roundOff, grand_total: c.grand, points: xlRound(c.points, 4),
    words: c.words, contact: p.contact ?? '', printed_by: printedBy,
    doc: cust ? { address: cust.address || [], payment: cust.payment || [], price_tier: cust.price_tier || '', xp: c.xp } : null,
  };
}

// The PI Log's derived columns: Discount = RSP − Rate, Effective = (Grand − Points) / Qty
export const piDiscount = (row) => (row.rsp == null || row.rsp === '' ? null : Number(row.rsp) - Number(row.rate));
export const piEffective = (row) => (Number(row.qty) ? (Number(row.grand_total) - Number(row.points || 0)) / Number(row.qty) : null);

// A logged PI back into the sheet (LoadLogRowToSheet): the historic rate, PO
// and RSP are kept so a reprint matches the original. The address and
// payment lines are those printed (or, for a PI logged in Excel, the
// customer's lines today, as Excel's reprint does).
export function piFromLog(row, tanker = []) {
  const now = tanker.find((t) => norm(t.company) === norm(row.customer));
  const doc = row.doc || {};
  const customer = {
    company: row.customer,
    address: doc.address && doc.address.length ? doc.address : (now ? now.address : [row.gstin || '', '', '']),
    payment: doc.payment && doc.payment.length ? doc.payment : (now ? now.payment : []),
  };
  return {
    pi_no: row.pi_no, date: row.pi_date, customer, po_no: row.po_no == null ? '' : String(row.po_no), po_date: row.po_date || '',
    place: row.place ?? '', contact: row.contact ?? '', description: row.description || '', hsn: row.hsn ?? '',
    qty: Number(row.qty) || 0, rate: Number(row.rate) || 0, rsp: row.rsp == null ? null : Number(row.rsp), xp: doc.xp || undefined,
  };
}
const norm = (s) => xlTrim(s).toLowerCase();

// ReprintPIs: part of the customer's name (blank = all) and a date range.
export function piMatches(row, { customer = '', from, to }) {
  if (!row.pi_date && (from || to)) return false;
  if (from && row.pi_date < from) return false;
  if (to && row.pi_date > to) return false;
  return !customer || String(row.customer || '').toLowerCase().includes(customer.trim().toLowerCase());
}

// Re-importing the workbook: does Excel's PI Log match the app's?
//   same              PIs alike in both
//   differ            same PI No., different figures — kept 'excel' when the
//                     app's copy came from an earlier import (the import takes
//                     Excel's), 'app' when the PI was made in the app (kept)
//   new_from_excel    in Excel, not yet in the app (the import adds them)
//   missing_in_excel  in the app, not in Excel's PI Log
//   twice_in_excel    a PI No. listed more than once in Excel
//   excel_nos         Excel's PI Nos., so later screens can tell which app PIs Excel lacks
const PI_CHECK = [
  ['pi_date', 'PI date', 'date'], ['valid_to', 'Valid up to', 'date'], ['customer', 'Customer', 'text'], ['place', 'Place of supply', 'text'],
  ['po_no', 'P.O. No.', 'text'], ['po_date', 'P.O. date', 'date'], ['description', 'Description', 'text'], ['hsn', 'HSN code', 'text'],
  ['qty', 'Quantity (Ltr)', 'num'], ['rate', 'Rate (₹/Ltr)', 'num'], ['rsp', 'IOCL RSP (₹/Ltr)', 'num'], ['grand_total', 'Grand total (₹)', 'num'],
  ['points', 'XtraPower points', 'num'],
];
export const piKey = (no) => String(no ?? '').trim().toLowerCase();
const sameValue = (kind, a, b) => {
  if (kind === 'num') {
    const x = a == null || a === '' ? null : Number(a);
    const y = b == null || b === '' ? null : Number(b);
    if (x == null || y == null) return (x ?? 0) === (y ?? 0) || (x == null && y == null);
    return Math.abs(x - y) < 0.005;
  }
  if (kind === 'date') return String(a || '').slice(0, 10) === String(b || '').slice(0, 10);
  return xlTrim(a) === xlTrim(b);
};
const brief = (r) => ({ id: r.id ?? r.log_id ?? null, pi_no: String(r.pi_no || '').trim(), customer: r.customer || '', pi_date: r.pi_date || null, source: r.source || 'workbook' });
export function comparePiLog(excelRows = [], appRows = []) {
  const app = new Map();
  for (const r of appRows) app.set(piKey(r.pi_no), r);
  const out = { same: 0, differ: [], new_from_excel: [], missing_in_excel: [], twice_in_excel: [], excel_nos: [] };
  const seen = new Set();
  for (const x of excelRows) {
    const k = piKey(x.pi_no);
    if (!k) continue;
    if (seen.has(k)) { out.twice_in_excel.push(brief(x)); continue; }
    seen.add(k);
    out.excel_nos.push(String(x.pi_no).trim());
    const a = app.get(k);
    if (!a) { out.new_from_excel.push(brief(x)); continue; }
    const changes = PI_CHECK.filter(([f, , kind]) => !sameValue(kind, x[f], a[f]))
      .map(([field, label, kind]) => ({ field, label, kind, excel: x[field] ?? null, app: a[field] ?? null }));
    if (!changes.length) { out.same++; continue; }
    out.differ.push({ ...brief(a), kept: a.source === 'app' ? 'app' : 'excel', changes });
  }
  for (const a of appRows) if (!seen.has(piKey(a.pi_no))) out.missing_in_excel.push(brief(a));
  return out;
}
export const piCheckClean = (c) => !c.differ.length && !c.missing_in_excel.length && !c.twice_in_excel.length;

// Next PI number: one after the highest "PI/<FY>/nnn" of the PI's financial year.
export function nextPiNo(log, iso) {
  const fy = fyOf(iso || new Date().toISOString().slice(0, 10));
  const prefix = `PI/${fy}/`;
  let max = 0;
  let width = 3;
  for (const r of log || []) {
    const s = String(r.pi_no || '').trim();
    if (!s.toUpperCase().startsWith(prefix.toUpperCase())) continue;
    const m = /(\d+)$/.exec(s);
    if (m) { max = Math.max(max, Number(m[1])); width = Math.max(width, m[1].length); }
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

export const samePiNo = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// ---- reading the workbook ----------------------------------------------------------
const cellAt = (ws, a) => (ws ? ws[a] : null);
const cellText = (c) => (c == null || c.v == null ? '' : String(c.v));
const cellNum = (c) => (c && typeof c.v === 'number' ? c.v : (c && c.v !== '' && c.v != null && Number.isFinite(Number(c.v)) ? Number(c.v) : null));

function colName(i) { let s = ''; let n = i + 1; while (n) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); } return s; }
function colNo(letters) { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function bounds(ws) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec((ws && ws['!ref']) || '');
  return m ? { rows: Number(m[4] || m[2]), cols: colNo(m[3] || m[1]) + 1 } : { rows: 0, cols: 0 };
}

// A table by its header row (row 1): {col index by header text}
function headers(ws) {
  const out = new Map();
  const { cols } = bounds(ws);
  for (let c = 0; c < cols; c++) {
    const t = label(cellText(cellAt(ws, `${colName(c)}1`)));
    if (t && !out.has(t)) out.set(t, c);
  }
  return out;
}
const label = (s) => xlTrim(s).toLowerCase().replace(/[.:]+$/, '');

function definedCell(wb, name) {
  const n = ((wb.Workbook && wb.Workbook.Names) || []).find((x) => String(x.Name).toLowerCase() === name.toLowerCase() && x.Sheet == null);
  const m = n && /^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)$/.exec(String(n.Ref || ''));
  return m ? cellAt(wb.Sheets[m[1]], `${m[2]}${m[3]}`) : null;
}

// wb: a SheetJS workbook read with cellFormula. Returns
// {customers, data, pi_log, warnings}.
export function readTankerBilling(wb) {
  const warnings = [];
  const ws = wb.Sheets.Customers;
  if (!ws) throw new Error('This isn\'t the Tanker Billing workbook — it has no "Customers" sheet.');
  const h = headers(ws);
  const col = (name) => h.get(label(name));
  const need = ['Company', 'HSD', 'Address 1', 'Address 2', 'Address 3', 'Payment 1', 'Payment 2', 'Payment 3', 'Payment 4', 'Payment 5', 'Price Tier'];
  const missing = need.filter((n) => col(n) == null);
  if (missing.length) throw new Error(`The Customers sheet has no ${missing.join(', ')} column — is this the Tanker Billing workbook?`);
  const { rows } = bounds(ws);
  const at = (r, name) => (col(name) == null ? null : cellAt(ws, `${colName(col(name))}${r}`));
  const keep = (c) => { const t = cellText(c); return t.trim() === '' ? '' : t.trim(); };

  // RateCard / ProductRates / FuelTypes sit beside the Customers table
  const rateCard = [];
  let rcCol = null;
  for (let c = (col('Price Tier') ?? 0) + 1; c < bounds(ws).cols; c++) {
    if (label(cellText(cellAt(ws, `${colName(c)}1`))) === 'price tier' && label(cellText(cellAt(ws, `${colName(c + 1)}1`))) === 'rate') { rcCol = c; break; }
  }
  if (rcCol == null) warnings.push('No RateCard table (Price Tier / Rate) beside the Customers table — rates come from the HSD column only.');
  let rspRow = null;
  if (rcCol != null) {
    for (let r = 2; r <= rows; r++) {
      const tier = xlTrim(cellText(cellAt(ws, `${colName(rcCol)}${r}`)));
      if (!tier) continue;
      const rc = cellAt(ws, `${colName(rcCol + 1)}${r}`);
      if (tier === HSD_TIER) rspRow = r;
      rateCard.push({ tier, rate: cellNum(rc), f: rc && rc.f ? String(rc.f) : '', row: r });
    }
    const rateCol = colName(rcCol + 1);
    for (const t of rateCard) {
      const m = new RegExp(`^\\$?${rateCol}\\$?(\\d+)\\s*([-+])\\s*([\\d.]+)$`).exec(t.f.replace(/^=/, '').trim());
      t.rsp_offset = m && Number(m[1]) === rspRow ? (m[2] === '-' ? -1 : 1) * Number(m[3]) : null;
      delete t.f;
      delete t.row;
    }
  }
  const findPair = (a, b) => {
    for (let c = 0; c < bounds(ws).cols; c++) {
      if (label(cellText(cellAt(ws, `${colName(c)}1`))) === a && (b == null || label(cellText(cellAt(ws, `${colName(c + 1)}1`))) === b)) return c;
    }
    return null;
  };
  const productRates = {};
  const prCol = findPair('product', 'rate');
  if (prCol != null) {
    for (let r = 2; r <= rows; r++) {
      const p = xlTrim(cellText(cellAt(ws, `${colName(prCol)}${r}`)));
      const v = cellNum(cellAt(ws, `${colName(prCol + 1)}${r}`));
      if (p && v != null) productRates[p] = v;
    }
  }
  const fuelTypes = [];
  const ftCol = findPair('fuel type');
  if (ftCol != null) {
    for (let r = 2; r <= rows; r++) {
      const f = xlTrim(cellText(cellAt(ws, `${colName(ftCol)}${r}`)));
      if (f) fuelTypes.push(f);
    }
  }

  // XtraPower figures: the XP_Points / XP_TDS / XP_Net names (or their labels)
  const byLabel = (re) => {
    const { cols } = bounds(ws);
    for (let r = 1; r <= rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        if (re.test(cellText(cellAt(ws, `${colName(c)}${r}`)))) return cellNum(cellAt(ws, `${colName(c + 1)}${r}`));
      }
    }
    return null;
  };
  const xp = {
    points: cellNum(definedCell(wb, 'XP_Points')) ?? byLabel(/points earned/i) ?? DEFAULT_XP.points,
    tds: cellNum(definedCell(wb, 'XP_TDS')) ?? byLabel(/tds deducted/i) ?? DEFAULT_XP.tds,
  };
  xp.net = cellNum(definedCell(wb, 'XP_Net')) ?? byLabel(/net points/i) ?? xp.points * (1 - xp.tds);
  const rspTier = rateCard.find((t) => t.tier === HSD_TIER);
  const hsd_rsp = cellNum(definedCell(wb, 'HSD_RSP')) ?? (rspTier ? rspTier.rate : null);

  const customers = [];
  const seen = new Set();
  for (let r = 2; r <= rows; r++) {
    const company = keep(at(r, 'Company'));
    if (!company || seen.has(company.toLowerCase())) continue;
    seen.add(company.toLowerCase());
    const tier = keep(at(r, 'Price Tier'));
    let rate = cellNum(at(r, 'HSD'));
    if (rate == null) { const t = rateCard.find((x) => x.tier === tier); rate = t ? t.rate : null; }
    customers.push({
      company,
      hsd_rate: rate,
      address: ['Address 1', 'Address 2', 'Address 3'].map((n) => keep(at(r, n))),
      payment: ['Payment 1', 'Payment 2', 'Payment 3', 'Payment 4', 'Payment 5'].map((n) => keep(at(r, n))),
      po_label: keep(at(r, 'PO Label')), po_no: keep(at(r, 'PO No.')), price_tier: tier,
    });
  }
  if (!customers.length) throw new Error('No customers in the Customers table. Open the workbook in Excel, save it, and import again.');

  // Quotation Maker: its inputs (the yellow cells beside the page) and wording
  const quote = { valid_till: '', contact: '', email: '', dispatch: '', fleet: '' };
  const qm = wb.Sheets['Quotation Maker'];
  if (qm) {
    const want = { 'valid till': 'valid_till', 'contact no': 'contact', email: 'email', dispatch: 'dispatch', 'fleet available': 'fleet' };
    const { rows: qr, cols: qc } = bounds(qm);
    for (let r = 1; r <= qr; r++) {
      for (let c = 6; c < qc - 1; c++) {            // the helper block is to the right of A:F
        const key = want[label(cellText(cellAt(qm, `${colName(c)}${r}`)))];
        if (key && !quote[key]) quote[key] = xlTrim(cellText(cellAt(qm, `${colName(c + 1)}${r}`)));
      }
    }
  } else warnings.push('No "Quotation Maker" sheet — quotations use the app\'s own wording.');

  const pi = wb.Sheets['Proforma Invoice'];
  if (!pi) warnings.push('No "Proforma Invoice" sheet — proforma invoices use the app\'s own wording.');
  const texts = { quotation: sheetTexts(qm, LAYOUTS.quotation), proforma: sheetTexts(pi, LAYOUTS.proforma) };
  const pi_sheet = pi ? {
    pi_no: xlTrim(cellText(cellAt(pi, 'G4'))),
    place: xlTrim(cellText(cellAt(pi, 'G9'))),
    hsn: xlTrim(cellText(cellAt(pi, 'D19'))),
    contact: cellText(cellAt(pi, 'E16')),
    description: xlTrim(cellText(cellAt(pi, 'B19'))),
  } : {};

  const pi_log = readPiLog(wb.Sheets['PI Log'], warnings);

  return {
    customers,
    data: {
      rate_card: rateCard, product_rates: productRates, fuel_types: fuelTypes, xp, hsd_rsp,
      quote, texts, pi_sheet,
    },
    pi_log,
    warnings,
  };
}

// The fixed wording of a sheet, read at the cells the layout prints it in.
function sheetTexts(ws, layout) {
  if (!ws) return {};
  const out = {};
  for (const [a, cell] of Object.entries(layout.cells)) {
    if (cell.t == null) continue;
    const c = ws[a];
    if (c && c.f) continue;                              // turned into a formula: keep the layout's
    const t = cellText(c);
    if (t !== cell.t) out[a] = t;
  }
  return out;
}

const PI_COLS = {
  log_id: 'log id', pi_no: 'pi no', pi_date: 'pi date', valid_to: 'valid up to', customer: 'customer', gstin: 'buyer gstin',
  place: 'place of supply', po_no: 'p.o. no', po_date: 'p.o. date', description: 'description', hsn: 'hsn code',
  qty: 'quantity (ltr)', rate: 'rate (₹/ltr)', rsp: 'iocl rsp (₹/ltr)', sub_total: 'sub total (₹)', round_off: 'round off (₹)',
  grand_total: 'grand total (₹)', points: 'xtrapower points', words: 'amount in words', contact: 'contact person',
  printed_at: 'printed on', printed_by: 'printed by',
};
function readPiLog(ws, warnings) {
  if (!ws) return [];
  const h = headers(ws);
  const col = Object.fromEntries(Object.entries(PI_COLS).map(([k, name]) => [k, h.get(name)]));
  if (col.pi_no == null) { warnings.push('The PI Log sheet has no "PI No." column, so the log wasn\'t copied.'); return []; }
  const { rows } = bounds(ws);
  const out = [];
  for (let r = 2; r <= rows; r++) {
    const get = (k) => (col[k] == null ? null : cellAt(ws, `${colName(col[k])}${r}`));
    const piNo = xlTrim(cellText(get('pi_no')));
    if (!piNo) continue;
    const num = (k) => cellNum(get(k));
    const date = (k) => { const c = get(k); return c && typeof c.v === 'number' ? serialToIso(c.v) : null; };
    const txt = (k) => cellText(get(k));
    out.push({
      log_id: num('log_id'), pi_no: piNo, pi_date: date('pi_date'), valid_to: date('valid_to'), customer: xlTrim(txt('customer')),
      gstin: txt('gstin'), place: txt('place'), po_no: xlTrim(txt('po_no')), po_date: date('po_date'),
      description: txt('description'), hsn: txt('hsn'), qty: num('qty'), rate: num('rate'), rsp: num('rsp'),
      sub_total: num('sub_total'), round_off: num('round_off'), grand_total: num('grand_total'), points: num('points'),
      words: txt('words'), contact: txt('contact'),
      printed_at: (() => { const c = get('printed_at'); return c && typeof c.v === 'number' ? serialToStamp(c.v) : null; })(),
      printed_by: txt('printed_by'),
    });
  }
  return out;
}

// ---- the workbook's pictures -------------------------------------------------------
// files: {path: text} of xl/workbook.xml, its rels, the sheets' rels and the
// drawings (+ rels). Returns {quotation: {letterhead, stamp}, proforma: {...}}
// with the xl/media/... path of each picture: the one in row 1 is the
// letterhead, the one lower down the stamp.
export function picturePaths(files) {
  const wbXml = files['xl/workbook.xml'] || '';
  const wbRels = files['xl/_rels/workbook.xml.rels'] || '';
  const target = (rels, id) => {
    const m = new RegExp(`<Relationship[^>]*Id="${id}"[^>]*>`).exec(rels);
    const t = m && /Target="([^"]+)"/.exec(m[0]);
    return t ? t[1] : null;
  };
  const resolve = (base, rel) => {
    if (rel.startsWith('/')) return rel.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const p of rel.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
    return parts.join('/');
  };
  const out = {};
  for (const [key, sheetName] of [['quotation', 'Quotation Maker'], ['proforma', 'Proforma Invoice']]) {
    const sm = new RegExp(`<sheet [^>]*name="${sheetName}"[^>]*r:id="(rId\\d+)"`).exec(wbXml);
    if (!sm) continue;
    const sheetPath = resolve('xl/workbook.xml', target(wbRels, sm[1]) || '');
    const sheetRels = files[sheetPath.replace(/([^/]+)$/, '_rels/$1.rels')] || '';
    const dm = /Target="([^"]*drawings\/drawing\d+\.xml)"/.exec(sheetRels);
    if (!dm) continue;
    const drawingPath = resolve(sheetPath, dm[1]);
    const drawing = files[drawingPath] || '';
    const dRels = files[drawingPath.replace(/([^/]+)$/, '_rels/$1.rels')] || '';
    const pics = {};
    for (const a of drawing.match(/<xdr:twoCellAnchor[\s\S]*?<\/xdr:twoCellAnchor>/g) || []) {
      const embed = /<a:blip[^>]*r:embed="(rId\d+)"/.exec(a);
      const row = /<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(a);
      if (!embed || !row) continue;
      const media = target(dRels, embed[1]);
      if (!media) continue;
      pics[Number(row[1]) === 0 ? 'letterhead' : 'stamp'] = resolve(drawingPath, media);
    }
    out[key] = pics;
  }
  return out;
}
