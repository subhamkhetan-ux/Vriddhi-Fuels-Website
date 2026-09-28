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
  assert.equal(rows[1][13], 'High');
  assert.ok(!rows[0].some((h) => /sold/i.test(h)));                       // nothing is sold while decanting
  // the internal-audit columns come last, after the ones that were there
  assert.deepEqual(rows[0].slice(14), ['Value (₹)', 'Stock before from', 'Stock after from', 'Stock proof']);
  assert.deepEqual(rows[1].slice(15), ['', '', '']);                       // readings with no source: nothing claimed
  const tank = (before, after) => ({ id: 'A', status: 'done', tt_no: 'OD23U8210', invoice_no: 'I', created_at: '2026-09-27T04:00:00Z',
    data: { decantedAt: '2026-09-27T04:00:00Z', tanks: [{ tank: 'T2', tankNo: 2, product: 'HSD', chambers: [1], litres: 5000, before, after }] } });
  const audit = (before, after) => exportRows(entriesFrom([tank(before, after)]))[1].slice(15);
  assert.deepEqual(audit({ volume: 9000, source: 'photo' }, { volume: 14000, source: 'dip', dip: 150.1 }), ['Screenshot', 'Dip 150.1 cm', 'Yes']);
  assert.deepEqual(audit({ volume: 9000, source: 'photo-edited', screenVolume: 9050 }, { volume: 14000, source: 'litres' }),
    ['Screenshot, corrected by hand (the screen said 9,050.00 L)', 'Typed litres — no solid proof', 'No — typed litres']);
  const csv = toCsv([['a', 'b,c'], ['say "hi"', 1]]);
  assert.equal(csv, 'a,"b,c"\r\n"say ""hi""",1');
});

test('periods: this month, last month, this FY, all', async () => {
  const { fyStart, periodRange } = await import('../../decant/js/report.js');
  assert.equal(fyStart('2026-09-27'), '2026-04-01');
  assert.equal(fyStart('2027-03-31'), '2026-04-01');
  assert.equal(fyStart('2027-04-01'), '2027-04-01');
  assert.deepEqual(periodRange('month', '2026-09-27'), ['2026-09-01', '2026-09-27']);
  assert.deepEqual(periodRange('lastmonth', '2026-09-27'), ['2026-08-01', '2026-08-31']);
  assert.deepEqual(periodRange('lastmonth', '2027-01-05'), ['2026-12-01', '2026-12-31']);
  assert.deepEqual(periodRange('fy', '2027-02-10'), ['2026-04-01', '2027-02-10']);
  assert.deepEqual(periodRange('all', '2026-09-27'), ['', '2026-09-27']);
  assert.deepEqual(periodRange('custom', '2026-09-27', { from: '2026-09-10' }), ['2026-09-10', '2026-09-27']);
});

test('what the phone keeps, what the cloud keeps, and months', async () => {
  const { localFrom, monthsBetween, oldestKept, withOlder } = await import('../../decant/js/report.js');
  // the cloud: this FY and the last (matches dec_purge_old)
  assert.equal(oldestKept('2026-09-27'), '2025-04-01');
  assert.equal(oldestKept('2027-03-31'), '2025-04-01');
  assert.equal(oldestKept('2027-04-01'), '2026-04-01');
  // the phone: this month and last, with two days' slack
  assert.equal(localFrom('2026-09-27'), '2026-07-30');
  assert.equal(localFrom('2026-03-05'), '2026-01-30');
  assert.equal(localFrom('2026-01-10'), '2025-11-29');
  assert.equal(localFrom('2028-03-01'), '2028-01-30');
  assert.deepEqual(monthsBetween('2025-11-29', '2026-02-03'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(monthsBetween('2026-09-01', '2026-09-27'), ['2026-09']);
  assert.equal(monthsBetween('2025-04-01', '2027-03-31').length, 24);
  // the phone's copy wins over the cloud's older rows
  const merged = withOlder([{ id: 'a', v: 'phone' }], [{ id: 'a', v: 'cloud' }, { id: 'b', v: 'cloud' }], 'id');
  assert.deepEqual(merged, [{ id: 'a', v: 'phone' }, { id: 'b', v: 'cloud' }]);
  assert.deepEqual(withOlder([{ id: 'a' }], undefined, 'id'), [{ id: 'a' }]);
});

test('reports read compact rows from the cloud history view', async () => {
  const { entriesFrom, purchaseSummary } = await import('../../decant/js/report.js');
  // the shape dec_history returns: no readings' details, no invoice copy
  const compact = {
    id: 'old1', invoice_no: 'I9', tt_no: 'OD23U8210', status: 'done', created_at: '2026-05-02T04:00:00Z',
    data: {
      compact: true, decantedAt: '2026-05-02T04:30:00Z', startedAt: null, plan: [{ no: 1, tank: 'T2' }],
      tanks: [{ tank: 'T2', tankNo: 2, product: 'HSD', chambers: [1], litres: 5000, salesL: 12, pricePerL: null, before: { volume: 9000 }, after: { volume: 13950 } }],
    },
  };
  const [e] = entriesFrom([compact], DEFAULT_SETTINGS);
  assert.equal(e.day, '2026-05-02');
  assert.equal(e.variation, -38);            // gained 4950, expected 5000 − 12
  assert.equal(e.value, null);
  const buy = purchaseSummary([{ invoice_no: 'I9', invoice_date: '02/05/2026', tt_no: 'OD23U8210', lines: [{ column_key: 'HSD', qty_kl: 5 }] }], [compact], {});
  assert.equal(buy.byProduct.HSD.decanted, 5000);
  assert.equal(buy.byProduct.HSD.transit, 0);
});

test('purchases: decanted + outside the app + in transit', async () => {
  const { dismissReason, purchaseSummary } = await import('../../decant/js/report.js');
  const inv = (no, date, tt, lines, extra = {}) => ({
    invoice_no: no, invoice_date: date, invoice_time: '10:00', tt_no: tt,
    lines: lines.map(([column_key, qty_kl]) => ({ column_key, qty_kl })), ...extra,
  });
  const invoices = [
    inv('A', '26/09/2026', 'OD23U8210', [['HSD', 22]]),                                   // fully decanted
    inv('B', '26/09/2026', 'OD23U8210', [['MS | EBMS', 5], ['HSD', 17]]),                  // HSD C5 still on the truck
    inv('C', '27/09/2026', 'OR15X1234', [['XtraGreen HSD', 12]]),                          // not decanted yet
    inv('D', '20/09/2026', 'OD23U8210', [['HSD', 22]], { dismissed: true, dismiss_reason: 'outside' }),
    inv('E', '21/09/2026', 'OD01A0001', [['HSD', 12]], { dismissed: true, note: 'Not for our tanks' }),
    inv('F', '31/08/2026', 'OD23U8210', [['HSD', 22]]),                                    // last month
    inv('G', '27/09/2026', 'OD23U8210', [['HSD', 22]]),                                    // decanting right now
  ];
  const sess = (invoice_no, status, tanks) => ({ invoice_no, status, data: { tanks: tanks.map(([product, litres]) => ({ product, litres })) } });
  const sessions = [
    sess('A', 'done', [['HSD', 14000], ['HSD', 8000]]),
    sess('B', 'done', [['MS', 5000], ['HSD', 9000], ['HSD', 4000]]),
    sess('G', 'decanting', [['HSD', 14000]]),
    sess('C', 'cancelled', [['XG', 12000]]),
  ];
  const r = purchaseSummary(invoices, sessions, { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(r.byProduct.HSD, { purchased: 83000, decanted: 35000, outside: 22000, transit: 26000, trucks: 2 });
  assert.deepEqual(r.byProduct.MS, { purchased: 5000, decanted: 5000, outside: 0, transit: 0, trucks: 0 });
  assert.deepEqual(r.byProduct.XG, { purchased: 12000, decanted: 0, outside: 0, transit: 12000, trucks: 1 });
  assert.deepEqual(r.total, { purchased: 100000, decanted: 40000, outside: 22000, transit: 38000 });
  assert.deepEqual(r.transit.map((t) => [t.invoice_no, t.tt, t.products.map((p) => `${p.product}:${p.litres}${p.decanting ? ' now' : ''}`).join(' '), t.partial, t.decanting]), [
    ['B', 'OD23U8210', 'HSD:4000', true, false],
    ['C', 'OR15X1234', 'XG:12000', false, false],
    ['G', 'OD23U8210', 'HSD:22000 now', false, true],
  ]);
  // one truck, one product
  assert.equal(purchaseSummary(invoices, sessions, { from: '2026-09-01', tt: 'OR15X1234' }).total.purchased, 12000);
  assert.equal(purchaseSummary(invoices, sessions, { product: 'MS' }).total.purchased, 5000);
  assert.equal(purchaseSummary(invoices, sessions, { from: '2026-08-01', to: '2026-08-31' }).byProduct.HSD.transit, 22000);
  assert.equal(dismissReason({ dismissed: true, note: 'Decanted before the app' }), 'outside');
  assert.equal(dismissReason({ dismissed: false }), null);
});

test('the Log: one card per invoice, a line per tank', async () => {
  const { byInvoice } = await import('../../decant/js/report.js');
  const e = (sessionId, invoiceNo, tank, at) => ({ sessionId, invoiceNo, tt: 'OD23U8210', tank, tankNo: Number(tank.slice(1)), at, litres: 1000, variation: 1 });
  const groups = byInvoice([
    e('S2', '7011319869', 'T3', '2026-09-27T11:45:00Z'), e('S2', '7011319869', 'T2', '2026-09-27T11:45:00Z'),
    e('S1', '7011285916', 'T2', '2026-09-27T07:51:00Z'), e('S1', '7011285916', 'T3', '2026-09-27T07:51:00Z'),
    // part decanted, the rest later: one invoice, two goes, in time order
    e('S4', '7011300001', 'T2', '2026-09-26T12:00:00Z'), e('S3', '7011300001', 'T3', '2026-09-26T09:00:00Z'),
  ]);
  assert.deepEqual(groups.map((g) => [g.invoiceNo, g.entries.map((x) => x.tank).join('+'), g.sessions.length]),
    [['7011319869', 'T2+T3', 1], ['7011285916', 'T2+T3', 1], ['7011300001', 'T3+T2', 2]]);
  assert.equal(groups[0].litres, 2000);
  assert.equal(groups[0].variation, 2);
  assert.equal(groups[2].at, '2026-09-26T12:00:00Z');                   // the latest go
});

test('chart axis always reaches the biggest value', async () => {
  const { niceTicks } = await import('../../decant/js/charts.js');
  assert.deepEqual(niceTicks(-50, 165).ticks, [-100, 0, 100, 200]);    // a +165 L day no longer runs past a 100 top
  assert.deepEqual(niceTicks(-117, 0).ticks, [-150, -100, -50, 0]);
  assert.deepEqual(niceTicks(-40, 100).ticks, [-50, 0, 50, 100]);      // an exact top stays tight
});
