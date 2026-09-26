// DayBook import and the PO rule. Run: node --test tests/ledger_web
import assert from 'node:assert/strict';
import test from 'node:test';

import { daybookPayload, parseDaybook, sheetRows } from '../../ledger/js/daybook.js';
import { allocate, billOrder } from '../../ledger/js/po.js';
import {
  cellNumber, cellText, fyOf, isDateFormat, normKey, parseTextDate, serialToISO, suggestLedgerName,
} from '../../ledger/js/util.js';
import { date, sheet } from './sheets.mjs';

test('helpers', () => {
  assert.equal(serialToISO(45658), '2025-01-01');
  assert.equal(serialToISO(45658 - 1462, true), '2025-01-01');         // Mac 1904 date system
  assert.equal(parseTextDate('7-Apr-26'), '2026-04-07');
  assert.equal(parseTextDate('07/04/2026'), '2026-04-07');                // day first
  assert.equal(parseTextDate('7 April 2026'), '2026-04-07');
  assert.equal(parseTextDate('31-02-2026'), null);
  assert.equal(parseTextDate('Total'), null);
  assert.equal(fyOf('2026-04-01'), '2026-27');
  assert.equal(fyOf('2027-03-31'), '2026-27');
  assert.equal(normKey('  M/s  Demo Power\tLtd '), 'm/s demo power ltd');
  assert.ok(isDateFormat('[$-14009]dd/mm/yy;@'));
  assert.ok(isDateFormat('mmm-yy'));
  assert.ok(!isDateFormat('General'));
  assert.ok(!isDateFormat('[$₹-4009]#,##0;\\-[$₹-4009]#,##0;\\-'));
  assert.equal(cellText({ t: 'n', v: 4500012345 }), '4500012345');     // no 4.5E+09
  assert.equal(cellText({ t: 'e', v: 42 }), '');                        // #N/A reads as blank
  assert.equal(cellNumber({ t: 's', v: '1,234.50 Ltr' }), 1234.5);
  assert.equal(cellNumber({ t: 's', v: 'abc' }), null);
  assert.equal(suggestLedgerName('M/s Demo: Power/Ltd'), 'M s Demo Power Ltd');
});

test('DayBook: reads sales the way ImportDayBook does', () => {
  const ws = sheet({}, {
    start: 1,
    rows: [
      ['Day Book', '', '', '', '', '', '', '', ''],
      ['Date', 'Particulars', 'Vch Type', 'Quantity', 'Rate', 'Vehicle', 'Vch No.', 'Debit', 'Credit'],
      [date('2026-04-07'), 'Demo Power Ltd', 'HSD Credit', 1000, 90.5, ' OD01A1111 ', '101', 90500, ''],
      [date('2026-04-07'), 'Sample Roadlines', 'MS CREDIT', 20, 100, 'OD02B2222', 'M-5', '', 2000],
      [date('2026-04-07'), 'Sample Roadlines', 'XG CREDIT', '15.5 Ltr', 99, '', 'XG7', '1,534.50', ''],
      [date('2026-04-07'), 'Cash', 'Receipt', '', '', '', 'R1', '', 500],
      ['07-04-2026', 'Text Date Movers', 'HSD CREDIT', 10, 91, 'OD03C3333', '102', 910, ''],
      [date('2026-04-07'), 'No Bill Co', 'HSD CREDIT', 10, 91, '', '', 910, ''],
      [date('2026-04-07'), '', 'HSD CREDIT', 5, 91, '', '103', 455, ''],
      ['Total', '', '', '', '', '', '', 95000, 2500],
    ],
  });
  const parsed = parseDaybook(sheetRows(ws));
  assert.deepEqual(parsed.byProduct, { HSD: 3, MS: 1, XG: 1 });
  assert.equal(parsed.from, '2026-04-07');
  assert.deepEqual(parsed.skipped, { otherVouchers: 1, noBillNo: 1 });
  assert.deepEqual(parsed.otherTypes, [{ type: 'RECEIPT', count: 1 }]);
  const [hsd, ms, xg, textDate, noName] = parsed.sales;
  assert.deepEqual(hsd, {
    product: 'HSD', bill_no: '101', sale_date: '2026-04-07', vehicle: 'OD01A1111', qty: 1000,
    rate: 90.5, amount: 90500, customer: 'Demo Power Ltd', row: 3,
  });
  assert.equal(ms.amount, 2000);                       // Debit empty -> Credit
  assert.equal(xg.qty, 15.5);
  assert.equal(xg.amount, 1534.5);
  assert.equal(textDate.sale_date, '2026-04-07');
  assert.deepEqual(parsed.problems, [{ row: 9, bill_no: '103', problem: 'no customer name' }]);
  assert.equal(noName.customer, '');
  assert.equal(daybookPayload(parsed).length, 4);      // the nameless row isn't sent
});

// ---------------------------------------------------------------------------
// The PO rule: first PO in the list with enough litres left for the bill.
// ---------------------------------------------------------------------------
const bill = (qty, extra = {}) => ({ qty, po_mode: 'auto', ...extra });

test('PO: first PO with enough litres left, in list order', () => {
  const pos = [
    { id: 1, po_no: 'A', allotted: 1000, seq: 1 },
    { id: 2, po_no: 'B', allotted: 500, seq: 2 },
  ];
  const bills = [bill(600), bill(300), bill(200), bill(150), bill(100), bill(400), bill(50), bill(0)];
  const { bills: out, registers } = allocate({ kind: 'po', pos, bills });
  assert.deepEqual(out.map((b) => b.po), ['A', 'A', 'B', 'B', 'A', '', 'B', '']);
  assert.deepEqual(out.map((b) => b.how), ['auto', 'auto', 'auto', 'auto', 'auto', 'no-po', 'auto', 'no-po']);
  const [a, b] = registers[0].pos;
  assert.deepEqual([a.used, a.balance, a.status, a.bills], [1000, 0, 'Completed', 3]);
  assert.deepEqual([b.used, b.balance, b.status, b.bills], [400, 100, 'Pending', 3]);
});

test('PO: list order decides, not the PO number', () => {
  const pos = [
    { id: 9, po_no: 'Z-LAST', allotted: 100, seq: 1 },
    { id: 1, po_no: 'A-FIRST', allotted: 100, seq: 2 },
  ];
  assert.deepEqual(allocate({ kind: 'po', pos, bills: [bill(60), bill(60)] }).bills.map((b) => b.po),
    ['Z-LAST', 'A-FIRST']);
});

test('PO: typed-in POs are kept and use up litres', () => {
  const pos = [{ id: 1, po_no: 'A', allotted: 1000, seq: 1 }, { id: 2, po_no: 'B', allotted: 1000, seq: 2 }];
  const bills = [bill(700, { po_mode: 'fixed', po_fixed: 'a' }), bill(400), bill(10, { po_mode: 'fixed', po_fixed: '' })];
  const { bills: out, registers } = allocate({ kind: 'po', pos, bills });
  assert.deepEqual(out.map((b) => [b.po, b.how]), [['a', 'fixed'], ['B', 'auto'], ['', 'fixed']]);
  assert.equal(registers[0].pos[0].used, 700);          // 'a' matches 'A' like Excel's SUMIFS
});

test('PO: unit-wise lists (SMC)', () => {
  const pos = [
    { id: 1, unit: 'UNIT 1', po_no: 'U1-A', allotted: 500, seq: 1 },
    { id: 2, unit: 'UNIT 2', po_no: 'U2-A', allotted: 500, seq: 1 },
  ];
  const bills = [
    bill(400, { unit: 'UNIT 1' }), bill(400, { unit: 'unit 2' }), bill(200, { unit: 'UNIT 1' }),
    bill(100, { unit: 'UNIT 2' }), bill(50, { unit: '' }),
  ];
  const { bills: out, registers } = allocate({ kind: 'po_units', units: ['UNIT 1', 'UNIT 2'], pos, bills });
  assert.deepEqual(out.map((b) => b.po), ['U1-A', 'U2-A', '', 'U2-A', '']);
  assert.deepEqual(out.map((b) => b.how), ['auto', 'auto', 'no-po', 'auto', 'needs-unit']);
  assert.deepEqual(registers.map((r) => [r.unit, r.pos[0].used, r.pos[0].balance]),
    [['UNIT 1', 400, 100], ['UNIT 2', 500, 0]]);
});

test('PO: petrol / XtraGreen bills only get a PO you pick, and it uses up litres', () => {
  const pos = [{ id: 1, po_no: 'A', allotted: 1000, seq: 1 }];
  const bills = [
    bill(300, { product: 'XG' }), bill(400, { product: 'XG', po_mode: 'fixed', po_fixed: 'A' }),
    bill(700, { product: 'HSD' }), bill(600, { product: 'HSD' }),
  ];
  const { bills: out, registers } = allocate({ kind: 'po', pos, bills });
  assert.deepEqual(out.map((b) => [b.po, b.how]), [['', 'not-diesel'], ['A', 'fixed'], ['', 'no-po'], ['A', 'auto']]);
  assert.equal(registers[0].pos[0].used, 1000);
});

test('PO: bills are taken by date, then sheet order', () => {
  const rows = [
    { id: 3, date: '2026-04-02', seq: 5 }, { id: 1, date: '2026-04-01', seq: 9 },
    { id: 2, date: '2026-04-01', seq: 7 }, { id: 4, date: '2026-04-01', seq: 2, product: 'XG' },
  ];
  assert.deepEqual(rows.sort(billOrder).map((r) => r.id), [2, 1, 4, 3]);   // diesel rows first each day
});
