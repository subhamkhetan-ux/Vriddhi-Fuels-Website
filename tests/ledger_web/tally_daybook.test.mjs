// The Tally app's Day Book downloads (tally/daybook.js) must be the files Tally
// Prime itself exports: the XML byte for byte, and the Excel "Sales Register"
// the Ledger app's Import Sales reads. The fixture is a real Tally Day Book
// export with every name, address, GSTIN, PAN, vehicle and GUID made up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { parseDaybook, sheetRows } from '../../ledger/js/daybook.js';

const require = createRequire(import.meta.url);
const D = require('../../tally/daybook.js');
const XLSX = require('../../pdf/vendor/xlsx.full.min.js');

const RAW = fs.readFileSync(new URL('../fixtures/tally-daybook-sample.xml', import.meta.url));
const TEXT = new TextDecoder('utf-16le').decode(RAW.subarray(2));

const tag = (b, t) => { const m = b.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([^<]*)</' + t + '>')); return m ? m[1] : undefined; };
const un = s => s == null ? s : s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// What the app knows about each voucher (and Tally's keys, which the bridge knows only in part).
function vouchersOf(text) {
  return [...text.matchAll(/<VOUCHER ([^>]*)>([\s\S]*?)<\/VOUCHER>/g)].map(([, attrs, b]) => {
    const at = n => (attrs.match(new RegExp(n + '="([^"]*)"')) || [])[1];
    const inv = b.slice(b.indexOf('<ALLINVENTORYENTRIES.LIST>'));
    const led = [...b.matchAll(/<LEDGERENTRIES\.LIST>([\s\S]*?)<\/LEDGERENTRIES\.LIST>/g)].map(m => m[1]);
    const roff = led.find(l => tag(l, 'LEDGERNAME') === 'R/off');
    const addr = (b.match(/<ADDRESS\.LIST TYPE="String">([\s\S]*?)<\/ADDRESS\.LIST>/) || [, ''])[1];
    return {
      seriesKey: { 'HSD CREDIT': 'hsd', 'MS CREDIT': 'ms', 'XG CREDIT': 'xg' }[at('VCHTYPE')], number: tag(b, 'VOUCHERNUMBER'),
      dateISO: tag(b, 'DATE').replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3'), party: un(tag(b, 'PARTYLEDGERNAME')),
      vehicle: un(tag(b, 'UDF:EIVEHNO')) || '', qty: parseFloat(tag(inv, 'BILLEDQTY')), rate: parseFloat(tag(inv, 'RATE')),
      itemAmt: parseFloat(tag(inv, 'AMOUNT')), partyAmt: -parseFloat(tag(led[0], 'AMOUNT')), roff: roff ? parseFloat(tag(roff, 'AMOUNT')) : 0,
      guid: tag(b, 'GUID'), vchKey: at('VCHKEY'), alterId: (tag(b, 'ALTERID') || '').trim(), masterId: (tag(b, 'MASTERID') || '').trim(),
      voucherKey: tag(b, 'VOUCHERKEY'), retainKey: tag(b, 'VOUCHERRETAINKEY'),
      master: { gstin: tag(b, 'PARTYGSTIN'), regType: tag(b, 'GSTREGISTRATIONTYPE'), state: tag(b, 'STATENAME'), place: tag(b, 'PLACEOFSUPPLY'),
        pincode: tag(b, 'PARTYPINCODE'), country: tag(b, 'COUNTRYOFRESIDENCE'), pan: tag(b, 'BUYERPINNUMBER'),
        consigneePan: tag(b, 'CONSIGNEEPINNUMBER'), vatDealerType: tag(b, 'VATDEALERTYPE'),
        address: [...addr.matchAll(/<ADDRESS>([^<]*)<\/ADDRESS>/g)].map(m => un(m[1])) },
    };
  });
}
const VOUCHERS = vouchersOf(TEXT);
const COMPANY = tag(TEXT, 'SVCURRENTCOMPANY');

test('the Day Book XML is Tally’s export byte for byte', () => {
  assert.equal(VOUCHERS.length, 5);
  const out = D.xml({ company: COMPANY, companyGuid: tag(TEXT.slice(TEXT.indexOf('<COMPANY>')), 'NAME'), vouchers: VOUCHERS });
  assert.ok(Buffer.from(D.utf16(out)).equals(RAW));
});

test('what the app does not know is left out, never invented', () => {
  const v = { ...VOUCHERS[2], guid: undefined, vchKey: undefined, alterId: undefined, masterId: undefined, voucherKey: undefined,
    retainKey: undefined, vehicle: '', master: {} };
  const lines = D.voucherLines(v).join('\n');
  assert.match(lines, /^     <VOUCHER VCHTYPE="HSD CREDIT" ACTION="Create" OBJVIEW="Invoice Voucher View">/);
  for (const t of ['GUID', 'ALTERID', 'MASTERID', 'VOUCHERKEY', 'ADDRESS.LIST', 'PARTYGSTIN', 'BUYERPINNUMBER', 'VATDEALERTYPE', 'UDF:EIVEHNO'])
    assert.ok(!lines.includes('<' + t), t);
  assert.match(lines, /<GSTREGISTRATIONTYPE>Unregistered\/Consumer<\/GSTREGISTRATIONTYPE>/);
  assert.match(lines, /<LEDGERNAME>R\/off<\/LEDGERNAME>[\s\S]*<AMOUNT>-0\.57<\/AMOUNT>/);
  // XtraGreen books to SALE (HSD) with its own stock item
  const xg = D.voucherLines({ ...v, seriesKey: 'xg', number: 'XG9' }).join('\n');
  assert.match(xg, /VCHTYPE="XG CREDIT"/);
  assert.match(xg, /<STOCKITEMNAME>XtraGreen Diesel<\/STOCKITEMNAME>/);
  assert.match(xg, /<LEDGERNAME>SALE \(HSD\)<\/LEDGERNAME>/);
});

test('the Excel Day Book is the Sales Register the Ledger imports', () => {
  const heading = ['VRIDDHI FUELS (2026-27)', 'AT-KHERWAL PO- BADMAL', 'DIST- JHARSUGUDA, 768202', 'ODISHA', 'E-Mail : subhamkhetan@gmail.com'];
  const wb = XLSX.read(D.excel({ heading, day: '2026-10-22', vouchers: VOUCHERS }));
  assert.deepEqual(wb.SheetNames, ['Sales Register']);
  const ws = wb.Sheets['Sales Register'];
  assert.equal(ws.A1.v, 'VRIDDHI FUELS (2026-27)');
  assert.equal(ws.A6.v, 'Sales Register');
  assert.equal(ws.A7.v, 'For 22-Oct-26');
  assert.deepEqual(['A8', 'B8', 'C8', 'D8', 'E8', 'F8', 'G8', 'H8', 'I8'].map(c => ws[c].v),
    ['Date', 'Particulars', 'Vch Type', 'Qty', 'Rate', 'Vehicle', 'Vch No.', 'Debit', 'Credit']);
  // by voucher type, then number: the HSD invoices, then MS
  assert.deepEqual([10, 11, 12, 13, 14].map(r => ws['G' + r].v), ['4331', '4340', '4355', '4356', 'MS690']);
  assert.equal(ws.A10.v, 46317);
  assert.equal(ws.D11.v, 27.8);
  assert.equal(ws.H11.v, 2800);       // the customer amount, after round-off
  assert.equal(ws.A15.v, 'Total:');
  assert.equal(ws.E15.v, VOUCHERS.reduce((n, v) => n + v.partyAmt, 0));
  assert.deepEqual(ws['!merges'].map(m => XLSX.utils.encode_range(m)).sort(),
    ['A15:D15', 'A1:C1', 'A2:C2', 'A3:C3', 'A4:C4', 'A5:C5', 'A6:C6', 'A7:C7'].sort());
  const r = parseDaybook(sheetRows(ws));
  assert.equal(r.sales.length, 5);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.byProduct, { HSD: 4, MS: 1, XG: 0 });
  assert.deepEqual(r.sales[1], { product: 'HSD', bill_no: '4340', sale_date: '2026-10-22', vehicle: 'OD00AA0000', qty: 27.8,
    rate: 100.74, amount: 2800, customer: VOUCHERS[2].party, row: 11 });
  assert.equal(r.sales[3].vehicle, '');
});

test('the Excel styles are Tally’s own', () => {
  const parts = D.excelParts({ heading: ['X'], day: '2026-10-05', vouchers: VOUCHERS.slice(0, 1) });
  assert.match(parts['xl/styles.xml'], /<numFmt numFmtId="164" formatCode="&quot;&quot;0\.000&quot; LTR&quot;"\/>/);
  assert.match(parts['xl/worksheets/sheet1.xml'], /<c r="A10" s="15"><v>46317<\/v><\/c><c r="B10" s="16" t="s">/);
  assert.match(parts['xl/sharedStrings.xml'], /<si><t>For 5-Oct-26<\/t><\/si>/);
});

test('the Master import keeps each customer’s address, PAN and VAT dealer type', () => {
  // the app's own parser (tally/index.html), run as it is
  const html = fs.readFileSync(new URL('../../tally/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('var TALLY = {');
  const end = html.indexOf('buildVoucherXml: buildVoucherXml, buildEnvelope: buildEnvelope };', start);
  const mod = { exports: {} };
  new Function('module', html.slice(start, html.indexOf('\n}', end) + 2))(mod);
  const master = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
    <TALLYMESSAGE><GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>
    <TALLYMESSAGE><LEDGER NAME="Sample &amp; Sons"><PARENT>Sundry Debtors</PARENT><INCOMETAXNUMBER>ZZZZZ1000Z</INCOMETAXNUMBER>
      <VATDEALERTYPE>Regular</VATDEALERTYPE><GSTIN>21ZZZZZ1000Z1Z0</GSTIN>
      <LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>Plot 1</ADDRESS><ADDRESS>Demo &amp; Co Road</ADDRESS></ADDRESS.LIST>
        <APPLICABLEFROM>20260401</APPLICABLEFROM><MAILINGNAME>Sample and Sons (Unit 2)</MAILINGNAME><PINCODE>700001</PINCODE><STATE>Odisha</STATE><COUNTRY>India</COUNTRY></LEDMAILINGDETAILS.LIST>
    </LEDGER></TALLYMESSAGE>
    <TALLYMESSAGE><LEDGER NAME="Walk-in Buyer"><PARENT>Sundry Debtors</PARENT></LEDGER></TALLYMESSAGE>
  </REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const [a, b] = mod.exports.parseMasterText(master).debtors;
  assert.deepEqual([a.name, a.address, a.pan, a.vatDealerType, a.pincode], ['Sample & Sons', ['Plot 1', 'Demo & Co Road'], 'ZZZZZ1000Z', 'Regular', '700001']);
  assert.deepEqual([b.name, b.address, b.pan, b.vatDealerType], ['Walk-in Buyer', [], '', '']);
  assert.deepEqual([a.mailingName, b.mailingName], ['Sample and Sons (Unit 2)', '']);
});

test('the Day Book prints the ledger’s mailing name, the ledger name without one', () => {
  const lines = m => D.voucherLines(Object.assign({}, VOUCHERS[0], { master: m })).join('\n');
  const named = lines({ mailingName: 'Unit & Two' });
  assert.match(named, /<PARTYMAILINGNAME>Unit &amp; Two<\/PARTYMAILINGNAME>/);
  assert.match(named, /<CONSIGNEEMAILINGNAME>Unit &amp; Two<\/CONSIGNEEMAILINGNAME>/);
  const plain = lines({});
  const party = VOUCHERS[0].party.replace(/&/g, '&amp;');
  assert.ok(plain.includes('<PARTYMAILINGNAME>' + party + '</PARTYMAILINGNAME>'));
});

test('a customer that re-registered gets the GST details that apply now, whatever the order in the file', () => {
  const html = fs.readFileSync(new URL('../../tally/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('var TALLY = {');
  const end = html.indexOf('buildVoucherXml: buildVoucherXml, buildEnvelope: buildEnvelope };', start);
  const mod = { exports: {} };
  new Function('module', html.slice(start, html.indexOf('\n}', end) + 2))(mod);
  // Tally lists the older Telangana registration and address first, the current Odisha ones after
  // (and the reverse for the second customer): the latest "applicable from" wins either way.
  const reg = (from, gstin, st) => `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>${from}</APPLICABLEFROM><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
    <PLACEOFSUPPLY>${st}</PLACEOFSUPPLY><GSTIN>${gstin}</GSTIN><STATE>${st}</STATE></LEDGSTREGDETAILS.LIST>`;
  const mail = (from, line, pin, st) => `<LEDMAILINGDETAILS.LIST><ADDRESS.LIST TYPE="String"><ADDRESS>${line}</ADDRESS></ADDRESS.LIST>
    <APPLICABLEFROM>${from}</APPLICABLEFROM><PINCODE>${pin}</PINCODE><STATE>${st}</STATE><COUNTRY>India</COUNTRY></LEDMAILINGDETAILS.LIST>`;
  const older = [reg('20230401', '36ZZZZZ2000Z1Z1', 'Telangana'), mail('20230401', 'Old office', '500001', 'Telangana')];
  const newer = [reg('20250601', '21ZZZZZ2000Z1Z2', 'Odisha'), mail('20250601', 'Plant road', '768001', 'Odisha')];
  const future = [reg('20991231', '27ZZZZZ2000Z1Z3', 'Maharashtra'), mail('20991231', 'Future', '400001', 'Maharashtra')];
  const master = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
    <TALLYMESSAGE><GROUP NAME="Sundry Debtors"><PARENT>Current Assets</PARENT></GROUP></TALLYMESSAGE>
    <TALLYMESSAGE><LEDGER NAME="Moved Co"><PARENT>Sundry Debtors</PARENT><GSTIN>36ZZZZZ2000Z1Z1</GSTIN>
      ${older[0]}${newer[0]}${future[0]}${older[1]}${newer[1]}${future[1]}</LEDGER></TALLYMESSAGE>
    <TALLYMESSAGE><LEDGER NAME="Moved Co Two"><PARENT>Sundry Debtors</PARENT>
      ${newer[0]}${older[0]}${newer[1]}${older[1]}</LEDGER></TALLYMESSAGE>
  </REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  for (const d of mod.exports.parseMasterText(master).debtors)
    assert.deepEqual([d.gstin, d.state, d.place, d.pincode, d.address], ['21ZZZZZ2000Z1Z2', 'Odisha', 'Odisha', '768001', ['Plant road']], d.name);
});

test('linked vouchers follow Tally’s own entry order (the GUID counter)', () => {
  const g = n => '00000000-0000-4000-8000-000000000000-0000dd' + n;
  const v = (number, createdAt, guid) => ({ number, createdAt, guid, dateISO: '2026-10-23', seriesKey: 'hsd' });
  // renumbered in Tally: the app saved #4360 before #4359
  const order = D.daybookOrder([v('4360', 1, g('76')), v('4359', 2, g('75')), v('4400', 1.5), v('4358', 0, g('74'))]);
  assert.deepEqual(order.map(x => x.number), ['4358', '4359', '4400', '4360']);
});
