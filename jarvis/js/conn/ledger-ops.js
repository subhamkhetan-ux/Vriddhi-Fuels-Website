// Ledger (/ledger/) — the rest of what the Ledger app does, and the questions
// that cut across it:
//   ledger_query        filter / rank every customer ("which bulk customers owe
//                       more than 5 lakh and haven't paid in 30 days", "top 5 by
//                       diesel litres this FY", "who hasn't bought this month")
//   ledger_compare      two periods ("diesel sales this month vs last month")
//   ledger_customer     one customer's business ("petrol SMC took in September")
//   ledger_pending_bills, ledger_pos, ledger_add_po, ledger_day_bills,
//   ledger_daily_pictures, ledger_import_daybook, ledger_unlogged_payments,
//   ledger_log_payments, ledger_rates, ledger_new_customers, ledger_set_ledger_name,
//   ledger_status
// Everything goes through the ledger's own store and rules (ledger/js/*).

import { analyse, dayRsp, FUELS, PRODUCT_NAME } from '../../../ledger/js/dash.js';
import { daybookPayload, parseDaybook, sheetRows } from '../../../ledger/js/daybook.js';
import { readWorkbook } from '../../../ledger/js/master.js';
import { loadBulkAccount, poGroups, groupName } from '../../../ledger/js/outstanding.js';
import { inkBox, jpegFromSvg, statementFontCss, toDataUrl } from '../../../ledger/js/render.js';
import { billStatementSvgs, dailySummarySvg, ledgerSvg, PAGE } from '../../../ledger/js/statement-svg.js';
import { buildStatements, monthStart } from '../../../ledger/js/statements.js';
import { rupees } from '../../../ledger/js/share-svg.js';
import { billKey, normKey } from '../../../ledger/js/util.js';
import { bestMatch } from '../match.js';
import { asked, book, find, pendingSummary, round } from './ledger.js';
import { paymentsRows } from './more.js';

const L = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-IN')} L`;
const daysSince = (d, today) => (d ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400000) : null);
const dmy = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const METRIC = {
  balance: { label: 'Outstanding', fmt: rupees }, amount: { label: 'Sales', fmt: rupees }, litres: { label: 'Litres', fmt: L },
  earning: { label: 'Earnings', fmt: rupees }, paid: { label: 'Received', fmt: rupees }, bills: { label: 'Bills', fmt: (n) => String(n) },
};

// the period asked for (default: this month)
function rangeOf(input, today) {
  if (input.from) return { from: input.from, to: input.to || today, label: input.period_label || `${dmy(input.from)} to ${dmy(input.to || today)}` };
  return { from: `${today.slice(0, 7)}-01`, to: today, label: 'This month' };
}

// dashboard data covering a range (the cached book covers this FY and last month)
async function dataFor(b, from, to) {
  return from >= b.per.earliest && to <= b.today ? b.data : b.store.dashboard(from, to);
}

// every account with its figures for a period
async function table(ctx, r) {
  const b = await book(ctx);
  const data = await dataFor(b, r.from, r.to);
  const a = analyse(data, r);
  const fy = analyse(b.data, b.per.fy);
  const byId = new Map(a.customers.map((e) => [e.id, e]));
  const fyIds = new Set(fy.customers.map((e) => e.id));
  const lastPay = new Map();
  for (const [d, k] of b.data.payments || []) {
    const id = b.idOf(k);
    if (!lastPay.has(id) || d > lastPay.get(id)) lastPay.set(id, d);
  }
  const rows = b.people.map((p) => {
    const e = byId.get(p.id);
    return {
      id: p.id, name: p.name, kind: p.kind, balance: round(p.balance),
      litres: e ? e.qty : 0, amount: e ? e.amount : 0, earning: e ? e.earning : 0, paid: e ? e.paid : 0, bills: e ? e.bills : 0,
      products: e ? e.products : null, last_bill: e?.last || null, last_payment: lastPay.get(p.id) || null,
      days_since_payment: daysSince(lastPay.get(p.id), ctx.today), bought_this_fy: fyIds.has(p.id),
    };
  });
  return { b, a, rows };
}

const valueOf = (row, metric, product) => {
  if (product && row.products && ['litres', 'amount', 'earning'].includes(metric)) {
    const p = row.products[product];
    return p ? { litres: p.qty, amount: p.amount, earning: p.earning }[metric] : 0;
  }
  if (product && !row.products && ['litres', 'amount', 'earning'].includes(metric)) return 0;
  return row[metric] ?? 0;
};

async function query(input, ctx) {
  const r = rangeOf(input, ctx.today);
  const { b, rows } = await table(ctx, r);
  const metric = METRIC[input.metric] ? input.metric : 'amount';
  const product = input.product || null;
  let list = rows;
  const notes = [];
  if (input.segment) list = list.filter((x) => x.kind === input.segment);
  if (input.not_bought) {
    list = list.filter((x) => x.bought_this_fy && !(valueOf(x, 'litres', product) > 0 || valueOf(x, 'amount', product) > 0));
    notes.push(`bought this FY but nothing${product ? ` (${PRODUCT_NAME[product]})` : ''} in ${r.label.toLowerCase()}`);
  } else if (metric === 'balance') list = list.filter((x) => (input.order === 'asc' ? x.balance < 0 : x.balance > 0) || input.max_value !== undefined);
  else list = list.filter((x) => valueOf(x, metric, product) > 0);
  if (input.min_value !== undefined) { list = list.filter((x) => valueOf(x, metric, product) > input.min_value); notes.push(`${METRIC[metric].label.toLowerCase()} over ${METRIC[metric].fmt(input.min_value)}`); }
  if (input.max_value !== undefined) { list = list.filter((x) => valueOf(x, metric, product) < input.max_value); notes.push(`${METRIC[metric].label.toLowerCase()} under ${METRIC[metric].fmt(input.max_value)}`); }
  if (input.no_payment_days) {
    list = list.filter((x) => x.balance > 0 && (x.days_since_payment === null || x.days_since_payment > input.no_payment_days));
    notes.push(`no payment in ${input.no_payment_days} days`);
  }
  if (input.bills_older_than_days) {
    const keep = [];
    for (const x of list.filter((y) => y.kind === 'bulk' && y.balance > 0)) {
      const { acct } = await loadBulkAccount(b.store, x.id.slice(2), x.name, ctx.today);
      const old = acct.fifo.pending.filter((d) => d.days > input.bills_older_than_days);
      if (old.length) keep.push({ ...x, old_bills: old.length, old_amount: round(old.reduce((s, d) => s + d.pending, 0)) });
    }
    list = keep;
    notes.push(`bills older than ${input.bills_older_than_days} days (bulk accounts)`);
  }
  const dir = input.order === 'asc' ? 1 : -1;
  list.sort((x, y) => dir * (valueOf(x, metric, product) - valueOf(y, metric, product)));
  const limit = Math.min(input.limit || 25, 100);
  const shown = list.slice(0, limit);
  const total = list.reduce((s, x) => s + valueOf(x, metric, product), 0);
  const cols = ['Customer', METRIC[metric].label + (product ? ` (${PRODUCT_NAME[product]})` : '')];
  const extra = metric === 'balance' ? ['Last payment'] : metric !== 'paid' ? ['Outstanding'] : [];
  if (input.bills_older_than_days) extra.unshift('Old bills');
  const periodTxt = metric === 'balance' ? '' : ` (${r.label})`;
  const head = input.limit && list.length > input.limit
    ? `${input.order === 'asc' ? 'Bottom' : 'Top'} ${input.limit} by ${METRIC[metric].label.toLowerCase()}${product ? ` of ${PRODUCT_NAME[product]}` : ''}${input.segment ? `, ${input.segment}` : ''}${periodTxt}`
    : `${list.length} ${list.length === 1 ? 'customer' : 'customers'}${input.segment ? ` (${input.segment})` : ''}${notes.length ? ` — ${notes.join(', ')}` : ''}${periodTxt}`;
  return {
    summary: {
      question: { metric, product, period: metric === 'balance' ? 'as on today' : r, segment: input.segment, filters: notes },
      count: list.length, total: round(total),
      rows: shown.map((x) => ({
        name: x.name, kind: x.kind, [metric]: round(valueOf(x, metric, product)), outstanding: x.balance,
        last_payment: x.last_payment, days_since_payment: x.days_since_payment, ...(x.old_bills ? { old_bills: x.old_bills, old_amount: x.old_amount } : {}),
      })),
    },
    say: list.length
      ? `${head}: ${shown.slice(0, 3).map((x) => `${x.name} ${METRIC[metric].fmt(valueOf(x, metric, product))}`).join(', ')}${list.length > 3 ? '…' : ''}${input.not_bought ? '' : ` Total of all ${list.length}: ${METRIC[metric].fmt(total)}.`}`
      : `No customer matches (${notes.join(', ') || r.label}).`,
    table: {
      columns: [...cols, ...extra],
      rows: shown.map((x) => [x.name, METRIC[metric].fmt(valueOf(x, metric, product)),
        ...(input.bills_older_than_days ? [`${x.old_bills} · ${rupees(x.old_amount)}`] : []),
        ...(metric === 'balance' ? [x.last_payment ? `${dmy(x.last_payment)} (${x.days_since_payment} d)` : 'none this FY'] : metric !== 'paid' ? [rupees(x.balance)] : [])]),
    },
    app: 'ledger',
  };
}

// one figure of a period (all customers or one), and its split by product
function figure(a, metric, product, id) {
  const e = id ? a.customers.find((x) => x.id === id) : null;
  if (id && !e) return { value: 0, byProduct: {} };
  const src = id ? e.products : a.products;
  const pick = (p) => ({ litres: p.qty, amount: p.amount, earning: p.earning }[metric] ?? 0);
  if (metric === 'paid') return { value: id ? e.paid : a.kpi.collections, byProduct: {} };
  const byProduct = Object.fromEntries(FUELS.map((p) => [PRODUCT_NAME[p], round(pick(src[p]))]));
  return { value: product ? pick(src[product]) : id ? pick({ qty: e.qty, amount: e.amount, earning: e.earning }) : { litres: a.kpi.qty, amount: a.kpi.amount, earning: a.kpi.earning }[metric], byProduct };
}

async function compare(input, ctx) {
  const b = await book(ctx);
  const A = { from: input.a_from, to: input.a_to || input.a_from, label: input.a_label || `${dmy(input.a_from)}–${dmy(input.a_to)}` };
  let B;
  if (input.b_from) B = { from: input.b_from, to: input.b_to || input.b_from, label: input.b_label || `${dmy(input.b_from)}–${dmy(input.b_to)}` };
  else {                                                       // the same length just before
    const len = Math.round((Date.parse(A.to) - Date.parse(A.from)) / 86400000);
    const to = new Date(Date.parse(`${A.from}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    B = { from: new Date(Date.parse(`${to}T00:00:00Z`) - len * 86400000).toISOString().slice(0, 10), to, label: 'the period before' };
  }
  let id = null;
  let who = null;
  if (input.customer) {
    const f = await find(ctx, input.customer);
    if (f.ask) return asked(f.ask, 'ledger_compare', input);
    id = f.person.id;
    who = f.person.name;
  }
  const from = A.from < B.from ? A.from : B.from;
  const to = A.to > B.to ? A.to : B.to;
  const data = await dataFor(b, from, to);
  const metric = ['amount', 'litres', 'earning', 'paid'].includes(input.metric) ? input.metric : 'amount';
  const fa = figure(analyse(data, A), metric, input.product, id);
  const fb = figure(analyse(data, B), metric, input.product, id);
  const diff = fa.value - fb.value;
  const pct = fb.value ? Math.round((diff / fb.value) * 1000) / 10 : null;
  const fmt = METRIC[metric].fmt;
  const what = `${who ? `${who}'s ` : ''}${input.product ? `${PRODUCT_NAME[input.product]} ` : ''}${METRIC[metric].label.toLowerCase()}`;
  return {
    summary: { what, a: { ...A, value: round(fa.value), by_product: fa.byProduct }, b: { ...B, value: round(fb.value), by_product: fb.byProduct }, change: round(diff), change_pct: pct },
    say: `${what[0].toUpperCase()}${what.slice(1)}: ${A.label} ${fmt(fa.value)} vs ${B.label} ${fmt(fb.value)} — ${diff >= 0 ? 'up' : 'down'} ${fmt(Math.abs(diff))}${pct !== null ? ` (${diff >= 0 ? '+' : '−'}${Math.abs(pct)}%)` : ''}.`,
    table: metric === 'paid' ? null : {
      columns: ['Product', A.label, B.label, 'Change'],
      rows: Object.keys(fa.byProduct).map((p) => [p, fmt(fa.byProduct[p]), fmt(fb.byProduct[p]), `${fa.byProduct[p] - fb.byProduct[p] >= 0 ? '+' : '−'}${fmt(Math.abs(fa.byProduct[p] - fb.byProduct[p]))}`]),
    },
    app: 'ledger',
  };
}

async function customer(input, ctx) {
  const f = await find(ctx, input.customer || '');
  if (f.ask) return asked(f.ask, 'ledger_customer', input);
  const { person, b } = f;
  const r = rangeOf(input, ctx.today);
  const data = await dataFor(b, r.from, r.to);
  const a = analyse(data, r);
  const e = a.customers.find((x) => x.id === person.id);
  const prods = FUELS.concat('OTHER').map((p) => ({ product: PRODUCT_NAME[p], litres: round(e?.products[p].qty), amount: round(e?.products[p].amount), bills: e?.products[p].bills || 0 }))
    .filter((p) => p.amount || p.litres);
  const focus = input.product ? prods.find((p) => p.product === PRODUCT_NAME[input.product]) : null;
  let lastPay = null;
  for (const [d, k, amt] of b.data.payments || []) if (b.idOf(k) === person.id && (!lastPay || d > lastPay.date)) lastPay = { date: d, amount: amt };
  const head = input.product
    ? `${person.name} took ${L(focus?.litres)} of ${PRODUCT_NAME[input.product]} (${rupees(focus?.amount || 0)}, ${focus?.bills || 0} bills) in ${r.label.toLowerCase()}.`
    : `${person.name} in ${r.label.toLowerCase()}: ${L(e?.qty)} for ${rupees(e?.amount || 0)} over ${e?.bills || 0} bills${e?.paid ? `, paid ${rupees(e.paid)}` : ''}.`;
  return {
    summary: {
      customer: person.name, kind: person.kind, period: r, litres: round(e?.qty), amount: round(e?.amount), earning: round(e?.earning), bills: e?.bills || 0,
      paid_in_period: round(e?.paid), products: prods, last_bill: e?.last || null, outstanding_today: round(person.balance), last_payment: lastPay,
    },
    say: `${head} Outstanding today ${rupees(person.balance)}.`,
    table: prods.length ? { columns: ['Product', 'Litres', 'Amount', 'Bills'], rows: prods.map((p) => [p.product, L(p.litres), rupees(p.amount), String(p.bills)]) } : null,
    app: 'ledger',
  };
}

async function pendingBills(input, ctx) {
  const days = Number(input.older_than_days) || 0;
  const bucket = (d) => (d > 45 ? '45+ days' : d > 30 ? '31–45 days' : d > 15 ? '16–30 days' : '0–15 days');
  if (input.customer) {
    const f = await find(ctx, input.customer);
    if (f.ask) return asked(f.ask, 'ledger_pending_bills', input);
    const { person, b } = f;
    if (person.kind !== 'bulk') {
      return { summary: { customer: person.name, kind: 'retail', outstanding: round(person.balance), note: 'Retail ledgers keep a running balance, not bill-wise pending bills.' }, say: `${person.name} is a retail ledger: outstanding ${rupees(person.balance)} (bill-wise pending is kept for bulk accounts).` };
    }
    const { acct } = await loadBulkAccount(b.store, person.id.slice(2), person.name, ctx.today);
    const list = acct.fifo.pending.filter((d) => d.days > days);
    const total = list.reduce((s, d) => s + d.pending, 0);
    return {
      summary: { customer: person.name, older_than_days: days, bills: list.length, total: round(total), summary: pendingSummary(list),
        bills_list: list.slice(0, 40).map((d) => ({ date: d.date, bill: d.bill, product: d.product, po: d.po || undefined, pending: round(d.pending), days: d.days })) },
      say: list.length ? `${person.name}: ${list.length} pending bills${days ? ` older than ${days} days` : ''}, ${rupees(total)}; oldest ${list[0].days} days (${dmy(list[0].date)}).` : `${person.name} has no pending bill${days ? ` older than ${days} days` : ''}.`,
      table: { columns: ['Date', 'Bill', 'Pending', 'Days'], rows: list.slice(0, 60).map((d) => [dmy(d.date), `${d.bill || d.title || ''}${d.product ? ` · ${d.product}` : ''}`, rupees(d.pending), String(d.days)]) },
      app: 'ledger',
    };
  }
  const b = await book(ctx);
  const ageing = {};
  const per = [];
  ctx.progress('Working out every bulk account\'s pending bills…');
  for (const p of b.people.filter((x) => x.kind === 'bulk' && x.balance > 0)) {
    const { acct } = await loadBulkAccount(b.store, p.id.slice(2), p.name, ctx.today);
    const list = acct.fifo.pending.filter((d) => d.days > days);
    for (const d of list) ageing[bucket(d.days)] = (ageing[bucket(d.days)] || 0) + d.pending;
    if (list.length) per.push({ name: p.name, bills: list.length, amount: round(list.reduce((s, d) => s + d.pending, 0)), oldest: list[0].days });
  }
  per.sort((x, y) => y.amount - x.amount);
  const total = per.reduce((s, x) => s + x.amount, 0);
  return {
    summary: { older_than_days: days, accounts: per.length, total: round(total), ageing: Object.fromEntries(Object.entries(ageing).map(([k, v]) => [k, round(v)])), by_customer: per.slice(0, 30) },
    say: per.length ? `${per.length} bulk accounts have ${rupees(total)} in pending bills${days ? ` older than ${days} days` : ''}. Most: ${per.slice(0, 3).map((x) => `${x.name} ${rupees(x.amount)} (oldest ${x.oldest} d)`).join(', ')}.` : `No pending bill${days ? ` older than ${days} days` : ''}.`,
    table: { columns: ['Customer', 'Bills', 'Pending', 'Oldest'], rows: per.map((x) => [x.name, String(x.bills), rupees(x.amount), `${x.oldest} d`]) },
    app: 'ledger',
  };
}

async function groupsFor(ctx, customerName) {
  const b = await book(ctx);
  const groups = poGroups(await b.store.poData());
  if (!customerName) return { b, groups };
  const f = await find(ctx, customerName);
  if (f.ask) return { ask: f.ask };
  const code = f.person.id.startsWith('g:') ? f.person.id.slice(2) : null;
  const mine = groups.filter((g) => g.group.code === code);
  return { b, groups: mine, person: f.person };
}

async function pos(input, ctx) {
  const g = await groupsFor(ctx, input.customer);
  if (g.ask) return asked(g.ask, 'ledger_pos', input);
  if (input.customer && !g.groups.length) return { summary: { customer: g.person.name, note: 'No PO list for this customer.' }, say: `${g.person.name} has no PO list.` };
  const rows = [];
  const notes = [];
  for (const x of g.groups) {
    const name = groupName(x.group, x.members);
    for (const r of x.registers) {
      for (const p of r.pos) rows.push({ customer: name, unit: r.unit || '', po: p.po_no, allotted: round(p.allotted), used: round(p.used), left: round(p.balance), status: p.status, low: p.balance > 0 && (p.balance < 5000 || p.balance < p.allotted * 0.1) });
      const open = r.pos.filter((p) => p.balance > 0);
      if (!open.length) notes.push(`${name}${r.unit ? ` ${r.unit}` : ''}: no PO with litres left`);
    }
    if (x.noPo) notes.push(`${name}: ${x.noPo} bill${x.noPo > 1 ? 's' : ''} without a PO`);
    if (x.needsUnit) notes.push(`${name}: ${x.needsUnit} bill${x.needsUnit > 1 ? 's' : ''} need a unit`);
  }
  const open = rows.filter((r) => r.left > 0);
  const low = open.filter((r) => r.low);
  if (input.low) {
    const none = g.groups.flatMap((x) => x.registers.filter((r) => !r.pos.some((p) => p.balance > 0)).map((r) => `${groupName(x.group, x.members)}${r.unit ? ` ${r.unit}` : ''}`));
    return {
      summary: { running_low: low, no_po_left: none, problems: notes },
      say: low.length || none.length ? `${low.length ? `Running low: ${low.map((r) => `${r.customer}${r.unit ? ` ${r.unit}` : ''} ${r.po} (${L(r.left)} left)`).join(', ')}.` : ''}${none.length ? ` No PO with litres left: ${none.join(', ')}.` : ''}`.trim() : 'No PO is running low.',
      table: low.length ? { columns: ['Customer', 'PO', 'Left'], rows: low.map((r) => [`${r.customer}${r.unit ? ` · ${r.unit}` : ''}`, r.po, L(r.left)]) } : null,
      app: 'ledger',
    };
  }
  return {
    summary: { pos_open: open.length, litres_left: round(open.reduce((s, r) => s + r.left, 0)), running_low: low, problems: notes, pos: rows.filter((r) => r.left > 0 || input.customer).slice(0, 60) },
    say: `${open.length} open PO${open.length === 1 ? '' : 's'} with ${L(open.reduce((s, r) => s + r.left, 0))} left.${low.length ? ` Running low: ${low.map((r) => `${r.customer} ${r.po} (${L(r.left)})`).join(', ')}.` : ''}${notes.length ? ` ${notes.join('. ')}.` : ''}`,
    table: { columns: ['Customer', 'PO', 'Allotted', 'Left'], rows: (input.customer ? rows : open).map((r) => [`${r.customer}${r.unit ? ` · ${r.unit}` : ''}`, `${r.po}${r.low ? ' ⚠' : ''}`, L(r.allotted), L(r.left)]) },
    app: 'ledger',
  };
}

async function addPo(input, ctx) {
  const g = await groupsFor(ctx, input.customer);
  if (g.ask) return asked(g.ask, 'ledger_add_po', input);
  const x = g.groups[0];
  if (!x) return { summary: { error: `${g.person?.name || input.customer} has no PO list (only bulk sheets with POs do).` } };
  const units = x.group.units || [];
  let unit = '';
  if (x.group.kind === 'po_units') {
    unit = units.find((u) => normKey(u) === normKey(input.unit || '')) || '';
    if (!unit) return { summary: { needs: 'unit', units }, say: `Which unit — ${units.join(' or ')}?`, choices: units.map((u) => ({ label: u, tool: 'ledger_add_po', input: { ...input, unit: u } })) };
  }
  const litres = Number(input.litres);
  if (!(litres > 0) || !input.po_no) return { summary: { error: 'Need the PO number and litres.' } };
  const name = groupName(x.group, x.members);
  const ok = await ctx.confirm({ title: 'Add this PO in the Ledger?', rows: [[name + (unit ? ` · ${unit}` : ''), String(input.po_no).toUpperCase(), L(litres)]], ok: 'Add PO' });
  if (!ok) return { summary: { saved: false, declined_by_owner: true }, say: 'Not added.' };
  await g.b.store.savePo({ group_code: x.group.code, unit, po_no: String(input.po_no).toUpperCase(), allotted: litres });
  return { summary: { saved: true, customer: name, po: input.po_no, litres }, say: `Added PO ${String(input.po_no).toUpperCase()} for ${name}${unit ? ` (${unit})` : ''}: ${L(litres)}. Bills without a PO pick it up.`, app: 'ledger' };
}

async function dayBills(input, ctx) {
  const b = await book(ctx);
  const day = await b.store.salesDay(input.date || ctx.today);
  let bills = day.bills || [];
  if (input.product) bills = bills.filter((x) => x.product === input.product);
  let who = null;
  if (input.customer) {
    const names = [...new Set(bills.map((x) => x.customer))].map((name) => ({ name }));
    const { best, candidates } = bestMatch(input.customer, names);
    if (!best && candidates.length > 1) return { summary: { ambiguous: true, candidates: candidates.map((c) => c.name) }, say: `Which one: ${candidates.map((c) => c.name).join(', ')}?`, choices: candidates.map((c) => ({ label: c.name, tool: 'ledger_day_bills', input: { ...input, customer: c.name } })) };
    who = best?.name || candidates[0]?.name || null;
    bills = who ? bills.filter((x) => x.customer === who) : [];
  }
  const by = {};
  for (const x of bills) { const k = PRODUCT_NAME[x.product] || x.product; by[k] = by[k] || { bills: 0, litres: 0, amount: 0 }; by[k].bills += 1; by[k].litres += Number(x.qty) || 0; by[k].amount += Number(x.amount) || 0; }
  const total = bills.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return {
    summary: { date: day.date, customer: who || undefined, bills: bills.length, total: round(total), by_product: by, note: day.date !== (input.date || ctx.today) ? `No bills on that day; showing ${day.date}, the latest.` : undefined },
    say: bills.length ? `${dmy(day.date)}${who ? `, ${who}` : ''}: ${bills.length} bills, ${rupees(total)} — ${Object.entries(by).map(([k, v]) => `${k} ${L(v.litres)}`).join(', ')}.` : `No bills${who ? ` for ${input.customer}` : ''} on ${dmy(day.date || input.date)}.`,
    table: { columns: ['Bill', 'Customer', 'Vehicle', 'Litres', 'Amount'], rows: bills.slice(0, 80).map((x) => [`${x.product} ${x.bill_no}`, x.customer, x.vehicle || '', L(x.qty), rupees(x.amount)]) },
    app: 'ledger',
  };
}

async function dailyPictures(input, ctx) {
  const b = await book(ctx);
  const date = input.date || new Date(Date.parse(`${ctx.today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  ctx.progress('Finding the day\'s sales…');
  const stamp = await b.store.setting('statement_stamp').catch(() => null);
  const [data, logo, letterhead, fontCss, stampInk] = await Promise.all([
    b.store.statementData(monthStart(date), date), toDataUrl('../ledger/assets/logo.png').catch(() => ''), toDataUrl('../ledger/assets/letterhead.png').catch(() => ''),
    statementFontCss(), stamp ? inkBox(stamp.data_url).catch(() => null) : null,
  ]);
  const images = { logo, letterhead, fontCss, stamp: stamp ? stamp.data_url : '', stampInk };
  const res = buildStatements({ kind: 'daily', date, data });
  if (!res.customers.length && !res.summaries.length) return { summary: { date, pictures: 0 }, say: `No sales on ${dmy(date)}.` };
  const pages = [
    ...res.customers.flatMap((c) => [{ name: c.ledgerFile, svg: ledgerSvg(c.ledger, images) }, { name: c.billFile, svg: billStatementSvgs(c.bills, images)[0] }]),
    ...res.summaries.map((x) => ({ name: x.file, svg: dailySummarySvg(x, images) })),
  ];
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    ctx.progress(`Making picture ${i + 1} of ${pages.length}…`);
    out.push({ file: new File([await jpegFromSvg(pages[i].svg, PAGE)], `${pages[i].name}.jpeg`, { type: 'image/jpeg' }), title: pages[i].name });
  }
  return {
    summary: { date, customers: res.customers.map((c) => c.customer.name), pictures: out.length, stamp: Boolean(images.stamp) },
    say: `${out.length} pictures for ${dmy(date)}: ${res.customers.length === 1 ? 'one customer\'s' : `${res.customers.length} customers'`} ledger and bills, plus the daily summaries. Tap Share all to send them on WhatsApp.`,
    images: out,
    app: 'ledger',
  };
}

async function importDaybook(input, ctx) {
  const att = ctx.attachments.get(input.attachment_id);
  if (!att) return { summary: { error: 'Attach the Tally DayBook (.xlsx) first.' }, say: 'Attach the Tally DayBook Excel file first (📎).' };
  const b = await book(ctx);
  ctx.progress(`Reading ${att.name}…`);
  let XLSX;
  try { XLSX = await import(SHEETJS); } catch { throw new Error('Couldn\'t load the Excel reader (cdn.sheetjs.com). Check the internet connection.'); }
  const wb = readWorkbook(XLSX, await att.file.arrayBuffer(), { all: true });
  const date1904 = Boolean(wb.Workbook?.WBProps?.date1904);
  const parsed = parseDaybook(sheetRows(wb.Sheets[wb.SheetNames[0]]), { date1904 });
  const rows = daybookPayload(parsed);
  if (!rows.length) return { summary: { error: 'No HSD / MS / XG credit vouchers in the first sheet.', other: parsed.otherTypes } };
  const existing = new Set(await b.store.existingBills(rows.map(({ product, bill_no, sale_date }) => ({ product, bill_no, sale_date }))));
  const seen = new Set();
  const fresh = rows.filter((r) => { const k = billKey(r.product, r.sale_date, r.bill_no); if (existing.has(k) || seen.has(k)) return false; seen.add(k); return true; });
  const count = (list, p) => list.filter((r) => r.product === p).length;
  if (!fresh.length) return { summary: { new_bills: 0, already: rows.length }, say: 'Every bill in that DayBook is already in the Ledger.' };
  const ok = await ctx.confirm({
    title: `Import the DayBook (${parsed.from === parsed.to ? dmy(parsed.from) : `${dmy(parsed.from)} – ${dmy(parsed.to)}`}) into the Ledger?`,
    rows: FUELS.map((p) => [PRODUCT_NAME[p], `${count(fresh, p)} new`, `${count(rows, p) - count(fresh, p)} already in`]),
    notes: parsed.problems.slice(0, 5).map((p) => `Row ${p.row}, bill ${p.bill_no}: ${p.problem}`),
    ok: `Import ${fresh.length} bills`,
  });
  if (!ok) return { summary: { imported: false, declined_by_owner: true }, say: 'Not imported.' };
  const res = await b.store.importDaybook(att.name, rows);
  b.at = 0;                                                       // figures change
  const added = Object.entries(res.inserted || {}).map(([p, n]) => `${n} ${PRODUCT_NAME[p] || p}`).join(', ') || 'nothing new';
  return { summary: { imported: res.inserted, duplicates: res.duplicates, new_customers: res.new_customers }, say: `Imported ${added}.${res.duplicates ? ` ${res.duplicates} were already there.` : ''}`, app: 'ledger' };
}

async function paymentsToLog(ctx) {
  const b = await book(ctx);
  const { payments } = await paymentsRows(ctx);
  const checks = payments.length ? await b.store.appPaymentsCheck(payments.map(({ ref, pay_date, customer, amount }) => ({ ref, pay_date, customer, amount }))) : [];
  const byRef = new Map(checks.map((c) => [c.ref, c]));
  const todo = payments.filter((p) => (byRef.get(p.ref) || { state: 'new' }).state === 'new');
  return { b, todo, unknown: [...new Set(todo.filter((p) => byRef.get(p.ref)?.known === false).map((p) => p.customer))] };
}

async function unloggedPayments(input, ctx) {
  const { todo, unknown } = await paymentsToLog(ctx);
  const total = todo.reduce((s, p) => s + p.amount, 0);
  return {
    summary: { not_in_ledger: todo.length, total: round(total), unknown_customers: unknown, payments: todo.slice(0, 40) },
    say: todo.length ? `${todo.length} payments (${rupees(total)}) from the payments app aren't in the Ledger yet. Say "log them" to add them.` : 'Every matched payment is already in the Ledger.',
    table: { columns: ['Date', 'Customer', 'Amount', 'Mode'], rows: todo.slice(0, 60).map((p) => [dmy(p.pay_date), p.customer, rupees(p.amount), p.mode]) },
    app: 'ledger',
  };
}

async function logPayments(input, ctx) {
  const { b, todo, unknown } = await paymentsToLog(ctx);
  if (!todo.length) return { summary: { logged: 0 }, say: 'Nothing to log — every matched payment is already in the Ledger.' };
  const total = todo.reduce((s, p) => s + p.amount, 0);
  const ok = await ctx.confirm({
    title: `Log ${todo.length} payments (${rupees(total)}) into the Ledger?`,
    rows: todo.slice(0, 12).map((p) => [dmy(p.pay_date), p.customer, rupees(p.amount)]),
    notes: [todo.length > 12 ? `…and ${todo.length - 12} more` : '', unknown.length ? `Not ledger customers yet: ${unknown.join(', ')}` : ''],
    ok: 'Log payments',
  });
  if (!ok) return { summary: { logged: 0, declined_by_owner: true }, say: 'Not logged.' };
  const res = await b.store.appPaymentsLog(todo.map(({ ref, pay_date, customer, amount, mode }) => ({ ref, pay_date, customer, amount, mode })));
  b.at = 0;
  return { summary: { logged: res?.logged ?? todo.length, total: round(total) }, say: `Logged ${todo.length} payments (${rupees(total)}) in the Ledger — balances are up to date.`, app: 'ledger' };
}

async function rates(input, ctx) {
  const b = await book(ctx);
  const r = input.from ? rangeOf(input, ctx.today) : { from: ctx.today, to: ctx.today, label: 'Today' };
  const data = await dataFor(b, r.from < b.per.earliest ? r.from : b.per.earliest, ctx.today);
  const rsp = dayRsp(data.rsp);
  const days = [];
  for (let d = r.from; d <= r.to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) days.push(d);
  const now = Object.fromEntries(FUELS.map((p) => [PRODUCT_NAME[p], rsp.at(p, r.to)]));
  const changes = [];
  for (const p of FUELS) {
    let prev = rsp.at(p, days[0]);
    for (const d of days.slice(1)) { const v = rsp.at(p, d); if (v != null && prev != null && v !== prev) changes.push({ date: d, product: PRODUCT_NAME[p], from: prev, to: v }); if (v != null) prev = v; }
  }
  return {
    summary: { as_on: r.to, rsp: now, changes },
    say: `Rates on ${dmy(r.to)}: ${Object.entries(now).filter(([, v]) => v).map(([k, v]) => `${k} ₹${v}`).join(', ') || 'no bills that day'}.${changes.length ? ` ${changes.length} change${changes.length > 1 ? 's' : ''} in the period.` : ''}`,
    table: changes.length ? { columns: ['Date', 'Product', 'From', 'To'], rows: changes.map((c) => [dmy(c.date), c.product, `₹${c.from}`, `₹${c.to}`]) } : null,
    app: 'ledger',
  };
}

async function newCustomers(input, ctx) {
  const b = await book(ctx);
  const list = (await b.store.customers()).filter((c) => !c.archived && !c.ledger && !c.bulk_group && !c.no_ledger);
  return {
    summary: { count: list.length, customers: list.map((c) => ({ name: c.name, first_sale: c.first_sale, bills: c.bills })) },
    say: list.length ? `${list.length} customer${list.length > 1 ? 's' : ''} need a ledger name: ${list.slice(0, 6).map((c) => c.name).join(', ')}${list.length > 6 ? '…' : ''}. Say e.g. "ledger name for ${list[0].name} is ${list[0].name.split(' ')[0]}" or "no ledger for …".` : 'Every customer has a ledger.',
    table: list.length ? { columns: ['Customer', 'First sale', 'Bills'], rows: list.map((c) => [c.name, dmy(c.first_sale), String(c.bills)]) } : null,
    app: 'ledger',
  };
}

async function setLedgerName(input, ctx) {
  const b = await book(ctx);
  const all = (await b.store.customers()).filter((c) => !c.archived);
  const { best, candidates } = bestMatch(input.customer || '', all, (c) => c.name);
  if (!best) return candidates.length ? { summary: { ambiguous: true }, say: `Which one: ${candidates.map((c) => c.name).join(', ')}?`, choices: candidates.map((c) => ({ label: c.name, tool: 'ledger_set_ledger_name', input: { ...input, customer: c.name } })) } : { summary: { error: `No customer "${input.customer}".` } };
  const none = input.no_ledger === true || !input.ledger_name;
  const ok = await ctx.confirm({ title: none ? `${best.name}: no ledger needed?` : `Give ${best.name} the ledger name "${input.ledger_name}"?`, ok: 'Save' });
  if (!ok) return { summary: { saved: false, declined_by_owner: true }, say: 'Not saved.' };
  await b.store.updateCustomer(best.id, none ? { no_ledger: true } : { ledger: input.ledger_name });
  b.at = 0;
  return { summary: { saved: true, customer: best.name }, say: none ? `${best.name}: no ledger needed.` : `${best.name} now has the ledger "${input.ledger_name}".`, app: 'ledger' };
}

async function status(input, ctx) {
  const b = await book(ctx);
  const s = await b.store.summary();
  return {
    summary: { sales_until: s.last_sale_date, master_ledger_until: s.master_until, last_import: s.last_import && { kind: s.last_import.kind, file: s.last_import.file_name, at: s.last_import.created_at }, customers: s.customers, need_ledger_name: s.needs_ledger, pos: s.pos },
    say: `Ledger sales are in up to ${dmy(s.last_sale_date)}${s.master_until ? `; the Master Ledger upload runs to ${dmy(s.master_until)}` : ''}.${s.last_import ? ` Last import: ${s.last_import.file_name} (${new Date(s.last_import.created_at).toLocaleString('en-IN')}).` : ''}${s.needs_ledger ? ` ${s.needs_ledger} customers need a ledger name.` : ''}`,
    app: 'ledger',
  };
}

const C = { type: 'string', description: 'Customer / bulk account as the owner said it.' };
const RANGE = { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, period_label: { type: 'string' } };
const PRODUCT = { type: 'string', enum: ['HSD', 'MS', 'XG', 'OTHER'], description: 'HSD = diesel, MS = petrol, XG = XtraGreen' };

export const tools = [
  {
    name: 'ledger_query', app: 'ledger', label: () => 'Customers',
    description: 'Filter and rank every customer in the Ledger: by outstanding (balance, as on today), sales amount, litres, earnings or payments received in a period; optionally one product, retail or bulk, above / below a value, no payment for N days, bulk bills older than N days, or customers who bought this FY but nothing in the period. Answers "which customers owe more than 5 lakh", "top 5 by diesel litres this FY", "who hasn\'t paid in 30 days".',
    input_schema: { type: 'object', properties: { metric: { type: 'string', enum: ['balance', 'amount', 'litres', 'earning', 'paid'] }, ...RANGE, product: PRODUCT, segment: { type: 'string', enum: ['retail', 'bulk'] }, min_value: { type: 'number' }, max_value: { type: 'number' }, no_payment_days: { type: 'integer' }, bills_older_than_days: { type: 'integer' }, not_bought: { type: 'boolean' }, order: { type: 'string', enum: ['desc', 'asc'] }, limit: { type: 'integer' } }, required: ['metric'] },
    run: query,
  },
  {
    name: 'ledger_compare', app: 'ledger', label: (i) => `Compare · ${i.a_label || ''}${i.b_label ? ` vs ${i.b_label}` : ''}`,
    description: 'Compare sales amount, litres, earnings or payments received between two periods (b defaults to the same length just before a), for everyone or one customer, one product or all (with the split by product).',
    input_schema: { type: 'object', properties: { metric: { type: 'string', enum: ['amount', 'litres', 'earning', 'paid'] }, a_from: { type: 'string' }, a_to: { type: 'string' }, a_label: { type: 'string' }, b_from: { type: 'string' }, b_to: { type: 'string' }, b_label: { type: 'string' }, product: PRODUCT, customer: C }, required: ['metric', 'a_from', 'a_to'] },
    run: compare,
  },
  {
    name: 'ledger_customer', app: 'ledger', label: (i) => `${i.customer} · ${i.period_label || 'this month'}`,
    description: 'One customer\'s business in a period (default this month): litres and amount per product, bills, payments, last bill, last payment and outstanding today. E.g. "how much petrol did SMC take in September".',
    input_schema: { type: 'object', properties: { customer: C, ...RANGE, product: PRODUCT }, required: ['customer'] },
    run: customer,
  },
  {
    name: 'ledger_pending_bills', app: 'ledger', label: (i) => `Pending bills${i.customer ? ` · ${i.customer}` : ''}`,
    description: 'Pending (unpaid) bills of bulk accounts, matched to payments the Ledger app\'s way: for one customer (each bill, its age), or for everyone (by customer, with ageing buckets). Optionally only bills older than N days.',
    input_schema: { type: 'object', properties: { customer: C, older_than_days: { type: 'integer' } } },
    run: pendingBills,
  },
  {
    name: 'ledger_pos', app: 'ledger', label: (i) => `POs${i.customer ? ` · ${i.customer}` : ''}`,
    description: 'Purchase orders on the bulk sheets: litres allotted, used and left per PO (by unit for SMC-style sheets), POs running low, bills without a PO and bills needing a unit.',
    input_schema: { type: 'object', properties: { customer: C, low: { type: 'boolean', description: 'only POs running low / used up' } } },
    run: pos,
  },
  {
    name: 'ledger_add_po', app: 'ledger', label: (i) => `Add PO · ${i.customer || ''}`,
    description: 'Add a PO with its allotted litres to a bulk customer\'s PO list (and unit for SMC-style sheets), as the Ledger app\'s POs tab does. The owner confirms first.',
    input_schema: { type: 'object', properties: { customer: C, po_no: { type: 'string' }, litres: { type: 'number' }, unit: { type: 'string' } }, required: ['customer', 'po_no', 'litres'] },
    run: addPo,
  },
  {
    name: 'ledger_day_bills', app: 'ledger', label: (i) => `Bills · ${i.date || 'today'}`,
    description: 'The bills (sales) of one day from the Ledger: each bill, customer, vehicle, litres and amount, with totals per product; optionally one customer or product.',
    input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, customer: C, product: PRODUCT } },
    run: dayBills,
  },
  {
    name: 'ledger_daily_pictures', app: 'ledger', label: () => 'Daily screenshots',
    description: 'The Ledger\'s "Daily Screenshots": for a day (default yesterday) every customer\'s ledger and bill pictures plus the HSD / MS daily summaries, ready to share on WhatsApp.',
    input_schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } } },
    run: dailyPictures,
  },
  {
    name: 'ledger_import_daybook', app: 'ledger', label: () => 'Import DayBook',
    description: 'Import an attached Tally DayBook (.xlsx) into the Ledger, as its Import tab does: new HSD / MS / XG credit bills are added, ones already there skipped. The owner confirms first.',
    input_schema: { type: 'object', properties: { attachment_id: { type: 'string' } }, required: ['attachment_id'] },
    run: importDaybook,
  },
  {
    name: 'ledger_unlogged_payments', app: 'ledger', label: () => 'Payments not in the Ledger',
    description: 'Payments the payments app matched that are not logged in the Ledger yet.',
    input_schema: { type: 'object', properties: {} },
    run: unloggedPayments,
  },
  {
    name: 'ledger_log_payments', app: 'ledger', label: () => 'Log payments in the Ledger',
    description: 'Log every matched payment that isn\'t in the Ledger yet (the Ledger\'s Payments tab "Log payments"). The owner confirms first.',
    input_schema: { type: 'object', properties: {} },
    run: logPayments,
  },
  {
    name: 'ledger_rates', app: 'ledger', label: () => 'Rates',
    description: 'The day\'s RSP per product as billed (today, or the end of a period) and every rate change in the period.',
    input_schema: { type: 'object', properties: { ...RANGE } },
    run: rates,
  },
  {
    name: 'ledger_new_customers', app: 'ledger', label: () => 'Customers without a ledger',
    description: 'New customers from the DayBook that still need a ledger name (or "no ledger needed").',
    input_schema: { type: 'object', properties: {} },
    run: newCustomers,
  },
  {
    name: 'ledger_set_ledger_name', app: 'ledger', label: (i) => `Ledger name · ${i.customer || ''}`,
    description: 'Give a customer its short ledger name, or mark "no ledger needed" (no_ledger true). The owner confirms first.',
    input_schema: { type: 'object', properties: { customer: C, ledger_name: { type: 'string' }, no_ledger: { type: 'boolean' } }, required: ['customer'] },
    run: setLedgerName,
  },
  {
    name: 'ledger_status', app: 'ledger', label: () => 'Ledger status',
    description: 'How up to date the Ledger is: sales in up to which date, the Master Ledger upload date, the last import, customers needing a ledger name.',
    input_schema: { type: 'object', properties: {} },
    run: status,
  },
];
