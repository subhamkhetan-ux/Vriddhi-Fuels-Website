// How full each trip went. The RTO overload fee is already paid, so carrying
// more is pure gain: every tonne short of what could have been loaded is
// freight lost. Each loaded trip is measured against
//   near — the best load on the same route around the same time (trips
//          loaded within ±15 days; ±30 when there are few): what the port
//          was giving then
//   all  — the route's best overall (its top 5%, so one odd heavy load
//          doesn't set the bar)
// and graded by the gap to `near`: full (≤ 0.5 T), near full (≤ 1.5 T),
// under (≤ 3 T), well under (> 3 T). Gross over the RTO's 56 T is good.
// Pure functions.

import { RTO_GROSS } from './bulker.js';
import { daysBetween } from './util.js';

const lc = (s) => String(s || '').trim().toLowerCase();
const sameRoute = (a, b) => lc(a.port) === lc(b.port) && lc(a.dest) === lc(b.dest);
const r2 = (n) => Math.round(n * 100) / 100;

export const GRADES = {
  top: { name: 'Full load', cls: 'load-top' },
  ok: { name: 'Near full', cls: 'load-ok' },
  low: { name: 'Under-loaded', cls: 'load-low' },
  poor: { name: 'Well under-loaded', cls: 'load-poor' },
};
export const gradeOf = (gap) => (gap == null ? null : gap <= 0.5 ? 'top' : gap <= 1.5 ? 'ok' : gap <= 3 ? 'low' : 'poor');

const loaded = (data) => data.trips.filter((t) => t.loadWt > 0 && t.loadWt < 80 && t.loadDate);
function p95(xs) {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
}

// trip row → { near, nearBy, all, gapNear, gapAll, grade, lostT, lostRs, overRto }
export function loadBench(data) {
  const list = loaded(data);
  const out = new Map();
  const allOf = new Map();
  for (const t of list) {
    const k = `${lc(t.port)}|${lc(t.dest)}`;
    if (!allOf.has(k)) allOf.set(k, p95(list.filter((x) => sameRoute(x, t)).map((x) => x.loadWt)));
  }
  for (const t of list) {
    let peers = list.filter((x) => sameRoute(x, t) && Math.abs(daysBetween(x.loadDate, t.loadDate)) <= 15);
    if (peers.length < 3) peers = list.filter((x) => sameRoute(x, t) && Math.abs(daysBetween(x.loadDate, t.loadDate)) <= 30);
    const best = peers.reduce((m, x) => (x.loadWt > m.loadWt ? x : m), t);
    const all = allOf.get(`${lc(t.port)}|${lc(t.dest)}`);
    const gapNear = r2(Math.max(0, best.loadWt - t.loadWt));
    out.set(t.row, {
      near: best.loadWt, nearBy: best, all, gapNear, gapAll: all != null ? r2(Math.max(0, all - t.loadWt)) : null,
      grade: gradeOf(gapNear), lostT: gapNear, lostRs: Math.round(gapNear * (t.rate || 0)),
      overRto: t.gross ? r2(t.gross - RTO_GROSS) : null, peers: peers.length,
    });
  }
  return out;
}

// what a trip not loaded yet should aim for: the best load on its route in the last 30 days
export function loadTarget(data, t, today) {
  const recent = loaded(data).filter((x) => sameRoute(x, t) && daysBetween(x.loadDate, today) <= 30 && daysBetween(x.loadDate, today) >= 0);
  const pool = recent.length >= 3 ? recent : loaded(data).filter((x) => sameRoute(x, t)).slice(-20);
  if (!pool.length) return null;
  const best = pool.reduce((m, x) => (x.loadWt > m.loadWt ? x : m));
  return { load: best.loadWt, by: best };
}

// a set of trips: average load, gap, tonnes and freight left behind
export function loadSummary(trips, bench) {
  const xs = trips.map((t) => [t, bench.get(t.row)]).filter(([, b]) => b);
  const n = xs.length;
  const sum = (f) => xs.reduce((a, x) => a + f(x), 0);
  return {
    trips: n,
    avgLoad: n ? sum(([t]) => t.loadWt) / n : null,
    avgGap: n ? sum(([, b]) => b.gapNear) / n : null,
    lostT: sum(([, b]) => b.gapNear),
    lostRs: sum(([, b]) => b.lostRs),
    top: xs.filter(([, b]) => b.grade === 'top').length,
    ok: xs.filter(([, b]) => b.grade === 'ok').length,
    low: xs.filter(([, b]) => b.grade === 'low').length,
    poor: xs.filter(([, b]) => b.grade === 'poor').length,
    overRto: xs.filter(([, b]) => b.overRto > 0).length,
    underRto: xs.filter(([, b]) => b.overRto != null && b.overRto <= 0).length,
  };
}
