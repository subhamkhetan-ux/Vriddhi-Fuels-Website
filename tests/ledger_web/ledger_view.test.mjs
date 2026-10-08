// The statement view of a ledger, the company-wise split of a group sheet,
// the rate chart and the shared pictures (all made-up figures).
import assert from 'node:assert/strict';
import test from 'node:test';

import { bulkRows } from '../../ledger/js/account.js';
import { bulkStatement, companyWise, rateChart, rateChartSheet, RATE_HEAD_ROWS, retailStatement } from '../../ledger/js/ledger-view.js';
import {
  drCr, fit, ledgerPagesSvg, monthSlice, outstandingCardSvg, outstandingListSvg, rupees, textWidth,
} from '../../ledger/js/share-svg.js';
import { ledgerRows } from '../../ledger/js/statements.js';
import { isoToSerial } from '../../ledger/js/util.js';

const groupData = () => ({
  group: { code: 'Crew_Bulk', title: 'Crew Group — Bulk Ledger — Diesel', kind: 'group', units: [], period_from: '2026-04-01', opening: 5000, layout: null },
  members: [{ key: 'crew one', name: 'Crew One' }, { key: 'crew two', name: 'Crew Two' }, { key: 'crew three', name: 'Crew Three' }],
  sales: [
    { id: 1, product: 'HSD', bill_no: '10', sale_date: '2026-04-02', qty: 100, rate: 90, amount: 9000, customer: 'Crew One', seq: 1 },
    { id: 2, product: 'HSD', bill_no: '11', sale_date: '2026-04-03', qty: 200, rate: 90, amount: 18000, customer: 'Crew Two', seq: 2 },
    { id: 3, product: 'OTHER', bill_no: 'L/1', sale_date: '2026-05-01', qty: 1, rate: 450, amount: 450, customer: 'crew  one', item: 'AdBlue', seq: 3 },
  ],
  payments: [
    { id: 9, pay_date: '2026-04-20', customer: 'Crew Two', amount: 10000, tds: 100, shortage: 50, remarks: 'NEFT', seq: 1 },
    { id: 10, pay_date: '2026-05-02', customer: 'Crew One', amount: -500, remarks: 'refund', seq: 2 },
  ],
});

test('bulk statement: entries, totals, months and the closing match the sheet', () => {
  const data = groupData();
  const res = bulkRows(data);
  const st = bulkStatement(res, data, { name: 'Crew Group' });
  assert.equal(st.closing, res.closing);
  assert.equal(st.closing, 5000 + 9000 + 18000 - 10150 + 450 + 500);
  assert.deepEqual(st.entries.map((e) => [e.type, e.product, e.title, e.debit, e.credit, e.balance]), [
    ['bill', 'HSD', 'Diesel · Bill 10', 9000, 0, 14000],
    ['bill', 'HSD', 'Diesel · Bill 11', 18000, 0, 32000],
    ['pay', 'PAY', 'Payment received', 0, 10150, 21850],
    ['bill', 'OTHER', 'AdBlue', 450, 0, 22300],
    ['pay', 'PAY', 'Refund', 0, -500, 22800],
  ]);
  assert.equal(st.entries[2].detail, 'Crew Two · NEFT');
  assert.deepEqual(st.totals, { billed: 27450, qty: 301, received: 9500, tds: 100, shortage: 50, bills: 3, payments: 2 });
  assert.deepEqual(st.lastPayment, { date: '2026-04-20', amount: 10000 });
  assert.equal(st.products.HSD.qty, 300);
  assert.deepEqual(st.months.map((m) => [m.month, m.opening, m.billed, m.received, m.deductions, m.closing]), [
    ['2026-04', 5000, 27000, 10000, 150, 21850],
    ['2026-05', 21850, 450, -500, 0, 22800],
  ]);
});

test('company-wise outstanding: each billing name, opening kept for the group', () => {
  const data = groupData();
  const st = bulkStatement(bulkRows(data), data, { name: 'Crew Group' });
  const cw = st.companies;
  assert.deepEqual(cw.list.map((c) => [c.name, c.billed, c.received, c.deductions, c.outstanding]), [
    ['Crew One', 9450, -500, 0, 9950],                     // "crew  one" is Crew One
    ['Crew Two', 18000, 10000, 150, 7850],
    ['Crew Three', 0, 0, 0, 0],
  ]);
  assert.equal(cw.opening, 5000);
  assert.equal(round(cw.opening + cw.list.reduce((a, c) => a + c.outstanding, 0)), cw.total);
  assert.equal(cw.total, st.closing);
  // one company: no split
  assert.equal(companyWise(st.entries.filter((e) => e.company === 'Crew Two'), [{ name: 'Crew Two' }], 0, 7850), null);
});
const round = (n) => Math.round(n * 100) / 100;

test('retail statement: a payment on a sale day counts as a payment', () => {
  const led = ledgerRows({
    opening: 1000, from: '2026-10-01',
    sales: [
      { product: 'HSD', sale_date: '2026-10-02', qty: 10, rate: 90, amount: 900 },
      { product: 'MS', sale_date: '2026-10-03', qty: 5, rate: 100, amount: 500 },
    ],
    payments: [{ pay_date: '2026-10-02', amount: 400 }, { pay_date: '2026-10-05', amount: 300 }],
  });
  const st = retailStatement(led, { name: 'Sample', from: '2026-10-01', to: '2026-10-08' });
  assert.equal(st.closing, 1000 + 900 + 500 - 700);
  assert.deepEqual(st.entries.map((e) => [e.type, e.title, e.debit, e.credit]), [
    ['bill', 'Diesel', 900, 400], ['bill', 'Petrol', 500, 0], ['pay', 'Payment received', 0, 300],
  ]);
  assert.equal(st.totals.payments, 2);
  assert.equal(st.totals.bills, 2);
  assert.deepEqual(st.lastPayment, { date: '2026-10-05', amount: 300 });
  assert.equal(st.companies, null);
});

test('rate chart: one row per day, changes from the day before, Excel dates', () => {
  const series = {
    HSD: [{ date: '2026-10-01', rsp: 90.5 }, { date: '2026-10-02', rsp: 90.5 }, { date: '2026-10-03', rsp: 91 }],
    MS: [{ date: '2026-10-01', rsp: 101 }, { date: '2026-10-02', rsp: null }, { date: '2026-10-03', rsp: 100.5 }],
    XG: [{ date: '2026-10-01', rsp: null }, { date: '2026-10-02', rsp: null }, { date: '2026-10-03', rsp: null }],
  };
  const chart = rateChart(series);
  assert.deepEqual(chart.products, ['HSD', 'MS']);
  const aoa = rateChartSheet(chart, { from: '2026-10-01', to: '2026-10-03' });
  assert.deepEqual(aoa[RATE_HEAD_ROWS - 1], ['Date', 'Day', 'Diesel', 'Petrol', 'Diesel change', 'Petrol change']);
  assert.deepEqual(aoa.slice(RATE_HEAD_ROWS), [
    [isoToSerial('2026-10-01'), 'Thu', 90.5, 101, null, null],
    [isoToSerial('2026-10-02'), 'Fri', 90.5, null, null, null],
    [isoToSerial('2026-10-03'), 'Sat', 91, 100.5, 0.5, -0.5],
  ]);
  assert.match(aoa[1][0], /^01-10-2026 to 03-10-2026/);
});

test('pictures: money the Indian way, balances as Dr / Cr, names that fit', () => {
  assert.equal(rupees(6942589), '₹69,42,589');
  assert.equal(rupees(-4683615), '−₹46,83,615');
  assert.equal(rupees(12.5), '₹12.50');
  assert.equal(drCr(1162839), '₹11,62,839 Dr');
  assert.equal(drCr(-3016161), '₹30,16,161 Cr');
  assert.equal(drCr(0.2), '₹0');
  const long = 'SHYAM METALICS & ENERGY LTD SAMBALPUR UNIT AND SOMETHING MUCH LONGER';
  const f = fit(long, 400, 20, 700);
  assert.ok(f.endsWith('…') && textWidth(f, 20, 700) <= 400);
  assert.equal(fit('Short', 400, 20), 'Short');
});

test('ledger pictures: A4-shaped pages, every entry once, the group split on page 1', () => {
  const data = groupData();
  for (let i = 0; i < 60; i++) {
    data.sales.push({ id: 100 + i, product: 'HSD', bill_no: String(200 + i), sale_date: `2026-06-${String(1 + (i % 28)).padStart(2, '0')}`, qty: 10, rate: 90, amount: 900, customer: i % 2 ? 'Crew One' : 'Crew Two', seq: 10 + i });
  }
  const st = bulkStatement(bulkRows(data), data, { name: 'Crew <Group> & Co' });
  const pages = ledgerPagesSvg(st, { asOn: '2026-10-08', images: { logo: 'data:image/png;base64,AAAA' } });
  assert.ok(pages.length >= 2);
  for (const p of pages) {
    assert.match(p, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 1280 1810"/);
    assert.ok(!p.includes('Crew <Group>'), 'names are escaped');
  }
  const all = pages.join('');
  for (const e of st.entries.filter((x) => x.title.startsWith('Diesel'))) {
    assert.equal(all.split(`>${e.title}</text>`).length - 1, 1, `${e.title} drawn once`);
  }
  assert.ok(pages[0].includes('COMPANY-WISE OUTSTANDING'));
  assert.ok(!pages[1].includes('COMPANY-WISE OUTSTANDING'));
  assert.ok(pages[pages.length - 1].includes('Closing balance'));
  assert.ok(pages[0].includes(`Page 1 of ${pages.length}`));
  // a month on its own: that month's opening and closing, no company split
  const june = monthSlice(st, '2026-06');
  assert.equal(june.from, '2026-06-01');
  assert.equal(june.opening, st.months.find((m) => m.month === '2026-06').opening);
  assert.equal(june.companies, null);
  assert.equal(june.entries.length, 60);
});

test('outstanding card and list pictures', () => {
  const data = groupData();
  const st = bulkStatement(bulkRows(data), data, { name: 'Crew Group' });
  const card = outstandingCardSvg({
    name: 'Crew Group', kind: 'bulk', balance: st.closing, asOn: '2026-10-08', since: st.from, opening: st.opening,
    billed: st.totals.billed, received: st.totals.received, lastPayment: st.lastPayment, companies: st.companies,
  });
  assert.equal(card.size.width, 1080);
  assert.ok(card.size.height > 900);
  assert.ok(card.svg.includes('Crew Two') && card.svg.includes('Group balance') && card.svg.includes(drCr(st.closing)));
  const adv = outstandingCardSvg({ name: 'Paid Ahead', kind: 'retail', balance: -2500, asOn: '2026-10-08' });
  assert.ok(adv.svg.includes('ADVANCE WITH US') && adv.svg.includes('₹2,500'));
  const list = outstandingListSvg({ list: [{ name: 'A', kind: 'bulk', balance: 100 }, { name: 'B', kind: 'retail', balance: 50 }], total: 150, asOn: '2026-10-08' });
  assert.ok(list.svg.includes('₹150') && list.svg.includes('2 CUSTOMERS'));
});
