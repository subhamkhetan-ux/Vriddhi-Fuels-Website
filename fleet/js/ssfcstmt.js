// SSFC's monthly account statement ("SHREE SHYAM LOGISTIC SEP- 2026"), read
// without trusting its layout: SSFC's template shifts from month to month
// (the header on row 3 or 4, extra columns, a label one column off, dates
// typed as text or saved day-and-month swapped), so every column is found by
// its heading and every value by what it looks like, not by a fixed letter.
//
//   readStatement(book)   the main sheet: for each vehicle its trips (LR no.,
//                         loading / unloading date and weight, SSFC's pump
//                         diesel, pump cash, Vriddhi diesel, cash office,
//                         freight rate, the row's total), its deduction lines
//                         (fastag, maintenance, tyre … — and any new label,
//                         kept as it is) and the NET AMOUNT; the expense
//                         sheet(s) — every bill behind those deductions
//                         (date, bill no., vehicle, what, head, qty, rate,
//                         amount), with DEF / AdBlue picked out however it's
//                         spelt; the LD (late delivery) sheet
//   statementFromText()   the same from a PDF's text (the older months)
//   kindOf(), defLine()   what a label or a bill is
// book: { sheets: { name: { rows: [[…]], r0 } } } (parse.js bookFromSheetJS). Pure functions.

import { serialToIso } from './util.js';

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_WORDS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const r2 = (n) => Math.round(n * 100) / 100;
const up = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// a number however it was typed: 1,980 / "1980.00" / " 28471.04 "
export function numOf(v) {
  if (isNum(v)) return v;
  const s = String(v ?? '').replace(/[,₹\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
// a vehicle no. → as kept (XX01AB1001); null when it isn't one
export function vehOf(v) {
  const s = String(v ?? '').toUpperCase().replace(/[\s.-]+/g, '');
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(s) ? s : null;
}
const hasVeh = (v) => /[A-Z]{2}\s*\d{1,2}\s*[A-Z]{0,3}\s*\d{3,4}/i.test(String(v ?? ''));
const ym = (iso) => (iso ? iso.slice(0, 7) : null);
const monthsApart = (a, b) => Math.abs((Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7))) - (Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7))));
const isoOf = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

// A date as SSFC wrote it, read against the statement's month: a saved date
// whose day and month were swapped (9 Dec for 12 Sep), a text date in either
// order, a wrong year (22.01.25 in a 2026 statement) are put right, and
// said so. → { iso, fixed: '' | 'swapped' | 'year' } or null
export function dateOf(v, month = null) {
  if (v == null || v === '' || v === 0) return null;
  let y; let m; let d;
  if (v instanceof Date) { y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate(); }
  else if (isNum(v)) {
    if (v < 20000 || v > 80000) return null;
    const s = serialToIso(v);
    [y, m, d] = s.split('-').map(Number);
  } else {
    const s = String(v).trim();
    let x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (x) [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
    else if ((x = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) {
      d = Number(x[1]); m = Number(x[2]); y = Number(x[3]) < 100 ? 2000 + Number(x[3]) : Number(x[3]);
    } else if ((x = s.match(new RegExp(`^(\\d{1,2})[\\s.\\-/]*(${MONTH_WORDS})[a-z]*[\\s.\\-/,']*(\\d{2,4})$`, 'i')))) {
      d = Number(x[1]); m = MON[x[2].slice(0, 3).toLowerCase()]; y = Number(x[3]) < 100 ? 2000 + Number(x[3]) : Number(x[3]);
    } else return null;
  }
  const plain = isoOf(y, m, d);
  if (!month) return plain ? { iso: plain, fixed: '' } : null;
  const near = (iso) => iso && monthsApart(ym(iso), month) <= 1;
  if (near(plain)) return { iso: plain, fixed: '' };
  const swapped = d <= 12 ? isoOf(y, d, m) : null;
  if (near(swapped)) return { iso: swapped, fixed: 'swapped' };
  for (const yy of [Number(month.slice(0, 4)), Number(month.slice(0, 4)) - 1, Number(month.slice(0, 4)) + 1]) {
    const a = isoOf(yy, m, d);
    if (near(a)) return { iso: a, fixed: 'year' };
    const b = d <= 12 ? isoOf(yy, d, m) : null;
    if (near(b)) return { iso: b, fixed: 'swapped' };
  }
  return plain ? { iso: plain, fixed: '', far: true } : null;
}

// A trip's loading and unloading dates, read together: SSFC types some dates month-first
// ("11/12/25" for 12 Nov). When either could be read both ways, take the reading where the truck
// unloads 0–20 days after it loads.
function swapOf(r) {
  if (!r) return null;
  const [y, m, d] = r.iso.split('-').map(Number);
  if (d > 12 || d === m) return null;
  const iso = isoOf(y, d, m);
  return iso ? { iso, fixed: r.fixed === 'swapped' ? '' : 'swapped' } : null;
}
export function tripDates(loadRaw, unloadRaw, month) {
  const l = dateOf(loadRaw, month);
  const u = dateOf(unloadRaw, month);
  if (!l || !u) return { l, u };
  const ok = (a, b) => { const g = (Date.parse(b.iso) - Date.parse(a.iso)) / 864e5; return g >= 0 && g <= 20 ? g : 1e3 + Math.abs(g); };
  let best = { l, u, s: ok(l, u) };
  for (const a of [l, swapOf(l)]) for (const b of [u, swapOf(u)]) {
    if (!a || !b) continue;
    const sc = ok(a, b) + (a === l ? 0 : 0.5) + (b === u ? 0 : 0.5);
    if (sc < best.s) best = { l: a, u: b, s: sc };
  }
  return { l: best.l, u: best.u };
}

// ---- what a deduction label or an expense head is ---------------------------------------------
// The Trip Register column each one goes to (the macro posts there too):
//   fastag AD · maint AE · tyre AF · lessOver AG · rtoEntry AH · rtoChallan AI · shortage AJ · docExp AK ·
//   anything else SSFC deducts (union, GPS, fooding, LD, a new label) → ssfcMisc AA · emi: never posted
//   (the firm pays its EMIs itself — SSFC deducting one is a flag)
export const KINDS = {
  fastag: { name: 'Fastag', col: 'AD' }, maint: { name: 'Maintenance', col: 'AE' }, tyre: { name: 'Tyre', col: 'AF' },
  lessOver: { name: 'Over / unload', col: 'AG' }, rtoEntry: { name: 'RTO entry', col: 'AH' }, rtoChallan: { name: 'RTO challan', col: 'AI' },
  shortage: { name: 'Shortage', col: 'AJ' }, docExp: { name: 'Document exp.', col: 'AK' },
  union: { name: 'Union', col: 'AA' }, gps: { name: 'GPS', col: 'AA' }, fooding: { name: 'Driver fooding', col: 'AA' },
  ld: { name: 'Late delivery (LD)', col: 'AA' }, penalty: { name: 'Penalty', col: 'AA' }, other: { name: 'Other', col: 'AA' },
  emi: { name: 'Instalment (EMI)', col: null },
};
export function kindOf(label) {
  const s = up(label).replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/\bNET\b/.test(s)) return 'net';
  if (/\bTOTAL\b/.test(s)) return 'total';
  if (/R\s?T\s?O/.test(s) && /CHAL|FINE|CHALL/.test(s)) return 'rtoChallan';
  if (/R\s?T\s?O/.test(s) && /ENT|TAX|PERMIT/.test(s)) return 'rtoEntry';
  if (/R\s?T\s?O/.test(s)) return 'rtoChallan';
  if (/FAST|TOLL/.test(s)) return 'fastag';
  if (/INSTAL|INSTL|\bEMI\b|LOAN/.test(s)) return 'emi';
  if (/TYRE|TIRE|TYER/.test(s)) return 'tyre';
  if (/OVER|UNLOAD|OVLD|OVERLAD/.test(s)) return 'lessOver';
  if (/DOC/.test(s)) return 'docExp';
  if (/UNION/.test(s)) return 'union';
  if (/GPS/.test(s)) return 'gps';
  if (/SHORT/.test(s)) return 'shortage';
  if (/\bLD\b|\bL D\b|LATE|DELAY|DETENTION/.test(s)) return 'ld';
  if (/PENAL|FINE/.test(s)) return 'penalty';
  if (/FOOD|KHANA|MEAL/.test(s)) return 'fooding';
  if (/MAINT|MAINTAN|MANT|REPAIR|DEEP|SERVICE|WORKSHOP/.test(s)) return 'maint';
  return 'other';
}
// DEF / AdBlue / urea, however SSFC spells it ("AD BLUE URIA", "URIA AD ABLUE TARA TRINI",
// "CLEARLUE 20 LTR", "DEF URIA LTR", "XX01AB1001,1002 & 1003 DEF")
export const DEF_RE = /AD\s*-?\s*BLUE|\bA\s*BLUE|ABLUE|ADBLUE|UREA|URIA|URIYA|YURIA|\bDEF\b|CLEAR\s*BLUE|CLEARLUE|CLEARBLUE/i;
export const defLine = (desc) => DEF_RE.test(String(desc || ''));
// litres in a description ("20 LTR", "CLEARLUE 20 LTR")
const litresIn = (desc) => { const m = String(desc || '').match(/(\d+(?:\.\d+)?)\s*(?:LTR|LTRS|LITRE|LITER|L)\b/i); return m ? Number(m[1]) : null; };

// ---- the statement month ------------------------------------------------------------------------
function monthFromText(s) {
  const t = String(s || '');
  const m = t.match(new RegExp(`(${MONTH_WORDS})[a-z]*[\\s.\\-'’,]*(\\d{4}|\\d{2})\\b`, 'i'));
  if (!m) return null;
  const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  const mo = MON[m[1].slice(0, 3).toLowerCase()];
  return y > 2000 && y < 2100 && mo ? `${y}-${String(mo).padStart(2, '0')}` : null;
}

// ---- the trips table ------------------------------------------------------------------------------
// a header row: one cell about the vehicle and one about loading (or the LR no.)
const isHeader = (row) => {
  const t = (row || []).map(up);
  return t.some((x) => /VEHICLE|TRUCK|LORRY/.test(x)) && t.some((x) => /LOADING|LOAD WT|LR NO|L\.R/.test(x));
};
// columns from the header row and the one under it (its sub-headings): each column's job
function columnsOf(h1, h2) {
  const n = Math.max(h1.length, h2.length);
  const cols = { pumps: [] };
  let group = null;          // the diesel group a column belongs to (row 1's label: "RAYAGADA DIESEL", "VRIDHHI FUEL")
  let pendingDate = null;    // a DATE just before a group starts belongs to that group
  const seen = [];
  for (let c = 0; c < n; c++) {
    const a = up(h1[c]);
    const b = up(h2[c]);
    const both = `${a} ${b}`.trim();
    if (!both) continue;
    seen.push([c, both]);
    if (a && /DIESEL|FUEL|HSD|PUMP|RAYAGADA|DASPALLA|VRID|MUNIGUDA|KORBA/.test(a) && !/DATE|QTY|AMOUNT|LTR/.test(a)) {
      group = { label: a, vriddhi: /VRID/.test(a), date: pendingDate === c - 1 ? pendingDate : null, qty: null, rate: null, amount: null, cash: null };
      cols.pumps.push(group);
      pendingDate = null;
    }
    if (/\bSL\b|S\.?\s?NO|SR\.?\s?NO/.test(both) && cols.sl == null) cols.sl = c;
    else if (/\bLR\b|L\.R|CHALLAN NO|BILTY/.test(both) && cols.lr == null) cols.lr = c;
    else if (/VEHICLE|TRUCK|LORRY/.test(both) && cols.veh == null) cols.veh = c;
    else if (/UNL|UNLD|UNLOAD/.test(both) && /WT|WEIGHT/.test(both)) cols.unloadWt = c;
    else if (/LOAD/.test(both) && /WT|WEIGHT/.test(both)) cols.loadWt = c;
    else if (/SHORT|EXCESS/.test(both)) cols.short = c;
    else if (/FRIEGHT|FREIGHT|RATE\b|BHADA/.test(both)) cols.rate = c;
    else if (/^TOTAL$|\bTOTAL\b/.test(both) && cols.total == null) cols.total = c;
    else if (/OFF.*CASH.*DATE|CASH.*DATE/.test(both)) cols.cashDate = c;
    else if (/CASH OFFICE|OFFICE CASH|CASH OFF\b|OFFICE/.test(both)) cols.cashOffice = c;
    else if (/\/\s*LTR|\/\s*LITRE|PER LTR|PER LITRE|RATE|RSP|PRICE/.test(b || a) && group) group.rate = c;
    else if (/QTY|QUANTITY|LTR|LITRE/.test(b || a) && group) group.qty = c;
    else if (/AMOUNT|AMT/.test(b || a) && group) group.amount = c;
    else if (/\bCASH\b/.test(b || a) && group) group.cash = c;
    else if (/DATE/.test(both)) {
      if (group && group.qty == null && group.date == null && b) group.date = c;
      else pendingDate = c;
      (cols.dates || (cols.dates = [])).push(c);
    }
  }
  // the loading and unloading dates: the DATE just left of each weight
  const before = (c) => (cols.dates || []).filter((d) => d < c).pop();
  if (cols.loadWt != null) cols.loadDate = before(cols.loadWt);
  if (cols.unloadWt != null) cols.unloadDate = before(cols.unloadWt);
  cols.seen = seen;
  return cols;
}

// one vehicle's deduction / net lines: a label, and the number to its right
function linesOf(rows, from, to, cols) {
  const out = [];
  for (let r = from; r < to; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (typeof v !== 'string' || !/[A-Z]/i.test(v) || vehOf(v) || hasVeh(v) && !/LESS|NET/i.test(v)) continue;
      const kind = kindOf(v);
      if (!kind || kind === 'total') continue;
      // the amount: the total column if it has a number, else the nearest number to the right
      let amount = cols.total != null && cols.total > c ? numOf(row[cols.total]) : null;
      if (amount == null) for (let k = c + 1; k < row.length; k++) { const x = numOf(row[k]); if (x != null) { amount = x; break; } }
      if (amount == null) continue;
      out.push({ label: String(v).replace(/\s+/g, ' ').trim(), kind, amount: r2(amount), row: r });
      break;
    }
  }
  return out;
}

export function readStatement(book, { fileName = '' } = {}) {
  const names = Object.keys(book.sheets || {});
  const warnings = [];
  // the main sheet: the one with header rows; a statement can have more than one such sheet (rare)
  const isLd = (n) => /\bLD\b/i.test(n) || (book.sheets[n].rows || []).slice(0, 4).some((row) => (row || []).some((v) => /LD AMOUNT/i.test(String(v ?? ''))));
  const mains = names.filter((n) => !isLd(n) && (book.sheets[n].rows || []).some(isHeader));
  if (!mains.length) return { error: `No vehicle-wise trip table found in ${fileName || 'the file'} — is it SSFC's monthly account?` };
  const vehicles = [];
  let title = '';
  for (const name of mains) {
    const { rows, r0 = 1 } = book.sheets[name];
    for (const row of rows.slice(0, 6)) for (const v of row || []) if (!title && typeof v === 'string' && monthFromText(v)) title = v.trim();
    const heads = rows.map((row, i) => (isHeader(row) ? i : -1)).filter((i) => i >= 0);
    heads.forEach((h, k) => {
      const end = k + 1 < heads.length ? heads[k + 1] - 1 : rows.length;
      const sub = rows[h + 1] || [];
      const subIsHeading = sub.some((v) => typeof v === 'string' && /QTY|AMOUNT|FUEL|CASH|DATE/i.test(v)) && !sub.some((v) => vehOf(v));
      const cols = columnsOf(rows[h] || [], subIsHeading ? sub : []);
      if (cols.veh == null || cols.loadWt == null) { warnings.push(`${name} row ${h + r0}: a heading without its vehicle / loading weight columns — skipped`); return; }
      // the vehicle named above the table (a block can have deductions and no trip)
      let named = null;
      for (let r = h - 1; r >= Math.max(0, h - 3) && !named; r--) for (const v of rows[r] || []) if (vehOf(v)) { named = vehOf(v); break; }
      const trips = [];
      let r = h + (subIsHeading ? 2 : 1);
      let lastTripRow = r - 1;
      for (; r < end; r++) {
        const row = rows[r] || [];
        const veh = vehOf(row[cols.veh]);
        const wt = numOf(row[cols.loadWt]);
        if (!veh || !(wt > 0)) continue;
        lastTripRow = r;
        const pumps = cols.pumps.map((p) => ({
          label: p.label, vriddhi: p.vriddhi,
          date: p.date != null ? row[p.date] : null, qty: p.qty != null ? numOf(row[p.qty]) || 0 : 0,
          rate: p.rate != null ? numOf(row[p.rate]) || 0 : 0, amount: p.amount != null ? numOf(row[p.amount]) || 0 : 0,
          cash: p.cash != null ? numOf(row[p.cash]) || 0 : 0,
        }));
        trips.push({
          sl: cols.sl != null ? numOf(row[cols.sl]) : null, lr: cols.lr != null ? String(row[cols.lr] ?? '').trim() : '', veh,
          loadDateRaw: cols.loadDate != null ? row[cols.loadDate] : null, loadWt: wt,
          unloadDateRaw: cols.unloadDate != null ? row[cols.unloadDate] : null, unloadWt: cols.unloadWt != null ? numOf(row[cols.unloadWt]) : null,
          short: cols.short != null ? numOf(row[cols.short]) : null,
          pumps, cashOffice: cols.cashOffice != null ? numOf(row[cols.cashOffice]) || 0 : 0,
          cashDateRaw: cols.cashDate != null ? row[cols.cashDate] : null,
          rate: cols.rate != null ? numOf(row[cols.rate]) || 0 : 0, total: cols.total != null ? numOf(row[cols.total]) : null,
          sheet: name, row: r + r0,
        });
      }
      // the subtotal row (just under the trips): SSFC's own sum of the TOTAL column
      let subtotal = null;
      for (let s = lastTripRow + 1; s < Math.min(end, lastTripRow + 3); s++) {
        const row = rows[s] || [];
        if (cols.total != null && numOf(row[cols.total]) != null && !row.some((v) => typeof v === 'string' && /[A-Z]{3}/i.test(v))) { subtotal = numOf(row[cols.total]); break; }
      }
      const lines = linesOf(rows, lastTripRow + 1, end, cols);
      const netLine = lines.find((l) => l.kind === 'net');
      const deductions = lines.filter((l) => l.kind !== 'net');
      const veh = trips.length ? trips[0].veh : named;
      if (!veh) { warnings.push(`${name} row ${h + r0}: a table with no vehicle — skipped`); return; }
      if (trips.some((t) => t.veh !== veh)) warnings.push(`${veh}'s table on ${name} has another vehicle's trip in it`);
      vehicles.push({ veh, named, trips, subtotal, deductions, net: netLine ? netLine.amount : null, sheet: name, row: h + r0, cols });
    });
  }
  // the month: the title, else the file's name, else the trips' loading dates
  let month = monthFromText(title) || monthFromText(fileName);
  if (!month) {
    const c = new Map();
    for (const v of vehicles) for (const t of v.trips) { const d = dateOf(t.loadDateRaw); if (d) c.set(ym(d.iso), (c.get(ym(d.iso)) || 0) + 1); }
    month = [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    if (month) warnings.push('The statement\'s month was worked out from its loading dates.');
  }
  // dates, read against the month
  for (const v of vehicles) {
    for (const t of v.trips) {
      const { l, u } = tripDates(t.loadDateRaw, t.unloadDateRaw, month);
      t.loadDate = l ? l.iso : null; t.loadDateFix = l ? l.fixed : '';
      t.unloadDate = u ? u.iso : null; t.unloadDateFix = u ? u.fixed : '';
      for (const p of t.pumps) { const d = dateOf(p.date, month); p.date = d ? d.iso : null; }
      t.ssfcDiesel = r2(t.pumps.reduce((a, p) => a + p.amount + p.cash, 0));
      t.ssfcLitres = r2(t.pumps.reduce((a, p) => a + (p.amount > 0 ? p.qty : 0), 0));          // litres SSFC charged for
      t.freight = r2(t.loadWt * t.rate);
      delete t.loadDateRaw; delete t.unloadDateRaw;
    }
  }
  const expenses = [];
  const ld = [];
  for (const name of names) {
    if (mains.includes(name) && !(book.sheets[name].rows || []).some((row) => (row || []).some((v) => /^(MAINT|TYRE|OVERLOAD)/i.test(String(v ?? '').trim())))) continue;
    if (isLd(name)) { ld.push(...readLd(book.sheets[name], name, month)); continue; }
    if (mains.includes(name)) continue;
    const e = readExpenses(book.sheets[name], name, month, vehicles);
    expenses.push(...e.lines);
    warnings.push(...e.warnings);
  }
  return { month, title, file: fileName, vehicles, expenses, ld, warnings };
}

// ---- the expense sheet: every bill behind the deductions ------------------------------------------
// No two months lay it out alike (the vehicle in C or E, the head in E, F or G, the amount in I, J
// or K, a header row or none), so each column is told by what's in it.
const CAT_RE = /^(MAINT|MAINTENANCE|TYRE|TIRE|OVERL|OVER LOAD|RTO|DRI\.?\s*FOOD|FOOD|DOC|GPS|FAST|DEEP|OTHER|SHORT|UNION|LD|PENAL)/i;
export function readExpenses(sheet, name = '', month = null, vehicles = []) {
  const rows = (sheet.rows || []).map((r) => r || []);
  const r0 = sheet.r0 || 1;
  const warnings = [];
  const width = Math.max(0, ...rows.map((r) => r.length));
  // the rows that are bills: a vehicle no. somewhere
  const billRows = rows.map((row, i) => [i, row]).filter(([, row]) => row.some((v) => vehOf(v)));
  if (billRows.length < 2) return { lines: [], warnings };
  const stat = Array.from({ length: width }, () => ({ veh: 0, cat: 0, num: 0, pos: 0, int: 0, date: 0, text: 0, long: 0, distinct: new Set() }));
  for (const [, row] of billRows) {
    for (let c = 0; c < width; c++) {
      const v = row[c];
      if (v == null || v === '') continue;
      const s = stat[c];
      if (vehOf(v)) s.veh += 1;
      if (typeof v === 'string' && CAT_RE.test(v.trim()) && v.trim().length <= 16) s.cat += 1;
      const n = numOf(v);
      if (n != null) { s.num += 1; if (n > 0) s.pos += 1; if (Number.isInteger(n)) s.int += 1; }
      if (dateOf(v, month) && (typeof v !== 'number' || v > 40000)) s.date += 1;
      if (typeof v === 'string' && /[A-Z]/i.test(v) && !vehOf(v)) { s.text += 1; if (v.trim().length > 6) s.long += 1; s.distinct.add(v.trim().toUpperCase()); }
    }
  }
  // a header row, when there is one, settles it
  const hdr = {};
  for (const row of rows.slice(0, Math.max(1, billRows[0][0]))) {
    row.forEach((v, c) => {
      const t = up(v);
      if (!t) return;
      if (/VEHICLE|TRUCK/.test(t)) hdr.veh = c;
      else if (/PAYMENT|AMOUNT|TOTAL|AMT/.test(t)) hdr.amount = c;
      else if (/EXPENSE|HEAD|TYPE|CATEG/.test(t)) hdr.cat = c;
      else if (/REMARK|PARTIC|DESC|ITEM|DETAIL/.test(t)) hdr.desc = c;
      else if (/DATE/.test(t)) hdr.date = c;
      else if (/QTY|QUANTITY|NOS/.test(t)) hdr.qty = c;
      else if (/RATE|PRICE/.test(t)) hdr.rate = c;
      else if (/SL|S\.?\s?NO|BILL|VOUCH/.test(t)) hdr.bill = c;
    });
  }
  const best = (score, skip = []) => {
    let b = null; let bs = 0;
    stat.forEach((s, c) => { if (skip.includes(c)) return; const x = score(s, c); if (x > bs) { bs = x; b = c; } });
    return b;
  };
  const N = billRows.length;
  const vehC = hdr.veh ?? best((s) => s.veh);
  const catC = hdr.cat ?? best((s) => (s.cat >= N * 0.5 ? s.cat : 0), [vehC]);
  const dateC = hdr.date ?? best((s) => (s.date >= N * 0.4 ? s.date : 0), [vehC, catC]);
  // the amount: right of the vehicle, a number on most bills — of those, the one adding up to most
  // (an amount is qty × rate, so it's never less than the rate beside it; tyre bills have only an amount)
  const sums = stat.map((s, c) => billRows.reduce((a, [, row]) => a + Math.max(0, numOf(row[c]) || 0), 0));
  const amtC = hdr.amount ?? (() => { let b = null; stat.forEach((s, c) => { if (c <= (vehC ?? -1) || [catC, dateC].includes(c) || s.num < N * 0.5) return; if (b == null || sums[c] > sums[b]) b = c; }); return b; })();
  const descC = hdr.desc ?? best((s) => s.distinct.size + s.long, [vehC, catC, dateC, amtC]);
  const billC = hdr.bill ?? best((s, c) => (c < (vehC ?? 0) && s.int >= N * 0.6 ? s.int : 0), [vehC, catC, dateC, amtC, descC]);
  // qty and rate: numbers between the head and the amount, qty × rate = amount where both are there
  let qtyC = hdr.qty ?? null;
  let rateC = hdr.rate ?? null;
  if (qtyC == null || rateC == null) {
    const nums = stat.map((s, c) => c).filter((c) => c > (descC ?? 0) && c < (amtC ?? width) && ![vehC, catC, dateC, amtC, descC, billC].includes(c) && stat[c].num > 0);
    for (const a of nums) for (const b of nums) {
      if (a === b || qtyC != null) continue;
      let ok = 0; let tried = 0;
      for (const [, row] of billRows) { const q = numOf(row[a]); const p = numOf(row[b]); const t = numOf(row[amtC]); if (q && p && t) { tried += 1; if (Math.abs(q * p - t) <= Math.max(1, t * 0.002)) ok += 1; } }
      if (tried && ok >= tried * 0.6) { qtyC = a; rateC = b; }
    }
  }
  if (vehC == null || amtC == null) { warnings.push(`${name}: couldn't tell its vehicle / amount columns — its bills weren't read`); return { lines: [], warnings }; }
  const lines = [];
  for (const [i, row] of billRows) {
    const veh = vehOf(row[vehC]) || row.map(vehOf).find(Boolean);
    const amount = numOf(row[amtC]);
    if (!veh || amount == null) continue;
    const desc = descC != null ? String(row[descC] ?? '').replace(/\s+/g, ' ').trim() : '';
    const cat = catC != null ? String(row[catC] ?? '').replace(/\s+/g, ' ').trim() : '';
    let kind = kindOf(cat || desc) || 'other';
    const def = defLine(desc) || defLine(cat);
    if (def && (kind === 'maint' || kind === 'other')) kind = 'maint';
    const d = dateC != null ? dateOf(row[dateC], month) : null;
    // the other vehicles one bill names ("XX01AB1001,1002 & 1003 DEF")
    const others = [];
    const m = desc.toUpperCase().match(/([A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3})\s?(\d{3,4})((?:\s*(?:,|&|AND|\/)\s*\d{3,4})+)/);
    if (m) for (const x of m[3].match(/\d{3,4}/g)) { const o = vehOf(`${m[1]}${x}`); if (o && o !== veh) others.push(o); }
    const qty = qtyC != null ? numOf(row[qtyC]) : null;
    lines.push({
      sheet: name, row: i + r0, bill: billC != null && row[billC] != null ? String(row[billC]).trim() : '', date: d ? d.iso : null, dateFix: d ? d.fixed : '', dateFar: !!(d && d.far),
      veh, others, desc, cat, kind, def, qty, rate: rateC != null ? numOf(row[rateC]) : null,
      litres: def ? (litresIn(desc) || (/LTR|LITRE/i.test(desc) && qty ? qty : null)) : null, amount: r2(amount),
    });
  }
  // a grand-total row after the bills (a lone number in the amount column) isn't a bill
  return { lines, warnings, cols: { veh: vehC, cat: catC, date: dateC, amount: amtC, desc: descC, bill: billC, qty: qtyC, rate: rateC } };
}

// ---- the LD (late delivery) sheet -------------------------------------------------------------
function readLd(sheet, name, month) {
  const rows = (sheet.rows || []).map((r) => r || []);
  const hdr = {};
  rows.slice(0, 4).forEach((row) => row.forEach((v, c) => {
    const t = up(v);
    if (/LD AMOUNT/.test(t)) hdr.amount = c;
    else if (/TRUCK|VEHICLE/.test(t)) hdr.veh = c;
    else if (/^LR|LR NO/.test(t)) hdr.lr = c;
    else if (/^DAYS/.test(t)) hdr.days = c;
    else if (/INV.*DATE/.test(t)) hdr.inv = c;
    else if (/ARRIVAL/.test(t)) hdr.arrival = c;
    else if (/UNLOADING/.test(t)) hdr.unload = c;
    else if (/NET W/.test(t)) hdr.wt = c;
  }));
  const out = [];
  for (const row of rows) {
    const veh = hdr.veh != null ? vehOf(row[hdr.veh]) : row.map(vehOf).find(Boolean);
    if (!veh) continue;
    const d = (c) => (c != null ? dateOf(row[c], month)?.iso || null : null);
    out.push({ sheet: name, veh, lr: hdr.lr != null ? String(row[hdr.lr] ?? '').trim() : '', inv: d(hdr.inv), unload: d(hdr.unload) || d(hdr.arrival),
      days: hdr.days != null ? numOf(row[hdr.days]) : null, wt: hdr.wt != null ? numOf(row[hdr.wt]) : null, amount: numOf(row[hdr.amount]) || 0 });
  }
  return out;
}

// ---- a PDF's text (the older months) ---------------------------------------------------------------
// A trip line, as pdf.js / pdftotext give it: "[sl] LR  XX01AB1001  27/7/2025  41.630  30/7/2025  41.8  0.170
// 0 0 94.09 0 0 25.07.25 0 92.74 0 30.07.25 6500 1785 67809.55" — blank columns simply missing, so it's
// read by its arithmetic, not its positions: each diesel fill is three numbers where litres × rate =
// amount; the last three are the cash office, the freight rate and the row's total.
const DATE_TOK = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;
function tripFromTokens(toks, vi, month) {
  const veh = vehOf(toks[vi]);
  const lr = vi > 0 && !/^\d{1,2}$/.test(toks[vi - 1]) ? toks[vi - 1] : vi > 1 ? toks[vi - 1] : '';
  const rest = toks.slice(vi + 1).map((t) => (DATE_TOK.test(t) ? { d: t } : numOf(t) != null ? { n: numOf(t) } : { s: t }));
  if (!rest[0] || !rest[0].d || !rest[1] || rest[1].n == null) return null;
  const loadRaw = rest[0].d;
  const loadWt = rest[1].n;
  const tail = rest.slice(2);
  const nums = tail.map((x, i) => ({ ...x, i }));
  const total = [...nums].reverse().find((x) => x.n != null);
  const rateTok = total && [...nums].reverse().find((x) => x.n != null && x.i < total.i);
  const coTok = rateTok && [...nums].reverse().find((x) => x.n != null && x.i < rateTok.i);
  // the fills: qty, ₹/L (70–130), amount with qty × rate = amount
  const fills = [];
  for (let i = 0; i + 2 < tail.length && (!coTok || i + 2 < coTok.i); i++) {
    const [a, b, c] = [tail[i], tail[i + 1], tail[i + 2]];
    if (a.n == null || b.n == null || c.n == null || b.n < 60 || b.n > 140) continue;
    if (Math.abs(a.n * b.n - c.n) <= Math.max(1, c.n * 0.001)) { fills.push({ qty: a.n, rate: b.n, amount: c.n, at: i }); i += 2; }
  }
  if (!fills.length) return null;
  const f1 = fills[0];
  const f2 = fills[1] || { qty: 0, rate: 0, amount: 0, at: null };
  const after1 = tail[f1.at + 3];
  const cash = after1 && after1.n != null && (f2.at == null || f1.at + 3 < f2.at) && (!coTok || f1.at + 3 < coTok.i) ? after1.n : 0;
  // between the loading weight and the first fill's date: [unload date] [unload wt] [short]
  const firstFillDate = f1.at > 0 && (tail[f1.at - 1].d || tail[f1.at - 1].n === 0) ? f1.at - 1 : f1.at;   // its date, or the 0 standing for none
  const mid = tail.slice(0, firstFillDate);
  const ud = mid.find((x) => x.d);
  const mn = mid.filter((x) => x.n != null).map((x) => x.n);
  let unloadWt = null; let short = null;
  if (mn.length >= 2) { unloadWt = mn[mn.length - 2] || null; short = mn[mn.length - 1]; } else if (mn.length === 1) short = mn[0];
  const pumpDate = f1.at > 0 && tail[f1.at - 1].d ? tail[f1.at - 1].d : null;
  const vrDate = f2.at != null && f2.at > 0 && tail[f2.at - 1].d ? tail[f2.at - 1].d : null;
  const { l, u } = tripDates(loadRaw, ud ? ud.d : null, month);
  const t = {
    lr, veh, loadDate: l ? l.iso : null, loadDateFix: l ? l.fixed : '', loadWt, unloadDate: u ? u.iso : null, unloadDateFix: u ? u.fixed : '',
    unloadWt, short,
    pumps: [{ label: 'SSFC pump', vriddhi: false, date: pumpDate ? dateOf(pumpDate, month)?.iso || null : null, qty: f1.qty, rate: f1.rate, amount: f1.amount, cash },
      { label: 'VRIDHHI FUEL', vriddhi: true, date: vrDate ? dateOf(vrDate, month)?.iso || null : null, qty: f2.qty, rate: f2.rate, amount: f2.amount, cash: 0 }],
    cashOffice: coTok ? coTok.n : 0, rate: rateTok ? rateTok.n : 0, total: total ? total.n : null, sheet: 'pdf',
  };
  t.ssfcDiesel = r2(f1.amount + cash + f2.amount);
  t.ssfcLitres = r2((f1.amount > 0 ? f1.qty : 0) + (f2.amount > 0 ? f2.qty : 0));
  t.freight = r2(loadWt * t.rate);
  return t;
}
export function statementFromText(text, { fileName = '' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  let month = null;
  for (const l of lines.slice(0, 8)) if (!month) month = monthFromText(l);
  month = month || monthFromText(fileName);
  const vehicles = [];
  let cur = null;
  let named = null;
  for (const line of lines) {
    const toks = line.trim().split(/\s+/).filter(Boolean);
    const vi = toks.findIndex((t) => vehOf(t));
    // the vehicle's title line ("XX01AB1004" or "XX01AB1004 P"): its block starts, trips or not
    if (vi >= 0 && toks.length <= 3 && !toks.some((t) => DATE_TOK.test(t))) {
      named = vehOf(toks[vi]);
      cur = { veh: named, named, trips: [], deductions: [], net: null, subtotal: null, sheet: 'pdf' };
      vehicles.push(cur);
      continue;
    }
    if (vi >= 0 && DATE_TOK.test(toks[vi + 1] || '')) {
      const t = tripFromTokens(toks, vi, month);
      if (!t || !(t.loadWt > 0)) continue;
      if (!cur || cur.veh !== t.veh || (cur.closed && cur.trips.length)) { cur = { veh: t.veh, named: t.veh, trips: [], deductions: [], net: null, subtotal: null, sheet: 'pdf' }; vehicles.push(cur); }
      cur.trips.push(t);
      continue;
    }
    if (!cur) continue;
    const m = line.match(/([A-Z][A-Z .\/&]*[A-Z.])\s+(-?[\d,]+(?:\.\d+)?)\s*$/i);
    if (m && !hasVeh(m[1])) {
      const kind = kindOf(m[1]);
      if (kind === 'net') { cur.net = numOf(m[2]); cur.closed = true; } else if (kind && kind !== 'total') cur.deductions.push({ label: m[1].trim(), kind, amount: numOf(m[2]) });
    } else if (/^\s*[\d.,\s-]+$/.test(line) && line.trim() && cur.trips.length && cur.subtotal == null && !cur.closed) {
      const ns = line.trim().split(/\s+/).map(numOf);
      cur.subtotal = ns[ns.length - 1];
    }
  }
  for (let i = vehicles.length - 1; i >= 0; i--) if (!vehicles[i].trips.length && !vehicles[i].deductions.length && vehicles[i].net == null) vehicles.splice(i, 1);
  if (!vehicles.length) return { error: `No trips found in ${fileName || 'the PDF'} — is it SSFC's monthly account?` };
  return { month, title: '', file: fileName, vehicles, expenses: [], ld: [], warnings: ['Read from a PDF — the bill-by-bill expense sheet isn\'t in it; ask SSFC for the Excel file to check maintenance and DEF line by line.'], pdf: true };
}

// ---- what the app keeps of a statement (Setup's settings; small, and enough to check it again) ----
export function compactStatement(st) {
  const n = (x) => (x == null || x === '' || x === 0 ? undefined : x);
  return JSON.parse(JSON.stringify({
    month: st.month, file: st.file || '', title: st.title || '', pdf: st.pdf ? true : undefined, warnings: st.warnings && st.warnings.length ? st.warnings : undefined,
    vehicles: st.vehicles.map((v) => ({
      veh: v.veh, net: v.net, subtotal: v.subtotal,
      deductions: v.deductions.map((d) => ({ label: d.label, kind: d.kind, amount: d.amount })),
      trips: v.trips.map((t) => ({
        lr: n(t.lr), veh: t.veh, loadDate: t.loadDate, loadDateFix: n(t.loadDateFix), loadWt: t.loadWt, unloadDate: n(t.unloadDate), unloadDateFix: n(t.unloadDateFix), unloadWt: t.unloadWt ?? undefined, short: n(t.short),
        pumps: t.pumps.filter((p) => p.qty || p.amount || p.cash).map((p) => ({ label: p.label, vriddhi: p.vriddhi || undefined, date: n(p.date), qty: n(p.qty), rate: n(p.rate), amount: n(p.amount), cash: n(p.cash) })),
        cashOffice: n(t.cashOffice), rate: t.rate, total: t.total, freight: t.freight, ssfcDiesel: t.ssfcDiesel, ssfcLitres: t.ssfcLitres, row: t.row,
      })),
    })),
    expenses: st.expenses.map((e) => ({ row: e.row, bill: n(e.bill), date: e.date, dateFix: n(e.dateFix), veh: e.veh, others: e.others.length ? e.others : undefined, desc: e.desc, cat: n(e.cat), kind: e.kind, def: e.def || undefined, qty: n(e.qty), rate: n(e.rate), litres: n(e.litres), amount: e.amount })),
    ld: st.ld.length ? st.ld : undefined,
  }));       // as saved: no undefined keys left
}
// and back: the shape readStatement gives
export function expandStatement(c) {
  return {
    month: c.month, file: c.file || '', title: c.title || '', pdf: !!c.pdf, warnings: c.warnings || [],
    vehicles: (c.vehicles || []).map((v) => ({
      veh: v.veh, net: v.net ?? null, subtotal: v.subtotal ?? null, deductions: v.deductions || [],
      trips: (v.trips || []).map((t) => ({
        lr: '', loadDateFix: '', unloadDate: null, unloadDateFix: '', unloadWt: null, short: null, cashOffice: 0, ...t,
        pumps: (t.pumps || []).map((p) => ({ vriddhi: false, date: null, qty: 0, rate: 0, amount: 0, cash: 0, ...p })),
      })),
    })),
    expenses: (c.expenses || []).map((e) => ({ bill: '', dateFix: '', others: [], cat: '', def: false, qty: null, rate: null, litres: null, ...e })),
    ld: c.ld || [],
  };
}

