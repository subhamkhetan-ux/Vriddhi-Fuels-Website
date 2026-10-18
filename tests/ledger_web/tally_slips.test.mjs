// The Tally app's fuel slips (tally/slips.js) are the Ledger app's Print
// Bills, ported to a plain script. They must stay identical: same drawing,
// same PDFs and file names.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { slipBundles, slipHeaderFor, splitCompany } from '../../ledger/js/bills.js';
import { slipSvg } from '../../ledger/js/render.js';
import { fyOf } from '../../ledger/js/util.js';

const require = createRequire(import.meta.url);
const VFSlips = require('../../tally/slips.js');

const HEADER = {
  title: 'CREDIT MEMO', mobile: 'Mob : 00000 00000',
  lines: ['DEMO FUELS (2026-27)', 'AT- SAMPLE ROAD PO- TESTPUR', 'DIST- DEMO, 000000', 'DEMO STATE',
    'GSTIN/UIN: 00DEMO0000D0Z0', 'State Name : Demo, Code : 00', 'E-Mail : demo@example.com', 'an eighth line is dropped'],
};
const STAMP = 'data:image/png;base64,iVBORw0KGgo=';

const SALES = [
  { product: 'MS', bill_no: 'MS320', sale_date: '2026-10-02', customer: 'Sample Roadlines', vehicle: 'OD23A1234', qty: 20.5, rate: 101.2, amount: 2074.6, seq: 320 },
  { product: 'HSD', bill_no: '1641', sale_date: '2026-10-02', customer: 'sample roadlines ', vehicle: '', qty: 12000, rate: 90.02, amount: 1080240, seq: 1641 },
  { product: 'HSD', bill_no: '1640', sale_date: '2026-10-01', customer: 'Demo & <Co> "Ltd"', vehicle: 'OD15R9360', qty: 300, rate: 90.52, amount: 27156, seq: 1640 },
  { product: 'XG', bill_no: 'XG7', sale_date: '2026-10-01', customer: 'Example Infra', vehicle: 'OD02/AB:1', qty: 0.333, rate: 106.34, amount: -35.41, seq: 7 },
  { product: 'HSD', bill_no: '1642', sale_date: '2026-10-03', customer: '', vehicle: null, qty: '50', rate: '', amount: 4501, seq: 1642 },
  { product: 'HSD', bill_no: '', sale_date: '2026-10-02', customer: 'No Number', qty: 1, rate: 1, amount: 1, seq: 1 },
  { product: 'OTHER', bill_no: 'O1', sale_date: '2026-10-02', customer: 'Lube Buyer', qty: 1, rate: 1, amount: 1, seq: 2 },
  { product: 'HSD', bill_no: '1600', sale_date: '2026-09-30', customer: 'Before Range', qty: 1, rate: 1, amount: 1, seq: 1600 },
];

test('the slip is drawn exactly like the Ledger app draws it', () => {
  for (const bill of SALES) {
    assert.equal(VFSlips.slipSvg(bill, HEADER, STAMP), slipSvg(bill, HEADER, STAMP));
    assert.equal(VFSlips.slipSvg(bill, HEADER, ''), slipSvg(bill, HEADER, ''));
    assert.equal(VFSlips.slipSvg(bill), slipSvg(bill));
    assert.equal(VFSlips.slipSvg(bill, {}, ''), slipSvg(bill, {}, ''));
  }
});

test('the signature is printed only when there is one', () => {
  assert.match(VFSlips.slipSvg(SALES[0], HEADER, STAMP), /<image href="data:image\/png/);
  assert.doesNotMatch(VFSlips.slipSvg(SALES[0], HEADER, ''), /<image/);
});

test('slips are bundled into the same PDFs, with the same names', () => {
  const cases = [
    { from: '2026-10-01', to: '2026-10-03' },
    { from: '2026-10-02', to: '2026-10-02' },
    { from: '2026-10-01', to: '2026-10-03', filter: 'SAMPLE ROADLINES' },
    { from: '2026-10-01', to: '2026-10-03', filter: 'nobody' },
  ];
  for (const c of cases) {
    const mine = VFSlips.slipBundles({ sales: SALES, ...c });
    const theirs = slipBundles({ sales: SALES, ...c });
    assert.deepEqual(JSON.parse(JSON.stringify(mine)), JSON.parse(JSON.stringify(theirs)));
  }
  const r = VFSlips.slipBundles({ sales: SALES, from: '2026-10-01', to: '2026-10-03' });
  assert.equal(r.folder, 'Fuel Bills 01-10-2026 to 03-10-2026');
  assert.deepEqual(r.bundles.map((b) => b.fileName), [
    'Demo & Co Ltd Slips 01-10-2026 to 03-10-2026.pdf',
    'sample roadlines Slips 01-10-2026 to 03-10-2026.pdf',   // the first bill's spelling
    '(No Customer) Slips 01-10-2026 to 03-10-2026.pdf',
    'Example Infra Slips 01-10-2026 to 03-10-2026.pdf',
  ]);
  // diesel first, then petrol, for the same customer
  assert.deepEqual(r.bundles[1].bills.map((b) => b.bill_no), ['1641', 'MS320']);
});

test('the company name and its financial year work as in the Ledger app', () => {
  for (const d of ['2026-03-31', '2026-04-01', '2027-01-15', '2099-12-31', '2100-02-01']) assert.equal(VFSlips.fyOf(d), fyOf(d));
  for (const line of ['VRIDDHI FUELS (2026-27)', ' Demo ( 2027 - 28 ) ', 'DEMO FUELS', '', undefined, 'A (B)']) {
    assert.deepEqual(VFSlips.splitCompany(line), splitCompany(line));
  }
  const header = { title: 'CREDIT MEMO', mobile: 'Mob : 1', lines: ['DEMO FUELS (2026-27)', 'AT- TESTPUR'] };
  for (const co of [null, { name: '' }, { name: 'DEMO FUELS', fy: true }, { name: 'DEMO LLP', fy: false }]) {
    for (const d of ['2027-03-31', '2027-04-01']) {
      assert.deepEqual(VFSlips.slipHeaderFor(header, co, d), slipHeaderFor(header, co, d));
    }
  }
  assert.deepEqual(VFSlips.slipHeaderFor({ title: 'X' }, { name: 'N', fy: true }, '2027-04-01'), slipHeaderFor({ title: 'X' }, { name: 'N', fy: true }, '2027-04-01'));
  assert.equal(VFSlips.slipHeaderFor(header, { name: 'DEMO FUELS', fy: true }, '2027-04-01').lines[0], 'DEMO FUELS (2027-28)');
});
