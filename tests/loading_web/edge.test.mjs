// Edge cases of the Tanker Loading mileage model: entries saved twice, dips or
// litres that can't fit in the tank, a corrected Angul size, stock checks whose
// time is off, and data too thin to measure. Each must keep the mileage right,
// raise no false theft alert, and point at the entry to fix.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModel, simulate } from './sim.mjs';

const P = 'OR15R1110', M = 'OD15AF5510';
const sorted = (rows) => rows.sort((a, b) => a.ts - b.ts || (a.cts || 0) - (b.cts || 0));
const run = (s, plate = P) => loadModel(sorted(s.rows), s.trips).analyse(plate);
const checksOf = (an) => an.iv.filter((o) => o.checkOnly).map((o) => o.checks[0]);
const drops = (an) => an.iv.filter((o) => o.sev).length;
const within = (got, want, tol) => got != null && Math.abs(got / want - 1) <= tol;
const refills = (s) => s.rows.filter((r) => r.litres > 0 && r.stock_l != null);
const BOLERO = { plate: M, meter: true, start: 100000, fillTo: 50, refillAt: 10, jobL: [300, 600], days: 90 };

test('a refill saved twice counts once: no false theft alert', () => {
  for (const seed of [3, 8, 13]) {
    const s = simulate({ seed, stockCheckEvery: 2 }); const R = refills(s)[4];
    s.rows.push({ ...R, id: 'dup', cts: R.cts + 60e3 });               // same entry, saved again a minute later
    const an = run(s);
    assert.ok(within(an.current.ratio, s.truth, 0.05), 'mileage');
    assert.equal(drops(an), 0, 'no drop alert');
    assert.equal(checksOf(an).filter((t) => /saved twice/.test(t)).length, 1);
  }
});

test('a stock check saved twice is harmless', () => {
  const s = simulate({ seed: 4, stockCheckEvery: 2 }); const C = s.rows.filter((r) => r.litres === 0)[5];
  s.rows.push({ ...C, id: 'dup', cts: C.cts + 1 });
  const an = run(s);
  assert.ok(within(an.current.ratio, s.truth, 0.05)); assert.equal(drops(an), 0);
});

test('a refill whose dip + litres overflow the 365 L tank is flagged, not alerted', () => {
  const s = simulate({ seed: 6, stockCheckEvery: 2 }); const R = refills(s)[5];
  R.anguls += 6; R.stock_l = R.anguls * 16;                               // dip read 6 Anguls high
  const an = run(s);
  assert.ok(R.stock_l + R.litres > 365 * 1.1 + 32, 'scenario overflows');
  assert.ok(checksOf(an).some((t) => /more than the 365 L tank/.test(t)));
  assert.equal(drops(an), 0, 'no false drop across it');
  assert.ok(within(an.current.ratio, s.truth, 0.05));
});

test('litres typed ×10 on a refill: flagged as overfull, mileage unaffected', () => {
  const s = simulate({ seed: 7, stockCheckEvery: 2 }); const R = refills(s)[6];
  R.litres *= 10;
  const an = run(s);
  assert.ok(checksOf(an).some((t) => /more than the 365 L tank/.test(t)));
  assert.equal(drops(an), 0);
  assert.ok(within(an.current.ratio, s.truth, 0.05));
});

test('dips are re-read at the current Angul size (saved when 1 Angul was another size)', () => {
  const s = simulate({ seed: 10, stockCheckEvery: 2 });                 // the model runs at 16 L per Angul
  for (const r of s.rows) if (r.anguls != null) r.stock_l = r.anguls * 20;   // stored when 1 Angul was 20 L
  const an = run(s);
  assert.ok(within(an.current.ratio, s.truth, 0.05), 'mileage from the Anguls');
  assert.equal(drops(an), 0);
});

test('a dip typed in litres (no Anguls) keeps its litres', () => {
  const s = simulate({ seed: 12, stockCheckEvery: 2 });
  for (const r of s.rows) if (r.anguls != null) r.anguls = null;        // stock_l only
  const an = run(s);
  assert.ok(within(an.current.ratio, s.truth, 0.05)); assert.equal(drops(an), 0);
});

test('a stock check holding a refill saved after it WITHOUT a dip: refill counted once', () => {
  const s = simulate({ seed: 5, stockCheckEvery: 2 }); const R = refills(s)[3];
  const after = R.stock_l + R.litres;
  R.anguls = null; R.stock_l = null;                                    // refill saved without its dip
  s.rows.push({ id: 'S', plate: P, ts: R.ts - 3600e3, cts: 0, odo: R.odo, litres: 0, anguls: after / 16, stock_l: after });
  const an = run(s);
  assert.ok(after + R.litres > 365 * 1.1 + 32, 'scenario: check + refill overflow the tank');
  assert.ok(within(an.current.ratio, s.truth, 0.05)); assert.equal(drops(an), 0);
  assert.ok(checksOf(an).some((t) => /already holds the refill/.test(t)));
});

test('diesel in the tank now never shows more than the tank holds', () => {
  const s = simulate({ seed: 2, stockCheckEvery: 2 });
  const rows = sorted(s.rows), last = rows[rows.length - 1];
  rows.push({ id: 'big', plate: P, ts: last.ts + 3600e3, cts: 9e15, odo: last.odo, litres: 340, anguls: null, stock_l: null });
  const m = loadModel(rows, []), mpl = m.analyse(P).current.ratio;
  const f = m.fuelNow(rows, false, mpl, 0);
  assert.ok(f.stock_now <= 365 && f.after_fill <= 365, `got ${f.stock_now}`);
});

test('two different refills on the same day are not mistaken for a duplicate', () => {
  const s = simulate({ seed: 14, stockCheckEvery: 0 }); const R = refills(s)[4];
  s.rows.push({ ...R, id: 'R2', ts: R.ts + 2 * 3600e3, cts: R.cts + 2 * 3600e3, odo: R.odo + 60, stock_l: R.stock_l, anguls: R.anguls });
  const an = run(s);
  assert.ok(!checksOf(an).some((t) => /saved twice/.test(t)));
});

test('OD15AF5510: a refill saved twice counts once; litres beyond its 50 L tank are flagged', () => {
  const s = simulate({ ...BOLERO, mpl: 60, seed: 3 }); const R = s.rows.filter((r) => r.litres > 0)[8];
  s.rows.push({ ...R, id: 'dup', cts: R.cts + 60e3 });
  let an = run(s, M);
  assert.ok(within(an.current.ratio, 60, 0.05)); assert.equal(drops(an), 0);
  const t = simulate({ ...BOLERO, mpl: 60, seed: 4 }); t.rows.filter((r) => r.litres > 0)[8].litres = 400;
  an = run(t, M);
  assert.ok(checksOf(an).some((x) => /more than the 50 L tank/.test(x)));
  assert.ok(within(an.current.ratio, 60, 0.05)); assert.equal(drops(an), 0);
});

test('too little or odd data: no figure and no error', () => {
  const T = Date.UTC(2026, 9, 1);
  const cases = [
    [],
    [{ id: 'a', plate: P, ts: T, cts: 1, odo: 1000, litres: 300, anguls: 2, stock_l: 32 }],
    [{ id: 'a', plate: P, ts: T, cts: 1, odo: 1000, litres: 300, anguls: null, stock_l: null },
     { id: 'b', plate: P, ts: T + 864e5, cts: 2, odo: 1200, litres: 280, anguls: null, stock_l: null }],
    [{ id: 'a', plate: P, ts: T, cts: 1, odo: 1000, litres: 0, anguls: 10, stock_l: 160 },
     { id: 'b', plate: P, ts: T + 864e5, cts: 2, odo: 1000, litres: 0, anguls: 10, stock_l: 160 }],
  ];
  for (const rows of cases) {
    const m = loadModel(rows, []), an = m.analyse(P);
    assert.equal(an.current.ratio, null);
    assert.equal(m.fuelNow(rows, false, an.current.ratio, 0), null);
  }
});
