// Reports over the decanting log (no DOM, tested under Node).
//
// Every finished decantation contributes one entry per tank it filled: the
// litres decanted (the chambers' quantity), what the tank actually gained and
// the variation between the two. Entries roll up by day, by truck, by product,
// by month, and make the variation trend.

import { DEFAULT_SETTINGS, istDate, pctOf, round2, tankResult } from './core.js';

export function entriesFrom(sessions, settings = DEFAULT_SETTINGS) {
  const out = [];
  for (const s of sessions || []) {
    if (s.status !== 'done') continue;
    const d = s.data || {};
    const at = d.decantedAt || d.startedAt || s.created_at;
    for (const t of d.tanks || []) {
      const r = tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, settings);
      if (!r) continue;
      out.push({
        id: `${s.id}:${t.tank}`,
        sessionId: s.id,
        at,
        day: istDate(at),
        month: istDate(at).slice(0, 7),
        tt: s.tt_no || d.invoice?.tt_no || '',
        invoiceNo: s.invoice_no || '',
        product: t.product,
        tank: t.tank,
        tankNo: t.tankNo,
        chambers: t.chambers || [],
        litres: t.litres,
        salesL: Number(t.salesL) || 0,
        before: t.before?.volume,
        after: t.after?.volume,
        ...r,
        value: Number.isFinite(t.pricePerL) ? round2(r.variation * t.pricePerL) : null,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function filterEntries(entries, { from = '', to = '', tt = '', product = '', tank = '' } = {}) {
  return entries.filter((e) => (!from || e.day >= from) && (!to || e.day <= to)
    && (!tt || e.tt === tt) && (!product || e.product === product) && (!tank || e.tank === tank));
}

export function summarize(entries) {
  const sum = (f) => round2(entries.reduce((a, e) => a + (Number(f(e)) || 0), 0));
  const litres = sum((e) => e.litres);
  const variation = sum((e) => e.variation);
  const values = entries.filter((e) => Number.isFinite(e.value));
  let worst = null;
  for (const e of entries) if (!worst || e.pct < worst.pct) worst = e;
  return {
    count: entries.length,
    trips: new Set(entries.map((e) => e.sessionId)).size,
    litres,
    variation,
    pct: pctOf(variation, litres),
    short: sum((e) => Math.min(0, e.variation)),
    excess: sum((e) => Math.max(0, e.variation)),
    value: values.length ? round2(values.reduce((a, e) => a + e.value, 0)) : null,
    flagged: entries.filter((e) => e.band !== 'ok').length,
    worst,
  };
}

function groupRows(entries, keyOf) {
  const groups = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, entries: list, ...summarize(list) }));
}

export function byDay(entries) {
  return groupRows(entries, (e) => e.day)
    .map((g) => ({ ...g, products: Object.fromEntries(groupRows(g.entries, (e) => e.product).map((p) => [p.key, p])) }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

export function byVehicle(entries) {
  return groupRows(entries, (e) => e.tt || '—')
    .map((g) => ({ ...g, last: g.entries.reduce((m, e) => (e.day > m ? e.day : m), '') }))
    .sort((a, b) => b.litres - a.litres);
}

export function byProduct(entries) {
  const order = { MS: 0, HSD: 1, XG: 2 };
  return groupRows(entries, (e) => e.product).sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9));
}

export function byTank(entries) {
  return groupRows(entries, (e) => e.tank).sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function byMonth(entries) {
  return groupRows(entries, (e) => e.month).sort((a, b) => (a.key < b.key ? 1 : -1));
}

// Oldest first, for the trend chart.
export function trend(entries) {
  return [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((e) => ({ at: e.at, day: e.day, pct: e.pct, variation: e.variation, litres: e.litres, tt: e.tt, product: e.product, band: e.band, id: e.id }));
}

// Days in [from, to] (ISO dates), for a day axis without gaps.
export function daysBetween(from, to) {
  const out = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end && out.length < 400) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  return out;
}

// Rows for the CSV / Excel export of the log.
export function exportRows(entries) {
  const head = ['Date', 'Time', 'Truck', 'Invoice', 'Product', 'Tank', 'Chambers', 'Decanted (L)', 'Sold during (L)',
    'Stock before (L)', 'Stock after (L)', 'Tank gain (L)', 'Variation (L)', 'Variation (%)', 'Status', 'Value (₹)'];
  const rows = entries.map((e) => {
    const t = new Date(Date.parse(e.at) + 330 * 60000).toISOString();
    return [
      `${e.day.slice(8, 10)}/${e.day.slice(5, 7)}/${e.day.slice(0, 4)}`, t.slice(11, 16), e.tt, e.invoiceNo, e.product,
      e.tankNo ? `Tank ${e.tankNo}` : e.tank, e.chambers.map((c) => `C${c}`).join(' + '), e.litres, e.salesL,
      e.before, e.after, e.gain, e.variation, e.pct, { ok: 'OK', watch: 'Watch', high: 'High' }[e.band], e.value ?? '',
    ];
  });
  return [head, ...rows];
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
