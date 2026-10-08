// The statement view of a ledger, the company-wise split of a group sheet,
// the rate chart and the shared pictures (all made-up figures).
import assert from 'node:assert/strict';
import test from 'node:test';

import { bulkRows } from '../../ledger/js/account.js';
import {
  bulkStatement, companyWise, fifoPending, poSummary, rateChart, rateChartSheet, RATE_HEAD_ROWS, retailStatement, unitKey, unitLabel, unitStatement,
} from '../../ledger/js/ledger-view.js';
import { demoSeed } from '../../ledger/js/demo.js';
import { memoryStore } from '../../ledger/js/store.js';
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
  ]);
  assert.equal(cw.settled, 1);                             // Crew Three, at nil: counted, not listed
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
  assert.ok(!card.svg.includes('Crew Three') && card.svg.includes('+ 1 company with a nil balance'));
  const adv = outstandingCardSvg({ name: 'Paid Ahead', kind: 'retail', balance: -2500, asOn: '2026-10-08' });
  assert.ok(adv.svg.includes('ADVANCE WITH US') && adv.svg.includes('₹2,500'));
  const list = outstandingListSvg({ list: [{ name: 'A', kind: 'bulk', balance: 100 }, { name: 'B', kind: 'retail', balance: 50 }], total: 150, asOn: '2026-10-08' });
  assert.ok(list.svg.includes('₹150') && list.svg.includes('2 CUSTOMERS'));
});

// ---- FIFO ---------------------------------------------------------------------------
const e = (date, bill, debit, credit = 0, extra = {}) => ({
  date, bill, title: bill ? `Diesel · Bill ${bill}` : 'Payment received', product: bill ? 'HSD' : 'PAY', type: bill ? 'bill' : 'pay',
  debit, credit, paid: credit, tds: 0, shortage: 0, unit: '', company: '', ...extra,
});

test('FIFO: payments clear the opening, then the oldest bills; the newest stay pending', () => {
  const entries = [e('2026-04-02', '10', 1000), e('2026-04-03', '11', 2000), e('2026-04-04', '', 0, 1800), e('2026-04-06', '12', 500)];
  const f = fifoPending(entries, { opening: 400, from: '2026-04-01', asOn: '2026-04-10' });
  assert.deepEqual(f.pending.map((d) => [d.date, d.bill, d.amount, d.pending, d.days]), [
    ['2026-04-03', '11', 2000, 1600, 7],
    ['2026-04-06', '12', 500, 500, 4],
  ]);
  assert.equal(f.total, 400 + 3500 - 1800);
  assert.equal(f.advance, 0);
  // more paid than owed: nothing pending, the rest is an advance
  const over = fifoPending([e('2026-04-02', '10', 1000), e('2026-04-03', '', 0, 1500), e('2026-04-05', '11', 200)], { asOn: '2026-04-05' });
  assert.deepEqual(over.pending, []);
  assert.equal(over.advance, 300);
  assert.equal(over.total, -300);
  // an advance opening is used by the first bills; a refund is owed back like a bill
  const adv = fifoPending([e('2026-04-02', '10', 1000), e('2026-04-03', '', 0, -200)], { opening: -700, from: '2026-04-01' });
  assert.deepEqual(adv.pending.map((d) => [d.bill, d.title, d.pending]), [['10', 'Diesel · Bill 10', 300], ['', 'Refund', 200]]);
  assert.equal(adv.total, -700 + 1000 + 200);
});

test('FIFO by unit: a payment with a unit clears that unit, one without a unit the oldest of either', () => {
  const U1 = { unit: 'UNIT 1' };
  const U2 = { unit: 'UNIT 2' };
  const entries = [
    e('2026-04-02', '101', 1000, 0, U1), e('2026-04-03', '102', 2000, 0, U2),
    e('2026-04-04', '', 0, 1500, U2),                    // Unit 2's payment
    e('2026-04-05', '103', 1000, 0, U1),
    e('2026-04-06', '', 0, 1200),                        // no unit
    e('2026-04-07', '', 0, 900, U1),                     // Unit 1: its bills, then the opening without a unit
  ];
  const st = { name: 'SMC', kind: 'bulk', from: '2026-04-01', to: '2026-04-07', opening: 1300, entries };
  const obu = { 'UNIT 1': 600, 'UNIT 2': 400 };          // 300 of the opening isn't split
  const f = fifoPending(entries, { opening: 1300, openingByKey: obu, keyOf: unitKey, from: st.from, asOn: '2026-04-10' });
  const closing = 1300 + 4000 - 3600;
  assert.equal(f.total, closing);
  // the no-unit 1,200 cleared the oldest debts of any unit: Unit 1's opening (600),
  // the unsplit opening (300), then 300 of bill 101; Unit 1's own 900 then cleared
  // the rest of 101 (700) and 200 of 103
  assert.deepEqual(f.pending.map((d) => [d.bill, d.key, d.pending]), [['102', 'UNIT 2', 900], ['103', 'UNIT 1', 800]]);
  assert.deepEqual(f.keys['UNIT 1'], { pending: 800, advance: 0, balance: 800 });
  // each unit's own statement closes on what the FIFO says it owes, and the parts add up
  const parts = ['UNIT 1', 'UNIT 2', ''].map((u) => unitStatement({ ...st, months: [], totals: {} }, f, u, { openingByUnit: obu }));
  assert.deepEqual(parts.map((p) => p.closing), [800, 900, 0]);
  assert.equal(parts.reduce((a, p) => a + p.closing, 0), closing);
  assert.deepEqual(parts.map((p) => p.opening), [600, 400, 300]);
  assert.ok(parts[0].entries.some((x) => x.title === 'Payment received' && x.credit === 900 && /FIFO/.test(x.detail)));
  // the part without a unit keeps only the 300 of that payment it used
  assert.deepEqual(parts[2].entries.map((x) => [x.credit, x.balance]), [[300, 0]]);
  assert.equal(parts[0].name, 'SMC — Unit 1');
  assert.equal(unitLabel(''), 'No unit');
  // a unit's payment beyond its bills spills into the unsplit opening first
  const spill = fifoPending([e('2026-04-02', '', 0, 900, U1)], { opening: 1000, openingByKey: { 'UNIT 1': 600 }, keyOf: unitKey, from: '2026-04-01' });
  assert.deepEqual(spill.pending.map((d) => [d.key, d.pending]), [['', 100]]);
  assert.deepEqual(spill.moves, [{ at: 0, key: 'UNIT 1', amount: 300, kind: 'spill' }]);
  const u1 = unitStatement({ name: 'S', kind: 'bulk', from: '2026-04-01', to: '2026-04-02', opening: 1000, entries: [e('2026-04-02', '', 0, 900, U1)] }, spill, 'UNIT 1', { openingByUnit: { 'UNIT 1': 600 } });
  assert.equal(u1.closing, 0);
});

test('demo: the unit typed on a payment reaches the bulk ledger', async () => {
  const store = memoryStore(demoSeed(new Date('2026-10-08T12:00:00')));
  const data = await store.account(null, 'Twin Steel_Bulk', null, null);
  const units = data.payments.map((p) => p.unit);
  assert.ok(units.includes('UNIT 1') && units.includes(''));
  const res = bulkRows(data);
  assert.ok(res.rows.some((r) => r.payment && r.unit === 'UNIT 1'));
});

test('pictures: the pending bills (FIFO) on the card and after the closing', () => {
  const pending = [
    { date: '2026-09-22', bill: '1437', title: 'Diesel · Bill 1437', key: 'UNIT 1', amount: 225050, pending: 1214, days: 16 },
    { date: '2026-10-04', bill: '1490', title: 'Diesel · Bill 1490', key: 'UNIT 1', amount: 144032, pending: 144032, days: 4 },
  ];
  const card = outstandingCardSvg({ name: 'SMC — Unit 1', kind: 'bulk', balance: 145246, asOn: '2026-10-08', pending });
  for (const t of ['PENDING BILLS', 'Inv. 1437', 'of ₹2,25,050', '₹1,214', '16 days', 'Inv. 1490', '22 Sep 2026', 'Unit 1']) assert.ok(card.svg.includes(t), t);
  const many = Array.from({ length: 50 }, (_, i) => ({ ...pending[1], bill: String(2000 + i), pending: 100 }));
  const big = outstandingCardSvg({ name: 'X', kind: 'bulk', balance: 5000, asOn: '2026-10-08', pending: many });
  assert.ok(big.svg.includes('+ 11 more bills'));
  const data = groupData();
  const st = bulkStatement(bulkRows(data), data, { name: 'Crew' });
  const pages = ledgerPagesSvg(st, { asOn: '2026-10-08', pending, advance: 0 });
  const lastPage = pages[pages.length - 1];
  assert.ok(lastPage.includes('PENDING BILLS') && lastPage.includes('Inv. 1490'));
  assert.ok(lastPage.indexOf('Closing balance') < lastPage.indexOf('PENDING BILLS'));
});

test('PO-wise outstanding: the FIFO pending bills by PO, unit by unit', () => {
  const entries = [
    e('2026-09-01', '1', 1000, 0, { unit: 'UNIT 1', po: 'PO-A' }), e('2026-09-02', '2', 1000, 0, { unit: 'UNIT 1', po: 'PO-A' }),
    e('2026-09-03', '3', 1000, 0, { unit: 'UNIT 1', po: 'PO-B' }), e('2026-09-04', '4', 500, 0, { unit: 'UNIT 2', po: 'PO-Z' }),
    e('2026-09-05', '5', 300, 0, { unit: 'UNIT 1', product: 'MS' }),                 // petrol: no PO
    e('2026-09-06', '', 0, 1500, { unit: 'UNIT 1' }),
  ];
  const f = fifoPending(entries, { opening: 200, openingByKey: { 'UNIT 1': 200 }, keyOf: unitKey, from: '2026-09-01', asOn: '2026-09-10' });
  assert.ok(f.pending.every((d) => 'po' in d));
  const pos = poSummary(f.pending);
  // Unit 1's 1,500 cleared its opening (200) and 1,300 of PO-A
  assert.deepEqual(pos.rows.map((r) => [r.unit, r.kind, r.po, r.bills, r.pending, r.from, r.oldestDays]), [
    ['UNIT 1', 'po', 'PO-A', 1, 700, '2026-09-02', 8],
    ['UNIT 1', 'po', 'PO-B', 1, 1000, '2026-09-03', 7],
    ['UNIT 1', 'none', '', 1, 300, '2026-09-05', 5],
    ['UNIT 2', 'po', 'PO-Z', 1, 500, '2026-09-04', 6],
  ]);
  assert.equal(pos.total, f.total);
  assert.deepEqual(pos.rows.map((r) => r.unitLabel), ['Unit 1', 'Unit 1', 'Unit 1', 'Unit 2']);
  // a bill with no unit yet: last, as "No unit"
  const mixed = poSummary([{ date: '2026-09-01', bill: '9', key: '', po: '', amount: 5, pending: 5, days: 1 }, ...f.pending]);
  assert.deepEqual(mixed.rows.map((r) => r.unitLabel).slice(-1), ['No unit']);
  // no PO anywhere: no summary
  assert.equal(poSummary(fifoPending([e('2026-09-01', '1', 100)]).pending), null);
  // an unpaid opening is a row of its own, first in its unit
  const open = poSummary(fifoPending([e('2026-09-01', '1', 100, 0, { po: 'P' })], { opening: 50, from: '2026-08-31' }).pending);
  assert.deepEqual(open.rows.map((r) => [r.kind, r.pending]), [['opening', 50], ['po', 100]]);

  const card = outstandingCardSvg({ name: 'SMC — Unit 1', kind: 'bulk', balance: 2000, asOn: '2026-09-10', pending: f.pending, pos });
  for (const t of ['PO-WISE OUTSTANDING', 'PO PO-A', '₹700', 'Without a PO', '3 POs', 'oldest 8 d', 'PO PO-B']) assert.ok(card.svg.includes(t), t);
  assert.ok(card.svg.indexOf('PO-WISE OUTSTANDING') < card.svg.indexOf('PENDING BILLS'));
  const data = groupData();
  const st = bulkStatement(bulkRows(data), data, { name: 'X' });
  const pages = ledgerPagesSvg(st, { asOn: '2026-09-10', pending: f.pending, pos });
  const last = pages.join('');
  assert.ok(last.indexOf('Closing balance') < last.indexOf('PO-WISE OUTSTANDING') && last.indexOf('PO-WISE OUTSTANDING') < last.indexOf('PENDING BILLS'));
});
