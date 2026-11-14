// A bulk customer's litres by billing price.
import assert from 'node:assert/strict';
import test from 'node:test';

import { qtyByRate, qtyByRateSheet } from '../../ledger/js/qty-rate.js';

const sales = [
  { sale_date: '2026-10-02', product: 'HSD', qty: 12000, rate: 89.5, amount: 1074000, unit: 'UNIT I' },
  { sale_date: '2026-10-05', product: 'HSD', qty: 9000, rate: 89.5, amount: 805500, unit: 'UNIT II' },
  { sale_date: '2026-10-20', product: 'HSD', qty: 12000, rate: 88.75, amount: 1065000, unit: 'UNIT I' },
  { sale_date: '2026-11-03', product: 'HSD', qty: 12000, rate: 88.75, amount: 1065000, unit: 'UNIT I' },
  { sale_date: '2026-11-04', product: 'MS', qty: 200, rate: 101.2, amount: 20240, unit: null },
  { sale_date: '2026-11-05', product: 'HSD', qty: 0, rate: 88.75, amount: 0, unit: 'UNIT I' },   // a cancelled bill: left out
];

test('litres by billing price: each product, its prices (highest first), totals', () => {
  const r = qtyByRate(sales);
  assert.deepEqual([r.from, r.to, r.qty, r.bills, r.amount], ['2026-10-02', '2026-11-04', 45200, 5, 4029740]);
  assert.deepEqual(r.products.map((p) => p.product), ['HSD', 'MS']);
  const hsd = r.products[0];
  assert.deepEqual([hsd.qty, hsd.bills, hsd.amount, hsd.avg], [45000, 4, 4009500, 89.1]);
  assert.deepEqual(hsd.rates.map((x) => [x.rate, x.qty, x.bills, x.first, x.last]),
    [[89.5, 21000, 2, '2026-10-02', '2026-10-05'], [88.75, 24000, 2, '2026-10-20', '2026-11-03']]);
  assert.equal(Math.round(hsd.rates[0].share * 1000) / 1000, 0.467);
});

test('litres by billing price: a period, a unit', () => {
  const oct = qtyByRate(sales, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(oct.products[0].rates.map((x) => [x.rate, x.qty]), [[89.5, 21000], [88.75, 12000]]);
  assert.equal(oct.products.length, 1);
  const u1 = qtyByRate(sales, { unit: 'UNIT I' });
  assert.deepEqual(u1.products[0].rates.map((x) => [x.rate, x.qty]), [[89.5, 12000], [88.75, 24000]]);
  assert.deepEqual(qtyByRate([], { from: '2026-10-01', to: '2026-10-31' }), { from: '2026-10-01', to: '2026-10-31', qty: 0, amount: 0, bills: 0, products: [] });
});

test('litres by billing price: the spreadsheet', () => {
  const rows = qtyByRateSheet(qtyByRate(sales), 'SMC Power — litres by billing price');
  assert.deepEqual(rows[3], ['Product', 'Billing price (₹/L)', 'Litres', 'Share of the product', 'Bills', 'Amount (₹)', 'First bill', 'Last bill']);
  assert.deepEqual(rows[4], ['HSD', 89.5, 21000, 46.67, 2, 1879500, '2026-10-02', '2026-10-05']);
  assert.deepEqual(rows[6], ['HSD total', 89.1, 45000, 100, 4, 4009500, '', '']);
  assert.deepEqual(rows[rows.length - 1], ['All products', '', 45200, '', 5, 4029740, '', '']);
});
