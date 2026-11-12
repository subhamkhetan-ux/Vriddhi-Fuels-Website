#!/usr/bin/env node
// Writes ledger/js/demo-workbook.js: the ledger demo's Tanker Billing
// workbook (/ledger/?demo → Quotes), made from the real workbook's design.
//
// The Quotation Maker, Proforma Invoice and Bank Pay CrNote sheets keep their
// layout, wording, formulas and macros (Module1: Print & Log PI; the credit
// note's Save/Print & Log, Reprint); everything about real
// customers is replaced with made-up data — the Customers / RateCard /
// TierTerms rows, the typed-in customer, contacts and PI No. — and every
// formula's saved result is worked out again from the made-up data. The
// script stops if a real customer's name is still in the output.
//
//   LEDGER_XLSX=/path/to/xlsx.mjs JSZIP=/path/to/jszip/lib/index.js \
//     node ledger/tools/demo_workbook.mjs "Tanker Billing.xlsm"
//
// (SheetJS and JSZip aren't part of this repo; the app loads them from CDNs.)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = process.argv[2];
if (!src || !process.env.LEDGER_XLSX || !process.env.JSZIP) {
  console.error('usage: LEDGER_XLSX=…/xlsx.mjs JSZIP=…/jszip/lib/index.js node ledger/tools/demo_workbook.mjs "Tanker Billing.xlsm"');
  process.exit(2);
}
const XLSX = await import(pathToFileURL(process.env.LEDGER_XLSX).href);
const JSZip = (await import(pathToFileURL(process.env.JSZIP).href)).default;
const { buildModel, MODEL_PARTS } = await import(pathToFileURL(join(root, 'ledger/js/xl-model.js')).href);
const { vbaModules } = await import(pathToFileURL(join(root, 'ledger/js/vba.js')).href);
const { addrOf, isErr, makeCalc } = await import(pathToFileURL(join(root, 'ledger/js/formula.js')).href);

const buf = readFileSync(src);
const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellNF: true, cellDates: false });
const zip = await JSZip.loadAsync(buf);
const files = {};
for (const n of Object.keys(zip.files)) if (MODEL_PARTS.test(n)) files[n] = await zip.file(n).async('string');
const vba = zip.file('xl/vbaProject.bin') ? vbaModules(await zip.file('xl/vbaProject.bin').async('uint8array')) : {};
// only the macros the app reads: Print & Log PI, and the credit note's
const keep = Object.fromEntries(Object.entries(vba).filter(([, t]) => /Sub\s+PrintAndLog/i.test(t)));
const model = buildModel(wb, files, { vba: keep });

// the real names, to make sure none is left
const realNames = [];
const custT = Object.values(model.tables).find((t) => t.cols.includes('Company'));
const csh = model.sheets[custT.sheet];
for (let r = custT.r0 + 1; r <= custT.r1; r++) {
  const v = csh.cells[addrOf(r, custT.c0 + custT.cols.indexOf('Company'))];
  if (v && typeof v.v === 'string' && v.v.trim().length > 4) realNames.push(v.v.trim());
}

// ---- made-up data ----
const PAY = ['Payment Details:', 'Account No. – 000000000000', 'IFSC Code – DEMO0000000', 'Branch Name – DEMO BANK, SAMPLE BRANCH', 'Beneficiary Name – Demo Fuels'];
const CUSTOMERS = [
  ['Crew One Logistics', ['Crew Camp, Sample Mines', 'Testpur.', ''], PAY, '', '', 'HSD RSP'],
  ['Demo Power Ltd', ['At- Demo Industrial Estate', 'Post- Sampleganj, Via- Testpur.', 'GSTIN: 21AAACD0000A1Z1'], PAY, 'P.O. No.:', 'DP/26/0142', 'Bulk Price'],
  ['Sample Metals Ltd', ['Sample Metals Plant', 'Testpur.', 'GSTIN : 21AAACS0000C1Z3'],
    ['Payment Details for XtraPower Account:', 'Virtual Account No. – DEMOXP0000000000', 'IFS Code – DEMO0000001', 'Branch Name – DEMO BANK, HEAD OFFICE', 'Beneficiary Name – Demo Oil Company'],
    'P.O. No.:', 'SM-2026-01', 'Twin Price'],
  ['Twin Steel Ltd, UNIT I', ['Unit I, Twin Steel Works', 'Sample Road, Testpur.', 'GSTIN: 21AAACT0000B1Z2'], PAY, 'P.O. No.:', '', 'Linked Price'],
];
const TIERS = [['HSD RSP', 91.02], ['Bulk Price', '=+0-0.5'], ['Twin Price', 90.02], ['Linked Price', '=+2-0.74']];   // =+k: row k of the card
const TERMS = [['HSD RSP', 'Advance', null], ['Bulk Price', 'N Days', 15], ['Twin Price', '24 Hrs', null], ['Linked Price', 'Advance', null]];
const PRODUCTS = [['Motor Spirit', 99.5], ['XtraGreen Diesel', 95.1]];

const sheet = model.sheets[custT.sheet];
const keepTables = new Set(['FuelTypes', 'PaymentPresets']);
const tablesHere = Object.entries(model.tables).filter(([, t]) => t.sheet === custT.sheet);
const inTable = (r, c) => tablesHere.find(([, t]) => r >= t.r0 && r <= t.r1 && c >= t.c0 && c <= t.c1);
// first data row's formula of each column (a table column's formula is the same on every row)
const colFormula = (t, name) => { const c = sheet.cells[addrOf(t.r0 + 1, t.c0 + t.cols.indexOf(name))]; return c && c.f ? c.f : null; };
const formulas = {};
for (const [n, t] of tablesHere) for (const col of t.cols) formulas[`${n}|${col}`] = colFormula(t, col);

// keep: table headers, the kept tables, and the XtraPower block (labels + figures)
const xpCols = new Set();
for (const [a, c] of Object.entries(sheet.cells)) if (typeof c.v === 'string' && /points|tds|rsp \(/i.test(c.v) && !c.f) xpCols.add(a.replace(/\d+$/, ''));
const next = {};
for (const [a, c] of Object.entries(sheet.cells)) {
  const m = /^([A-Z]+)(\d+)$/.exec(a);
  const r = Number(m[2]) - 1;
  let col = 0; for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64; col -= 1;
  const t = inTable(r, col);
  if (t) { if (r === t[1].r0 || keepTables.has(t[0])) next[a] = c; continue; }
  const left = m[1];
  const nextCol = String.fromCharCode(left.charCodeAt(0) - 1);
  if (left.length === 1 && (xpCols.has(left) || xpCols.has(nextCol))) next[a] = c;
}
sheet.cells = next;
const put = (t, row, name, v) => {
  const a = addrOf(t.r0 + 1 + row, t.c0 + t.cols.indexOf(name));
  if (t.cols.indexOf(name) < 0) return;
  sheet.cells[a] = typeof v === 'string' && v.startsWith('=') ? { f: v.slice(1) } : { v };
};
const fill = (name, rows, write) => {
  const t = model.tables[name];
  if (!t) return;
  t.r1 = t.r0 + rows.length;
  rows.forEach((x, i) => write(t, i, x));
};
fill('Customers', CUSTOMERS, (t, i, [company, address, payment, poLabel, poNo, tier]) => {
  put(t, i, 'Company', company);
  if (formulas['Customers|HSD']) put(t, i, 'HSD', `=${formulas['Customers|HSD']}`);
  address.forEach((x, k) => put(t, i, `Address ${k + 1}`, x));
  payment.forEach((x, k) => put(t, i, `Payment ${k + 1}`, x));
  put(t, i, 'PO Label', poLabel);
  put(t, i, 'PO No.', poNo);
  put(t, i, 'Price Tier', tier);
});
fill('RateCard', TIERS, (t, i, [tier, rate]) => {
  put(t, i, 'Price Tier', tier);
  const rateCol = t.cols.indexOf('Rate');
  if (typeof rate === 'string') {
    const [, k, off] = /^=\+(\d+)(.*)$/.exec(rate);
    put(t, i, 'Rate', `=${addrOf(t.r0 + 1 + Number(k), t.c0 + rateCol)}${off}`);
  } else put(t, i, 'Rate', rate);
});
fill('ProductRates', PRODUCTS, (t, i, [p, rate]) => { put(t, i, 'Product', p); put(t, i, 'Rate', rate); });
fill('TierTerms', TERMS, (t, i, [tier, preset, days]) => {
  put(t, i, 'Price Tier', tier);
  put(t, i, 'Payment Preset', preset);
  if (days != null) put(t, i, 'Credit Days', days);
  if (formulas['TierTerms|Payment Terms']) put(t, i, 'Payment Terms', `=${formulas['TierTerms|Payment Terms']}`);
});

// the typed-in cells of the two documents
const set = (s, a, v) => { const sh = model.sheets[s]; if (sh) sh.cells[a] = { ...(sh.cells[a] || {}), v }; };
set('Quotation Maker', 'A5', 'Demo Power Ltd');
set('Quotation Maker', 'I7', '00000 00000');
set('Quotation Maker', 'I8', 'demo@example.com');
set('Proforma Invoice', 'A12', 'Sample Metals Ltd');
set('Proforma Invoice', 'G4', 'PI/2026-27/001');
// the credit note: a made-up customer, PO and our bank account
set('Bank Pay CrNote', 'A17', 'Demo Power Ltd');
set('Bank Pay CrNote', 'G17', 'BNK/001');
set('Bank Pay CrNote', 'G20', 'DP/26/0142');
set('Bank Pay CrNote', 'K13', 'DEMO BANK, Sample Branch – A/c 000000000000, IFSC DEMO0000000');
// the seller block names the business; the demo names a made-up one
for (const [a, v] of [['A4', 'DEMO FUELS'], ['A7', 'GSTIN: 00DEMO0000D0Z0      PAN: DEMO00000D'], ['A8', 'Mob: 00000 00000'], ['A9', 'Email: demo@example.com']]) {
  const c = model.sheets['Proforma Invoice'].cells[a];
  if (c && !c.f && typeof c.v === 'string') c.v = v;
}

// every formula's saved result, worked out again from the made-up data
const calc = makeCalc(model, { today: model.saved_today ?? undefined, format: (f, v) => XLSX.SSF.format(f, v) });
for (const [s, sh] of Object.entries(model.sheets)) {
  for (const [a, c] of Object.entries(sh.cells)) {
    if (c.ext) { delete c.ext; c.v = ''; }
    if (!c.f) continue;
    const v = calc.value(s, a);
    delete c.v; delete c.e;
    if (isErr(v)) c.e = v.code; else if (v != null) c.v = v;
  }
}
const out = JSON.stringify(model);
const left = realNames.filter((n) => out.toLowerCase().includes(n.toLowerCase()));
if (left.length) {
  console.error(`real customer names still in the demo: ${left.length} — not written`);
  process.exit(1);
}
const dest = join(root, 'ledger/js/demo-workbook.js');
writeFileSync(dest, `// Made by ledger/tools/demo_workbook.mjs — the demo's Tanker Billing workbook: the real sheets'
// design, formulas and macros (Print & Log PI, the credit note's), with made-up customers, rates and contacts.
export const DEMO_WORKBOOK = ${out};
`);
console.log(`wrote ${dest} (${out.length} bytes; ${realNames.length} real names checked)`);
