// "Import Sales": reads a Tally DayBook the same way the workbook's
// ImportDayBook macro (Module10) does.
//
// First sheet, columns A..I:
//   A Date   B Customer   C Voucher type   D Quantity   E Rate
//   F Vehicle   G Voucher no. (= Bill No.)   H Debit   I Credit
// Only "HSD CREDIT", "MS CREDIT" and "XG CREDIT" vouchers are sales; the
// amount is the Debit column, or the Credit column when Debit is empty.
// Rows whose column A isn't a date (headers, totals, blank lines) are
// skipped, exactly like the macro.

import { addr, cellDate, cellNumber, cellText, isDateCell, sheetBounds } from './util.js';

export const VOUCHER_TYPES = { 'HSD CREDIT': 'HSD', 'MS CREDIT': 'MS', 'XG CREDIT': 'XG' };

export function sheetRows(ws, cols = 9) {
  const { rows } = sheetBounds(ws);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(ws[addr(r, c)]);
    out.push(row);
  }
  return out;
}

// rows: arrays of SheetJS cells (A..I). Returns the sales rows plus what
// was skipped and why.
export function parseDaybook(rows, { date1904 = false } = {}) {
  const sales = [];
  const skipped = { otherVouchers: 0, noBillNo: 0 };
  const otherTypes = new Map();
  const problems = [];

  rows.forEach((r, i) => {
    if (!isDateCell(r[0])) return;
    const type = cellText(r[2]).toUpperCase();
    const product = VOUCHER_TYPES[type];
    if (!product) {
      skipped.otherVouchers += 1;
      if (type) otherTypes.set(type, (otherTypes.get(type) || 0) + 1);
      return;
    }
    const billNo = cellText(r[6]);
    if (!billNo) {
      skipped.noBillNo += 1;
      return;
    }
    let amount = cellNumber(r[7]);                 // Debit
    if (amount == null) amount = cellNumber(r[8]); // else Credit
    const row = {
      product,
      bill_no: billNo,
      sale_date: cellDate(r[0], date1904),
      vehicle: cellText(r[5]),
      qty: cellNumber(r[3]),
      rate: cellNumber(r[4]),
      amount,
      customer: cellText(r[1]),
      row: i + 1,
    };
    if (!row.sale_date) problems.push({ row: row.row, bill_no: billNo, problem: 'date not readable' });
    else if (!row.customer) problems.push({ row: row.row, bill_no: billNo, problem: 'no customer name' });
    else if (row.qty == null || row.amount == null) {
      problems.push({ row: row.row, bill_no: billNo, problem: 'quantity or amount not a number' });
    }
    sales.push(row);
  });

  const byProduct = { HSD: 0, MS: 0, XG: 0 };
  for (const s of sales) byProduct[s.product] += 1;
  const dates = sales.map((s) => s.sale_date).filter(Boolean).sort();
  return {
    sales,
    byProduct,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
    skipped,
    otherTypes: [...otherTypes].map(([type, count]) => ({ type, count })),
    problems,
  };
}

// The rows to send to ledger_import_daybook(): only complete ones.
export function daybookPayload(parsed) {
  return parsed.sales
    .filter((s) => s.sale_date && s.customer && s.bill_no)
    .map(({ product, bill_no, sale_date, vehicle, qty, rate, amount, customer }) => (
      { product, bill_no, sale_date, vehicle, qty, rate, amount, customer }));
}
