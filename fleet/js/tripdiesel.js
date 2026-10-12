// Diesel trip by trip: how much of the trip's allotment has been taken, how
// much is still to take, and any extra — carried on to the next trips.
//
// Each trip is allotted its route's diesel + overload − underload (the Recon
// Engine's figures, analyse.js dieselRecon()). Taken = the fills tagged to
// the trip: SSFC's diesel + our own (the Trip Register's OWN DIESEL for Trip,
// bought when SSFC can't supply). Own Diesel Extra is incentive diesel for
// the driver, already settled — it isn't counted against the allotment.
// Diesel a driver takes over the allotment isn't lost: it's owed back, out of
// the next trips' allotments — so every trip starts with the balance the
// vehicle carries in from the trips before it:
//   carry in    the running balance before this trip (− = extra still owed)
//   may take    this trip's allotment + carry in (what's left to fill, net)
//   to take     what's left of this trip's own allotment
//   extra       taken over this trip's allotment
//   after       the balance this trip leaves
// Up to `buffer` litres over (settings.recon.buffer, 200 L) is planned: filled
// mid-way so the truck can unload and get back mid-way without refilling at
// the congested pumps near the plant — it comes off the next trip. Only past
// it is a trip over its allotment in earnest.
// A trip not loaded yet has no gross weight: its allotment is the route's
// base diesel until it's loaded (marked as an estimate). Pure functions.

import { routeFor } from './rules.js';

const r1 = (n) => Math.round(n * 10) / 10;
const lc = (s) => String(s || '').trim().toLowerCase();

// recon: analyse.js dieselRecon(); → Map(trip row → the trip's diesel)
export function tripDiesel(data, recon, settings = null) {
  const out = new Map();
  const b = settings && settings.recon ? Number(settings.recon.buffer) : NaN;
  const buffer = Number.isFinite(b) && b >= 0 ? b : 200;
  const rateOf = (t) => (data.rates || []).find((x) => lc(x.port) === lc(t.port) && lc(x.dest) === lc(t.dest));
  const fillsOf = new Map();
  for (const h of data.hsd || []) {
    const k = `${h.veh}|${h.trip}`;
    if (!fillsOf.has(k)) fillsOf.set(k, []);
    fillsOf.get(k).push(h);
  }
  for (const v of recon.vehicles) {
    let run = 0;
    for (const x of v.list) {
      const t = x.t;
      const tagged = (fillsOf.get(`${t.veh}|${t.trip}`) || []).filter((h) => !t.start || h.date >= t.start).sort((a, b) => (a.date < b.date ? -1 : 1));
      const fills = tagged.filter((h) => lc(h.source) !== 'extra filling');             // incentive diesel: not part of the trip's
      const incentiveFills = tagged.filter((h) => lc(h.source) === 'extra filling');
      let { allotted, base } = x;
      let est = false;
      if (allotted == null) {
        const app = settings ? routeFor(data, settings, t.port, t.dest, t.month) : {};
        base = app.diesel ?? (rateOf(t) ? rateOf(t).diesel : null);
        allotted = base || null;
        est = true;
      }
      const taken = x.issued || 0;
      const carryIn = r1(run);
      const live = !t.unloadDate;
      const d = {
        t, allotted, base, over: x.over || 0, under: x.under || 0, est, taken, fills, incentiveFills, carryIn, live,
        ssfcL: t.ssfcLtr || 0, ownL: t.ownLtr || 0, ownRs: t.ownAmt || 0, incentive: t.extraLtr || 0,
        extra: allotted != null ? r1(Math.max(0, taken - allotted)) : 0, buffer,
        toTake: allotted != null && live ? r1(Math.max(0, allotted - taken)) : 0,
        mayTake: allotted != null && live ? r1(Math.max(0, allotted + carryIn - taken)) : 0,
        after: allotted != null ? r1(carryIn + allotted - taken) : r1(carryIn - taken),
      };
      d.owed = r1(Math.max(0, -d.after));                     // extra still to come out of the next trips
      d.beyond = r1(Math.max(0, d.extra - buffer));            // over even the mid-way buffer
      out.set(t.row, d);
      // the running balance moves as the recon's does (a trip without an allotment yet doesn't count)
      if (x.allotted != null) run += x.balance;
    }
  }
  return out;
}

// each counted fill's place in its trip's allotment: what the trip had before it and after it
// trips: tripDiesel(); → Map(the HSD Data row → { before, after, allotted, est, trip })
export function fillProgress(trips) {
  const out = new Map();
  for (const z of trips.values()) {
    let run = 0;
    for (const h of z.fills) {
      const before = run;
      run = r1(run + (h.qty || 0));
      out.set(h, { before: r1(before), after: run, allotted: z.allotted, est: z.est, trip: z.t, buffer: z.buffer });
    }
  }
  return out;
}

// the fleet: who owes diesel back, who's saved, what the trips on the road may still take
export function fleetDiesel(recon, trips, price = 0) {
  const vehicles = recon.vehicles.map((v) => ({ veh: v.veh, balance: v.balance }));
  const owed = vehicles.filter((v) => v.balance < -0.5);
  const saved = vehicles.filter((v) => v.balance > 0.5);
  const live = [...trips.values()].filter((d) => d.live && d.t.start);
  return {
    balance: recon.total,
    owedL: owed.reduce((a, v) => a - v.balance, 0), owed: owed.sort((a, b) => a.balance - b.balance),
    savedL: saved.reduce((a, v) => a + v.balance, 0), saved,
    owedRs: Math.round(owed.reduce((a, v) => a - v.balance, 0) * price),
    live, overNow: live.filter((d) => d.beyond > 0.5), bufferNow: live.filter((d) => d.extra > 0.5 && d.beyond <= 0.5),
    toTake: live.reduce((a, d) => a + d.toTake, 0), mayTake: live.reduce((a, d) => a + d.mayTake, 0),
  };
}

// Fills that may be missing: a trip with far less diesel tagged than its
// allotment — less than 75% of it, and 100 L+ under what the route usually
// takes — most likely has a fill that was never reported or entered (in HSD
// Data, against this trip). Normal savings run to about 20% under, so they
// aren't flagged. A trip on the road is flagged once it's loaded and past
// the usual day of its return refill with no fill after loading.
// live: live.js liveTrips() (optional); → Map(trip row → { kind, short, typical, text })
export function missingFills(trips, { live = [], today = null } = {}) {
  const out = new Map();
  const done = [...trips.values()].filter((z) => !z.live && z.allotted && !z.est);
  const key = (t) => `${lc(t.port)}|${lc(t.dest)}`;
  const typical = new Map();
  for (const z of done) {
    const k = key(z.t);
    if (!typical.has(k)) typical.set(k, []);
    typical.get(k).push(z.taken);
  }
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
  for (const [k, xs] of typical) typical.set(k, median(xs));
  for (const z of done) {
    const usual = typical.get(key(z.t));
    if (z.taken < 0.75 * z.allotted && (usual == null || z.taken < usual - 100)) {
      const short = r1((usual != null ? Math.min(usual, z.allotted) : z.allotted) - z.taken);
      out.set(z.t.row, {
        kind: 'low', short, typical: usual,
        text: `Only ${Math.round(z.taken)} L tagged against ${Math.round(z.allotted)} L allotted${usual != null ? ` (the route usually takes ${Math.round(usual)} L)` : ''} — a fill of about ${Math.round(short)} L may not have been reported or entered`,
      });
    }
  }
  for (const lt of live) {
    const z = trips.get(lt.t.row);
    if (!z || lt.stage !== 'load' || !today) continue;
    const back = lt.steps.find((s) => s.key === 'back');
    if (back && back.typical && today > back.typical) {
      const after = z.fills.filter((h) => lt.t.loadDate && h.date > lt.t.loadDate);
      if (!after.length) out.set(lt.t.row, { kind: 'refill', short: null, typical: null, text: `Loaded on ${lt.t.loadDate.slice(8, 10)}/${lt.t.loadDate.slice(5, 7)} and past the usual day of the refill at ${back.place || 'the return pump'} — no refill entered yet` });
    }
  }
  return out;
}
