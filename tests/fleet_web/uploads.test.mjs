// Daily uploads: checks on a freshly read workbook, and what it changes
// against the saved one. All data is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataChecks } from '../../fleet/js/checks.js';
import { blocking, compareUploads } from '../../fleet/js/changes.js';
import { extractFleet } from '../../fleet/js/parse.js';
import { sameDriver } from '../../fleet/js/drivers.js';

let row = 3;
const trip = (veh, n, start, o = {}) => ({
  row: row++, veh, trip: `T${String(n).padStart(3, '0')}/DEMO`, start, loadDate: start, unloadDate: start, status: 'done',
  month: (start || o.loadDate || '').slice(0, 7), port: 'Demo Port', dest: 'Demo Plant', loadWt: 40, rate: 3000, bhada: 120000,
  ssfcAmt: 50000, ssfcNet: 70000, income: 70000, remarks: '', ...o,
});
const base = () => {
  row = 3;
  return {
    latest: '2026-03-10',
    trips: [trip('XX01', 1, '2026-03-01'), trip('XX01', 2, '2026-03-10', { unloadDate: null, status: 'loaded' }), trip('XX02', 1, '2026-03-02')],
    hsd: [{ date: '2026-03-01', veh: 'XX01', bill: 'B1', qty: 300, amount: 27000, trip: 'T001/DEMO' }],
    urea: [], driverPay: [{ row: 2, date: '2026-03-02', veh: 'XX01', amount: 1000, name: 'Ramesh', note: '' }],
    roster: [{ veh: 'XX01', name: 'Ramesh' }], ssfc: { rows: [{ month: '2026-03', veh: 'XX01', net: 70000 }] },
  };
};
const copy = (x) => JSON.parse(JSON.stringify(x));

test('a day\'s edits: new trip, an unloading filled in, a new advance — nothing blocks', () => {
  const prev = base();
  const next = copy(prev);
  next.trips[1].unloadDate = '2026-03-15';
  next.trips[1].unloadWt = 39.9;
  next.trips.splice(1, 0, trip('XX02', 2, '2026-03-12'));        // a row inserted: rows move
  next.trips.forEach((t, i) => { t.row = 3 + i; });
  next.driverPay.push({ row: 3, date: '2026-03-12', veh: 'XX02', amount: 2000, name: 'Dinesh', note: '' });
  next.latest = '2026-03-12';
  const c = compareUploads(prev, next);
  assert.deepEqual(c.trips.added.map((t) => t.trip), ['T002/DEMO']);
  assert.deepEqual(c.trips.changed.map((x) => [x.t.trip, x.fields.map((f) => f.key)]), [['T002/DEMO', ['unloadDate', 'unloadWt']]]);
  assert.equal(c.trips.removed.length, 0);
  assert.equal(c.pay.added.length, 1);
  assert.deepEqual(c.risks, []);
  assert.equal(blocking(c), false);
  assert.equal(c.none, false);
  assert.equal(compareUploads(prev, copy(prev)).none, true);       // same file again
});

test('an old copy of the workbook is stopped', () => {
  const prev = base();
  const old = copy(prev);
  old.trips = old.trips.slice(0, 1);
  old.trips[0].unloadDate = null;
  old.latest = '2026-03-01';
  const c = compareUploads(prev, old);
  assert.equal(blocking(c), true);
  assert.ok(c.risks.some((r) => /older than the saved/.test(r.text)));
  assert.equal(c.trips.removed.length, 2);
  assert.equal(c.trips.backwards.length, 1);
});

test('a sheet missing that\'s saved now is stopped; one deleted trip only warns', () => {
  const prev = base();
  const next = copy(prev);
  next.driverPay = [];
  next.trips.pop();
  const c = compareUploads(prev, next);
  assert.equal(blocking(c), true);
  assert.ok(c.risks.some((r) => r.level === 'stop' && /Driver Payment/.test(r.text)));
  assert.ok(c.risks.some((r) => r.level === 'warn' && /not in this file/.test(r.text)));
  const edit = copy(prev);
  edit.hsd[0].qty = 310;                                           // an edited fill: −1 +1, not a loss
  assert.deepEqual(compareUploads(prev, edit).risks, []);
});

test('checks: duplicates, formulas not recalculated, advances not matching, stray payments', () => {
  row = 3;
  const data = {
    trips: [
      trip('XX01', 1, '2026-03-01', { drvTrip: 1000, income: 69000 }),
      trip('XX01', 1, '2026-03-05'),                               // the same trip twice
      trip('XX01', 2, '2026-03-10', { bhada: 100000 }),            // not 40 T × 3000
      trip('XX02', 1, '2026-03-02', { drvTrip: 500, income: 69500 }),             // no payment for it
      trip('XX02', 2, null, { loadDate: '2026-03-20' }),
    ],
    driverPay: [
      { row: 2, date: '2026-03-02', veh: 'XX01', amount: 1000, name: 'Ramesh', note: '' },
      { row: 3, date: '2026-03-02', veh: 'XX09', amount: 700, name: 'Ramesh', note: '' },
      { row: 4, date: '2026-02-01', veh: 'XX02', amount: 300, name: 'Rameesh Kumarr', note: '' },
    ],
    roster: [{ veh: 'XX01', name: 'Ramesh' }, { veh: 'XX01', name: 'Suresh' }],
    hsd: [],
  };
  data.driverPay.push({ row: 5, date: '2026-04-30', veh: 'XX01', amount: 100, name: 'Ramesh', note: '' });
  const txt = dataChecks(data, '2026-03-31').map((x) => `${x.level}: ${x.text}`).join('\n');
  assert.match(txt, /warn: The same trip .*T001\/DEMO XX01 \(rows 3, 4\)/);
  assert.match(txt, /warn: No Trip Start Date on row 7/);
  assert.match(txt, /warn: Excel's saved figures don't add up on row 5 \(Trip Bhada, SSFC Net Amount\)\. Either/);
  assert.match(txt, /warn: Trip Driver Payment doesn't match .*row 6/);
  assert.match(txt, /warn: Driver Payment row 3 \(XX09\): no trips for that vehicle/);
  assert.match(txt, /warn: Driver Payment row 4: dated before the vehicle's first trip/);
  assert.match(txt, /warn: Driver Payment row 5 \(2026-04-30\): dated after today/);
  assert.match(txt, /info: Paid only once .*Rameesh Kumarr/);
  assert.match(txt, /warn: The drivers list has more than one driver for XX01/);
  row = 3;
  assert.deepEqual(dataChecks({ trips: [trip('XX01', 1, '2026-03-01')], hsd: [] }), []);   // a clean file: nothing
});

test('a one-letter slip in the surname is the same driver; a different first name isn\'t', () => {
  assert.ok(sameDriver('Ramesh Yadv', 'Ramesh Yadav'));
  assert.ok(sameDriver('Ramesh Yadav', 'Ramesh Yaadav'));
  assert.ok(!sameDriver('Ramesh Yadav', 'Rajesh Yadav'));
  assert.ok(!sameDriver('Ramesh Yadav', 'Ramesh Pradhan'));
});

test('the reader reports Excel error cells and half-filled payment rows', () => {
  const tr = [
    ['S.No', 'TRIP No', 'Vehicle No', 'Trip Start Date', 'Loading Date', 'Load Weight', 'Price/Ton', 'Trip Bhada', 'Income/Trip'],
    [1, 'T001/DEMO', 'XX01AB1001', 46023, 46025, 40, 3000, 120000, null],
    [2, 'T002/DEMO', null, 46030],
  ];
  const dp = [
    ['Date', 'Vehicle No', 'Amount Paid', 'Driver Name'],
    [46024, 'XX01AB1001', 1000, 'Ramesh'],
    ['31/02/2026x', 'XX01AB1001', 500, 'Ramesh'],
    [46026, 'XX01AB1001', 700, null],
  ];
  const book = { sheets: { 'Trip Register': { rows: tr, r0: 1, errors: [[1, 8, '#VALUE!'], [1, 12, '#N/A']] }, 'Driver Payment': { rows: dp, r0: 1 } } };
  const d = extractFleet(book);
  const w = d.warnings.join('\n');
  assert.match(w, /Trip Register row 2, Income\/Trip: #VALUE! in Excel/);
  assert.doesNotMatch(w, /#N\/A/);                                 // a column the app doesn't read
  assert.match(w, /Trip Register row 3: trip T002\/DEMO has no vehicle/);
  assert.match(w, /Driver Payment row 3: a date it can't read/);
  assert.match(w, /Driver Payment row 4: no driver name — counted/);
  assert.equal(d.driverPay.length, 2);
  assert.equal(extractFleet(book).warnings.filter((x) => /#VALUE/.test(x)).length, 1);   // read twice: reported once
});
