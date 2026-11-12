// Register — the pump's Daily Stock Register (the paper DSR book) and the
// Stock Register, from the three workbooks kept on the Mac:
//
//   E-DSR.xlsx           one sheet per product (Petrol, Diesel, XtraGreen):
//                        the month's opening book stock, each day's
//                        receipts, opening meter readings per nozzle and
//                        testing. Sale = next morning's readings - this
//                        morning's - testing (the sheet's own formula).
//   Stock Register.xlsm  MS / HSD / XG: the "Actual Tank Stock" of each day
//                        (the next morning's dip stock, logged by its
//                        macro), the opening shortage; its "Macro Log" sheet
//                        keeps every morning's stock since it was started.
//   DIP Chart.xlsm       the tank chart (dip in cm -> litres, one chart for
//                        every tank), this morning's stock of each tank
//                        (HSD has two) and its "Log" sheet of mornings.
//
// The paper DSR's opening stock of a day is that morning's dip stock, and its
// dips are that stock read back on the chart, as "Stock to Dip" does. Book
// stock (opening + receipts - sale) is the E-DSR's / Stock Register's.
//
// Pure functions: no DOM, no network. Workbooks come in as SheetJS objects.

import { addr, cellDate, cellNumber, cellText } from './util.js';

export const PRODUCTS = [
  { key: 'HSD', name: 'HSD (High Speed Diesel)', short: 'HSD', dsr: /^(diesel|hsd)$/i, stock: /^(hsd|diesel)$/i, tanks: 2 },
  { key: 'MS', name: 'MS (Petrol)', short: 'MS', dsr: /^(petrol|ms)$/i, stock: /^(ms|petrol)$/i, tanks: 1 },
  { key: 'XG', name: 'XtraGreen', short: 'XtraGreen', dsr: /^(xtra ?green|xg)$/i, stock: /^(xg|xtra ?green)$/i, tanks: 1 },
];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
export const daysIn = (month) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
export const dateOf = (month, day) => `${month}-${pad(day)}`;
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const prevMonth = (month) => addDays(`${month}-01`, -1).slice(0, 7);

// "DIESEL MONTH OF NOVEMBER 2026" -> '2026-11'
export function monthFromTitle(text) {
  const m = String(text || '').toLowerCase().match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b[\s,'-]*(\d{4})/);
  return m ? `${m[2]}-${pad(MONTHS.indexOf(m[1]) + 1)}` : null;
}

// ---- reading cells -------------------------------------------------------
const cell = (ws, r, c) => ws[addr(r, c)];                 // 0-based
const text = (ws, r, c) => cellText(cell(ws, r, c));
const num = (ws, r, c) => cellNumber(cell(ws, r, c));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function bounds(ws) {
  const m = String(ws['!ref'] || 'A1').match(/([A-Z]+)(\d+)$/i);
  let cols = 0;
  for (const ch of m[1].toUpperCase()) cols = cols * 26 + ch.charCodeAt(0) - 64;
  return { rows: +m[2], cols };
}
// the first cell whose text matches, scanning rows top to bottom
function findCell(ws, test, maxRow = 60) {
  const { rows, cols } = bounds(ws);
  for (let r = 0; r < Math.min(rows, maxRow); r++) {
    for (let c = 0; c < cols; c++) if (test(norm(text(ws, r, c)))) return { r, c };
  }
  return null;
}
const date1904 = (wb) => !!(wb && wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
const sheetOf = (wb, re) => {
  const name = (wb.SheetNames || []).find((n) => re.test(String(n).trim()));
  return name ? { name, ws: wb.Sheets[name] } : null;
};

// Which of the three workbooks this is: 'dsr' | 'stock' | 'dipchart' | null
export function registerKind(wb) {
  const names = (wb && wb.SheetNames) || [];
  const has = (re) => names.some((n) => re.test(String(n).trim()));
  if (has(/^stock to dip$/i)) return 'dipchart';
  if (has(/^macro log$/i) || (has(/^hsd$/i) && has(/^ms$/i))) return 'stock';
  if (has(/^diesel$/i) || has(/^petrol$/i)) return 'dsr';
  return null;
}

// ---- E-DSR.xlsx ------------------------------------------------------------
// -> { month, products: { HSD: { sheet, title, nozzles: [{label, machine}],
//      open, days: [{receipt, test, meters}] } } }
// days has one entry per day of the month plus one: the morning after the
// last day (its readings close the last day's sale).
export function readDsr(wb) {
  const out = { month: null, products: {} };
  for (const p of PRODUCTS) {
    const sh = sheetOf(wb, p.dsr);
    if (!sh) continue;
    const { ws } = sh;
    const title = text(ws, 0, 0);
    const month = monthFromTitle(title);
    const head = findCell(ws, (t) => t === 'opening', 15);
    if (!month || !head) continue;
    const hr = head.r;
    const { cols } = bounds(ws);
    const colOf = (re) => { for (let c = 0; c < cols; c++) if (re.test(norm(text(ws, hr, c)))) return c; return -1; };
    const cOpen = head.c;
    const cRec = colOf(/^receipts?$/);
    const cTotal = colOf(/^total$/);
    const cTest = colOf(/^test(ing)?$/);
    if (cRec < 0 || cTotal < 0 || cTest < 0 || cTest <= cTotal + 1) throw new Error(`E-DSR ${sh.name}: the Receipts / Total / Test columns weren't found on row ${hr + 1}.`);
    // machines: the merged labels on the row above the headers
    const merges = (ws['!merges'] || []).filter((m) => m.s.r === hr - 1);
    const machineOf = (c) => {
      const m = merges.find((x) => x.s.c <= c && c <= x.e.c);
      const t = m ? text(ws, hr - 1, m.s.c) : text(ws, hr - 1, c);
      return t.replace(/\bmachine\b/i, 'Machine').replace(/\bno\.?\s*/i, 'No. ').replace(/\s+/g, ' ').trim();
    };
    const nozzles = [];
    for (let c = cTotal + 1; c < cTest; c++) nozzles.push({ col: c, label: text(ws, hr, c) || `Nozzle ${c - cTotal}`, machine: machineOf(c) });
    const n = daysIn(month);
    const days = [];
    for (let d = 1; d <= n + 1; d++) {
      const r = hr + d;
      const meters = nozzles.map((z) => num(ws, r, z.col));
      days.push({
        receipt: d <= n ? num(ws, r, cRec) : null,
        test: d <= n ? num(ws, r, cTest) : null,
        meters: meters.some((v) => v != null) ? meters : null,
      });
    }
    out.products[p.key] = {
      sheet: sh.name, title, month,
      nozzles: nozzles.map(({ label, machine }) => ({ label, machine })),
      open: num(ws, hr + 1, cOpen),
      days,
    };
    out.month = out.month || month;
  }
  if (!Object.keys(out.products).length) throw new Error('This doesn\'t look like the E-DSR: no Petrol / Diesel / XtraGreen sheet with a "MONTH OF …" title and an Opening column.');
  return out;
}

// ---- Stock Register.xlsm ----------------------------------------------------
// -> { month, products: { HSD: { openShortage, testAdjust, actual: [per day] } },
//      log: { 'YYYY-MM-DD|mac': {MS, HSD, XG} } }
function labelled(ws, re) {
  const at = findCell(ws, (t) => re.test(t), 10);
  if (!at) return null;
  for (let c = at.c + 1; c < at.c + 5; c++) { const v = num(ws, at.r, c); if (v != null) return v; }
  return null;
}
export function readStock(wb) {
  const out = { month: null, products: {}, log: {} };
  for (const p of PRODUCTS) {
    const sh = sheetOf(wb, p.stock);
    if (!sh) continue;
    const { ws } = sh;
    const month = monthFromTitle(text(ws, 0, 0));
    const head = findCell(ws, (t) => /^actual tank stock$/.test(t), 10);
    if (!month || !head) continue;
    const sno = findCell(ws, (t) => /^s ?no$/.test(t), 10);
    const n = daysIn(month);
    const actual = [];
    for (let d = 1; d <= n; d++) actual.push(num(ws, head.r + d, head.c));
    out.products[p.key] = {
      sheet: sh.name, month, sno: !!sno,
      openShortage: labelled(ws, /^opening shortage$/),
      testAdjust: labelled(ws, /^testing adjustment$/),
      actual,
    };
    out.month = out.month || month;
  }
  if (!Object.keys(out.products).length) throw new Error('This doesn\'t look like the Stock Register: no MS / HSD / XG sheet with an "Actual Tank Stock" column.');
  // the macro's log: each morning's stock as it was logged ("LOGGED to F…")
  const log = sheetOf(wb, /^macro log$/i);
  if (log) {
    const { rows } = bounds(log.ws);
    const flag = date1904(wb);
    for (let r = 1; r < rows; r++) {
      if (!/^logged\b/i.test(text(log.ws, r, 3))) continue;
      const day = cellDate(cell(log.ws, r, 0), flag);
      const key = PRODUCTS.find((p) => p.stock.test(text(log.ws, r, 1)));
      const v = num(log.ws, r, 2);
      if (!day || !key || v == null) continue;
      const e = out.log[`${day}|mac`] || (out.log[`${day}|mac`] = {});
      if (e[key.key] == null) e[key.key] = round2(v);
    }
  }
  return out;
}

// ---- DIP Chart.xlsm ---------------------------------------------------------
// -> { chart: [[dip, litres]...], reading: {date, MS, HSD1, HSD2, XG (litres)},
//      log: { 'YYYY-MM-DD|log': {MS, HSD, XG}, 'YYYY-MM-DD|chart': {...reading} } }
export function readDipChart(wb) {
  const sh = sheetOf(wb, /^stock to dip$/i);
  if (!sh) throw new Error('This doesn\'t look like the DIP Chart: no "Stock to Dip" sheet.');
  const { ws } = sh;
  const { rows } = bounds(ws);
  const head = findCell(ws, (t) => t === 'dip', 5) || { r: 0, c: 0 };
  const chart = [];
  for (let r = head.r + 1; r < rows; r++) {
    const dip = num(ws, r, head.c);
    const vol = num(ws, r, head.c + 1);
    if (dip == null || vol == null) continue;
    chart.push([Math.round(dip * 10) / 10, round2(vol)]);
  }
  if (chart.length < 20) throw new Error('The DIP Chart\'s table (DIP / VOLUME) wasn\'t found on "Stock to Dip".');
  const flag = date1904(wb);
  // this morning's stock per tank: the cell under each "... Volume" label
  const under = (re) => {
    const at = findCell(ws, (t) => re.test(t), 40);
    return at ? num(ws, at.r + 1, at.c) : null;
  };
  const reading = {
    MS: under(/^ms volume$/), HSD1: under(/^hsd volume 1$/), HSD2: under(/^hsd volume 2$/), XG: under(/^xg volume$/),
  };
  // its date: the sheet's =TODAY() as last worked out
  let date = null;
  for (const [a, c] of Object.entries(ws)) {
    if (a[0] !== '!' && c && c.f && /^today\(\)$/i.test(String(c.f).replace(/\s/g, ''))) { date = cellDate(c, flag); break; }
  }
  const log = {};
  for (const k of Object.keys(reading)) if (reading[k] != null) reading[k] = round2(reading[k]);
  if (date && [reading.MS, reading.HSD1, reading.HSD2, reading.XG].some((v) => v != null)) {
    log[`${date}|chart`] = { ...reading, HSD: reading.HSD1 != null && reading.HSD2 != null ? round2(reading.HSD1 + reading.HSD2) : null };
  }
  // its "Log" sheet: Date | MS Volume | HSD (Total) Volume | XG Volume
  const lg = sheetOf(wb, /^log$/i);
  if (lg) {
    const { rows: lr } = bounds(lg.ws);
    for (let r = 1; r < lr; r++) {
      const day = cellDate(cell(lg.ws, r, 0), flag);
      if (!day) continue;
      const e = { MS: num(lg.ws, r, 1), HSD: num(lg.ws, r, 2), XG: num(lg.ws, r, 3) };
      if (Object.values(e).every((v) => v == null)) continue;
      for (const k of Object.keys(e)) if (e[k] != null) e[k] = round2(e[k]);
      log[`${day}|log`] = e;
    }
  }
  return { chart, reading: { date, ...reading }, log };
}

// ---- the tank chart ---------------------------------------------------------
// litres -> dip (cm): the chart row nearest the stock, as "Stock to Dip" does
// (INDEX/MATCH on the smallest difference, first one on a tie)
export function dipOf(chart, litres) {
  if (!chart || !chart.length || litres == null) return null;
  let best = null;
  let gap = Infinity;
  for (const [dip, vol] of chart) {
    const g = Math.abs(vol - litres);
    if (g < gap - 1e-9) { gap = g; best = dip; }
  }
  return best;
}
// dip (cm) -> litres (exact chart row, else the next one up — XLOOKUP's ",1")
export function litresOf(chart, dip) {
  if (!chart || dip == null) return null;
  const d = Math.round(Number(dip) * 10) / 10;
  const hit = chart.find(([x]) => x >= d - 1e-9);
  return hit ? hit[1] : null;
}

// ---- the morning stock of each day ----------------------------------------
// tanklog: { 'YYYY-MM-DD|src': {MS, HSD, XG, HSD1?, HSD2?} }, src:
//   chart  the DIP Chart's own reading (per tank; dated by its =TODAY())
//   log    the DIP Chart's Log sheet
//   mac    the Stock Register's Macro Log
// plus the Stock Register's Actual Tank Stock of the day before ('stock').
// A DIP Chart reading carried to the next day (the file opened again before
// the new volumes were typed) is moved back to the day whose stock it is.
export function mornings(tanklog, stockDocs = []) {
  const by = new Map();                                   // date -> {chart, log, mac, stock}
  const put = (date, src, v) => { if (!by.has(date)) by.set(date, {}); by.get(date)[src] = v; };
  for (const [k, v] of Object.entries(tanklog || {})) {
    const [date, src] = k.split('|');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && v && typeof v === 'object') put(date, src, v);
  }
  for (const s of stockDocs) {
    if (!s || !s.month) continue;
    const n = daysIn(s.month);
    for (let d = 1; d <= n; d++) {
      const v = {};
      for (const p of PRODUCTS) { const a = s.products[p.key] && s.products[p.key].actual[d - 1]; if (a != null) v[p.key] = round2(a); }
      if (Object.keys(v).length) put(addDays(dateOf(s.month, d), 1), 'stock', v);
    }
  }
  const same = (a, b, keys = ['MS', 'HSD']) => keys.every((k) => a && b && a[k] != null && b[k] != null && Math.abs(a[k] - b[k]) < 0.05);
  for (const [date, e] of [...by]) {
    if (!e.chart) continue;
    const others = (x) => x && [x.log, x.stock, x.mac].filter(Boolean);
    if (others(e).some((o) => same(o, e.chart))) continue;
    for (let back = 1; back <= 3; back++) {
      const d = addDays(date, -back);
      const x = by.get(d);
      if (x && !x.chart && others(x).some((o) => same(o, e.chart))) { x.chart = e.chart; delete e.chart; break; }
    }
  }
  return by;
}

// One day's dip stock: {MS, HSD, XG, HSD1, HSD2, src: {MS: 'chart'…}, differs: {MS: litres in the Stock Register}}
const ORDER = ['chart', 'log', 'stock', 'mac'];
export function morningOf(by, date) {
  const e = by.get(date);
  if (!e) return null;
  const out = { src: {}, differs: {} };
  for (const p of PRODUCTS) {
    for (const src of ORDER) {
      const v = e[src] && e[src][p.key];
      if (v != null) { out[p.key] = v; out.src[p.key] = src; break; }
    }
    const st = e.stock && e.stock[p.key];
    if (out[p.key] != null && st != null && Math.abs(st - out[p.key]) >= 1) out.differs[p.key] = st;
  }
  if (!Object.keys(out.src).length) return null;
  if (e.chart && e.chart.HSD1 != null && e.chart.HSD2 != null && out.src.HSD === 'chart') { out.HSD1 = e.chart.HSD1; out.HSD2 = e.chart.HSD2; }
  return out;
}

// ---- one product's month: the DSR book and the Stock Register ---------------
// dsr: readDsr()'s product, stock: readStock()'s product (or null),
// by: mornings(), chart: the DIP chart (or null)
export function productMonth({ month, key, dsr, stock, by, chart }) {
  const n = daysIn(month);
  const prod = PRODUCTS.find((p) => p.key === key);
  const rows = [];
  let book = dsr && dsr.open != null ? dsr.open : null;
  let cum = 0;
  let prevShort = stock && stock.openShortage != null ? stock.openShortage : null;
  let totals = { receipt: 0, test: 0, sale: 0, variation: 0 };
  for (let d = 1; d <= n; d++) {
    const date = dateOf(month, d);
    const day = dsr ? dsr.days[d - 1] : null;
    const next = dsr ? dsr.days[d] : null;
    const receipt = day && day.receipt != null ? day.receipt : null;
    const test = day ? day.test : null;
    const meters = day ? day.meters : null;
    let sale = null;
    if (test != null && meters && next && next.meters && meters.every((v) => v != null) && next.meters.every((v) => v != null)) {
      sale = round2(next.meters.reduce((a, v) => a + v, 0) - meters.reduce((a, v) => a + v, 0) - test);
    }
    if (sale != null) cum = round2(cum + sale);
    // the morning's dip stock and dips
    const m = by ? morningOf(by, date) : null;
    const stockAm = m && m[key] != null ? m[key] : null;
    let dips = [];
    if (stockAm != null) {
      if (prod.tanks === 2) dips = m.HSD1 != null ? [dipOf(chart, m.HSD1), dipOf(chart, m.HSD2)] : [null, null];
      else dips = [dipOf(chart, stockAm)];
    }
    // book stock (E-DSR / Stock Register columns B, D, E)
    const bookOpen = book;
    const bookTotal = bookOpen != null ? round2(bookOpen + (receipt || 0)) : null;
    const bookClose = bookTotal != null && sale != null ? round2(bookTotal - sale) : null;
    book = bookClose;
    // Stock Register: Actual Tank Stock (the next morning's), shortage, variation
    let actual = stock ? stock.actual[d - 1] : null;
    let actualSrc = actual != null ? 'stock' : null;
    let actualAlt = null;                                  // the DIP Chart's stock, when the Stock Register's differs
    const nm = by ? morningOf(by, addDays(date, 1)) : null;
    if (actual == null && nm && nm[key] != null && nm.src[key] !== 'stock') { actual = nm[key]; actualSrc = nm.src[key]; }
    else if (actual != null && nm && nm[key] != null && nm.src[key] !== 'stock' && Math.abs(nm[key] - actual) >= 1) actualAlt = nm[key];
    const shortage = actual != null && bookClose != null ? round2(bookClose - actual) : null;
    const variation = shortage != null && prevShort != null ? round2(shortage - prevShort) : null;
    if (shortage != null) prevShort = shortage;
    if (receipt) totals.receipt += receipt;
    if (test) totals.test += test;
    if (sale != null) totals.sale = round2(totals.sale + sale);
    if (variation != null) totals.variation = round2(totals.variation + variation);
    rows.push({
      day: d, date, receipt, test, meters, sale, cum: sale != null ? cum : null,
      stock: stockAm, stockSrc: m ? m.src[key] || null : null, differs: m ? m.differs[key] ?? null : null,
      total: stockAm != null ? round2(stockAm + (receipt || 0)) : null,
      tanks: m && prod.tanks === 2 && m.HSD1 != null ? [m.HSD1, m.HSD2] : null, dips,
      bookOpen, bookTotal, bookClose, actual, actualSrc, actualAlt, shortage, variation,
    });
  }
  totals.receipt = round2(totals.receipt);
  totals.test = round2(totals.test);
  const last = [...rows].reverse().find((r) => r.shortage != null);
  return {
    month, key, product: prod, nozzles: dsr ? dsr.nozzles : [], rows, totals,
    openShortage: stock ? stock.openShortage : null,
    testAdjust: stock ? stock.testAdjust : null,
    shortageNow: last ? last.shortage : (stock ? stock.openShortage : null),
    shortageDay: last ? last.day : null,
  };
}

// ---- the latest morning, for the top of the screen ----------------------------
// -> { date, products: [{key, stock, dips, tanks, src}] } or null
export function latestMorning(by, chart, upTo) {
  const dates = [...by.keys()].filter((d) => !upTo || d <= upTo).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const m = morningOf(by, dates[i]);
    if (!m || PRODUCTS.every((p) => m[p.key] == null)) continue;
    return {
      date: dates[i],
      products: PRODUCTS.map((p) => {
        const v = m[p.key] ?? null;
        const tanks = p.tanks === 2 && m.HSD1 != null ? [m.HSD1, m.HSD2] : null;
        return { key: p.key, product: p, stock: v, tanks, src: m.src[p.key] || null,
          dips: v == null ? [] : tanks ? tanks.map((t) => dipOf(chart, t)) : p.tanks === 2 ? [] : [dipOf(chart, v)] };
      }),
    };
  }
  return null;
}

// a register doc's day ('YYYY-MM-DD') when it last has any figure — for "updated until"
export function lastDay(pm) {
  const r = [...pm.rows].reverse().find((x) => x.sale != null || x.meters);
  return r ? r.date : null;
}

