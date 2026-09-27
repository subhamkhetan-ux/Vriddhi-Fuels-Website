// The in-app invoice PDF reader, and the reports over the decanting log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { DEFAULT_SETTINGS, chamberLayout } from '../../decant/js/core.js';
import { columnKey, linesFromItems, parseInvoiceLines } from '../../decant/js/invoice.js';
import {
  byDay, byMonth, byProduct, byTank, byVehicle, daysBetween, entriesFrom, exportRows, filterEntries, summarize, toCsv, trend,
} from '../../decant/js/report.js';

// pdf.js text items from the two real invoices (header, items, chamber table and
// seal line — the address block is left out of the fixture).
const PDF = JSON.parse(fs.readFileSync(new URL('./fixtures/invoice-pdf-items.json', import.meta.url)));

test('invoice PDF: the two-product load', () => {
  const inv = parseInvoiceLines(linesFromItems(PDF['7011294526']), '7011294526.pdf');
  assert.equal(inv.invoice_no, '7011294526');
  assert.equal(inv.invoice_date, '26/09/2026');
  assert.equal(inv.invoice_time, '14:15');
  assert.equal(inv.tt_no, 'OD23U8210');
  assert.equal(inv.density15, 829.3);
  assert.equal(inv.amount, 2193251);
  assert.equal(inv.seals, '439 & 440:KEY:BLR T2 439 & BLR T2 440');
  assert.deepEqual(inv.lines.map((l) => [l.product, l.column_key, l.qty_kl, l.compartments, l.density15, l.terminal_tank, l.value]), [
    ['EBMS [PDRP]', 'MS | EBMS', 5, [1], 748.2, 'SUP1', 524764],
    ['HSD-BSVI [PDRP]', 'HSD', 17, [2, 3, 4, 5], 829.3, 'T002', 1668487],
  ]);
  assert.deepEqual(inv.chambers.map((c) => [c.no, c.pl_cm, c.dip_cm, c.qty_kl]), [
    [1, 184.9, 140, 5], [2, 185.2, 145.3, 5], [3, 186.9, 144.9, 4], [4, 184.6, 149, 4], [5, 184.8, 136.6, 4]]);
  assert.deepEqual(chamberLayout(inv).chambers.map((c) => c.product), ['MS', 'HSD', 'HSD', 'HSD', 'HSD']);
});

test('invoice PDF: the full HSD load', () => {
  const inv = parseInvoiceLines(linesFromItems(PDF['7011263776']), 'Invoice.pdf');
  assert.equal(inv.invoice_no, '7011263776');                 // from the text when the file name hasn't it
  assert.equal(inv.invoice_time, '09:34');
  assert.deepEqual(inv.lines.map((l) => [l.column_key, l.qty_kl, l.compartments]), [['HSD', 22, []]]);
  assert.equal(inv.chambers.length, 5);
  assert.deepEqual(chamberLayout(inv).problems, []);
  assert.equal(columnKey('XTRAGREEN BS-VI'), 'XtraGreen HSD');
  assert.equal(columnKey('MS-BSVI [PDRP]'), 'MS | EBMS');
});

// A finished decantation, the way the app stores it.
function session(id, tt, at, tanks, status = 'done') {
  return {
    id, tt_no: tt, invoice_no: `INV-${id}`, status, created_at: at,
    data: { decantedAt: at, tanks },
  };
}
const tankRow = (tank, tankNo, product, litres, before, after, extra = {}) => ({
  tank, tankNo, product, litres, chambers: [1], before: { volume: before }, after: { volume: after }, pricePerL: 98, ...extra,
});

const SESSIONS = [
  session('a', 'OD23U8210', '2026-09-26T08:00:00Z', [                      // 26 Sep 13:30 IST
    tankRow('T1', 1, 'MS', 5000, 3898.77, 8889.12, { pricePerL: 104.95 }),  // −9.65 L
    tankRow('T3', 3, 'HSD', 9000, 9989.83, 18960),                          // −29.83 L
  ]),
  session('b', 'OD23U8210', '2026-09-27T04:00:00Z', [tankRow('T2', 2, 'HSD', 4000, 10000, 14012)]), // +12 L
  session('c', 'OR15R1110', '2026-09-27T20:00:00Z', [tankRow('T4', 4, 'XG', 12000, 2000, 13850)]),  // −150 L, 28 Sep IST
  session('d', 'OR15R1110', '2026-09-27T21:00:00Z', [tankRow('T2', 2, 'HSD', 4000, 1, 2)], 'settling'), // not finished
];

test('log entries: one per tank per finished decantation', () => {
  const es = entriesFrom(SESSIONS, DEFAULT_SETTINGS);
  assert.deepEqual(es.map((e) => [e.id, e.day, e.tt, e.product, e.variation, e.band]), [
    ['c:T4', '2026-09-28', 'OR15R1110', 'XG', -150, 'high'],
    ['b:T2', '2026-09-27', 'OD23U8210', 'HSD', 12, 'ok'],
    ['a:T1', '2026-09-26', 'OD23U8210', 'MS', -9.65, 'ok'],
    ['a:T3', '2026-09-26', 'OD23U8210', 'HSD', -29.83, 'watch'],
  ]);
  assert.equal(es.find((e) => e.id === 'a:T1').value, -1012.77);          // ₹ at the invoice price
  assert.equal(es.find((e) => e.id === 'a:T1').month, '2026-09');
});

test('summaries by day, truck, product, tank and month', () => {
  const es = entriesFrom(SESSIONS);
  const all = summarize(es);
  assert.equal(all.count, 4);
  assert.equal(all.trips, 3);
  assert.equal(all.litres, 30000);
  assert.equal(all.variation, -177.48);
  assert.equal(all.pct, -0.592);
  assert.equal(all.short, -189.48);
  assert.equal(all.excess, 12);
  assert.equal(all.flagged, 2);
  assert.equal(all.worst.id, 'c:T4');
  assert.deepEqual(byDay(es).map((d) => [d.key, d.count, d.variation, Object.keys(d.products).sort().join('+')]), [
    ['2026-09-28', 1, -150, 'XG'], ['2026-09-27', 1, 12, 'HSD'], ['2026-09-26', 2, -39.48, 'HSD+MS']]);
  assert.deepEqual(byVehicle(es).map((v) => [v.key, v.trips, v.litres, v.variation, v.last]), [
    ['OD23U8210', 2, 18000, -27.48, '2026-09-27'], ['OR15R1110', 1, 12000, -150, '2026-09-28']]);
  assert.deepEqual(byProduct(es).map((p) => [p.key, p.litres, p.variation]), [['MS', 5000, -9.65], ['HSD', 13000, -17.83], ['XG', 12000, -150]]);
  assert.deepEqual(byTank(es).map((t) => t.key), ['T1', 'T2', 'T3', 'T4']);
  assert.deepEqual(byMonth(es).map((m) => [m.key, m.count]), [['2026-09', 4]]);
  assert.deepEqual(trend(es).map((p) => p.id), ['a:T1', 'a:T3', 'b:T2', 'c:T4']);
});

test('filters and export', () => {
  const es = entriesFrom(SESSIONS);
  assert.equal(filterEntries(es, { tt: 'OD23U8210' }).length, 3);
  assert.equal(filterEntries(es, { product: 'HSD' }).length, 2);
  assert.equal(filterEntries(es, { from: '2026-09-27', to: '2026-09-27' }).length, 1);
  assert.equal(filterEntries(es, { tank: 'T4' })[0].tt, 'OR15R1110');
  assert.deepEqual(daysBetween('2026-09-29', '2026-10-02'), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  const rows = exportRows(filterEntries(es, { tt: 'OR15R1110' }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].slice(0, 7), ['28/09/2026', '01:30', 'OR15R1110', 'INV-c', 'XG', 'Tank 4', 'C1']);
  assert.equal(rows[1][14], 'High');
  const csv = toCsv([['a', 'b,c'], ['say "hi"', 1]]);
  assert.equal(csv, 'a,"b,c"\r\n"say ""hi""",1');
});
