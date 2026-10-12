// Loads (fuller is better: the RTO overload fee is paid) and the daily brief. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeOf, loadBench, loadSummary, loadTarget } from '../../fleet/js/load.js';
import { driverBrief, ownerBrief } from '../../fleet/js/brief.js';
import { driverBriefSvg, ownerBriefSvg, wrap } from '../../fleet/js/share-svg.js';

let row = 3;
const trip = (veh, loadDate, loadWt, o = {}) => ({ row: row++, veh, trip: `T${row}/DEMO`, start: loadDate, loadDate, loadWt, tare: 17, gross: loadWt + 17, rate: 3000, bhada: loadWt * 3000, port: 'Demo Port', dest: 'Demo Plant', month: loadDate.slice(0, 7), ...o });

test('each load against the best on the route around the same time', () => {
  row = 3;
  const trips = [trip('XX01', '2026-10-01', 42), trip('XX02', '2026-10-03', 41.6), trip('XX03', '2026-10-05', 40), trip('XX04', '2026-10-06', 37.5),
    trip('XX05', '2026-06-01', 48), trip('XX06', '2026-10-02', 30, { port: 'Other Port' })];
  const b = loadBench({ trips });
  assert.equal(b.get(3).grade, 'top');
  assert.equal(b.get(4).gapNear, 0.4);
  assert.equal(b.get(4).grade, 'top');
  assert.equal(b.get(5).grade, 'low');                     // 2 T below 42
  assert.equal(b.get(6).grade, 'poor');                    // 4.5 T below
  assert.equal(b.get(6).lostRs, 13500);
  assert.equal(b.get(6).overRto, -1.5);                    // 54.5 T gross: under the RTO 56 T
  assert.equal(b.get(7).near, 48);                         // June's heavy load isn't "near" October
  assert.equal(b.get(3).near, 42);
  assert.equal(b.get(8).grade, 'top');                     // another route: compared with its own
  assert.deepEqual([0.5, 1.5, 3, 3.1].map(gradeOf), ['top', 'ok', 'low', 'poor']);
  const s = loadSummary(trips.slice(0, 4), b);
  assert.equal(s.trips, 4);
  assert.equal(s.poor, 1);
  assert.equal(s.underRto, 1);
  assert.equal(loadTarget({ trips }, { port: 'Demo Port', dest: 'Demo Plant' }, '2026-10-10').load, 42);
});

test('the daily brief: the owner\'s insight and the drivers\' instructions in Hindi', () => {
  row = 3;
  const today = '2026-10-11';
  const loadedY = trip('XX01', '2026-10-10', 37);
  const best = trip('XX02', '2026-10-08', 42);
  const data = { trips: [loadedY, best], hsd: [], driverPay: [] };
  const loads = loadBench(data);
  const step = (key, done, best2) => ({ key, done, date: done ? '2026-10-09' : null, place: key === 'out' || key === 'back' ? 'Halfway' : '', best: best2, typical: best2 });
  const live = [{
    veh: 'XX01', t: { ...loadedY, unloadDate: null }, stage: 'load', status: 'behind', el: 3, pace: { best: 1, typical: 0 }, phase: { title: 'Loaded', short: 'To Halfway' },
    steps: [step('start', true), step('out', true), step('load', true), step('back', false, '2026-10-12'), step('unload', false, '2026-10-13')], etaTypical: '2026-10-13',
  }];
  const status = [{ veh: 'XX01', state: 'loaded', days: 3, trip: loadedY }, { veh: 'XX02', state: 'idle', days: 3, last: { ...best, unloadDate: '2026-10-09' } }];
  const ctx = { status, live, loads, account: null, recon: null, drivers: null, issues: [], driverNow: (v) => (v === 'XX01' ? 'Ramesh' : '') };
  const o = ownerBrief(data, ctx, today);
  const all = o.sections.flatMap((s) => s.items.map((i) => `${i.tone}: ${i.text}`)).join('\n');
  assert.match(all, /Yesterday \(10 Oct\): 1 truck loaded 37\.0 T/);
  assert.match(all, /warn: XX01|bad: XX01/);
  assert.match(all, /5\.00 T below the best then \(42\.00 T\): ₹15,000 freight left behind/);
  assert.match(all, /Behind the best pace: XX01 \(\+1 d\)/);
  assert.match(all, /Idle 2\+ days: XX02/);
  const d =driverBrief(data, ctx, today);
  const r = d.rows[0];
  assert.equal(r.veh, 'XX01');
  assert.equal(r.next, 'Halfway पर डीज़ल भरवाना');
  assert.equal(r.by, '2026-10-12');
  assert.equal(r.byRel, 'कल तक');
  assert.match(r.pace, /1 दिन पीछे/);
  assert.match(r.load, /कम लोड: 37\.00 टन/);
  assert.equal(d.rows[1].state, 'idle');
  assert.match(d.yesterday, /1 गाड़ी लोड हुई/);
  for (const svg of [driverBriefSvg(d, { asOn: today }).svg, ownerBriefSvg(o, { asOn: today }).svg]) assert.doesNotMatch(svg, /undefined|NaN/);
  assert.ok(wrap('एक दो तीन चार पाँच छह सात आठ नौ दस', 120, 20).length > 1);
});
