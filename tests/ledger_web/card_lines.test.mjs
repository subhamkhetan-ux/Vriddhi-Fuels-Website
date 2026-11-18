// The outstanding card's extra lines: retail — what's still owed from before
// the month; bulk — how fast they're lifting against last month.
import assert from 'node:assert/strict';
import test from 'node:test';

import { cardOf, liftingPace, pendingBefore } from '../../ledger/js/outstanding.js';
import { outstandingCardSvg } from '../../ledger/js/share-svg.js';

const totals = (received, tds = 0, shortage = 0) => ({ billed: 434392, qty: 4311.99, received, tds, shortage, bills: 9, payments: 1 });

test('pendingBefore: the opening less everything received since, never below nil', () => {
  // the card in the question: ₹37,07,767 opening, ₹11,80,640 received
  assert.deepEqual(pendingBefore({ opening: 3707767, from: '2026-11-01', totals: totals(1180640) }), { before: '2026-11-01', opening: 3707767, amount: 2527127 });
  assert.equal(pendingBefore({ opening: 50000, from: '2026-11-01', totals: totals(30000, 1000, 500) }).amount, 18500);
  assert.equal(pendingBefore({ opening: 50000, from: '2026-11-01', totals: totals(60000) }).amount, 0);   // cleared
  assert.equal(pendingBefore({ opening: 0, from: '2026-11-01', totals: totals(0) }), null);
  assert.equal(pendingBefore({ opening: -2000, from: '2026-11-01', totals: totals(0) }), null);          // an advance
});

const bill = (date, qty) => ({ type: 'bill', date, qty });
test('liftingPace: 1st to today against the same days last month', () => {
  const entries = [bill('2026-10-02', 1000), bill('2026-10-18', 500), bill('2026-10-19', 9999), bill('2026-11-01', 800),
    bill('2026-11-18', 400), { type: 'pay', date: '2026-11-05', qty: 0 }, bill('2026-09-30', 7777)];
  const p = liftingPace(entries, '2026-11-18');
  assert.deepEqual([p.cur.from, p.cur.to, p.cur.qty], ['2026-11-01', '2026-11-18', 1200]);
  assert.deepEqual([p.prev.from, p.prev.to, p.prev.qty], ['2026-10-01', '2026-10-18', 1500]);
  assert.equal(Math.round(p.change * 100), -20);
  // a 31st against a 30-day month; January against December
  assert.equal(liftingPace([], '2026-12-31').prev.to, '2026-11-30');
  assert.deepEqual([liftingPace([], '2027-01-10').prev.from, liftingPace([], '2027-01-10').prev.to], ['2026-12-01', '2026-12-10']);
  assert.equal(liftingPace([bill('2026-11-02', 10)], '2026-11-18').change, null);   // nothing last month
});

test('the card shows the line for retail and the pace for bulk', () => {
  const st = { name: 'Retail Co', kind: 'retail', opening: 3707767, closing: 2961518, from: '2026-11-01', totals: totals(1180640), entries: [] };
  const retail = outstandingCardSvg(cardOf(st, { asOn: '2026-11-18' })).svg;
  assert.match(retail, /Pending from previous months/);
  assert.match(retail, /₹25,27,127/);
  assert.doesNotMatch(retail, /LIFTING PACE/);
  const bst = { ...st, name: 'Bulk Co', kind: 'bulk', entries: [bill('2026-10-03', 3000), bill('2026-11-04', 3600)] };
  const bulk = outstandingCardSvg(cardOf(bst, { asOn: '2026-11-18' })).svg;
  assert.match(bulk, /LIFTING PACE/);
  assert.match(bulk, /3,600 L/);
  assert.match(bulk, /3,000 L/);
  assert.match(bulk, /▲ 20% more/);
  assert.doesNotMatch(bulk, /Pending from previous/);
});
