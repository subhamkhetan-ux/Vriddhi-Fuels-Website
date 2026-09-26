// Phase 3 rules: Daily Screenshots (Module1), Monthly Export (Module2) and
// Custom Date Report (Module6), plus their drawings. All names are made up.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  billRows, buildStatements, dailySummary, defaultMonth, firstWord, general, indAuto, ledgerRows, monthEnd,
  monthLabel, rupeeAuto, shortNames,
} from '../../ledger/js/statements.js';
import { billStatementSvgs, dailySummarySvg, ledgerSvg } from '../../ledger/js/statement-svg.js';

let id = 0;
const sale = (product, date, key, qty, rate, extra = {}) => {
  id += 1;
  return { id, product, bill_no: String(3300 + id), sale_date: date, vehicle: 'od16l4127', qty, rate,
    amount: Math.round(qty * rate * 100) / 100, customer: extra.customer || key.replace(/\b\w/g, (c) => c.toUpperCase()), key, item: '', seq: id, ...extra };
};

test('numbers and names', () => {
  assert.equal(indAuto(191740), '1,91,740');
  assert.equal(indAuto(56118.4), '56,118.40');
  assert.equal(indAuto(12), '12');
  assert.equal(indAuto(1786.77), '1,786.77');
  assert.equal(rupeeAuto(0.4), '₹0.40');
  assert.equal(rupeeAuto(3354069.47), '₹33,54,069.47');
  assert.equal(rupeeAuto(-22448.46), '-₹22,448.46');
  assert.equal(general(122468.61), '122468.61');
  assert.equal(general(0.1 + 0.2), '0.3');
  assert.equal(general(1791000), '1791000');
  assert.equal(firstWord('M/s Shree Balajee Enterprises'), 'M-s');
  assert.equal(firstWord('Steels and Carriers Private Limited'), 'Steels');
  assert.deepEqual(shortNames(['Keshav Minerals', 'Steels and Carriers', 'Steels Mart', 'Radhe']),
    ['Keshav', 'Steels and', 'Steels Mart', 'Radhe']);
  assert.deepEqual(shortNames(['Same Co', 'Same Co']), ['Same Co', 'Same Co (2)']);
  assert.equal(monthLabel('2026-09-05'), 'September-2026');
  assert.equal(monthEnd('2026-02-10'), '2026-02-28');
  assert.equal(defaultMonth('2026-10-01'), '2026-09-01');       // on the 1st: last month
  assert.equal(defaultMonth('2026-10-02'), '2026-10-01');
});

test('ledger rows: per day and fuel, payment-only days, other sales, running balance', () => {
  const sales = [
    sale('HSD', '2026-09-01', 'k', 100, 100),
    sale('MS', '2026-09-01', 'k', 2.75, 109.09),
    sale('HSD', '2026-09-01', 'k', 50, 102),                     // same day + fuel -> summed, price averaged
    sale('OTHER', '2026-09-03', 'k', 1, 450, { item: 'Engine oil' }),
    sale('XG', '2026-09-03', 'k', 10, 95),
  ];
  const payments = [
    { pay_date: '2026-09-01', key: 'k', amount: 5000 }, { pay_date: '2026-09-01', key: 'k', amount: 1000 },
    { pay_date: '2026-09-02', key: 'k', amount: 700 },
  ];
  const led = ledgerRows({ opening: 10000.4, from: '2026-09-01', sales, payments });
  assert.deepEqual(led.rows.map((r) => [r.date, r.showDate, r.label, r.qty, r.amount, r.paid, r.balance]), [
    ['2026-09-01', false, 'DIESEL', 150, 15100, 6000, 19100.4],     // same date as the opening row: hidden
    ['2026-09-01', false, 'PETROL', 2.75, 300, 0, 19400.4],
    ['2026-09-02', true, '', 0, 0, 700, 18700.4],
    ['2026-09-03', true, 'XtraGreen', 10, 950, 0, 19650.4],
    ['2026-09-03', false, 'Engine oil', 1, 450, 0, 20100.4],
  ]);
  assert.equal(led.rows[0].rate, 101);
  assert.equal(led.rows[1].petrol, true);
  assert.deepEqual(led.totals, { qty: 163.75, amount: 16800, paid: 6700 });
  assert.equal(led.closing, 20100.4);
});

test('bill statement rows: by date, diesel before petrol, other items by name', () => {
  const res = billRows([
    sale('MS', '2026-09-25', 'k', 11.74, 109.01, { bill_no: 'MS573' }),
    sale('HSD', '2026-09-25', 'k', 49.64, 100.74),
    sale('OTHER', '2026-09-24', 'k', 1, 450, { item: 'Engine oil', vehicle: '' }),
  ]);
  assert.deepEqual(res.rows.map((r) => [r.showDate, r.product, r.vehicle]), [
    [true, 'Engine oil', ''], [true, 'Diesel', 'OD16L4127'], [false, 'Petrol', 'OD16L4127']]);
  assert.equal(res.totals.amount, 6730.51);
});

test('daily summary: customers in sheet order, one row each', () => {
  const sales = [
    sale('HSD', '2026-09-25', 'b', 10, 100, { customer: 'Beta Co' }),
    sale('HSD', '2026-09-25', 'a', 5, 100, { customer: 'Alpha Co' }),
    sale('HSD', '2026-09-25', 'b', 2, 100, { customer: 'beta co ' }),
    sale('HSD', '2026-09-25', '', 1, 100, { customer: '' }),
    sale('HSD', '2026-09-24', 'a', 7, 100, { customer: 'Alpha Co' }),
    sale('MS', '2026-09-25', 'a', 3, 100, { customer: 'Alpha Co' }),
  ];
  const d = dailySummary(sales, 'HSD', '2026-09-25');
  assert.deepEqual(d.rows, [{ name: 'Beta Co', amount: 1200, qty: 12 }, { name: 'Alpha Co', amount: 500, qty: 5 }, { name: '(blank)', amount: 100, qty: 1 }]);
  assert.equal(d.amount, 1800);
});

const DATA = () => {
  id = 0;
  return {
    customers: [
      { name: 'Keshav Minerals', key: 'keshav minerals', ledger: 'Keshav', title: '', bill_address: 'Rourkela.', gstin: '21AAAAA0000A1Z1', opening: 191740.4 },
      { name: 'Radhe Mining', key: 'radhe mining', ledger: 'Radhe', title: 'Radhe Mining (Main)', bill_address: '', gstin: '', opening: 0 },
      { name: 'Lube Buyer', key: 'lube buyer', ledger: 'Lube', title: '', bill_address: '', gstin: '', opening: 50 },
    ],
    sales: [
      sale('HSD', '2026-09-07', 'keshav minerals', 516.18, 100.74),
      sale('HSD', '2026-09-25', 'keshav minerals', 258.1, 100.74),
      sale('MS', '2026-09-24', 'radhe mining', 11.74, 109.01),
      sale('OTHER', '2026-09-25', 'lube buyer', 1, 450, { item: 'Grease' }),
      sale('HSD', '2026-09-25', 'bulk co', 18000, 99.5, { customer: 'Bulk Co' }),   // no ledger: summary only
    ],
    payments: [{ pay_date: '2026-09-05', key: 'keshav minerals', amount: 191740 }],
  };
};

test('daily: anyone who bought that day (Other too), ledger month to date, that day\'s bills', () => {
  const res = buildStatements({ kind: 'daily', date: '2026-09-25', data: DATA() });
  assert.deepEqual(res.customers.map((c) => [c.ledgerFile, c.billFile]), [
    ['Keshav Ledger 25-09-2026', 'Keshav Bill 25-09-2026'], ['Lube Ledger 25-09-2026', 'Lube Bill 25-09-2026']]);
  const k = res.customers[0];
  assert.equal(k.ledger.title, 'Keshav Minerals');
  assert.equal(k.ledger.period, 'for The Month of  September-2026');
  assert.equal(k.ledger.rows.length, 3);
  assert.equal(k.ledger.closing, 78001.36);          // 0.40 + 51,999.97 + 26,000.99
  assert.deepEqual(k.bills.rows.map((r) => r.date), ['2026-09-25']);
  assert.equal(k.bills.from, '2026-09-25');
  assert.equal(k.ledger.total, false);
  assert.deepEqual(res.summaries.map((s) => [s.file, s.rows.map((r) => r.name)]), [
    ['HSD Daily 25-09-2026', ['Keshav Minerals', 'Bulk Co']]]);
  assert.equal(res.folder, 'Daily_Snapshot_250926');
});

test('monthly and custom: fuel buyers only, totals, filter, file labels', () => {
  const m = buildStatements({ kind: 'monthly', from: '2026-09-01', to: '2026-09-30', data: DATA() });
  assert.deepEqual(m.customers.map((c) => c.ledgerFile), ['Keshav Ledger September-2026', 'Radhe Ledger September-2026']);
  assert.equal(m.customers[1].ledger.title, 'Radhe Mining (Main)');
  assert.equal(m.customers[0].bills.rows.length, 2);
  assert.equal(m.customers[0].ledger.total, true);
  assert.deepEqual(m.summaries, []);
  const c = buildStatements({ kind: 'custom', from: '2026-09-20', to: '2026-09-25', data: DATA(), filter: 'RADHE' });
  assert.deepEqual(c.customers.map((x) => x.billFile), ['Radhe Bill 20-09-2026 to 25-09-2026']);
  const span = buildStatements({ kind: 'custom', from: '2026-08-20', to: '2026-09-25', data: DATA() });
  assert.equal(span.customers[0].ledger.period, 'for 20/08/2026 to 25/09/2026');
});

test('statement drawings', () => {
  const res = buildStatements({ kind: 'monthly', from: '2026-09-01', to: '2026-09-30', data: DATA() });
  const k = res.customers[0];
  const img = { logo: 'data:image/png;base64,AA', letterhead: 'data:image/png;base64,BB', stamp: 'data:image/png;base64,CC' };
  const led = ledgerSvg(k.ledger, img);
  for (const want of ['Keshav Minerals', 'Ledger Account for Diesel', 'September-2026', '01/09/26', '₹1,91,740.40',
    '1,91,740', 'DIESEL', '100.74', 'TOTAL', 'base64,AA', 'base64,CC']) assert.ok(led.includes(want), want);
  const bills = billStatementSvgs(k.bills, img);
  assert.equal(bills.length, 1);
  for (const want of ['Bill To', 'Rourkela.', 'GSTIN:21AAAAA0000A1Z1', '01/09/2026', '30/09/2026', 'Price/Ltr',
    '07/09/2026', 'OD16L4127', '₹51999.97', 'TOTAL', 'base64,BB']) assert.ok(bills[0].includes(want), want);
  // long months: more pages, the header on each
  const many = { ...k.bills, rows: Array.from({ length: 60 }, (_, i) => ({ ...k.bills.rows[0], showDate: true, bill_no: String(i) })) };
  const pages = billStatementSvgs(many, img);
  assert.equal(pages.length, 3);
  assert.ok(pages.every((p) => p.includes('Price/Ltr') && p.includes('base64,CC')));
  assert.ok(pages[2].includes('TOTAL') && !pages[0].includes('TOTAL'));
  assert.ok(billStatementSvgs({ ...k.bills, rows: [] }, {})[0].includes('No bills in range'));
  // daily: one page, shrunk to fit when long
  const daily = billStatementSvgs({ ...many, total: false }, img);
  assert.equal(daily.length, 1);
  assert.ok(daily[0].includes('scale('));
  const d = buildStatements({ kind: 'daily', date: '2026-09-25', data: DATA() });
  const sum = dailySummarySvg(d.summaries[0], img);
  for (const want of ['HSD Daily Sales Summary', 'Sum of Amount', '25/09/26', 'Bulk Co', '1791000']) assert.ok(sum.includes(want), want);
  assert.ok(!ledgerSvg(k.ledger, {}).includes('<image'));
});
