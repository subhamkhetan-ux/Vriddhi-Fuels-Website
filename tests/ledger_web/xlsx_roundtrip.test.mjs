// The same made-up workbooks, saved as real .xlsx files and read back with
// SheetJS using the app's own options — checks that formulas, number
// formats and dates survive the trip. Skipped when SheetJS isn't installed
// (point LEDGER_XLSX at its xlsx.mjs to run it).
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { parseDaybook, sheetRows } from '../../ledger/js/daybook.js';
import { extractMaster, readWorkbook } from '../../ledger/js/master.js';
import { demoWorkbook } from './fixtures.mjs';
import { date, sheet, workbook } from './sheets.mjs';

let XLSX = null;
try {
  XLSX = await import(process.env.LEDGER_XLSX ? pathToFileURL(process.env.LEDGER_XLSX).href : 'xlsx');
} catch {
  XLSX = null;
}
const skip = XLSX ? false : 'SheetJS (xlsx) is not installed';

test('Master Ledger survives a real .xlsx round trip', { skip }, () => {
  const bytes = XLSX.write(demoWorkbook(), { type: 'array', bookType: 'xlsx' });
  const wb = readWorkbook(XLSX, bytes);
  assert.ok(!wb.Sheets.Index, 'sheets the app doesn\'t need are not parsed');
  const direct = extractMaster(demoWorkbook());
  const viaFile = extractMaster(wb);
  assert.deepEqual(viaFile.payload, direct.payload);
  assert.deepEqual(viaFile.preview, direct.preview);
});

test('DayBook dates keep their format through a real .xlsx', { skip }, () => {
  const ws = sheet({}, {
    start: 1,
    rows: [
      ['Date', 'Particulars', 'Vch Type', 'Quantity', 'Rate', 'Vehicle', 'Vch No.', 'Debit', 'Credit'],
      [date('2026-04-07', 'dd-mm-yyyy'), 'Demo Power Ltd', 'HSD CREDIT', 1000, 90.5, 'OD01A1111', '101', 90500, ''],
      [{ t: 'n', v: 12 }, 'Not a date', 'HSD CREDIT', 1, 1, '', '102', 1, ''],
    ],
  });
  const bytes = XLSX.write(workbook({ DayBook: ws }), { type: 'array', bookType: 'xlsx' });
  const wb = readWorkbook(XLSX, bytes, { all: true });
  const parsed = parseDaybook(sheetRows(wb.Sheets[wb.SheetNames[0]]));
  assert.deepEqual(parsed.sales.map((s) => [s.bill_no, s.sale_date]), [['101', '2026-04-07']]);
});
