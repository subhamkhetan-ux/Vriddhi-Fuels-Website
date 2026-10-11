// Where each vehicle on the road is, its pace and what the trip should earn — made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveTrip, routeProfile } from '../../fleet/js/live.js';
import { withDefaults } from '../../fleet/js/rules.js';
import { addDays } from '../../fleet/js/util.js';
import { bulkerSvg, plateText } from '../../fleet/js/bulker.js';

let row = 3;
const hsd = [];
// a past trip: start, outbound fill on day o, loaded day l, refill day b, unloaded day u
function done(veh, start, o, l, b, u, extra = {}) {
  const t = { row: row++, veh, trip: `T${row}`, port: 'Kakinada', dest: 'BALCO', start, loadDate: addDays(start, l), unloadDate: addDays(start, u), status: 'done', loadWt: 40, tare: 17, gross: 57, rate: 3000, bhada: 120000, drvSsfc: 10300, fastag: 9000, tyre: 6000, income: 30000, ...extra };
  t.month = t.loadDate.slice(0, 7);
  hsd.push({ veh, trip: t.trip, date: addDays(start, 0), qty: 30, amount: 3000, rsp: 100, location: 'Korba', source: 'SSFC' });
  hsd.push({ veh, trip: t.trip, date: addDays(start, o), qty: 350, amount: 35000, rsp: 100, location: 'Muniguda', source: 'SSFC' });
  hsd.push({ veh, trip: t.trip, date: addDays(start, b), qty: 280, amount: 28000, rsp: 100, location: 'Muniguda', source: 'SSFC' });
  return t;
}
function data() {
  row = 3;
  hsd.length = 0;
  const trips = [];
  for (let i = 0; i < 6; i++) {
    const s = addDays('2026-08-01', i * 10);
    trips.push(done('A', s, 1, 2, 4, 6), done('B', s, 2, 4, 6, 9));
  }
  return { trips, hsd, rates: [{ port: 'Kakinada', dest: 'BALCO', rate: 3000, diesel: 630, driver: 11000 }] };
}

test('a route learns where the fills are and on which day each step comes', () => {
  const d = data();
  const p = routeProfile(d, { port: 'Kakinada', dest: 'BALCO' }, '2026-10-11', 'B');
  assert.equal(p.outPlace, 'Muniguda');
  assert.equal(p.backPlace, 'Muniguda');
  assert.deepEqual([p.out.best, p.load.best, p.back.best, p.unload.best], [1, 2, 4, 6]);
  assert.equal(p.unload.own, 9);                                  // B's own best
  assert.equal(p.litres, 660);
});

test('stages from the fills logged so far, the pace and the projection', () => {
  const d = data();
  // on the road: started 5 Oct, filled at Muniguda on the 7th, loaded on the 9th — today the 11th
  const t = { row: 99, veh: 'B', trip: 'T99', port: 'Kakinada', dest: 'BALCO', start: '2026-10-05', loadDate: '2026-10-09', loadWt: 41, tare: 17, gross: 58, rate: 3000, bhada: 123000, status: 'loaded', month: '2026-10', drvTrip: 2000 };
  d.trips.push(t);
  d.hsd.push({ veh: 'B', trip: 'T99', date: '2026-10-07', qty: 350, amount: 35000, rsp: 100, location: 'Muniguda', source: 'SSFC' });
  const lt = liveTrip(d, withDefaults({}), '2026-10-11', t);
  assert.equal(lt.stage, 'load');
  assert.equal(lt.phase.title, 'Loaded at Kakinada — heading back, diesel at Muniguda');
  assert.deepEqual(lt.steps.map((x) => x.done), [true, true, true, false, false]);
  assert.equal(lt.pace.best, 2);                                  // loaded on day 4, the best load on day 2
  assert.equal(lt.pace.typical, 1);                              // the usual load is on day 3
  assert.equal(lt.status, 'late');
  const pr = lt.projection;
  assert.equal(pr.freight, 123000);
  assert.equal(pr.dieselSoFar, 35000);
  assert.equal(pr.litresLeft, 310);                               // the route uses 660 L
  assert.equal(pr.driver, 11000);                                 // the Rates sheet's driver payment
  assert.equal(pr.driverFrom, 'rates');
  assert.equal(pr.ssfcOther, 15000);                              // fastag + tyre a trip
  assert.equal(pr.before, 123000 - 35000 - 31000 - 11000 - 15000);
  // still going to load: phase and an estimated freight
  const e = { row: 100, veh: 'A', trip: 'T100', port: 'Kakinada', dest: 'BALCO', start: '2026-10-10', status: 'empty' };
  d.trips.push(e);
  const le = liveTrip(d, withDefaults({}), '2026-10-11', e);
  assert.equal(le.stage, 'start');
  assert.match(le.phase.title, /Departed — heading to Muniguda/);
  assert.equal(le.projection.freight, 40 * 3000);
});

test('the bulker shows the full number on its plate, and the route', () => {
  assert.equal(plateText('XX01T1001'), 'XX 01 T 1001');
  const svg = bulkerSvg({ state: 'loaded', load: 40, gross: 57, plate: 'XX01T1001', route: 'Kakinada → BALCO', trip: 'T055/BALCO' });
  assert.match(svg, /XX 01 T 1001/);
  assert.match(svg, /Kakinada → BALCO/);
  assert.match(svg, /T055\/BALCO/);
});
