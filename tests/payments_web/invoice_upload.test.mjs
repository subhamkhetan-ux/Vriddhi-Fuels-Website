// The payments app's "invoice from PDF" fallback must write exactly what the
// mail agent would, under the same keys, so the mail arriving later is a no-op.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { linesFromItems, newerPrices, noteId, parseInvoiceLines, planUpload } from '../../payments/invoice_upload.js';

const PDF = JSON.parse(fs.readFileSync(new URL('../decant_web/fixtures/invoice-pdf-items.json', import.meta.url)));
const read = (no, name) => parseInvoiceLines(linesFromItems(PDF[no]), name);

test('note id is the agent\'s state_store.entry_id(SAP entry no.)', async () => {
  // python -c "from agent import state_store; print(state_store.entry_id('7011294526'))"
  assert.equal(await noteId('7011294526'), '6890dbdf5ca5177d');
  assert.equal(await noteId('7011263776'), '6b92f2f2d6a26c19');
});

test('own-TT two-product invoice: credit row, prices and a consignment note', () => {
  const plan = planUpload(read('7011294526', '7011294526.pdf'));
  assert.equal(plan.key, '7011294526');
  assert.deepEqual(plan.fuelRow, {
    invoice_no: '7011294526', invoice_date: '26/09/2026', tt_no: 'OD23U8210', amount: 2193251, gmail_msg_id: null,
  });
  assert.deepEqual(plan.note, {
    p_gmail_msg_id: null, p_invoice_no: '7011294526', p_invoice_date: '26/09/2026', p_tt_no: 'OD23U8210',
    p_product: 'EBMS [PDRP]', p_column_key: 'MS | EBMS', p_qty: '5', p_value: 2193251,
    p_columns: { 'MS | EBMS': '5', HSD: '17' }, p_origin: 'Jharsuguda Terminal, Jharsuguda, Odisha',
  });
  assert.equal(plan.noteSkip, null);
  assert.deepEqual(plan.prices.map((p) => [p.col_key, p.price, p.as_of]), [
    ['MS | EBMS', 104952.8, '2026-09-26'], ['HSD', 98146.29, '2026-09-26']]);
});

test('a renamed download still keys on the invoice number', () => {
  assert.equal(planUpload(read('7011263776', 'Invoice (1).pdf')).key, '7011263776');
});

test('no note for another TT, or before the 047 anchor', () => {
  const inv = read('7011294526', '7011294526.pdf');
  const other = planUpload({ ...inv, tt_no: 'OR15R1110' });
  assert.equal(other.note, null);
  assert.equal(other.noteSkip, 'other-tt');
  assert.ok(other.fuelRow, 'every truck still counts on the Credit tab');
  assert.equal(planUpload(inv, { minInvoiceNo: '7099999999' }).noteSkip, 'before-anchor');
  assert.equal(planUpload({ ...inv, amount: null }).noteSkip, 'incomplete');
  assert.equal(planUpload({ ...inv, amount: null }).fuelRow, null);
});

test('prices: only a strictly newer invoice date replaces the stored one', () => {
  const obs = [{ col_key: 'HSD', price: 98000, as_of: '2026-09-26', invoice_no: 'a' },
    { col_key: 'MS | EBMS', price: 104000, as_of: '2026-09-26', invoice_no: 'a' }];
  assert.deepEqual(newerPrices(obs, { HSD: { as_of: '2026-09-26' }, 'MS | EBMS': { as_of: '2026-09-25' } }),
    [{ col_key: 'MS | EBMS', price_per_kl: 104000, as_of: '2026-09-26', invoice_no: 'a' }]);
});

test('XtraGreen printed as HSD-XG maps like the agent\'s product_column()', async () => {
  const { columnKey } = await import('../../decant/js/invoice.js');
  assert.equal(columnKey('HSD-XG-BSVI [PDRP]'), 'XtraGreen HSD');
  assert.equal(columnKey('HSD-BSVI [PDRP]'), 'HSD');
});

// ---- the decant app ----
import { decantProject, decantRow, typedTwin } from '../../payments/invoice_upload.js';

test('decant row: the agent\'s dec_invoices columns, from the PDF', () => {
  const row = decantRow(read('7011294526', '7011294526.pdf'));
  // agent/decant.py COLUMNS, plus the two the decant app's own PDF upload sets
  assert.deepEqual(Object.keys(row).sort(), ['amount', 'chambers', 'density15', 'dismissed', 'gmail_msg_id', 'invoice_date', 'invoice_no',
    'invoice_time', 'lines', 'note', 'origin', 'seals', 'source', 'tt_no'].sort());
  assert.equal(row.invoice_no, '7011294526');          // the key the agent's later insert collides on
  assert.equal(row.source, 'pdf');
  assert.equal(row.dismissed, false);
  assert.equal(row.chambers.length, 5);
  assert.deepEqual(row.lines.map((l) => [l.column_key, l.qty_kl, l.compartments]), [['MS | EBMS', 5, [1]], ['HSD', 17, [2, 3, 4, 5]]]);
});

test('decant project: its own one, never the payments project', () => {
  const pay = { SUPABASE_URL: 'https://pay.supabase.co' };
  assert.deepEqual(decantProject({ SUPABASE_URL: 'https://dec.supabase.co/', SUPABASE_ANON_KEY: 'k' }, pay), { url: 'https://dec.supabase.co', key: 'k' });
  assert.ok(decantProject({ SUPABASE_URL: 'https://pay.supabase.co', SUPABASE_ANON_KEY: 'k' }, pay).why);
  assert.ok(decantProject({ SUPABASE_URL: 'PASTE_URL', SUPABASE_ANON_KEY: 'PASTE_KEY' }, pay).why);
  assert.ok(decantProject(undefined, pay).why);
});

test('a truck typed in on the decant app for the same TT and day is found', () => {
  const inv = { invoice_no: '7011294526', tt_no: 'OD23U8210', invoice_date: '26/09/2026' };
  const typed = { invoice_no: 'M-20260926-1400-8210', tt_no: 'OD23U8210', invoice_date: '26/09/2026', dismissed: false };
  assert.equal(typedTwin([typed], inv), typed);
  assert.equal(typedTwin([{ ...typed, dismissed: true }], inv), null);
  assert.equal(typedTwin([{ ...typed, invoice_date: '25/09/2026' }], inv), null);
  assert.equal(typedTwin([{ ...inv }], inv), null);                         // the invoice itself isn't its twin
});
