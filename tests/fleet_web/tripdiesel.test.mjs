// Diesel trip by trip: allotted, taken, to take, extra, and what carries on. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dieselRecon } from '../../fleet/js/analyse.js';
import { extraKind, fleetDiesel, tripDiesel } from '../../fleet/js/tripdiesel.js';
import { withDefaults } from '../../fleet/js/rules.js';

const trip = (row, o) => ({ row, veh: 'XX01', trip: `T${row}/DEMO`, port: 'Demo Port', dest: 'Demo Plant', month: '2026-10', ...o });
const data = {
  rates: [{ port: 'Demo Port', dest: 'Demo Plant', rate: 3000, diesel: 600 }],
  trips: [
    trip(3, { start: '2026-10-01', loadDate: '2026-10-02', unloadDate: '2026-10-06', gross: 58, ssfcLtr: 650 }),   // 50 L extra
    trip(4, { start: '2026-10-07', loadDate: '2026-10-08', gross: 58, ssfcLtr: 500 }),                            // on the road, 100 L left
    { row: 5, veh: 'XX02', trip: 'T5/DEMO', port: 'Demo Port', dest: 'Demo Plant', month: '2026-10', start: '2026-10-09', ssfcLtr: 300 },  // not loaded yet
  ],
  hsd: [{ date: '2026-10-02', veh: 'XX01', trip: 'T3/DEMO', qty: 650 }, { date: '2026-10-08', veh: 'XX01', trip: 'T4/DEMO', qty: 500 }, { date: '2026-10-09', veh: 'XX02', trip: 'T5/DEMO', qty: 300 }],
  recon: { fromRow: 3, underloadFromRow: 3, overloadOver: 58, underloadBelow: 58, perTonne: 5, noUnderloadPorts: [], rows: {} },
};

test('each trip: allotted, taken, extra, carried in, to take, may still take', () => {
  const recon = dieselRecon(data);
  const td = tripDiesel(data, recon, withDefaults({}));
  const a = td.get(3);
  assert.deepEqual([a.allotted, a.taken, a.extra, a.carryIn, a.after, a.live], [600, 650, 50, 0, -50, false]);
  const b = td.get(4);
  assert.deepEqual([b.allotted, b.taken, b.carryIn, b.toTake, b.mayTake, b.extra, b.after], [600, 500, -50, 100, 50, 0, 50]);
  const c = td.get(5);                                                 // not loaded: the route's diesel, an estimate
  assert.equal(c.est, true);
  assert.deepEqual([c.allotted, c.taken, c.toTake, c.mayTake], [600, 300, 300, 300]);
  assert.equal(c.fills.length, 1);
  const F = fleetDiesel(recon, td, 100);
  assert.equal(F.balance, -50 + 100);                                  // the recon: trip 3 −50, trip 4 +100 (it's loaded)
  assert.equal(F.live.length, 2);
  assert.equal(F.mayTake, 350);
  assert.equal(F.overNow.length, 0);
});

test('extra on the road shows at once, and what is owed eats what is left', () => {
  const d2 = { ...data, trips: data.trips.map((t) => (t.row === 4 ? { ...t, ssfcLtr: 620 } : t)), hsd: data.hsd.map((h) => (h.trip === 'T4/DEMO' ? { ...h, qty: 620 } : h)) };
  const recon = dieselRecon(d2);
  const z = tripDiesel(d2, recon, withDefaults({})).get(4);
  assert.deepEqual([z.extra, z.toTake, z.mayTake, z.after, z.owed], [20, 0, 0, -70, 70]);
  const d3 = { ...data, trips: data.trips.map((t) => (t.row === 4 ? { ...t, ssfcLtr: 570 } : t)) };
  const y = tripDiesel(d3, dieselRecon(d3), withDefaults({})).get(4);
  assert.deepEqual([y.toTake, y.mayTake], [30, 0]);                    // 30 L left of the trip's own, but 50 L owed from before
  // over the allotment: under the 120–140 L mid-way buffer is the driver's extra (deduct), in it the planned
  // buffer, over it an entry to check
  const F = fleetDiesel(dieselRecon(d2), tripDiesel(d2, dieselRecon(d2)));
  assert.deepEqual([F.driverNow.length, F.bufferNow.length, F.overNow.length], [1, 0, 0]);
  assert.deepEqual(z.buffer, { min: 120, max: 140 });
  assert.equal(z.extraKind, 'driver');
  assert.deepEqual([0, 20, 117.9, 118.8, 130, 141.5, 142.1, 365].map((x) => extraKind(x)), ['none', 'driver', 'driver', 'buffer', 'buffer', 'buffer', 'wrong', 'wrong']);   // 2 L rounding either side
  const tight = tripDiesel(d2, recon, withDefaults({ recon: { bufferMin: 10, bufferMax: 15 } })).get(4);
  assert.equal(tight.extraKind, 'wrong');
  assert.equal(tight.beyond, 5);
  assert.equal(fleetDiesel(recon, new Map([[4, tight]])).overNow.length, 1);
  assert.equal(tripDiesel(d2, recon, withDefaults({ recon: { bufferMin: 15, bufferMax: 25 } })).get(4).extraKind, 'buffer');
});

test('a trip with far less diesel tagged than allotted is flagged — normal savings aren\'t', async () => {
  const { missingFills } = await import('../../fleet/js/tripdiesel.js');
  const mk = (row, taken, o = {}) => [row, { t: { row, veh: 'XX01', trip: `T${row}`, port: 'P', dest: 'D', loadDate: '2026-10-01', ...o.t }, allotted: 630, taken, live: !!o.live, est: false, fills: o.fills || [] }];
  const trips = new Map([mk(1, 620), mk(2, 610), mk(3, 600), mk(4, 510), mk(5, 350), mk(6, 0)]);
  const M = missingFills(trips);
  assert.deepEqual([...M.keys()], [5, 6]);                              // 510 of 630 (81%) is a normal saving
  assert.equal(M.get(5).short, 205);                                    // the route usually takes 555 (the median)
  assert.match(M.get(5).text, /Only 350 L tagged against 630 L allotted \(the route usually takes 555 L\)/);
  // on the road: loaded, past the usual refill day, nothing after loading
  const road = new Map([...trips, mk(7, 350, { live: true, t: { loadDate: '2026-10-05' }, fills: [{ date: '2026-10-03', qty: 350 }] })]);
  const lt = { t: road.get(7).t, stage: 'load', steps: [{ key: 'back', typical: '2026-10-07', place: 'Halfway' }] };
  assert.equal(missingFills(road, { live: [lt], today: '2026-10-09' }).get(7).kind, 'refill');
  assert.equal(missingFills(road, { live: [lt], today: '2026-10-07' }).has(7), false);
});

test('own diesel bought for the trip counts; Own Diesel Extra (driver incentive, settled) does not', async () => {
  const { dataChecks } = await import('../../fleet/js/checks.js');
  const d4 = {
    ...data,
    trips: data.trips.map((t) => (t.row === 3 ? { ...t, ssfcLtr: 350, ownLtr: 250, ownAmt: 23000, extraLtr: 40 } : t)),
    hsd: [{ date: '2026-10-02', veh: 'XX01', trip: 'T3/DEMO', qty: 350, source: 'SSFC' }, { date: '2026-10-03', veh: 'XX01', trip: 'T3/DEMO', qty: 250, source: 'Vriddhi Fuels' },
      { date: '2026-10-04', veh: 'XX01', trip: 'T3/DEMO', qty: 40, source: 'Extra Filling' }, ...data.hsd.filter((h) => h.trip !== 'T3/DEMO')],
  };
  const recon = dieselRecon(d4);
  const z = tripDiesel(d4, recon, withDefaults({})).get(3);
  assert.deepEqual([z.taken, z.ssfcL, z.ownL, z.ownRs, z.incentive, z.extra], [600, 350, 250, 23000, 40, 0]);
  assert.equal(z.fills.length, 2);                                     // the incentive fill is kept apart
  assert.equal(z.incentiveFills.length, 1);
  assert.equal(dataChecks(d4).filter((x) => /OWN DIESEL/.test(x.text)).length, 0);
  const off = { ...d4, trips: d4.trips.map((t) => (t.row === 3 ? { ...t, ownLtr: 0 } : t)) };   // own fill in HSD Data, not typed in the register
  assert.match(dataChecks(off).map((x) => x.text).join('\n'), /Own diesel in HSD Data doesn't match .* row 3 \(T3\/DEMO XX01\)/);
});
