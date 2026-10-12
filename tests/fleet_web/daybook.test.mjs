// The day book: every dated entry, day by day, with the standard ranges. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayBook, entries, KINDS, ranges, shiftRange, sums } from '../../fleet/js/daybook.js';
import { daybookPagesSvg } from '../../fleet/js/share-svg.js';

const data = {
  trips: [
    { row: 3, veh: 'XX01', trip: 'T001/DEMO', start: '2026-10-01', loadDate: '2026-10-03', unloadDate: '2026-10-08', loadWt: 40, unloadWt: 39.8, diff: -0.2, bhada: 120000, rate: 3000, port: 'Demo Port', dest: 'Demo Plant' },
    { row: 4, veh: 'XX02', trip: 'T002/DEMO', start: '2026-10-03', loadDate: '2026-10-05', loadWt: 41, bhada: 123000, port: 'Demo Port', dest: 'Demo Plant' },
  ],
  hsd: [
    { date: '2026-10-03', veh: 'XX01', trip: 'T001/DEMO', qty: 300, amount: 30000, source: 'SSFC', location: 'Halfway' },
    { date: '2026-10-05', veh: 'XX02', trip: 'T002/DEMO', qty: 200, amount: 19000, source: 'Vriddhi Fuels', location: 'Home pump' },
  ],
  urea: [{ date: '2026-10-05', veh: 'XX02', trip: 'T002/DEMO', qty: 20, amount: 1780, from: 'Demo seller' }],
  driverPay: [{ row: 2, date: '2026-10-05', veh: 'XX02', amount: 2000, name: 'Ramesh', note: '' }],
};
const payments = [{ date: '2026-10-08', month: '2026-09', veh: 'XX01', account: 500000, other: 0, how: 'In SSL account' }, { date: null, month: '2026-08', veh: 'XX01', account: 1, other: 0, how: 'x' }];

test('every dated entry, newest first, linked to its trip', () => {
  const all = entries(data, { payments, driverOf: (t) => (t.veh === 'XX01' ? 'Ramesh' : '') });
  assert.equal(all.length, 2 + 2 + 1 + 2 + 1 + 1 + 1);                 // starts, loads, unload, fills, urea, advance, payment (undated one left out)
  assert.equal(all[0].date, '2026-10-08');
  assert.deepEqual(all.filter((e) => e.date === '2026-10-05').map((e) => e.kind), ['load', 'diesel', 'urea', 'advance']);
  assert.equal(all.find((e) => e.kind === 'diesel' && e.veh === 'XX01').t.row, 3);
  assert.match(all.find((e) => e.kind === 'unload').detail, /short 0\.20 T · 7 days · Ramesh/);
});

test('a range, filtered by type and vehicle, grouped by day with sums', () => {
  const all = entries(data, { payments });
  const b = dayBook(all, { from: '2026-10-03', to: '2026-10-05' });
  assert.deepEqual(b.days.map((d) => d.date), ['2026-10-05', '2026-10-03']);
  assert.equal(b.sums.loads, 2);
  assert.equal(b.sums.tonnes, 81);
  assert.equal(b.sums.freight, 243000);
  assert.equal(b.sums.litres, 500);
  assert.equal(b.sums.ssfcLitres, 300);
  assert.equal(b.sums.advances, 2000);
  assert.equal(b.days[0].sums.urea, 1780);
  assert.equal(dayBook(all, { from: '2026-10-01', to: '2026-10-31', kinds: new Set(['diesel']) }).list.length, 2);
  assert.equal(dayBook(all, { from: '2026-10-01', to: '2026-10-31', veh: 'XX01' }).list.every((e) => e.veh === 'XX01'), true);
  const s = sums(dayBook(all, { from: '2026-10-08', to: '2026-10-08' }).list);
  assert.equal(s.received, 500000);
  assert.equal(s.short, -0.2);
  const pages = daybookPagesSvg(b, { label: '3 – 5 Oct' });
  assert.doesNotMatch(pages.join(''), /undefined|NaN/);
  // each day split by kind, in order, each kind a table of its own
  assert.deepEqual(b.days[0].groups.map((g) => g.kind.key), [...new Set(b.days[0].entries.map((e) => e.kind))].sort((x, y) => KINDS.findIndex((k) => k.key === x) - KINDS.findIndex((k) => k.key === y)));
  assert.equal(b.groups.find((g) => g.kind.key === 'diesel').sums.litres, 500);
  const diesel = b.days.flatMap((d) => d.groups).filter((g) => g.kind.key === 'diesel').flatMap((g) => g.entries);
  assert.ok(diesel.every((e) => 'bill' in e && 'place' in e && 'pump' in e));
  for (const g of b.groups) assert.ok(pages.join('').includes(g.kind.title));
});

test('standard ranges (weeks start Monday) and moving a range by its length', () => {
  const r = ranges('2026-10-11');                                      // a Sunday
  assert.deepEqual(r.week, { label: 'This week', from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(r.lastMonth, { label: 'Last month', from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.yesterday.from, '2026-10-10');
  assert.deepEqual(r.recent, { label: 'Yesterday & today', from: '2026-10-10', to: '2026-10-11' });
  assert.equal(Object.keys(r)[0], 'recent');
  assert.equal(r.fy.from, '2026-04-01');
  assert.equal(ranges('2027-02-15').fy.from, '2026-04-01');
  assert.equal(ranges('2026-10-05').week.from, '2026-10-05');          // Monday
  assert.deepEqual(shiftRange('2026-10-11', '2026-10-11', -1), { from: '2026-10-10', to: '2026-10-10' });
  assert.deepEqual(shiftRange('2026-10-05', '2026-10-11', 1), { from: '2026-10-12', to: '2026-10-18' });
});
