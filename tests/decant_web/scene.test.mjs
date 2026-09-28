// The decanting scene (decant/js/scene.js): what it draws for each tank's stage
// and, while a tank decants, where its pipe and levels are by the clock.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SETTINGS, DEFAULT_TANKS } from '../../decant/js/core.js';
import { decantScene } from '../../decant/js/scene.js';

const T0 = Date.parse('2026-09-28T11:45:00Z');           // 17:15 IST
const iso = (secs) => new Date(T0 + secs * 1000).toISOString();
const reading = (volume) => ({ volume });
const session = (stages) => ({
  id: 'S', tt_no: 'OD23U8210', status: 'decanting',
  data: {
    chambers: [[1, 5000, 'MS'], [2, 5000, 'HSD'], [3, 4000, 'HSD'], [4, 4000, 'HSD'], [5, 4000, 'HSD']].map(([no, litres, product]) => ({ no, litres, product })),
    done: stages.T1 === 'settling' ? [1] : [],
    tanks: [
      { tank: 'T1', product: 'MS', chambers: [1], litres: 5000, stage: stages.T1, before: reading(7682) },
      { tank: 'T2', product: 'HSD', chambers: [2, 3], litres: 9000, stage: stages.T2, before: reading(10755), startedAt: stages.T2 === 'waiting' ? null : iso(0) },
      { tank: 'T3', product: 'HSD', chambers: [4, 5], litres: 8000, stage: stages.T3, before: reading(11495), startedAt: stages.T3 === 'waiting' ? null : iso(0) },
    ],
  },
});
const draw = (stages, secs, extra = {}) => decantScene(session(stages), { tanks: DEFAULT_TANKS, stock: { T4: reading(2560) }, settings: DEFAULT_SETTINGS, now: T0 + secs * 1000, ...extra });
const count = (svg, re) => (svg.match(re) || []).length;
// the sight glass level of chamber `no` (its liquid's top, in the picture's units)
const glassTop = (svg, no) => Number(new RegExp(`data-k="l${no}" transform="translate\\(0 ([\\d.]+)\\)"`).exec(svg)?.[1]);
const tankTop = (svg, id) => Number(new RegExp(`data-k="t${id}" transform="translate\\(0 ([\\d.]+)\\)"`).exec(svg)?.[1]);

test('the truck: its number and capacity, every chamber full', () => {
  const svg = draw({ T1: 'waiting', T2: 'waiting', T3: 'waiting' }, 0);
  assert.match(svg, /class="ds-livery">OD23U8210 · 22 KL</);
  assert.ok(!/BOTTOM LOADING/.test(svg));
  assert.equal(count(svg, /class="ds-ch">C\d</g), 5);
  for (const no of [1, 2, 3, 4, 5]) assert.equal(glassTop(svg, no), 36.1, `C${no} full`);
  // nothing started: one pipe per tank, only where it will go first (dashed)
  assert.equal(count(svg, /stroke-dasharray="2 4"/g), 3);
  assert.equal(count(svg, /class="dp/g), 0);
  assert.ok(!/data-anim/.test(svg));
});

test('one pipe per tank, on one chamber at a time — moved on as each empties', () => {
  // 10 min in: C2 (5 KL, 8:15) is empty, the pipe is on C3 (4 KL, 7:00), a quarter out
  const svg = draw({ T1: 'settling', T2: 'decanting', T3: 'waiting' }, 600);
  assert.equal(count(svg, /class="dp flowing"/g), 1);
  assert.match(svg, /data-k="pT2">\s*<path class="hose" d="M95 103 /);  // C3's valve
  assert.match(svg, /class="coupling" cx="95"/);
  assert.equal(glassTop(svg, 2), 63);                                   // C2 empty (liquid out of sight)
  assert.equal(glassTop(svg, 3), 42.1);                                 // C3 three quarters full
  assert.equal(glassTop(svg, 4), 36.1);                                 // C4, C5 full, waiting for Tank 3
  assert.match(svg, /class="gl on" data-k="g3"/);
  assert.match(svg, /class="gl" data-k="g2"/);
  // Tank 2 has what C2 and a quarter of C3 gave: 10,755 + 5,000 + 1,000 L
  assert.equal(tankTop(svg, 'T2'), 167.1);
  assert.match(svg, /class="dt flowing" data-k="dT2"/);
  assert.equal(count(svg, /class="drop"/g), 3);
  assert.match(svg, /aria-label="OD23U8210: C1 into Tank 1 \(settling\); C2,3 into Tank 2 \(pipe on C3\); C4,5 into Tank 3 \(next\)"/);
  assert.match(svg, /data-anim="/);
});

test('two tanks at once: two pipes; once every chamber should be empty the pipes stop', () => {
  const two = draw({ T1: 'waiting', T2: 'decanting', T3: 'decanting' }, 60);
  assert.equal(count(two, /class="dp flowing"/g), 2);
  assert.match(two, /data-k="pT2">\s*<path class="hose" d="M82.5 103 /);  // C2
  assert.match(two, /data-k="pT3">\s*<path class="hose" d="M107.5 103 /); // C4
  const after = draw({ T1: 'waiting', T2: 'decanting', T3: 'decanting' }, 16 * 60);   // C2+C3 = 15:15, C4+C5 = 14:00
  assert.equal(count(after, /class="dp flowing"/g), 0);
  assert.equal(count(after, /class="dp"/g), 2);
  for (const no of [2, 3, 4, 5]) assert.equal(glassTop(after, no), 63, `C${no} empty`);
  assert.equal(tankTop(after, 'T2'), 160.5);                           // at 19,755 L
  assert.match(after, /class="dt" data-k="dT2"/);
});

test('settling: the pipe still on the last chamber; done: no pipe', () => {
  const svg = draw({ T1: 'settling', T2: 'settling', T3: 'read' }, 0);
  assert.match(svg, /class="dp still" data-k="pT2">\s*<path class="hose" d="M95 103 /);
  assert.equal(count(svg, /data-k="pT3"/g), 0);
  assert.equal(count(svg, /done ✓/g), 1);
});

test('a tank not in this decantation shows its stock, dimmed', () => {
  const svg = draw({ T1: 'waiting', T2: 'decanting', T3: 'waiting' }, 0);
  assert.match(svg, /data-k="dT4" opacity="\.42">[\s\S]*Tank 4/);
});
