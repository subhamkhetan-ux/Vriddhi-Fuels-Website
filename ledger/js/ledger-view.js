// A customer's ledger as the app shows it (summary cards + a statement by
// month) and as the shared pictures draw it (share-svg.js). Built from the
// same rows as the sheet views — account.js bulkRows() for a *_Bulk sheet,
// statements.js ledgerRows() for a ledger sheet — so every figure matches
// the Master Ledger. Also the day-by-day rate chart for the Excel download.
// Pure functions: no DOM, no network.

import { isoToSerial, normKey } from './util.js';

export const PRODUCT_LABEL = { HSD: 'Diesel', MS: 'Petrol', XG: 'XtraGreen', OTHER: 'Other' };
const CODE_OF = { DIESEL: 'HSD', PETROL: 'MS', XTRAGREEN: 'XG' };
const round2 = (n) => Math.round(n * 100) / 100;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthTitle = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

// bulkRows() labels the product (DIESEL / PETROL / XtraGreen / Payment / item)
function codeOf(r) {
  if (r.payment) return 'PAY';
  return CODE_OF[String(r.product || '').toUpperCase()] || 'OTHER';
}

function blankProducts() {
  return Object.fromEntries(['HSD', 'MS', 'XG', 'OTHER'].map((p) => [p, { qty: 0, amount: 0, bills: 0 }]));
}

// entries -> months (oldest first), each with its own totals and closing
function byMonth(entries, opening) {
  const months = [];
  let bal = opening;
  for (const e of entries) {
    const ym = e.date.slice(0, 7);
    let m = months[months.length - 1];
    if (!m || m.month !== ym) {
      m = { month: ym, title: monthTitle(ym), opening: bal, entries: [], billed: 0, received: 0, deductions: 0, qty: 0, bills: 0, payments: 0 };
      months.push(m);
    }
    m.entries.push(e);
    m.billed += e.debit;
    m.received += e.paid;
    m.deductions += e.tds + e.shortage;
    m.qty += e.qty;
    if (e.paid) m.payments += 1;
    if (e.type !== 'pay' && e.debit) m.bills += 1;
    bal = e.balance;
    m.closing = bal;
  }
  for (const m of months) ['billed', 'received', 'deductions', 'qty'].forEach((k) => { m[k] = round2(m[k]); });
  return months;
}

function summarise(entries) {
  const t = { billed: 0, qty: 0, received: 0, tds: 0, shortage: 0, bills: 0, payments: 0 };
  const products = blankProducts();
  let lastPayment = null;
  let lastBill = null;
  for (const e of entries) {
    t.billed += e.debit; t.qty += e.qty; t.received += e.paid; t.tds += e.tds; t.shortage += e.shortage;
    // a ledger sheet puts a day's payment on that day's first sale row
    if (e.paid) {
      t.payments += 1;
      if (e.paid > 0 && (!lastPayment || e.date >= lastPayment.date)) lastPayment = { date: e.date, amount: e.paid };
    }
    if (e.type !== 'pay' && e.debit) {
      t.bills += 1;
      const p = products[e.product] || products.OTHER;
      p.qty += e.qty; p.amount += e.debit; p.bills += e.bills || 1;
      if (!lastBill || e.date >= lastBill) lastBill = e.date;
    }
  }
  Object.keys(t).forEach((k) => { t[k] = round2(t[k]); });
  Object.values(products).forEach((p) => { p.qty = round2(p.qty); p.amount = round2(p.amount); });
  return { totals: t, products, lastPayment, lastBill };
}

// ---- a *_Bulk sheet ---------------------------------------------------------------
// res: bulkRows(data, poOf); data: store.account(null, code)
export function bulkStatement(res, data, { name = '' } = {}) {
  const g = data.group || {};
  const group = res.kind === 'group';
  const entries = res.rows.map((r) => {
    const code = codeOf(r);
    const tds = Number(r.tds) || 0;
    const shortage = Number(r.shortage) || 0;
    const detail = [];
    if (group && r.name) detail.push(r.name);
    if (r.unit) detail.push(r.unit);
    if (r.po) detail.push(`PO ${r.po}`);
    if (r.remarks) detail.push(r.remarks);
    let title;
    if (code === 'PAY') title = r.paid < 0 ? 'Refund' : 'Payment received';
    else if (code === 'OTHER') title = `${r.product}${r.bill ? ` · Bill ${r.bill}` : ''}`;
    else title = `${PRODUCT_LABEL[code]}${r.bill ? ` · Bill ${r.bill}` : ''}`;
    return {
      date: r.date, type: code === 'PAY' ? 'pay' : 'bill', product: code, title, detail: detail.join(' · '),
      company: r.name || '', qty: Number(r.qty) || 0, rate: Number(r.rate) || 0,
      debit: Number(r.amount) || 0, paid: Number(r.paid) || 0, tds, shortage,
      credit: round2((Number(r.paid) || 0) + tds + shortage), balance: r.balance,
    };
  });
  const sum = summarise(entries);
  const members = data.members || [];
  return {
    kind: 'bulk', layout: res.kind, code: g.code, name: name || g.title || g.code,
    from: g.period_from || entries[0]?.date || '', to: entries.length ? entries[entries.length - 1].date : (g.period_from || ''),
    opening: res.opening, closing: res.closing, entries, months: byMonth(entries, res.opening), ...sum,
    members: members.map((m) => m.name),
    companies: companyWise(entries, members, res.opening, res.closing),
  };
}

// Company-wise outstanding of a group sheet (one *_Bulk sheet, several billing
// names): each company's bills − payments − TDS − shortage since the sheet's
// period from. The sheet's opening balance belongs to the group as a whole,
// so opening + every company = the group's balance. null for a one-company sheet.
export function companyWise(entries, members, opening, closing) {
  const map = new Map();
  const add = (name) => {
    const k = normKey(name);
    if (!map.has(k)) map.set(k, { name: String(name || '').trim() || 'Unnamed', billed: 0, qty: 0, received: 0, deductions: 0, bills: 0, payments: 0, lastBill: '', lastPayment: null });
    return map.get(k);
  };
  for (const m of members || []) add(m.name);
  for (const e of entries) {
    const c = add(e.company || (members && members.length === 1 ? members[0].name : ''));
    c.billed += e.debit; c.qty += e.qty; c.received += e.paid; c.deductions += e.tds + e.shortage;
    if (e.paid) {
      c.payments += 1;
      if (e.paid > 0 && (!c.lastPayment || e.date >= c.lastPayment.date)) c.lastPayment = { date: e.date, amount: e.paid };
    }
    if (e.type !== 'pay' && e.debit) {
      c.bills += 1;
      if (e.date > c.lastBill) c.lastBill = e.date;
    }
  }
  if (map.size < 2) return null;
  const list = [...map.values()].map((c) => ({
    ...c, billed: round2(c.billed), qty: round2(c.qty), received: round2(c.received), deductions: round2(c.deductions),
    outstanding: round2(c.billed - c.received - c.deductions),
  })).sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  return { list, opening: round2(opening || 0), total: round2(closing) };
}

// ---- a ledger sheet (one month) -----------------------------------------------------
// led: statements.js ledgerRows(); one row per day and product, payments of a
// day on its first row
export function retailStatement(led, { name = '', from = '', to = '' } = {}) {
  const entries = led.rows.map((r) => {
    const code = r.hasSale ? (r.product in PRODUCT_LABEL ? r.product : 'OTHER') : 'PAY';
    const paid = Number(r.paid) || 0;
    let title;
    if (!r.hasSale) title = paid < 0 ? 'Refund' : 'Payment received';
    else title = code === 'OTHER' ? r.label : PRODUCT_LABEL[code];
    return {
      date: r.date, type: r.hasSale ? 'bill' : 'pay', product: code, title,
      detail: r.hasSale && paid ? 'Payment received the same day' : '',
      company: name, qty: r.hasSale ? Number(r.qty) || 0 : 0, rate: r.hasSale && r.rate != null ? Number(r.rate) : 0,
      debit: Number(r.amount) || 0, paid, tds: 0, shortage: 0, credit: paid, balance: r.balance,
    };
  });
  const sum = summarise(entries);
  return {
    kind: 'retail', name, from: from || led.from, to: to || (entries.length ? entries[entries.length - 1].date : led.from),
    opening: led.opening, closing: led.closing, entries, months: byMonth(entries, led.opening), ...sum,
    members: [name], companies: null,
  };
}

// ---- the rate chart: each product's price per day --------------------------------
// series: analyse().rspSeries {HSD: [{date, rsp}], MS: [...], XG: [...]}
// -> [{date, HSD, MS, XG}] (null where the day has no rate); products with no
// rate in the whole range are left out of `products`.
export function rateChart(series) {
  const products = ['HSD', 'MS', 'XG'].filter((p) => (series[p] || []).some((d) => d.rsp != null));
  const dates = (series.HSD || series.MS || series.XG || []).map((d) => d.date);
  const at = Object.fromEntries(['HSD', 'MS', 'XG'].map((p) => [p, new Map((series[p] || []).map((d) => [d.date, d.rsp]))]));
  const rows = dates.map((date) => ({ date, HSD: at.HSD.get(date) ?? null, MS: at.MS.get(date) ?? null, XG: at.XG.get(date) ?? null }));
  return { products, rows };
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The sheet as an array of rows (SheetJS aoa_to_sheet): title, period, header
// (row 4), one row per day (oldest first) with the change from the day before.
// Dates are Excel serials (format the column as a date); HEAD_ROWS rows come
// before the first day.
export const RATE_HEAD_ROWS = 4;
export function rateChartSheet(chart, { from, to, title = 'Vriddhi Fuels — Rate chart (₹ per litre)' } = {}) {
  const names = chart.products.map((p) => PRODUCT_LABEL[p]);
  const head = ['Date', 'Day', ...names, ...names.map((n) => `${n} change`)];
  const dmy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
  const prev = {};
  const body = chart.rows.map((r) => {
    const wd = DAY[new Date(`${r.date}T00:00:00Z`).getUTCDay()];
    const changes = chart.products.map((p) => {
      const v = r[p];
      const c = v != null && prev[p] != null ? round2(v - prev[p]) : null;
      if (v != null) prev[p] = v;
      return c ? c : null;
    });
    return [isoToSerial(r.date), wd, ...chart.products.map((p) => r[p]), ...changes];
  });
  return [[title], [`${dmy(from)} to ${dmy(to)} · the day's RSP — the highest price billed that day`], [], head, ...body];
}
