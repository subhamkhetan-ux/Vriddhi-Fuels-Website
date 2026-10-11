// How the rate, the costs and what's kept moved over time — from the trips as
// they are in the Trip Register (the Excel file is the truth for every past
// trip: its rate per ton, its diesel, what the driver was paid).
//
// Every unloaded trip's freight (bhada) splits into:
//   diesel        SSFC diesel + own diesel + extra HSD
//   driver        driver SSFC payment + trip driver payment + extra own driver pay
//   fastag        fastag (tolls)
//   tyre & maint  tyre + maintenance
//   RTO & docs    RTO entry, RTO challan, document expense, own document
//                 expense (road tax, permits …)
//   other         urea, own misc, SSFC misc, less over/unload, shortage
//   yearly        insurance, permit, road tax, Fleet Edge … booked on one trip
//                 a year (an own misc / own document entry whose remarks say so)
//   kept          what's left before the EMI (Income/Trip + Installment)
// Own misc / own document entries go by their remarks: tyre buys to tyre &
// maintenance, repairs to maintenance, insurance / permit / tax to yearly.
// The EMI and the yearly costs are compared on their own ("kept before
// yearly costs and EMI"): they're not costs of the trip they're booked on.
// SSFC books fastag, tyre, maintenance and RTO entry once a month per vehicle,
// on whichever trip was running — so for comparing routes and rates each
// vehicle's month of those charges is spread evenly over its trips that
// month (totals don't change).
// Pure functions.

const lc = (s) => String(s || '').toLowerCase();
export const routeKey = (t) => `${t.port} → ${t.dest}`;

// fixed order = the chart colours' order (dataviz categorical slots 1–7)
export const PARTS = [
  { key: 'diesel', name: 'Diesel', color: 'var(--s-1)' },
  { key: 'driver', name: 'Driver', color: 'var(--s-2)' },
  { key: 'fastag', name: 'Fastag & tolls', color: 'var(--s-3)' },
  { key: 'tyreMaint', name: 'Tyre & maintenance', color: 'var(--s-4)' },
  { key: 'rtoDocs', name: 'RTO, road tax & documents', short: 'RTO & docs', color: 'var(--s-5)' },
  { key: 'other', name: 'Urea, misc & shortage', short: 'Other', color: 'var(--s-6)' },
  { key: 'yearly', name: 'Insurance, permit & road tax (yearly)', short: 'Yearly', color: 'var(--s-7)' },
  { key: 'kept', name: 'Kept before EMI', short: 'Kept', color: 'var(--s-8)' },
];
const YEARLY = /insurance|permit|road\s*tax|fitness|fleet\s*edge|registration|\bpuc\b|\btax\b/i;
const TYRE = /tyre|tire|patta|tube/i;
const REPAIR = /repair|service|wiring|alignment|grease|maint|clutch|brake|engine|battery|bolt/i;

const MONTHLY = ['fastag', 'tyre', 'maint', 'rtoEntry'];
const spreadCache = new WeakMap();
function spreadOf(data) {
  let m = spreadCache.get(data);
  if (m) return m;
  m = new Map();
  const groups = new Map();
  for (const t of data.trips) {
    if (t.status !== 'done' || !t.month) continue;
    const k = `${t.veh}|${t.month}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const list of groups.values()) {
    const share = Object.fromEntries(MONTHLY.map((f) => [f, list.reduce((a, t) => a + (t[f] || 0), 0) / list.length]));
    for (const t of list) m.set(t, share);
  }
  spreadCache.set(data, m);
  return m;
}

// a trip's split; with `data`, the monthly charges spread over the vehicle's trips that month
export function splitTrip(t, data = null) {
  const sp = data ? spreadOf(data).get(t) : null;
  if (sp) {
    const moved = MONTHLY.reduce((a, f) => a + (sp[f] - (t[f] || 0)), 0);
    t = { ...t, ...sp, income: (t.income || 0) - moved };
  }
  const diesel = (t.ssfcAmt || 0) + (t.ownAmt || 0) + (t.extraAmt || 0);
  const driver = (t.drvSsfc || 0) + (t.drvTrip || 0) + (t.drvExtra || 0);
  const bhada = t.bhada || 0;
  const own = (t.ownMisc || 0) + (t.docOwn || 0);
  const kind = !own ? null : YEARLY.test(t.remarks || '') ? 'yearly' : TYRE.test(t.remarks || '') || REPAIR.test(t.remarks || '') ? 'tyreMaint' : null;
  const kept = (t.income || 0) + (t.emi || 0);
  const yearly = kind === 'yearly' ? own : 0;
  return {
    bhada, diesel, driver, fastag: t.fastag || 0, tyreMaint: (t.tyre || 0) + (t.maint || 0) + (kind === 'tyreMaint' ? own : 0),
    rtoDocs: (t.rtoEntry || 0) + (t.rtoChallan || 0) + (t.docExp || 0) + (kind ? 0 : t.docOwn || 0),
    other: (t.urea || 0) + (kind ? 0 : t.ownMisc || 0) + (t.ssfcMisc || 0) + (t.lessOver || 0) + (t.shortage || 0),
    yearly, kept, keptRun: kept + yearly, emi: t.emi || 0,
    litres: (t.ssfcLtr || 0) + (t.ownLtr || 0) + (t.extraLtr || 0), loadWt: t.loadWt || 0, rate: t.rate || 0,
  };
}

// averages a trip over a set of unloaded trips
export function summary(trips, data = null) {
  const xs = trips.map((t) => splitTrip(t, data));
  const n = xs.length;
  const sum = (k) => xs.reduce((a, x) => a + x[k], 0);
  const out = { trips: n };
  for (const k of ['bhada', ...PARTS.map((p) => p.key), 'keptRun', 'emi', 'litres', 'loadWt']) out[k] = n ? sum(k) / n : 0;
  out.rate = n ? sum('rate') / n : 0;
  out.perL = out.litres ? out.diesel / out.litres : 0;
  out.share = {};
  const b = sum('bhada');
  for (const p of PARTS) out.share[p.key] = b ? sum(p.key) / b : 0;
  out.margin = out.share.kept;
  out.marginRun = b ? sum('keptRun') / b : 0;
  return out;
}

const done = (data) => data.trips.filter((t) => t.status === 'done' && t.bhada && t.rate && t.loadDate);

// runs of trips at one rate on a route, oldest first; a rate seen on fewer
// than two trips (a typing slip) doesn't start a new run
export function rateEras(data, route) {
  const list = done(data).filter((t) => routeKey(t) === route).sort((a, b) => (a.loadDate < b.loadDate ? -1 : a.loadDate > b.loadDate ? 1 : a.row - b.row));
  const eras = [];
  for (const t of list) {
    const cur = eras[eras.length - 1];
    if (cur && cur.rate === t.rate) { cur.trips.push(t); continue; }
    const ahead = list.slice(list.indexOf(t), list.indexOf(t) + 3).filter((x) => x.rate === t.rate).length;
    if (cur && ahead < 2) { cur.trips.push(t); continue; }
    eras.push({ rate: t.rate, trips: [t] });
  }
  return eras.map((e, i) => ({
    list: e.trips, from: e.trips[0].loadDate, to: e.trips[e.trips.length - 1].loadDate, ...summary(e.trips, data), rate: e.rate,
    change: i ? { from: eras[i - 1].rate, by: e.rate - eras[i - 1].rate, pct: (e.rate - eras[i - 1].rate) / eras[i - 1].rate } : null,
  }));
}

// each rate change: the last trips at the old rate against the first at the
// new one (up to `n` each side), so the comparison is like for like in time
export function rateChanges(data, { n = 40 } = {}) {
  const out = [];
  for (const route of routes(data)) {
    const eras = rateEras(data, route.route);
    eras.forEach((e, i) => {
      if (!i) return;
      const prev = eras[i - 1];
      const before = prev.list.slice(-n);
      const after = e.list.slice(0, n);
      out.push({ route: route.route, at: e.from, from: prev.rate, to: e.rate, by: e.rate - prev.rate, pct: (e.rate - prev.rate) / prev.rate, before: summary(before, data), after: summary(after, data) });
    });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function routes(data) {
  const m = new Map();
  for (const t of done(data)) m.set(routeKey(t), (m.get(routeKey(t)) || 0) + 1);
  return [...m.entries()].map(([route, trips]) => ({ route, trips })).sort((a, b) => b.trips - a.trips);
}

// month by month (by the loading month), for one route or all ('')
export function monthlyTrend(data, route = '') {
  const m = new Map();
  for (const t of done(data)) {
    if (route && routeKey(t) !== route) continue;
    if (!m.has(t.month)) m.set(t.month, []);
    m.get(t.month).push(t);
  }
  const prices = new Map();
  for (const h of data.hsd || []) {
    const k = h.date.slice(0, 7);
    if (!prices.has(k)) prices.set(k, { l: 0, a: 0 });
    prices.get(k).l += h.qty || 0;
    prices.get(k).a += h.amount || 0;
  }
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, list]) => {
    const p = prices.get(month);
    return { month, ...summary(list, data), pumpPerL: p && p.l ? p.a / p.l : null, rates: [...new Set(list.map((t) => t.rate))].sort((a, b) => a - b) };
  });
}

export const sameRoute = (a, b) => lc(a.port) === lc(b.port) && lc(a.dest) === lc(b.dest);
