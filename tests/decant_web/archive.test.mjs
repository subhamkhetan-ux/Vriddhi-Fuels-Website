// Monthly log files (decant/js/archive.js) and the Excel writer they use.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  addMonths, fileName, keepFrom, logMonths, logSheets, monthBounds, monthCounts, monthName, monthOf,
} from '../../decant/js/archive.js';
import { DEFAULT_SETTINGS, DEFAULT_TANKS } from '../../decant/js/core.js';
import { buildWorkbook, excelSerial } from '../../decant/js/xlsx.js';

test('months are India-time months', () => {
  assert.equal(monthOf('2026-08-31T18:29:59Z'), '2026-08');
  assert.equal(monthOf('2026-08-31T18:30:00Z'), '2026-09');                 // midnight on 1 Sep in India
  assert.deepEqual(monthBounds('2026-09'), ['2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z']);
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(monthName('2026-09'), 'September 2026');
  assert.equal(fileName('2026-09'), 'Vriddhi decanting log 2026-09.xlsx');
});

test('what the cloud keeps', () => {
  assert.equal(keepFrom('2026-09-29', 'fy2'), '2025-04');                   // this FY (from Apr 2026) and the last
  assert.equal(keepFrom('2027-03-31', 'fy2'), '2025-04');
  assert.equal(keepFrom('2027-04-01', 'fy2'), '2026-04');
  assert.equal(keepFrom('2026-09-29', '12'), '2025-10');
  assert.equal(keepFrom('2026-09-29', '3'), '2026-07');
});

const S = (id, created, status = 'done', updated = created) => ({ id, status, created_at: created, updated_at: updated });
const I = (no, created, updated = created) => ({ invoice_no: no, created_at: created, updated_at: updated });

test('records per month', () => {
  const counts = monthCounts(
    [S('a', '2026-07-10T05:00:00Z'), S('b', '2026-07-20T05:00:00Z', 'decanting', '2026-07-21T05:00:00Z'), S('c', '2026-08-31T19:00:00Z')],
    [I('1', '2026-07-09T04:00:00Z'), I('2', '2026-08-31T18:00:00Z')],
  );
  assert.deepEqual(counts, {
    '2026-07': { sessions: 2, open: 1, invoices: 1, updated: '2026-07-21T05:00:00Z' },
    '2026-08': { sessions: 0, open: 0, invoices: 1, updated: '2026-08-31T18:00:00Z' },
    '2026-09': { sessions: 1, open: 0, invoices: 0, updated: '2026-08-31T19:00:00Z' },
  });
});

test('which files are due, and which months to clear', () => {
  const counts = {
    '2025-03': { sessions: 40, open: 0, invoices: 50, updated: '2025-04-02T10:00:00Z' },   // downloaded, older than kept
    '2025-04': { sessions: 41, open: 0, invoices: 52, updated: '2025-05-06T10:00:00Z' },   // edited after its file
    '2026-08': { sessions: 60, open: 1, invoices: 70, updated: '2026-09-01T10:00:00Z' },   // no file yet
    '2026-09': { sessions: 20, open: 2, invoices: 25, updated: '2026-09-29T10:00:00Z' },   // this month: not yet
  };
  const archive = {
    '2025-02': { at: '2025-03-01T05:00:00Z', s: 30, i: 31, u: '2025-02-28T10:00:00Z', cleared: '2026-04-01T05:00:00Z' },
    '2025-03': { at: '2025-04-03T05:00:00Z', by: 'Ravi', s: 40, i: 50, u: '2025-04-02T10:00:00Z' },
    '2025-04': { at: '2025-05-02T05:00:00Z', s: 41, i: 52, u: '2025-05-01T10:00:00Z' },
  };
  const list = logMonths({ counts, archive, today: '2026-09-29', keep: '12' });
  assert.deepEqual(list.map((f) => [f.month, f.state, f.clear]), [
    ['2025-02', 'cleared', false],
    ['2025-03', 'saved', true],        // file saved, unchanged, older than Oct 2025: clear it
    ['2025-04', 'changed', false],     // never cleared while a change isn't in a file
    ['2026-08', 'new', false],
  ]);
  // this FY and the last: in March 2026 that reaches back to April 2024, so March 2025 stays
  assert.equal(logMonths({ counts, archive, today: '2026-03-15', keep: 'fy2' }).find((f) => f.month === '2025-03').clear, false);
  assert.equal(logMonths({ counts, archive, today: '2026-09-29', keep: 'fy2' }).find((f) => f.month === '2025-03').clear, true);
  // cleared once: not again (its open decantation stays in the cloud)
  const again = logMonths({ counts, archive: { ...archive, '2025-03': { ...archive['2025-03'], cleared: '2026-09-29T06:00:00Z' } }, today: '2026-09-29', keep: '12' });
  assert.equal(again.find((f) => f.month === '2025-03').clear, false);
});

// One finished decantation (two tanks), one cancelled, and their invoice.
const reading = (volume, source, extra = {}) => ({ volume, source, readingAt: '2026-08-26T11:18:17+05:30', ...extra });
const SESSION = {
  id: 'S-1', invoice_no: '7011263776', tt_no: 'OD23U8210', status: 'done',
  created_at: '2026-08-26T05:37:37.838Z', updated_at: '2026-08-26T05:49:17.580Z', completed_at: '2026-08-26T05:49:16.228Z',
  data: {
    invoice: { invoice_date: '26/08/2026', invoice_time: '09:34' },
    chambers: [[1, 5000], [2, 5000], [3, 4000], [4, 4000], [5, 4000]].map(([no, litres]) => ({ no, litres, product: 'HSD', dipCm: 140 })),
    plan: [1, 2, 3, 4, 5].map((no) => ({ no, product: 'HSD', tank: no <= 3 ? 'T2' : 'T3' })),
    prices: { HSD: 98.15 }, densities: { HSD: 831 }, checks: { density: { HSD: { reading: 819.8, temp: 29 } } },
    startedAt: '2026-08-26T05:37:41.925Z', decantedAt: '2026-08-26T05:48:00.000Z', operator: 'Ravi', notes: 'C3 foamed',
    tanks: [
      { tank: 'T2', tankNo: 2, product: 'HSD', litres: 14000, chambers: [1, 2, 3], pricePerL: 98.15,
        before: reading(3446.8, 'photo', { dip: 45.46 }), after: reading(17376.58, 'photo', { dip: 157.28 }) },
      { tank: 'T3', tankNo: 3, product: 'HSD', litres: 8000, chambers: [4, 5], pricePerL: 98.15,
        before: reading(4136.61, 'litres'), after: reading(12019.45, 'photo-edited', { screenVolume: 12091.45 }) },
    ],
  },
};
const CANCELLED = { id: 'S-2', invoice_no: 'X', tt_no: 'OD02AB1234', status: 'cancelled', created_at: '2026-08-27T05:00:00Z', updated_at: '2026-08-27T05:10:00Z', data: { cancelReason: 'Cancelled before decanting.' } };
const INVOICE = {
  invoice_no: '7011263776', invoice_date: '26/08/2026', invoice_time: '09:34', tt_no: 'OD23U8210',
  lines: [{ product: 'HSD-BSVI [PDRP]', column_key: 'HSD', qty_kl: 22, compartments: [1, 2, 3, 4, 5], density15: 831, terminal_tank: 'T002', value: 2159219 }],
  chambers: [{ no: 1, pl_cm: 184.9, dip_cm: 140, qty_kl: 5 }], amount: 2159219, source: 'agent', created_at: '2026-08-26T04:14:00+00:00',
};

test('a month\'s log file: every record, and the app\'s results', () => {
  const sheets = logSheets({
    month: '2026-08', sessions: [SESSION, CANCELLED], invoices: [INVOICE], settings: DEFAULT_SETTINGS,
    madeAt: '2026-09-01T04:00:00Z', madeBy: 'Ravi', tanks: DEFAULT_TANKS,
  });
  assert.deepEqual(sheets.map((x) => x.name), ['Info', 'Fills', 'Decantations', 'Chambers', 'Density', 'Invoices', 'Invoice chambers', 'App totals']);
  const sheet = (name) => {
    const [head, ...rows] = sheets.find((x) => x.name === name).rows;
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  };
  const info = Object.fromEntries(sheet('Info').map((r) => [r.Item, r.Value]));
  assert.equal(info.Month, '2026-08');
  assert.equal(info.Format, 1);
  assert.equal(info['Decantations finished'], 1);
  assert.equal(info['Decantations cancelled'], 1);

  const [t2, t3] = sheet('Fills');
  assert.equal(t2['Fill ID'], 'S-1:T2');
  assert.deepEqual(t2['Day'], { date: '2026-08-26' });
  assert.deepEqual(t2['Decanted at'], { at: '2026-08-26T05:48:00.000Z' });
  assert.equal(t2['Chambers'], '1+2+3');
  assert.equal(t2['Tank gain (L)'], 13929.78);
  assert.equal(t2['Variation (L)'], -70.22);
  assert.equal(t2['Variation (%)'], -0.502);
  assert.equal(t2['Tolerance (L)'], 35);
  assert.equal(t2['Band'], 'High');
  assert.equal(t2['Value (₹)'], -6892.09);
  assert.equal(t2['Proof'], 'Yes');
  assert.equal(t2['Before dip (cm)'], 45.46);
  assert.equal(t2['Before from'], 'Screenshot');
  assert.equal(t3['Proof'], 'No — typed litres');
  assert.equal(t3['After, screen said (L)'], 12091.45);
  assert.equal(t3['Variation (L)'], -117.16);

  const [done, cancelled] = sheet('Decantations');
  assert.equal(done['Net variation (L)'], -187.38);
  assert.equal(done['Decanted (L)'], 22000);
  assert.equal(done['Tanks'], 'T2 + T3');
  assert.match(done['Audit'], /Tank 3 stock before typed in litres/);
  assert.match(done['Density check'], /^HSD \d+(\.\d)? \([+-]?\d/);
  assert.equal(cancelled['Cancelled because'], 'Cancelled before decanting.');
  assert.equal(sheet('Chambers').length, 5);
  assert.equal(sheet('Chambers')[3]['Into tank'], 'T3');
  assert.equal(sheet('Density')[0]['OK'], 'Yes');

  const [line] = sheet('Invoices');
  assert.equal(line['Quantity (L)'], 22000);
  assert.equal(line['Decanted in the app (L)'], 22000);
  assert.equal(line['Still on the truck (L)'], 0);
  assert.equal(line['Compartments'], '1+2+3+4+5');
  assert.equal(sheet('Invoice chambers').length, 1);

  const totals = sheet('App totals');
  assert.deepEqual(totals[0], {
    Group: 'Month', Key: '2026-08', 'Tank fills': 2, Decantations: 1, 'Decanted (L)': 22000, 'Net variation (L)': -187.38,
    'Variation (%)': -0.852, 'Short (L)': -187.38, 'Excess (L)': 0, 'Outside tolerance': 2, 'Value (₹)': -18391.34,
  });
  assert.deepEqual(totals.map((r) => `${r.Group} ${r.Key}`), ['Month 2026-08', 'Day 2026-08-26', 'Truck OD23U8210', 'Product HSD', 'Tank T2', 'Tank T3']);
});

test('the Excel writer: several sheets, real dates', async () => {
  assert.equal(excelSerial({ date: '2026-09-26' }), 46291);
  assert.equal(excelSerial({ at: '2026-09-26T06:30:00Z' }), 46291.5);          // 12:00 in India
  const blob = buildWorkbook([{ name: 'One', rows: [['a'], [1]] }, { name: 'Two', rows: [['b'], [{ date: '2026-09-26' }]] }]);
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.match(text, /<sheet name="One" sheetId="1" r:id="rId1"\/><sheet name="Two" sheetId="2" r:id="rId2"\/>/);
  assert.match(text, /xl\/worksheets\/sheet2\.xml/);
  assert.match(text, /<c r="A2" s="3"><v>46291<\/v><\/c>/);
});
