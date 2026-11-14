// A bulk customer's litres by billing price: over a period, each product's
// total and how much went at each price (₹/L). Pure: no DOM, no network.
//
// sales: the account's bills [{sale_date, product, qty, rate, amount, unit?}]
// -> { from, to, qty, amount, bills, products: [{product, qty, amount, bills,
//      avg, rates: [{rate, qty, amount, bills, share, first, last}]}] }

const PRODUCT_ORDER = ['HSD', 'MS', 'XG'];
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

export function qtyByRate(sales, { from = null, to = null, unit = undefined } = {}) {
  const rows = (sales || []).filter((s) => (!from || s.sale_date >= from) && (!to || s.sale_date <= to)
    && (unit === undefined || (s.unit || null) === unit) && Number(s.qty));
  const by = new Map();
  for (const s of rows) {
    const p = s.product || 'OTHER';
    if (!by.has(p)) by.set(p, new Map());
    const rate = round2(Number(s.rate) || (Number(s.qty) ? Number(s.amount) / Number(s.qty) : 0));
    const m = by.get(p);
    if (!m.has(rate)) m.set(rate, { rate, qty: 0, amount: 0, bills: 0, first: s.sale_date, last: s.sale_date });
    const r = m.get(rate);
    r.qty = round3(r.qty + Number(s.qty));
    r.amount = round2(r.amount + (Number(s.amount) || 0));
    r.bills += 1;
    if (s.sale_date < r.first) r.first = s.sale_date;
    if (s.sale_date > r.last) r.last = s.sale_date;
  }
  const products = [...by].map(([product, m]) => {
    const rates = [...m.values()].sort((a, b) => b.rate - a.rate);
    const qty = round3(rates.reduce((a, r) => a + r.qty, 0));
    const amount = round2(rates.reduce((a, r) => a + r.amount, 0));
    rates.forEach((r) => { r.share = qty ? r.qty / qty : 0; });
    return { product, qty, amount, bills: rates.reduce((a, r) => a + r.bills, 0), avg: qty ? round2(amount / qty) : 0, rates };
  }).sort((a, b) => (PRODUCT_ORDER.indexOf(a.product) + 1 || 9) - (PRODUCT_ORDER.indexOf(b.product) + 1 || 9));
  const dates = rows.map((s) => s.sale_date).sort();
  return {
    from: from || dates[0] || null, to: to || dates[dates.length - 1] || null,
    qty: round3(products.reduce((a, p) => a + p.qty, 0)), amount: round2(products.reduce((a, p) => a + p.amount, 0)),
    bills: rows.length, products,
  };
}

// the same as rows for a spreadsheet: [[...], ...]
export function qtyByRateSheet(res, title) {
  const out = [[title], [`${res.from || ''} to ${res.to || ''}`], [], ['Product', 'Billing price (₹/L)', 'Litres', 'Share of the product', 'Bills', 'Amount (₹)', 'First bill', 'Last bill']];
  for (const p of res.products) {
    for (const r of p.rates) out.push([p.product, r.rate, r.qty, Math.round(r.share * 10000) / 100, r.bills, r.amount, r.first, r.last]);
    out.push([`${p.product} total`, p.avg, p.qty, 100, p.bills, p.amount, '', '']);
    out.push([]);
  }
  out.push(['All products', '', res.qty, '', res.bills, res.amount, '', '']);
  return out;
}
