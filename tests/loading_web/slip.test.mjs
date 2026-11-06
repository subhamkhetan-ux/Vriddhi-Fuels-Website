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
