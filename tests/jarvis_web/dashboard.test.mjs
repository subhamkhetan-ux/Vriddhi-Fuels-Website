// The home screen's dashboard: every card is drawn from its app's own
// operation (demo data), and amounts are written the Indian way.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DASH_CARDS, litres, rupees } from '../../jarvis/js/dashboard.js';
import { byName, runTool } from '../../jarvis/js/tools.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = iso(new Date());
const ctx = { demo: true, today: TODAY, attachments: new Map(), progress: () => {}, confirm: async () => false };

test('amounts', () => {
  assert.equal(rupees(15262235), '₹1.53 Cr');
  assert.equal(rupees(8471497), '₹84.7 lakh');
  assert.equal(rupees(634296), '₹6.34 lakh');
  assert.equal(rupees(13500), '₹13,500');
  assert.equal(litres(94462), '94,462 L');
  assert.equal(litres(250000), '250 KL');
});

test('every card runs a real operation and draws its answer', async () => {
  assert.equal(new Set(DASH_CARDS.map((c) => c.key)).size, DASH_CARDS.length);
  for (const c of DASH_CARDS) {
    assert.ok(byName.get(c.tool), `${c.key}: no operation ${c.tool}`);
    const out = await runTool(c.tool, c.input(TODAY), ctx);
    assert.ok(out.ok, `${c.key}: ${out.error}`);
    const d = c.draw(out.result.summary, TODAY);
    assert.ok(d.big !== undefined || d.rows?.length, `${c.key} draws nothing`);
    for (const v of [d.big, d.sub, ...(d.rows || []).flat()]) assert.ok(v === undefined || !/undefined|NaN/.test(String(v)), `${c.key}: ${v}`);
  }
});

test('a card copes with an empty answer', () => {
  for (const c of DASH_CARDS) assert.doesNotThrow(() => c.draw({}, TODAY), c.key);
});
