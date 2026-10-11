// Who's slow, and the bulker drawing — made-up trips only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveBehind, performance, tripStages } from '../../fleet/js/perf.js';
import { bulkerSvg, lanesSvg, RTO_GROSS } from '../../fleet/js/bulker.js';
import { addDays } from '../../fleet/js/util.js';

let row = 3;
// a trip: start, days to load, days loaded
function trip(veh, start, toLoad, loaded, extra = {}) {
  const loadDate = addDays(start, toLoad);
  const unloadDate = loaded == null ? undefined : addDays(loadDate, loaded);
  return { row: row++, veh, trip: `T${row}`, port: 'Kakinada', dest: 'BALCO', start, loadDate, unloadDate, month: loadDate.slice(0, 7), status: unloadDate ? 'done' : 'loaded', remarks: '', ...extra };
}

function fleet() {
  row = 3;
  const trips = [];
  // five convoys ten days apart; A always quick, D always 3 days slower to load
  ['2026-05-01', '2026-05-11', '2026-05-21', '2026-05-31', '2026-06-10'].forEach((d) => {
    trips.push(trip('A', d, 2, 3), trip('B', d, 3, 3), trip('C', d, 3, 4), trip('D', d, 6, 4));
  });
  return { trips, hsd: [{ veh: 'A', trip: trips[0].trip, date: '2026-05-02', qty: 300 }] };
}

test('stages per trip, idle until the next start', () => {
  const d = fleet();
  const st = tripStages(d, '2026-07-01');
  const a1 = st.get(3);
  assert.deepEqual([a1.toLoad, a1.loaded, a1.trip, a1.idle, a1.fills.length, a1.litres], [2, 3, 5, 5, 1, 300]);
});

test('each vehicle against the same route at the same time', () => {
  const d = fleet();
  const p = performance(d, '2026-07-01');
  const by = Object.fromEntries(p.vehicles.map((v) => [v.veh, v]));
  assert.equal(by.D.under, true);
  assert.equal(by.D.worstStage, 'toLoad');
  assert.ok(by.D.slowerPerTrip >= 2);
  assert.equal(by.A.under, false);
  assert.equal(by.A.wins, 5);
  assert.equal(by.A.top, true);
  const c = p.compared.find((x) => x.t.veh === 'D');
  assert.equal(c.best.trip, 5);
  assert.equal(c.bestBy.trip.veh, 'A');
  assert.equal(c.behind.trip, 5);
  // only one route asked for: nothing on another route
  assert.equal(performance(d, '2026-07-01', { route: 'Gopalpur → Vedanta' }).compared.length, 0);
});

test('on the road: behind the route\'s usual best, or others that started with it are further on', () => {
  const d = fleet();
  d.trips.push(trip('D', '2026-06-25', 1, null), trip('A', '2026-06-25', 1, 2));
  const live = liveBehind(d, '2026-07-01', performance(d, '2026-07-01'));
  assert.equal(live.length, 1);
  assert.equal(live[0].veh, 'D');
  assert.equal(live[0].stage, 'loaded');
  assert.equal(live[0].sofar, 5);
  assert.equal(live[0].late, true);
  assert.deepEqual(live[0].ahead.map((t) => t.veh), ['A']);
});

test('the bulker: alumina up to the load, the RTO line, over-weight shown', () => {
  const under = bulkerSvg({ state: 'loaded', load: 38, tare: 17, gross: 55, max: 65, label: '2010' });
  assert.match(under, /SHREE SHYAM/);
  assert.match(under, /Driving Your Progress/);
  assert.match(under, new RegExp(`RTO ${RTO_GROSS} T`));
  assert.doesNotMatch(under, /is-over/);
  assert.match(bulkerSvg({ state: 'loaded', load: 43, tare: 17, gross: 60, max: 65 }), /is-over/);
  assert.match(bulkerSvg({ state: 'empty' }), /is-empty/);
  const lanes = lanesSvg([{ label: '2010', start: '2026-05-01', load: '2026-05-03', unload: '2026-05-06', fills: ['2026-05-02'], best: true }], { today: '2026-05-10' });
  assert.match(lanes, /ln-fill/);
  assert.match(lanes, /ln-row best/);
});
