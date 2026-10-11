// Who's slow: each trip against the best trips on the same route at the same
// time (trips started within ±10 days — ±21 when there are too few), stage by
// stage. Dates in the register are days, so everything here is in days.
//
//   to load  = trip start → loading date (the empty run + waiting at the port)
//   loaded   = loading → unloading (the loaded run + waiting at the plant)
//   trip     = start → unloading
//   idle     = unloading → the vehicle's next trip start
//   fills    = HSD fills tagged to the trip (HSD Data), day by day
//
// Each stage is shown against the best of its group (what's possible) and
// judged against the group's typical trip (its median), so one lucky fast trip
// doesn't make everyone look slow. A trip is slow when it took 2+ days more
// than its group's typical; a vehicle is underperforming over a period when
// it averages ≥ 1 day a trip slower than its peers' typical (getting loaded +
// the loaded run — what the driver controls), or 40%+ of its trips are slow.
// Idle days after unloading are shown on their own: the next loading is
// mostly up to dispatch, and a late truck simply waits less. Pure functions.

import { daysBetween } from './util.js';

const lc = (s) => String(s || '').toLowerCase();
const sameRoute = (a, b) => lc(a.port) === lc(b.port) && lc(a.dest) === lc(b.dest);
const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const ok = (d) => d != null && d >= 0 && d <= 45;
const gap = (a, b) => (a && b ? daysBetween(a, b) : null);

export const STAGES = [
  { key: 'toLoad', name: 'To load', note: 'start → loading (empty run + port)' },
  { key: 'loaded', name: 'Loaded run', note: 'loading → unloading' },
  { key: 'idle', name: 'Idle after unloading', note: 'unloading → next trip start' },
];
export const SLOW_DAYS = 2;

// the day-by-day of every trip
export function tripStages(data, today) {
  const out = new Map();
  const byVeh = new Map();
  for (const t of [...data.trips].sort((a, b) => a.row - b.row)) {
    if (!byVeh.has(t.veh)) byVeh.set(t.veh, []);
    byVeh.get(t.veh).push(t);
  }
  const fillsOf = new Map();
  for (const h of data.hsd || []) {
    const k = `${h.veh}|${h.trip}`;
    if (!fillsOf.has(k)) fillsOf.set(k, []);
    fillsOf.get(k).push(h);
  }
  for (const list of byVeh.values()) {
    list.forEach((t, i) => {
      const next = list[i + 1];
      const toLoad = gap(t.start, t.loadDate);
      const loaded = gap(t.loadDate, t.unloadDate);
      const trip = gap(t.start, t.unloadDate);
      const idle = next && t.unloadDate ? gap(t.unloadDate, next.start) : null;
      const fills = (fillsOf.get(`${t.veh}|${t.trip}`) || []).filter((h) => !t.start || h.date >= t.start).sort((a, b) => (a.date < b.date ? -1 : 1));
      const valid = t.status === 'done' && ok(toLoad) && ok(loaded) && ok(trip) && (!t.unloadDate || t.unloadDate <= today);
      out.set(t.row, {
        t, next, toLoad: ok(toLoad) ? toLoad : null, loaded: ok(loaded) ? loaded : null, trip: ok(trip) ? trip : null,
        idle: ok(idle) ? idle : null, fills, litres: fills.reduce((a, h) => a + (h.qty || 0), 0), valid,
      });
    });
  }
  return out;
}

// trips on the same route that started around the same time (done, sensible dates)
function group(stages, s, days) {
  const out = [];
  for (const x of stages.values()) {
    if (x.valid && sameRoute(x.t, s.t) && Math.abs(daysBetween(x.t.start, s.t.start)) <= days) out.push(x);
  }
  return out;
}

export function performance(data, today, { from = '0000-00', to = '9999-99', route = '' } = {}) {
  const stages = tripStages(data, today);
  const compared = [];
  for (const s of stages.values()) {
    if (!s.valid || !s.t.month || s.t.month < from || s.t.month > to) continue;
    if (route && `${s.t.port} → ${s.t.dest}` !== route) continue;
    let peers = group(stages, s, 10);
    let window = 10;
    if (peers.length < 3) { peers = group(stages, s, 21); window = 21; }
    if (peers.length < 2) continue;                              // nobody to compare with
    const best = {};
    const bestBy = {};
    const usual = {};
    for (const k of ['toLoad', 'loaded', 'trip', 'idle']) {
      const vals = peers.filter((p) => p[k] != null);
      if (!vals.length) continue;
      const b = vals.reduce((m, p) => (p[k] < m[k] ? p : m));
      best[k] = b[k];
      bestBy[k] = b.t;
      usual[k] = median(vals.map((p) => p[k]));
    }
    const behind = {};                                           // vs the best
    const vsUsual = {};                                          // vs the group's typical
    for (const k of Object.keys(best)) {
      if (s[k] == null) continue;
      behind[k] = s[k] - best[k];
      vsUsual[k] = s[k] - usual[k];
    }
    compared.push({ ...s, peers, window, best, bestBy, usual, behind, vsUsual, slow: (vsUsual.trip || 0) >= SLOW_DAYS });
  }

  // per vehicle
  const vehicles = [...new Set(data.trips.map((t) => t.veh))].sort().map((veh) => {
    const mine = compared.filter((c) => c.t.veh === veh);
    const lost = mine.map((c) => c.behind.trip || 0);
    const slower = mine.map((c) => c.vsUsual.trip || 0);
    const wins = mine.filter((c) => c.behind.trip === 0).length;
    return {
      veh, trips: mine.length, list: mine,
      avgTrip: avg(mine.map((c) => c.trip).filter((x) => x != null)),
      avgToLoad: avg(mine.map((c) => c.toLoad).filter((x) => x != null)),
      avgLoaded: avg(mine.map((c) => c.loaded).filter((x) => x != null)),
      avgIdle: avg(mine.map((c) => c.idle).filter((x) => x != null)),
      behindToLoad: avg(mine.map((c) => c.behind.toLoad).filter((x) => x != null)) || 0,
      behindLoaded: avg(mine.map((c) => c.behind.loaded).filter((x) => x != null)) || 0,
      behindIdle: avg(mine.map((c) => c.behind.idle).filter((x) => x != null)) || 0,
      lostPerTrip: avg(lost) || 0,                               // vs the best
      daysLost: lost.reduce((a, x) => a + x, 0),
      slowerPerTrip: avg(slower) || 0,                           // vs the typical peer
      daysSlower: slower.reduce((a, x) => a + Math.max(0, x), 0),
      usualToLoad: avg(mine.map((c) => c.vsUsual.toLoad).filter((x) => x != null)) || 0,
      usualLoaded: avg(mine.map((c) => c.vsUsual.loaded).filter((x) => x != null)) || 0,
      usualIdle: avg(mine.map((c) => c.vsUsual.idle).filter((x) => x != null)) || 0,
      slowTrips: mine.filter((c) => c.slow).length,
      wins,
      fillsPerTrip: avg(mine.map((c) => c.fills.length)),
      litresPerTrip: avg(mine.map((c) => c.litres)),
    };
  });
  const usual = median(vehicles.filter((v) => v.trips >= 3).map((v) => v.lostPerTrip)) || 0;
  for (const v of vehicles) {
    v.under = v.trips >= 3 && (v.slowerPerTrip >= 1 || v.slowTrips / v.trips >= 0.4);
    v.watch = v.trips >= 3 && !v.under && v.slowerPerTrip >= 0.5;
    v.top = v.trips >= 3 && !v.under && v.slowerPerTrip <= -0.75;
    const worst = [['toLoad', v.usualToLoad], ['loaded', v.usualLoaded]].sort((a, b) => b[1] - a[1])[0];
    v.worstStage = worst[1] >= 0.5 ? worst[0] : null;
  }
  // a cycle's worth of days, to put days lost into trips
  const cycle = median(compared.map((c) => (c.trip != null ? c.trip + (c.idle || 0) : null)));
  return { compared, vehicles, usual, cycle, stages };
}

// Vehicles on a trip now that are behind the route's usual best (the median
// of each group's best over the last 90 days) or behind trips that started
// with them.
// the group a trip is compared with (also for one still on the road)
export function sameTime(data, t, days = 10) {
  return data.trips.filter((x) => sameRoute(x, t) && x.start && t.start && Math.abs(daysBetween(x.start, t.start)) <= days);
}

export function liveBehind(data, today, perf) {
  const out = [];
  const recent = perf.compared.filter((c) => daysBetween(c.t.start, today) <= 90);
  const bench = (t, k) => median(recent.filter((c) => sameRoute(c.t, t) && c.best[k] != null).map((c) => c.best[k]));
  const vehicles = [...new Set(data.trips.map((t) => t.veh))];
  for (const veh of vehicles) {
    const live = data.trips.filter((t) => t.veh === veh && t.start && !t.unloadDate).sort((a, b) => b.row - a.row)[0];
    if (!live) continue;
    const loaded = !!live.loadDate;
    const k = loaded ? 'loaded' : 'toLoad';
    const sofar = daysBetween(loaded ? live.loadDate : live.start, today);
    const b = bench(live, k);
    // trips on the same route that started within 3 days of this one and are further on
    const mates = data.trips.filter((t) => t !== live && sameRoute(t, live) && t.start && Math.abs(daysBetween(t.start, live.start)) <= 3);
    const ahead = mates.filter((t) => (loaded ? !!t.unloadDate : !!t.loadDate));
    const late = b != null && sofar > b + 1;
    if (late || (ahead.length && b != null && sofar > b)) {
      out.push({ veh, t: live, stage: k, sofar, bench: b, late, ahead });
    }
  }
  return out;
}
