// The fleet app's rules, on a small made-up Trip Register (every vehicle,
// number and invoice here is invented).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFleet } from '../../fleet/js/parse.js';
import {
  attention, byRoute, costBreakdown, dateIssues, dieselRecon, fleetStatus, fuel, inPeriod, monthly, periods, ssfcAccount, totals,
} from '../../fleet/js/analyse.js';
import { demoData } from '../../fleet/js/demo.js';
import { memoryStore } from '../../fleet/js/store.js';
import { fyStart, money, serialToIso, toIso } from '../../fleet/js/util.js';

const serial = (iso) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);

const TRIP_HEAD = ['S.No', 'TRIP No', 'Vehicle No', 'Trip Start Date', 'Loading Date', 'Load Weight', 'Unload Date', 'Unload Weight', 'Excess/Short',
  'Loading Port', 'Destination', 'Tare Weight', 'Gross Weight', 'Price/Ton', 'Trip Bhada', 'SSFC Diesel Ltr ', 'SSFC Diesel Amount', 'Extra HSD Ltr',
  'Extar HSD Amt', 'Trip Diesel Ltr', 'Trip Diesel Amount', 'Own Urea', 'Extra Own Driver Pay', 'Trip Driver Payment', 'Driver SSFC Payment',
  'Own Document Exp.', 'SSFC Misc', 'Own Misc Kharcha', 'SSFC Receivable', 'Fastag', 'Maintainance', 'Tyre', 'Less Over/Unload', 'RTO Entry',
  'RTO Challan', 'Shortage', 'Document Expense', 'SSFC Net Amount', 'Installment', 'Income/Trip', 'Driver Debit', 'Remarks', 'Month'];
const col = (name) => TRIP_HEAD.indexOf(name);
function tripRow(o) {
  const r = new Array(TRIP_HEAD.length).fill(null);
  for (const [k, v] of Object.entries(o)) r[col(k)] = /Date/.test(k) && typeof v === 'string' ? serial(v) : v;
  return r;
}

function book() {
  const trips = [
    // row 3: done, cached formula values present
    tripRow({ 'S.No': 1, 'TRIP No': 'T001/BALCO', 'Vehicle No': 'XX01A1001', 'Trip Start Date': '2026-05-01', 'Loading Date': '2026-05-03', 'Load Weight': 40,
      'Unload Date': '2026-05-09', 'Unload Weight': 39.8, 'Excess/Short': -0.2, 'Loading Port': 'Kakinada', Destination: 'BALCO', 'Tare Weight': 17, 'Gross Weight': 57,
      'Price/Ton': 3000, 'Trip Bhada': 120000, 'SSFC Diesel Ltr ': 600, 'SSFC Diesel Amount': 60000, 'Driver SSFC Payment': 12000, Fastag: 8000,
      'Trip Diesel Ltr': 40, 'Trip Diesel Amount': 3700, Installment: 50000, 'SSFC Net Amount': 40000, 'Income/Trip': -13700 }),
    // row 4: done, formulas left blank -> the app works them out the same way
    tripRow({ 'S.No': 2, 'TRIP No': 'T002/JSG', 'Vehicle No': 'XX01A1002', 'Trip Start Date': '2026-05-02', 'Loading Date': '2026-05-04', 'Load Weight': 41,
      'Unload Date': '2026-05-08', 'Unload Weight': 41, 'Loading Port': 'Gopalpur', Destination: 'Vedanta', 'Tare Weight': 17, 'Gross Weight': 59,
      'Price/Ton': 1800, 'SSFC Diesel Ltr ': 300, 'SSFC Diesel Amount': 30000, 'Driver SSFC Payment': 6500, 'Own Urea': 1000 }),
    // row 5: loaded, on the way
    tripRow({ 'S.No': 3, 'TRIP No': 'T003/BALCO', 'Vehicle No': 'XX01A1001', 'Trip Start Date': '2026-06-01', 'Loading Date': '2026-06-03', 'Load Weight': 42,
      'Loading Port': 'Kakinada', Destination: 'BALCO', 'Tare Weight': 17, 'Gross Weight': 59, 'Price/Ton': 3000, 'Trip Bhada': 126000, 'SSFC Diesel Ltr ': 640,
      'SSFC Diesel Amount': 64000, 'SSFC Net Amount': 62000, 'Income/Trip': 62000 }),
    // row 6: empty, going to load
    tripRow({ 'S.No': 4, 'TRIP No': 'T004/BALCO', 'Vehicle No': 'XX01A1002', 'Trip Start Date': '2026-06-05', 'Loading Port': 'Kakinada', Destination: 'BALCO' }),
    // row 7: a mistyped unload date (after "today")
    tripRow({ 'S.No': 5, 'TRIP No': 'T005/JSG', 'Vehicle No': 'XX01A1003', 'Trip Start Date': '2026-01-08', 'Loading Date': '2026-01-09', 'Load Weight': 40,
      'Unload Date': '2026-10-13', 'Unload Weight': 40, 'Loading Port': 'Gopalpur', Destination: 'Vedanta', 'Price/Ton': 1800, 'Trip Bhada': 72000,
      'SSFC Net Amount': 72000, 'Income/Trip': 72000 }),
  ];
  const ledger = [
    ['DEMO FREIGHT CARRIER (00ABCDE1234F1Z5)'], ['Ledger Account for BULKER HIRING'], [],
    ['Month', 'Vehicle No', 'SSFC Base Net Amount (NA)', 'Hiring Base Amount', 'Hiring IGST (18%)', 'Hiring Total (HT)', 'Diff (NA-HT) In Cash',
      'Market HSD (Paid Direct to Market Pump)', 'Own Diesel          (Paid In My Pump)', 'Paid         In Cash ', 'Balance           In Cash',
      'Paid In SSL Account', 'Balance     In Account', 'Invoice No', 'Paid Date', 'Remarks', null, null, null, 'TOTAL', 999],
    [serial('2026-03-01'), 'XX01A1001', 100000, null, 0, 0, 100000, null, null, null, 100000, null, 0, null, '', 'not invoiced'],
    [serial('2026-04-01'), 'XX01A1001', 200000, 150000, 27000, 177000, 23000, null, 50000, null, 73000, null, 177000, 'INV/1', '', ''],
    [serial('2026-05-01'), 'XX01A1001', 300000, 200000, 36000, 236000, 64000, null, null, null, 137000, 200000, 213000, 'INV/2', serial('2026-06-10'), ''],
  ];
  // Bridgestone note beside the table (col Y/Z like the real sheet)
  ledger[4][24] = 'Bridgestone Security Deposit'; ledger[4][25] = 12345;
  const hsd = [
    ['Date', 'Bill No.', 'Vehicle', 'Quantity', 'RSP', 'Amount', 'RO Name', 'Location', 'Month', 'Trip ID', 'Expected Trip ID (rule)', null, null, null, 'RO Name'],
    [serial('2026-05-03'), '1', 'XX01A1001', 600, 100, 60000, 'SSFC', 'Muniguda', 'May-26', 'T001/BALCO', '', null, null, null, 'pivot junk'],
    [serial('2026-05-04'), '2', 'XX01A1002', 300, 92, 27600, 'Vriddhi Fuels', 'Jharsuguda', 'May-26', 'T002/JSG', ''],
    [serial('2026-06-03'), '3', 'XX01A1001', 40, 92.5, 3700, 'Tara Tarini', 'Sambalpur', 'Jun-26', 'T003/BALCO', ''],
  ];
  const rates = [['Location', 'Company', 'Rate', 'Diesel', 'Driver Payment', 'Driver Extra Pay'], ['Kakinada', 'BALCO', 3000, 630, 10000, null], ['Gopalpur', 'Vedanta', 1800, 310, null, null]];
  // Excel's own recon for row 3 (a hand-typed allotted of 650); rows past it use the rule
  const recon = [['TR Row', 'Vehicle', 'Trip No', 'Date', 'Loading Port', 'Destination', 'Gross Wt', 'Base Diesel', 'Overload', 'Underload', 'Allotted', 'SSFC', 'Own Trip', 'Issued', 'Trip Balance'],
    [3, 'XX01A1001', 'T001/BALCO', null, 'Kakinada', 'BALCO', 57, 630, 0, 5, 650, 600, 40, 640, 10]];
  return {
    sheets: {
      'Trip Register': { rows: [['', '', '', '', 'LOADING'], TRIP_HEAD, ...trips], r0: 1 },
      Ledger: { rows: ledger, r0: 1 },
      'HSD Data': { rows: hsd, r0: 1 },
      Rates: { rows: rates, r0: 1 },
      'Recon Engine': { rows: recon, r0: 1 },
      'Diesel Recon': { rows: [['Vehicle-wise'], ['Vehicle', 'Net Balance (L)'], ['TOTAL', -55]], r0: 1 },
    },
    formulas: { 'Recon Engine!J': '=IF($B9="","",IF($G9="","",IF(AND($A9>=4,ROUND($G9,0)<58,$Q9<>"No"),(58-ROUND($G9,0))*5,0)))' },
  };
}

const TODAY = '2026-06-08';

test('dates and money helpers', () => {
  assert.equal(serialToIso(serial('2026-10-11')), '2026-10-11');
  assert.equal(toIso('13/01/2026'), '2026-01-13');
  assert.equal(fyStart('2026-03-31'), '2025-04');
  assert.equal(fyStart('2026-04-01'), '2026-04');
  assert.equal(money(12345678.9), '₹1.23 Cr');
  assert.equal(money(-318000), '−₹3.18 L');
});

test('reads trips by their headings and fills blank formulas the same way', () => {
  const d = extractFleet(book(), { fileName: 'x.xlsm' });
  assert.equal(d.trips.length, 5);
  const [a, b, c, e] = d.trips;
  assert.deepEqual([a.row, a.veh, a.start, a.loadDate, a.unloadDate, a.month, a.status], [3, 'XX01A1001', '2026-05-01', '2026-05-03', '2026-05-09', '2026-05', 'done']);
  assert.equal(a.income, -13700);                                       // the cached value, as Excel saved it
  // row 4 had no Trip Bhada / SSFC Net / Income: Load × Rate, then the sheet's formulas
  assert.equal(b.bhada, 73800);
  assert.equal(b.ssfcNet, 73800 - 30000 - 6500);
  assert.equal(b.income, b.ssfcNet - 1000);
  assert.equal(c.status, 'loaded');
  assert.equal(e.status, 'empty');
  assert.equal(e.month, null);
  assert.equal(d.latest, '2026-06-05');
});

test('totals, costs, months and routes', () => {
  const d = extractFleet(book());
  const may = d.trips.filter((t) => inPeriod(t, { from: '2026-05', to: '2026-05' }));
  const T = totals(may);
  assert.equal(T.trips, 2);
  assert.equal(T.bhada, 120000 + 73800);
  assert.equal(T.emi, 50000);
  assert.equal(T.income, -13700 + 36300);
  assert.equal(Math.round(T.short * 100) / 100, -0.2);
  assert.equal(T.shortTrips, 1);
  const cost = costBreakdown(may);
  assert.equal(cost.groups[0].key, 'diesel');
  assert.equal(cost.groups[0].amount, 60000 + 3700 + 30000);
  const months = monthly(d.trips, '2026-04', '2026-06');
  assert.deepEqual(months.map((m) => m.trips), [0, 2, 1]);
  const routes = byRoute(d.trips.filter((t) => t.month));
  assert.equal(routes[0].route, 'Kakinada → BALCO');
  assert.equal(routes[0].trips, 2);
});

test('periods follow the Indian financial year', () => {
  const p = periods('2026-05-20', '2026-06');
  assert.deepEqual([p.month.from, p.last.from, p.q.from, p.fy.from, p.fy.to, p.lastfy.from, p.lastfy.to], ['2026-05', '2026-04', '2026-03', '2026-04', '2027-03', '2025-04', '2026-03']);
  assert.equal(p.all.to, '2026-06');
});

test('live fleet: loaded / empty / idle like the On-Trip Dashboard', () => {
  const d = extractFleet(book());
  const s = fleetStatus(d, TODAY);
  const by = Object.fromEntries(s.map((x) => [x.veh, x]));
  assert.equal(by.XX01A1001.state, 'loaded');
  assert.equal(by.XX01A1001.text, 'Loaded → BALCO');
  assert.equal(by.XX01A1001.days, 7);
  assert.equal(by.XX01A1002.state, 'empty');
  assert.equal(by.XX01A1002.text, 'Empty → Kakinada');
  assert.equal(by.XX01A1003.state, 'idle');
});

test('SSFC account: balances, and payments clear the oldest first', () => {
  const d = extractFleet(book());
  assert.deepEqual(d.ssfc.party, { name: 'DEMO FREIGHT CARRIER', gstin: '00ABCDE1234F1Z5' });
  assert.deepEqual(d.ssfc.memos, [{ label: 'Bridgestone Security Deposit', amount: 12345 }]);
  assert.equal(d.checks.ssfcTotal, 999);
  const a = ssfcAccount(d.ssfc, TODAY);
  assert.equal(a.net, 600000);
  assert.equal(a.paid, 250000);                                          // 200000 in account + 50000 own diesel
  assert.equal(a.exGst, 350000);
  assert.equal(a.total, 350000 + 63000);
  assert.equal(a.account, 413000 - 200000);                              // invoices with GST − paid in account
  assert.equal(a.cash, 600000 - 413000 - 50000);
  assert.equal(a.account + a.cash, a.exGst);
  assert.deepEqual(a.withGst.map((b) => [b.no, b.amount, b.cleared, b.pending, b.status]), [
    [null, 100000, 100000, 0, 'cleared'],
    ['INV/1', 227000, 150000, 77000, 'part'],
    ['INV/2', 336000, 0, 336000, 'pending'],
  ]);
  assert.equal(a.withGst[1].age, 39);                                    // since 30 Apr
  assert.equal(a.exGstList.reduce((x, b) => x + b.pending, 0), a.exGst);
  assert.equal(a.payments.length, 2);
});

test('diesel recon: Excel\'s own rows as they are, the newest rule after them', () => {
  const d = extractFleet(book());
  assert.equal(d.recon.fromRow, 3);
  assert.equal(d.recon.underloadFromRow, 4);
  assert.equal(d.recon.underloadBelow, 58);
  const r = dieselRecon(d);
  const v1 = r.vehicles.find((v) => v.veh === 'XX01A1001');
  assert.deepEqual(v1.list.map((x) => [x.t.row, x.allotted, x.issued, x.balance]), [
    [3, 650, 640, 10],                                                   // typed in Excel
    [5, 635, 640, -5],                                                   // 630 + (59 − 58) × 5
  ]);
  assert.equal(v1.balance, 5);
  const v2 = r.vehicles.find((v) => v.veh === 'XX01A1002');
  assert.equal(v2.list[0].allotted, 315);                                // Gopalpur 310 + overload 5
  assert.equal(v2.list[1].allotted, null);                               // not loaded: no balance yet
  assert.equal(d.checks.reconTotal, -55);
});

test('flags dates that look mistyped and lists what needs a look', () => {
  const d = extractFleet(book());
  const odd = dateIssues(d, TODAY);
  assert.deepEqual(odd.map((x) => x.t.trip), ['T005/JSG']);
  const todo = attention(d, TODAY, { recon: dieselRecon(d), account: ssfcAccount(d.ssfc, TODAY) });
  assert.match(todo[0].text, /1 trip has a date/);
  assert.ok(todo.some((t) => /T001\/BALCO: 0.20 T short/.test(t.text)));
});

test('fuel by pump folds unknown pumps into Other', () => {
  const d = extractFleet(book());
  const f = fuel(d.hsd, { from: '2026-01', to: '2026-12' });
  assert.equal(d.hsd.length, 3);
  assert.deepEqual(f.sources.map((s) => [s.name, s.litres]), [['SSFC', 600], ['Vriddhi Fuels', 300], ['Other', 40]]);
  assert.equal(f.months.length, 2);
});

test('a workbook without a Trip Register is refused clearly', () => {
  assert.throws(() => extractFleet({ sheets: { Sheet1: { rows: [['a', 'b']], r0: 1 } } }), /no Trip Register/);
});

test('demo data and the in-memory store work end to end', async () => {
  const d = demoData('2026-10-11');
  assert.ok(d.trips.length > 100);
  const s = memoryStore(d);
  const latest = await s.latest();
  assert.equal(latest.payload.trips.length, d.trips.length);
  const a = ssfcAccount(latest.payload.ssfc, '2026-10-11');
  assert.ok(Math.abs(a.account + a.cash - a.exGst) < 0.01);
  assert.equal(fleetStatus(latest.payload, '2026-10-11').length, 8);
  dieselRecon(latest.payload);
  await s.save('again.xlsm', d);
  assert.equal((await s.uploads()).length, 2);
});
