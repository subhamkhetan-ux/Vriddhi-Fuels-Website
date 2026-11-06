// Quotations and Proforma Invoices made from the workbook model: the demo
// workbook (ledger/js/demo-workbook.js) is the real Tanker Billing sheets'
// design, formulas and Print & Log PI macro with made-up customers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEMO_WORKBOOK as M } from '../../ledger/js/demo-workbook.js';
import {
  customerRow, docCalc, docFileName, helperRows, inputsOf, layoutOf, pageValues, piLogRowOf, piMacro, piProblem, piStateFromLog, rspCell,
  selfCheck,
} from '../../ledger/js/docs.js';
import { basicFormat, isoToSerial, makeCalc } from '../../ledger/js/formula.js';
import { sheetSvg } from '../../ledger/js/sheet-svg.js';
import { decompress } from '../../ledger/js/vba.js';
import { buildModel, readStyles } from '../../ledger/js/xl-model.js';

const QM = 'Quotation Maker';
const PI = 'Proforma Invoice';
const macro = piMacro(M);

test('every formula of the workbook comes out as Excel saved it', () => {
  const r = selfCheck(M);
  assert.ok(r.count > 60, `only ${r.count} formulas`);
  assert.deepEqual(r.bad, []);
  assert.deepEqual(r.unknown, []);
});

test('the PI Log is filled as the Print & Log PI macro says', () => {
  assert.equal(macro.from, 'macro');
  assert.deepEqual(
    [macro.write.pi_no, macro.write.pi_date, macro.write.valid_to, macro.write.customer, macro.write.qty, macro.write.rate, macro.write.rsp, macro.write.grand_total, macro.write.points, macro.write.words],
    ['G4', 'G5', 'G6', 'A12', 'E19', 'F19', 'Customers!P2', 'G25', 'K25', 'C27'],
  );
  assert.deepEqual(Object.keys(macro.load).sort(), ['contact', 'customer', 'description', 'hsn', 'pi_date', 'pi_no', 'place', 'po_date', 'po_no', 'qty', 'rate', 'rsp']);
  assert.deepEqual(macro.required.map((x) => [x.addr, x.positive]), [['G4', false], ['A12', false], ['E19', true]]);
  assert.deepEqual(macro.pdf, { customer: 'A12', date: 'G5', word: 'PI' });
  assert.deepEqual(rspCell(M, macro), { sheet: 'Customers', addr: 'P2' });
  // no macro: the app's own copy of the mapping
  assert.equal(piMacro({ ...M, vba: {} }).from, 'default');
});

test('the form asks for the sheet\'s input cells, named as the sheet names them', () => {
  const calc = makeCalc(M);
  const q = inputsOf(M, 'quotation', calc);
  assert.deepEqual(q.map((x) => [x.addr, x.label, x.kind]), [
    ['A5', 'QUOTATION TO', 'select'], ['I5', 'Valid Till', 'text'], ['I6', 'Quotation Date', 'date'], ['I7', 'Contact No.', 'text'],
    ['I8', 'Email', 'text'], ['I9', 'Dispatch', 'textarea'], ['I10', 'Fleet Available', 'textarea'],
  ]);
  assert.deepEqual(q[0].options, ['Crew One Logistics', 'Demo Power Ltd', 'Sample Metals Ltd', 'Twin Steel Ltd, UNIT I']);
  assert.equal(q[2].formula, true);                                           // =TODAY(): worked out unless typed over
  const p = inputsOf(M, 'proforma', calc, macro);
  assert.deepEqual(p.map((x) => x.addr), ['G4', 'G5', 'G7', 'G8', 'G9', 'A12', 'E16', 'B19', 'D19', 'E19', 'F19']);
  assert.equal(p.find((x) => x.addr === 'G8').kind, 'date');
  assert.equal(p.find((x) => x.addr === 'B19').options.length, 4);
  assert.equal(p.find((x) => x.addr === 'E16').label, 'Contact Person / Mob');
  const h = helperRows(M, 'quotation', q);
  assert.ok(h.some((x) => x.kind === 'pair' && x.addr === 'I13' && /Offer/.test(x.label)));
  assert.ok(h.some((x) => x.kind === 'pair' && x.addr === 'I24' && x.label === 'Payment Terms'));
});

test('a quotation: the sheet\'s formulas with what was typed in', () => {
  const calc = docCalc(M, 'quotation', { inputs: { A5: 'Demo Power Ltd', I6: isoToSerial('2026-11-06') } }, { format: basicFormat });
  const v = pageValues(M, 'quotation', calc, basicFormat);
  assert.equal(v.A6.text, 'At- Demo Industrial Estate');
  assert.equal(v.E5.text, '06/11/2026');
  assert.match(v.A12.text, /flat discount of ₹0\.50 per Litre/);
  assert.equal(v.C25.text, 'Payment within 15 days from the date of receipt of material and invoice.');   // Bulk Price: N Days, 15
  assert.equal(v.A26.text, 'BANK DETAILS FOR PAYMENT (RTGS / NEFT)');                                      // not advance
  assert.equal(docFileName('quotation', calc, { customerAddr: 'A5', dateAddr: 'I6' }), 'Demo Power Quotation 6 November 2026.pdf');
  // an XtraPower customer: the conditional format turns the remark bold green
  const x = pageValues(M, 'quotation', docCalc(M, 'quotation', { inputs: { A5: 'Sample Metals Ltd' } }), basicFormat);
  assert.match(x.E19.text, /Effective ₹89\.70\/Ltr after XtraPower points/);
  assert.deepEqual([x.E19.b, x.E19.c], [1, '#008000']);
  assert.match(x.A26.text, /XTRAPOWER ACCOUNT/);
  // another RSP: tiers written as =P2-0.5 follow it, a tier on another tier follows that one
  const at = (cust, rsp) => docCalc(M, 'quotation', { inputs: { A5: cust }, rsp }, { macro }).value(QM, 'I13');
  assert.equal(at('Demo Power Ltd', 92), 91.5);
  assert.equal(at('Crew One Logistics', 92), 92);
  assert.equal(at('Sample Metals Ltd', 92), 90.02);                          // typed in: stays
  assert.equal(Math.round(at('Twin Steel Ltd, UNIT I', 92) * 100) / 100, 89.28);    // Twin Price − 0.74
  // a calculated cell changed for this quotation only
  const own = docCalc(M, 'quotation', { inputs: { A5: 'Demo Power Ltd' }, overrides: { I24: 'Payment against delivery.' } });
  assert.equal(own.value(QM, 'C25'), 'Payment against delivery.');
});

test('a proforma invoice: the macro\'s checks, the log row, a reprint', () => {
  const inputs = { G4: 'PI/2026-27/007', G5: isoToSerial('2026-11-20'), A12: 'Sample Metals Ltd', E19: 150000, G7: 'SM-2026-01' };
  const calc = docCalc(M, 'proforma', { inputs }, { macro, format: basicFormat });
  assert.equal(piProblem(calc, macro), '');
  assert.equal(piProblem(docCalc(M, 'proforma', { inputs: { ...inputs, E19: 0 } }, { macro }), macro), 'Quantity is missing or zero.');
  assert.equal(piProblem(docCalc(M, 'proforma', { inputs: { ...inputs, G4: '' } }, { macro }), macro), 'Proforma Invoice No. is blank.');
  const row = piLogRowOf(calc, macro, M, { inputs });
  assert.equal(row.pi_no, 'PI/2026-27/007');
  assert.equal(row.valid_to, '2026-11-30');                                  // after the 15th: month-end
  assert.equal(row.grand_total, 13503000);
  assert.equal(row.words, 'Rupees One Crore Thirty Five Lakh Three Thousand Only');
  assert.equal(Math.round(row.points), 48611);
  assert.equal(row.rsp, 91.02);
  assert.equal(row.doc.customer_row['Address 1'], 'Sample Metals Plant');
  assert.equal(docFileName('proforma', calc, { customerAddr: 'A12', dateAddr: 'G5', word: 'PI' }), 'Sample Metals PI 20 November 2026.pdf');

  // reprint: the historic rate / RSP / PO, and the customer's lines as printed
  const logged = { ...row, rate: 89, rsp: 95, doc: { customer_row: { ...row.doc.customer_row, 'Address 1': 'Old Plant Road' } } };
  const st = piStateFromLog(logged, macro, M);
  const again = docCalc(M, 'proforma', st, { macro, format: basicFormat });
  assert.equal(again.value(PI, 'F19'), 89);
  assert.equal(again.value(PI, 'A13'), 'Old Plant Road');
  assert.equal(again.value(PI, 'G7'), 'SM-2026-01');
  assert.match(again.value(PI, 'A24'), /Rs\.95\.00\/Ltr.*Special Discount Rs\.6\.00/);
  assert.equal(customerRow(M, makeCalc(M), 'Nobody'), null);
});

test('the page: the print area fitted to A4, pictures where Excel puts them', () => {
  const L = layoutOf(M, 'proforma');
  assert.equal(L.cols.length, 8);
  assert.equal(L.rows.length, 49);
  assert.deepEqual(L.images.map((x) => x.key).sort(), ['letterhead', 'stamp']);
  const calc = docCalc(M, 'proforma', { inputs: { A12: 'Demo Power Ltd' } }, { macro });
  const svg = sheetSvg(L, { values: pageValues(M, 'proforma', calc, basicFormat), images: { letterhead: 'lh.png', stamp: 'st.png' } });
  assert.match(svg, /scale\(0\.48\d+\)/);                                   // Excel's 48%
  assert.match(svg, />PROFORMA INVOICE</);
  assert.match(svg, />Demo Power Ltd</);
  assert.match(svg, /<image href="st\.png"/);
});

test('reading a workbook: cells, tables, names, styles, a link to another file', () => {
  const wb = {
    SheetNames: ['Quotation Maker', 'Data'],
    Sheets: {
      'Quotation Maker': { '!ref': 'A1:B2', A1: { t: 's', v: 'Hello' }, B1: { t: 'n', v: 3, f: 'Data!A2*1.5', z: '0.00' }, A2: { t: 's', v: 'x', f: '[1]Other!A1' } },
      Data: { '!ref': 'A1:A2', A1: { t: 's', v: 'Qty' }, A2: { t: 'n', v: 2 } },
    },
    Workbook: { Names: [{ Name: 'QTY', Ref: 'Data!$A$2' }, { Name: '_xlnm.Print_Area', Sheet: 0, Ref: "'Quotation Maker'!$A$1:$B$2" }] },
  };
  const files = {
    'xl/workbook.xml': '<sheets><sheet name="Quotation Maker" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/></sheets>',
    'xl/_rels/workbook.xml.rels': '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/>',
    'xl/worksheets/sheet1.xml': '<sheetFormatPr baseColWidth="10" defaultRowHeight="16"/><cols><col min="1" max="1" width="20" customWidth="1"/></cols><sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c></row><row r="2"><c r="B2" s="1"><f>B1*2</f><v></v></c></row></sheetData><mergeCells><mergeCell ref="A2:B2"/></mergeCells><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5"/><printOptions horizontalCentered="1"/>',
    'xl/worksheets/sheet2.xml': '<sheetData/><tableParts><tablePart r:id="rId1"/></tableParts>',
    'xl/worksheets/_rels/sheet2.xml.rels': '<Relationship Id="rId1" Target="../tables/table1.xml"/>',
    'xl/tables/table1.xml': '<table id="1" name="Qtys" displayName="Qtys" ref="A1:A2"><tableColumns count="1"><tableColumn id="1" name="Qty"/></tableColumns></table>',
    'xl/styles.xml': '<fonts><font><sz val="12"/><name val="Aptos Narrow"/></font><font><b/><sz val="14"/><color rgb="FF0000FF"/><name val="Arial"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill></fills><borders><border/><border><left style="thin"/><bottom style="medium"/></border></borders><cellXfs><xf fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" wrapText="1"/></xf></cellXfs><dxfs><dxf><font><b/><color rgb="FF008000"/></font></dxf></dxfs>',
  };
  const m = buildModel(wb, files, { docSheets: ['Quotation Maker'] });
  assert.deepEqual(Object.keys(m.sheets).sort(), ['Data', 'Quotation Maker']);          // Data is reached by a formula
  assert.equal(m.sheets['Quotation Maker'].cells.A2.ext, 1);                            // a link: keeps Excel's value
  assert.equal(m.sheets['Quotation Maker'].cells.A2.f, undefined);
  assert.equal(m.names.QTY, 'Data!$A$2');
  assert.deepEqual([m.tables.Qtys.sheet, m.tables.Qtys.cols], ['Data', ['Qty']]);
  const L = m.sheets['Quotation Maker'].layout;
  assert.deepEqual([L.area, L.widths[0], L.heights[0], L.merges, L.center], [{ r0: 0, c0: 0, r1: 1, c1: 1 }, 20, 30, ['A2:B2'], true]);
  assert.equal(L.margins.left, 18);
  assert.deepEqual(m.styles.xf[1], { f: 'Arial', s: 14, c: '#0000FF', b: 1, bg: '#FFF2CC', h: 'center', w: 1, bd: [1, 0, 0, 2], z: 'dd/mm/yyyy' });
  assert.deepEqual(readStyles(files['xl/styles.xml']).dxf[0], { b: 1, c: '#008000' });
  assert.equal(makeCalc(m).value('Quotation Maker', 'B1'), 3);
  // a formula saved without its result (SheetJS skips it) is read from the sheet itself
  assert.equal(m.sheets['Quotation Maker'].cells.B2.f, 'B1*2');
  assert.equal(makeCalc(m).value('Quotation Maker', 'B2'), 6);
  assert.equal(selfCheck(m).unsaved, 1);
});

test('the macros\' source: MS-OVBA decompression', () => {
  const lit = Uint8Array.from([0x01, 0x08, 0xb0, 0x00, ...Buffer.from('abcdefgh')]);
  assert.equal(Buffer.from(decompress(lit)).toString(), 'abcdefgh');
  const copy = Uint8Array.from([0x01, 0x05, 0xb0, 0x08, 0x61, 0x62, 0x63, 0x03, 0x20]);       // "abc" then copy 6 from 3 back
  assert.equal(Buffer.from(decompress(copy)).toString(), 'abcabcabc');
});

test('a cell that is empty in the workbook prints what was typed into it', () => {
  const calc = docCalc(M, 'proforma', { inputs: { G7: 'PO-9', G8: isoToSerial('2026-11-02') } }, { macro });
  const v = pageValues(M, 'proforma', calc, basicFormat);
  assert.equal(v.G7.text, 'PO-9');
  assert.equal(v.G8.text, '02/11/2026');                                    // the cell's own date format
});
