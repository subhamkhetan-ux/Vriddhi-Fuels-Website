// The pipe change acted out (decant/js/worker.js): what the attendant does at
// each moment of the move, all from the time.
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXIT, GROUND, OUTLET_Y, SIZE, leverTip, moveScene, skeleton } from '../../decant/js/worker.js';

// C2's valve at 82.5 to C3's at 95, in the default 0:45
const m = { t0: 0, t1: 45000, xa: 82.5, xb: 95 };
const at = (s) => moveScene(m, s * 1000);
// the near hand, in the picture's units
const hand = (sc) => { const h = skeleton(sc.pose).hands.f; return { x: sc.x + h.x * SIZE * sc.face, y: GROUND + h.y * SIZE }; };
const near = (p, q, d = 1.5) => Math.hypot(p.x - q.x, p.y - q.y) <= d;

test('on only while the pipe is moved, and a few seconds after as he walks off', () => {
  assert.equal(at(-0.1), null);
  assert.ok(at(0));
  assert.ok(at(45 + EXIT));
  assert.equal(at(45 + EXIT + 0.1), null);
  assert.equal(moveScene({ ...m, t1: 10000 }, 5000), null);          // under 12 s: no one to show
});

test('the steps, in order', () => {
  assert.deepEqual([1, 7, 10, 15, 20, 28, 35, 42, 47].map((s) => at(s).step),
    ['in', 'look', 'close', 'unhook', 'carry', 'couple', 'open', 'stand', 'exit']);
});

test('the valves: the emptied one open until he turns it shut, the next shut until he opens it', () => {
  for (const s of [0, 7.9]) assert.deepEqual(at(s).levers, { a: 0, b: -90 });
  assert.ok(at(11).levers.a < 0 && at(11).levers.a > -90);
  for (const s of [13, 20, 31]) assert.deepEqual(at(s).levers, { a: -90, b: -90 });
  assert.ok(at(35).levers.b > -90 && at(35).levers.b < 0);
  for (const s of [40, 44, 50]) assert.deepEqual(at(s).levers, { a: -90, b: 0 });
});

test('the hose: on the emptied chamber, in his hands, then coupled on the next', () => {
  for (const s of [0, 10, 13.5]) assert.deepEqual(at(s).hose, { x: 82.5, y: OUTLET_Y });
  const carried = at(21.5).hose;
  assert.ok(carried.x > 82.5 && carried.x < 95 && carried.y < OUTLET_Y, JSON.stringify(carried));
  for (const s of [33, 40, 50]) assert.deepEqual(at(s).hose, { x: 95, y: OUTLET_Y });
  assert.ok(at(16).drip && !at(10).drip && !at(35).drip);            // a drip as it comes off
  assert.ok(at(31.6).lock > 0 && !at(29).lock);                      // the click as it couples
});

test('his hand is on what he works: the handles as they turn, the hose as he carries it', () => {
  const closing = at(11);
  assert.ok(near(hand(closing), leverTip(82.5, closing.levers.a)), JSON.stringify(hand(closing)));
  const opening = at(35);
  assert.ok(near(hand(opening), leverTip(95, opening.levers.b)), JSON.stringify(hand(opening)));
  for (const s of [17, 21.5, 28]) { const sc = at(s); assert.ok(near(hand(sc), sc.hose), `${s} s: ${JSON.stringify([hand(sc), sc.hose])}`); }
  assert.ok(at(42.5).thumb && !at(35).thumb);                        // a thumbs-up as the fuel runs
});

test('he walks in from the left, works facing the truck, and walks off the way he came', () => {
  assert.ok(at(0).x < 0 && at(0).face === 1);
  assert.equal(at(10).x, 82.5 - 8);
  assert.equal(at(35).x, 95 - 8);
  assert.equal(at(47).face, -1);
  assert.ok(at(45 + EXIT).x < 0);
});

test('his feet stay on the ground whatever he does', () => {
  for (let s = 0; s <= 45 + EXIT; s += 0.25) {
    const { feet } = skeleton(at(s).pose);
    assert.ok(Math.abs(Math.max(feet.f.y, feet.b.y)) < 1e-9, `${s} s`);
    assert.ok(Math.min(feet.f.y, feet.b.y) > -4, `${s} s: a foot lifted ${Math.min(feet.f.y, feet.b.y)}`);
  }
});

test('the close-up: zooms in as he gets there, out as he leaves', () => {
  assert.equal(at(2).zoom, 0);
  assert.equal(at(10).zoom, 1);
  assert.equal(at(44).zoom, 1);
  assert.ok(at(47).zoom > 0 && at(47).zoom < 1);
  assert.equal(at(49.5).zoom, 0);
});

test('a longer pipe time: the same steps, in proportion', () => {
  const slow = (s) => moveScene({ ...m, t1: 90000 }, s * 1000);
  assert.equal(slow(22).step, 'close');
  assert.ok(Math.abs(slow(22).levers.a - at(11).levers.a) < 1e-9);
  assert.equal(slow(95).step, 'exit');                               // walking off still takes 8 s
  assert.equal(slow(90 + EXIT + 1), null);
});
