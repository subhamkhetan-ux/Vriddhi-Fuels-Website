// Payments → By mode (modes.js); made-up figures, modes as typed in Master Paid.
import assert from 'node:assert/strict';
import test from 'node:test';

import { modeKey, modeSummary, splitMode } from '../../ledger/js/modes.js';
import { demoSeed } from '../../ledger/js/demo.js';
import { memoryStore } from '../../ledger/js/store.js';

test('split payments: each mode gets its part when the parts add up', () => {
  assert.deepEqual(splitMode('2.5 Cash + 1Lac HDFC 1010', 350000), [{ mode: 'Cash', amount: 250000 }, { mode: 'HDFC 1010', amount: 100000 }]);
  assert.deepEqual(splitMode('15000 HDFC + 35000 Cash', 50000), [{ mode: 'HDFC', amount: 15000 }, { mode: 'Cash', amount: 35000 }]);
  assert.deepEqual(splitMode('10148 Swipe + 10k HDFC 1010', 20148), [{ mode: 'Swipe', amount: 10148 }, { mode: 'HDFC 1010', amount: 10000 }]);
  assert.deepEqual(splitMode('1,00,000 Cash + 50k ICICI', 150000), [{ mode: 'Cash', amount: 100000 }, { mode: 'ICICI', amount: 50000 }]);
  assert.deepEqual(splitMode('20000 Cash + HDFC 1010', 30000), [{ mode: 'Cash', amount: 20000 }, { mode: 'HDFC 1010', amount: 10000 }]);   // the rest
  assert.equal(splitMode('HDFC 1010', 5000), null);                      // not a split
  assert.equal(splitMode('Cash + HDFC', 100), null);                     // no amounts
  assert.equal(splitMode('5000 Cash + 3000 UPI', 9999), null);           // doesn't add up: kept as written
  assert.equal(modeKey(' ICICI BANK LTD. '), 'icici bank ltd');
});

test('by mode: Cash first, XtraPower next, the rest by amount, no mode last', () => {
  const p = (pay_date, customer, amount, mode, remarks = '') => ({ pay_date, customer, amount, mode, remarks });
  const s = modeSummary([
    p('2026-10-01', 'Alpha Ltd', 500000, 'HDFC 1010'),
    p('2026-10-02', 'Beta Ltd', 900000, 'ICICI BANK LTD'),
    p('2026-10-03', 'Alpha Ltd', 200000, 'XtraPower'),
    p('2026-10-04', 'Gamma', 300000, 'Xtrapower'),
    p('2026-10-05', 'Delta', 350000, '2.5 Cash + 1Lac HDFC 1010'),
    p('2026-10-06', 'Gamma', 60000, '30000 UPI + 30000 HDFC'),
    p('2026-10-07', 'Delta', 4000, 'cash'),
    p('2026-10-08', 'Omega', 7000, ''),
    p('2026-11-02', 'Alpha Ltd', -1000, 'HDFC 1010', 'refund'),
    p('2026-11-03', 'Zero', 0, 'Cheque'),                                 // nothing paid: not a mode
  ]);
  assert.equal(s.total, 2320000);
  assert.equal(s.count, 9);
  assert.deepEqual(s.modes.map((m) => [m.label, m.amount, m.count]), [
    ['Cash', 254000, 2], ['XtraPower', 500000, 2], ['ICICI BANK LTD', 900000, 1], ['HDFC 1010', 629000, 3], ['UPI', 30000, 1], ['No mode entered', 7000, 1],
  ]);
  const hdfc = s.modes.find((m) => m.label === 'HDFC 1010');
  assert.deepEqual([hdfc.split, hdfc.refunds, hdfc.customers, hdfc.first, hdfc.last], [2, 1, 3, '2026-10-01', '2026-11-02']);   // "HDFC" is HDFC 1010
  assert.deepEqual(hdfc.byCustomer.map((c) => [c.name, c.amount, c.count]), [['Alpha Ltd', 499000, 2], ['Delta', 100000, 1], ['Gamma', 30000, 1]]);
  assert.deepEqual(hdfc.months, [{ month: '2026-10', amount: 630000 }, { month: '2026-11', amount: -1000 }]);
  const cash = s.modes[0];
  assert.deepEqual(cash.payments.map((x) => [x.pay_date, x.part, x.whole, x.written, x.split, x.modeKey]), [
    ['2026-10-07', 4000, 4000, 'cash', false, 'cash'],
    ['2026-10-05', 250000, 350000, '2.5 Cash + 1Lac HDFC 1010', true, 'cash'],
  ]);
  assert.ok(Math.abs(s.modes.reduce((a, m) => a + m.share, 0) - 1) < 1e-9);
  // only the modes used in the period
  assert.deepEqual(modeSummary([p('2026-11-01', 'A', 100, 'PayTM')]).modes.map((m) => m.label), ['PayTM']);
  assert.deepEqual(modeSummary([]), { total: 0, count: 0, modes: [], from: '', to: '' });
});

test('demo store: payments of a period with their mode', async () => {
  const store = memoryStore(demoSeed(new Date('2026-11-10')));
  const rows = await store.paymentsRange('2026-11-01', '2026-11-10');
  assert.ok(rows.length && rows.every((r) => r.pay_date >= '2026-11-01' && r.pay_date <= '2026-11-10'));
  assert.ok(rows.every((r) => 'mode' in r && 'remarks' in r && r.customer && r.key));
  const s = modeSummary(rows);
  assert.equal(s.modes[0].label, 'Cash');
  assert.equal(s.modes[1].label, 'XtraPower');
  await assert.rejects(store.paymentsRange('2026-11-10', '2026-11-01'), /From date/);
});
