// Home → Lifting pace: this month to date against last month to the same date.
import assert from 'node:assert/strict';
import test from 'node:test';

import { liftingPaces, paceWindows } from '../../ledger/js/dash.js';

const data = {
  customers: [['a', 'Alpha Transport', 'Alpha', null], ['b', 'Beta Roadways', 'Beta', null], ['s1', 'Steel One Ltd', null, 'Steel_Bulk'],
    ['s2', 'Steel One Ltd Unit 2', null, 'Steel_Bulk'], ['n', 'New Movers', 'New', null], ['g', 'Gone Carriers', 'Gone', null]],
  groups: [['Steel_Bulk', 'Steel One Ltd — Bulk Ledger — Diesel']],
  sales: [
    ['2026-10-05', 'HSD', 'a', 1000, 0, 1], ['2026-11-04', 'HSD', 'a', 1500, 0, 1],            // +500 (+50%)
    ['2026-10-10', 'HSD', 'b', 400, 0, 1], ['2026-11-10', 'MS', 'b', 200, 0, 1],               // −200 (−50%)
    ['2026-10-02', 'HSD', 's1', 5000, 0, 1], ['2026-11-02', 'HSD', 's1', 4000, 0, 1], ['2026-11-12', 'HSD', 's2', 3000, 0, 1],  // bulk: 8000 vs 5000
    ['2026-11-15', 'XG', 'n', 300, 0, 1],                                                     // new this month
    ['2026-10-15', 'HSD', 'g', 700, 0, 1],                                                    // nothing this month
    ['2026-10-19', 'HSD', 'a', 9999, 0, 1], ['2026-11-19', 'HSD', 'a', 9999, 0, 1],            // after the date: left out
    ['2026-11-05', 'OTHER', 'a', 5, 0, 1], ['2026-09-30', 'HSD', 'b', 7777, 0, 1],              // a lube, and before last month
  ],
};

test('paceWindows: the 1st to today, and last month to the same date', () => {
  assert.deepEqual(paceWindows('2026-11-18'), { day: 18, cur: { from: '2026-11-01', to: '2026-11-18' }, prev: { from: '2026-10-01', to: '2026-10-18' } });
  assert.equal(paceWindows('2026-03-31').prev.to, '2026-02-28');
  assert.equal(paceWindows('2027-01-05').prev.from, '2026-12-01');
});

test('liftingPaces: bulk sheets together, fuel only, best gain first', () => {
  const p = liftingPaces(data, '2026-11-18');
  assert.deepEqual(p.list.map((e) => [e.name, e.kind, e.cur, e.prev, e.diff]), [
    ['Steel One Ltd', 'bulk', 7000, 5000, 2000],
    ['Alpha Transport', 'retail', 1500, 1000, 500],
    ['New Movers', 'retail', 300, 0, 300],
    ['Beta Roadways', 'retail', 200, 400, -200],
    ['Gone Carriers', 'retail', 0, 700, -700],
  ]);
  assert.equal(p.list[0].id, 'g:Steel_Bulk');
  assert.equal(p.list[1].change, 0.5);
  assert.equal(p.list[2].change, null);
});

test('liftingPaces by % change: new lifting first, then the biggest rise', () => {
  const p = liftingPaces(data, '2026-11-18', { sort: 'pct' });
  assert.deepEqual(p.list.map((e) => e.name), ['New Movers', 'Alpha Transport', 'Steel One Ltd', 'Beta Roadways', 'Gone Carriers']);
});

test('paceListSvg: the list as shown, with the totals and each change', async () => {
  const { paceListSvg } = await import('../../ledger/js/share-svg.js');
  const pace = liftingPaces(data, '2026-11-18');
  const { svg, size } = paceListSvg({ pace, label: '', sortLabel: 'by litres gained', asOn: '2026-11-18' });
  for (const t of ['Lifting pace', 'Steel One Ltd', '7,000 L', 'vs 5,000 L', '+2,000 L', '▲ 40%', 'Beta Roadways', '▼ 50%', 'none last month', '1–18 Nov', '1–18 Oct', '9,000 L', '7,100 L', '▲ 27%']) assert.ok(svg.includes(t), t);
  assert.ok(svg.indexOf('Steel One Ltd') < svg.indexOf('Gone Carriers'));
  assert.equal(size.width, 1080);
  const bulk = paceListSvg({ pace: { ...pace, list: pace.list.filter((e) => e.kind === 'bulk') }, label: 'Bulk', asOn: '2026-11-18' }).svg;
  assert.ok(bulk.includes('Lifting pace · Bulk') && !bulk.includes('Alpha Transport'));
});
