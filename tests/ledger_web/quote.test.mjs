// Quotes: the Tanker Billing workbook's Quotation Maker, Proforma Invoice and
// PI Log. All names and numbers are made up.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  comparePiLog, firstTwoWords, nextPiNo, piCheckClean, piDiscount, piEffective, piFileName, piMatches, picturePaths, quoteFileName,
  readTankerBilling, samePiNo, textDate, textStamp,
} from '../../ledger/js/quote.js';
import { wrapLines } from '../../ledger/js/sheet-svg.js';
import { memoryStore } from '../../ledger/js/store.js';
import { date, formula, sheet } from './sheets.mjs';

const PAY = ['Payment Details:', 'Account No. – 000011112222', 'IFSC Code – DEMO0000001 ', 'Branch Name – DEMO BANK, TESTPUR', 'Beneficiary Name – Demo Fuels'];
const XP_PAY = ['Payment Details for XtraPower Account:', 'Virtual Account No. – DEMOXP0001', 'IFS Code – DEMO0000002', 'Branch Name– DEMO BANK, HEAD OFFICE', 'Beneficiary Name – Demo Oil Co'];
const DATA = {
  hsd_rsp: 100.74,
  rate_card: [
    { tier: 'HSD RSP', rate: 100.74, rsp_offset: null }, { tier: 'Bulk Price', rate: 99.5, rsp_offset: null },
    { tier: 'Linked Price', rate: 100, rsp_offset: -0.74 },
  ],
  product_rates: { 'Motor Spirit': 109.01, 'XtraGreen Diesel': 106.34 },
  xp: { points: 40, tds: 0.1, net: 36 },
};
const DEMO = { company: 'Demo Coal Mines Private Limited', hsd_rate: 100, address: ['Plot 1, Testpur', 'Vill: Sample', 'GSTIN : 00DEMO0000A1Z1'], payment: PAY, price_tier: 'Linked Price', po_no: 'PO-1' };
const XPC = { company: 'Sample Metals and Energy Ltd', hsd_rate: 99.5, address: ['Vill – Sample', 'Testpur.', 'GSTIN : 00DEMO0000B1Z2'], payment: XP_PAY, price_tier: 'Bulk Price' };

test('file names as the macros make them', () => {
  assert.equal(firstTwoWords('M/s. Ankita Air Products Private Limited'), 'Ankita Air');
  assert.equal(firstTwoWords('M/S Ultratech Cement Ltd'), 'Ultratech Cement');
  assert.equal(firstTwoWords('MS  Sample\nTraders'), 'Sample Traders');
  assert.equal(piFileName('Sample Metals and Energy Ltd', '2026-08-17'), 'Sample Metals PI 17 August 2026.pdf');
  assert.equal(piFileName('Twin/Steel Ltd', '2026-08-01'), 'Twin-Steel Ltd PI 1 August 2026.pdf');
  assert.equal(quoteFileName('', '2026-11-03'), 'Customer Quotation 3 November 2026.pdf');
});

test('the PI Log: derived columns, the next number, the reprint filter, dates typed as text', () => {
  const row = { qty: 12000, rate: 99.74, rsp: 100.74, grand_total: 1196880, points: 0 };
  assert.equal(piDiscount(row).toFixed(2), '1.00');
  assert.equal(piEffective(row), 99.74);
  const log = [{ pi_no: 'PI/2026-27/009' }, { pi_no: 'pi/2026-27/011' }, { pi_no: 'PI/2025-26/040' }];
  assert.equal(nextPiNo(log, '2026-11-03'), 'PI/2026-27/012');
  assert.equal(nextPiNo(log, '2027-04-01'), 'PI/2027-28/001');
  assert.ok(samePiNo(' PI/2026-27/011', 'pi/2026-27/011 '));
  assert.ok(piMatches({ pi_date: '2026-10-02', customer: 'Demo Coal Mines' }, { customer: 'coal', from: '2026-10-01', to: '2026-10-31' }));
  assert.ok(!piMatches({ pi_date: '2026-09-30', customer: 'Demo Coal Mines' }, { customer: '', from: '2026-10-01', to: '2026-10-31' }));
  assert.ok(piMatches({ pi_date: null, customer: 'X' }, { customer: '' }));          // no dates asked: every PI
  for (const [t, d] of [['31 Oct 2026', '2026-10-31'], ['03/11/2026', '2026-11-03'], ['3/11/26', '2026-11-03'], ['2026-11-03', '2026-11-03'], ['31/02/2026', null], ['soon', null]]) {
    assert.equal(textDate(t), d, t);
  }
  assert.equal(textStamp('4/11/2026, 2:19:12 PM'), '2026-11-04T14:19:12+05:30');
  assert.equal(textStamp('04/11/2026 12:05 AM'), '2026-11-04T00:05:00+05:30');
});

// a Tanker Billing workbook, as SheetJS reads it
function workbook() {
  const customers = sheet({
    A1: 'Company', B1: 'HSD', C1: 'Address 1', D1: 'Address 2', E1: 'Address 3', F1: 'Payment 1', G1: 'Payment 2', H1: 'Payment 3',
    I1: 'Payment 4', J1: 'Payment 5', K1: 'PO Label', L1: 'PO No.', M1: 'Price Tier',
    O1: 'Price Tier', P1: 'Rate', R1: 'Product', S1: 'Rate', U1: 'Fuel Type',
    O2: 'HSD RSP', P2: 100.74, O3: 'Bulk Price', P3: 99.5, O4: 'Linked Price', P4: formula(100, 'P2-0.74'),
    R2: 'Motor Spirit', S2: 109.01, U2: 'High Speed Diesel', U3: 'Motor Spirit',
    AC1: 'Preset', AD1: 'Terms Wording', AC2: 'Advance', AD2: '100% advance payment against Proforma Invoice, prior to dispatch.',
    AC3: 'N Days', AD3: 'Payment within {N} days from the date of receipt of material and invoice.',
    AF1: 'Price Tier', AG1: 'Payment Preset', AH1: 'Credit Days', AI1: 'Payment Terms',
    AF2: 'HSD RSP', AG2: 'Advance', AI2: formula('100% advance payment against Proforma Invoice, prior to dispatch.'),
    AF3: 'Bulk Price', AG3: 'N Days', AH3: 15, AI3: formula('Payment within 15 days from the date of receipt of material and invoice.'),
    W2: 'Points earned (paise per ₹100 paid)', X2: 40, W3: 'TDS deducted by IOCL on points', X3: 0.1, W4: 'Net points credited', X4: formula(36, 'X2*(1-X3)'),
  }, {
    start: 2, col: 'A', rows: [
      [DEMO.company, formula(100), ...DEMO.address, ...PAY, ' ', 'PO-1', 'Linked Price'],
      [XPC.company, formula(99.5), XPC.address[0], XPC.address[1], ' ', ...XP_PAY, 'P.O. No.:', 2120000001, 'Bulk Price'],
      [DEMO.company, 1],                                              // listed twice: the first is kept
    ],
  });
  const log = sheet({
    A1: 'Log ID', B1: 'PI No.', C1: 'PI Date', D1: 'Valid Up To', E1: 'Customer', H1: 'P.O. No.', L1: 'Quantity (Ltr)', M1: 'Rate (₹/Ltr)',
    N1: 'IOCL RSP (₹/Ltr)', R1: 'Grand Total (₹)', S1: 'XtraPower Points', U1: 'Amount in Words', W1: 'Printed On', X1: 'Printed By',
  }, {
    start: 2, col: 'A', rows: [
      [1, 'PI/2026-27/001', date('2026-08-17'), date('2026-08-31'), XPC.company, '', '', 4500000001, '', '', '', 12000, 99.5, 100.74, '', '', '', 1194000, 0, '', 'Rupees Eleven Lakh Ninety Four Thousand Only', '', { t: 'n', v: 46251.363229 }, 'Owner'],
      // pasted from the app's download: dates as text
      [2, 'PI/2026-27/002', '31 Oct 2026', '31 Oct 2026', DEMO.company, '', '', '', '', '', '', 40000, 99.5, 100.74, '', '', '', 3980000, 0, '', '', '', '4/11/2026, 2:19:12 PM', 'owner@example.com'],
    ],
  });
  return {
    SheetNames: ['Customers', 'PI Log'],
    Sheets: { Customers: customers, 'PI Log': log },
  };
}

test('reading the Tanker Billing workbook', () => {
  const r = readTankerBilling(workbook());
  assert.deepEqual(r.customers.map((c) => [c.company, c.hsd_rate, c.price_tier]), [[DEMO.company, 100, 'Linked Price'], [XPC.company, 99.5, 'Bulk Price']]);
  assert.deepEqual(r.customers[1].address, [XPC.address[0], XPC.address[1], '']);
  assert.equal(r.customers[1].po_no, '2120000001');
  assert.equal(r.pi_log.length, 2);
  assert.deepEqual([r.pi_log[1].pi_date, r.pi_log[1].valid_to, r.pi_log[1].printed_at], ['2026-10-31', '2026-10-31', '2026-11-04T14:19:12+05:30']);
  assert.deepEqual(r.warnings, ['PI Log row 3: the dates are text, not Excel dates — read as dates here; in Excel, format those cells as dates (or paste rows from the app\'s Download log, which now has real dates).']);
  assert.deepEqual([r.pi_log[0].pi_no, r.pi_log[0].pi_date, r.pi_log[0].valid_to, r.pi_log[0].po_no, r.pi_log[0].grand_total],
    ['PI/2026-27/001', '2026-08-17', '2026-08-31', '4500000001', 1194000]);
  assert.equal(r.pi_log[0].printed_at, '2026-08-17T08:43:03+05:30');
  assert.throws(() => readTankerBilling({ SheetNames: [], Sheets: {} }), /no "Customers" sheet/);
});

test('the letterhead and stamp of each sheet are found in the file', () => {
  const files = {
    'xl/workbook.xml': '<sheets><sheet name="Proforma Invoice" sheetId="14" r:id="rId2"/><sheet name="Quotation Maker" sheetId="16" r:id="rId3"/></sheets>',
    'xl/_rels/workbook.xml.rels': '<Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="x" Target="worksheets/sheet3.xml"/>',
    'xl/worksheets/_rels/sheet2.xml.rels': '<Relationship Id="rId1" Type="x" Target="../drawings/drawing2.xml"/>',
    'xl/worksheets/_rels/sheet3.xml.rels': '<Relationship Id="rId1" Type="x" Target="../drawings/drawing3.xml"/>',
    'xl/drawings/drawing2.xml': '<xdr:twoCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:row>43</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:twoCellAnchor><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId2"/></xdr:pic></xdr:twoCellAnchor>',
    'xl/drawings/_rels/drawing2.xml.rels': '<Relationship Id="rId2" Type="x" Target="../media/image2.png"/><Relationship Id="rId1" Type="x" Target="../media/image3.png"/>',
    'xl/drawings/drawing3.xml': '<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:twoCellAnchor>',
    'xl/drawings/_rels/drawing3.xml.rels': '<Relationship Id="rId1" Type="x" Target="../media/image4.tmp"/>',
  };
  assert.deepEqual(picturePaths(files), {
    proforma: { stamp: 'xl/media/image3.png', letterhead: 'xl/media/image2.png' },
    quotation: { letterhead: 'xl/media/image4.tmp' },
  });
});

test('the demo store keeps the PI Log like the database does', async () => {
  const s = memoryStore();
  const res = await s.tankerImport('Tanker Billing.xlsm', {
    customers: [DEMO, XPC, DEMO], data: DATA, images: { pi_stamp: 'data:image/png;base64,AA', quote_stamp: 'nope' },
    pi_log: [{ log_id: 1, pi_no: 'PI/2026-27/001', customer: XPC.company, qty: 1 }, { log_id: 1, pi_no: 'PI/2026-27/002', customer: DEMO.company, qty: 2 }],
  });
  assert.deepEqual([res.customers, res.pi_new, res.pi_updated, res.pi_kept, res.images], [2, 2, 0, 0, 1]);
  assert.deepEqual((await s.piList()).map((r) => [r.id, r.pi_no]), [[1, 'PI/2026-27/001'], [2, 'PI/2026-27/002']]);
  const row = { pi_no: 'pi/2026-27/002', pi_date: '2026-11-03', customer: DEMO.company, qty: 5, rate: 100, grand_total: 500 };
  assert.equal((await s.piSave(row)).status, 'exists');
  const rep = await s.piSave(row, true);
  assert.deepEqual([rep.status, rep.row.id, rep.row.source], ['replaced', 2, 'app']);
  assert.equal((await s.piSave({ ...row, pi_no: 'PI/2026-27/003' })).row.id, 3);
  await assert.rejects(() => s.piSave({ ...row, qty: 0 }), /Quantity is missing or zero/);
  await assert.rejects(() => s.piSave({ ...row, pi_no: '' }), /Proforma Invoice No\. is blank/);
  const again = await s.tankerImport('Tanker Billing.xlsm', { customers: [], data: DATA, pi_log: [{ pi_no: 'PI/2026-27/002', customer: 'X', qty: 9 }] });
  assert.deepEqual([again.pi_new, again.pi_updated, again.pi_kept], [0, 0, 1]);
  assert.equal((await s.tankerList()).length, 2);
  await s.piDelete(3);
  await assert.rejects(() => s.piDelete(3), /No PI Log entry 3/);
  await s.setSetting('quote_stamp', { data_url: 'data:image/png;base64,BB' });
  assert.equal((await s.setting('tanker_billing')).file_name, 'Tanker Billing.xlsm');
});

test('re-importing: Excel\'s PI Log checked against the app\'s', () => {
  const excel = [
    { pi_no: 'PI/2026-27/001', pi_date: '2026-08-17', customer: 'Demo Power Ltd', po_no: '4500000001', qty: 12000, rate: 99.5, rsp: 100.74, grand_total: 1194000, points: 0 },
    { pi_no: 'PI/2026-27/002', pi_date: '2026-08-20', customer: 'Twin Steel Ltd', qty: 18000, rate: 99.5, grand_total: 1791000 },
    { pi_no: 'PI/2026-27/003', pi_date: '2026-08-25', customer: 'Crew One', qty: 3000, rate: 100, grand_total: 300000 },
    { pi_no: 'pi/2026-27/003 ', pi_date: '2026-08-26', customer: 'Crew One', qty: 1 },
    { pi_no: 'PI/2026-27/005', pi_date: '2026-09-01', customer: 'New One', qty: 5 },
  ];
  const app = [
    { id: 1, pi_no: 'PI/2026-27/001', pi_date: '2026-08-17', customer: 'Demo Power Ltd', po_no: 4500000001, qty: '12000', rate: 99.5, rsp: 100.74, grand_total: 1194000, points: null, source: 'workbook' },
    { id: 2, pi_no: 'PI/2026-27/002', pi_date: '2026-08-20', customer: 'Twin Steel Ltd', qty: 12000, rate: 99.5, grand_total: 1194000, source: 'workbook' },
    { id: 3, pi_no: 'PI/2026-27/003', pi_date: '2026-08-25', customer: 'Crew One', qty: 3000, rate: 99.9, grand_total: 299700, source: 'app' },
    { id: 4, pi_no: 'PI/2026-27/004', pi_date: '2026-08-28', customer: 'Made Here', qty: 9, source: 'app' },
  ];
  const c = comparePiLog(excel, app);
  assert.equal(c.same, 1);                                             // 4500000001 as a number or text, 0 or no points: alike
  assert.deepEqual(c.differ.map((d) => [d.pi_no, d.kept, d.changes.map((x) => x.field)]), [
    ['PI/2026-27/002', 'excel', ['qty', 'grand_total']],
    ['PI/2026-27/003', 'app', ['rate', 'grand_total']],
  ]);
  assert.deepEqual([c.differ[0].changes[0].excel, c.differ[0].changes[0].app], [18000, 12000]);
  assert.deepEqual(c.new_from_excel.map((r) => r.pi_no), ['PI/2026-27/005']);
  assert.deepEqual(c.missing_in_excel.map((r) => [r.pi_no, r.source]), [['PI/2026-27/004', 'app']]);
  assert.deepEqual(c.twice_in_excel.map((r) => r.pi_no), ['pi/2026-27/003']);
  assert.deepEqual(c.excel_nos, ['PI/2026-27/001', 'PI/2026-27/002', 'PI/2026-27/003', 'PI/2026-27/005']);
  assert.equal(piCheckClean(c), false);
  assert.equal(piCheckClean(comparePiLog(excel.slice(0, 1), app.slice(0, 1))), true);
});
