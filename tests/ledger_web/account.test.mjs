// A customer's ledger as on their Master Ledger sheet (bulk layouts + formats).
import assert from 'node:assert/strict';
import test from 'node:test';

import { bulkRows, cellText, isNegative, xlPrice, xlRupee, xlVolume } from '../../ledger/js/account.js';
import { memoryStore } from '../../ledger/js/store.js';

const data = (kind, extra = {}) => ({
  group: { code: 'SMC_Bulk', title: 'SMC — Bulk Ledger', kind, units: ['UNIT 1', 'UNIT 2'], period_from: '2026-04-01', opening: 1000, layout: null, ...extra },
  members: [{ key: 'smc', name: 'SMC Power' }],
  sales: [
    { id: 3, product: 'OTHER', bill_no: 'LUBE/1', sale_date: '2026-04-02', qty: 1, rate: 450, amount: 450, customer: 'SMC Power', item: 'Engine oil', seq: 1 },
    { id: 2, product: 'MS', bill_no: '77', sale_date: '2026-04-02', qty: 10, rate: 100, amount: 1000, customer: 'SMC Power', seq: 5 },
    { id: 1, product: 'HSD', bill_no: '101', sale_date: '2026-04-02', qty: 1000.4, rate: 90, amount: 90036, customer: 'SMC Power', seq: 9, unit: 'UNIT 1', remarks: 'late' },
    { id: 4, product: 'HSD', bill_no: '102', sale_date: '2026-04-01', qty: 500, rate: 90, amount: 45000, customer: 'SMC Power', seq: 10, unit: 'UNIT 2' },
  ],
  payments: [{ id: 9, pay_date: '2026-04-02', customer: 'SMC Power', amount: 100000, tds: 500, shortage: 36, remarks: 'NEFT', seq: 3 }],
});

test('bulk sheet rows: bills by date (diesel, petrol, XtraGreen, payments, other), running balance', () => {
  const res = bulkRows(data('po_units'), (id) => ({ 1: 'PO-9', 4: 'PO-8' }[id]));
  assert.equal(res.kind, 'po_units');
  assert.deepEqual(res.columns, ['date', 'bill', 'qty', 'rate', 'amount', 'paid', 'tds', 'shortage', 'balance', 'unit', 'product', 'po', 'remarks']);
  assert.deepEqual(res.rows.map((r) => [r.date, r.product, r.bill, r.po, r.balance]), [
    ['2026-04-01', 'DIESEL', '102', 'PO-8', 46000],
    ['2026-04-02', 'DIESEL', '101', 'PO-9', 136036],
    ['2026-04-02', 'PETROL', '77', '', 137036],
    ['2026-04-02', 'Payment', '', '', 137036 - 100000 - 500 - 36],
    ['2026-04-02', 'Engine oil', '', '', 36950],
  ]);
  assert.equal(res.closing, 36950);
  assert.deepEqual(res.totals, { qty: 1511.4, amount: 136486, paid: 100000, tds: 500, shortage: 36 });
  const pay = res.rows[3];
  assert.deepEqual(res.columns.map((c) => cellText(c, pay)), ['02/04/26', '', '', '', '-', '₹100,000', '₹500', '₹36', '₹36,500', '', 'Payment', '', 'NEFT']);
  const bill = res.rows[1];
  assert.deepEqual(res.columns.map((c) => cellText(c, bill)), ['02/04/26', '101', '1,000', '90.00', '₹90,036', '-', '', '', '₹136,036', 'UNIT 1', 'DIESEL', 'PO-9', 'late']);
});

test('group sheets carry the billing name; PO sheets have no unit', () => {
  assert.deepEqual(bulkRows(data('group')).columns.slice(0, 3), ['date', 'name', 'bill']);
  assert.ok(!bulkRows(data('po')).columns.includes('unit'));
  const w = bulkRows(data('po', { layout: { cols: [12, 12, 11, 9, 15, 15, 9, 13, 15, 12, 18, 24, 8, 20, 18] } }));
  assert.equal(w.widths.length, 15);
  assert.equal(bulkRows(data('po')).widths, null);
});

test("the sheets' number formats", () => {
  assert.equal(xlVolume(0), '');
  assert.equal(xlVolume(1234.6), '1,235');
  assert.equal(xlVolume(-5), '(5)');
  assert.equal(xlPrice(0), '');
  assert.equal(xlPrice(90.5), '90.50');
  assert.equal(xlRupee(0), '-');
  assert.equal(xlRupee(null), '-');
  assert.equal(xlRupee(null, { blankIfEmpty: true }), '');
  assert.equal(xlRupee(-2500), '-₹2,500');
  assert.equal(xlRupee(12345678.4), '₹12,345,678');
  assert.ok(isNegative('balance', { balance: -1 }));
  assert.ok(!isNegative('product', { product: -1 }));
});

test('demo store: a bulk group and a retail customer', async () => {
  const store = memoryStore({});
  await store.importMaster('ML.xlsm', {
    groups: [{ code: 'Big_Bulk', title: 'Big — Bulk', kind: 'group', period_from: '2026-04-01', opening: 1000, layout: { cols: [1, 2] } }],
    customers: [{ name: 'Big One', bulk_group: 'Big_Bulk' }, { name: 'Alpha', ledger: 'Alpha' }],
    sales: [{ product: 'HSD', bill_no: '1', sale_date: '2026-04-02', qty: 10, rate: 90, amount: 900, customer: 'Big One', seq: 2, remarks: 'x' },
      { product: 'HSD', bill_no: '0', sale_date: '2026-03-31', qty: 1, rate: 90, amount: 90, customer: 'Big One', seq: 1 },
      { product: 'HSD', bill_no: '2', sale_date: '2026-04-05', qty: 1, rate: 91, amount: 91, customer: 'Alpha', seq: 3 }],
    payments: [{ pay_date: '2026-04-03', customer: 'Big One', amount: 500, tds: 5, shortage: 10, seq: 2 },
      { pay_date: '2026-04-06', customer: 'Alpha', amount: 50, seq: 3 }],
  });
  const g = await store.account(null, 'Big_Bulk');
  assert.deepEqual([g.kind, g.group.layout, g.members.map((m) => m.name)], ['bulk', { cols: [1, 2] }, ['Big One']]);
  assert.deepEqual(g.sales.map((s) => [s.bill_no, s.remarks]), [['1', 'x']]);            // before the period: left out
  assert.deepEqual(g.payments.map((p) => [p.amount, p.tds, p.shortage]), [[500, 5, 10]]);
  assert.equal(bulkRows(g).closing, 1000 + 900 - 515);
  const r = await store.account('alpha', null, '2026-04-01', '2026-04-30');
  assert.deepEqual([r.kind, r.customer.name, r.customer.opening, r.sales.length, r.payments.length, r.first], ['retail', 'Alpha', 0, 1, 1, '2026-04-05']);
  await assert.rejects(store.account('nobody', null, '2026-04-01', '2026-04-30'), /No customer/);
  await assert.rejects(store.account(null, 'Nope_Bulk'), /No bulk ledger/);
});
