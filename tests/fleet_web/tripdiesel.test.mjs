// Diesel trip by trip: allotted, taken, to take, extra, and what carries on. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dieselRecon } from '../../fleet/js/analyse.js';
import { fleetDiesel, tripDiesel } from '../../fleet/js/tripdiesel.js';
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
  assert.equal(fleetDiesel(dieselRecon(d2), tripDiesel(d2, dieselRecon(d2))).overNow.length, 1);
});
