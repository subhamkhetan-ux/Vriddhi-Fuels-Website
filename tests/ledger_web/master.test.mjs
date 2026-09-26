// Reading the Master Ledger (see fixtures.mjs for the made-up workbook).
import assert from 'node:assert/strict';
import test from 'node:test';

import { extractMaster, sheetsToRead } from '../../ledger/js/master.js';
import { demoWorkbook } from './fixtures.mjs';
import { formula } from './sheets.mjs';

test('picks only the sheets it needs', () => {
  assert.deepEqual(sheetsToRead(demoWorkbook().SheetNames), ['Tanker Master', 'HSD Bill', 'Master Paid', 'Outstanding', 'Demo_Bulk',
    'Twin_Bulk', 'Crew_Bulk', 'HSD Sale', 'MS Sale', 'XG Sale', 'Other Sale', 'Customer GST', 'Roadways']);
});

test('reads sales, payments, customers, bulk ledgers and PO lists', () => {
  const { payload, preview, warnings } = extractMaster(demoWorkbook());

  const bills = Object.fromEntries(payload.sales.map((s) => [`${s.product} ${s.bill_no}`, s]));
  assert.deepEqual(Object.keys(bills).sort(), ['HSD 1', 'HSD 2', 'HSD 3', 'HSD 4', 'HSD 5', 'HSD 6', 'HSD 7',
    'HSD 8', 'MS 1', 'OTHER LUBE/001', 'XG XG1', 'XG XG2']);
  assert.deepEqual([bills['XG XG2'].po_mode, bills['XG XG2'].po_fixed], ['fixed', 'PO-B']);   // typed on the Bulk sheet
  assert.equal(bills['HSD 3'].vehicle, 'OD01A3333');                  // first row wins
  assert.deepEqual(bills['HSD 1'], {
    product: 'HSD', bill_no: '1', sale_date: '2026-04-01', vehicle: 'OD01A1111', qty: 600, rate: 90,
    amount: 54000, customer: 'Demo Power Ltd', item: '', seq: 2, unit: '', po_mode: 'fixed',
    po_fixed: 'OLD-PO', tds: null, shortage: null, remarks: '',
  });
  assert.equal(bills['HSD 3'].po_mode, 'auto');
  assert.equal(bills['HSD 2'].unit, 'UNIT 1');
  assert.equal(bills['HSD 7'].unit, 'UNIT 2');
  assert.equal(bills['HSD 8'].unit, '');
  assert.equal(bills['HSD 4'].tds, 20);                               // from the group ledger
  assert.equal(bills['OTHER LUBE/001'].item, 'Engine oil');

  assert.deepEqual(payload.payments, [
    { pay_date: '2026-04-05', customer: 'Demo Power Ltd', amount: 50000, mode: 'HDFC 1010', seq: 2, tds: 1000, shortage: null, remarks: '' },
    { pay_date: '2026-04-05', customer: 'Demo Power Ltd', amount: 10000, mode: 'Cash', seq: 3, tds: null, shortage: null, remarks: 'cash' },
    { pay_date: '2026-04-06', customer: 'Twin Steel Ltd', amount: 20000, mode: '', seq: 4, tds: null, shortage: 50, remarks: '' },
  ]);

  const groups = Object.fromEntries(payload.groups.map((g) => [g.code, g]));
  assert.deepEqual(groups.Demo_Bulk, {
    code: 'Demo_Bulk', title: 'Demo Power — Bulk Ledger — Diesel (FY 2026-27)', kind: 'po', units: [],
    period_from: '2026-04-01', opening: 1000, opening_by_unit: {},
  });
  assert.deepEqual([groups.Twin_Bulk.kind, groups.Twin_Bulk.units, groups.Twin_Bulk.opening,
    groups.Twin_Bulk.opening_by_unit], ['po_units', ['UNIT 1', 'UNIT 2'], 300, { 'UNIT 1': 100, 'UNIT 2': 200 }]);
  assert.deepEqual([groups.Crew_Bulk.kind, groups.Crew_Bulk.period_from], ['group', '2026-04-01']);

  assert.deepEqual(payload.pos, [
    { group_code: 'Demo_Bulk', unit: '', po_no: 'PO-A', allotted: 700, seq: 1 },
    { group_code: 'Demo_Bulk', unit: '', po_no: 'PO-B', allotted: 1000, seq: 2 },
    { group_code: 'Twin_Bulk', unit: 'UNIT 1', po_no: 'T1-A', allotted: 1000, seq: 1 },
    { group_code: 'Twin_Bulk', unit: 'UNIT 2', po_no: 'T2-A', allotted: 250, seq: 1 },
    { group_code: 'Twin_Bulk', unit: 'UNIT 2', po_no: 'T2-B', allotted: 500, seq: 2 },
  ]);

  const customers = Object.fromEntries(payload.customers.map((c) => [c.name, c]));
  assert.deepEqual(customers['Retail Roadways'], { name: 'Retail Roadways', ledger: 'Roadways', gstin: '21BBBBB1111B1Z6',
    title: 'Retail Roadways (Demo)', bill_address: 'Testpur.',
    layout: {
      cols: [12.16, 14.16, 10, 19.83, 17.16, 14.5, 18.5],
      bill: [0.33, 12.66, 12.5, 16.16, 13.16, 11.66, 15.5, 13.83],
      head: 21.75, row: 20, rows: [20, 20, 24],
    } });
  assert.deepEqual(customers['Demo Power Ltd'], { name: 'Demo Power Ltd', gstin: '22AAAAA0000A1Z5', bulk_group: 'Demo_Bulk' });
  assert.equal(customers['Crew Two Movers'].bulk_group, 'Crew_Bulk');    // from Customer GST column G
  assert.equal(customers['Crew One Logistics'].bulk_group, 'Crew_Bulk');
  assert.equal(customers['Twin Steel Ltd'].bulk_group, 'Twin_Bulk');

  assert.deepEqual(payload.opening, [
    { customer: 'Retail Roadways', month: '2026-04-01', amount: 2500 },
    { customer: 'Old Customer', month: '2026-04-01', amount: 100 },
  ]);

  // The app's PO rule gives the same POs Excel shows.
  const checks = Object.fromEntries(preview.groups.filter((g) => g.check).map((g) => [g.code, g.check]));
  assert.deepEqual(checks.Demo_Bulk, { code: 'Demo_Bulk', compared: 2, matched: 2, mismatches: [] });
  assert.deepEqual(checks.Twin_Bulk, { code: 'Twin_Bulk', compared: 3, matched: 3, mismatches: [] });
  assert.deepEqual(preview.sales.HSD, { count: 8, from: '2026-04-01', to: '2026-04-04' });
  assert.equal(preview.payments.total, 80000);

  assert.deepEqual(payload.tanker, [
    { company: 'Demo Power Ltd', hsd_rate: 90.5, address: ['At- Demo', 'Testpur', 'GSTIN: 00AAAAA0000A0Z0'],
      payment: ['Payment Details:', 'Account No. – 0000', '', '', ''], po_label: 'P.O. No.:', po_no: '', price_tier: 'Bulk' },
    { company: 'Twin Steel Ltd, UNIT I', hsd_rate: 90, address: ['Unit I', '', ''], payment: ['', '', '', '', ''],
      po_label: '', po_no: '', price_tier: 'Bulk' },
  ]);
  assert.deepEqual(payload.settings, { slip_header: { title: 'CREDIT MEMO', mobile: 'Mob : 00000',
    lines: ['DEMO FUELS (2026-27)', 'AT- SAMPLE', 'DIST- DEMO', 'E-Mail : demo@example.com'] } });
  assert.equal(preview.tanker, 2);

  assert.equal(warnings.length, 3, warnings.join('\n'));
  assert.match(warnings.join('\n'), /HSD Sale: 1 row\(s\) with a bill number but no date/);
  assert.match(warnings.join('\n'), /1 bill number\(s\) appear twice.*HSD bill 3/);
  assert.match(warnings.join('\n'), /Master Paid: 1 row\(s\) missing/);
});

test('reports POs that differ from Excel', () => {
  const wb = demoWorkbook();
  wb.Sheets.Demo_Bulk.K8 = formula('PO-A', 'LET(1)');       // Excel says PO-A, the rule says PO-B
  const { preview } = extractMaster(wb);
  const check = preview.groups.find((g) => g.code === 'Demo_Bulk').check;
  assert.equal(check.matched, 1);
  assert.deepEqual(check.mismatches, [{ date: '2026-04-03', bill_no: '6', excel: 'PO-A', app: 'PO-B' }]);
});

test('refuses a workbook that is not the Master Ledger', () => {
  const wb = demoWorkbook();
  delete wb.Sheets['HSD Sale'];
  wb.SheetNames = wb.SheetNames.filter((n) => n !== 'HSD Sale');
  assert.throws(() => extractMaster(wb), /doesn't look like the Master Ledger: no "HSD Sale" sheet/);

  const moved = demoWorkbook();
  moved.Sheets['MS Sale'].D1 = { t: 's', v: 'Litres' };
  assert.throws(() => extractMaster(moved), /"MS Sale" sheet isn't laid out as expected \(D1 should say "Quantity"/);
});
