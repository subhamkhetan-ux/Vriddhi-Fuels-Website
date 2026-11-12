// Quotes: what the app keeps of the Tanker Billing workbook besides its
// sheets (those are read by xl-model.js and worked out by formula.js):
//   readTankerBilling() — the Customers table (also the Tanker Master for
//                         Daily Tanker Bills) and the PI Log sheet
//   the PI Log's rules  — next PI No., reprint filter, the check of Excel's
//                         PI Log against the app's, file names
// Pure: tested in node (tests/ledger_web/quote.test.mjs).

import { fyOf } from './util.js';

// ---- small Excel look-alikes ------------------------------------------------
export const xlRound = (x, d = 0) => { const k = 10 ** d; const v = Math.abs(Number(x) || 0) * k; return Math.sign(Number(x) || 0) * Math.round(v + 1e-9) / k; };
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
export const piFileName = (customer, iso, word = 'PI') => `${cleanName(`${firstTwoWords(customer) || 'Customer'} ${word} ${longDate(iso)}`)}.pdf`;
export const quoteFileName = (customer, iso) => `${cleanName(`${firstTwoWords(customer) || 'Customer'} Quotation ${longDate(iso)}`)}.pdf`;

// The PI Log's derived columns: Discount = RSP − Rate, Effective = (Grand − Points) / Qty
export const piDiscount = (row) => (row.rsp == null || row.rsp === '' ? null : Number(row.rsp) - Number(row.rate));
export const piEffective = (row) => (Number(row.qty) ? (Number(row.grand_total) - Number(row.points || 0)) / Number(row.qty) : null);

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
export const headerLabel = label;


// wb: a SheetJS workbook. Returns {customers, pi_log, warnings}.
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

  const customers = [];
  const seen = new Set();
  for (let r = 2; r <= rows; r++) {
    const company = keep(at(r, 'Company'));
    if (!company || seen.has(company.toLowerCase())) continue;
    seen.add(company.toLowerCase());
    const tier = keep(at(r, 'Price Tier'));
    const rate = cellNum(at(r, 'HSD'));
    customers.push({
      company,
      hsd_rate: rate,
      address: ['Address 1', 'Address 2', 'Address 3'].map((n) => keep(at(r, n))),
      payment: ['Payment 1', 'Payment 2', 'Payment 3', 'Payment 4', 'Payment 5'].map((n) => keep(at(r, n))),
      po_label: keep(at(r, 'PO Label')), po_no: keep(at(r, 'PO No.')), price_tier: tier,
    });
  }
  if (!customers.length) throw new Error('No customers in the Customers table. Open the workbook in Excel, save it, and import again.');

  const pi_log = readPiLog(wb.Sheets['PI Log'], warnings);

  return {
    customers,
    pi_log,
    warnings,
  };
}

export const PI_COLUMNS = {
  log_id: 'log id', pi_no: 'pi no', pi_date: 'pi date', valid_to: 'valid up to', customer: 'customer', gstin: 'buyer gstin',
  place: 'place of supply', po_no: 'p.o. no', po_date: 'p.o. date', description: 'description', hsn: 'hsn code',
  qty: 'quantity (ltr)', rate: 'rate (₹/ltr)', rsp: 'iocl rsp (₹/ltr)', sub_total: 'sub total (₹)', round_off: 'round off (₹)',
  grand_total: 'grand total (₹)', points: 'xtrapower points', words: 'amount in words', contact: 'contact person',
  printed_at: 'printed on', printed_by: 'printed by',
};
// A date typed as text (as a pasted row brings it): "31 Oct 2026",
// "03/11/2026" or "3/11/2026" (day first), "2026-11-03". null otherwise.
const MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const isoOf = (y, m, d) => {
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};
export function textDate(s) {
  const t = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return isoOf(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/.exec(t);
  if (m) return isoOf(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -,]+(\d{4})\b/.exec(t);
  if (m && MON3.includes(m[2].toLowerCase())) return isoOf(+m[3], MON3.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
}
// "4/11/2026, 2:19:12 PM" / "04/11/2026 14:19" -> India time, like Excel's clock
export function textStamp(s) {
  const t = String(s ?? '').trim();
  const day = textDate(t);
  if (!day) return null;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*$/.exec(t);
  let h = m ? Number(m[1]) : 0;
  if (m && m[4]) { const pm = /p/i.test(m[4]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  const two = (n) => String(n).padStart(2, '0');
  return `${day}T${two(h)}:${m ? m[2] : '00'}:${m && m[3] ? m[3] : '00'}+05:30`;
}

function readPiLog(ws, warnings) {
  if (!ws) return [];
  const h = headers(ws);
  const col = Object.fromEntries(Object.entries(PI_COLUMNS).map(([k, name]) => [k, h.get(name)]));
  if (col.pi_no == null) { warnings.push('The PI Log sheet has no "PI No." column, so the log wasn\'t copied.'); return []; }
  const { rows } = bounds(ws);
  const out = [];
  const textRows = [];
  for (let r = 2; r <= rows; r++) {
    const get = (k) => (col[k] == null ? null : cellAt(ws, `${colName(col[k])}${r}`));
    const piNo = xlTrim(cellText(get('pi_no')));
    if (!piNo) continue;
    const num = (k) => cellNum(get(k));
    let typed = false;
    const date = (k) => {
      const c = get(k);
      if (c && typeof c.v === 'number') return serialToIso(c.v);
      const d = c ? textDate(c.v) : null;
      if (d) typed = true;
      return d;
    };
    const txt = (k) => cellText(get(k));
    out.push({
      log_id: num('log_id'), pi_no: piNo, pi_date: date('pi_date'), valid_to: date('valid_to'), customer: xlTrim(txt('customer')),
      gstin: txt('gstin'), place: txt('place'), po_no: xlTrim(txt('po_no')), po_date: date('po_date'),
      description: txt('description'), hsn: txt('hsn'), qty: num('qty'), rate: num('rate'), rsp: num('rsp'),
      sub_total: num('sub_total'), round_off: num('round_off'), grand_total: num('grand_total'), points: num('points'),
      words: txt('words'), contact: txt('contact'),
      printed_at: (() => {
        const c = get('printed_at');
        if (c && typeof c.v === 'number') return serialToStamp(c.v);
        const t = c ? textStamp(c.v) : null;
        if (t) typed = true;
        return t;
      })(),
      printed_by: txt('printed_by'),
    });
    if (typed) textRows.push(r);
  }
  if (textRows.length) {
    warnings.push(`PI Log ${textRows.length === 1 ? 'row' : 'rows'} ${textRows.join(', ')}: the dates are text, not Excel dates — read as dates here; in Excel, format those cells as dates (or paste rows from the app's Download log, which now has real dates).`);
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
  for (const [key, sheetName] of [['quotation', 'Quotation Maker'], ['proforma', 'Proforma Invoice'], ['creditnote', 'Bank Pay CrNote']]) {
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
