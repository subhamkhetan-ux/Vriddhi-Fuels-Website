// Home dashboard figures — the Master Ledger's analysis (Module14 "Sales
// Analysis", the Outstanding sheet) worked out from store.dashboard().
// Pure functions: no DOM, no network. Charts are drawn in charts.js.
//
// Earnings (Module14): a bill earns   amount − litres × (day's RSP − margin)
//   margin per litre: Diesel 2.58, XtraGreen 2.58, Petrol 4.00
//   day's RSP: the highest price billed that day for that product, so retail
//   (billed at RSP) earns the full margin and a discounted bulk bill earns
//   the margin minus its discount.
// A day with no RSP of its own (no bills, or only discounted bulk bills that
// sit under an unchanged price) takes the price of the days before and after
// when those two are the same.

export const MARGIN = { HSD: 2.58, XG: 2.58, MS: 4 };
export const FUELS = ['HSD', 'MS', 'XG'];
export const PRODUCT_NAME = { HSD: 'Diesel', MS: 'Petrol', XG: 'XtraGreen', OTHER: 'Other' };

const round2 = (n) => Math.round(n * 100) / 100;
const NEAR = 7;                                   // days to look either side for the RSP

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// rows: [[date, product, highest price]] -> { at(product, date) -> RSP or null }
export function dayRsp(rows) {
  const raw = {};
  for (const [d, p, v] of rows || []) {
    if (!FUELS.includes(p) || !(Number(v) > 0)) continue;
    (raw[p] || (raw[p] = new Map())).set(d, Number(v));
  }
  const cache = new Map();
  const at = (p, d) => {
    const key = `${p}|${d}`;
    if (cache.has(key)) return cache.get(key);
    const m = raw[p];
    let v = null;
    if (m) {
      const own = m.has(d) ? m.get(d) : null;
      let prev = null;
      let next = null;
      for (let i = 1; i <= NEAR && (prev == null || next == null); i++) {
        if (prev == null && m.has(addDays(d, -i))) prev = m.get(addDays(d, -i));
        if (next == null && m.has(addDays(d, i))) next = m.get(addDays(d, i));
      }
      const same = prev != null && prev === next ? prev : null;
      if (own == null) v = same;                                  // no bills that day
      else if (same != null && own < same) v = same;              // only discounted bills that day
      else v = own;
    }
    cache.set(key, v);
    return v;
  };
  return { at };
}

export function earningOf(product, qty, amount, rsp) {
  if (!(product in MARGIN) || rsp == null) return null;
  return amount - qty * (rsp - MARGIN[product]);
}

const blankProducts = () => Object.fromEntries(['HSD', 'MS', 'XG', 'OTHER'].map((p) => [p, { qty: 0, amount: 0, earning: 0, bills: 0 }]));

// data: store.dashboard(from', to') (from' <= from); period: {from, to}
export function analyse(data, { from, to }) {
  const cust = new Map((data.customers || []).map(([k, name, ledger, group]) => [k, { name, ledger, group }]));
  const groupName = new Map((data.groups || []).map(([code, title]) => [code, shortGroup(code, title)]));
  const rsp = dayRsp(data.rsp);
  const entityOf = (k) => {
    const c = cust.get(k);
    if (c && c.group) return { id: `g:${c.group}`, name: groupName.get(c.group) || c.group, kind: 'bulk' };
    return { id: `c:${k}`, name: c ? c.name : k, kind: 'retail', ledger: c ? c.ledger : null };
  };

  const days = dateRange(from, to);
  const daily = new Map(days.map((d) => [d, { date: d, qty: { HSD: 0, MS: 0, XG: 0 }, amount: 0, earning: 0 }]));
  const products = blankProducts();
  const entities = new Map();
  const segments = { bulk: { qty: 0, amount: 0, earning: 0 }, retail: { qty: 0, amount: 0, earning: 0 } };
  const months = new Map();
  const month = (d) => {
    const m = d.slice(0, 7);
    if (!months.has(m)) months.set(m, { month: m, qty: 0, amount: 0, earning: 0, paid: 0 });
    return months.get(m);
  };
  let noRsp = 0;
  for (const [d, p, k, qty0, amt0, n] of data.sales || []) {
    if (d < from || d > to) continue;
    const qty = Number(qty0) || 0;
    const amt = Number(amt0) || 0;
    const fuel = FUELS.includes(p);
    const earn = fuel ? earningOf(p, qty, amt, rsp.at(p, d)) : null;
    if (fuel && earn == null) noRsp += 1;
    const e = earn || 0;
    const pr = products[p] || products.OTHER;
    pr.qty += fuel ? qty : 0; pr.amount += amt; pr.earning += e; pr.bills += Number(n) || 0;
    const day = daily.get(d);
    if (day) { if (fuel) day.qty[p] += qty; day.amount += amt; day.earning += e; }
    const mo = month(d);
    mo.qty += fuel ? qty : 0; mo.amount += amt; mo.earning += e;
    const ent = entityOf(k);
    if (!entities.has(ent.id)) entities.set(ent.id, { ...ent, qty: 0, amount: 0, earning: 0, paid: 0, bills: 0, last: '', products: blankProducts() });
    const en = entities.get(ent.id);
    en.qty += fuel ? qty : 0; en.amount += amt; en.earning += e; en.bills += Number(n) || 0;
    if (d > en.last) en.last = d;
    const ep = en.products[p] || en.products.OTHER;
    ep.qty += fuel ? qty : 0; ep.amount += amt; ep.earning += e; ep.bills += Number(n) || 0;
    const sg = segments[ent.kind];
    sg.qty += fuel ? qty : 0; sg.amount += amt; sg.earning += e;
  }
  let collections = 0;
  for (const [d, k, amt] of data.payments || []) {
    if (d < from || d > to) continue;
    collections += Number(amt) || 0;
    month(d).paid += Number(amt) || 0;
    const ent = entityOf(k);
    if (entities.has(ent.id)) entities.get(ent.id).paid += Number(amt) || 0;
  }

  const outstanding = (data.outstanding || []).map(([t, id, bal]) => {
    const e = t === 'g' ? { id: `g:${id}`, name: groupName.get(id) || id, kind: 'bulk' } : entityOf(id);
    return { ...e, balance: round2(Number(bal) || 0) };
  }).filter((o) => Math.abs(o.balance) >= 1).sort((a, b) => b.balance - a.balance);
  const due = outstanding.filter((o) => o.balance > 0);
  const advance = outstanding.filter((o) => o.balance < 0);

  const fuelQty = FUELS.reduce((a, p) => a + products[p].qty, 0);
  const amount = Object.values(products).reduce((a, x) => a + x.amount, 0);
  const earning = Object.values(products).reduce((a, x) => a + x.earning, 0);
  const rspSeries = Object.fromEntries(FUELS.map((p) => [p, days.map((d) => ({ date: d, rsp: rsp.at(p, d) }))]));
  const outByEntity = new Map(outstanding.map((o) => [o.id, o.balance]));
  const list = [...entities.values()].map((e) => ({ ...e, outstanding: outByEntity.get(e.id) ?? null }));
  return {
    from, to, days: days.length,
    kpi: {
      amount: round2(amount), qty: round2(fuelQty), earning: round2(earning), collections: round2(collections),
      perLitre: fuelQty ? round2(earning / fuelQty) : 0,
      outstanding: round2(due.reduce((a, o) => a + o.balance, 0)), advance: round2(advance.reduce((a, o) => a + o.balance, 0)),
      customers: list.filter((e) => e.bills).length, noRsp,
    },
    products, daily: [...daily.values()], months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    customers: list.sort((a, b) => b.qty - a.qty || b.amount - a.amount), segments, outstanding, due, advance, rspSeries,
  };
}

// 'SMC_Bulk' / 'SMC Power — Bulk Ledger — Diesel (FY …)' -> 'SMC Power'
export function shortGroup(code, title) {
  const t = String(title || '').split(/\s[—–-]\s/)[0].trim();
  return t || String(code).replace(/_Bulk$/i, '').trim();
}

// Periods offered on Home; today is the store's date (IST on the server).
export function periods(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const fyStart = `${m >= 4 ? y : y - 1}-04-01`;
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastEnd = addDays(monthStart, -1);
  const lastStart = `${lastEnd.slice(0, 7)}-01`;
  return {
    month: { label: 'This month', from: monthStart, to: today },
    last: { label: 'Last month', from: lastStart, to: lastEnd },
    d30: { label: 'Last 30 days', from: addDays(today, -29), to: today },
    fy: { label: 'This FY', from: fyStart, to: today },
    earliest: [fyStart, lastStart, addDays(today, -29)].sort()[0],
  };
}
