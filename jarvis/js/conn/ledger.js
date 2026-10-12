// Ledger (/ledger/): outstanding, statements, sales. Uses the ledger app's own
// modules — the same SQL functions, the same rules and the same pictures as
// its Share buttons — so what Jarvis shows always matches the app.

import { analyse, FUELS, periods, PRODUCT_NAME, shortGroup } from '../../../ledger/js/dash.js';
import { demoSeed } from '../../../ledger/js/demo.js';
import { poSummary, retailStatement } from '../../../ledger/js/ledger-view.js';
import { dmyDash, loadBulkAccount, outstandingFor, safeName } from '../../../ledger/js/outstanding.js';
import { brandFontCss, jpegFromSvg, toDataUrl } from '../../../ledger/js/render.js';
import {
  ledgerPagesSvg, monthSlice, outstandingCardSvg, outstandingListSvg, rupees, SHARE_PAGE,
} from '../../../ledger/js/share-svg.js';
import { ledgerRows, monthEnd, monthLabel } from '../../../ledger/js/statements.js';
import { memoryStore, supabaseStore } from '../../../ledger/js/store.js';
import { bestMatch } from '../match.js';
import { signedIn } from '../session.js';

const LOGO = '../ledger/assets/logo.png';
export const round = (n) => Math.round(Number(n) || 0);

let demo = null;
export async function store(ctx) {
  if (ctx.demo) return demo || (demo = memoryStore(demoSeed()));
  return supabaseStore(await signedIn('ledger', 'the Ledger'));
}

// ---- the people: every customer and bulk sheet, with today's balance ------------
let cache = null;
export async function book(ctx) {
  const today = ctx.today;
  if (cache && cache.today === today && cache.demo === ctx.demo && Date.now() - cache.at < 3 * 60000) return cache;
  const s = await store(ctx);
  const per = periods(today);
  const data = await s.dashboard(per.earliest, today);
  const a = analyse(data, per.month);
  const bal = new Map(a.outstanding.map((o) => [o.id, o.balance]));
  const people = new Map();
  for (const [code, title] of data.groups || []) {
    people.set(`g:${code}`, { id: `g:${code}`, name: shortGroup(code, title), kind: 'bulk', names: [shortGroup(code, title), title, code.replace(/_Bulk$/i, '')] });
  }
  for (const [k, name, ledger, group] of data.customers || []) {
    if (group && people.has(`g:${group}`)) { people.get(`g:${group}`).names.push(name); continue; }
    people.set(`c:${k}`, { id: `c:${k}`, name, kind: 'retail', names: [name, ledger].filter(Boolean) });
  }
  for (const p of people.values()) p.balance = bal.get(p.id) ?? 0;
  // customer key -> the account it belongs to (a bulk sheet, or its own ledger)
  const groupOf = new Map((data.customers || []).map(([k, , , group]) => [k, group && people.has(`g:${group}`) ? `g:${group}` : `c:${k}`]));
  const idOf = (k) => groupOf.get(k) || `c:${k}`;
  cache = { today, demo: ctx.demo, at: Date.now(), data, a, per, people: [...people.values()], store: s, idOf };
  return cache;
}

// who is meant -> the person, or an answer asking which one
export async function find(ctx, query) {
  const b = await book(ctx);
  const { best, candidates } = bestMatch(query, b.people, (p) => p.names);
  if (best) return { person: best, b };
  if (!candidates.length) return { ask: { found: false, message: `No customer in the ledger matches "${query}".` }, b };
  return {
    ask: {
      ambiguous: true,
      message: `"${query}" could be: ${candidates.map((c) => c.name).join(', ')}. Which one?`,
      candidates: candidates.map((c) => ({ name: c.name, kind: c.kind, balance: c.balance })),
    },
    b,
  };
}

// "which one?" — the candidates as choices the owner taps or names
export const asked = (ask, tool, input) => ({
  summary: ask,
  say: ask.message,
  choices: (ask.candidates || []).map((c) => ({ label: c.name, tool, input: { ...input, customer: c.name } })),
});

// ---- pictures (exactly the ledger app's) -------------------------------------------
let assets = null;
export const shareKit = () => (assets || (assets = Promise.all([toDataUrl(LOGO).catch(() => ''), brandFontCss()])
  .then(([logo, fontCss]) => ({ images: { logo }, fontCss }))));

async function cardImage(card, base) {
  const { images, fontCss } = await shareKit();
  const { svg, size } = outstandingCardSvg(card, { images, fontCss });
  return { file: new File([await jpegFromSvg(svg, size)], `${base}.jpeg`, { type: 'image/jpeg' }), title: base };
}

export const pendingSummary = (pending) => {
  if (!pending || !pending.length) return null;
  const oldest = pending[0];
  return {
    bills: pending.length,
    total: round(pending.reduce((a, d) => a + d.pending, 0)),
    oldest: { date: oldest.date, days: oldest.days, amount: round(oldest.pending), product: oldest.product },
    over_30_days: pending.filter((d) => d.days > 30).length,
  };
};

// ---- tools ---------------------------------------------------------------------
async function outstanding(input, ctx) {
  const b = await book(ctx);
  if (!input.customer) {
    const seg = ['retail', 'bulk'].includes(input.segment) ? input.segment : 'all';
    const list = b.a.due.filter((o) => seg === 'all' || o.kind === seg);
    const total = list.reduce((x, o) => x + o.balance, 0);
    const images = [];
    if (input.picture !== false) {
      ctx.progress('Drawing the outstanding list…');
      const label = { all: '', retail: 'Retail', bulk: 'Bulk' }[seg];
      const { images: im, fontCss } = await shareKit();
      const { svg, size } = outstandingListSvg({ list, total, asOn: ctx.today, label }, { images: im, fontCss });
      const name = `Outstanding${label ? ` ${label}` : ''} ${dmyDash(ctx.today)}`;
      images.push({ file: new File([await jpegFromSvg(svg, size)], `${name}.jpeg`, { type: 'image/jpeg' }), title: name });
    }
    const adv = b.a.advance.filter((o) => seg === 'all' || o.kind === seg);
    return {
      summary: {
        as_on: ctx.today, segment: seg, total_outstanding: round(total), customers_owing: list.length,
        top: list.slice(0, 12).map((o) => ({ name: o.name, kind: o.kind, balance: round(o.balance) })),
        paid_in_advance: adv.slice(0, 5).map((o) => ({ name: o.name, advance: round(-o.balance) })),
        picture: images.length ? 'shown to the owner' : 'not drawn',
      },
      say: `${list.length} customers owe ${rupees(total)} in all. Top: ${list.slice(0, 3).map((o) => `${o.name} ${rupees(o.balance)}`).join(', ')}.`,
      images,
      app: 'ledger',
    };
  }
  const { person, ask } = await find(ctx, input.customer);
  if (ask) return asked(ask, 'ledger_outstanding', input);
  ctx.progress(`Drawing ${person.name}'s outstanding…`);
  const res = await outstandingFor(b.store, person, ctx.today);
  const [first, ...others] = res.options;
  const images = [];
  if (input.picture !== false) for (const s of first.sets) images.push(await cardImage(s.card, s.base));
  const card = first.sets.length === 1 ? first.sets[0].card : res.options.at(-1).sets[0].card;
  const pend = res.kind === 'bulk' ? pendingSummary(res.acct.fifo.pending) : null;
  return {
    summary: {
      customer: person.name, kind: res.kind, as_on: res.asOn, balance: round(card.balance),
      balance_means: card.balance >= 0 ? 'they owe us' : 'paid in advance',
      since: card.since, billed: round(card.billed), received: round(card.received), litres: round(card.qty),
      last_payment: card.lastPayment || null,
      pending_bills: pend,
      po_wise: res.kind === 'bulk' ? (poSummary(res.acct.fifo.pending)?.rows || []).slice(0, 8)
        .map((r) => ({ po: r.po || r.kind, unit: r.unitLabel || undefined, product: r.product || undefined, pending: round(r.pending), bills: r.bills, oldest_days: r.oldestDays })) : undefined,
      units: res.acct?.units ? res.acct.units.map((u) => ({ unit: u.unit || 'No unit', balance: round(u.st.closing) })) : undefined,
      pictures: images.map((i) => i.title),
      other_picture_options: others.map((o) => o.label),
    },
    say: `${person.name}: ${card.balance >= 0 ? 'outstanding' : 'advance'} ${rupees(Math.abs(card.balance))} as on ${dmyDash(res.asOn)}.`
      + (pend ? ` ${pend.bills} pending bill${pend.bills === 1 ? '' : 's'}, oldest ${pend.oldest.days} days.` : ''),
    images,
    app: 'ledger',
  };
}

async function statement(input, ctx) {
  const { person, ask, b } = await find(ctx, input.customer || '');
  if (ask) return asked(ask, 'ledger_statement', input);
  const ym = /^\d{4}-\d{2}$/.test(input.month || '') ? input.month : null;
  const { images: im, fontCss } = await shareKit();
  ctx.progress(`Drawing ${person.name}'s ledger…`);
  let st;
  let fifo = null;
  let base;
  if (person.kind === 'bulk') {
    const { acct, asOn } = await loadBulkAccount(b.store, person.id.slice(2), person.name, ctx.today);
    st = ym ? monthSlice(acct.st, ym) : acct.st;
    fifo = ym ? null : acct.fifo;
    base = safeName(`${person.name} Ledger ${ym ? monthLabel(`${ym}-01`) : dmyDash(asOn)}`);
  } else {
    const m = ym || ctx.today.slice(0, 7);
    const from = `${m}-01`;
    const to = monthEnd(from);
    const data = await b.store.account(person.id.slice(2), null, from, to);
    const led = ledgerRows({ opening: data.customer.opening, from, sales: data.sales, payments: data.payments });
    st = retailStatement(led, { name: person.name, from, to: to > ctx.today ? ctx.today : to });
    base = safeName(`${person.name} Ledger ${monthLabel(from)}`);
  }
  const svgs = ledgerPagesSvg(st, {
    asOn: ctx.today < st.to ? st.to : ctx.today, images: im, fontCss,
    pending: fifo ? fifo.pending : null, advance: fifo ? fifo.advance : 0, pos: fifo ? poSummary(fifo.pending) : null,
  });
  const images = [];
  for (let i = 0; i < svgs.length; i++) {
    const name = `${base}${svgs.length > 1 ? ` (${i + 1} of ${svgs.length})` : ''}`;
    images.push({ file: new File([await jpegFromSvg(svgs[i], SHARE_PAGE)], `${name}.jpeg`, { type: 'image/jpeg' }), title: name });
  }
  return {
    summary: {
      customer: person.name, kind: person.kind, period: { from: st.from, to: st.to }, opening: round(st.opening), closing: round(st.closing),
      billed: round(st.totals?.billed), received: round(st.totals?.received), entries: st.entries?.length ?? 0, pages: images.length,
    },
    say: `${person.name}'s ledger (${images.length} page${images.length === 1 ? '' : 's'}): closing ${rupees(st.closing)}.`,
    images,
    app: 'ledger',
  };
}

function rangeOf(input, today, per) {
  if (input.from && /^\d{4}-\d{2}-\d{2}$/.test(input.from)) return { from: input.from, to: /^\d{4}-\d{2}-\d{2}$/.test(input.to || '') ? input.to : today, label: input.period_label || `${input.from} to ${input.to || today}` };
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  return {
    today: { from: today, to: today, label: 'Today' },
    yesterday: { from: yesterday, to: yesterday, label: 'Yesterday' },
    this_month: { ...per.month, label: 'This month' },
    last_month: { ...per.last, label: 'Last month' },
    last_30_days: { ...per.d30, label: 'Last 30 days' },
    this_fy: { ...per.fy, label: 'This FY' },
  }[input.period || 'today'] || { from: today, to: today, label: 'Today' };
}

async function sales(input, ctx) {
  const b = await book(ctx);
  const r = rangeOf(input, ctx.today, b.per);
  const data = r.from >= b.per.earliest ? b.data : await b.store.dashboard(r.from, r.to);
  const a = analyse(data, r);
  const products = FUELS.concat('OTHER').map((p) => ({ product: PRODUCT_NAME[p], litres: round(a.products[p].qty), amount: round(a.products[p].amount), earning: round(a.products[p].earning), bills: a.products[p].bills }))
    .filter((p) => p.amount || p.litres);
  return {
    summary: {
      period: r.label, from: r.from, to: r.to, sales: round(a.kpi.amount), litres: round(a.kpi.qty), earnings: round(a.kpi.earning),
      earning_per_litre: a.kpi.perLitre, collections: round(a.kpi.collections), products,
      top_customers: a.customers.slice(0, 6).map((c) => ({ name: c.name, litres: round(c.qty), amount: round(c.amount) })),
      note: a.kpi.noRsp ? `${a.kpi.noRsp} bills had no day's rate, so their earnings aren't counted.` : undefined,
      data_until: b.data.last_sale_date || undefined,
    },
    say: input.product
      ? `${r.label}: ${PRODUCT_NAME[input.product]} ${Math.round(a.products[input.product].qty).toLocaleString('en-IN')} L, ${rupees(a.products[input.product].amount)}, earnings ${rupees(a.products[input.product].earning)} (${a.products[input.product].bills} bills).`
      : `${r.label}: sales ${rupees(a.kpi.amount)}, ${Math.round(a.kpi.qty).toLocaleString('en-IN')} L, earnings ${rupees(a.kpi.earning)}, collections ${rupees(a.kpi.collections)}.`,
    table: products.length ? { columns: ['Product', 'Litres', 'Sales', 'Earnings'], rows: products.map((p) => [p.product, `${p.litres.toLocaleString('en-IN')} L`, rupees(p.amount), rupees(p.earning)]) } : null,
    app: 'ledger',
  };
}

const customerParam = { type: 'string', description: 'The customer or bulk account as the owner said it (part of a name, initials like "SMC", Hinglish is fine).' };

export const tools = [
  {
    name: 'ledger_outstanding',
    app: 'ledger',
    label: (i) => (i.customer ? `Outstanding · ${i.customer}` : 'Outstanding list'),
    description: 'Outstanding balances from the Ledger app, as on today, with the same picture the Ledger app shares on WhatsApp (shown to the owner automatically). '
      + 'With `customer`: that customer\'s card — balance (positive = they owe, negative = paid in advance), billed, received, last payment, pending bills and PO-wise outstanding for bulk customers. '
      + 'Without `customer`: everyone who owes, largest first, as one picture. If the name matches several customers the result lists them — ask the owner which.',
    input_schema: {
      type: 'object',
      properties: {
        customer: customerParam,
        segment: { type: 'string', enum: ['all', 'retail', 'bulk'], description: 'For the list only.' },
        picture: { type: 'boolean', description: 'Draw the picture (default true). Set false when only the figure is needed.' },
      },
    },
    run: outstanding,
  },
  {
    name: 'ledger_statement',
    app: 'ledger',
    label: (i) => `Ledger · ${i.customer || ''}`,
    description: 'A customer\'s ledger / statement of account as A4 pictures (the Ledger app\'s "Share ledger"). Retail customers: one month (default this month). Bulk accounts: the whole ledger with pending bills, or one month.',
    input_schema: {
      type: 'object',
      properties: { customer: customerParam, month: { type: 'string', description: 'YYYY-MM; leave out for this month (retail) or the whole ledger (bulk).' } },
      required: ['customer'],
    },
    run: statement,
  },
  {
    name: 'ledger_sales',
    app: 'ledger',
    label: (i) => `Sales · ${i.period_label || (i.period || 'today').replace(/_/g, ' ')}`,
    description: 'Sales from the Ledger app for a period: amount, litres per product (Diesel/HSD, Petrol/MS, XtraGreen), earnings (margin), collections and the top customers. Sales come in when the Tally DayBook is imported, so today may be empty until then — data_until says the last sale date.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'yesterday', 'this_month', 'last_month', 'last_30_days', 'this_fy'] },
        from: { type: 'string', description: 'YYYY-MM-DD, instead of period' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        period_label: { type: 'string' },
        product: { type: 'string', enum: ['HSD', 'MS', 'XG', 'OTHER'] },
      },
    },
    run: sales,
  },
];
