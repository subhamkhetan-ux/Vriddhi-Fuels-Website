// Use From (the *_Bulk trackers' new date column): a PO is only for bills on or
// after that date, so adding a PO never changes a bill that already has one —
// the case that turned set POs into "Select PO ▼" on Shyam Metalics and SMC.
import assert from 'node:assert/strict';
import test from 'node:test';

import { allocate, poListChanges } from '../../ledger/js/po.js';

const bill = (date, qty, extra = {}) => ({ date, qty, product: 'HSD', po_mode: 'auto', ...extra });
const pos = [{ id: 1, po_no: 'A', allotted: 50000, seq: 1, use_from: '2026-04-01' }];

test('a new PO with a later Use From leaves earlier bills as they were', () => {
  const bills = [bill('2026-11-10', 12000), bill('2026-11-15', 12000), bill('2026-11-21', 12000), bill('2026-11-22', 12000)];
  const before = allocate({ kind: 'po', pos, bills, rule: 'pick' }).bills.map((b) => b.po || b.how);
  assert.deepEqual(before, ['A', 'A', 'A', 'A']);
  // without Use From, adding B makes every bill that both fit a "Select PO ▼"
  const undated = allocate({ kind: 'po', pos: [...pos, { id: 2, po_no: 'B', allotted: 70000, seq: 2 }], bills, rule: 'pick' }).bills.map((b) => b.po || b.how);
  assert.deepEqual(undated, ['choose', 'choose', 'choose', 'choose']);
  // with Use From 21 Nov: the bills before it keep A; from it on both fit
  const dated = allocate({ kind: 'po', pos: [...pos, { id: 2, po_no: 'B', allotted: 70000, seq: 2, use_from: '2026-11-21' }], bills, rule: 'pick' });
  assert.deepEqual(dated.bills.map((b) => b.po || b.how), ['A', 'A', 'choose', 'choose']);
  assert.deepEqual(dated.bills[2].choices, ['A', 'B']);
});

test('a bill before every PO\'s Use From gets none; unit-wise lists (SMC) too', () => {
  assert.equal(allocate({ kind: 'po', pos: [{ po_no: 'A', allotted: 1000, use_from: '2026-11-21' }], bills: [bill('2026-11-20', 500)] }).bills[0].how, 'no-po');
  const smc = allocate({
    kind: 'po_units', units: ['UNIT 1', 'UNIT 2'], rule: 'pick',
    pos: [{ unit: 'UNIT 2', po_no: '4500223727', allotted: 70000, seq: 1, use_from: '2026-04-01' },
      { unit: 'UNIT 2', po_no: '4500225060', allotted: 70000, seq: 2, use_from: '2026-11-21' }],
    bills: [bill('2026-11-20', 12000, { unit: 'UNIT 2' }), bill('2026-11-21', 12000, { unit: 'UNIT 2' })],
  });
  assert.deepEqual(smc.bills.map((b) => b.po || b.how), ['4500223727', 'choose']);
});

test('the upload preview shows a changed Use From', () => {
  const cur = [{ group_code: 'G', unit: '', po_no: 'A', allotted: 100, seq: 1, use_from: null }];
  const inc = [{ group_code: 'G', unit: '', po_no: 'A', allotted: 100, seq: 1, use_from: '2026-04-01' }];
  assert.deepEqual(poListChanges(cur, inc, ['G'])[0].changed, [{ po_no: 'A', useFrom: { from: '', to: '2026-04-01' } }]);
});

test('the import reads Use From next to each PO list (after Allotted, or after Status on SMC)', async () => {
  const { extractMaster } = await import('../../ledger/js/master.js');
  const { demoWorkbook } = await import('./fixtures.mjs');
  const { date } = await import('./sheets.mjs');
  const wb = demoWorkbook();
  // as the sheets now are: Demo_Bulk T PO No. | U Allotted | V Use From;
  // Twin (unit-wise) … Z Status | AA Use From, … AG Status | AH Use From
  const demo = wb.Sheets.Demo_Bulk;
  Object.assign(demo, { V4: { t: 's', v: 'Use From' }, V5: date('2026-04-01'), V6: date('2026-11-21') });
  const twin = wb.Sheets.Twin_Bulk;
  Object.assign(twin, { AA4: { t: 's', v: 'Use From' }, AA5: date('2026-04-01'), AH4: { t: 's', v: 'Use From' }, AH6: date('2026-11-21') });
  const pos = extractMaster(wb).payload.pos;
  const uf = (g, no) => pos.find((p) => p.group_code === g && p.po_no === no).use_from || null;
  assert.equal(uf('Demo_Bulk', 'PO-A'), '2026-04-01');
  assert.equal(uf('Demo_Bulk', 'PO-B'), '2026-11-21');
  assert.equal(uf('Twin_Bulk', 'T1-A'), '2026-04-01');
  assert.equal(uf('Twin_Bulk', 'T2-A'), null);                     // left blank: every bill
  assert.equal(uf('Twin_Bulk', 'T2-B'), '2026-11-21');
});
