// The consignment note PDF: FY-correct serials, the fields written on the form.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { A5, blankFields, blankPrefix, buildNotePdf, fyCode, noteFields, TERMINALS } from '../../payments/consignment_pdf.js';

test('the financial year runs 1 Apr – 31 Mar, in IST', () => {
  assert.equal(fyCode(new Date('2026-11-13T04:00:00Z')), '2627');
  assert.equal(fyCode(new Date('2027-03-31T18:29:00Z')), '2627');   // 31 Mar 2027 23:59 IST
  assert.equal(fyCode(new Date('2027-03-31T18:31:00Z')), '2728');   // 1 Apr 2027 00:01 IST
  assert.equal(fyCode(new Date('2028-04-01T00:00:00Z')), '2829');
  assert.equal(fyCode(new Date('2099-06-01T00:00:00Z')), '9900');
  assert.equal(blankPrefix(new Date('2027-04-01T06:00:00Z')), 'VF/CN2728/');
});

test('a filled note writes its serial, date, quantities, value and invoice', () => {
  const f = noteFields({ serial_str: 'VF/CN2627/187', reporting_date: '13/11/2026', columns: { HSD: '22', Other: '9' },
    value: 2159219, invoice_no: '7013019147', invoice_date: '12/11/2026', origin: 'Jharsuguda Terminal, Jharsuguda, Odisha' });
  assert.deepEqual(f, { serial: 'VF/CN2627/187', date: '13/11/2026', origin: 'Jharsuguda Terminal, Jharsuguda, Odisha', qty: { HSD: '22' },
    value: '2159219/-', invoiceNo: '7013019147', invoiceDate: '12/11/2026' });
  // another terminal replaces the printed Jharsuguda one
  assert.equal(noteFields({ origin: 'Paradeep Terminal, Paradeep, Odisha' }).origin, 'Paradeep Terminal, Paradeep, Odisha');
  assert.deepEqual(noteFields(null).blank, true);
});

test('a blank note for a terminal: Jharsuguda (default, printed), Paradeep, or one typed in', () => {
  const d = new Date('2027-04-02T06:00:00Z');
  assert.deepEqual(blankFields(null, d), { serial: 'VF/CN2728/', blank: true, origin: 'Jharsuguda Terminal, Jharsuguda, Odisha' });
  assert.equal(blankFields(TERMINALS[0].origin).origin, 'Jharsuguda Terminal, Jharsuguda, Odisha');
  assert.equal(blankFields(TERMINALS.find((t) => t.key === 'paradeep').origin).origin, 'Paradeep Terminal, Paradeep, Odisha');
  assert.equal(blankFields('  Balasore   Terminal, Balasore, Odisha ').origin, 'Balasore Terminal, Balasore, Odisha');
  assert.equal(blankFields('x'.repeat(200)).origin.length, 90);
});

// The PDF itself, when pdf-lib is to hand (the app loads it from the CDN).
let PDFLib = null;
try { PDFLib = await import('pdf-lib'); } catch { /* not installed here */ }
test('the PDF is one A5 page on the form', { skip: !PDFLib && 'pdf-lib is not installed' }, async () => {
  const tpl = fs.readFileSync(new URL('../../payments/consignment_note_template.pdf', import.meta.url));
  for (const fields of [noteFields({ serial_str: 'VF/CN2728/001', columns: { HSD: '22' }, value: 1 }), noteFields(null), blankFields('A Very Long Terminal Name Somewhere Far Away, Some District, Some State')]) {
    const doc = await PDFLib.PDFDocument.load(await buildNotePdf(PDFLib, tpl, fields));
    assert.equal(doc.getPageCount(), 1);
    const { width, height } = doc.getPage(0).getSize();
    assert.deepEqual([Math.round(width), Math.round(height)], A5.map(Math.round));
  }
});
