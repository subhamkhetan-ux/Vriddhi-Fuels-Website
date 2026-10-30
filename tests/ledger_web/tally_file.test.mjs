// The Tally viewer: reading a DayBook (Excel) or Tally's XML export, and the
// insights worked out from it. Run: node --test tests/ledger_web
// All names and numbers are made up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  analyseTally, checks, decodeText, filterVouchers, fuelOf, kindOf, looksLikeXml, numberSeries, parseDaybookSheet, parseTallyXml,
  voucherSheet,
} from '../../ledger/js/tally-file.js';
import {
  checksHtml, fileHeadHtml, ledgersHtml, overviewHtml, partiesHtml, productsHtml, ratesHtml, seriesHtml, trendHtml, typesHtml,
  vehiclesHtml, vouchersHtml,
} from '../../ledger/js/tally-view.js';
import { sheetRows } from '../../ledger/js/daybook.js';
import { date, sheet } from './sheets.mjs';

const RAW = fs.readFileSync(new URL('../fixtures/tally-daybook-sample.xml', import.meta.url));
const buf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function daybook() {
  return sheet({}, {
    start: 1,
    rows: [
      ['Demo Fuels (2026-27)', '', '', '', '', '', '', '', ''],
      ['Day Book', '', '', '', '', '', '', '', ''],
      ['Date', 'Particulars', 'Vch Type', 'Qty', 'Rate', 'Vehicle', 'Vch No.', 'Debit', 'Credit'],
      [date('2026-04-06'), 'Demo Power Ltd', 'HSD CREDIT', 1000, 90.5, 'od01 a 1111', '101', 90500, ''],
      [date('2026-04-07'), 'Demo Power Ltd', 'HSD CREDIT', 1000, 89.5, 'OD01A1111', '102', 89500, ''],
      [date('2026-04-07'), 'Sample Roadlines', 'HSD CREDIT', 500, 90.5, 'OD02B2222', '105', 45250, ''],
      [date('2026-04-07'), 'Sample Roadlines', 'MS CREDIT', 20, 100, '', 'MS5', 2000, ''],
      [date('2026-04-07'), 'Sample Roadlines', 'XG CREDIT', 100, 92.5, 'OD02B2222', 'XG7', 9250, ''],
      [date('2026-04-07'), 'Demo Power Ltd', 'Receipt', '', '', '', '1', '', 50000],
      [date('2026-04-08'), 'Electricity Charges', 'Payment', '', '', '', '1', 4200, ''],
      [date('2026-04-08'), 'Sample Roadlines', 'HSD CREDIT', 200, 91, 'OD01A1111', '104', 18300, ''],
      [date('2026-04-08'), 'Demo Power Ltd', 'HSD CREDIT', 100, 91, 'OD01A1111', '104', 9100, ''],
      [date('2026-04-08'), '(cancelled)', 'HSD CREDIT', '', '', '', '106', '', ''],
      ['Total:', '', '', '', '', '', '', 268100, 50000],
    ],
  });
}

test('voucher kinds and fuels from their names', () => {
  assert.equal(kindOf('HSD CREDIT'), 'sale');
  assert.equal(kindOf('MS CASH'), 'sale');
  assert.equal(kindOf('Sales'), 'sale');
  assert.equal(kindOf('Receipt'), 'receipt');
  assert.equal(kindOf('Payment'), 'payment');
  assert.equal(kindOf('Credit Note'), 'creditnote');
  assert.equal(kindOf('Debit Note'), 'debitnote');
  assert.equal(kindOf('Contra'), 'contra');
  assert.equal(kindOf('Journal'), 'journal');
  assert.equal(kindOf('Purchase'), 'purchase');
  assert.equal(kindOf('Memorandum'), 'other');
  assert.equal(fuelOf('XtraGreen Diesel'), 'XG');
  assert.equal(fuelOf('High Speed Diesel'), 'HSD');
  assert.equal(fuelOf('Motor Spirit'), 'MS');
  assert.equal(fuelOf('XG CREDIT'), 'XG');
  assert.equal(fuelOf('Servo 4T 1L'), null);
});

test('Tally XML: UTF-16 export with ledgers, items and vehicles', () => {
  assert.ok(looksLikeXml(buf(RAW)));
  const p = parseTallyXml(decodeText(buf(RAW)));
  assert.equal(p.company, 'VRIDDHI FUELS (2026-27)');
  assert.equal(p.vouchers.length, 5);
  const v = p.vouchers.find((x) => x.number === '4331');
  assert.equal(v.kind, 'sale');
  assert.equal(v.product, 'HSD');
  assert.equal(v.date, '2026-10-22');
  assert.equal(v.vehicle, 'OD00AA0000');
  assert.equal(v.qty, 12000);
  assert.equal(v.rate, 99.5);
  assert.equal(v.amount, 1194000);
  assert.equal(v.debit, 1194000);
  assert.deepEqual(v.items, [{ name: 'High Speed Diesel', product: 'HSD', qty: 12000, rate: 99.5, amount: 1194000 }]);
  assert.deepEqual(v.ledgers.map((l) => l.name).sort(), ['SALE (HSD)', v.party].sort());
  assert.equal(p.vouchers.filter((x) => x.product === 'MS').length, 1);
});

test('Tally XML: cancelled vouchers, receipts and lubes', () => {
  const xml = `<ENVELOPE><BODY><TALLYMESSAGE>
    <VOUCHER VCHTYPE="Receipt"><DATE>20260407</DATE><VOUCHERNUMBER>R1</VOUCHERNUMBER><PARTYLEDGERNAME>Demo &amp; Sons</PARTYLEDGERNAME>
      <NARRATION>NEFT &#4; ref 12</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Demo &amp; Sons</LEDGERNAME><AMOUNT>25000.00</AMOUNT><BILLALLOCATIONS.LIST><AMOUNT>25000.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sample Bank</LEDGERNAME><AMOUNT>-25000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
    <VOUCHER VCHTYPE="Sales"><DATE>20260407</DATE><VOUCHERNUMBER>9</VOUCHERNUMBER><PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
      <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Servo 4T 1L</STOCKITEMNAME><RATE>350.00/NOS</RATE><AMOUNT>700.00</AMOUNT><BILLEDQTY> 2 NOS</BILLEDQTY>
        <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>SALE (LUBE)</LEDGERNAME><AMOUNT>700.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>
      <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-700.00</AMOUNT></LEDGERENTRIES.LIST></VOUCHER>
    <VOUCHER VCHTYPE="HSD CREDIT"><DATE>20260407</DATE><VOUCHERNUMBER>10</VOUCHERNUMBER><ISCANCELLED>Yes</ISCANCELLED><PARTYLEDGERNAME>Demo &amp; Sons</PARTYLEDGERNAME></VOUCHER>
  </TALLYMESSAGE></BODY></ENVELOPE>`;
  const enc = new TextEncoder().encode(xml);
  assert.ok(looksLikeXml(buf(Buffer.from(enc))));
  const p = parseTallyXml(xml);
  const [rec, lube, cancelled] = p.vouchers;
  assert.equal(rec.kind, 'receipt');
  assert.equal(rec.party, 'Demo & Sons');
  assert.equal(rec.amount, 25000);
  assert.equal(rec.credit, 25000);
  assert.equal(rec.narration, 'NEFT  ref 12');
  assert.equal(lube.product, 'OTHER');
  assert.deepEqual(lube.items[0], { name: 'Servo 4T 1L', product: 'OTHER', qty: 2, rate: 350, amount: 700 });
  assert.ok(lube.ledgers.some((l) => l.name === 'SALE (LUBE)' && l.amount === 700));
  assert.ok(cancelled.cancelled);
  const a = analyseTally(p.vouchers);
  assert.equal(a.kpi.receipts, 25000);
  assert.equal(a.products.OTHER.amount, 700);
  assert.deepEqual(a.products.OTHER.items, [{ name: 'Servo 4T 1L', amount: 700 }]);
  assert.equal(a.counts.cancelled, 1);
  assert.deepEqual(a.ledgers.find((l) => l.name === 'Sample Bank'), { name: 'Sample Bank', debit: 25000, credit: 0, count: 1 });
});

test('DayBook Excel: every voucher type, the company and cancelled bills', () => {
  const p = parseDaybookSheet(sheetRows(daybook()));
  assert.equal(p.company, 'Demo Fuels (2026-27)');
  assert.equal(p.vouchers.length, 10);
  const first = p.vouchers[0];
  assert.equal(first.vehicle, 'OD01A1111');            // spaces gone, upper case
  assert.equal(first.product, 'HSD');
  assert.deepEqual(first.items, [{ name: 'HSD CREDIT', product: 'HSD', qty: 1000, rate: 90.5, amount: 90500 }]);
  const rec = p.vouchers.find((v) => v.kind === 'receipt');
  assert.equal(rec.amount, 50000);
  assert.equal(rec.credit, 50000);
  assert.ok(p.vouchers.at(-1).cancelled);
});

test('insights: totals, products, earnings, discounts, parties, vehicles', () => {
  const { vouchers } = parseDaybookSheet(sheetRows(daybook()));
  const a = analyseTally(vouchers);
  assert.equal(a.from, '2026-04-06');
  assert.equal(a.to, '2026-04-08');
  assert.equal(a.days, 3);
  assert.equal(a.kpi.bills, 7);
  assert.equal(a.kpi.sales, 263900);
  assert.equal(a.kpi.receipts, 50000);
  assert.equal(a.kpi.payments, 4200);
  assert.equal(a.products.HSD.qty, 2800);
  assert.equal(a.products.HSD.bills, 5);
  assert.equal(a.products.HSD.rateMin, 89.5);
  assert.equal(a.products.HSD.rateMax, 91);
  // 7 Apr: RSP 90.5, Demo Power billed 1,000 L at 89.5 -> ₹1,000 discount
  assert.equal(a.products.HSD.discount, 1000);
  // earnings: retail earns the full margin, the discounted bill 2.58 − 1
  const demo = a.parties.find((x) => x.name === 'Demo Power Ltd');
  assert.equal(Math.round(demo.earning * 100) / 100, Math.round((1000 * 2.58 + 1000 * 1.58 + 100 * 2.58) * 100) / 100);
  assert.equal(demo.receipts, 50000);
  assert.equal(demo.net, 90500 + 89500 + 9100 - 50000);
  assert.equal(demo.vehicles, 1);
  assert.equal(a.kpi.parties, 2);
  const veh = a.vehicles.find((v) => v.vehicle === 'OD01A1111');
  assert.equal(veh.fills, 4);
  assert.deepEqual(veh.parties.sort(), ['Demo Power Ltd', 'Sample Roadlines']);
  assert.deepEqual(a.changes.map((c) => [c.product, c.date, c.from, c.to]), [['HSD', '2026-04-08', 90.5, 91]]);
  assert.equal(a.weekday.length, 7);
  // a period: only those days
  const one = analyseTally(vouchers, { from: '2026-04-08', to: '2026-04-08' });
  assert.equal(one.kpi.bills, 2);
  assert.equal(one.kpi.payments, 4200);
});

test('bill numbers: missing, used twice, out of order; checks', () => {
  const { vouchers } = parseDaybookSheet(sheetRows(daybook()));
  const hsd = numberSeries(vouchers).find((s) => s.type === 'HSD CREDIT');
  assert.equal(hsd.first, '101');
  assert.equal(hsd.last, '106');
  assert.deepEqual(hsd.missing, ['103']);
  assert.deepEqual(hsd.duplicates, [{ number: '104', count: 2 }]);
  assert.deepEqual(hsd.outOfOrder.map((o) => o.number), ['104', '104']);   // dated after 105
  assert.equal(hsd.cancelled, 1);
  // numbering restarts in April: separate series per FY
  const fy = numberSeries([
    { type: 'HSD CREDIT', kind: 'sale', number: '900', date: '2027-03-31' },
    { type: 'HSD CREDIT', kind: 'sale', number: '1', date: '2027-04-01' },
  ]);
  assert.equal(fy.length, 2);
  assert.ok(fy.every((s) => !s.missingCount && !s.outOfOrder.length));

  const c = checks(vouchers);
  assert.equal(c.cancelled.length, 1);
  assert.deepEqual(c.noVehicle.map((v) => v.number), ['MS5']);
  const off = { ...vouchers[0], items: [{ ...vouchers[0].items[0], amount: 90000 }], amount: 90000 };
  assert.equal(checks([off]).mismatch[0].diff, 500);
});

test('voucher list: filters and the Excel rows', () => {
  const { vouchers } = parseDaybookSheet(sheetRows(daybook()));
  assert.equal(filterVouchers(vouchers, { kind: 'receipt' }).length, 1);
  assert.equal(filterVouchers(vouchers, { product: 'MS' }).length, 1);
  assert.equal(filterVouchers(vouchers, { q: 'od02' }).length, 2);
  assert.equal(filterVouchers(vouchers, { from: '2026-04-08' }).length, 4);
  const list = filterVouchers(vouchers, {});
  assert.equal(list[0].date, '2026-04-08');              // newest first
  const rows = voucherSheet(list);
  assert.equal(rows[0][0], 'Date');
  assert.equal(rows.length, vouchers.length + 1);
});

test('screens render without throwing and escape names', () => {
  const { vouchers, company } = parseDaybookSheet(sheetRows(daybook()));
  vouchers[1].party = '<b>Demo</b>';
  const a = analyseTally(vouchers);
  const file = { name: 'daybook.xlsx', company, source: 'excel', vouchers };
  const html = [
    fileHeadHtml(file, a, { key: 'all' }), overviewHtml(a), typesHtml(a), productsHtml(a), trendHtml(a), partiesHtml(a, {}),
    vehiclesHtml(a), ratesHtml(a), seriesHtml(a), checksHtml(a), ledgersHtml(a, a.parties), vouchersHtml(vouchers, { kind: 'all', product: 'all', q: '' }, ['sale']),
  ].join('');
  assert.ok(html.includes('&lt;b&gt;Demo&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Demo</b>'));
  assert.ok(html.includes('Demo Fuels (2026-27)'));
});
