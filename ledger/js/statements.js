// Phase 3: the customer statements — the rules of the workbook's
//   Daily Screenshots  (Module1)  one image per ledger / bill statement / daily summary
//   Monthly Export     (Module2)  one PDF per ledger / bill statement for a month
//   Custom Date Report (Module6)  the same for any From..To range
// Pure functions: no DOM, no network. Drawing is in statement-svg.js.
//
// The data comes from store.statementData(from, to):
//   customers: [{id, name, key, ledger, title, bill_address, gstin, layout, opening}]
//              opening = balance before `from` (Outstanding table + later sales − payments)
//   sales:     [{id, product, bill_no, sale_date, vehicle, qty, rate, amount, customer, key, item, seq}]
//   payments:  [{pay_date, key, amount}]

import { normKey } from './util.js';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const FUEL = ['HSD', 'MS', 'XG'];
const PRODUCT_ORDER = { HSD: 0, MS: 1, XG: 2, OTHER: 3 };
export const LEDGER_PRODUCT = { HSD: 'DIESEL', MS: 'PETROL', XG: 'XtraGreen' };
export const BILL_PRODUCT = { HSD: 'Diesel', MS: 'Petrol', XG: 'XtraGreen' };

// ---- dates ---------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));

export function addDays(iso, n) {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}

export const monthStart = (iso) => `${iso.slice(0, 7)}-01`;

export function monthEnd(iso) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0));
  return isoOf(d);
}

// 2026-09-05 -> "September-2026" (Excel's mmmm-yyyy)
export const monthLabel = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]}-${iso.slice(0, 4)}`;
export const ddmmyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '');
export const ddmmyyyy = (iso, sep = '/') => (iso ? `${iso.slice(8, 10)}${sep}${iso.slice(5, 7)}${sep}${iso.slice(0, 4)}` : '');

// Monthly Export: last month on the 1st, otherwise this month (Module2).
export function defaultMonth(todayIso) {
  return todayIso.slice(8, 10) === '01' ? monthStart(addDays(todayIso, -1)) : monthStart(todayIso);
}

// ---- numbers -------------------------------------------------------------------

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function groupIndian(intStr) {
  if (intStr.length <= 3) return intStr;
  return `${intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${intStr.slice(-3)}`;
}

// Ledger amounts: 1,91,740 / 56,118.40 (decimals only when not whole)
export function indAuto(n) {
  const v = round2(n);
  const neg = v < 0;
  const [i, f] = Math.abs(v).toFixed(2).split('.');
  return `${neg ? '-' : ''}${groupIndian(i)}${f === '00' ? '' : `.${f}`}`;
}

export const rupeeAuto = (n) => (round2(n) < 0 ? `-₹${indAuto(-n)}` : `₹${indAuto(n)}`);

// Excel's General format: 65042.72, 1791000, 101.76
export function general(n) {
  const v = Number(n) || 0;
  return String(Number(v.toPrecision(11)));
}

// ---- file names ------------------------------------------------------------------

// Module1 FirstWord(): the first word of the name, with characters a file
// name can't hold turned into "-" ("M/s Shree ..." -> "M-s").
export function firstWord(name, n = 1) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, n);
  const w = words.join(' ').replace(/[/\\:*?"<>|]/g, '-');
  return w || 'Customer';
}

// Short names for a list of customers; two customers with the same first
// word get more words until they differ (the workbook would overwrite one).
export function shortNames(names) {
  const out = names.map((nm) => firstWord(nm));
  for (let n = 2; n < 8; n++) {
    const count = new Map();
    for (const s of out) count.set(s.toLowerCase(), (count.get(s.toLowerCase()) || 0) + 1);
    let clash = false;
    out.forEach((s, i) => {
      if (count.get(s.toLowerCase()) > 1) { out[i] = firstWord(names[i], n); clash = true; }
    });
    if (!clash) break;
  }
  const seen = new Map();
  return out.map((s) => {
    const k = s.toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
    return seen.get(k) > 1 ? `${s} (${seen.get(k)})` : s;
  });
}

// ---- the ledger (A1:G of a customer sheet) ------------------------------------------

// One row per date and fuel (volume and amount summed, price averaged), a
// row for a date with only a payment, each Other Sale on its own row; within
// a date: diesel, petrol, XtraGreen, payment, other. "Paid" is the day's
// payments, on the day's first row. Balance runs on from the opening.
export function ledgerRows({ opening = 0, from, sales, payments }) {
  const fuel = new Map();
  const other = [];
  for (const s of sales) {
    if (FUEL.includes(s.product)) {
      const k = `${s.sale_date}|${s.product}`;
      if (!fuel.has(k)) fuel.set(k, { date: s.sale_date, product: s.product, qty: 0, amount: 0, rates: [] });
      const r = fuel.get(k);
      r.qty += Number(s.qty) || 0;
      r.amount += Number(s.amount) || 0;
      if (s.rate != null && s.rate !== '') r.rates.push(Number(s.rate));
    } else if (s.product === 'OTHER') {
      other.push({ date: s.sale_date, product: 'OTHER', label: String(s.item || '').trim() || 'Other',
        qty: Number(s.qty) || 0, amount: Number(s.amount) || 0, rates: s.rate != null && s.rate !== '' ? [Number(s.rate)] : [] });
    }
  }
  const paid = new Map();
  for (const p of payments) paid.set(p.pay_date, (paid.get(p.pay_date) || 0) + (Number(p.amount) || 0));
  const fuelDates = new Set([...fuel.values()].map((r) => r.date));
  const RANK = { HSD: 0, MS: 1, XG: 2, '': 3, OTHER: 4 };
  const rank = (r) => RANK[r.product];
  const list = [
    ...[...fuel.values()],
    ...[...paid.keys()].filter((d) => !fuelDates.has(d)).map((d) => ({ date: d, product: '', qty: 0, amount: 0, rates: [] })),
    ...other,
  ].map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.i - b.i);

  let balance = round2(opening);
  let prev = from;                                   // the opening row shows `from`
  const seenPaid = new Set();
  const totals = { qty: 0, amount: 0, paid: 0 };
  const rows = list.map((r) => {
    const p = seenPaid.has(r.date) ? 0 : (paid.get(r.date) || 0);
    seenPaid.add(r.date);
    balance = round2(balance + r.amount - p);
    totals.qty += r.qty;
    totals.amount += r.amount;
    totals.paid += p;
    const row = {
      date: r.date, showDate: r.date !== prev, product: r.product,
      label: r.product === 'OTHER' ? r.label : (LEDGER_PRODUCT[r.product] || ''),
      qty: r.qty, rate: r.rates.length ? r.rates.reduce((a, x) => a + x, 0) / r.rates.length : null,
      amount: r.amount, paid: p, balance, petrol: r.product === 'MS', hasSale: r.product !== '',
    };
    prev = r.date;
    return row;
  });
  return {
    opening: round2(opening), from, rows, closing: balance,
    totals: { qty: round2(totals.qty), amount: round2(totals.amount), paid: round2(totals.paid) },
  };
}

// ---- the bill statement (Q1:X of a customer sheet) -----------------------------------

export function billRows(sales) {
  const list = [...sales].sort((a, b) => a.sale_date.localeCompare(b.sale_date)
    || (PRODUCT_ORDER[a.product] ?? 9) - (PRODUCT_ORDER[b.product] ?? 9) || (a.seq ?? 0) - (b.seq ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  let prev = '';
  const rows = list.map((s) => {
    const r = {
      date: s.sale_date, showDate: s.sale_date !== prev, bill_no: String(s.bill_no ?? ''),
      vehicle: String(s.vehicle ?? '').toUpperCase(), qty: Number(s.qty) || 0,
      rate: s.rate == null || s.rate === '' ? null : Number(s.rate), amount: Number(s.amount) || 0,
      product: s.product === 'OTHER' ? (String(s.item || '').trim() || 'Other') : (BILL_PRODUCT[s.product] || s.product),
      petrol: s.product === 'MS',
    };
    prev = s.sale_date;
    return r;
  });
  return {
    rows,
    totals: { qty: round2(rows.reduce((a, r) => a + r.qty, 0)), amount: round2(rows.reduce((a, r) => a + r.amount, 0)) },
  };
}

// ---- the daily summaries (HSD Daily / MS Daily pivots) ---------------------------------

// Customers in the order they first appear on the sheet; a bill with no
// customer shows as "(blank)", like the pivot.
export function dailySummary(sales, product, date) {
  const byKey = new Map();
  let amount = 0;
  let qty = 0;
  const list = sales.filter((s) => s.product === product && s.sale_date === date)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.id ?? 0) - (b.id ?? 0));
  for (const s of list) {
    const name = String(s.customer ?? '').trim() || '(blank)';
    const k = normKey(name);
    if (!byKey.has(k)) byKey.set(k, { name, amount: 0, qty: 0 });
    const r = byKey.get(k);
    r.amount += Number(s.amount) || 0;
    r.qty += Number(s.qty) || 0;
    amount += Number(s.amount) || 0;
    qty += Number(s.qty) || 0;
  }
  const rows = [...byKey.values()].map((r) => ({ ...r, amount: round2(r.amount), qty: round2(r.qty) }));
  return { product, date, amount: round2(amount), qty: round2(qty), rows };
}

// ---- which customers get statements ------------------------------------------------------

// kind: 'daily' — any sale (fuel or Other) on the day   (Module1)
//       'monthly' / 'custom' — a fuel sale in the range  (Module2 / Module6)
// filter (custom): part of the customer or ledger name, any case.
export function buildStatements({ kind, date, from, to, data, filter = '' }) {
  if (kind === 'daily') { from = monthStart(date); to = date; }
  const billFrom = kind === 'daily' ? date : from;
  const f = String(filter).trim().toLowerCase();
  const salesOf = new Map();
  for (const s of data.sales) {
    if (!s.key || s.sale_date < from || s.sale_date > to) continue;
    if (!salesOf.has(s.key)) salesOf.set(s.key, []);
    salesOf.get(s.key).push(s);
  }
  const payOf = new Map();
  for (const p of data.payments) {
    if (!p.key || p.pay_date < from || p.pay_date > to) continue;
    if (!payOf.has(p.key)) payOf.set(p.key, []);
    payOf.get(p.key).push(p);
  }
  const chosen = data.customers.filter((c) => {
    const mine = salesOf.get(c.key) || [];
    const qualifies = kind === 'daily'
      ? mine.some((s) => s.sale_date === date && (FUEL.includes(s.product) || s.product === 'OTHER'))
      : mine.some((s) => FUEL.includes(s.product));
    if (!qualifies) return false;
    return !f || String(c.name).toLowerCase().includes(f) || String(c.ledger || '').toLowerCase().includes(f);
  });
  const short = shortNames(chosen.map((c) => c.name));
  const label = kind === 'daily' ? ddmmyyyy(date, '-')
    : kind === 'monthly' ? monthLabel(from)
      : from === to ? ddmmyyyy(from, '-') : `${ddmmyyyy(from, '-')} to ${ddmmyyyy(to, '-')}`;
  const period = from.slice(0, 7) === to.slice(0, 7)
    ? `for The Month of  ${monthLabel(to)}`
    : `for ${ddmmyyyy(from)} to ${ddmmyyyy(to)}`;
  const customers = chosen.map((c, i) => {
    const mine = salesOf.get(c.key) || [];
    return {
      customer: c, short: short[i],
      ledger: {
        title: String(c.title || '').trim() || c.name, subtitle: 'Ledger Account for Diesel', period,
        ...ledgerRows({ opening: c.opening, from, sales: mine, payments: payOf.get(c.key) || [] }),
        total: kind !== 'daily', layout: c.layout || null,
      },
      bills: {
        name: c.name, address: c.bill_address || '', gstin: c.gstin || '', from: billFrom, to,
        ...billRows(mine.filter((s) => s.sale_date >= billFrom)),
        total: kind !== 'daily', layout: c.layout || null,
      },
      ledgerFile: `${short[i]} Ledger ${label}`,
      billFile: `${short[i]} Bill ${label}`,
    };
  });
  const summaries = kind === 'daily'
    ? ['HSD', 'MS'].map((p) => ({ ...dailySummary(data.sales, p, date), file: `${p} Daily ${ddmmyyyy(date, '-')}` }))
      .filter((x) => x.rows.length)
    : [];
  const folder = kind === 'daily' ? `Daily_Snapshot_${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(2, 4)}`
    : kind === 'monthly' ? `Monthly Statements ${monthLabel(from)}` : `Statements ${label}`;
  return { kind, from, to, date, label, folder, customers, summaries };
}
