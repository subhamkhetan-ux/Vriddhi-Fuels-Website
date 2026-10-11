// Each vehicle on the road now: which stage of the trip it's in, how its pace
// compares with the best, and what the trip should earn.
//
// Stages, learned from the diesel fills in HSD Data (every route runs the same
// way): departed → the outbound fill (Muniguda on our routes) → loaded at the
// port → the return refill → unloaded at the plant. For each route the app
// looks at the trips of the last 150 days: where the outbound and return fills
// happen, and on which day of the trip each step comes — the best (the
// quickest tenth), the typical (the median), and each vehicle's own best.
//
// The projection is the trip's own: freight (loaded × rate, or the vehicle's
// usual load × rate before loading) − diesel (what's been filled for the trip
// so far + what the route usually still needs) − the driver's salary (Setup /
// the Rates sheet, or what the route usually costs) − urea (logged, or the
// usual) − own misc logged on the trip. SSFC's fastag, tyre, maintenance and
// RTO are booked once a month (after a number of trips), and the EMI is
// monthly too: neither belongs to one trip, so they're shown apart, as the
// vehicle's month.

import { routeFor } from './rules.js';
import { addDays, daysBetween, monthOf, round2 } from './util.js';

const lc = (s) => String(s || '').toLowerCase();
const same = (a, b) => lc(a.port) === lc(b.port) && lc(a.dest) === lc(b.dest);
const median = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const quick = (xs) => {                                          // the best: quickest tenth
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length < 10 ? v[0] : v[Math.floor(v.length * 0.1)];
};
const mode = (xs) => {
  const m = new Map();
  xs.filter(Boolean).forEach((x) => m.set(x, (m.get(x) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};
const MAIN_FILL = 100;
const YEARLY = /insurance|permit|road\s*tax|fitness|fleet\s*edge|registration|\bpuc\b|\btax\b/i;   // as trends.js                                           // litres: smaller is a top-up

export const STEPS = ['start', 'out', 'load', 'back', 'unload'];

function fillsOf(data, t) {
  return (data.hsd || []).filter((h) => h.veh === t.veh && h.trip === t.trip && (!t.start || h.date >= t.start))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
// a trip's fills split around the loading
function split(t, fills) {
  const pre = t.loadDate ? fills.filter((h) => h.date < t.loadDate) : fills;
  const post = t.loadDate ? fills.filter((h) => h.date > t.loadDate) : [];
  const atLoad = t.loadDate ? fills.filter((h) => h.date === t.loadDate) : [];
  // a fill on the loading day counts on the outbound side unless there's already a main outbound fill
  if (atLoad.length) (pre.some((h) => h.qty >= MAIN_FILL) ? post : pre).push(...atLoad);
  pre.sort((a, b) => (a.date < b.date ? -1 : 1));
  post.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { pre, post, out: pre.find((h) => h.qty >= MAIN_FILL) || null, back: post[0] || null };
}

// what a route usually looks like (and this vehicle's best on it)
export function routeProfile(data, t, today, veh = null) {
  let hist = data.trips.filter((x) => x.status === 'done' && same(x, t) && x.start && x.unloadDate && x.unloadDate <= today
    && daysBetween(x.start, today) <= 150 && daysBetween(x.start, x.unloadDate) >= 0 && daysBetween(x.start, x.unloadDate) <= 45);
  if (hist.length < 5) hist = data.trips.filter((x) => x.status === 'done' && same(x, t) && x.start && x.unloadDate && x.unloadDate <= today && daysBetween(x.start, x.unloadDate) <= 45);
  const rows = hist.map((x) => {
    const f = fillsOf(data, x);
    const sp = split(x, f);
    return {
      x, veh: x.veh,
      out: sp.out ? daysBetween(x.start, sp.out.date) : null, outPlace: sp.out?.location,
      load: daysBetween(x.start, x.loadDate),
      back: sp.back ? daysBetween(x.start, sp.back.date) : null, backPlace: sp.back?.location,
      unload: daysBetween(x.start, x.unloadDate),
      litres: f.reduce((a, h) => a + h.qty, 0), price: f.length ? f[f.length - 1].rsp : null, loadWt: x.loadWt,
      driver: (x.drvSsfc || 0) + (x.drvTrip || 0) + (x.drvExtra || 0) || null, rate: x.rate,
      // the trip's own result: freight − diesel − driver − urea (no monthly charges, no EMI)
      before: x.bhada ? x.bhada - (x.ssfcAmt || 0) - (x.ownAmt || 0) - (x.drvSsfc || 0) - (x.drvTrip || 0) - (x.drvExtra || 0) - (x.urea || 0) : null,
    };
  });
  const prof = { trips: rows.length, outPlace: mode(rows.map((r) => r.outPlace)), backPlace: mode(rows.map((r) => r.backPlace)) };
  for (const k of ['out', 'load', 'back', 'unload']) {
    prof[k] = { best: quick(rows.map((r) => r[k])), typical: median(rows.map((r) => r[k])), own: veh ? quick(rows.filter((r) => r.veh === veh).map((r) => r[k])) : null };
  }
  prof.start = { best: 0, typical: 0, own: 0 };
  prof.litres = median(rows.map((r) => r.litres).filter((x) => x > 0));
  prof.price = median(rows.map((r) => r.price));
  prof.driver = median(rows.map((r) => r.driver));
  prof.rate = rows.length ? [...rows].sort((a, b) => (a.x.start < b.x.start ? 1 : -1))[0].rate : null;
  prof.before = median(rows.map((r) => r.before));
  return prof;
}

// the vehicle's last 90 days: urea a trip and its usual load; SSFC's monthly
// charges and the EMI a month (they're booked once a month, not per trip)
function usualCosts(data, veh, today) {
  const recent = data.trips.filter((x) => x.veh === veh && x.status === 'done' && x.loadDate && daysBetween(x.loadDate, today) <= 90);
  const n = recent.length || 1;
  const s = (f) => recent.reduce((a, x) => a + (f(x) || 0), 0);
  const months = new Set(recent.map((x) => monthOf(x.loadDate))).size || 1;
  const emis = recent.filter((x) => x.emi).map((x) => x.emi);
  return {
    trips: recent.length,
    monthly: s((x) => (x.fastag || 0) + (x.maint || 0) + (x.tyre || 0) + (x.rtoEntry || 0) + (x.rtoChallan || 0) + (x.docExp || 0) + (x.ssfcMisc || 0)) / months,
    tripsAMonth: recent.length / months,
    urea: s((x) => x.urea) / n,
    loadWt: median(recent.map((x) => x.loadWt)),
    emi: emis.length ? median(emis) : 0,
  };
}

export function liveTrip(data, settings, today, t) {
  const fills = fillsOf(data, t);
  const sp = split(t, fills);
  const prof = routeProfile(data, t, today, t.veh);
  const el = daysBetween(t.start, today);
  const at = {
    start: t.start, out: sp.out ? sp.out.date : null, load: t.loadDate || null, back: t.loadDate && sp.back ? sp.back.date : null, unload: t.unloadDate || null,
  };
  // where it is now
  let stage;
  if (t.unloadDate) stage = 'unload';
  else if (at.back) stage = 'back';
  else if (at.load) stage = 'load';
  else if (at.out) stage = 'out';
  else stage = 'start';
  const next = STEPS[STEPS.indexOf(stage) + 1] || null;
  const port = t.port;
  const dest = t.dest;
  const outPlace = sp.out?.location || prof.outPlace || 'the outbound pump';
  const backPlace = sp.back?.location || prof.backPlace || 'the return pump';
  const waiting = stage === 'out' && prof.load.typical != null && el >= prof.load.typical;
  const phase = {
    start: { title: `Departed — heading to ${outPlace} for diesel`, short: `To ${outPlace}` },
    out: waiting ? { title: `At ${port} — waiting to load`, short: `At ${port}` } : { title: `Diesel at ${outPlace} — heading to ${port}`, short: `To ${port}` },
    load: { title: `Loaded at ${port} — heading back, diesel at ${backPlace}`, short: `To ${backPlace}` },
    back: { title: `Refilled at ${backPlace} — heading to ${dest}`, short: `To ${dest}` },
    unload: { title: `Unloaded at ${dest}`, short: 'Unloaded' },
  }[stage];
  // pace: the steps done against the best / typical / own best, and the next one if it's overdue
  const pace = {};
  for (const ref of ['best', 'typical', 'own']) {
    let late = null;
    for (const k of STEPS.slice(1)) {
      if (!at[k] || prof[k][ref] == null) continue;
      late = daysBetween(t.start, at[k]) - prof[k][ref];
    }
    if (next && prof[next] && prof[next][ref] != null && el > prof[next][ref]) late = Math.max(late ?? -99, el - prof[next][ref]);
    pace[ref] = late;
  }
  const status = pace.typical != null && pace.typical >= 1 ? 'late' : pace.best != null && pace.best >= 1 ? 'behind' : 'good';
  const steps = STEPS.map((k) => ({
    key: k, done: !!at[k], date: at[k],
    place: { start: '', out: outPlace, load: port, back: backPlace, unload: dest }[k],
    name: { start: 'Departed', out: 'Diesel', load: 'Loaded', back: 'Refill', unload: 'Unloaded' }[k],
    best: prof[k].best != null ? addDays(t.start, prof[k].best) : null,
    typical: prof[k].typical != null ? addDays(t.start, prof[k].typical) : null,
    current: k === stage,
  }));
  const etaTypical = prof.unload.typical != null ? addDays(t.start, prof.unload.typical + Math.max(0, pace.typical || 0)) : null;
  const etaBest = prof.unload.best != null ? addDays(t.start, prof.unload.best) : null;

  // the projection
  const u = usualCosts(data, t.veh, today);
  const rate = t.rate || prof.rate || ((data.rates || []).find((r) => same(r, t)) || {}).rate || 0;
  const loadWt = t.loadWt || u.loadWt || median(data.trips.filter((x) => same(x, t) && x.loadWt).slice(-20).map((x) => x.loadWt)) || 0;
  const freight = t.bhada || round2(loadWt * rate);
  const litresSoFar = fills.reduce((a, h) => a + h.qty, 0);
  const dieselSoFar = fills.reduce((a, h) => a + h.amount, 0);
  const price = fills.length ? fills[fills.length - 1].rsp : prof.price || 0;
  const litresLeft = t.unloadDate ? 0 : Math.max(0, (prof.litres || 0) - litresSoFar);
  const dieselLeft = round2(litresLeft * price);
  const r = routeFor(data, settings, t.port, t.dest, t.month || monthOf(today));
  const advances = (t.drvTrip || 0) + (t.drvExtra || 0);
  const extra = settings && settings.driver && settings.driver.extraIsAdvance ? 0 : t.drvExtra || 0;   // promised on top of the salary
  const driver = (r.salary ?? (t.drvSsfc != null ? (t.drvSsfc || 0) + (t.drvTrip || 0) : prof.driver || 0)) + extra;
  const urea = t.urea ?? u.urea;
  // own misc / documents logged on this trip — unless it's a yearly cost (road tax, insurance, permit …) booked on it
  const yearlyCost = YEARLY.test(t.remarks || '') ? (t.ownMisc || 0) + (t.docOwn || 0) : 0;
  const ownOther = yearlyCost ? 0 : (t.ownMisc || 0) + (t.docOwn || 0);
  const before = round2(freight - dieselSoFar - dieselLeft - driver - urea - ownOther);
  const projection = {
    freight, loaded: !!t.bhada, loadWt, rate, dieselSoFar, litresSoFar, litresLeft, dieselLeft, price, driver, driverFrom: r.salaryFrom === 'app' ? 'setup' : r.salaryFrom === 'rates' ? 'rates' : 'usual', advances,
    urea: round2(urea), ureaLogged: t.urea != null, ownOther: round2(ownOther), yearly: round2(yearlyCost), yearlyWhat: yearlyCost ? t.remarks : '', before,
    monthly: round2(u.monthly), emi: round2(u.emi), tripsAMonth: u.tripsAMonth,
    usual: prof.before, basis: u.trips,
  };
  return { veh: t.veh, t, prof, stage, next, phase, steps, at, el, pace, status, etaTypical, etaBest, fills, projection };
}

export function liveTrips(data, settings, today) {
  const out = [];
  for (const veh of [...new Set(data.trips.map((t) => t.veh))].sort()) {
    const live = data.trips.filter((t) => t.veh === veh && t.start && !t.unloadDate).sort((a, b) => b.row - a.row)[0];
    if (live) out.push(liveTrip(data, settings, today, live));
  }
  return out;
}
