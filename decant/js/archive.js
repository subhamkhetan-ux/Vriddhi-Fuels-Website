// Monthly log files (no DOM, tested under Node). Supabase's free plan is kept
// light by clearing old months from the cloud — but only once each month's
// records have gone into an Excel file on a phone. Each finished month gets
// its file (the Log tab shows a badge until it is downloaded); a month older
// than what the cloud keeps (Settings) is cleared once its file is downloaded
// and nothing in it changed since.
//
// A month is the India-time month a record was entered (created_at) — the
// same way the phone and the cloud window their records.

import {
  densityCheck, dmyToIso, istDate, pctOf, productKey, round2, stockProof, tankResult,
} from './core.js';
import {
  byDay, byProduct, byTank, byVehicle, dismissReason, entriesFrom, fyStart, summarize,
} from './report.js';

export const FORMAT = 1;                 // the file layout (the Excel workbook checks it)

// How much the cloud keeps (Settings). 'fy2' is how it has always been.
export const KEEP_OPTIONS = [
  ['fy2', 'This financial year and the last'],
  ['12', 'The last 12 months'],
  ['6', 'The last 6 months'],
  ['3', 'The last 3 months'],
];

const OPEN = ['draft', 'decanting', 'settling'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 'YYYY-MM' of an instant, in India time.
export const monthOf = (t) => istDate(t).slice(0, 7);

export function monthName(m) {
  return `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
}

export function addMonths(m, n) {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

// [start, end) of a month as instants (ISO, UTC) — India-time month edges.
export function monthBounds(m) {
  const at = (x) => new Date(`${x}-01T00:00:00+05:30`).toISOString();
  return [at(m), at(addMonths(m, 1))];
}

// The first month the cloud keeps.
export function keepFrom(today, keep = 'fy2') {
  const n = Number(keep);
  if (n > 0) return addMonths(today.slice(0, 7), -(n - 1));
  return `${Number(fyStart(today).slice(0, 4)) - 1}-04`;
}

// Records per month, from rows with at least created_at / updated_at (and a
// session's status): {month: {sessions, open, invoices, updated}}.
export function monthCounts(sessions, invoices) {
  const out = {};
  const get = (m) => (out[m] ||= { sessions: 0, open: 0, invoices: 0, updated: '' });
  const later = (a, b) => ((Date.parse(b || 0) || 0) > (Date.parse(a || 0) || 0) ? b : a);
  for (const s of sessions || []) {
    if (!s.created_at) continue;
    const x = get(monthOf(s.created_at));
    x.sessions += 1;
    if (OPEN.includes(s.status)) x.open += 1;
    x.updated = later(x.updated, s.updated_at || s.created_at);
  }
  for (const i of invoices || []) {
    if (!i.created_at) continue;
    const x = get(monthOf(i.created_at));
    x.invoices += 1;
    x.updated = later(x.updated, i.updated_at || i.created_at);
  }
  return out;
}

// Every finished month, oldest first:
//   state  'new' (no file yet) | 'changed' (edited after its file) | 'saved'
//          | 'cleared' (its file downloaded, and nothing left in the cloud)
//   clear  its file is saved and it is older than the cloud keeps: clear it
// counts: monthCounts of the cloud; archive: config.archive — {month: {at, by,
// s, i, u, cleared}} (s / i: decantations / invoices in the file, u: the last
// edit in it).
export function logMonths({ counts, archive = {}, today, keep = 'fy2' }) {
  const current = today.slice(0, 7);
  const from = keepFrom(today, keep);
  const months = [...new Set([...Object.keys(counts || {}), ...Object.keys(archive || {})])].filter((m) => m < current).sort();
  return months.map((m) => {
    const x = counts?.[m] || { sessions: 0, open: 0, invoices: 0, updated: '' };
    const a = archive?.[m] || null;
    const newer = a && (Date.parse(x.updated || 0) || 0) > (Date.parse(a.u || 0) || 0);
    const none = !x.sessions && !x.invoices;
    const state = !a ? 'new' : newer ? 'changed' : none ? 'cleared' : 'saved';
    return { month: m, ...x, state, file: a, clear: state === 'saved' && !a.cleared && m < from };
  }).filter((f) => f.state !== 'new' || f.sessions || f.invoices);
}

export const fileName = (m) => `Vriddhi decanting log ${m}.xlsx`;

// ---------------------------------------------------------------------------
// The file: one sheet per kind of record (plain tables, a header row each)
// ---------------------------------------------------------------------------

const at = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? { at: iso } : '');
const day = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? { date: iso } : '');
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : '');
const plus = (list) => (list || []).join('+');
const BAND = { ok: 'OK', watch: 'Watch', high: 'High' };
const REASON = { outside: 'decanted outside the app', not_ours: 'not ours', deleted: 'deleted' };

function fromText(r) {
  return stockProof(r)?.label || '';
}

// A decantation's density checks: [{product, reading, temp, d15, invoice15, diff, ok}].
function densityRows(s, settings) {
  const d = s.data || {};
  return Object.entries(d.checks?.density || {}).map(([p, v]) => {
    const c = densityCheck({ reading: v?.reading, tempC: v?.temp, invoice15: d.densities?.[p], limitKg: settings.densityLimit });
    return { product: p, reading: v?.reading, temp: v?.temp, d15: c?.d15, invoice15: d.densities?.[p], diff: c?.diff, ok: c ? c.ok : null };
  });
}

// What a decantation's results add up to (as the Result screen shows them).
function sessionTotals(s, settings) {
  const d = s.data || {};
  let litres = 0;
  let variation = 0;
  let value = 0;
  let any = false;
  for (const t of d.tanks || []) {
    litres += Number(t.litres) || 0;
    const r = tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, settings);
    if (!r) continue;
    any = true;
    variation += r.variation;
    if (Number.isFinite(t.pricePerL ?? d.prices?.[t.product])) value += r.variation * (t.pricePerL ?? d.prices[t.product]);
  }
  return { litres, variation: any ? round2(variation) : null, pct: any ? pctOf(round2(variation), litres) : null, value: any && value ? round2(value) : null };
}

function auditText(s) {
  const rows = (s.data?.tanks || []).filter((t) => t.before && t.after);
  if (!rows.some((t) => stockProof(t.before) || stockProof(t.after))) return '';
  const typed = [];
  for (const t of rows) for (const w of ['before', 'after']) if (stockProof(t[w])?.proof === false) typed.push(`Tank ${t.tankNo || t.tank} stock ${w}`);
  return typed.length ? `No proof: ${typed.join(', ')} typed in litres` : 'Proof held: every stock from a screenshot or a dip';
}

// Litres of each product decanted per invoice (finished decantations).
function decantedPerInvoice(sessions) {
  const out = new Map();
  for (const s of sessions || []) {
    if (s.status !== 'done' || !s.invoice_no) continue;
    const m = out.get(s.invoice_no) || {};
    for (const t of s.data?.tanks || []) m[t.product] = (m[t.product] || 0) + (Number(t.litres) || 0);
    out.set(s.invoice_no, m);
  }
  return out;
}

// sessions / invoices: the month's records; known: every decantation this
// phone knows of (for what each invoice has had decanted so far).
export function logSheets({ month, sessions = [], invoices = [], known = [], settings, madeAt, madeBy = '', tanks = [] }) {
  const done = sessions.filter((s) => s.status === 'done');
  // oldest first; a decantation's tanks in order
  const entries = entriesFrom(done, settings).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.tankNo || 0) - (b.tankNo || 0));
  const info = [
    ['Item', 'Value'],
    ['File', 'Vriddhi Fuels — tanker decanting log'],
    ['Month', month],
    ['Month name', monthName(month)],
    ['Format', FORMAT],
    ['Made at', at(madeAt)],
    ['Made by', madeBy],
    ['Decantations finished', done.length],
    ['Decantations cancelled', sessions.filter((s) => s.status === 'cancelled').length],
    ['Decantations still open', sessions.filter((s) => OPEN.includes(s.status)).length],
    ['Tank fills', entries.length],
    ['Invoices', invoices.length],
    ['Variation OK within (%)', settings.tolerancePct],
    ['… or within (L), whichever is more', settings.toleranceMinL],
    ['Truck density vs invoice OK within (± kg/m³)', settings.densityLimit],
    ...tanks.map((t) => [`Tank ${t.no} (${t.id})`, `${t.product} · capacity ${t.capacity} L · fill to ${t.fillTo} L`]),
    ['Rows', 'A month is the India-time month each record was entered. Times are India time. Results use the tolerance above, as the app showed them.'],
  ];

  const fills = [[
    'Fill ID', 'Decantation ID', 'Decanted at', 'Day', 'Truck', 'Invoice', 'Product', 'Tank', 'Tank no', 'Chambers',
    'Decanted (L)', 'Sold while decanting (L)',
    'Stock before (L)', 'Before dip (cm)', 'Before read at', 'Before from', 'Before, screen said (L)',
    'Stock after (L)', 'After dip (cm)', 'After read at', 'After from', 'After, screen said (L)',
    'Tank gain (L)', 'Expected (L)', 'Variation (L)', 'Variation (%)', 'Tolerance (L)', 'Band', 'Direction',
    'Price (₹/L)', 'Value (₹)', 'Proof', 'Tank started at', 'Tank done at',
  ]];
  const byId = new Map(done.map((s) => [s.id, s]));
  for (const e of entries) {
    const s = byId.get(e.sessionId);
    const t = (s?.data?.tanks || []).find((x) => x.tank === e.tank) || {};
    const b = t.before || {};
    const a = t.after || {};
    const typed = stockProof(b)?.proof === false || stockProof(a)?.proof === false;
    fills.push([
      e.id, e.sessionId, at(e.at), day(e.day), e.tt, e.invoiceNo, e.product, e.tank, num(e.tankNo), plus(e.chambers),
      num(e.litres), num(e.salesL),
      num(b.volume), num(b.dip), at(b.readingAt), fromText(b), num(b.screenVolume),
      num(a.volume), num(a.dip), at(a.readingAt), fromText(a), num(a.screenVolume),
      num(e.gain), num(e.expected), num(e.variation), num(e.pct), num(e.tol), BAND[e.band] || '', e.direction,
      num(t.pricePerL ?? s?.data?.prices?.[e.product]), num(e.value), !stockProof(b) && !stockProof(a) ? '' : typed ? 'No — typed litres' : 'Yes',
      at(t.startedAt), at(t.doneAt),
    ]);
  }

  const decs = [[
    'Decantation ID', 'Status', 'Invoice', 'Invoice date', 'Invoice time', 'Truck', 'Entered at', 'Started at', 'Decanted at', 'Finished at',
    'By', 'Tanks', 'Decanted (L)', 'Net variation (L)', 'Variation (%)', 'Value (₹)', 'Audit', 'Density check', 'Notes', 'Cancelled because',
  ]];
  const chambers = [['Decantation ID', 'Invoice', 'Truck', 'Chamber', 'Product', 'Litres', 'Into tank', 'Truck dip (cm)']];
  const density = [['Decantation ID', 'Invoice', 'Truck', 'Product', 'Reading (kg/m³)', 'Temperature (°C)', 'Density at 15 °C', 'Invoice density at 15 °C', 'Difference', 'OK']];
  const ordered = [...sessions].sort((x, y) => (Date.parse(x.created_at) || 0) - (Date.parse(y.created_at) || 0));
  for (const s of ordered) {
    const d = s.data || {};
    const inv = d.invoice || {};
    const tot = sessionTotals(s, settings);
    const dens = densityRows(s, settings);
    decs.push([
      s.id, s.status, s.invoice_no || '', day(dmyToIso(inv.invoice_date)), inv.invoice_time || '', s.tt_no || '',
      at(s.created_at), at(d.startedAt), at(d.decantedAt), at(s.completed_at || d.completedAt),
      d.operator || '', (d.tanks || []).map((t) => t.tank).join(' + '), num(tot.litres), num(tot.variation), num(tot.pct), num(tot.value),
      auditText(s), dens.filter((x) => Number.isFinite(x.d15)).map((x) => `${x.product} ${x.d15} (${x.diff > 0 ? '+' : ''}${x.diff} vs invoice ${x.invoice15})`).join('; '),
      d.notes || '', d.cancelReason || '',
    ]);
    for (const c of d.chambers || []) {
      const into = (d.tanks || []).find((t) => (t.chambers || []).includes(c.no))?.tank || (d.plan || []).find((p) => p.no === c.no)?.tank || '';
      chambers.push([s.id, s.invoice_no || '', s.tt_no || '', num(c.no), c.product || '', num(c.litres), into, num(c.dipCm)]);
    }
    for (const x of dens) {
      density.push([s.id, s.invoice_no || '', s.tt_no || '', x.product, num(x.reading), num(x.temp), num(x.d15), num(x.invoice15), num(x.diff), x.ok === null ? '' : x.ok ? 'Yes' : 'No']);
    }
  }

  const decanted = decantedPerInvoice(known.length ? known : sessions);
  const invs = [[
    'Invoice', 'Invoice date', 'Invoice time', 'Truck', 'Line', 'Product', 'Product as invoiced', 'Quantity (L)', 'Compartments', 'Density at 15 °C',
    'Terminal tank', 'Line value (₹)', 'Invoice amount (₹)', 'Origin', 'Seals', 'Source', 'Hidden', 'Hidden because', 'Note', 'Entered at',
    'Decanted in the app (L)', 'Still on the truck (L)',
  ]];
  const invChambers = [['Invoice', 'Truck', 'Chamber', 'Quantity (KL)', 'PL (cm)', 'Dip (cm)']];
  const orderedInv = [...invoices].sort((x, y) => (Date.parse(x.created_at) || 0) - (Date.parse(y.created_at) || 0));
  for (const inv of orderedInv) {
    const reason = dismissReason(inv);
    const dec = decanted.get(inv.invoice_no) || {};
    const left = { ...dec };
    (inv.lines || []).forEach((ln, i) => {
      const k = productKey(ln.column_key || ln.product);
      const litres = Math.round(Number(ln.qty_kl ?? ln.qty) * 1000);
      const got = k && Number.isFinite(litres) ? Math.min(litres, left[k] || 0) : 0;
      if (k) left[k] = (left[k] || 0) - got;
      const counts = k && ['MS', 'HSD', 'XG'].includes(k) && reason !== 'not_ours' && reason !== 'deleted';
      invs.push([
        inv.invoice_no, day(dmyToIso(inv.invoice_date)), inv.invoice_time || '', inv.tt_no || '', i + 1, k || '', ln.product || '',
        num(litres), plus(ln.compartments), num(ln.density15 ?? inv.density15), ln.terminal_tank || '', num(ln.value), num(inv.amount),
        inv.origin || '', inv.seals || '', inv.source || '', inv.dismissed ? 'Yes' : 'No', REASON[reason] || '', inv.note || '', at(inv.created_at),
        counts ? num(got) : '', counts && reason !== 'outside' ? num(Math.max(0, litres - got)) : '',
      ]);
    });
    for (const c of inv.chambers || []) invChambers.push([inv.invoice_no, inv.tt_no || '', num(c.no), num(c.qty_kl), num(c.pl_cm), num(c.dip_cm)]);
  }

  // the app's own totals for these fills (what its Reports would show) — for
  // checking the Excel workbook's sums against
  const totals = [['Group', 'Key', 'Tank fills', 'Decantations', 'Decanted (L)', 'Net variation (L)', 'Variation (%)', 'Short (L)', 'Excess (L)', 'Outside tolerance', 'Value (₹)']];
  const row = (group, key, g) => totals.push([group, key, g.count, g.trips, num(g.litres), num(g.variation), num(g.pct), num(g.short), num(g.excess), g.flagged, num(g.value)]);
  if (entries.length) row('Month', month, summarize(entries));
  for (const g of [...byDay(entries)].reverse()) row('Day', g.key, g);
  for (const g of byVehicle(entries)) row('Truck', g.key, g);
  for (const g of byProduct(entries)) row('Product', g.key, g);
  for (const g of byTank(entries)) row('Tank', g.key, g);

  return [
    { name: 'Info', rows: info, widths: [40, 70] },
    { name: 'Fills', rows: fills, widths: [30, 24, 17, 11, 12, 12, 8, 6, 7, 10, 12, 12, 13, 10, 17, 30, 14, 13, 10, 17, 30, 14, 12, 12, 12, 11, 11, 8, 9, 10, 11, 16, 17, 17] },
    { name: 'Decantations', rows: decs, widths: [24, 10, 12, 11, 8, 12, 17, 17, 17, 17, 12, 12, 12, 13, 11, 11, 44, 36, 36, 30] },
    { name: 'Chambers', rows: chambers, widths: [24, 12, 12, 8, 8, 8, 9, 12] },
    { name: 'Density', rows: density, widths: [24, 12, 12, 8, 13, 13, 13, 16, 10, 5] },
    { name: 'Invoices', rows: invs, widths: [12, 11, 8, 12, 5, 8, 22, 11, 12, 13, 10, 13, 15, 30, 30, 8, 7, 22, 24, 17, 16, 16] },
    { name: 'Invoice chambers', rows: invChambers, widths: [12, 12, 8, 12, 8, 8] },
    { name: 'App totals', rows: totals, widths: [8, 12, 9, 12, 12, 16, 12, 10, 10, 16, 11] },
  ];
}
