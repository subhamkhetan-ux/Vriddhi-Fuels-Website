// Who drove which trip, from the Driver Payment sheet. All names, vehicles and
// amounts are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentDrivers, driverNames, isSettlement, sameDriver, tripDrivers } from '../../fleet/js/drivers.js';
import { driverCheck, withDefaults } from '../../fleet/js/rules.js';
import { byDriver, performance } from '../../fleet/js/perf.js';
import { extractFleet } from '../../fleet/js/parse.js';

let row = 3;
const trip = (veh, start, o = {}) => ({
  row: row++, veh, trip: `T${String(row).padStart(3, '0')}/DEMO`, status: 'done', start, loadDate: start, unloadDate: start,
  month: start.slice(0, 7), port: 'Demo Port', dest: 'Demo Plant', remarks: '', ...o,
});
let prow = 2;
const pay = (date, veh, name, amount = 1000, note = '') => ({ row: prow++, date, veh, amount, name, note });

test('names typed differently are one person; different people stay apart', () => {
  assert.ok(sameDriver('Rafiq Ali', 'Rafik Ali'));
  assert.ok(sameDriver('Ramesh', 'Ramesh Kumar'));
  assert.ok(sameDriver('M D Anwar', 'MD Anwar'));
  assert.ok(sameDriver('Mohd Anwar', 'MD Anwar'));
  assert.ok(sameDriver('Firoj', 'Firoz'));
  assert.ok(!sameDriver('Suresh Yadav', 'Suresh Kumar Ram'));
  assert.ok(!sameDriver('Ramesh', 'Mahesh'));
  assert.ok(!sameDriver('', 'Mahesh'));
  const canon = driverNames({ roster: [{ veh: 'XX01', name: 'Rafik Ali' }], driverPay: [pay('2026-01-01', 'XX01', 'Rafiq Ali'), pay('2026-01-02', 'XX02', 'Ramesh'), pay('2026-01-03', 'XX02', 'Ramesh Kumar')] });
  assert.equal(canon('Rafiq Ali'), 'Rafik Ali');                   // the drivers list's spelling
  assert.equal(canon('Ramesh'), 'Ramesh Kumar');                          // else the fullest
  assert.ok(isSettlement({ note: '2000 security + 7400 last trip' }));
  assert.ok(isSettlement({ note: 'Voucher clear' }));
  assert.ok(!isSettlement({ note: '' }));
});

test('each trip gets the driver paid during it (start ≤ date < next start), carried over trips without an advance', () => {
  row = 3; prow = 2;
  const trips = [trip('XX01', '2026-01-01'), trip('XX01', '2026-01-10'), trip('XX01', '2026-01-20'), trip('XX01', '2026-02-01'), trip('XX01', '2026-02-10')];
  const data = { trips, driverPay: [
    pay('2026-01-12', 'XX01', 'Ramesh'),                  // trip 2 (trip 1 gets him too: before his first advance)
    pay('2026-02-01', 'XX01', 'Mahesh Kumar'),            // trip 4 starts that day: Mahesh takes over there
    pay('2026-02-03', 'XX01', 'Ramesh', 9000, 'Security refund'), // Ramesh's settlement — not driving
  ] };
  const w = tripDrivers(data);
  assert.deepEqual(trips.map((t) => w.get(t.row).name), ['Ramesh', 'Ramesh', 'Ramesh', 'Mahesh Kumar', 'Mahesh Kumar']);
  assert.equal(w.get(trips[2].row).carried, true);
  assert.deepEqual(w.get(trips[3].row).paid.map((p) => p.amount), [1000, 9000]);
});

test('a former driver paid once more is a settlement unless he drives again; someone driving another truck isn\'t counted', () => {
  row = 3; prow = 2;
  const a = [trip('XX01', '2026-01-01'), trip('XX01', '2026-01-10'), trip('XX01', '2026-01-20'), trip('XX01', '2026-02-01')];
  const b = [trip('XX02', '2026-01-01'), trip('XX02', '2026-01-15'), trip('XX02', '2026-02-01')];
  const data = { trips: [...a, ...b], driverPay: [
    pay('2026-01-02', 'XX01', 'Ramesh'), pay('2026-01-11', 'XX01', 'Suresh'),
    pay('2026-01-21', 'XX01', 'Ramesh'),                  // paid again, no note…
    pay('2026-02-02', 'XX01', 'Suresh'),                  // …but Suresh drives on: a settlement
    pay('2026-01-02', 'XX02', 'Dinesh'), pay('2026-01-16', 'XX02', 'Suresh'), // Suresh is on XX01 then
    pay('2026-02-02', 'XX02', 'Dinesh'),
  ] };
  const w = tripDrivers(data);
  assert.deepEqual(a.map((t) => w.get(t.row).name), ['Ramesh', 'Suresh', 'Suresh', 'Suresh']);
  assert.deepEqual(b.map((t) => w.get(t.row).name), ['Dinesh', 'Dinesh', 'Dinesh']);
});

test('driver now: the drivers list wins, and says when the last advance went to someone else', () => {
  row = 3; prow = 2;
  const data = { trips: [trip('XX01', '2026-01-01'), trip('XX02', '2026-01-01')], driverPay: [pay('2026-01-02', 'XX01', 'Ramesh'), pay('2026-01-02', 'XX02', 'Dinesh')],
    roster: [{ veh: 'XX01', name: 'Ramesh Kumar' }, { veh: 'XX02', name: 'Naresh' }] };
  const now = currentDrivers(data);
  assert.deepEqual(now.get('XX01'), { name: 'Ramesh Kumar', from: 'list', lastPaid: 'Ramesh Kumar', matches: true });
  assert.equal(now.get('XX02').name, 'Naresh');
  assert.equal(now.get('XX02').matches, false);
});

test('driver check spells follow the payments (remarks only without the sheet)', () => {
  row = 3; prow = 2;
  const trips = [
    trip('XX01', '2026-01-01', { drvSsfc: 9000, drvTrip: 1000 }),
    trip('XX01', '2026-01-10', { drvSsfc: 9000, drvTrip: 1000, remarks: 'New Driver Somebody' }),
    trip('XX01', '2026-01-20', { drvSsfc: 9500, drvTrip: 1000 }),
  ];
  const data = { trips, rates: [], driverPay: [pay('2026-01-02', 'XX01', 'Ramesh'), pay('2026-01-11', 'XX01', 'Ramesh'), pay('2026-01-21', 'XX01', 'Mahesh')], roster: [{ veh: 'XX01', name: 'Mahesh' }] };
  const set = withDefaults({ routes: [{ port: 'Demo Port', dest: 'Demo Plant', salary: 10000 }], driver: { checkFrom: '2026-01' } });
  const dc = driverCheck(data, set);
  assert.equal(dc.byPayments, true);
  assert.deepEqual(dc.spells.map((s) => [s.name, s.all.length, s.payments.length]), [['Ramesh', 2, 2], ['Mahesh', 1, 1]]);
  assert.equal(dc.spells[1].balance, 500);
  assert.equal(dc.spells[1].current, true);
  assert.equal(dc.tripDriver(trips[2]), 'Mahesh');
  assert.equal(dc.now.get('XX01').name, 'Mahesh');
  // without the sheet: the remarks
  const old = driverCheck({ trips, rates: [] }, set);
  assert.equal(old.byPayments, false);
  assert.deepEqual(old.spells.map((s) => s.label), ['Driver from the start', 'Somebody']);
});

test('performance by driver: one driver across trucks', () => {
  row = 3; prow = 2;
  const t = (veh, start, days) => trip(veh, start, { loadDate: start, unloadDate: new Date(Date.parse(start) + days * 86400000).toISOString().slice(0, 10) });
  const trips = [t('XX01', '2026-01-01', 5), t('XX02', '2026-01-01', 5), t('XX03', '2026-01-02', 9), t('XX01', '2026-01-03', 5)];
  const data = { trips, hsd: [], driverPay: [pay('2026-01-01', 'XX01', 'Ramesh'), pay('2026-01-01', 'XX02', 'Dinesh'), pay('2026-01-02', 'XX03', 'Ramesh')] };
  const w = tripDrivers(data);
  const perf = performance(data, '2026-03-01');
  const by = byDriver(perf, (x) => w.get(x.row).name);
  const ramesh = by.find((x) => x.name === 'Ramesh');
  assert.deepEqual(ramesh.vehs.sort(), ['XX01', 'XX03']);
  assert.equal(ramesh.trips, 3);
});

test('reads the Driver Payment sheet: payments with notes, and the drivers list (names only)', () => {
  const tr = [
    [null, 'LOADING'],
    ['S.No', 'TRIP No', 'Vehicle No', 'Trip Start Date', 'Loading Date', 'Load Weight', 'Unload Date', 'Unload Weight', 'Loading Port', 'Destination', 'Price/Ton', 'Trip Bhada', 'Trip Driver Payment', 'Remarks', 'Month'],
    [1, 'T001/DEMO', 'XX01AB1001', 46023, 46025, 40, 46030, 40, 'Demo Port', 'Demo Plant', 3000, 120000, 3000, '', 46023],
  ];
  const dp = [
    ['Date', 'Vehicle No', 'Amount Paid', 'Driver Name', null, null, null, null, 'Driver Name', 'Vehicle Number', 'Driving License', 'Account No', 'IFSC Code'],
    [46024, 'XX01AB1001', 1000, 'Ramesh', null, null, null, null, 'Ramesh Kumar', 'XX01AB1001', 'DL0000', '1234', 'DEMO0001'],
    [46026, 'XX01 AB 1001', 2000, 'Ramesh', null, '1000 security + 1000 bonus', null, null, 'Dinesh', 'XX01AB1002'],
    [null, null, null, ' '],
  ];
  const d = extractFleet({ sheets: { 'Trip Register': { rows: tr, r0: 1 }, 'Driver Payment': { rows: dp, r0: 1 } } });
  assert.deepEqual(d.driverPay, [
    { row: 2, date: '2026-01-02', veh: 'XX01AB1001', amount: 1000, name: 'Ramesh', note: '' },
    { row: 3, date: '2026-01-04', veh: 'XX01AB1001', amount: 2000, name: 'Ramesh', note: '1000 security + 1000 bonus' },
  ]);
  assert.deepEqual(d.roster, [{ veh: 'XX01AB1001', name: 'Ramesh Kumar' }, { veh: 'XX01AB1002', name: 'Dinesh' }]);
  assert.ok(!JSON.stringify(d).includes('DEMO0001'));                    // no bank details kept
});
