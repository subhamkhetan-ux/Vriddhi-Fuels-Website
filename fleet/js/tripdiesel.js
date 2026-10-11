// Diesel trip by trip: how much of the trip's allotment has been taken, how
// much is still to take, and any extra — carried on to the next trips.
//
// Each trip is allotted its route's diesel + overload − underload (the Recon
// Engine's figures, analyse.js dieselRecon()). Taken = the fills tagged to
// the trip (SSFC + own pump; the Trip Register's litres are those fills).
// Diesel a driver takes over the allotment isn't lost: it's owed back, out of
// the next trips' allotments — so every trip starts with the balance the
// vehicle carries in from the trips before it:
//   carry in    the running balance before this trip (− = extra still owed)
//   may take    this trip's allotment + carry in (what's left to fill, net)
//   to take     what's left of this trip's own allotment
//   extra       taken over this trip's allotment
//   after       the balance this trip leaves
// A trip not loaded yet has no gross weight: its allotment is the route's
// base diesel until it's loaded (marked as an estimate). Pure functions.

import { routeFor } from './rules.js';

const r1 = (n) => Math.round(n * 10) / 10;
const lc = (s) => String(s || '').trim().toLowerCase();

// recon: analyse.js dieselRecon(); → Map(trip row → the trip's diesel)
export function tripDiesel(data, recon, settings = null) {
  const out = new Map();
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
      const fills = (fillsOf.get(`${t.veh}|${t.trip}`) || []).filter((h) => !t.start || h.date >= t.start).sort((a, b) => (a.date < b.date ? -1 : 1));
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
        t, allotted, base, over: x.over || 0, under: x.under || 0, est, taken, fills, extraHsd: t.extraLtr || 0, carryIn, live,
        extra: allotted != null ? r1(Math.max(0, taken - allotted)) : 0,
        toTake: allotted != null && live ? r1(Math.max(0, allotted - taken)) : 0,
        mayTake: allotted != null && live ? r1(Math.max(0, allotted + carryIn - taken)) : 0,
        after: allotted != null ? r1(carryIn + allotted - taken) : r1(carryIn - taken),
      };
      d.owed = r1(Math.max(0, -d.after));                     // extra still to come out of the next trips
      out.set(t.row, d);
      // the running balance moves as the recon's does (a trip without an allotment yet doesn't count)
      if (x.allotted != null) run += x.balance;
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
    live, overNow: live.filter((d) => d.extra > 0.5),
    toTake: live.reduce((a, d) => a + d.toTake, 0), mayTake: live.reduce((a, d) => a + d.mayTake, 0),
  };
}
