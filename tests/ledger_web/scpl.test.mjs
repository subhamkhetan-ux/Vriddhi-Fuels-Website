// The SCPL bill (the workbook's modSCPLBilling macro in the app).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bestGuess, classify, indian, numStr, SCPL_TEMPLATE, scplBill, scplBillSvg, scplCustomers, scplDefaultRange,
  scplFileName, scplPeriods, tableCells,
} from '../../ledger/js/scpl.js';

const C = 'Steels and Carriers Private Limited';
const sale = (id, date, bill, vehicle, qty, rate = 90.5, extra = {}) => ({
  id, product: 'HSD', sale_date: date, bill_no: bill, vehicle, qty, rate, amount: Math.round(qty * rate * 100) / 100, customer: C, ...extra,
});

test('the period offered is the 10 days just gone, as AskDateRange', () => {
  assert.deepEqual(scplDefaultRange('2026-11-15'), { from: '2026-11-01', to: '2026-11-10' });
  assert.deepEqual(scplDefaultRange('2026-11-25'), { from: '2026-11-11', to: '2026-11-20' });
  assert.deepEqual(scplDefaultRange('2026-12-03'), { from: '2026-11-21', to: '2026-11-30' });
  assert.deepEqual(scplDefaultRange('2027-03-10'), { from: '2027-02-21', to: '2027-02-28' });
  assert.deepEqual(scplDefaultRange('2027-01-01'), { from: '2026-12-21', to: '2026-12-31' });
  assert.deepEqual(scplPeriods('2026-11-15', 4).map((r) => `${r.from}|${r.to}`),
    ['2026-11-01|2026-11-10', '2026-10-21|2026-10-31', '2026-10-11|2026-10-20', '2026-10-01|2026-10-10']);
});

test('Vehicle labels are read as the macro reads them', () => {
  assert.equal(classify('Transporting'), 'Transporting');
  assert.equal(classify(' consumer '), 'Consumer');
  assert.equal(classify('Transportng'), 'Transporting');
  assert.equal(classify('Cosumer'), 'Consumer');
  assert.equal(classify('Trans'), '');
  assert.equal(classify('OD23AB1234'), '');
  assert.equal(classify(''), '');
  assert.equal(bestGuess('consumr'), 'Consumer');
});

test('scplBill splits, sorts and totals; asks about labels it cannot read', () => {
  const sales = [
    sale(1, '2026-11-03', '10', 'Transporting', 1500),
    sale(2, '2026-11-03', '9', 'Transporting', 2000.5),
    sale(3, '2026-11-02', 'A7', 'Transportng', 1000),
    sale(4, '2026-11-05', '12', 'Consumer', 300),
    sale(5, '2026-11-06', '13', 'OD23AB1234', 400),
    sale(6, '2026-11-11', '20', 'Consumer', 999),                   // after the period
    sale(7, '2026-11-04', '11', 'Consumer', 50, 90.5, { customer: 'Someone Else' }),
    sale(8, '2026-11-04', '14', 'Consumer', 70, 100, { product: 'MS' }),
  ];
  const b = scplBill(sales, { from: '2026-11-01', to: '2026-11-10' });
  assert.deepEqual(b.pages.map((p) => p.cat), ['Transporting', 'Consumer']);
  assert.deepEqual(b.pages[0].rows.map((r) => r.bill_no), ['A7', '9', '10']);          // by date, then 9 before 10
  assert.equal(b.pages[0].qty, 4500.5);
  assert.equal(b.pages[1].rows.length, 1);
  assert.deepEqual(b.unread.map((r) => r.bill_no), ['13']);
  assert.deepEqual(b.guessed.map((g) => [g.bill_no, g.cat]), [['A7', 'Transporting']]);
  const fixed = scplBill(sales, { from: '2026-11-01', to: '2026-11-10', picked: { 5: 'Consumer' } });
  assert.equal(fixed.unread.length, 0);
  assert.deepEqual(fixed.pages[1].rows.map((r) => r.bill_no), ['12', '13']);
  const left = scplBill(sales, { from: '2026-11-01', to: '2026-11-10', picked: { 5: 'skip' } });
  assert.equal(left.skipped, 1);
  assert.equal(left.count, 4);
  assert.deepEqual(scplCustomers(sales), [C, 'Someone Else']);
});

test('the macro formats: Indian amounts with paise, quantities, rates', () => {
  assert.equal(indian(123456.8), '1,23,456.80');
  assert.equal(indian(1234567), '12,34,567');
  assert.equal(indian(999), '999');
  assert.equal(numStr(1500), '1500');
  assert.equal(numStr(2000.5), '2000.5');
  const b = scplBill([sale(1, '2026-11-03', '9', 'Consumer', 1500, 90.12)], { from: '2026-11-01', to: '2026-11-10' });
  const t = tableCells(b.pages[0]);
  assert.deepEqual(t.rows[0], ['03/11/26', '9', 'Consumer', '1500', '90.12', '1,35,180']);
  assert.deepEqual(t.total, ['', '', 'TOTAL', '1500.00', '', '₹1,35,180']);
});

test('file names as the macro files them', () => {
  assert.equal(scplFileName('2026-11-01', '2026-11-10'), 'SCPL Bill 1-10 Nov 2026');
  assert.equal(scplFileName('2026-10-21', '2026-11-03'), 'SCPL Bill 21 Oct-3 Nov 2026');
});

test('scplBillSvg: laid out as the template, a sheet per category, TOTAL and payment on the last', () => {
  const sales = [];
  for (let i = 0; i < 40; i++) sales.push(sale(i + 1, `2026-11-${String(1 + (i % 10)).padStart(2, '0')}`, String(100 + i), 'Transporting', 1000 + i));
  sales.push(sale(99, '2026-11-04', '500', 'Consumer', 250));
  const svgs = scplBillSvg(scplBill(sales, { from: '2026-11-01', to: '2026-11-10' }));
  assert.equal(svgs.length, 3);                                     // 40 rows run on to a second sheet
  for (const svg of svgs) {
    for (const t of ['Bill To', 'Date:', '01-11-2026', '>To<', '10-11-2026', 'Product:', SCPL_TEMPLATE.name.replace('&', '&amp;'), 'GSTIN: 21AAICS8597H2ZV', 'For VRIDDHI FUELS', 'Signature of Customer']) assert.ok(svg.includes(t), t);
  }
  assert.doesNotMatch(svgs[0], />TOTAL</);
  assert.doesNotMatch(svgs[0], /Payment Details/);
  assert.match(svgs[1], />TOTAL</);
  assert.match(svgs[1], /fill="#FF0000"/);
  assert.match(svgs[1], /Payment Details:/);
  assert.match(svgs[1], /IFSC Code – HDFC0000763/);
  assert.match(svgs[2], />Consumer</);
  // one short period: one sheet each
  assert.equal(scplBillSvg(scplBill(sales.slice(0, 10), { from: '2026-11-01', to: '2026-11-10' })).length, 1);
});
