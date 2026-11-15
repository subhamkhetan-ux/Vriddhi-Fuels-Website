// The SCPL bill (the workbook's modSCPLBilling macro in the app).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bestGuess, classify, docText, indian, numStr, scplBill, scplBillSvg, scplCustomers, scplDefaultRange, scplDocXml,
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

test('scplBillSvg: a page per category, TOTAL in red on the last', () => {
  const sales = [];
  for (let i = 0; i < 40; i++) sales.push(sale(i + 1, `2026-11-${String(1 + (i % 10)).padStart(2, '0')}`, String(100 + i), 'Transporting', 1000 + i));
  sales.push(sale(99, '2026-11-04', '500', 'Consumer', 250));
  const svgs = scplBillSvg(scplBill(sales, { from: '2026-11-01', to: '2026-11-10' }));
  assert.equal(svgs.length, 3);                                     // 40 rows run on to a second page
  assert.match(svgs[0], /Transporting/);
  assert.doesNotMatch(svgs[0], />TOTAL</);
  assert.match(svgs[1], />TOTAL</);
  assert.match(svgs[1], /fill="#ff0000"/);
  assert.match(svgs[2], /Consumer/);
  assert.match(svgs[2], /01-11-2026/);
  assert.match(svgs[2], /10-11-2026/);
});

// a small Word document shaped like the template: two dates (one split over
// runs, as Word saves them), a table with a header and a TOTAL row, a text box
const DOC = `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:wp="wp"><w:body>
<w:p><w:r><w:t>Bill for the period </w:t></w:r><w:r><w:t>01-10-</w:t></w:r><w:r><w:t>2026</w:t></w:r><w:r><w:t xml:space="preserve"> to 10-10-2026</w:t></w:r></w:p>
<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>Date</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Bill No</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Vehicle</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Quantity</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Rate/Ltr</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>old</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>
<w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>TOTAL</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing><wp:anchor><wp:docPr id="3" name="Text Box 3"/></wp:anchor></w:drawing></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

test('scplDocXml fills the Word template as the macro does', () => {
  const sales = [sale(1, '2026-11-03', '9', 'Transporting', 1500), sale(2, '2026-11-04', '10', 'Consumer', 300.25), sale(3, '2026-11-02', '8', 'Transporting', 100)];
  const xml = scplDocXml(DOC, scplBill(sales, { from: '2026-11-01', to: '2026-11-10' }));
  const text = docText(xml);
  assert.match(text, /Bill for the period 01-11-2026 to 10-11-2026/);
  assert.doesNotMatch(text, /old|10-10-2026/);
  // both pages: the body copied after a page break, one table each
  assert.equal((xml.match(/<w:tbl>/g) || []).length, 2);
  assert.equal((xml.match(/<w:br w:type="page"\/>/g) || []).length, 1);
  const [t1, t2] = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g);
  assert.equal((t1.match(/<w:tr>/g) || []).length, 4);                 // header, 2 bills, TOTAL
  assert.match(docText(t1), /02\/11\/268Transporting10090\.509,050/);
  assert.match(docText(t1), /TOTAL1600\.00₹1,44,800$/);
  assert.match(docText(t2), /Consumer300\.25/);
  assert.match(t1, /w:color w:val="FF0000"/);
  assert.match(t1, /<w:sz w:val="28"\/>/);
  // the sectPr stays last, and the copied text box got its own id
  assert.ok(xml.indexOf('<w:sectPr') > xml.lastIndexOf('</w:tbl>'));
  assert.deepEqual([...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]), ['3', '1003']);
  // one category only: no second page
  const one = scplDocXml(DOC, scplBill([sales[2]], { from: '2026-11-01', to: '2026-11-10' }));
  assert.equal((one.match(/<w:tbl>/g) || []).length, 1);
  assert.equal((one.match(/w:type="page"/g) || []).length, 0);
});
