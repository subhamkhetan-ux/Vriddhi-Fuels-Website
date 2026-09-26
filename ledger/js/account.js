// A customer's ledger as on their sheet in the Master Ledger.
//   Bulk (*_Bulk sheets): the sheet's own formula — every member's bills
//   (diesel, petrol, XtraGreen, then payments, then Other Sale), sorted by
//   date; balance = opening + amount − paid − TDS − shortage. Three layouts:
//     group    — Date | Billing Name | Bill No. | Volume | Price | Amount | Paid | TDS | Shortage | Balance | Product | Remarks
//     po       — Date | Bill No. | Volume | Price | Amount | Paid | TDS | Shortage | Balance | Product | PO No. | Remarks
//     po_units — Date | Bill No. | Volume | Price | Amount | Paid | TDS | Shortage | Balance | Unit | Product | PO No. | Remarks
//   Retail ledger sheets use statements.js ledgerRows (the same rows as the
//   ledger picture).
// Pure functions: no DOM, no network.

export const BULK_COLUMNS = {
  group: ['date', 'name', 'bill', 'qty', 'rate', 'amount', 'paid', 'tds', 'shortage', 'balance', 'product', 'remarks'],
  po: ['date', 'bill', 'qty', 'rate', 'amount', 'paid', 'tds', 'shortage', 'balance', 'product', 'po', 'remarks'],
  po_units: ['date', 'bill', 'qty', 'rate', 'amount', 'paid', 'tds', 'shortage', 'balance', 'unit', 'product', 'po', 'remarks'],
};
export const COLUMN_HEAD = {
  date: 'Date', name: 'Billing Name', bill: 'Bill No.', qty: 'Volume', rate: 'Price', amount: 'Amount', paid: 'Paid',
  tds: 'TDS', shortage: 'Shortage', balance: 'Balance', unit: 'Unit', product: 'Product', po: 'PO No.', remarks: 'Remarks',
};
// Excel column widths when the upload brought none (a typical sheet)
export const DEFAULT_BULK_WIDTHS = {
  group: [12.16, 50.33, 15.83, 11.5, 9.83, 15, 16.83, 9.83, 13, 18.66, 12, 13.16],
  po: [12.16, 12.16, 11.5, 9.83, 15, 15, 9.83, 13, 15.5, 12.83, 18.66, 24.83],
  po_units: [13, 11.33, 11.5, 9.83, 19, 16.5, 9.83, 13, 17.16, 18.33, 27, 17.83, 26.33],
};

const LABEL = { HSD: 'DIESEL', MS: 'PETROL', XG: 'XtraGreen' };
const STACK = { HSD: 0, MS: 1, XG: 2, PAY: 3, OTHER: 4 };
const num = (v) => (v == null || v === '' ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;

// data: store.account(null, code) ; poOf(saleId) -> PO number
export function bulkRows(data, poOf = () => '') {
  const g = data.group;
  const kind = BULK_COLUMNS[g.kind] ? g.kind : 'po';
  const items = [];
  for (const s of data.sales || []) {
    const other = s.product === 'OTHER';
    items.push({
      stack: other ? STACK.OTHER : STACK[s.product], order: Number(s.seq) || 0, id: s.id,
      date: s.sale_date, name: s.customer, bill: other ? '' : String(s.bill_no ?? ''),
      qty: num(s.qty) || 0, rate: num(s.rate) || 0, amount: num(s.amount) || 0, paid: 0,
      tds: num(s.tds), shortage: num(s.shortage),
      product: other ? (String(s.item || '').trim() || 'Other') : LABEL[s.product],
      unit: s.unit || '', po: s.product === 'HSD' ? (poOf(s.id) || '') : '', remarks: s.remarks || '',
      petrol: s.product === 'MS', payment: false,
    });
  }
  for (const p of data.payments || []) {
    items.push({
      stack: STACK.PAY, order: Number(p.seq) || 0, id: p.id, date: p.pay_date, name: p.customer, bill: '',
      qty: 0, rate: 0, amount: 0, paid: num(p.amount) || 0, tds: num(p.tds), shortage: num(p.shortage),
      product: 'Payment', unit: '', po: '', remarks: p.remarks || '', petrol: false, payment: true,
    });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.stack - b.stack || a.order - b.order || a.id - b.id);
  const opening = num(g.opening) || 0;
  let bal = opening;
  const totals = { qty: 0, amount: 0, paid: 0, tds: 0, shortage: 0 };
  const rows = items.map((r) => {
    bal = round2(bal + r.amount - r.paid - (r.tds || 0) - (r.shortage || 0));
    totals.qty += r.qty; totals.amount += r.amount; totals.paid += r.paid;
    totals.tds += r.tds || 0; totals.shortage += r.shortage || 0;
    return { ...r, balance: bal };
  });
  Object.keys(totals).forEach((k) => { totals[k] = round2(totals[k]); });
  const widths = Array.isArray(g.layout?.cols) && g.layout.cols.length >= BULK_COLUMNS[kind].length
    ? g.layout.cols.slice(0, BULK_COLUMNS[kind].length + 3).map(Number) : null;
  return { kind, columns: BULK_COLUMNS[kind], rows, opening, closing: bal, totals, widths };
}

// ---- the sheets' number formats ------------------------------------------------------

const grp3 = (n, d = 0) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// dd/mm/yy
export const xlDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '');
// #,##0;(#,##0);" " — blank for zero
export function xlVolume(n) {
  const v = Math.round(Number(n) || 0);
  if (!v) return '';
  return v < 0 ? `(${grp3(v)})` : grp3(v);
}
// 0.00;(0.00);" "
export function xlPrice(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  return v < 0 ? `(${Math.abs(v).toFixed(2)})` : v.toFixed(2);
}
// [$₹-4009]#,##0;-[$₹-4009]#,##0;- — a dash for zero; blank when the cell is empty
export function xlRupee(n, { blankIfEmpty = false } = {}) {
  if (n == null || n === '') return blankIfEmpty ? '' : '-';
  const v = Math.round(Number(n) || 0);
  if (!v) return '-';
  return v < 0 ? `-₹${grp3(v)}` : `₹${grp3(v)}`;
}

export function cellText(col, r) {
  switch (col) {
    case 'date': return xlDate(r.date);
    case 'name': return r.name;
    case 'bill': return r.bill;
    case 'qty': return xlVolume(r.qty);
    case 'rate': return xlPrice(r.rate);
    case 'amount': return xlRupee(r.amount);
    case 'paid': return xlRupee(r.paid);
    case 'tds': return xlRupee(r.tds, { blankIfEmpty: true });
    case 'shortage': return xlRupee(r.shortage, { blankIfEmpty: true });
    case 'balance': return xlRupee(r.balance);
    case 'unit': return r.unit;
    case 'product': return r.product;
    case 'po': return r.po;
    case 'remarks': return r.remarks;
    default: return '';
  }
}

// negative numbers show red (the sheet's conditional format "< 0")
export function isNegative(col, r) {
  return ['qty', 'rate', 'amount', 'paid', 'tds', 'shortage', 'balance'].includes(col) && Number(r[col]) < 0;
}
