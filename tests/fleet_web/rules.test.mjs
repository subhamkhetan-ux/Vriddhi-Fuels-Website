// Routes, driver pay and the fastag / tyre trend check, on made-up trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  driverCheck, driverName, monthlyCharges, routeFor, routePairs, tripKms, vehicleFlags, withDefaults,
} from '../../fleet/js/rules.js';
import { dieselRecon } from '../../fleet/js/analyse.js';

let row = 3;
const trip = (o) => ({ row: row++, status: 'done', start: `${o.month}-01`, loadDate: `${o.month}-03`, unloadDate: `${o.month}-09`, port: 'Kakinada', dest: 'BALCO', remarks: '', ...o });
const rates = [{ port: 'Kakinada', dest: 'BALCO', rate: 3000, diesel: 630, driver: 10000, driverExtra: 0 }];

test('route values: newest entry from that month on, Rates sheet as the fallback', () => {
  const data = { trips: [trip({ veh: 'A', month: '2026-01' })], rates };
  const set = withDefaults({ routes: [
    { port: 'Kakinada', dest: 'BALCO', from: '', km: 820, salary: 11000 },
    { port: 'kakinada', dest: 'balco', from: '2026-05', salary: 11300 },
  ] });
  assert.deepEqual(routeFor(data, set, 'Kakinada', 'BALCO', '2026-04'), { km: 820, rtd: null, salary: 11000, salaryFrom: 'app', diesel: 630, dieselFrom: 'rates' });
  assert.equal(routeFor(data, set, 'Kakinada', 'BALCO', '2026-06').salary, 11300);
  assert.equal(routeFor(data, set, 'Kakinada', 'BALCO', '2026-06').km, 820);          // km from the older row
  assert.equal(routeFor(data, withDefaults({}), 'Kakinada', 'BALCO').salaryFrom, 'rates');
  assert.equal(routeFor(data, withDefaults({}), 'Gopalpur', 'Vedanta').salary, null);
  assert.deepEqual(routePairs({ trips: [trip({ veh: 'A', month: '2026-01', port: 'Gopalpur', dest: 'Vedanta' })], rates }, withDefaults({})).map((r) => `${r.port}>${r.dest}`),
    ['Gopalpur>BALCO', 'Gopalpur>Vedanta', 'Kakinada>BALCO', 'Kakinada>Vedanta']);
});

test('km per trip: loaded leg + empty leg from the last unloading point (either way round)', () => {
  row = 3;
  const data = { trips: [
    trip({ veh: 'A', month: '2026-01' }),
    trip({ veh: 'A', month: '2026-02', port: 'Gopalpur', dest: 'Vedanta' }),
    trip({ veh: 'A', month: '2026-03' }),
  ], rates };
  const set = withDefaults({ routes: [
    { port: 'Kakinada', dest: 'BALCO', km: 800 }, { port: 'Gopalpur', dest: 'Vedanta', km: 400 },
    { port: 'Gopalpur', dest: 'BALCO', km: 600 }, { port: 'Kakinada', dest: 'Vedanta', km: 700 },
  ] });
  const k = tripKms(data, set);
  assert.deepEqual(k.get(3), { loaded: 800, empty: null, km: 800, complete: true });         // first trip: no empty leg known
  assert.deepEqual(k.get(4), { loaded: 400, empty: 600, km: 1000, complete: true });         // BALCO → Gopalpur empty
  assert.deepEqual(k.get(5), { loaded: 800, empty: 700, km: 1500, complete: true });         // Vedanta → Kakinada empty
});

test('driver pay: SSFC should pay salary − your advances (the promised extra is settled); overpaid drivers by spell', () => {
  row = 3;
  const data = { trips: [
    trip({ veh: 'A', month: '2026-01', drvSsfc: 11000 }),                          // salary 11000: exact
    trip({ veh: 'A', month: '2026-02', drvSsfc: 9000, drvTrip: 3000 }),           // 9000 + 3000 = 1000 over
    trip({ veh: 'A', month: '2026-03', drvSsfc: 11000, drvExtra: 1600 }),        // extra promised for the trip: settled
    trip({ veh: 'A', month: '2026-04', drvSsfc: 5000, drvDebit: 6000, remarks: 'New Driver Ram Kumar' }),
    trip({ veh: 'A', month: '2026-05', status: 'loaded', unloadDate: undefined }), // not settled: skipped
    trip({ veh: 'B', month: '2026-01', drvSsfc: 6000, port: 'Gopalpur', dest: 'Vedanta' }), // no salary set
  ], rates };
  const set = withDefaults({ routes: [{ port: 'Kakinada', dest: 'BALCO', salary: 11000 }] });
  const dc = driverCheck(data, set);
  const a = dc.rows.filter((r) => r.veh === 'A');
  assert.deepEqual(a.map((r) => [r.expected, r.over]), [[11000, 0], [8000, 1000], [11000, 0], [11000, -6000]]);
  const spells = dc.spells.filter((s) => s.veh === 'A');
  assert.equal(spells.length, 2);
  assert.equal(spells[0].balance, 1000);
  assert.equal(spells[0].overTrips, 1);
  assert.equal(spells[1].name, 'Ram Kumar');
  assert.equal(spells[1].balance, 0);                                            // 6000 less paid recovers the 6000 debit
  assert.equal(spells[1].current, true);
  assert.deepEqual(dc.missing, [{ route: 'Gopalpur → Vedanta', trips: 1 }]);
  // if Extra Own Driver Pay were an advance out of the salary instead
  const dc2 = driverCheck(data, withDefaults({ ...set, driver: { extraIsAdvance: true } }));
  assert.equal(dc2.rows.filter((r) => r.veh === 'A')[2].over, 1600);
});

test('driver names from the remarks', () => {
  assert.equal(driverName('New Driver MD Anwar'), 'MD Anwar');
  assert.equal(driverName('Ravi Kumar New Driver'), 'Ravi Kumar');
  assert.equal(driverName('Driver Changed from Mohan to Sohan'), 'Sohan');
  assert.equal(driverName('New Driver, 200 Ltr Theft'), '');
});

test('vehicles left out of the tyre analysis by default, switchable', () => {
  assert.deepEqual(vehicleFlags(withDefaults({}), 'XX01T4010'), { tyre: false, fastag: true });
  assert.deepEqual(vehicleFlags(withDefaults({}), 'XX01T2010'), { tyre: true, fastag: true });
  assert.deepEqual(vehicleFlags(withDefaults({ vehicles: { XX01T4010: { tyre: true } } }), 'XX01T4010'), { tyre: true, fastag: true });
});

test('monthly charges: first two months not judged; high, low and twice flagged', () => {
  row = 3;
  const months = ['2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01'];
  const trips = [];
  for (const veh of ['XX1001', 'XX1002', 'XX1003', 'XX1004']) {
    months.forEach((m, i) => {
      let tyre = 25000;
      if (veh === 'XX1001' && i === 1) tyre = 90000;                            // a vehicle's 2nd month: not judged
      if (veh === 'XX1002' && m === '2025-12') tyre = 52000;                    // way above fleet and own trend
      if (veh === 'XX1003' && m === '2025-11') tyre = 2500;                     // way below
      trips.push(trip({ veh, month: m, tyre }));
      if (veh === 'XX1004' && m === '2025-10') trips.push(trip({ veh, month: m, tyre: 25000 }));   // booked twice
      else trips.push(trip({ veh, month: m }));
    });
  }
  const c = monthlyCharges({ trips, rates }, withDefaults({}), 'tyre');
  assert.equal(c.basis, 'month');
  assert.deepEqual(c.flags.map((f) => [f.kind, f.veh, f.month]).sort(), [
    ['high', 'XX1002', '2025-12'], ['high', 'XX1004', '2025-10'], ['low', 'XX1003', '2025-11'], ['twice', 'XX1004', '2025-10'],
  ].sort());
  assert.equal(c.cell.XX1001['2025-07'].settling, true);
  // switched off: not judged at all
  const off = monthlyCharges({ trips, rates }, withDefaults({ vehicles: { XX1002: { tyre: false } } }), 'tyre');
  assert.ok(!off.flags.some((f) => f.veh === 'XX1002'));
  assert.deepEqual(off.excluded, ['XX1002']);
});

test('diesel recon takes a route\'s diesel set in the app', () => {
  row = 3;
  const data = { trips: [trip({ veh: 'A', month: '2026-01', gross: 57, ssfcLtr: 600 })], rates, recon: { fromRow: 3, underloadFromRow: 3, rows: { 3: [630, 0, 5, 625] } } };
  assert.equal(dieselRecon(data).vehicles[0].list[0].allotted, 625);                    // Excel's row
  const set = { routes: [{ port: 'Kakinada', dest: 'BALCO', diesel: 650 }], recon: { useApp: true } };
  assert.equal(dieselRecon(data, set).vehicles[0].list[0].allotted, 645);              // 650 − 5 underload
});

test('the Rates sheet\'s round trip (RTD/Trip in Km) gives each trip its km unless Setup has the route\'s distance', () => {
  row = 3;
  const data = { trips: [trip({ veh: 'A', month: '2026-01' }), trip({ veh: 'A', month: '2026-02' })], rates: [{ ...rates[0], rtd: 1800 }] };
  const k = tripKms(data, withDefaults({}));
  assert.deepEqual(k.get(3), { loaded: 900, empty: 900, km: 1800, complete: true, from: 'rates' });
  assert.equal(tripKms(data, withDefaults({ routes: [{ port: 'Kakinada', dest: 'BALCO', km: 800 }] })).get(4).km, 1600);  // Setup's one-way 800 loaded + 800 empty back to the port
  assert.equal(routeFor(data, withDefaults({}), 'Kakinada', 'BALCO').rtd, 1800);
});
