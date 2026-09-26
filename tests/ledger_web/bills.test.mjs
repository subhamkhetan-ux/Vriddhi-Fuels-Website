// Phase 2 rules: Daily Tanker Bill bundles (Module8) and fuel-slip PDFs
// (Module7), plus the bill drawings. Customer names here are made up, apart
// from the group prefixes the macro itself looks for.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bundleInfo, firstNWords, normalizeCompany, resolveCustomer, slipBundles, tankerBundles,
} from '../../ledger/js/bills.js';
import { inr, inr2, money2, slipSvg, tankerBillSvg } from '../../ledger/js/render.js';

const TANKER = [
  { company: 'Demo Power Ltd', address: ['At- Demo', 'Testpur', 'GSTIN: X'], payment: ['Payment Details:', 'A/c 1'] },
  { company: 'SMC Power Generation LTD, UNIT I', address: [], payment: [] },
  { company: 'SMC Power Generation LTD, UNIT II', address: [], payment: [] },
  { company: 'Orissa Metaliks Private Limited', address: [], payment: [] },
  { company: 'Shyam Metalics and Energy Ltd', address: [], payment: [] },
  { company: 'Babylon Logistics PVT LTD', address: [], payment: [] },
  { company: 'Demo Power Traders', address: [], payment: [] },
];
const names = TANKER.map((t) => t.company);

test('Tanker Master match: same name, or name + unit', () => {
  assert.equal(resolveCustomer('demo power ltd ', '', names), 'Demo Power Ltd');
  // "M/s", punctuation and case are ignored when the unit is added
  assert.equal(resolveCustomer('M/s Smc Power Generation Ltd.', 'UNIT 1', names), 'SMC Power Generation LTD, UNIT I');
  assert.equal(resolveCustomer('SMC Power Generation LTD', 'UNIT 2', names), 'SMC Power Generation LTD, UNIT II');
  assert.equal(resolveCustomer('SMC Power Generation LTD', 'unit ii', names), 'SMC Power Generation LTD, UNIT II');
  assert.equal(resolveCustomer('SMC Power Generation LTD', '', names), '');
  assert.equal(resolveCustomer('Unknown Movers', 'UNIT 1', names), '');
});

test('bundles: groups by day, everyone else per customer per day', () => {
  const lak = new Set([normalizeCompany('Babylon Logistics Private Limited')]);
  const at = (name, unit = '') => bundleInfo(name, unit, '2026-09-05', lak);
  assert.equal(at('Babylon Logistics PVT LTD').fileBase, 'ESM 05 September');
  assert.equal(at('SMC Power Generation LTD, UNIT II').fileBase, 'SMC Unit 2 05 September');
  assert.equal(at('SMC Power Generation LTD, UNIT I', 'UNIT 1').fileBase, 'SMC Unit 1 05 September');
  assert.equal(at('Orissa Metaliks Private Limited').fileBase, 'OMPL 05 September');
  assert.equal(at('Shyam Metalics and Energy Ltd').fileBase, 'SMEL 05 September');
  assert.equal(at('M/s Demo Power Ltd').fileBase, 'Demo Power 05 September');
  assert.equal(at('M/s Demo Power Ltd').group, false);
  assert.equal(firstNWords('A/B Co: Ltd', 2), 'A-B Co-');
});

test('Daily Tanker Bill: bundles, file names, POs and skipped customers', () => {
  const s = (id, date, customer, extra = {}) => ({ id, product: 'HSD', bill_no: String(id), sale_date: date, customer, qty: 1000, rate: 90, amount: 90000, seq: id, ...extra });
  const sales = [
    s(1, '2026-09-05', 'Demo Power Ltd'),
    s(2, '2026-09-05', 'Demo Power Traders'),                 // same first two words -> longer name
    s(3, '2026-09-05', 'SMC Power Generation LTD', { unit: 'UNIT 1' }),
    s(4, '2026-09-05', 'SMC Power Generation LTD', { unit: 'UNIT 1' }),
    s(5, '2026-09-06', 'SMC Power Generation LTD', { unit: 'UNIT 2' }),
    s(6, '2026-09-05', 'Walk In Cash'),
    s(7, '2026-09-05', 'Walk In Cash'),
    s(8, '2026-09-07', 'Demo Power Ltd'),                     // outside the range
    { ...s(9, '2026-09-05', 'Demo Power Ltd'), product: 'MS' }, // tanker bills are HSD only
  ];
  const res = tankerBundles({ sales, tanker: TANKER, poOf: (b) => (b.id === 3 ? 'PO-77' : ''), from: '2026-09-05', to: '2026-09-06' });
  assert.equal(res.inRange, 7);
  assert.equal(res.bills, 5);
  assert.deepEqual(res.skipped, [{ customer: 'Walk In Cash', count: 2 }]);
  assert.deepEqual(res.bundles.map((b) => [b.fileName, b.bills.map((x) => x.id)]), [
    ['Demo Power 05 September.pdf', [1]],                     // only the later clash grows
    ['Demo Power Traders 05 September.pdf', [2]],
    ['SMC Unit 1 05 September.pdf', [3, 4]],
    ['SMC Unit 2 06 September.pdf', [5]],
  ]);
  assert.equal(res.bundles[2].bills[0].po, 'PO-77');
  assert.equal(res.bundles[0].bills[0].company.address[0], 'At- Demo');
  const only = tankerBundles({ sales, tanker: TANKER, poOf: () => '', from: '2026-09-05', to: '2026-09-06', filter: 'traders' });
  assert.deepEqual(only.bundles.map((b) => b.fileName), ['Demo Power 05 September.pdf']);
});

test('Print Bills: one PDF per customer, diesel then petrol then XtraGreen', () => {
  const s = (id, product, customer, extra = {}) => ({ id, product, bill_no: `B${id}`, sale_date: '2026-09-05', customer, qty: 10, rate: 90, amount: 900, seq: id, ...extra });
  const sales = [
    s(1, 'XG', 'Demo Power Ltd'), s(2, 'HSD', 'demo power ltd'), s(3, 'MS', 'Sample Roadlines'),
    s(4, 'HSD', 'Sample Roadlines'), s(5, 'OTHER', 'Demo Power Ltd'), s(6, 'HSD', ''),
    s(7, 'HSD', 'Late Co', { sale_date: '2026-09-06' }),
  ];
  const res = slipBundles({ sales, from: '2026-09-05', to: '2026-09-05' });
  assert.equal(res.folder, 'Fuel Bills 05-09-2026 to 05-09-2026');
  assert.deepEqual(res.bundles.map((b) => [b.fileName, b.bills.map((x) => x.id)]), [
    ['demo power ltd Slips 05-09-2026.pdf', [2, 1]],
    ['Sample Roadlines Slips 05-09-2026.pdf', [4, 3]],
    ['(No Customer) Slips 05-09-2026.pdf', [6]],
  ]);
  const one = slipBundles({ sales, from: '2026-09-05', to: '2026-09-06', filter: 'SAMPLE ROADLINES' });
  assert.deepEqual(one.bundles.map((b) => b.fileName), ['Sample Roadlines Slips 05-09-2026 to 06-09-2026.pdf']);
  assert.equal(slipBundles({ sales, from: '2026-09-05', to: '2026-09-05', filter: 'Sample' }).bills, 0);   // exact name
});

test('bill drawings', () => {
  assert.equal(inr(1234567.9), '12,34,567');
  assert.equal(money2(1234567.5), '1,234,567.50');
  const bill = { sale_date: '2026-09-05', bill_no: '1502', vehicle: 'od02b9863', qty: 3200, rate: 90.5, amount: 289600, po: 'PO<1>' };
  const svg = tankerBillSvg(bill, TANKER[0], { letterhead: 'assets/letterhead.png' });
  for (const want of ['05/09/26', '1502', 'OD02B9863', '3200', '90.50', '₹2,89,600', 'P.O. No.:', 'PO&lt;1&gt;', 'Density-', 'Seal No-', 'Demo Power Ltd', 'At- Demo', 'Payment Details:', 'High Speed Diesel']) {
    assert.ok(svg.includes(want), want);
  }
  const small = tankerBillSvg({ ...bill, qty: 3000, po: '' }, TANKER[0]);
  assert.ok(!small.includes('Density-') && !small.includes('P.O. No.:') && !small.includes('<image'));
  assert.equal(inr2(1791000), '17,91,000.00');
  assert.equal(inr2(122468.614), '1,22,468.61');
  assert.equal(inr2(16118.4), '16,118.40');
  const slip = slipSvg({ ...bill, product: 'XG', customer: 'Demo Power Ltd' }, { title: 'CREDIT MEMO', mobile: 'Mob : 1', lines: ['DEMO FUELS'] }, 'data:image/png;base64,AA');
  for (const want of ['CREDIT MEMO', 'Mob : 1', 'DEMO FUELS', '5-9-2026', 'XtraGreen Diesel', '3200.00 LTR', '90.50', '2,89,600.00', '₹ 2,89,600.00', "Customer&#39;s Sign.", 'data:image/png;base64,AA']) {
    assert.ok(slip.includes(want), want);
  }
  assert.ok(!slipSvg(bill, {}).includes('<image'));
});
