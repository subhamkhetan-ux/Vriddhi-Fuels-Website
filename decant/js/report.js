// Reports over the decanting log (no DOM, tested under Node).
//
// Every finished decantation contributes one entry per tank it filled: the
// litres decanted (the chambers' quantity), what the tank actually gained and
// the variation between the two. Entries roll up by day, by truck, by product,
// by month, and make the variation trend.

import { DEFAULT_SETTINGS, PRODUCTS, dmyToIso, istDate, pctOf, productKey, round2, stockProof, tankResult } from './core.js';

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
        beforeFrom: stockProof(t.before),              // for the internal audit: what's behind each stock
        afterFrom: stockProof(t.after),
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
  const head = ['Date', 'Time', 'Truck', 'Invoice', 'Product', 'Tank', 'Chambers', 'Decanted (L)',
    'Stock before (L)', 'Stock after (L)', 'Tank gain (L)', 'Variation (L)', 'Variation (%)', 'Status', 'Value (₹)',
    'Stock before from', 'Stock after from', 'Stock proof'];
  // the audit columns: a screenshot (even corrected) or a dip is proof; typed litres are not
  const proof = (e) => (!e.beforeFrom && !e.afterFrom ? ''
    : e.beforeFrom?.proof === false || e.afterFrom?.proof === false ? 'No — typed litres' : 'Yes');
  const rows = entries.map((e) => {
    const t = new Date(Date.parse(e.at) + 330 * 60000).toISOString();
    return [
      `${e.day.slice(8, 10)}/${e.day.slice(5, 7)}/${e.day.slice(0, 4)}`, t.slice(11, 16), e.tt, e.invoiceNo, e.product,
      e.tankNo ? `Tank ${e.tankNo}` : e.tank, e.chambers.map((c) => `C${c}`).join(' + '), e.litres,
      e.before, e.after, e.gain, e.variation, e.pct, { ok: 'OK', watch: 'Watch', high: 'High' }[e.band], e.value ?? '',
      e.beforeFrom?.label ?? '', e.afterFrom?.label ?? '', proof(e),
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

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export const PERIODS = [['month', 'This month'], ['lastmonth', 'Last month'], ['fy', 'This FY'], ['all', 'All'], ['custom', 'Custom…']];

function shiftDay(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// Start of the Indian financial year (1 April) an ISO date falls in.
export function fyStart(iso) {
  const y = Number(iso.slice(0, 4));
  return `${Number(iso.slice(5, 7)) >= 4 ? y : y - 1}-04-01`;
}

// The oldest day the cloud keeps: the start of last financial year (so "this
// FY" is always whole). Matches dec_purge_old().
export function oldestKept(today) {
  return `${Number(fyStart(today).slice(0, 4)) - 1}-04-01`;
}

// The phone keeps this month and last (and anything still open); older months
// are fetched from the cloud when a report reaches back that far. Two days of
// slack so a load decanted just after midnight on the 1st is inside.
export function localFrom(today) {
  const lastMonth = shiftDay(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  return shiftDay(`${lastMonth}-01`, -2);
}

// 'YYYY-MM' keys from the month of `from` to the month of `to`.
export function monthsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 60; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// This phone's rows plus the older ones fetched from the cloud (the phone's
// copy wins where both have a row).
export function withOlder(local, older, key) {
  const have = new Set(local.map((r) => r[key]));
  return [...local, ...(older || []).filter((r) => !have.has(r[key]))];
}

// [from, to] as ISO dates; an empty `from` means "from the start".
export function periodRange(period, today, custom = {}) {
  switch (period) {
    case 'today': return [today, today];
    case 'week': return [shiftDay(today, -6), today];
    case 'month': return [`${today.slice(0, 7)}-01`, today];
    case 'lastmonth': {
      const end = shiftDay(`${today.slice(0, 7)}-01`, -1);
      return [`${end.slice(0, 7)}-01`, end];
    }
    case 'fy': return [fyStart(today), today];
    case 'custom': return [custom.from || '', custom.to || today];
    default: return ['', today];
  }
}

// ---------------------------------------------------------------------------
// Purchases: what was invoiced, and where it is now
// ---------------------------------------------------------------------------

// Why an invoice was hidden: 'outside' (decanted outside / before the app —
// still a purchase), 'not_ours' or 'deleted' (not a purchase), or null.
export function dismissReason(inv) {
  if (!inv?.dismissed) return null;
  if (inv.dismiss_reason) return inv.dismiss_reason;
  const n = String(inv.note || '').toLowerCase();
  if (/before the app|outside the app/.test(n)) return 'outside';
  if (/deleted/.test(n)) return 'deleted';
  return 'not_ours';
}

export function invoiceDay(inv) {
  return dmyToIso(inv.invoice_date) || (inv.created_at ? istDate(inv.created_at) : '');
}

// Invoices dated in [from, to] (IOCL invoice date), per product: purchased =
// decanted in the app + decanted outside it + still on the truck (in transit).
// `transit` lists the invoices with product still on the truck.
export function purchaseSummary(invoices, sessions, { from = '', to = '', tt = '', product = '' } = {}) {
  const byProduct = Object.fromEntries(Object.keys(PRODUCTS).map((k) => [k, { purchased: 0, decanted: 0, outside: 0, transit: 0, trucks: 0 }]));
  const transit = [];
  for (const inv of invoices || []) {
    const reason = dismissReason(inv);
    if (reason === 'not_ours' || reason === 'deleted') continue;
    const day = invoiceDay(inv);
    if ((from && day < from) || (to && day > to) || (tt && inv.tt_no !== tt)) continue;
    const bought = {};
    for (const ln of inv.lines || []) {
      const k = productKey(ln.column_key || ln.product);
      if (!PRODUCTS[k] || (product && k !== product)) continue;
      bought[k] = (bought[k] || 0) + Math.round(Number(ln.qty_kl ?? ln.qty) * 1000);
    }
    if (!Object.keys(bought).length) continue;
    const done = {};
    const active = {};
    for (const s of sessions || []) {
      if (s.invoice_no !== inv.invoice_no) continue;
      const into = s.status === 'done' ? done : ['decanting', 'settling'].includes(s.status) ? active : null;
      if (!into) continue;
      for (const t of s.data?.tanks || []) into[t.product] = (into[t.product] || 0) + (Number(t.litres) || 0);
    }
    const left = [];
    for (const [k, litres] of Object.entries(bought)) {
      const p = byProduct[k];
      p.purchased += litres;
      if (reason === 'outside') { p.outside += litres; continue; }
      const dec = Math.min(litres, done[k] || 0);
      p.decanted += dec;
      if (litres - dec > 0) {
        p.transit += litres - dec;
        p.trucks += 1;
        left.push({ product: k, litres: litres - dec, decanting: (active[k] || 0) > 0 });
      }
    }
    if (left.length) {
      transit.push({
        invoice_no: inv.invoice_no, tt: inv.tt_no || '', day, time: inv.invoice_time || '', invoice: inv,
        products: left, partial: Object.keys(done).length > 0, decanting: Object.keys(active).length > 0,
      });
    }
  }
  const total = { purchased: 0, decanted: 0, outside: 0, transit: 0 };
  for (const p of Object.values(byProduct)) for (const k of Object.keys(total)) total[k] += p[k];
  transit.sort((a, b) => (a.day + a.time < b.day + b.time ? -1 : 1));
  return { byProduct, total, transit };
}

// Litres decanted per product in [from, to] (by decanting date).
export function decantedByProduct(entries) {
  const out = Object.fromEntries(Object.keys(PRODUCTS).map((k) => [k, { litres: 0, variation: 0, count: 0 }]));
  for (const e of entries) {
    if (!out[e.product]) continue;
    out[e.product].litres += e.litres;
    out[e.product].variation = round2(out[e.product].variation + e.variation);
    out[e.product].count += 1;
  }
  return out;
}
