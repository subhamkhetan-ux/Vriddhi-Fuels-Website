// "Upload Master Ledger": reads what the app needs out of Master Ledger.xlsm
// (opened in the browser with SheetJS — the file itself is never changed
// and never leaves the device except as the rows below).
//
//   HSD Sale / MS Sale / XG Sale / Other Sale   -> sales
//   Master Paid                                 -> payments
//   Outstanding (OutstandingTbl + monthly table) -> ledger names, opening balances
//   Customer GST                                -> GSTINs, group members
//   every *_Bulk sheet                          -> bulk ledgers, PO lists, and the
//                                                  Unit / PO / TDS / Shortage /
//                                                  Remarks typed against each row
//
// It also re-runs the PO rule on the workbook's own data and compares the
// answer with the POs Excel shows, so a mismatch is caught before import.

import { allocate, billOrder, poKey } from './po.js';
import {
  addr, billKey, cellDate, cellNumber, cellText, normKey, sheetBounds,
} from './util.js';

const SALE_SHEETS = [
  { name: 'HSD Sale', product: 'HSD' },
  { name: 'MS Sale', product: 'MS' },
  { name: 'XG Sale', product: 'XG' },
];
const REQUIRED = ['HSD Sale', 'MS Sale', 'XG Sale', 'Master Paid'];
const OPTIONAL = ['Other Sale', 'Outstanding', 'Customer GST'];
const PRODUCT_OF = { DIESEL: 'HSD', PETROL: 'MS', XTRAGREEN: 'XG' };

// Which sheets to parse (everything else in the workbook is skipped).
export function sheetsToRead(names) {
  const want = [...REQUIRED, ...OPTIONAL].map((n) => n.toLowerCase());
  return names.filter((n) => want.includes(n.trim().toLowerCase()) || /_bulk\s*$/i.test(n));
}

// Opens a file with SheetJS the way the app needs it: formulas and number
// formats kept, dates left as Excel serials, and (unless `all`) only the
// sheets extractMaster() reads.
export function readWorkbook(XLSX, data, { all = false } = {}) {
  const opts = { type: 'array', cellFormula: true, cellNF: true, cellText: false, cellDates: false };
  if (all) return XLSX.read(data, opts);
  const names = XLSX.read(data, { type: 'array', bookSheets: true }).SheetNames;
  return XLSX.read(data, { ...opts, sheets: sheetsToRead(names) });
}

function findSheet(wb, name) {
  const hit = wb.SheetNames.find((n) => n.trim().toLowerCase() === name.toLowerCase());
  return hit ? wb.Sheets[hit] : null;
}

const label = (v) => String(v ?? '').toLowerCase().replace(/[.:]/g, '').replace(/\s+/g, ' ').trim();
const text = (ws, r, c) => cellText(ws[addr(r, c)]);

function checkHeaders(ws, sheet, expected) {
  const bad = [];
  expected.forEach((names, c) => {
    if (!names) return;
    const got = text(ws, 0, c);
    if (!names.map(label).includes(label(got))) {
      bad.push(`${addr(0, c)} should say "${names[0]}" but says "${got}"`);
    }
  });
  if (bad.length) throw new Error(`The "${sheet}" sheet isn't laid out as expected (${bad.join('; ')}).`);
}

// ---- sale sheets -----------------------------------------------------------
function readSales(ws, spec, date1904, warn) {
  checkHeaders(ws, spec.name, [['Date'], ['Bill No.'], ['Vehicle'], ['Quantity'], ['RSP', 'Rate'],
    ['Amount'], ['Customer', 'Company']]);
  const { rows } = sheetBounds(ws);
  const out = [];
  let incomplete = 0;
  for (let r = 1; r < rows; r++) {
    const bill = text(ws, r, 1);
    if (!bill) continue;
    const date = cellDate(ws[addr(r, 0)], date1904);
    const customer = text(ws, r, 6);
    if (!date || !customer) {
      incomplete += 1;
      continue;
    }
    out.push({
      product: spec.product, bill_no: bill, sale_date: date, vehicle: text(ws, r, 2),
      qty: cellNumber(ws[addr(r, 3)]), rate: cellNumber(ws[addr(r, 4)]),
      amount: cellNumber(ws[addr(r, 5)]), customer, item: '', seq: r + 1,
    });
  }
  if (incomplete) warn(`${spec.name}: ${incomplete} row(s) with a bill number but no date or customer were left out.`);
  return out;
}

function readOtherSales(ws, date1904, warn) {
  checkHeaders(ws, 'Other Sale', [['Date'], ['Bill No.'], ['Product Name'], ['Amount'], ['Company', 'Customer']]);
  const { rows } = sheetBounds(ws);
  const out = [];
  let incomplete = 0;
  for (let r = 1; r < rows; r++) {
    const bill = text(ws, r, 1);
    if (!bill) continue;
    const date = cellDate(ws[addr(r, 0)], date1904);
    const customer = text(ws, r, 4);
    if (!date || !customer) {
      incomplete += 1;
      continue;
    }
    out.push({
      product: 'OTHER', bill_no: bill, sale_date: date, vehicle: '', qty: null, rate: null,
      amount: cellNumber(ws[addr(r, 3)]), customer, item: text(ws, r, 2), seq: r + 1,
    });
  }
  if (incomplete) warn(`Other Sale: ${incomplete} row(s) with a bill number but no date or company were left out.`);
  return out;
}

function readPayments(ws, date1904, warn) {
  checkHeaders(ws, 'Master Paid', [['Date'], ['Customer'], ['Amount Paid', 'Amount'], ['Payment Mode', 'Mode']]);
  const { rows } = sheetBounds(ws);
  const out = [];
  let incomplete = 0;
  for (let r = 1; r < rows; r++) {
    const dateCell = ws[addr(r, 0)];
    const customer = text(ws, r, 1);
    const amount = cellNumber(ws[addr(r, 2)]);
    const date = cellDate(dateCell, date1904);
    if (!date && !customer && amount == null) continue;
    if (!date || !customer || amount == null) {
      incomplete += 1;
      continue;
    }
    out.push({ pay_date: date, customer, amount, mode: text(ws, r, 3), seq: r + 1 });
  }
  if (incomplete) warn(`Master Paid: ${incomplete} row(s) missing a date, customer or amount were left out.`);
  return out;
}

// ---- Outstanding ------------------------------------------------------------
function monthStart(cell, date1904) {
  if (!cell || cell.t !== 'n' || !(cell.v >= 36526 && cell.v < 73051)) return null;
  const iso = cellDate(cell, date1904);
  return iso ? iso.slice(0, 8) + '01' : null;
}

function readOutstanding(ws, date1904, warn) {
  const { rows, cols } = sheetBounds(ws);
  const width = Math.min(cols, 80);
  const ledgers = [];
  let tbl = null;
  for (let r = 0; r < Math.min(rows, 15) && !tbl; r++) {
    for (let c = 0; c < width - 1; c++) {
      if (label(text(ws, r, c)) === 'customer' && label(text(ws, r, c + 1)) === 'ledger') {
        tbl = { r, c };
        break;
      }
    }
  }
  if (tbl) {
    for (let r = tbl.r + 1; r < rows; r++) {
      const name = text(ws, r, tbl.c);
      if (name) ledgers.push({ name, ledger: text(ws, r, tbl.c + 1) });
    }
  } else {
    warn('Outstanding: couldn\'t find the Customer / Ledger table, so ledger names weren\'t copied.');
  }

  // Monthly opening balances: a row of month dates with customer names in
  // the column to their left (Module5: names M4:M70, months N3:Y3).
  const opening = [];
  let head = null;
  for (let r = 0; r < Math.min(rows, 12) && !head; r++) {
    for (let c = 1; c < width; c++) {
      const run = [];
      for (let k = c; k < width; k++) {
        const iso = monthStart(ws[addr(r, k)], date1904);
        if (!iso) break;
        run.push({ c: k, iso });
      }
      if (run.length >= 2) {
        head = { r, c, run };
        break;
      }
    }
  }
  if (head) {
    for (let r = head.r + 1; r < rows; r++) {
      const name = text(ws, r, head.c - 1);
      if (!name) continue;
      for (const { c, iso } of head.run) {
        const amount = cellNumber(ws[addr(r, c)]);
        if (amount != null) opening.push({ customer: name, month: iso, amount });
      }
    }
  } else {
    warn('Outstanding: couldn\'t find the monthly opening-balance table.');
  }
  return { ledgers, opening };
}

function readCustomerGst(ws) {
  const { rows } = sheetBounds(ws);
  const out = [];
  for (let r = 1; r < rows; r++) {
    const name = text(ws, r, 0);
    const gstin = text(ws, r, 1).replace(/^gstin\s*[:\-]?\s*/i, '').replace(/\s+/g, '');
    if (name) out.push({ name, gstin });
  }
  return out;
}

// ---- *_Bulk sheets ------------------------------------------------------------
function findLabel(ws, want, maxRow, maxCol) {
  for (let r = 0; r < maxRow; r++) {
    for (let c = 0; c < maxCol; c++) {
      if (label(text(ws, r, c)) === want) return { r, c };
    }
  }
  return null;
}

const ROW_HEADERS = ['date', 'bill no', 'billing name', 'volume', 'price', 'amount', 'paid', 'tds',
  'shortage', 'balance', 'unit', 'product', 'po no', 'remarks'];

function readBulk(ws, code, gst, date1904, warn) {
  const { rows, cols } = sheetBounds(ws);
  const width = Math.min(cols, 120);
  const hdr = {};
  for (let c = 0; c < width; c++) {
    const l = label(text(ws, 4, c));
    if (ROW_HEADERS.includes(l) && hdr[l] == null) hdr[l] = c;
  }
  if (hdr.date == null || hdr.product == null) {
    warn(`${code}: row 5 doesn't have the usual Date / Product headings, so this sheet was skipped.`);
    return null;
  }

  const custAt = findLabel(ws, 'customer', 6, Math.min(width, 40));
  const groupAt = findLabel(ws, 'group', 6, Math.min(width, 40));
  const openAt = findLabel(ws, 'opening balance', 6, Math.min(width, 40));
  const customer = custAt ? text(ws, custAt.r, custAt.c + 1) : '';

  let opening = null;
  let periodFrom = null;
  if (openAt) {
    opening = cellNumber(ws[addr(openAt.r, openAt.c + 1)]);
    periodFrom = cellDate(ws[addr(openAt.r + 1, openAt.c + 1)], date1904);
  }
  if (!periodFrom) {
    const pf = findLabel(ws, 'period from', 6, Math.min(width, 40));
    if (pf) periodFrom = cellDate(ws[addr(pf.r, pf.c + 1)], date1904);
  }

  // PO lists you type into: a "PO No." / "Allotted (L)" pair in row 4 whose
  // cells below are values, not formulas (the "live status" copy is formulas).
  const registers = [];
  for (let c = 0; c < width - 1; c++) {
    if (label(text(ws, 3, c)) !== 'po no' || !label(text(ws, 3, c + 1)).startsWith('allotted')) continue;
    let formulas = false;
    for (let r = 4; r < 54 && !formulas; r++) if (ws[addr(r, c)] && ws[addr(r, c)].f) formulas = true;
    if (formulas) continue;
    let unit = '';
    for (const k of [c, c + 1, c - 1]) {
      if (k >= 0 && label(text(ws, 1, k)) === 'unit') unit = poKey(text(ws, 1, k + 1));
    }
    if (!unit) {
      const m = text(ws, 0, c).match(/UNIT\s*\d+/i);
      if (m) unit = poKey(m[0].replace(/\s+/, ' '));
    }
    const pos = [];
    for (let r = 4; r < 54; r++) {
      const po = text(ws, r, c);
      if (po) pos.push({ group_code: code, unit, po_no: po, allotted: cellNumber(ws[addr(r, c + 1)]) ?? 0, seq: r - 3 });
    }
    registers.push({ col: c, unit, pos });
  }

  const hasPoColumn = hdr['po no'] != null;
  let kind = 'group';
  if (hasPoColumn) kind = registers.length >= 2 ? 'po_units' : 'po';
  if (hasPoColumn && registers.length === 0) warn(`${code}: has a PO No. column but no PO list was found.`);
  const units = kind === 'po_units' ? registers.map((g) => g.unit || '') : [];
  if (kind === 'po_units' && units.some((u) => !u)) warn(`${code}: couldn't read the unit name of every PO list.`);
  if (kind === 'po_units' && hdr.unit == null) warn(`${code}: has unit-wise PO lists but no Unit column.`);
  if (kind !== 'po_units') registers.forEach((g) => { g.unit = ''; g.pos.forEach((p) => { p.unit = ''; }); });

  // Opening balance per unit (SMC: unit names in one row, amounts below).
  const openingByUnit = {};
  if (kind === 'po_units' && units.length >= 2) {
    const limitC = Math.min(...registers.map((g) => g.col));
    outer: for (let r = 5; r < Math.min(rows, 60); r++) {
      for (let c = 0; c < limitC - 1; c++) {
        if (poKey(text(ws, r, c)) === units[0] && poKey(text(ws, r, c + 1)) === units[1]) {
          units.forEach((u, i) => { openingByUnit[u] = cellNumber(ws[addr(r + 1, c + i)]); });
          break outer;
        }
      }
    }
  }

  // Group ledgers take their members from a Customer GST column named in
  // the sheet's formulas, e.g. 'Customer GST'!$G$1:$G$50.
  const members = new Map();
  if (customer) members.set(normKey(customer), customer);
  if (groupAt || !customer) {
    const ref = /'?Customer GST'?!\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)/i;
    for (let r = 0; r < Math.min(rows, 12); r++) {
      for (let c = 0; c < width; c++) {
        const f = ws[addr(r, c)] && ws[addr(r, c)].f;
        const m = f && f.match(ref);
        if (!m || !gst) continue;
        const col = m[1].toUpperCase();
        for (let k = Number(m[2]); k <= Number(m[4]); k++) {
          const name = cellText(gst[col + k]);
          if (name) members.set(normKey(name), name);
        }
      }
    }
  }

  // The rows: bills (with what you typed against them) and payments.
  const firstFormulaRow = (() => {
    if (!hasPoColumn) return Infinity;
    for (let r = 5; r < rows; r++) if (ws[addr(r, hdr['po no'])] && ws[addr(r, hdr['po no'])].f) return r;
    return Infinity;
  })();
  const bills = [];
  const payments = [];
  let otherWithTds = 0;
  for (let r = 5; r < rows; r++) {
    const date = cellDate(ws[addr(r, hdr.date)], date1904);
    if (!date) continue;
    const prod = text(ws, r, hdr.product).toUpperCase();
    const who = hdr['billing name'] != null ? text(ws, r, hdr['billing name']) : customer;
    if (hdr['billing name'] != null && who) members.set(normKey(who), who);
    const extras = {
      tds: hdr.tds != null ? cellNumber(ws[addr(r, hdr.tds)]) : null,
      shortage: hdr.shortage != null ? cellNumber(ws[addr(r, hdr.shortage)]) : null,
      remarks: hdr.remarks != null ? text(ws, r, hdr.remarks) : '',
    };
    if (prod === 'PAYMENT') {
      payments.push({ customer: who, date, ...extras });
      continue;
    }
    const product = PRODUCT_OF[prod];
    const bill = hdr['bill no'] != null ? text(ws, r, hdr['bill no']) : '';
    if (!product || !bill) {
      if (extras.tds || extras.shortage) otherWithTds += 1;
      continue;
    }
    const row = { product, bill_no: bill, sale_date: date, customer: who, row: r + 1, ...extras };
    if (hdr.unit != null) row.unit = poKey(text(ws, r, hdr.unit));
    if (hasPoColumn && product === 'HSD') {
      const cell = ws[addr(r, hdr['po no'])];
      const value = cellText(cell);
      if (cell && cell.f) {
        row.po_mode = 'auto';
        row.excel_po = value;
      } else if (value) {
        row.po_mode = 'fixed';
        row.po_fixed = value;
      } else if (r < firstFormulaRow) {
        row.po_mode = 'fixed';                   // before Excel's PO formula starts: no PO
        row.po_fixed = '';
      } else {
        row.po_mode = 'auto';
      }
    }
    bills.push(row);
  }
  if (otherWithTds) warn(`${code}: TDS / shortage on ${otherWithTds} non-fuel row(s) wasn't copied.`);

  return {
    group: {
      code, title: text(ws, 0, 0), kind, units, period_from: periodFrom, opening,
      opening_by_unit: openingByUnit,
    },
    members: [...members.values()],
    pos: registers.flatMap((g) => g.pos),
    bills,
    payments,
  };
}

// ---- the whole workbook ----------------------------------------------------------
export function extractMaster(wb) {
  const date1904 = Boolean(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
  const warnings = [];
  const warn = (w) => warnings.push(w);

  const missing = REQUIRED.filter((n) => !findSheet(wb, n));
  if (missing.length) {
    throw new Error(`This doesn't look like the Master Ledger: no ${missing.map((m) => `"${m}"`).join(', ')} sheet.`);
  }

  // Sales
  let sales = [];
  for (const spec of SALE_SHEETS) sales = sales.concat(readSales(findSheet(wb, spec.name), spec, date1904, warn));
  const other = findSheet(wb, 'Other Sale');
  if (other) sales = sales.concat(readOtherSales(other, date1904, warn));
  const byKey = new Map();
  const dupes = [];
  sales = sales.filter((s) => {
    const k = billKey(s.product, s.sale_date, s.bill_no);
    if (byKey.has(k)) {
      dupes.push(`${s.product} bill ${s.bill_no} (${s.sale_date})`);
      return false;
    }
    byKey.set(k, s);
    return true;
  });
  if (dupes.length) {
    warn(`${dupes.length} bill number(s) appear twice on the sale sheets; only the first row of each was copied: ${dupes.slice(0, 5).join(', ')}${dupes.length > 5 ? ' …' : ''}.`);
  }

  const payments = readPayments(findSheet(wb, 'Master Paid'), date1904, warn);

  const out = findSheet(wb, 'Outstanding');
  const { ledgers, opening } = out ? readOutstanding(out, date1904, warn) : { ledgers: [], opening: [] };
  if (!out) warn('No "Outstanding" sheet, so ledger names and opening balances weren\'t copied.');
  const gstWs = findSheet(wb, 'Customer GST');
  const gstins = gstWs ? readCustomerGst(gstWs) : [];

  // Bulk sheets
  const bulk = wb.SheetNames.filter((n) => /_bulk\s*$/i.test(n))
    .map((n) => readBulk(wb.Sheets[n], n.trim(), gstWs, date1904, warn))
    .filter(Boolean);

  // Per-bill cells from the bulk sheets onto the sales rows.
  let notOnSaleSheets = 0;
  for (const b of bulk) {
    for (const row of b.bills) {
      const s = byKey.get(billKey(row.product, row.sale_date, row.bill_no));
      if (!s) {
        notOnSaleSheets += 1;
        continue;
      }
      if (row.unit) s.unit = row.unit;
      if (row.po_mode) {
        s.po_mode = row.po_mode;
        if (row.po_mode === 'fixed') s.po_fixed = row.po_fixed;
      }
      if (row.tds != null) s.tds = row.tds;
      if (row.shortage != null) s.shortage = row.shortage;
      if (row.remarks) s.remarks = row.remarks;
    }
  }
  if (notOnSaleSheets) warn(`${notOnSaleSheets} row(s) on the Bulk sheets have no matching bill on the sale sheets.`);

  // Payment rows of the bulk sheets: the n-th payment of a customer on a
  // day is that day's n-th Master Paid entry for the customer.
  const payIndex = new Map();
  for (const p of payments) {
    const k = normKey(p.customer) + '|' + p.pay_date;
    if (!payIndex.has(k)) payIndex.set(k, []);
    payIndex.get(k).push(p);
  }
  let unmatchedPayExtras = 0;
  for (const b of bulk) {
    const seen = new Map();
    for (const row of b.payments) {
      const k = normKey(row.customer) + '|' + row.date;
      const n = seen.get(k) || 0;
      seen.set(k, n + 1);
      if (row.tds == null && row.shortage == null && !row.remarks) continue;
      const target = (payIndex.get(k) || [])[n];
      if (!target) {
        unmatchedPayExtras += 1;
        continue;
      }
      if (row.tds != null) target.tds = row.tds;
      if (row.shortage != null) target.shortage = row.shortage;
      if (row.remarks) target.remarks = row.remarks;
    }
  }
  if (unmatchedPayExtras) warn(`${unmatchedPayExtras} TDS / shortage entr(ies) on Bulk payment rows had no matching Master Paid entry.`);

  // Customers
  const customers = new Map();
  const addCustomer = (name, fields) => {
    const k = normKey(name);
    if (!k) return;
    const c = customers.get(k) || { name: String(name).trim() };
    for (const [f, v] of Object.entries(fields)) if (v && !c[f]) c[f] = v;
    customers.set(k, c);
  };
  ledgers.forEach((l) => addCustomer(l.name, { ledger: l.ledger }));
  gstins.forEach((g) => addCustomer(g.name, { gstin: g.gstin }));
  bulk.forEach((b) => b.members.forEach((m) => addCustomer(m, { bulk_group: b.group.code })));

  // PO check: the app's rule on the workbook's data vs. the POs Excel shows.
  const checks = bulk.filter((b) => b.group.kind !== 'group').map((b) => {
    const rows = b.bills.filter((r) => r.product === 'HSD')
      .map((r) => {
        const s = byKey.get(billKey('HSD', r.sale_date, r.bill_no));
        return {
          ...r, date: r.sale_date, seq: s ? s.seq : r.row, qty: s ? s.qty : null,
          po_mode: r.po_mode === 'fixed' ? 'fixed' : 'auto',
        };
      })
      .sort(billOrder);
    const res = allocate({ kind: b.group.kind, units: b.group.units, pos: b.pos, bills: rows });
    const mismatches = [];
    let compared = 0;
    rows.forEach((r, i) => {
      if (r.excel_po === undefined) return;
      compared += 1;
      if (poKey(res.bills[i].po) !== poKey(r.excel_po)) {
        mismatches.push({ date: r.date, bill_no: r.bill_no, excel: r.excel_po, app: res.bills[i].po });
      }
    });
    return { code: b.group.code, compared, matched: compared - mismatches.length, mismatches };
  });

  const payload = {
    groups: bulk.map((b) => b.group),
    customers: [...customers.values()],
    sales: sales.map((s) => ({
      product: s.product, bill_no: s.bill_no, sale_date: s.sale_date, vehicle: s.vehicle,
      qty: s.qty, rate: s.rate, amount: s.amount, customer: s.customer, item: s.item, seq: s.seq,
      unit: s.unit || '', po_mode: s.po_mode || 'auto', po_fixed: s.po_fixed || '',
      tds: s.tds ?? null, shortage: s.shortage ?? null, remarks: s.remarks || '',
    })),
    payments: payments.map((p) => ({
      pay_date: p.pay_date, customer: p.customer, amount: p.amount, mode: p.mode, seq: p.seq,
      tds: p.tds ?? null, shortage: p.shortage ?? null, remarks: p.remarks || '',
    })),
    pos: bulk.flatMap((b) => b.pos),
    opening,
  };

  const span = (list, field) => {
    const d = list.map((x) => x[field]).filter(Boolean).sort();
    return { count: list.length, from: d[0] || null, to: d[d.length - 1] || null };
  };
  const preview = {
    sales: Object.fromEntries(['HSD', 'MS', 'XG', 'OTHER'].map((p) => [p, span(sales.filter((s) => s.product === p), 'sale_date')])),
    payments: { ...span(payments, 'pay_date'), total: payments.reduce((a, p) => a + (p.amount || 0), 0) },
    customers: customers.size,
    ledgerNames: ledgers.filter((l) => l.ledger).length,
    opening: { count: opening.length, months: [...new Set(opening.map((o) => o.month))].sort() },
    groups: bulk.map((b) => ({
      code: b.group.code, title: b.group.title, kind: b.group.kind, units: b.group.units,
      period_from: b.group.period_from, members: b.members, pos: b.pos.length,
      bills: b.bills.filter((r) => r.product === 'HSD').length,
      check: checks.find((c) => c.code === b.group.code) || null,
    })),
  };
  return { payload, preview, warnings };
}
