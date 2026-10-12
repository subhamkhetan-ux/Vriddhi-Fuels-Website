// Entries that look wrong, and each fill's place in its trip's allotment. Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { irregularIndex, irregulars } from '../../fleet/js/irregular.js';
import { fillProgress } from '../../fleet/js/tripdiesel.js';

const today = '2026-10-12';
let row = 3;
const trip = (veh, n, start, o = {}) => ({ row: row++, veh, trip: `T0${n}/DEMO`, start, loadDate: start, unloadDate: null, port: 'Port', dest: 'Plant', month: start.slice(0, 7), ...o });
const fill = (veh, n, date, qty, o = {}) => ({ veh, trip: `T0${n}/DEMO`, date, qty, rsp: 100, amount: qty * 100, source: 'SSFC', location: 'Halfway', bill: '', ...o });
// a trip's diesel as tripdiesel.js has it
const zOf = (t, allotted, fills) => ({ t, allotted, est: false, live: !t.unloadDate, fills, taken: fills.reduce((a, h) => a + h.qty, 0) });

test('more diesel than the allotment and the 120–140 L mid-way buffer: an entry to check; the fill that belongs to the trip before', () => {
  row = 3;
  const trips = [];
  const hsd = [];
  const td = new Map();
  // five usual trips on the route: 630 L each
  for (let i = 0; i < 5; i++) {
    const t = trip(`XX0${i}`, 1, `2026-08-0${i + 1}`, { unloadDate: `2026-08-1${i}` });
    const fs = [fill(t.veh, 1, t.start, 350, { bill: `S/${i}a` }), fill(t.veh, 1, t.unloadDate, 280, { bill: `S/${i}b` })];
    trips.push(t); hsd.push(...fs); td.set(t.row, zOf(t, 630, fs));
  }
  // XX09: trip 1 is 250 L under, trip 2 has a 250 L fill on its first day
  const t1 = trip('XX09', 1, '2026-09-10', { loadDate: '2026-09-12', unloadDate: '2026-09-18' });
  const t2 = trip('XX09', 2, '2026-09-19', { loadDate: '2026-09-22', unloadDate: '2026-09-28' });
  const f1 = [fill('XX09', 1, '2026-09-11', 350, { bill: 'S/91' }), fill('XX09', 1, '2026-09-16', 30, { bill: 'S/92' })];
  const f2 = [fill('XX09', 2, '2026-09-19', 250, { location: 'Plant town', bill: 'S/93' }), fill('XX09', 2, '2026-09-20', 350, { bill: 'S/94' }), fill('XX09', 2, '2026-09-25', 280, { bill: 'S/95' })];
  // XX08: 130 L over at mid-way — the buffer, planned: not flagged; XX07: 60 L over — the driver's extra
  // (the recon deducts it), not a wrong entry: not flagged either
  const t4 = trip('XX07', 1, '2026-09-10', { loadDate: '2026-09-12', unloadDate: '2026-09-18' });
  const f4 = [fill('XX07', 1, '2026-09-11', 410, { bill: 'S/71' }), fill('XX07', 1, '2026-09-16', 280, { bill: 'S/72' })];
  trips.push(t4); hsd.push(...f4); td.set(t4.row, zOf(t4, 630, f4));
  const t3 = trip('XX08', 1, '2026-09-10', { loadDate: '2026-09-12', unloadDate: '2026-09-18' });
  const f3 = [fill('XX08', 1, '2026-09-11', 480, { bill: 'S/81' }), fill('XX08', 1, '2026-09-16', 280, { bill: 'S/82' })];
  trips.push(t3); hsd.push(...f3); td.set(t3.row, zOf(t3, 630, f3));
  trips.push(t1, t2); hsd.push(...f1, ...f2);
  td.set(t1.row, zOf(t1, 630, f1)); td.set(t2.row, zOf(t2, 630, f2));
  const L = irregulars({ trips, hsd }, { tripDiesel: td, today });
  const o = L.filter((x) => x.kind === 'overdraw');
  assert.equal(o.length, 1);
  assert.equal(o[0].row, t2.row);
  assert.equal(o[0].level, 'bad');
  assert.equal(o[0].src, f2[0]);                                         // the fill to move
  assert.match(o[0].text, /880 L of diesel tagged against 630 L allotted \(\+250 L — more than the 120–140 L mid-way buffer\) — trucks on this route usually take 630 L\. The 250 L fill on 19 Sep at Plant town \(S\/93\) probably belongs to T01\/DEMO, which is 250 L under/);
  // each fill's place in the trip
  const p = fillProgress(td);
  assert.deepEqual([p.get(f2[0]).before, p.get(f2[0]).after], [0, 250]);
  assert.deepEqual([p.get(f2[2]).before, p.get(f2[2]).after, p.get(f2[2]).allotted], [600, 880, 630]);
});

test('fills entered twice, a slip no. used twice, fills on the wrong trip or none, amounts off', () => {
  row = 3;
  const a = trip('XX01', 1, '2026-09-01', { unloadDate: '2026-09-08' });
  const b = trip('XX01', 2, '2026-09-09', { unloadDate: '2026-09-16' });
  const twin1 = fill('XX01', 2, '2026-09-10', 350);
  const twin2 = fill('XX01', 2, '2026-09-11', 350);
  const slipA = fill('XX02', 7, '2026-09-12', 300, { bill: 'S/700' });
  const slipB = fill('XX03', 7, '2026-09-13', 280, { bill: 's/700 ' });
  const onA = fill('XX01', 2, '2026-09-04', 200, { bill: 'S/1' });           // dated in trip 1, tagged to trip 2
  const nowhere = fill('XX01', 9, '2026-09-05', 50, { bill: 'S/2' });        // a trip the truck doesn't have
  const untagged = fill('XX01', 1, '2026-09-06', 30, { trip: '', bill: 'S/3' });
  const sum = fill('XX01', 1, '2026-09-07', 100, { amount: 9000, bill: 'S/4' });
  const L = irregulars({ trips: [a, b], hsd: [twin1, twin2, slipA, slipB, onA, nowhere, untagged, sum] }, { today });
  const of = (k) => L.filter((x) => x.kind === k);
  assert.equal(of('dup-fill').length, 2);
  assert.ok(of('dup-fill').some((x) => x.src === twin2 && x.also === twin1));
  assert.ok(of('dup-fill').some((x) => /Slip s\/700 entered 2 times/i.test(x.text)));
  const wrong = of('wrong-trip');
  assert.match(wrong.find((x) => x.src === onA).text, /tagged to T02\/DEMO .* but that day the truck was on T01\/DEMO/);
  assert.match(wrong.find((x) => x.src === nowhere).text, /T09\/DEMO, which this truck doesn't have/);
  assert.match(wrong.find((x) => x.src === untagged).text, /isn't tagged to any trip/);
  assert.match(of('fill-math')[0].text, /100 L × ₹100\.00 = ₹10,000, but the amount is ₹9,000/);
  // the day book's markers
  const ix = irregularIndex(L);
  assert.equal(ix.bySrc.get(twin1)[0].kind, 'dup-fill');
  assert.equal(ix.bySrc.get(onA)[0].kind, 'wrong-trip');
});

test('trips: dates, unloading far later than the route takes, weights, rates; urea and advances twice', () => {
  row = 3;
  const trips = [];
  for (let i = 0; i < 6; i++) trips.push(trip(`XX0${i}`, 1, `2026-09-0${i + 1}`, { loadDate: `2026-09-0${i + 2}`, unloadDate: `2026-09-${10 + i}`.replace('-9-', '-09-'), loadWt: 40, rate: 3000, bhada: 120000 }));
  trips.forEach((t, i) => { t.unloadDate = `2026-09-${String(5 + i).padStart(2, '0')}`; });       // 3 days load → unload
  const slow = trip('XX07', 1, '2026-09-10', { loadDate: '2026-09-11', unloadDate: '2026-09-24', loadWt: 40, rate: 3000, bhada: 120000 });
  const yr = trip('XX08', 1, '2026-01-08', { loadDate: '2026-10-05', unloadDate: '2026-10-09', month: '2026-10' });
  const light = trip('XX09', 1, '2026-09-20', { loadDate: '2026-09-21', unloadDate: '2026-09-24', loadWt: 30, rate: 3000, bhada: 90000, unloadWt: 30.6 });
  const odd = trip('XX10', 1, '2026-09-21', { loadDate: '2026-09-22', loadWt: 40, rate: 3500, bhada: 120000 });
  const urea = [{ veh: 'XX01', date: '2026-09-10', qty: 20, amount: 1780 }, { veh: 'XX01', date: '2026-09-10', qty: 20, amount: 1780 }];
  const pay = [{ veh: 'XX02', date: '2026-09-12', amount: 2000, name: 'Ramu' }, { veh: 'XX02', date: '2026-09-12', amount: 2000, name: 'Ramu' }];
  const L = irregulars({ trips: [...trips, slow, yr, light, odd], hsd: [], urea, driverPay: pay }, { today });
  const of = (k) => L.filter((x) => x.kind === k);
  assert.match(of('slow-unload')[0].text, /XX07 T01\/DEMO: unloaded 13 days after loading .* trucks lately take 3/);
  assert.equal(of('slow-unload')[0].level, 'bad');
  assert.match(of('dates').find((x) => x.row === yr.row).text, /days from the trip start \(8 Jan 2026\) to unloading — a year typed wrong/);
  assert.ok(of('weight').some((x) => x.row === light.row && /loaded 30\.00 T — trucks on Port → Plant usually load about 40\.00 T/.test(x.text)));
  assert.ok(of('weight').some((x) => x.row === light.row && /30\.60 T unloaded from 30\.00 T/.test(x.text)));
  assert.ok(of('rate').some((x) => x.row === odd.row && /rate ₹3,500\/T — the other trips on Port → Plant that month are ₹3,000\/T/.test(x.text)));
  assert.ok(of('rate').some((x) => x.row === odd.row && /freight ₹1,20,000 ≠ 40\.00 T × ₹3,500/.test(x.text)));
  assert.equal(of('dup-urea').length, 1);
  assert.equal(of('dup-advance').length, 1);
  // serious first, newest first
  assert.ok(L.findIndex((x) => x.level === 'warn') > L.findLastIndex((x) => x.level === 'bad'));
});
