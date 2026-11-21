// Tanker Loading — loading/slip.js: the density at 15 °C worked out from a
// hydrometer reading and its temperature (the density chart, Table 53B).
// Run: node --test tests/loading_web/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const box = { window: {} };
vm.runInNewContext(readFileSync(new URL('../../loading/slip.js', import.meta.url), 'utf8'), box);
const density15 = box.window.Slip.density15;

test('density at 15 °C: a reading at 15 °C is the answer', () => {
  assert.equal(density15(845, 15), 845);
  assert.equal(density15(830.4, 15), 830.4);
});

test('density at 15 °C: warm diesel reads lighter, cold heavier (about 0.7 kg/m³ a degree)', () => {
  assert.equal(density15(828.2, 32), 840.0);
  assert.equal(density15(830, 30), 840.4);
  assert.equal(density15(820, 40), 837.4);
  assert.equal(density15(850, 10), 846.6);
  for (const [o, t] of [[828.2, 32], [835, 25], [820, 40]]) {
    const per = (density15(o, t) - o) / (t - 15);
    assert.ok(per > 0.6 && per < 0.8, `${o} @ ${t}: ${per} a degree`);
  }
});

test('density at 15 °C: outside the tables, or not a number, there is no answer', () => {
  assert.equal(density15(500, 30), null);
  assert.equal(density15(830, 150), null);
  assert.equal(density15(NaN, 30), null);
  assert.equal(density15(830, NaN), null);
});

// (slip.js runs in its own vm context: results are copied out so deepEqual compares plain values)
const plain = (x) => JSON.parse(JSON.stringify(x));

test('day totals: loaded and sold per tanker, with the total', () => {
  const dayTotals = (...a) => plain(box.window.Slip.dayTotals(...a));
  const ev = [
    { plate: 'OR15R5510', kind: 'load', total: 900, ts: 1 },
    { plate: 'OR15R5510', kind: 'load', total: 282, ts: 2 },
    { plate: 'OR15R5510', kind: 'dispatch', total: 11946, ts: 5, remark: 'Shyam Metalics' },
    { plate: 'OD23A3710', kind: 'load', total: 3000.5, ts: 3 },
    { plate: 'OD23A3710', kind: 'dispatch', total: 11955, ts: 4, remark: 'SMC Unit 2' },
    { plate: 'OD23A3710', total: 100, ts: 6 },                       // no kind: a loading
  ];
  const r = dayTotals(ev, ['OR15R1110', 'OD23A3710', 'OR15R5510'], []);
  assert.deepEqual(r.rows.map((x) => x.plate), ['OR15R1110', 'OD23A3710', 'OR15R5510']);   // the tankers' own order, idle ones too
  assert.deepEqual(r.rows[0], { plate: 'OR15R1110', loadings: 0, loaded: 0, trips: 0, sold: 0, sales: [] });
  const sale = (ts, plate, customer, litres) => ({ ts, plate, customer, litres });          // (these records have no id)
  assert.deepEqual(r.rows[1], { plate: 'OD23A3710', loadings: 2, loaded: 3100.5, trips: 1, sold: 11955, sales: [sale(4, 'OD23A3710', 'SMC Unit 2', 11955)] });
  assert.deepEqual(r.rows[2], { plate: 'OR15R5510', loadings: 2, loaded: 1182, trips: 1, sold: 11946, sales: [sale(5, 'OR15R5510', 'Shyam Metalics', 11946)] });
  assert.deepEqual(r.totals, { loadings: 4, loaded: 4282.5, trips: 2, sold: 23901 });
  assert.deepEqual(r.sales.map((x) => [x.plate, x.customer, x.litres]), [['OD23A3710', 'SMC Unit 2', 11955], ['OR15R5510', 'Shyam Metalics', 11946]]);   // in time order
});

test('day totals: a tanker left out is left out of rows, sales and totals; plates are matched loosely', () => {
  const dayTotals = (...a) => plain(box.window.Slip.dayTotals(...a));
  const ev = [
    { plate: 'OD15AF5510', kind: 'load', total: 950, ts: 1 },
    { plate: 'OD15AF5510', kind: 'dispatch', total: 950, ts: 2, remark: 'x' },
    { plate: 'OR 15 R 5510', kind: 'load', total: 100, ts: 3 },
  ];
  const r = dayTotals(ev, ['OD15AF5510', 'OR15R5510'], ['od15 af 5510']);
  assert.deepEqual(r.rows.map((x) => x.plate), ['OR15R5510']);       // one row for both spellings
  assert.equal(r.rows[0].loaded, 100);
  assert.deepEqual(r.totals, { loadings: 1, loaded: 100, trips: 0, sold: 0 });
  assert.equal(r.sales.length, 0);
});

test('day totals: a day with nothing on it', () => {
  const dayTotals = (...a) => plain(box.window.Slip.dayTotals(...a));
  const r = dayTotals([], ['OR15R5510'], []);
  assert.deepEqual(r.totals, { loadings: 0, loaded: 0, trips: 0, sold: 0 });
  assert.deepEqual(dayTotals(null, null, null).rows, []);
});

test('day totals: a tanker sent for sale twice keeps both sales, in time order, with their ids', () => {
  const dayTotals = (...a) => plain(box.window.Slip.dayTotals(...a));
  const ev = [
    { id: 'b', plate: 'OR15R5510', kind: 'dispatch', total: 11946, ts: 20, remark: 'SMC Unit 2' },
    { id: 'a', plate: 'OR15R5510', kind: 'dispatch', total: 4000, ts: 10, remark: 'Shyam Metalics' },
    { id: 'l', plate: 'OR15R5510', kind: 'load', total: 3982, ts: 5 },
  ];
  const r = dayTotals(ev, ['OR15R5510'], []);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0].sales.map((x) => [x.id, x.customer, x.litres]), [['a', 'Shyam Metalics', 4000], ['b', 'SMC Unit 2', 11946]]);
  assert.equal(r.rows[0].trips, 2);
  assert.equal(r.rows[0].sold, 15946);
});
