// Tanker Loading — mileage model: accuracy, robustness to bad entries, and
// that real mileage drops are caught while dip noise is not.
// Run: node --test tests/loading_web/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModel, simulate } from './sim.mjs';

const near = (got, want, tol, msg) => assert.ok(got != null && Math.abs(got / want - 1) <= tol,
  `${msg}: got ${got?.toFixed?.(3)}, want ${want} ±${tol * 100}%`);
const run = (s, plate = 'OR15R1110') => loadModel(s.rows, s.trips).analyse(plate);

test('clean refills: within 4% and no alerts', () => {
  const s = simulate(); const an = run(s);
  near(an.current.ratio, s.truth, 0.04, 'mileage');
  assert.equal(an.iv.filter((o) => o.sev).length, 0);
  assert.equal(an.iv.filter((o) => o.checkOnly).length, 0);
});

test('a stock check after every trip (dip in whole Anguls): within 5%, no false drops', () => {
  const s = simulate({ stockCheckEvery: 1 }); const an = run(s);
  near(an.current.ratio, s.truth, 0.05, 'mileage');
  assert.equal(an.iv.filter((o) => o.sev).length, 0);
});

test('litres typed 10× is rejected as a reading error, not a drop', () => {
  const s = simulate({ stockCheckEvery: 2 }); const rf = s.rows.filter((r) => r.litres > 0); rf[rf.length - 3].litres *= 10;
  const an = run(s);
  near(an.current.ratio, s.truth, 0.05, 'mileage');
  assert.ok(an.iv.some((o) => o.checkOnly));
  assert.equal(an.iv.filter((o) => o.sev).length, 0);
});

test('an odometer with an extra digit is flagged and ignored', () => {
  const s = simulate({ stockCheckEvery: 2 }); s.rows[s.rows.length - 4].odo *= 10;
  const an = run(s);
  near(an.current.ratio, s.truth, 0.05, 'mileage');
  assert.ok(an.iv.some((o) => o.checkOnly));
  assert.equal(an.iv.filter((o) => o.sev).length, 0);
});

test('an odometer going backwards is flagged', () => {
  const s = simulate({ stockCheckEvery: 2 }); s.rows[s.rows.length - 6].odo -= 900;
  const an = run(s);
  assert.ok(an.iv.some((o) => o.checkOnly && /lower than/.test(o.checks[0])));
  near(an.current.ratio, s.truth, 0.05, 'mileage');
});

test('a refill without its dip is not a measuring point, and does no harm', () => {
  const s = simulate({ stockCheckEvery: 3 }); const rf = s.rows.filter((r) => r.litres > 0);
  Object.assign(rf[rf.length - 2], { anguls: null, stock_l: null });
  const m = loadModel(s.rows, s.trips);
  assert.equal(m.mileagePoints(s.rows, false).length, s.rows.length - 1);
  near(m.analyse('OR15R1110').current.ratio, s.truth, 0.05, 'mileage');
});

test('80 L stolen in one stretch is reported as a mileage drop (and only that)', () => {
  const s = simulate({ stockCheckEvery: 2, faults: { theftAtTrip: 70, theftL: 80 } }); const an = run(s);
  const drops = an.iv.filter((o) => o.sev > 0);
  assert.ok(drops.length >= 1 && drops.length <= 2, `drops: ${drops.length}`);
  near(an.current.ratio, s.truth, 0.08, 'current mileage');
});

test('not enough data: no figure rather than a guess', () => {
  const s = simulate({ days: 0 });
  s.rows.push({ id: 'x', plate: 'OR15R1110', ts: s.rows[0].ts + 3600e3, cts: 1, odo: s.rows[0].odo + 40, litres: 0, anguls: 20, stock_l: 320 });
  assert.equal(run(s).current.ratio, null);
});

// OD15AF5510 is a Bolero with a ~50 L tank, refilled near dry (≤ 10 L left, counted as 0)
const BOLERO = { plate: 'OD15AF5510', meter: true, start: 100000, fillTo: 50, refillAt: 10, jobL: [300, 600], days: 90 };

test('OD15AF5510 by fuel dispensed (refilled near dry, no dip): within 5%, no false drops', () => {
  const s = simulate({ ...BOLERO, mpl: 60, stockCheckEvery: 3 });
  const an = run(s, 'OD15AF5510');
  near(an.current.ratio, 60, 0.05, 'dispensed per litre');
  assert.equal(an.iv.filter((o) => o.sev).length, 0);
});

test('OD15AF5510 stress: accurate, no false alarms, every 25 L theft from its 50 L tank caught', () => {
  let off = 0, falseDrop = 0, missed = 0;
  for (let seed = 1; seed <= 30; seed++) {
    for (const every of [0, 2, 4]) for (const mpl of [45, 60, 80]) {
      const s = simulate({ ...BOLERO, mpl, seed: seed * 13 + every, stockCheckEvery: every }); const an = run(s, 'OD15AF5510');
      if (Math.abs(an.current.ratio / s.truth - 1) > 0.05) off++;
      if (an.iv.some((o) => o.sev)) falseDrop++;
    }
    const t = simulate({ ...BOLERO, mpl: 60, seed: seed * 7, faults: { theftAtTrip: 60 + (seed % 40), theftL: 25 } });
    if (!run(t, 'OD15AF5510').iv.some((o) => o.sev)) missed++;
  }
  assert.deepEqual({ off, falseDrop, missed }, { off: 0, falseDrop: 0, missed: 0 });
});

test('stress: 40 random fleets — accurate, no false alarms, every 80 L theft caught', () => {
  let off = 0, falseDrop = 0, missed = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const every of [0, 1, 2, 4]) {
      const s = simulate({ seed: seed * 13 + every, stockCheckEvery: every }); const an = run(s);
      if (Math.abs(an.current.ratio / s.truth - 1) > 0.05) off++;
      if (an.iv.some((o) => o.sev)) falseDrop++;
    }
    const t = simulate({ seed: seed * 7, stockCheckEvery: 2, faults: { theftAtTrip: 40 + (seed % 30), theftL: 80 } });
    if (!run(t).iv.some((o) => o.sev)) missed++;
  }
  assert.deepEqual({ off, falseDrop, missed }, { off: 0, falseDrop: 0, missed: 0 });
});

test('diesel in the tank now counts from the last dipped entry', () => {
  const s = simulate({ seed: 11, stockCheckEvery: 3 });
  const rows = s.rows.slice().sort((a, b) => a.ts - b.ts);
  const m = loadModel(rows, s.trips); const mpl = m.analyse('OR15R1110').current.ratio;
  const last = rows[rows.length - 1];
  const f = m.fuelNow(rows, false, mpl, 0);
  // the last entry has a dip: the tank right after it is that dip + whatever was filled
  assert.ok(Math.abs(f.after_fill - (last.stock_l + last.litres)) < 0.11);
  const g = m.fuelNow(rows, false, mpl, 140);                       // one DBL trip sold since
  assert.ok(Math.abs((f.stock_now - g.stock_now) - 140 / mpl) < 0.2);
});
