// Outstanding today: the net figure (due less what customers paid in advance).
import assert from 'node:assert/strict';
import test from 'node:test';

import { outstandingListSvg } from '../../ledger/js/share-svg.js';

const list = [{ name: 'Alpha', kind: 'bulk', balance: 500000 }, { name: 'Beta', kind: 'retail', balance: 120000 }];

test('the list picture leads with the net outstanding when there are advances', () => {
  const { svg } = outstandingListSvg({ list, total: 620000, advance: 45000, asOn: '2026-11-18' });
  assert.match(svg, /NET OUTSTANDING · AFTER ADVANCES/);
  assert.match(svg, /₹5,75,000/);                 // 6,20,000 − 45,000
  assert.match(svg, /₹6,20,000/);
  assert.match(svg, /− ₹45,000/);
});

test('without advances it stays the total outstanding', () => {
  const { svg } = outstandingListSvg({ list, total: 620000, asOn: '2026-11-18' });
  assert.match(svg, /TOTAL OUTSTANDING · 2 CUSTOMERS/);
  assert.doesNotMatch(svg, /NET OUTSTANDING/);
});
