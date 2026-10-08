// Tanker Loading — the tanker's own diesel before its mileage has settled:
// shown from the first refill on, by a first mileage figure or the fleet's.
// Run: node --test tests/loading_web/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModel, simulate } from './sim.mjs';

const P = 'OD23A3710', Q = 'OR15R1110', M = 'OD15AF5510', T = Date.UTC(2026, 9, 1), H = 3600e3;
const near = (got, want, tol = 0.01) => got != null && Math.abs(got - want) <= tol;

test('first refill after a previous one typed without its dip: own diesel shows at once', () => {
  // previous refill: no dip (run dry); now: 450 km on, 200 L in the tank, 150 L filled = 4.5 km/L
  const rows = [
    { id: 'a', plate: P, ts: T, cts: 1, odo: 1000, litres: 300, anguls: null, stock_l: null },
    { id: 'b', plate: P, ts: T + 30 * H, cts: 2, odo: 1450, litres: 150, anguls: 12.5, stock_l: 200 },
  ];
  const m = loadModel(rows, []);
  assert.equal(m.analyse(P).current.ratio, null, 'the settled mileage still waits for two dips');
  const tm = m.tankMileage(P, rows);
  assert.equal(tm.src, 'recent');
  assert.ok(near(tm.mpl, 4.5), `got ${tm.mpl}`);
  const f = m.fuelNow(rows, false, tm.mpl, 0);
  assert.ok(near(f.stock_now, 350, 0.11), `right after the refill: dip + litres, got ${f?.stock_now}`);
  const g = m.fuelNow(rows, false, tm.mpl, 140);                  // one 140 km trip sold since
  assert.ok(near(f.stock_now - g.stock_now, 140 / 4.5, 0.15));
});

test('two dipped refills too close for any mileage: the tank right after the refill still shows', () => {
  const rows = [
    { id: 'a', plate: P, ts: T, cts: 1, odo: 1000, litres: 300, anguls: 2, stock_l: 32 },
    { id: 'b', plate: P, ts: T + 5 * H, cts: 2, odo: 1080, litres: 20, anguls: 19, stock_l: 304 },   // 80 km on 28 L
  ];
  const m = loadModel(rows, []);
  const tm = m.tankMileage(P, rows);
  assert.equal(tm.mpl, null, 'an 80 km hop is too short to trust');
  const st = m.fuelState(P);
  assert.equal(st.mileage, null);
  assert.ok(near(st.stock_now, 324, 0.11), 'dip + litres, nothing burnt since');
  // once a trip is sold (or the odometer moves on) without a mileage, it is unknown
  const m2 = loadModel(rows, [{ plate: P, ts: T + 6 * H, dest: 'Shyam Metalics', total: 12000 }]);
  assert.equal(m2.fuelState(P).stock_now, null);
});

test('the fleet mileage comes before a tanker\'s own first figure', () => {
  // the reported case, but with a settled tanker in the fleet: its own 4.5 km/L
  // rests on a refill without its dip counted as dry, so the fleet's goes first
  const s = simulate({ plate: Q, seed: 3, stockCheckEvery: 2 });
  const rows = s.rows.concat([
    { id: 'a', plate: P, ts: T, cts: 1, odo: 1000, litres: 300, anguls: null, stock_l: null },
    { id: 'b', plate: P, ts: T + 30 * H, cts: 2, odo: 1450, litres: 150, anguls: 12.5, stock_l: 200 },
  ]);
  const m = loadModel(rows, s.trips), tm = m.tankMileage(P, rows);
  assert.equal(tm.src, 'fleet');
  assert.ok(near(tm.mpl, m.analyse(Q).current.ratio, 1e-9));
  assert.ok(near(m.fuelState(P).stock_now, 350, 0.11));
});

test('a first figure over a short hop is not used', () => {
  const rows = [
    { id: 'a', plate: P, ts: T, cts: 1, odo: 1000, litres: 300, anguls: null, stock_l: null },
    { id: 'b', plate: P, ts: T + 9 * H, cts: 2, odo: 1060, litres: 250, anguls: 15, stock_l: 240 },   // 60 km
  ];
  assert.equal(loadModel(rows, []).tankMileage(P, rows).mpl, null);
});

test('a tanker with only its first refill goes by the fleet mileage', () => {
  const s = simulate({ plate: Q, seed: 3, stockCheckEvery: 2 });
  const rows = s.rows.concat([{ id: 'n', plate: P, ts: T, cts: 1, odo: 5000, litres: 300, anguls: 2, stock_l: 32 }]);
  const m = loadModel(rows, s.trips);
  const fleet = m.analyse(Q).current.ratio, tm = m.tankMileage(P, rows);
  assert.equal(tm.src, 'fleet');
  assert.ok(near(tm.mpl, fleet, 1e-9));
  assert.ok(near(m.fuelNow(rows.filter((r) => r.plate === P), false, tm.mpl, 0).stock_now, 332, 0.11));
  // a refill saved without its dip: counted as run dry
  const dry = rows.map((r) => (r.id === 'n' ? { ...r, anguls: null, stock_l: null } : r));
  assert.ok(near(m.fuelNow(dry.filter((r) => r.plate === P), false, tm.mpl, 0).stock_now, 300, 0.11));
});

test('OD15AF5510 never borrows the big tankers\' mileage', () => {
  const s = simulate({ plate: Q, seed: 3 });
  const rows = s.rows.concat([{ id: 'n', plate: M, ts: T, cts: 1, odo: 100000, litres: 40, anguls: null, stock_l: null }]);
  const tm = loadModel(rows, []).tankMileage(M, rows);
  assert.equal(tm.mpl, null);
});

test('a settled mileage is used as before', () => {
  const s = simulate({ plate: Q, seed: 11, stockCheckEvery: 3 });
  const m = loadModel(s.rows, s.trips), tm = m.tankMileage(Q, s.rows);
  assert.equal(tm.src, 'own');
  assert.equal(tm.mpl, m.analyse(Q).current.ratio);
});

test('no entries: still nothing, and no error', () => {
  const m = loadModel([], []);
  const tm = m.tankMileage(P, []);
  assert.equal(tm.mpl, null);
  assert.equal(m.fuelNow([], false, tm.mpl, 0), null);
});
