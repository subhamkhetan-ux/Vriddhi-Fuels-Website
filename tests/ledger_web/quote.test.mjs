// Quotes: the Tanker Billing workbook's Quotation Maker, Proforma Invoice and
// PI Log. All names and numbers are made up.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  customerRate, firstTwoWords, hsdRsp, nextPiNo, piDiscount, piEffective, piFileName, piFromLog, piLogRow, piMatches, picturePaths,
  piValidTo, productRate, proformaCalc, proformaValues, quotationCalc, quotationValues, quoteFileName, readTankerBilling, rupeesInWords,
  samePiNo, splitDash,
} from '../../ledger/js/quote.js';
import { LAYOUTS } from '../../ledger/js/sheet-layouts.js';
import { sheetSvg, wrapLines } from '../../ledger/js/sheet-svg.js';
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

test('amount in words: the Proforma\'s formula, word for word', () => {
  assert.equal(rupeesInWords(14925000), 'Rupees One Crore Forty Nine Lakh Twenty Five Thousand Only');
  assert.equal(rupeesInWords(1196880), 'Rupees Eleven Lakh Ninety Six Thousand Eight Hundred Eighty Only');
  assert.equal(rupeesInWords(4000000), 'Rupees Forty Lakh Only');
  assert.equal(rupeesInWords(120034501), 'Rupees Twelve Crore Thirty Four Thousand Five Hundred One Only');
  assert.equal(rupeesInWords(20), 'Rupees Twenty Only');
  assert.equal(rupeesInWords(0), 'Rupees Zero Only');
  assert.equal(rupeesInWords(99.6), 'Rupees One Hundred Only');
});

test('valid up to: the 15th for 1st–15th, otherwise month-end', () => {
  assert.equal(piValidTo('2026-11-03'), '2026-11-15');
  assert.equal(piValidTo('2026-11-15'), '2026-11-15');
  assert.equal(piValidTo('2026-11-16'), '2026-11-30');
  assert.equal(piValidTo('2028-02-20'), '2028-02-29');
  assert.equal(piValidTo(''), '');
});

test('file names as the macros make them', () => {
  assert.equal(firstTwoWords('M/s. Ankita Air Products Private Limited'), 'Ankita Air');
  assert.equal(firstTwoWords('M/S Ultratech Cement Ltd'), 'Ultratech Cement');
  assert.equal(firstTwoWords('MS  Sample\nTraders'), 'Sample Traders');
  assert.equal(piFileName('Sample Metals and Energy Ltd', '2026-08-17'), 'Sample Metals PI 17 August 2026.pdf');
  assert.equal(piFileName('Twin/Steel Ltd', '2026-08-01'), 'Twin-Steel Ltd PI 1 August 2026.pdf');
  assert.equal(quoteFileName('', '2026-11-03'), 'Customer Quotation 3 November 2026.pdf');
});

test('rates: the workbook\'s own, or each tier worked out again for another RSP', () => {
  assert.equal(hsdRsp(DATA), 100.74);
  assert.equal(customerRate(DATA, DEMO), 100);
  assert.equal(customerRate(DATA, DEMO, 102), 101.26);                 // =P2-0.74 follows the RSP
  assert.equal(customerRate(DATA, XPC, 102), 99.5);                    // a typed-in rate stays
  assert.equal(customerRate(DATA, { ...XPC, price_tier: 'HSD RSP' }, 102), 102);
  assert.equal(productRate(DATA, DEMO, 'Motor Spirit (Petrol)'), 109.01);
  assert.equal(productRate(DATA, DEMO, 'XtraGreen Diesel'), 106.34);
  assert.equal(productRate(DATA, DEMO, 'Lubricants'), null);
  assert.equal(productRate(DATA, DEMO, 'High Speed Diesel (HSD)'), 100);
  assert.deepEqual(splitDash('Branch Name– DEMO BANK, HEAD OFFICE'), ['Branch Name', 'DEMO BANK, HEAD OFFICE']);
  assert.deepEqual(splitDash('Payment Details:'), ['Payment Details:', '']);
});

test('quotation: the Quotation Maker\'s formulas', () => {
  const q = { customer: DEMO, date: '2026-11-03', valid_till: 'Next price revision by IOCL', contact: '00000 00000', email: 'demo@example.com' };
  const c = quotationCalc(DATA, q);
  assert.equal(c.rate, 100);
  assert.equal(c.discount.toFixed(2), '0.74');
  assert.equal((c.pct * 100).toFixed(2), '0.73');
  assert.equal(c.xtra, false);
  const { values: v } = quotationValues(DATA, q);
  assert.match(v.A12, /flat discount of ₹0\.74 per Litre .* net billing price of ₹100\.00 per Litre\.$/);
  assert.equal(v.E5, '03/11/2026');
  assert.equal(v.E17, 'IOCL RSP as on 03/11/2026');
  assert.deepEqual([v.D17, v.D18, v.D19], ['₹100.74', '(₹0.74)', '₹100.00']);
  assert.equal(v.E19, 'Billing rate – FOR your site');
  assert.equal(v.A26, 'BANK DETAILS FOR PAYMENT (100% ADVANCE – RTGS / NEFT)');
  assert.deepEqual([v.A27, v.C27, v.A28, v.C28, v.A29, v.C29], ['Beneficiary Name', 'Demo Fuels', 'Account No.', '000011112222', 'IFSC Code', 'DEMO0000001']);
  assert.match(v.A33, /call us at 00000 00000 or write to demo@example\.com\.$/);

  const x = quotationValues(DATA, { ...q, customer: XPC }).values;
  assert.match(x.A12, /Being an XtraPower customer, you also earn XtraPower points worth approx\. ₹0\.36 per Litre \(net of TDS\), bringing your effective price down to ₹99\.14 per Litre\.$/);
  assert.equal(x.E19.text, 'Effective ₹99.14/Ltr after XtraPower points (36 paise/₹100 net)');
  assert.equal(x.E19.c, '#008000');                                    // the conditional format on E19:F19
  assert.equal(x.A26, 'BANK DETAILS – XTRAPOWER ACCOUNT (100% ADVANCE)');
  assert.deepEqual([x.A30, x.C30], ['Branch Name', 'DEMO BANK, HEAD OFFICE']);
});

test('proforma invoice: the sheet\'s formulas', () => {
  const p = { pi_no: 'PI/2026-27/013', date: '2026-11-03', customer: DEMO, place: 'Odisha (21)', contact: 'Contact Person / Mob:', description: 'High Speed Diesel (HSD)', hsn: '27101930', qty: 40000, rate: 100 };
  const c = proformaCalc(DATA, p);
  assert.deepEqual([c.amount, c.grand, c.roundOff, c.points, c.validTo], [4000000, 4000000, 0, 0, '2026-11-15']);
  const { values: v } = proformaValues(DATA, p);
  assert.equal(v.G6, '15/11/2026');
  assert.equal(v.E19, '40,000');
  assert.equal(v.G19, '40,00,000.00');
  assert.equal(v.G25, '₹40,00,000');
  assert.equal(v.C27, 'Rupees Forty Lakh Only');
  assert.equal(v.A24, 'Retail Selling Price at our RO: Rs.100.74/Ltr      Less: Special Discount Rs.0.74/Ltr      Net Offer Price: Rs.100.00/Ltr');
  assert.equal(v.A25, 'Total benefit passed on to you on this supply: Rs.29,600 (on 40,000 Ltr). Discount is applied on the prevailing IOCL RSP at every price revision.');
  assert.equal(v.A26, '');
  assert.deepEqual([v.A30, v.A33, v.E12, v.E15], [PAY[1], PAY[4], DEMO.company, DEMO.address[2]]);

  // amount = TRUNC(qty × rate): paise dropped
  assert.equal(proformaCalc(DATA, { ...p, qty: 333, rate: 99.99 }).amount, 33296);

  // no discount: the other wording
  const plain = proformaValues(DATA, { ...p, rate: 100.74 }).values;
  assert.equal(plain.A24, 'Rate as per prevailing IOCL Retail Selling Price at our RO: Rs.100.74/Ltr');
  assert.equal(plain.A25, 'Price is revised in line with every IOCL price revision. Delivery at your site is free of cost.');

  // XtraPower: points and the green line
  const xp = proformaValues(DATA, { ...p, customer: XPC, qty: 150000, rate: 99.5 });
  assert.equal(xp.calc.points, 53730);
  assert.equal(xp.calc.effective.toFixed(4), '99.1418');
  assert.equal(xp.values.A26, 'XtraPower Benefit: Earn 40 paise of XtraPower points per Rs.100 paid; after 10% TDS deducted by IOCL, net 36 paise per Rs.100 - approx. 53,730 points on this supply. Effective price after points: Rs.99.14/Ltr.');
  assert.equal(xp.values.C27, 'Rupees One Crore Forty Nine Lakh Twenty Five Thousand Only');
});

test('the PI Log: a row, its derived columns, a reprint and the next number', () => {
  const p = { pi_no: ' PI/2026-27/004 ', date: '2026-08-28', customer: DEMO, po_no: 'PO-1', place: 'Odisha (21)', contact: 'Contact Person / Mob:', description: 'High Speed Diesel (HSD)', hsn: '27101930', qty: 12000, rate: 99.74, rsp: 100.74 };
  const row = piLogRow(DATA, p, 'owner@example.com');
  assert.equal(row.pi_no, 'PI/2026-27/004');
  assert.equal(row.valid_to, '2026-08-31');
  assert.equal(row.gstin, DEMO.address[2]);
  assert.equal(row.grand_total, 1196880);
  assert.equal(row.words, 'Rupees Eleven Lakh Ninety Six Thousand Eight Hundred Eighty Only');
  assert.deepEqual(row.doc.address, DEMO.address);
  assert.equal(piDiscount(row).toFixed(2), '1.00');
  assert.equal(piEffective(row), 99.74);

  // a reprint keeps the historic rate / RSP / PO; a PI from Excel takes today's address
  const back = piFromLog({ ...row, doc: null, customer: 'Demo Coal Mines Private Limited' }, [{ ...DEMO, address: ['New road', '', ''] }]);
  assert.deepEqual([back.rate, back.rsp, back.po_no, back.customer.address[0]], [99.74, 100.74, 'PO-1', 'New road']);
  assert.equal(proformaValues(DATA, back).values.G25, '₹11,96,880');

  const log = [{ pi_no: 'PI/2026-27/009' }, { pi_no: 'pi/2026-27/011' }, { pi_no: 'PI/2025-26/040' }];
  assert.equal(nextPiNo(log, '2026-11-03'), 'PI/2026-27/012');
  assert.equal(nextPiNo(log, '2027-04-01'), 'PI/2027-28/001');
  assert.ok(samePiNo(' PI/2026-27/011', 'pi/2026-27/011 '));
  assert.ok(piMatches({ pi_date: '2026-10-02', customer: 'Demo Coal Mines' }, { customer: 'coal', from: '2026-10-01', to: '2026-10-31' }));
  assert.ok(!piMatches({ pi_date: '2026-09-30', customer: 'Demo Coal Mines' }, { customer: '', from: '2026-10-01', to: '2026-10-31' }));
});

// a Tanker Billing workbook, as SheetJS reads it
function workbook() {
  const customers = sheet({
    A1: 'Company', B1: 'HSD', C1: 'Address 1', D1: 'Address 2', E1: 'Address 3', F1: 'Payment 1', G1: 'Payment 2', H1: 'Payment 3',
    I1: 'Payment 4', J1: 'Payment 5', K1: 'PO Label', L1: 'PO No.', M1: 'Price Tier',
    O1: 'Price Tier', P1: 'Rate', R1: 'Product', S1: 'Rate', U1: 'Fuel Type',
    O2: 'HSD RSP', P2: 100.74, O3: 'Bulk Price', P3: 99.5, O4: 'Linked Price', P4: formula(100, 'P2-0.74'),
    R2: 'Motor Spirit', S2: 109.01, U2: 'High Speed Diesel', U3: 'Motor Spirit',
    W2: 'Points earned (paise per ₹100 paid)', X2: 40, W3: 'TDS deducted by IOCL on points', X3: 0.1, W4: 'Net points credited', X4: formula(36, 'X2*(1-X3)'),
  }, {
    start: 2, col: 'A', rows: [
      [DEMO.company, formula(100), ...DEMO.address, ...PAY, ' ', 'PO-1', 'Linked Price'],
      [XPC.company, formula(99.5), XPC.address[0], XPC.address[1], ' ', ...XP_PAY, 'P.O. No.:', 2120000001, 'Bulk Price'],
      [DEMO.company, 1],                                              // listed twice: the first is kept
    ],
  });
  const qm = sheet({ H5: 'Valid Till', I5: 'Next price revision by IOCL', H7: 'Contact No.', I7: '00000 00000', H8: 'Email', I8: 'demo@example.com', A13: 'Our own words.' });
  const pi = sheet({ G4: 'PI/2026-27/013', G9: 'Odisha (21)', D19: '27101930', E16: 'Contact Person / Mob:', B19: 'High Speed Diesel (HSD)', E40: '9.  Claims within 48 hours.' });
  const log = sheet({
    A1: 'Log ID', B1: 'PI No.', C1: 'PI Date', D1: 'Valid Up To', E1: 'Customer', H1: 'P.O. No.', L1: 'Quantity (Ltr)', M1: 'Rate (₹/Ltr)',
    N1: 'IOCL RSP (₹/Ltr)', R1: 'Grand Total (₹)', S1: 'XtraPower Points', U1: 'Amount in Words', W1: 'Printed On', X1: 'Printed By',
  }, {
    start: 2, col: 'A', rows: [[1, 'PI/2026-27/001', date('2026-08-17'), date('2026-08-31'), XPC.company, '', '', 4500000001, '', '', '', 12000, 99.5, 100.74, '', '', '', 1194000, 0, '', 'Rupees Eleven Lakh Ninety Four Thousand Only', '', { t: 'n', v: 46251.363229 }, 'Owner']],
  });
  return {
    SheetNames: ['Customers', 'Quotation Maker', 'Proforma Invoice', 'PI Log'],
    Sheets: { Customers: customers, 'Quotation Maker': qm, 'Proforma Invoice': pi, 'PI Log': log },
    Workbook: { Names: [{ Name: 'HSD_RSP', Ref: "'Customers'!$P$2" }, { Name: 'XP_Net', Ref: "'Customers'!$X$4" }] },
  };
}

test('reading the Tanker Billing workbook', () => {
  const r = readTankerBilling(workbook());
  assert.deepEqual(r.customers.map((c) => [c.company, c.hsd_rate, c.price_tier]), [[DEMO.company, 100, 'Linked Price'], [XPC.company, 99.5, 'Bulk Price']]);
  assert.deepEqual(r.customers[1].address, [XPC.address[0], XPC.address[1], '']);
  assert.equal(r.customers[1].po_no, '2120000001');
  assert.deepEqual(r.data.rate_card, [
    { tier: 'HSD RSP', rate: 100.74, rsp_offset: null }, { tier: 'Bulk Price', rate: 99.5, rsp_offset: null },
    { tier: 'Linked Price', rate: 100, rsp_offset: -0.74 },
  ]);
  assert.deepEqual(r.data.product_rates, { 'Motor Spirit': 109.01 });
  assert.deepEqual(r.data.fuel_types, ['High Speed Diesel', 'Motor Spirit']);
  assert.deepEqual(r.data.xp, { points: 40, tds: 0.1, net: 36 });
  assert.equal(r.data.hsd_rsp, 100.74);
  assert.deepEqual(r.data.quote, { valid_till: 'Next price revision by IOCL', contact: '00000 00000', email: 'demo@example.com', dispatch: '', fleet: '' });
  assert.equal(r.data.pi_sheet.pi_no, 'PI/2026-27/013');
  // wording that differs from the app's copy of the sheets comes along
  assert.equal(r.data.texts.quotation.A13, 'Our own words.');
  assert.equal(r.data.texts.proforma.E40, '9.  Claims within 48 hours.');
  assert.equal(r.data.texts.proforma.A2, '');                          // a blank cell here prints blank
  assert.equal(r.pi_log.length, 1);
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

test('the page: one A4 sheet with the sheet\'s cells, wording and pictures', () => {
  const p = { pi_no: 'PI/2026-27/013', date: '2026-11-03', customer: DEMO, description: 'High Speed Diesel (HSD)', hsn: '27101930', qty: 40000, rate: 100, place: 'Odisha (21)', contact: 'Contact Person / Mob:' };
  const svg = sheetSvg(LAYOUTS.proforma, {
    values: proformaValues(DATA, p).values, texts: { E40: '9.  Claims within 48 hours.' }, images: { letterhead: 'lh.png', stamp: 'st.png' },
  });
  assert.match(svg, /viewBox="0 0 595.28 841.89"/);
  assert.match(svg, /scale\(0\.48\d+\)/);                               // fit to one page, like Excel's 48%
  assert.match(svg, />PROFORMA INVOICE</);
  assert.match(svg, />PI\/2026-27\/013</);
  assert.match(svg, />₹40,00,000</);
  assert.match(svg, />9\.\u00A0\u00A0Claims within 48 hours\.</);   // wording from the workbook
  assert.match(svg, /Rs\.100\.74\/Ltr {6}Less/);                    // Excel's run of spaces is kept
  assert.match(svg, /<image href="lh\.png"/);
  assert.match(svg, /<image href="st\.png"/);
  assert.doesNotMatch(svg, /Dbl-|Shyam|SMC Power/);                    // the layout carries no customer
  const q = sheetSvg(LAYOUTS.quotation, { values: quotationValues(DATA, { customer: XPC, date: '2026-11-03' }).values });
  assert.match(q, /fill="#008000">Effective ₹99\.14\/Ltr/);
  assert.deepEqual(wrapLines('one two three four', 40, { s: 10 }, (t) => t.length * 5), ['one two', 'three', 'four']);
});

test('the demo store keeps the PI Log like the database does', async () => {
  const s = memoryStore();
  const res = await s.tankerImport('Tanker Billing.xlsm', {
    customers: [DEMO, XPC, DEMO], data: DATA, images: { pi_stamp: 'data:image/png;base64,AA', quote_stamp: 'nope' },
    pi_log: [{ log_id: 1, pi_no: 'PI/2026-27/001', customer: XPC.company, qty: 1 }, { log_id: 1, pi_no: 'PI/2026-27/002', customer: DEMO.company, qty: 2 }],
  });
  assert.deepEqual([res.customers, res.pi_new, res.pi_updated, res.pi_kept, res.images], [2, 2, 0, 0, 1]);
  assert.deepEqual((await s.piList()).map((r) => [r.id, r.pi_no]), [[1, 'PI/2026-27/001'], [2, 'PI/2026-27/002']]);
  const row = piLogRow(DATA, { pi_no: 'pi/2026-27/002', date: '2026-11-03', customer: DEMO, qty: 5, rate: 100 });
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
  assert.equal((await s.setting('tanker_billing')).hsd_rsp, 100.74);
});
