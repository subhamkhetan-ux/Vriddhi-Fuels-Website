// Reads the Trip Register workbook (Trip_Register.xlsm) into plain data.
//
// Every sheet is found by its header row, and every column by its header text,
// so moving or adding columns in Excel doesn't break the app. The workbook's
// own formulas stay the rules: the cached values Excel saved (Trip Bhada, SSFC
// Net Amount, Income/Trip, the SSFC diesel picked up from HSD Data …) are read
// as they are, and only filled in by the same formula when a cell is blank.
//
// book = { sheets: { 'Trip Register': { rows: [[...], ...], r0: 1 }, ... },
//          formulas: { 'Recon Engine!J2': '=IF(...)' } }
// rows are what SheetJS sheet_to_json(ws, { header: 1, raw: true }) gives
// (dates as Excel serial numbers); r0 is the sheet row number of rows[0].

import { num, round2, toIso, monthOf } from './util.js';

const key = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- column specs (normalised header text; first alias that matches wins) ----------
const TRIP_COLS = {
  sno: ['sno'], trip: ['tripno'], veh: ['vehicleno'], start: ['tripstartdate'], loadDate: ['loadingdate'],
  loadWt: ['loadweight'], unloadDate: ['unloaddate'], unloadWt: ['unloadweight'], diff: ['excessshort'],
  port: ['loadingport'], dest: ['destination'], tare: ['tareweight'], gross: ['grossweight'], rate: ['priceton', 'rate'],
  bhada: ['tripbhada', 'freight'], ssfcLtr: ['ssfcdieselltr'], ssfcAmt: ['ssfcdieselamount', 'ssfcdieselamt'],
  extraLtr: ['extrahsdltr', 'extarhsdltr'], extraAmt: ['extrahsdamt', 'extarhsdamt', 'extrahsdamount'],
  ownLtr: ['tripdieselltr'], ownAmt: ['tripdieselamount', 'tripdieselamt'], urea: ['ownurea'],
  drvExtra: ['extraowndriverpay'], drvTrip: ['tripdriverpayment'], drvSsfc: ['driverssfcpayment'],
  docOwn: ['owndocumentexp'], ssfcMisc: ['ssfcmisc'], ownMisc: ['ownmisckharcha', 'ownmisc'],
  receivable: ['ssfcreceivable'], fastag: ['fastag'], maint: ['maintainance', 'maintenance'], tyre: ['tyre', 'tyres'],
  lessOver: ['lessoverunload'], rtoEntry: ['rtoentry'], rtoChallan: ['rtochallan'], shortage: ['shortage'],
  docExp: ['documentexpense'], ssfcNet: ['ssfcnetamount'], emi: ['installment', 'instalment', 'emi'],
  income: ['incometrip', 'income'], drvDebit: ['driverdebit'], remarks: ['remarks', 'remark'],
};
// money columns SSFC takes out of the freight (the SSFC Net Amount formula)
export const SSFC_DEDUCTIONS = ['ssfcAmt', 'drvSsfc', 'ssfcMisc', 'fastag', 'maint', 'tyre', 'lessOver', 'rtoEntry', 'rtoChallan', 'shortage', 'docExp'];
// money the firm spends itself (the rest of the Income/Trip formula)
export const OWN_EXPENSES = ['extraAmt', 'ownAmt', 'urea', 'drvExtra', 'drvTrip', 'docOwn', 'ownMisc', 'emi'];
const TRIP_NUMS = ['loadWt', 'unloadWt', 'diff', 'tare', 'gross', 'rate', 'bhada', 'ssfcLtr', 'extraLtr', 'ownLtr',
  ...SSFC_DEDUCTIONS, ...OWN_EXPENSES, 'receivable', 'ssfcNet', 'income', 'drvDebit'];

const LEDGER_COLS = {
  month: ['month'], veh: ['vehicleno'], net: ['ssfcbasenetamount', 'ssfcnetamount'], hireBase: ['hiringbaseamount'],
  igst: ['hiringigst'], hireTotal: ['hiringtotal'], diffCash: ['diffnaht', 'diff'], marketHsd: ['markethsd'],
  ownDiesel: ['owndiesel'], paidCash: ['paidincash'], balCash: ['balanceincash'],
  paidAcct: ['paidinsslaccount', 'paidinaccount', 'paidinssl'], balAcct: ['balanceinaccount'],
  invoice: ['invoiceno'], paidDate: ['paiddate'], remarks: ['remarks'],
};
const HSD_COLS = {
  date: ['date'], bill: ['billno'], veh: ['vehicle', 'vehicleno'], qty: ['quantity', 'qty'], rsp: ['rsp', 'rate'],
  amount: ['amount'], source: ['roname'], location: ['location'], trip: ['tripid'],
};
const UREA_COLS = {
  date: ['date'], bill: ['particulars'], veh: ['vehicle', 'vehicleno'], qty: ['quantity', 'qty'], price: ['price', 'rate'],
  amount: ['amount'], location: ['location'], trip: ['tripid'], by: ['purchasedby'], from: ['purchasedfrom'], details: ['tripdetails'],
};
const RATE_COLS = {
  port: ['location'], dest: ['company'], rate: ['rate'], diesel: ['diesel'], driver: ['driverpayment'], driverExtra: ['driverextrapay'],
};

// Column index for each spec key. Only the first block of headers counts (the
// pivots Excel keeps to the right of a table repeat some header names).
function mapColumns(header, spec) {
  const keys = header.map(key);
  let end = keys.length;
  let seen = false;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]) seen = true;
    else if (seen && !keys[i] && !keys[i + 1]) { end = i; break; }       // two blank headers end the table
  }
  const cols = {};
  const used = new Set();
  for (const [k, aliases] of Object.entries(spec)) {
    let at = -1;
    for (const a of aliases) {
      at = keys.findIndex((h, i) => i < end && !used.has(i) && h === a);
      if (at < 0) at = keys.findIndex((h, i) => i < end && !used.has(i) && h.startsWith(a));
      if (at >= 0) break;
    }
    if (at >= 0) { cols[k] = at; used.add(at); }
  }
  return cols;
}

function findHeader(rows, must, maxScan = 12) {
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const keys = (rows[i] || []).map(key);
    if (must.every((m) => keys.some((k) => k === m || k.startsWith(m)))) return i;
  }
  return -1;
}

function findSheet(book, names, must) {
  const all = Object.keys(book.sheets || {});
  const byName = all.find((n) => names.some((x) => key(n) === key(x)));
  if (byName && findHeader(book.sheets[byName].rows, must) >= 0) return byName;
  return all.find((n) => findHeader(book.sheets[n].rows, must) >= 0) || null;
}

const text = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const cell = (row, i) => (i == null || !row ? null : row[i]);
const isBlank = (v) => v == null || (typeof v === 'string' && !v.trim());

function table(book, names, must, spec) {
  const name = findSheet(book, names, must);
  if (!name) return { name: null, records: [] };
  const { rows, r0 = 1 } = book.sheets[name];
  const h = findHeader(rows, must);
  const cols = mapColumns(rows[h], spec);
  const records = [];
  for (let i = h + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const rec = { row: r0 + i };
    for (const [k, c] of Object.entries(cols)) rec[k] = cell(row, c);
    records.push(rec);
  }
  return { name, records, cols };
}

// ---- Trip Register ---------------------------------------------------------------------
export function tripStatus(t) {
  if (t.unloadDate) return 'done';
  if (t.loadDate) return 'loaded';
  return 'empty';
}

function readTrips(book, warn) {
  const { name, records, cols } = table(book, ['Trip Register'], ['tripno', 'vehicleno'], TRIP_COLS);
  if (!name) throw new Error('This file has no Trip Register sheet (a sheet with “TRIP No” and “Vehicle No” headings).');
  for (const k of ['loadDate', 'loadWt', 'bhada', 'ssfcNet', 'income']) {
    if (cols[k] == null) warn.push(`Trip Register has no “${k}” column — those figures will be blank.`);
  }
  const trips = [];
  for (const r of records) {
    const trip = text(r.trip);
    const veh = text(r.veh).toUpperCase().replace(/\s+/g, '');
    if (!trip || !veh) continue;
    const t = {
      row: r.row, sno: typeof r.sno === 'number' ? r.sno : null, trip, veh,
      start: toIso(r.start), loadDate: toIso(r.loadDate), unloadDate: toIso(r.unloadDate),
      port: text(r.port), dest: text(r.dest), remarks: text(r.remarks),
    };
    for (const k of TRIP_NUMS) {
      const v = r[k];
      if (!isBlank(v) && typeof v !== 'object') {
        const n = num(v);
        if (n) t[k] = n;
      }
    }
    // the sheet's formulas, for any cell Excel left without a value
    if (t.bhada == null && t.loadWt && t.rate) t.bhada = round2(t.loadWt * t.rate);
    if (t.bhada) {
      if (t.ssfcNet == null) t.ssfcNet = round2(t.bhada - SSFC_DEDUCTIONS.reduce((a, k) => a + (t[k] || 0), 0));
      if (t.income == null) t.income = round2(t.ssfcNet - OWN_EXPENSES.reduce((a, k) => a + (t[k] || 0), 0));
    }
    if (t.unloadWt && t.loadWt && t.diff == null) t.diff = round2(t.unloadWt - t.loadWt);
    t.month = monthOf(t.loadDate);
    t.status = tripStatus(t);
    trips.push(t);
  }
  if (!trips.length) throw new Error('The Trip Register sheet has no trips.');
  return trips;
}

// ---- SSFC account (the Ledger sheet) ----------------------------------------------------
function readSsfc(book) {
  const { name, records } = table(book, ['Ledger'], ['month', 'vehicleno', 'ssfcbasenetamount'], LEDGER_COLS);
  if (!name) return null;
  const rows = [];
  for (const r of records) {
    const veh = text(r.veh).toUpperCase().replace(/\s+/g, '');
    const month = monthOf(toIso(r.month));
    if (!veh || !month) continue;
    const x = { month, veh, invoice: text(r.invoice), paidDate: toIso(r.paidDate), remarks: text(r.remarks) };
    for (const k of ['net', 'hireBase', 'igst', 'hireTotal', 'diffCash', 'marketHsd', 'ownDiesel', 'paidCash', 'paidAcct']) {
      const n = num(r[k]);
      if (n) x[k] = n;
    }
    if (x.hireTotal == null && (x.hireBase || x.igst)) x.hireTotal = round2((x.hireBase || 0) + (x.igst || 0));
    rows.push(x);
  }
  // the party (A1) and the notes kept beside the table
  const sheet = book.sheets[name].rows;
  const title = text((sheet[0] || [])[0]);
  const gst = title.match(/\(([0-9A-Z]{15})\)/);
  const party = { name: title.replace(/\(.*\)/, '').trim() || 'SS Freight Carrier', gstin: gst ? gst[1] : '' };
  const memos = [];
  const workbook = {};
  sheet.forEach((row) => (row || []).forEach((v, c) => {
    if (typeof v !== 'string' || c < 16) return;
    const label = text(v);
    const next = row.slice(c + 1, c + 4).find((x) => typeof x === 'number');
    if (next == null) return;
    const k = key(label);
    if (k.includes('bridgestone')) memos.push({ label, amount: next });
    else if (k === 'total' && workbook.total == null) workbook.total = next;
    else if (k.startsWith('basebalanceoutstanding')) workbook.exGst = next;
    else if (k.startsWith('sslgstbilling')) workbook.gst = next;
  }));
  return { party, rows, memos, workbook };
}

// ---- HSD Data, Urea DEF, Rates ----------------------------------------------------------
function readHsd(book) {
  const { records } = table(book, ['HSD Data'], ['date', 'vehicle', 'quantity', 'roname'], HSD_COLS);
  return records.map((r) => ({
    date: toIso(r.date), bill: text(r.bill), veh: text(r.veh).toUpperCase().replace(/\s+/g, ''),
    qty: num(r.qty), rsp: num(r.rsp), amount: num(r.amount), source: text(r.source), location: text(r.location), trip: text(r.trip),
  })).filter((r) => r.date && r.veh && (r.qty || r.amount));
}

function readUrea(book) {
  const { records } = table(book, ['Urea DEF', 'Urea'], ['date', 'vehicle', 'quantity', 'purchasedfrom'], UREA_COLS);
  return records.map((r) => ({
    date: toIso(r.date), bill: text(r.bill), veh: text(r.veh).toUpperCase().replace(/\s+/g, ''), qty: num(r.qty),
    price: num(r.price), amount: num(r.amount), location: text(r.location), trip: text(r.trip), from: text(r.from), details: text(r.details),
  })).filter((r) => r.date && r.veh && (r.qty || r.amount));
}

function readRates(book) {
  const { records } = table(book, ['Rates'], ['location', 'company', 'diesel'], RATE_COLS);
  return records.filter((r) => text(r.port) && text(r.dest)).map((r) => ({
    port: text(r.port), dest: text(r.dest), rate: num(r.rate), diesel: num(r.diesel), driver: num(r.driver), driverExtra: num(r.driverExtra),
  }));
}

// The diesel reconciliation (Recon Engine sheet). Excel's own figures for each
// trip it covers are kept as they are — the underload rule changed over time
// (56 T, later 58 T) and some allowances are typed by hand — and the rule of
// its newest formula is used only for trips past the end of that sheet.
const RECON_COLS = {
  row: ['trrow'], veh: ['vehicle'], base: ['basediesel'], over: ['overload'], under: ['underload'],
  allotted: ['allotted'], issued: ['issued'], balance: ['tripbalance'],
};
function readReconRules(book) {
  const rules = { fromRow: null, underloadFromRow: null, overloadOver: 58, underloadBelow: 58, perTonne: 5, noUnderloadPorts: ['Gangavaram'], rows: {}, lastRow: null };
  const { name, records } = table(book, ['Recon Engine'], ['trrow', 'vehicle'], RECON_COLS);
  if (name) {
    for (const r of records) {
      if (typeof r.row !== 'number') continue;
      if (rules.fromRow == null) rules.fromRow = r.row;
      rules.lastRow = r.row;
      if (typeof r.allotted !== 'number') continue;                // no gross weight yet
      rules.rows[r.row] = [num(r.base), num(r.over), num(r.under), num(r.allotted)];
    }
  }
  const f = Object.entries(book.formulas || {}).find(([k]) => /recon\s*engine!J$/i.test(k));
  if (f) {
    const m = f[1].match(/\$A\d+\s*>=\s*(\d+)/);
    if (m) rules.underloadFromRow = Number(m[1]);
    const lo = f[1].match(/ROUND\(\$G\d+,0\)\s*<\s*([\d.]+)/);
    if (lo) rules.underloadBelow = Number(lo[1]);
  }
  if (rules.underloadFromRow == null) rules.underloadFromRow = rules.fromRow;
  return rules;
}

// The workbook's own Diesel Recon total, to check the app's sum against.
function readReconTotal(book) {
  const name = Object.keys(book.sheets || {}).find((n) => key(n) === 'dieselrecon');
  if (!name) return null;
  for (const row of book.sheets[name].rows.slice(0, 40)) {
    if (row && key(row[0]) === 'total' && typeof row[1] === 'number') return row[1];
  }
  return null;
}

// The Driver Payment sheet: every advance the firm paid a driver (date,
// vehicle, amount, driver, and a note typed beside it), and next to it the
// drivers list — who drives each truck now. The Trip Register's Trip Driver
// Payment adds up these payments between a trip's start and the vehicle's
// next trip start, so the payee names say who was driving which trip.
// Only names are kept from the drivers list (no licence or bank details).
const PAY_COLS = { date: ['date'], veh: ['vehicleno'], amount: ['amountpaid', 'amount'], name: ['drivername'] };
const plate = (v) => text(v).toUpperCase().replace(/\s+/g, '');
function readDriverPay(book) {
  const out = { payments: [], roster: [] };
  const { name, records, cols } = table(book, ['Driver Payment'], ['date', 'vehicleno', 'amountpaid', 'drivername'], PAY_COLS);
  if (!name) return out;
  const { rows, r0 = 1 } = book.sheets[name];
  const h = findHeader(rows, ['date', 'vehicleno', 'amountpaid', 'drivername']);
  const keys = (rows[h] || []).map(key);
  const last = Math.max(...Object.values(cols));
  // the drivers list: a Driver Name column with Vehicle Number right of it, past the payments
  const rv = keys.findIndex((k, i) => i > last && k === 'vehiclenumber');
  const rn = rv < 0 ? -1 : keys.lastIndexOf('drivername', rv);
  const noteEnd = rn > last ? rn : last + 4;
  for (const r of records) {
    const date = toIso(r.date);
    const veh = plate(r.veh);
    const amount = num(r.amount);
    const who = text(r.name);
    if (!date || !veh || !amount) continue;
    const row = rows[r.row - r0] || [];
    const note = row.slice(last + 1, noteEnd).map(text).filter((x) => x && !/^[\d.,₹\s-]+$/.test(x)).join(' · ');
    out.payments.push({ row: r.row, date, veh, amount, name: who, note });
  }
  if (rn > last) {
    for (let i = h + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const who = text(row[rn]);
      const veh = plate(row[rv]);
      if (who && /^[A-Z]{2}\d/.test(veh)) out.roster.push({ veh, name: who });
    }
  }
  return out;
}

// ---- everything ---------------------------------------------------------------------------
export function extractFleet(book, { fileName = '' } = {}) {
  const warnings = [];
  const trips = readTrips(book, warnings);
  const ssfc = readSsfc(book);
  if (!ssfc) warnings.push('No Ledger sheet (SSFC account) — the SSFC tab will be empty.');
  const hsd = readHsd(book);
  const urea = readUrea(book);
  const rates = readRates(book);
  const recon = readReconRules(book);
  const { payments: driverPay, roster } = readDriverPay(book);
  const dated = trips.map((t) => t.loadDate || t.start).filter(Boolean).sort();
  return {
    version: 1,
    fileName,
    readAt: new Date().toISOString(),
    latest: dated[dated.length - 1] || null,
    trips, ssfc, hsd, urea, rates, recon, driverPay, roster,
    checks: { ssfcTotal: ssfc ? ssfc.workbook.total ?? null : null, ssfcExGst: ssfc ? ssfc.workbook.exGst ?? null : null, reconTotal: readReconTotal(book) },
    warnings,
  };
}

// SheetJS workbook -> the `book` shape above (browser and tests)
export function bookFromSheetJS(XLSX, wb) {
  const sheets = {};
  const formulas = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) { sheets[name] = { rows: [], r0: 1 }; continue; }
    const range = XLSX.utils.decode_range(ws['!ref']);
    sheets[name] = { rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true }), r0: range.s.r + 1 };
    if (/recon\s*engine/i.test(name)) {                         // the newest underload rule
      for (let r = range.e.r; r > range.s.r; r--) {
        const c = ws[XLSX.utils.encode_cell({ r, c: 9 })];
        if (c && c.f) { formulas[`${name}!J`] = `=${c.f}`; break; }
      }
    }
  }
  return { sheets, formulas };
}
