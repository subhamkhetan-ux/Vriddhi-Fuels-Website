// Split bills by vehicle tag (Shivaay Logistics: JSW, 700 Acre, …).
import assert from 'node:assert/strict';
import test from 'node:test';

import { billMonths, plateKey, scplBillSvg, tagBill, tagFileName } from '../../ledger/js/scpl.js';

const C = 'Shivaay Logistics';
const sale = (id, date, bill, vehicle, qty, extra = {}) => ({ id, product: 'HSD', sale_date: date, bill_no: bill, vehicle, qty, rate: 100.24, amount: Math.round(qty * 100.24 * 100) / 100, customer: C, ...extra });
const sales = [
  sale(1, '2026-10-02', '33', 'OD15AF5510', 1500),
  sale(2, '2026-10-05', '63', 'od 15 af-5510', 1500),            // the same vehicle, typed differently
  sale(3, '2026-10-04', '50', 'OD02BU0840', 2000),
  sale(4, '2026-10-09', '117', 'OD23U0755', 800),                 // not tagged yet
  sale(5, '2026-10-11', '136', null, 1999.89),                    // no vehicle no.
  sale(6, '2026-11-02', '200', 'OD15AF5510', 1000),               // next month
  sale(7, '2026-10-12', '140', 'OD15AF5510', 50, { product: 'MS' }),
  sale(8, '2026-10-12', '141', 'OD15AF5510', 70, { customer: 'Someone Else' }),
];
const tags = { OD15AF5510: 'JSW', OD02BU0840: '700 Acre' };

test('plateKey: one key however a vehicle no. is typed', () => {
  assert.equal(plateKey('od 15 af-5510'), 'OD15AF5510');
  assert.equal(plateKey(null), '');
});

test('tagBill: a page per tag (A–Z), its vehicles, and what still needs a tag', () => {
  const b = tagBill(sales, { customer: C, from: '2026-10-01', to: '2026-10-31', tags });
  assert.deepEqual(b.pages.map((p) => [p.cat, p.rows.map((r) => r.bill_no), p.qty]), [['700 Acre', ['50'], 2000], ['JSW', ['33', '63'], 3000]]);
  assert.ok(b.pages.every((p) => p.byTag));
  assert.deepEqual(b.vehicles.map((v) => [v.key, v.bills, v.qty, v.tag]), [['OD15AF5510', 2, 3000, 'JSW'], ['OD02BU0840', 1, 2000, '700 Acre'], ['OD23U0755', 1, 800, '']]);
  assert.deepEqual(b.unread.map((r) => r.bill_no), ['117', '136']);
  // put by hand, or left out, for this bill only
  const p = tagBill(sales, { customer: C, from: '2026-10-01', to: '2026-10-31', tags, picked: { 4: 'JSW', 5: 'skip' } });
  assert.equal(p.unread.length, 0);
  assert.equal(p.skipped, 1);
  assert.deepEqual(p.pages.find((x) => x.cat === 'JSW').rows.map((r) => r.bill_no), ['33', '63', '117']);
});

test('the month list and the file name', () => {
  assert.deepEqual(billMonths('2026-11-18', 2), [{ from: '2026-11-01', to: '2026-11-18', month: '2026-11' }, { from: '2026-10-01', to: '2026-10-31', month: '2026-10' }]);
  assert.equal(billMonths('2027-01-05', 2)[1].from, '2026-12-01');
  assert.equal(tagFileName(C, '2026-10-01', '2026-10-31'), 'Shivaay Logistics Bill Oct 2026');
  assert.equal(tagFileName(C, '2026-11-01', '2026-11-18'), 'Shivaay Logistics Bill 1-18 Nov 2026');
  assert.equal(tagFileName('A/B Co', '2026-10-25', '2026-11-05'), 'A B Co Bill 25 Oct-5 Nov 2026');
});

test("the pages: the customer's Bill To, the tag, the vehicle no. in the table", () => {
  const b = tagBill(sales, { customer: C, from: '2026-10-01', to: '2026-10-31', tags, picked: { 4: 'JSW', 5: 'skip' } });
  const svgs = scplBillSvg(b, { billTo: { name: 'Shivaay Logistics', address: ['Jharsuguda.'], gstin: '21AERFS8379H1ZD' } });
  assert.equal(svgs.length, 2);
  assert.match(svgs[0], /Vehicles:<\/tspan> 700 Acre/);
  assert.match(svgs[1], /Vehicles:<\/tspan> JSW/);
  for (const t of ['Shivaay Logistics', 'Jharsuguda.', 'GSTIN: 21AERFS8379H1ZD', '01-10-2026', '31-10-2026', '>OD15AF5510<', '>OD23U0755<']) assert.ok(svgs[1].includes(t), t);
  assert.doesNotMatch(svgs[1], /Steels/);
});

test('isVehicleNo: a vehicle no. or a word typed in its place', async () => {
  const { isVehicleNo } = await import('../../ledger/js/scpl.js');
  for (const v of ['OD15AF5510', 'od 02 bu-0840', 'OD23U755', '22BH1234AA']) assert.equal(isVehicleNo(v), true, v);
  for (const v of ['Transporting', 'Consumer', 'JSW', '700 Acre', '']) assert.equal(isVehicleNo(v), false, v);
});

test('a setup: auto tags from words, one page, several products', async () => {
  const { setupOf } = await import('../../ledger/js/scpl.js');
  assert.deepEqual(setupOf(null), { split: 'tag', period: 'month', products: ['HSD'], tags: {}, billTo: null });
  const more = [...sales, sale(9, '2026-10-20', '300', 'JSW Plant', 600), sale(10, '2026-10-21', '301', 'OD15AF5510', 40, { product: 'MS' })];
  // a word in the Vehicle column is its own tag, without saving anything
  const a = tagBill(more, { customer: C, from: '2026-10-01', to: '2026-10-31', setup: { tags } });
  assert.deepEqual(a.pages.map((p) => p.cat), ['700 Acre', 'JSW', 'JSW Plant']);
  assert.equal(a.vehicles.find((v) => v.key === 'JSWPLANT').auto, 'JSW Plant');
  // a saved tag wins over the word
  assert.deepEqual(tagBill(more, { customer: C, from: '2026-10-01', to: '2026-10-31', setup: { tags: { ...tags, JSWPLANT: 'JSW' } } }).pages.map((p) => p.cat), ['700 Acre', 'JSW']);
  // one page: every HSD bill, nothing to tag
  const one = tagBill(more, { customer: C, from: '2026-10-01', to: '2026-10-31', setup: { split: 'none' } });
  assert.equal(one.pages.length, 1);
  assert.equal(one.pages[0].cat, '');
  assert.equal(one.pages[0].rows.length, 6);
  assert.equal(one.unread.length, 0);
  assert.equal(one.vehicles.length, 0);
  // HSD and MS: a page per tag and product, each with its product
  const both = tagBill(more, { customer: C, from: '2026-10-01', to: '2026-10-31', setup: { tags, products: ['HSD', 'MS'] }, picked: { 4: 'JSW', 5: 'skip' } });
  assert.deepEqual(both.pages.map((p) => `${p.cat}|${p.product}`), ['700 Acre|HSD', 'JSW|HSD', 'JSW|MS', 'JSW Plant|HSD']);
  const svgs = scplBillSvg(both, { billTo: { name: C } });
  assert.match(svgs[2], /Product:<\/tspan> MS/);
  // one page leaves the Vehicles line out
  assert.doesNotMatch(scplBillSvg(one, { billTo: { name: C } })[0], /Vehicles:/);
});
