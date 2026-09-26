// The demo store must follow the same rules as the SQL functions: these are
// the scenarios of tests/test_ledger_schema.py, run against memoryStore().
import assert from 'node:assert/strict';
import test from 'node:test';

import { memoryStore } from '../../ledger/js/store.js';

function payload() {
  return {
    groups: [
      { code: 'Demo_Bulk', title: 'Demo Power — Bulk Ledger', kind: 'po', units: [], period_from: '2026-04-01', opening: 1000, opening_by_unit: {} },
      { code: 'Twin_Bulk', title: 'Twin Steel — Bulk Ledger', kind: 'po_units', units: ['UNIT 1', 'UNIT 2'], period_from: '2026-04-01', opening: 0, opening_by_unit: { 'UNIT 1': 0, 'UNIT 2': 0 } },
      { code: 'Crew_Bulk', title: 'Crew Group', kind: 'group', units: [], period_from: '2026-04-01', opening: 0, opening_by_unit: {} },
    ],
    customers: [
      { name: 'Demo Power Ltd', bulk_group: 'Demo_Bulk', gstin: '22AAAAA0000A1Z5' },
      { name: 'Twin Steel Ltd', bulk_group: 'Twin_Bulk' },
      { name: 'Crew One Logistics', bulk_group: 'Crew_Bulk' },
      { name: 'Retail Roadways', ledger: 'Roadways' },
    ],
    sales: [
      { product: 'HSD', bill_no: '1', sale_date: '2026-04-01', vehicle: 'OD01A1111', qty: 1000, rate: 90, amount: 90000, customer: 'Demo Power Ltd', seq: 2, po_mode: 'auto' },
      { product: 'HSD', bill_no: '2', sale_date: '2026-04-01', vehicle: 'OD01A2222', qty: 500, rate: 90, amount: 45000, customer: 'Twin Steel Ltd', seq: 3, unit: 'UNIT 1', po_mode: 'fixed', po_fixed: 'OLD-PO', tds: 12 },
      { product: 'HSD', bill_no: '3', sale_date: '2026-04-02', vehicle: 'OD01A3333', qty: 200, rate: 90, amount: 18000, customer: 'retail  roadways', seq: 4 },
      { product: 'MS', bill_no: '1', sale_date: '2026-04-01', vehicle: 'OD01B1111', qty: 10, rate: 100, amount: 1000, customer: 'Retail Roadways', seq: 2 },
      { product: 'OTHER', bill_no: 'LUBE/001', sale_date: '2026-04-03', amount: 700, customer: 'Lube Only Buyer', item: 'Engine oil', seq: 2 },
      { product: 'MS', bill_no: '2', sale_date: '2026-04-06', vehicle: 'OD01B2222', qty: 3, rate: 100, amount: 300, customer: 'Walk In Cash', seq: 3 },
      { product: 'HSD', bill_no: '3', sale_date: '2026-04-02', vehicle: 'DUP', qty: 1, rate: 1, amount: 1, customer: 'Retail Roadways', seq: 99 },
    ],
    payments: [
      { pay_date: '2026-04-05', customer: 'Demo Power Ltd', amount: 50000, mode: 'HDFC 1010', seq: 2 },
      { pay_date: '2026-04-06', customer: 'Payment Only Person', amount: 300, seq: 3 },
    ],
    pos: [
      { group_code: 'Demo_Bulk', unit: '', po_no: 'PO-A', allotted: 5000, seq: 1 },
      { group_code: 'Demo_Bulk', unit: '', po_no: 'PO-B', allotted: 3000, seq: 2 },
      { group_code: 'Twin_Bulk', unit: 'UNIT 1', po_no: 'T1-1', allotted: 800, seq: 1 },
      { group_code: 'Nope_Bulk', unit: '', po_no: 'X', allotted: 1, seq: 1 },
    ],
    opening: [{ customer: 'Retail Roadways', month: '2026-04-01', amount: 2500 }],
  };
}

test('memory store follows the SQL rules', async () => {
  const s = memoryStore();
  let res = await s.importMaster('Master Ledger.xlsm', payload());
  assert.deepEqual(res, {
    groups: 3, customers_new: 5, sales_new: 6, sales_updated: 0, payments: 2, pos_new: 3, opening: 1, tanker: 0, import_id: 1,
  });
  let custs = Object.fromEntries((await s.customers()).map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(custs), ['Crew One Logistics', 'Demo Power Ltd', 'Retail Roadways', 'Twin Steel Ltd', 'Walk In Cash']);
  assert.equal(custs['Retail Roadways'].ledger, 'Roadways');
  assert.equal(custs['Retail Roadways'].bills, 2);
  const summary = await s.summary();
  assert.equal(summary.sales.HSD.bills, 3);
  assert.equal(summary.needs_ledger, 1);

  // the app's own choices ...
  const demo = await s.poData('Demo_Bulk');
  await s.updateBill(demo.bills[0].id, { po_mode: 'fixed', po_fixed: 'APP-PO' });
  await s.updateCustomer(custs['Walk In Cash'].id, { ledger: 'Cash' });
  await s.savePo({ group_code: 'Demo_Bulk', po_no: 'APP-NEW', allotted: 100 });

  // ... survive a second upload
  const p = payload();
  Object.assign(p.sales[0], { qty: 1100, amount: 99000, po_mode: 'fixed', po_fixed: 'XL-PO' });
  Object.assign(p.sales[1], { unit: 'UNIT 2', tds: 15, remarks: 'short by 2 L' });
  p.customers.push({ name: 'Walk In Cash', ledger: 'Walkin' });
  p.payments = p.payments.slice(0, 1);
  p.pos[0].allotted = 9999;
  p.pos.push({ group_code: 'Demo_Bulk', unit: '', po_no: 'PO-C', allotted: 700, seq: 3 });
  p.opening[0].amount = 2600;
  res = await s.importMaster('Master Ledger v2.xlsm', p);
  assert.equal(res.sales_new, 0);
  assert.equal(res.sales_updated, 6);
  assert.equal(res.payments, 1);
  assert.equal(res.pos_new, 1);
  const data = await s.poData('Demo_Bulk');
  const b1 = data.bills.find((b) => b.bill_no === '1');
  assert.equal(b1.qty, 1100);
  assert.deepEqual([b1.po_mode, b1.po_fixed], ['fixed', 'APP-PO']);
  assert.deepEqual(data.pos.map((x) => [x.po_no, x.allotted]), [['PO-A', 5000], ['PO-B', 3000], ['APP-NEW', 100], ['PO-C', 700]]);
  custs = Object.fromEntries((await s.customers()).map((c) => [c.name, c]));
  assert.equal(custs['Walk In Cash'].ledger, 'Cash');

  // DayBook
  const rows = [
    { product: 'HSD', bill_no: '3', sale_date: '2026-04-02', vehicle: 'X', qty: 5, rate: 1, amount: 5, customer: 'Retail Roadways' },
    { product: 'HSD', bill_no: '4', sale_date: '2026-04-07', vehicle: 'OD02C4444', qty: 300, rate: 91, amount: 27300, customer: 'Demo Power Ltd' },
    { product: 'HSD', bill_no: '5', sale_date: '2026-04-07', vehicle: 'OD02C5555', qty: 50, rate: 91, amount: 4550, customer: 'Brand New Movers' },
    { product: 'XG', bill_no: 'XG1', sale_date: '2026-04-07', vehicle: '', qty: 20, rate: 95, amount: 1900, customer: 'Brand New Movers' },
    { product: 'HSD', bill_no: '4', sale_date: '2026-04-07', vehicle: 'again', qty: 1, rate: 1, amount: 1, customer: 'Demo Power Ltd' },
    { product: 'HSD', bill_no: '1', sale_date: '2027-04-01', vehicle: 'NEWFY', qty: 10, rate: 99, amount: 990, customer: 'Demo Power Ltd' },
    { product: 'BAD', bill_no: '9', sale_date: '2026-04-07', customer: 'x' },
  ];
  assert.deepEqual(await s.existingBills(rows), ['HSD|2026-27|3']);
  res = await s.importDaybook('DayBook 07-04-26.xlsx', rows);
  assert.deepEqual(res, {
    rows: 6, inserted: { HSD: 3, XG: 1 }, duplicates: 2, new_customers: ['Brand New Movers'], import_id: 3,
  });
  const day = await s.salesDay('2026-04-07');
  assert.deepEqual(day.bills.map((b) => [b.product, b.bill_no]), [['HSD', '4'], ['HSD', '5'], ['XG', 'XG1']]);
  assert.equal((await s.salesDay()).date, '2027-04-01');

  // PO editing
  await assert.rejects(s.savePo({ group_code: 'Demo_Bulk', po_no: 'po-a', allotted: 1 }), /already in this list/);
  const order = async () => (await s.poData('Demo_Bulk')).pos.map((x) => x.po_no);
  let list = (await s.poData('Demo_Bulk')).pos;
  await s.movePo(list[list.length - 1].id, -1);
  assert.deepEqual(await order(), ['PO-A', 'PO-B', 'PO-C', 'APP-NEW']);
  list = (await s.poData('Demo_Bulk')).pos;
  await s.deletePo(list[0].id);
  assert.deepEqual(await order(), ['PO-B', 'PO-C', 'APP-NEW']);

  // bills and customers
  const bill4 = (await s.poData('Demo_Bulk')).bills.find((b) => b.bill_no === '4');
  let upd = await s.updateBill(bill4.id, { unit: ' unit 2 ' });
  assert.deepEqual([upd.unit, upd.po_user_set], ['UNIT 2', false]);
  upd = await s.updateBill(bill4.id, { po_mode: 'auto' });
  assert.deepEqual([upd.po_mode, upd.po_fixed, upd.po_user_set], ['auto', '', true]);
  custs = Object.fromEntries((await s.customers()).map((c) => [c.name, c]));
  await assert.rejects(s.updateCustomer(custs['Brand New Movers'].id, { ledger: 'roadways' }), /already used by Retail Roadways/);
  upd = await s.updateCustomer(custs['Brand New Movers'].id, { ledger: 'Movers', archived: true });
  assert.deepEqual([upd.ledger, upd.archived], ['Movers', true]);
  assert.equal((await s.imports(1))[0].kind, 'daybook');
});
