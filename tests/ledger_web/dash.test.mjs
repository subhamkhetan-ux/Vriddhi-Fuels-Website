// Home dashboard figures: Module14's margin rule, the RSP gap rule, roll-ups.
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyse, dayRsp, earningOf, periods, shortGroup } from '../../ledger/js/dash.js';
import { memoryStore } from '../../ledger/js/store.js';

test('earning = amount − litres × (day RSP − margin)', () => {
  // retail at RSP earns the full margin; bulk at a ₹1.50 discount earns 1.08/L
  assert.equal(Math.round(earningOf('HSD', 100, 100 * 90.52, 90.52) * 100) / 100, 258);
  assert.equal(Math.round(earningOf('HSD', 1000, 1000 * 89.02, 90.52) * 100) / 100, 1080);
  assert.equal(Math.round(earningOf('MS', 10, 10 * 101.18, 101.18) * 100) / 100, 40);
  assert.equal(Math.round(earningOf('XG', 10, 10 * 93.76, 93.76) * 100) / 100, 25.8);
  assert.equal(earningOf('OTHER', 1, 450, 90), null);
  assert.equal(earningOf('HSD', 1, 90, null), null);
});

test("day's RSP: highest price; gaps and discount-only days take equal neighbours", () => {
  const r = dayRsp([
    ['2026-09-01', 'HSD', 90.52], ['2026-09-02', 'HSD', 89.02],     // 02: only a bulk bill
    ['2026-09-03', 'HSD', 90.52], ['2026-09-05', 'HSD', 90.52],     // 04: no bills
    ['2026-09-06', 'HSD', 91.10], ['2026-09-08', 'HSD', 91.80],     // 07: neighbours differ
    ['2026-09-10', 'HSD', 91.00], ['2026-09-11', 'HSD', 92.00],     // 10: a real price cut
  ]);
  assert.equal(r.at('HSD', '2026-09-01'), 90.52);
  assert.equal(r.at('HSD', '2026-09-02'), 90.52);
  assert.equal(r.at('HSD', '2026-09-04'), 90.52);
  assert.equal(r.at('HSD', '2026-09-07'), null);
  assert.equal(r.at('HSD', '2026-09-10'), 91.00);
  assert.equal(r.at('MS', '2026-09-01'), null);
});

test('roll-ups: products, customers (bulk as groups), days, months, outstanding', () => {
  const data = {
    customers: [['a', 'Alpha Roadlines', 'Alpha', null], ['b1', 'Big Steel Unit', null, 'Big_Bulk'], ['b2', 'Big Steel Two', null, 'Big_Bulk']],
    groups: [['Big_Bulk', 'Big Steel — Bulk Ledger — Diesel']],
    rsp: [['2026-09-01', 'HSD', 90], ['2026-09-01', 'MS', 100], ['2026-09-02', 'HSD', 90]],
    sales: [
      ['2026-09-01', 'HSD', 'a', 100, 9000, 2], ['2026-09-01', 'MS', 'a', 10, 1000, 1],
      ['2026-09-01', 'HSD', 'b1', 1000, 89000, 1], ['2026-09-02', 'HSD', 'b2', 500, 44500, 1],
      ['2026-09-02', 'OTHER', 'a', 1, 450, 1], ['2026-08-31', 'HSD', 'a', 5, 450, 1],
    ],
    payments: [['2026-09-02', 'a', 5000], ['2026-09-02', 'b1', 100000]],
    outstanding: [['g', 'Big_Bulk', 40000], ['c', 'a', 5450], ['c', 'z', -200], ['c', 'y', 0.4]],
  };
  const r = analyse(data, { from: '2026-09-01', to: '2026-09-03' });
  // earnings: a HSD 258 + a MS 40 + b1 (2.58-1)*1000 = 1580 + b2 790
  assert.equal(r.kpi.earning, 258 + 40 + 1580 + 790);
  assert.equal(r.kpi.qty, 1610);
  assert.equal(r.kpi.amount, 9000 + 1000 + 89000 + 44500 + 450);
  assert.equal(r.kpi.collections, 105000);
  assert.deepEqual(r.customers.map((c) => [c.name, c.kind, c.qty, Math.round(c.earning)]), [
    ['Big Steel', 'bulk', 1500, 2370], ['Alpha Roadlines', 'retail', 110, 298]]);
  assert.equal(r.customers[1].products.OTHER.amount, 450);
  assert.deepEqual(r.daily.map((d) => d.qty.HSD), [1100, 500, 0]);
  assert.deepEqual(r.outstanding.map((o) => [o.name, o.balance]), [['Big Steel', 40000], ['Alpha Roadlines', 5450], ['z', -200]]);
  assert.deepEqual([r.kpi.outstanding, r.kpi.advance], [45450, -200]);
  assert.equal(r.customers[0].outstanding, 40000);
  assert.deepEqual(r.segments.bulk, { qty: 1500, amount: 133500, earning: 2370 });
  assert.equal(r.products.HSD.earning, 258 + 1580 + 790);
  assert.equal(r.kpi.perLitre, Math.round((2668 / 1610) * 100) / 100);
  assert.equal(shortGroup('X_Bulk', ''), 'X');
});

test('periods: this month, last month, FY (April start)', () => {
  const p = periods('2026-04-10');
  assert.deepEqual([p.month.from, p.last.from, p.last.to, p.fy.from, p.earliest], ['2026-04-01', '2026-03-01', '2026-03-31', '2026-04-01', '2026-03-01']);
  assert.equal(periods('2027-01-15').fy.from, '2026-04-01');
});

test('demo store dashboard: same shape as the SQL, bulk groups owe opening + sales − paid − TDS − shortage', async () => {
  const store = memoryStore({});
  await store.importMaster('ML.xlsm', {
    groups: [{ code: 'Big_Bulk', title: 'Big — Bulk', kind: 'group', period_from: '2026-04-01', opening: 1000 }],
    customers: [{ name: 'Big One', bulk_group: 'Big_Bulk' }, { name: 'Alpha', ledger: 'Alpha' }],
    sales: [{ product: 'HSD', bill_no: '1', sale_date: '2026-04-02', qty: 10, rate: 90, amount: 900, customer: 'Big One', seq: 2 },
      { product: 'HSD', bill_no: '2', sale_date: '2026-04-02', qty: 1, rate: 91, amount: 91, customer: 'Alpha', seq: 3 }],
    payments: [{ pay_date: '2026-04-03', customer: 'Big One', amount: 500, tds: 5, shortage: 10, seq: 2 }],
  });
  const d = await store.dashboard('2026-04-01', '2026-04-30');
  assert.deepEqual(d.sales.map((x) => x.slice(0, 5)), [['2026-04-02', 'HSD', 'big one', 10, 900], ['2026-04-02', 'HSD', 'alpha', 1, 91]]);
  assert.deepEqual(d.rsp, [['2026-04-02', 'HSD', 91]]);
  assert.deepEqual(d.outstanding.find((o) => o[0] === 'g'), ['g', 'Big_Bulk', 1000 + 900 - 515]);
  assert.deepEqual(d.outstanding.find((o) => o[1] === 'alpha'), ['c', 'alpha', 91]);
});
