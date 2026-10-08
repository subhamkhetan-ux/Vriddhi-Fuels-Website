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
      company: r.name || '', unit: String(r.unit || '').trim().toUpperCase(), bill: r.bill || '', po: r.po || '', id: r.id, remarks: r.remarks || '',
      qty: Number(r.qty) || 0, rate: Number(r.rate) || 0,
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
// so opening + every company = the group's balance. Companies at nil are only
// counted (settled). null for a one-company sheet.
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
  const all = [...map.values()].map((c) => ({
    ...c, billed: round2(c.billed), qty: round2(c.qty), received: round2(c.received), deductions: round2(c.deductions),
    outstanding: round2(c.billed - c.received - c.deductions),
  })).sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
  // companies with a nil balance are left out (only counted)
  const list = all.filter((c) => Math.abs(c.outstanding) >= 1);
  return { list, settled: all.length - list.length, opening: round2(opening || 0), total: round2(closing) };
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

// ---- FIFO: the bills that make up the balance ------------------------------------
// Every credit (payment, TDS, shortage) clears the oldest open bill first, so
// what is still pending is the newest bills: their date and invoice number,
// what is left on each and how many days old it is.
// keyOf(entry) names the account an entry belongs to — the Unit on an SMC-style
// sheet ('UNIT 1' / 'UNIT 2'), '' otherwise. A credit with a key clears that
// key's bills, then bills with no key (an opening the units don't split, a
// bill with no unit yet); what's left is that key's advance. A credit with no
// key clears the oldest bills of every key. Opening balances go first.
// Returns { pending: [...newest last], keys: {key: {pending, advance, balance}},
// moves: [{at, key, amount, kind}] (how credits crossed keys — for the
// per-unit statements), total }.
// ---- matching a payment to the bills it pays ----------------------------------
// Customers who lift several products often pay product by product (all the
// diesel bills in one payment, the petrol bills later). Before falling back to
// oldest-first, a credit (payment + its TDS + shortage) is matched to the open
// bills it adds up to exactly (to the rupee):
//   1. one bill of exactly that amount (the oldest such);
//   2. whole runs of bills product by product — each product's oldest bills
//      first (all diesel up to a date; diesel and petrol together): one or two
//      products, fewest first, then the oldest;
//   3. one product's oldest bills with a single bill left out (one held back);
// A remark on the payment naming a product (MS / petrol, HSD / diesel, XG)
// tries that product's bills first. If oldest-first itself adds up exactly,
// or nothing matches, it's oldest-first.
// cands: open debits [{d, k}] oldest first -> the ones to clear, or null.
const MATCH_TOL = 1;
const MAX_TRIES = 200000;
const groupOf = (d) => (d.opening ? 'OPENING' : d.title === 'Refund' ? 'REFUND' : (d.product || 'OTHER'));
export function productHint(remarks) {
  const t = String(remarks || '');
  if (/\b(ms|petrol|motor spirit)\b/i.test(t)) return 'MS';
  if (/\b(xg|xtra\s*green|xtragreen)\b/i.test(t)) return 'XG';
  if (/\b(hsd|diesel)\b/i.test(t)) return 'HSD';
  return '';
}
// whole: cands are all the open bills (an exact oldest-first run is then left
// to oldest-first) rather than one product's (where it is the match)
export function matchBills(cands, amount, { whole = true } = {}) {
  const near = (v) => Math.abs(v - amount) < MATCH_TOL;
  if (!cands.length || amount <= 0) return null;
  // oldest-first already adds up
  let run = 0;
  for (let i = 0; i < cands.length; i++) {
    run += cands[i].d.pending;
    if (near(run)) return whole ? null : cands.slice(0, i + 1);
    if (run > amount + MATCH_TOL) break;
  }
  // 1. a single bill
  const one = cands.find((c) => near(c.d.pending));
  if (one) return [one];
  // 2. whole runs, product by product
  const groups = [];
  const byName = new Map();
  for (const c of cands) {
    const g = groupOf(c.d);
    if (!byName.has(g)) { byName.set(g, { name: g, list: [] }); groups.push(byName.get(g)); }
    byName.get(g).list.push(c);
  }
  for (const g of groups) {
    g.prefix = [0];
    for (const c of g.list) g.prefix.push(round2(g.prefix[g.prefix.length - 1] + c.d.pending));
  }
  let best = null;
  let tries = 0;
  const dateOf = (pick) => pick.reduce((m, [gi, n]) => (n && groups[gi].list[n - 1].d.date > m ? groups[gi].list[n - 1].d.date : m), '');
  const consider = (pick) => {
    const used = pick.filter(([, n]) => n > 0);
    const score = [used.length, dateOf(used)];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { pick: used, score };
  };
  // at most two products in one payment: a sum across more is more likely chance
  const walk = (gi, sum, pick, used) => {
    if (++tries > MAX_TRIES) return;
    if (gi === groups.length) { if (used && near(sum)) consider(pick); return; }
    const g = groups[gi];
    for (let n = 0; n < g.prefix.length; n++) {
      if (n && used >= 2) break;
      const v = sum + g.prefix[n];
      if (v > amount + MATCH_TOL) break;
      walk(gi + 1, v, [...pick, [gi, n]], used + (n ? 1 : 0));
    }
  };
  walk(0, 0, [], 0);
  if (best) return best.pick.flatMap(([gi, n]) => groups[gi].list.slice(0, n));
  // 3. one product's oldest bills, one of them held back
  for (const g of groups) {
    for (let n = 2; n < g.prefix.length; n++) {
      const extra = g.prefix[n] - amount;
      if (extra < -MATCH_TOL) continue;
      const skip = g.list.slice(0, n).findIndex((c) => Math.abs(c.d.pending - extra) < MATCH_TOL);
      if (skip >= 0) return g.list.slice(0, n).filter((_, i) => i !== skip);
    }
  }
  return null;
}

// ---- which bills make up a balance ------------------------------------------------
// Within each product a customer pays oldest first, but products are paid
// separately (diesel bills promptly; a lube or petrol bill can wait months),
// so what's pending is each product's NEWEST bills. Given what is owed, pick
// for each product (the opening balance and refunds count as their own) how
// many of its newest bills are pending so that they add up to it exactly —
// fewest bills, then the newest, win. null when no choice adds up.
// bills: every debit of the account (or unit), oldest first
const SOLVE_TRIES = 300000;
export function pendingFromBalance(bills, owed) {
  if (!(owed >= MATCH_TOL) || !bills.length) return null;
  const groups = [];
  const byName = new Map();
  for (const b of bills) {
    if (!(b.amount > 0)) continue;
    const g = groupOf(b);
    if (!byName.has(g)) { byName.set(g, { name: g, list: [], billed: 0 }); groups.push(byName.get(g)); }
    const x = byName.get(g);
    x.list.push(b);
    x.billed += b.amount;
  }
  for (const g of groups) {
    g.suffix = [0];                                   // suffix[k] = the newest k bills
    for (let i = g.list.length - 1; i >= 0; i--) g.suffix.push(round2(g.suffix[g.suffix.length - 1] + g.list[i].amount));
  }
  let best = null;
  let tries = 0;
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  };
  const oldestOf = (ks) => {
    let m = '9999-12-31';
    ks.forEach((k, gi) => { if (k && groups[gi].list[groups[gi].list.length - k].date < m) m = groups[gi].list[groups[gi].list.length - k].date; });
    return m;
  };
  const leaf = (ks, sum) => {
    const r = round2(owed - sum);
    const count = ks.reduce((a, k) => a + k, 0);
    if (Math.abs(r) < MATCH_TOL) {
      // exact: fewest bills, then the newest (an older oldest bill ranks lower)
      const score = [count, -Date.parse(oldestOf(ks))];
      if (!best || better(score, best.score)) best = { score, ks };
      return;
    }
  };
  const walk = (gi, sum, ks) => {
    if (++tries > SOLVE_TRIES) return;
    if (gi === groups.length) { leaf(ks, sum); return; }
    const g = groups[gi];
    for (let k = 0; k < g.suffix.length; k++) {
      const v = round2(sum + g.suffix[k]);
      if (v > owed + MATCH_TOL) break;
      walk(gi + 1, v, [...ks, k]);
    }
  };
  walk(0, 0, []);
  if (!best) return null;
  const out = [];
  best.ks.forEach((k, gi) => {
    const list = groups[gi].list;
    for (let i = list.length - k; i < list.length; i++) out.push({ d: list[i], pending: list[i].amount });
  });
  return out;
}

export function fifoPending(entries, { opening = 0, openingByKey = {}, keyOf = () => '', from = '', asOn = '' } = {}) {
  const queues = new Map();          // key -> open debits, oldest first
  const advance = new Map();         // key -> credit not yet used
  const moves = [];
  const move = (at, key, amount, kind) => {
    const last = moves[moves.length - 1];
    if (last && last.at === at && last.key === key && last.kind === kind) last.amount = round2(last.amount + amount);
    else moves.push({ at, key, amount: round2(amount), kind });
  };
  const q = (k) => { if (!queues.has(k)) queues.set(k, []); return queues.get(k); };
  const adv = (k) => advance.get(k) || 0;
  // products ranked by what was billed: the opening first, then the biggest product
  const share = {};
  for (const e of entries) if (e.debit > 0) share[e.product] = (share[e.product] || 0) + e.debit;
  const productRank = Object.fromEntries(Object.keys(share).sort((a, b) => share[b] - share[a]).map((p, i) => [p, i + 1]));
  const rankOf = (d) => (d.opening ? 0 : productRank[d.product] ?? 99);
  let seq = 0;
  const billed = new Map();          // key -> every debit, oldest first (for pendingFromBalance)
  const debit = (item, at) => {
    const sq = seq++;
    if (!billed.has(item.key)) billed.set(item.key, []);
    billed.get(item.key).push({ ...item, seq: sq });
    let left = round2(item.amount);
    for (const k of item.key ? [item.key, ''] : ['']) {   // unused credit of the same key first, then credit with no key
      const a = adv(k);
      if (left <= 0 || a <= 0) continue;
      const take = Math.min(a, left);
      advance.set(k, round2(a - take));
      left = round2(left - take);
      if (k !== item.key) move(at, item.key, take, 'advance');
    }
    if (left > 0) q(item.key).push({ ...item, pending: left, seq: sq });
  };
  const credit = (amount, key, at, hint = '') => {
    let left = round2(amount);
    // the bills this credit adds up to (a remark naming a product: that product first)
    const open = [];
    for (const [k, list] of queues) {
      if (key && k !== key && k !== '') continue;
      for (const d of list) open.push({ d, k });
    }
    open.sort((a, b) => a.d.date.localeCompare(b.d.date) || a.d.seq - b.d.seq);
    const hinted = hint ? open.filter((c) => c.d.product === hint) : [];
    const picked = (hinted.length && matchBills(hinted, left, { whole: false })) || matchBills(open, left);
    if (picked) {
      for (const { d, k } of picked) {
        const t = Math.min(d.pending, left);
        d.pending = round2(d.pending - t);
        left = round2(left - t);
        if (k !== key) move(at, k || key, t, key ? 'spill' : 'alloc');
      }
      for (const [k, list] of queues) queues.set(k, list.filter((d) => d.pending > 0));
      if (left <= 0) return;
    }
    // Nothing adds up: the opening first, then the product billed most (usually
    // diesel — what such payments are mostly for), oldest first; a petrol or
    // lube bill only once no bill of a bigger product is open.
    const order = (a, b) => rankOf(a) - rankOf(b) || a.date.localeCompare(b.date) || a.seq - b.seq;
    const take = (keysToUse, onTake) => {
      while (left > 0) {
        let best = null;
        for (const k of keysToUse) for (const d of q(k)) if (!best || order(d, best.d) < 0) best = { k, d };
        if (!best) break;
        const t = Math.min(best.d.pending, left);
        best.d.pending = round2(best.d.pending - t);
        left = round2(left - t);
        onTake(best.k, t);
        if (best.d.pending <= 0) queues.set(best.k, queues.get(best.k).filter((d) => d !== best.d));
      }
    };
    if (key) {
      take([key], () => {});
      take([''], (k, t) => move(at, key, t, 'spill'));
      if (left > 0) advance.set(key, round2(adv(key) + left));
      return;
    }
    // no key: the open debits of every key
    take([...queues.keys()], (k, t) => { if (k) move(at, k, t, 'alloc'); });
    if (left > 0) advance.set('', round2(adv('') + left));
  };
  // opening balances: per key where the sheet splits them, the rest without a key
  let rest = Number(opening) || 0;
  for (const [k, v0] of Object.entries(openingByKey || {})) {
    const v = Number(v0) || 0;
    if (!v) continue;
    rest -= v;
    const key = String(k).trim().toUpperCase();
    if (v > 0) debit({ date: from, bill: '', title: 'Opening balance', product: '', key, amount: v, opening: true }, -1);
    else credit(-v, key, -1);
  }
  rest = round2(rest);
  if (rest > 0) debit({ date: from, bill: '', title: 'Opening balance', product: '', key: '', amount: rest, opening: true }, -1);
  else if (rest < 0) credit(-rest, '', -1);

  entries.forEach((e, i) => {
    const key = keyOf(e) || '';
    const item = { date: e.date, bill: e.bill || '', title: e.title, product: e.product, key, company: e.company || '', po: e.po || '', id: e.id };
    if (e.debit > 0) debit({ ...item, amount: e.debit }, i);
    else if (e.debit < 0) credit(-e.debit, key, i);
    if (e.credit > 0) credit(e.credit, key, i, e.type === 'pay' ? productHint(e.remarks) : '');
    else if (e.credit < 0) debit({ ...item, title: 'Refund', amount: -e.credit }, i);   // money paid back
  });

  const days = (d) => (asOn && d ? Math.max(0, Math.round((Date.parse(`${asOn}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000)) : null);
  const all = [...queues.values()].flat().filter((d) => d.pending > 0);
  const keys = {};
  for (const k of new Set([...queues.keys(), ...advance.keys()])) {
    const p = round2(all.filter((d) => d.key === k).reduce((a, d) => a + d.pending, 0));
    keys[k] = { pending: p, advance: adv(k), balance: round2(p - adv(k)) };
  }
  // Which bills make up what each key still owes. When the payments above
  // leave only whole bills pending (each matched to what it paid), that
  // stands. When they leave a bill part paid and each product's newest bills
  // add up to what's owed exactly (see pendingFromBalance), those are the
  // pending bills; otherwise as worked out above.
  let chosen = [];
  for (const [k, list] of billed) {
    const owed = keys[k] ? keys[k].pending : 0;
    const sim = all.filter((d) => d.key === k);
    const whole = sim.every((d) => d.pending < MATCH_TOL || Math.abs(d.pending - d.amount) < MATCH_TOL);
    if (owed < MATCH_TOL || whole) { chosen = chosen.concat(sim); continue; }
    const fit = pendingFromBalance(list, owed);
    chosen = chosen.concat(fit
      ? fit.map(({ d, pending: p }) => ({ ...d, pending: p }))
      : all.filter((d) => d.key === k));
  }
  // under a rupee left on a bill (rounding) isn't a pending bill — but still counts
  const pending = chosen.filter((d) => d.pending >= MATCH_TOL)
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq)
    .map(({ seq: _s, ...d }) => ({ ...d, amount: round2(d.amount), pending: round2(d.pending), days: d.days ?? days(d.date) }));
  const total = round2(all.reduce((a, d) => a + d.pending, 0) - [...advance.values()].reduce((a, v) => a + v, 0));
  return { pending, keys, moves, total, advance: round2([...advance.values()].reduce((a, v) => a + v, 0)) };
}

// PO-wise outstanding: the FIFO pending bills by PO number (unit by unit,
// oldest PO first) — what the customer still owes against each PO. The opening
// balance and bills without a PO (petrol, XtraGreen, others, a diesel bill
// still waiting for a PO) get rows of their own. null when no pending bill has a PO.
export function poSummary(pending) {
  if (!pending || !pending.some((d) => d.po)) return null;
  const map = new Map();
  for (const d of pending) {
    const kind = d.opening ? 'opening' : d.po ? 'po' : 'none';
    const product = kind === 'none' ? (['HSD', 'MS', 'XG'].includes(d.product) ? d.product : 'OTHER') : '';
    const k = kind === 'po' ? `po|${d.key || ''}|${String(d.po).toUpperCase()}` : `${kind}|${d.key || ''}|${product}`;
    if (!map.has(k)) map.set(k, { kind, po: kind === 'po' ? d.po : '', product, unit: d.key || '', bills: 0, pending: 0, billed: 0, from: d.date, to: d.date, oldestDays: d.days });
    const x = map.get(k);
    x.pending += d.pending;
    x.billed += d.amount;
    if (!d.opening) x.bills += 1;
    if (d.date < x.from) { x.from = d.date; x.oldestDays = d.days; }
    if (d.date > x.to) x.to = d.date;
  }
  const rank = { opening: 0, po: 1, none: 2 };
  const pRank = { HSD: 0, MS: 1, XG: 2, OTHER: 3, '': 4 };
  const rows = [...map.values()].map((x) => ({ ...x, pending: round2(x.pending), billed: round2(x.billed) }))
    .sort((a, b) => (a.unit === '') - (b.unit === '') || a.unit.localeCompare(b.unit) || rank[a.kind] - rank[b.kind] || pRank[a.product] - pRank[b.product] || a.from.localeCompare(b.from) || String(a.po).localeCompare(String(b.po)));
  // on a unit-wise account the rows without a unit say so
  const units = rows.some((x) => x.unit);
  return { rows: rows.map((x) => ({ ...x, unitLabel: x.unit ? unitLabel(x.unit) : units ? 'No unit' : '' })), total: round2(rows.reduce((a, x) => a + x.pending, 0)) };
}

// a PO-wise row's name: the PO, or what the bills without a PO are
export function poRowName(r) {
  if (r.kind === 'opening') return 'Opening balance';
  if (r.kind === 'po') return `PO ${r.po}`;
  return { HSD: 'Diesel · no PO yet', MS: 'Petrol', XG: 'XtraGreen', OTHER: 'Other items' }[r.product] || 'Without a PO';
}

// the key of a bulk entry on an SMC-style (unit-wise) sheet
export const unitKey = (e) => String(e.unit || '').trim().toUpperCase();
// 'UNIT 1' -> 'Unit 1'; '' -> 'No unit'
export const unitLabel = (u) => (u ? String(u).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'No unit');

// A unit's own statement on an SMC-style sheet: its opening, its bills and the
// payments typed against it, plus its share (by FIFO) of payments that say no
// unit, and what its payments cleared outside it — so its closing is what the
// FIFO says the unit owes. The other figures (totals, months) as for the account.
export function unitStatement(st, fifo, unit, { openingByUnit = {}, asOn = '' } = {}) {
  const key = String(unit || '').toUpperCase();
  const keyed = Object.fromEntries(Object.entries(openingByUnit || {}).map(([k, v]) => [String(k).trim().toUpperCase(), Number(v) || 0]));
  const opening = key ? (keyed[key] || 0) : round2((st.opening || 0) - Object.values(keyed).reduce((a, v) => a + v, 0));
  const movesAt = new Map();
  for (const m of fifo.moves) {
    if (!movesAt.has(m.at)) movesAt.set(m.at, []);
    movesAt.get(m.at).push(m);
  }
  const blank = { qty: 0, rate: 0, debit: 0, tds: 0, shortage: 0, bill: '', unit: key, company: '' };
  const list = [];
  const addMoves = (i, date) => {
    for (const m of movesAt.get(i) || []) {
      if (key && m.key === key && m.kind === 'alloc') {
        list.push({ ...blank, date, type: 'pay', product: 'PAY', title: 'Payment received', detail: 'No unit on the sheet — set against this unit\'s bills', paid: m.amount, credit: m.amount });
      } else if (key && m.key === key && m.kind === 'advance') {
        list.push({ ...blank, date, type: 'pay', product: 'PAY', title: 'Advance set against this bill', detail: 'Paid earlier without a unit', paid: m.amount, credit: m.amount });
      } else if (key && m.key === key && m.kind === 'spill') {
        list.push({ ...blank, date, type: 'pay', product: 'PAY', title: 'Set against the opening balance', detail: 'The rest of this payment cleared the account\'s opening', paid: -m.amount, credit: -m.amount });
      } else if (!key && m.kind === 'spill') {
        list.push({ ...blank, unit: '', date, type: 'pay', product: 'PAY', title: `Payment from ${unitLabel(m.key)}`, detail: 'Cleared this opening balance', paid: m.amount, credit: m.amount });
      } else if (!key && m.kind === 'advance') {
        list.push({ ...blank, unit: '', date, type: 'pay', product: 'PAY', title: `Set against ${unitLabel(m.key)}'s bills`, detail: 'A payment with no unit, used for this unit', paid: -m.amount, credit: -m.amount });
      }
    }
  };
  // the part without a unit keeps only what its payments didn't clear for a unit
  const usedAt = new Map();
  if (!key) for (const m of fifo.moves) if (m.kind === 'alloc') usedAt.set(m.at, round2((usedAt.get(m.at) || 0) + m.amount));
  addMoves(-1, st.from);
  st.entries.forEach((e, i) => {
    if (unitKey(e) === key) {
      const used = usedAt.get(i) || 0;
      if (!used) list.push(e);
      else {
        let left = used;
        const cut = (v) => { const t = Math.min(Math.max(v, 0), left); left = round2(left - t); return round2(v - t); };
        const paid = cut(e.paid);
        const tds = cut(e.tds);
        const shortage = cut(e.shortage);
        const credit = round2(paid + tds + shortage);
        if (credit || e.type !== 'pay') {
          list.push({ ...e, paid, tds, shortage, credit, detail: [e.detail, `₹${used.toLocaleString('en-IN')} of it set against unit bills`].filter(Boolean).join(' · ') });
        }
      }
    }
    addMoves(i, e.date);
  });
  let bal = round2(opening);
  const entries = list.map((e) => {
    bal = round2(bal + e.debit - e.credit);
    return { ...e, balance: bal };
  });
  const sum = summarise(entries);
  return {
    ...st, unit: key, name: `${st.name} — ${unitLabel(key)}`, opening: round2(opening), closing: bal, entries,
    months: byMonth(entries, round2(opening)), ...sum, companies: null,
    to: st.to, asOn,
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
