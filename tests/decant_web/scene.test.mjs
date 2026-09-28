// The decanting scene (decant/js/scene.js): what it draws for each tank's stage.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TANKS } from '../../decant/js/core.js';
import { decantScene } from '../../decant/js/scene.js';

const reading = (volume) => ({ volume });
const session = (stages) => ({
  id: 'S', tt_no: 'OD23U8210', status: 'decanting',
  data: {
    chambers: [[1, 5000, 'MS'], [2, 5000, 'HSD'], [3, 4000, 'HSD'], [4, 4000, 'HSD'], [5, 4000, 'HSD']].map(([no, litres, product]) => ({ no, litres, product })),
    done: stages.T1 === 'settling' ? [1] : [],
    tanks: [
      { tank: 'T1', product: 'MS', chambers: [1], litres: 5000, stage: stages.T1, before: reading(7682) },
      { tank: 'T2', product: 'HSD', chambers: [2, 3], litres: 9000, stage: stages.T2, before: reading(10755) },
      { tank: 'T3', product: 'HSD', chambers: [4, 5], litres: 8000, stage: stages.T3, before: reading(11495) },
    ],
  },
});
const count = (svg, re) => (svg.match(re) || []).length;

test('the truck: its number and capacity, a sight glass per chamber', () => {
  const svg = decantScene(session({ T1: 'waiting', T2: 'waiting', T3: 'waiting' }), { tanks: DEFAULT_TANKS });
  assert.match(svg, /class="ds-livery">OD23U8210 · 22 KL</);
  assert.ok(!/BOTTOM LOADING/.test(svg));
  assert.equal(count(svg, /class="ds-ch">C\d</g), 5);
  // nothing started: every hose only planned (dashed), nothing flows
  assert.equal(count(svg, /hose-flow/g), 0);
  assert.equal(count(svg, /stroke-dasharray="2 4"/g), 5);
});

test('stages: flowing while decanting, still while settling, gone when done', () => {
  const svg = decantScene(session({ T1: 'settling', T2: 'decanting', T3: 'waiting' }), { tanks: DEFAULT_TANKS, stock: { T4: reading(2560) } });
  assert.equal(count(svg, /class="hose-flow"/g), 2);                     // C2, C3 into Tank 2
  assert.equal(count(svg, /class="drop"/g), 3);                          // product dropping into Tank 2
  assert.match(svg, /aria-label="OD23U8210: C1 into Tank 1 \(settling\); C2,3 into Tank 2 \(decanting\); C4,5 into Tank 3 \(next\)"/);
  assert.match(svg, /class="ds-live">decanting</);
  const done = decantScene(session({ T1: 'read', T2: 'read', T3: 'read' }), { tanks: DEFAULT_TANKS });
  assert.equal(count(done, /hose-flow/g), 0);
  assert.equal(count(done, /done ✓/g), 3);
});

test('a tank not in this decantation shows its stock, dimmed', () => {
  const svg = decantScene(session({ T1: 'waiting', T2: 'decanting', T3: 'waiting' }), { tanks: DEFAULT_TANKS, stock: { T4: reading(2560) } });
  assert.match(svg, /<g opacity="\.42">[\s\S]*Tank 4/);
});
