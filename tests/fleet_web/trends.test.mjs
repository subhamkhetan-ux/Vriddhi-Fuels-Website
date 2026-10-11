// Rates, costs and what's kept over time — made-up trips only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyTrend, rateChanges, rateEras, splitTrip, summary } from '../../fleet/js/trends.js';
import { driverCheck, withDefaults } from '../../fleet/js/rules.js';

let row = 3;
function trip(o) {
  const t = { row: row++, veh: 'A', trip: `T${row}`, port: 'Kakinada', dest: 'BALCO', status: 'done', loadWt: 40, remarks: '', ...o };
  t.month = t.loadDate.slice(0, 7);
  t.bhada = t.loadWt * t.rate;
  const costs = (t.ssfcAmt || 0) + (t.drvSsfc || 0) + (t.fastag || 0) + (t.tyre || 0) + (t.maint || 0) + (t.rtoEntry || 0) + (t.ownMisc || 0) + (t.docOwn || 0) + (t.urea || 0) + (t.emi || 0);
  t.income = t.bhada - costs;
  return t;
}

test('a trip\'s freight splits into its costs and what\'s kept', () => {
  const t = trip({ loadDate: '2026-01-05', rate: 3000, ssfcAmt: 60000, ssfcLtr: 600, drvSsfc: 10000, fastag: 5000, tyre: 4000, urea: 1000, emi: 50000 });
  const s = splitTrip(t);
  assert.equal(s.bhada, 120000);
  assert.deepEqual([s.diesel, s.driver, s.fastag, s.tyreMaint, s.other, s.yearly, s.kept], [60000, 10000, 5000, 4000, 1000, 0, 40000]);
  const sum = ['diesel', 'driver', 'fastag', 'tyreMaint', 'rtoDocs', 'other', 'yearly', 'kept'].reduce((a, k) => a + s[k], 0);
  assert.equal(sum, s.bhada);
  // a yearly insurance / permit entry is its own part, a tyre buy goes to tyres
  assert.equal(splitTrip(trip({ loadDate: '2026-06-02', rate: 3000, ownMisc: 125000, remarks: 'Insurance + Permit + Road Tax' })).yearly, 125000);
  assert.equal(splitTrip(trip({ loadDate: '2026-06-02', rate: 3000, ownMisc: 49000, remarks: 'New Tyre Pair Purchase' })).tyreMaint, 49000);
});

test('monthly SSFC charges are spread over the vehicle\'s trips that month', () => {
  row = 3;
  const a = trip({ loadDate: '2026-02-03', rate: 3000, fastag: 9000 });
  const b = trip({ loadDate: '2026-02-15', rate: 3000, port: 'Gangavaram' });
  const data = { trips: [a, b], hsd: [] };
  assert.equal(splitTrip(a, data).fastag, 4500);
  assert.equal(splitTrip(b, data).fastag, 4500);
  assert.equal(splitTrip(a, data).kept + splitTrip(b, data).kept, splitTrip(a).kept + splitTrip(b).kept);
});

test('rate changes: before and after, like for like', () => {
  row = 3;
  const trips = [];
  for (let i = 0; i < 4; i++) trips.push(trip({ loadDate: `2026-0${1 + i}-10`, rate: 3400, ssfcAmt: 60000, ssfcLtr: 640 }));
  trips.push(trip({ loadDate: '2026-04-20', rate: 3500 }));                  // a typing slip: one trip only
  trips.push(trip({ loadDate: '2026-04-25', rate: 3400, ssfcAmt: 60000, ssfcLtr: 640 }));
  for (let i = 0; i < 3; i++) trips.push(trip({ loadDate: `2026-0${6 + i}-10`, rate: 3467, ssfcAmt: 64000, ssfcLtr: 630 }));
  const data = { trips, hsd: [{ date: '2026-06-01', qty: 100, amount: 10200 }] };
  const eras = rateEras(data, 'Kakinada → BALCO');
  assert.deepEqual(eras.map((e) => [e.rate, e.trips]), [[3400, 6], [3467, 3]]);
  const [c] = rateChanges(data);
  assert.equal(c.from, 3400);
  assert.equal(c.to, 3467);
  assert.equal(c.at, '2026-06-10');
  assert.equal(c.after.bhada - c.before.bhada > 0, true);
  assert.equal(Math.round(c.after.diesel - c.before.diesel), Math.round(64000 - (5 * 60000) / 6));
  const m = monthlyTrend(data, 'Kakinada → BALCO');
  assert.equal(m.find((x) => x.month === '2026-06').pumpPerL, 102);
  assert.ok(Math.abs(summary(trips).share.diesel + summary(trips).share.kept - 1) < 1e-9);
});

test('driver pay is checked only from the chosen month on', () => {
  row = 3;
  const t1 = trip({ loadDate: '2026-01-10', rate: 3000, drvSsfc: 14000 });
  const t2 = trip({ loadDate: '2026-10-05', rate: 3000, drvSsfc: 12000 });
  const data = { trips: [t1, t2], rates: [] };
  const set = withDefaults({ routes: [{ port: 'Kakinada', dest: 'BALCO', salary: 11000 }] });
  const dc = driverCheck(data, set, '2026-10-11');                           // default: from this month
  assert.equal(dc.checkFrom, '2026-10');
  assert.deepEqual(dc.rows.map((r) => [r.t.loadDate, r.over]), [['2026-10-05', 1000]]);
  const all = driverCheck(data, withDefaults({ ...set, driver: { checkFrom: '2026-01' } }), '2026-10-11');
  assert.equal(all.rows.length, 2);
});
