// The built-in brain — Jarvis with no AI service at all (the default).
//   nlu.js reads the sentence (amounts, dates, products, names from the apps…)
//   intents.js scores every operation and fills its input
//   this file keeps the conversation going:
//   - missing details are asked for, and the next answer fills them
//       "add a PO for SMC" → "What's the PO number and litres?" → "4500/12, 20 KL"
//   - slot carry-over: a sentence with only new details changes the last request
//       "sales this month" → "last month?" → "diesel only" → "and petrol?"
//       "outstanding of Keshav" → "and SMC?" ; "top 5 customers" → "top 10"
//   - pronouns: "his statement", "stop it", "deliver it"
//   - several requests at once: "tank stock and sales today"
//   - picking one of several matches: "the second one", "shiva"
//   - spelling slips in command words, and "did you mean" when nothing fits
// understand(text, {attachments, memory, choices, lexicon, today}) ->
//   {calls: [{tool, input}]} | {ask, pending} | {help: true} | {suggest: [phrase]}
// remember(memory, call, result) — after a call.
// Pure (tests/jarvis_web/engine.test.mjs).

import { match } from './intents.js';
import { bestMatch, editDistance } from './match.js';
import { read, says } from './nlu.js';
import { HELP, parse } from './quick.js';

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const lower = (s) => ` ${clean(s).toLowerCase()} `;
const OK = 60;                                    // a score Jarvis acts on

export const newMemory = () => ({ last: null, customer: null, account: null, tanker: null, indent: null, pending: null });

const PRONOUN = /\b(his|her|their|its|him|them|it|uska|uski|unka|unki|iska|same|that one|that customer|is customer|us customer|this one)\b/;

// ---- picking one of several -----------------------------------------------------------
// checked in this order ("second one" is the second, not "one")
const ORDINAL = [
  ['first', 0], ['1st', 0], ['pehla', 0], ['second', 1], ['2nd', 1], ['doosra', 1], ['dusra', 1], ['third', 2], ['3rd', 2], ['teesra', 2],
  ['fourth', 3], ['4th', 3], ['fifth', 4], ['5th', 4], ['last', -1], ['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4], ['one', 0], ['two', 1], ['three', 2],
];
function pickChoice(text, choices) {
  const t = lower(text);
  for (const [w, i] of ORDINAL) {
    if (new RegExp(`\\b${w}\\b`).test(t) && t.trim().split(' ').length <= 4) return choices.at(i) || null;
  }
  return bestMatch(text, choices, (c) => c.label).best;
}

// ---- spelling ------------------------------------------------------------------------
const VOCAB = ['outstanding', 'balance', 'statement', 'ledger', 'sales', 'stock', 'tank', 'tanks', 'monitor', 'monitoring', 'xtrapower',
  'status', 'decant', 'trucks', 'fleet', 'payments', 'tankers', 'loading', 'yesterday', 'today', 'month', 'start', 'stop', 'open',
  'variation', 'report', 'collections', 'earnings', 'list', 'logs', 'window', 'invoices', 'pending', 'scripts', 'customers', 'compare',
  'indent', 'indents', 'deliver', 'delivered', 'cancel', 'dispatch', 'vouchers', 'diesel', 'petrol', 'xtragreen', 'statement', 'september',
  'october', 'november', 'december', 'january', 'february', 'august', 'outstandings', 'litres', 'payment', 'received'];
// short words are too close to names ("Salem" / "sales"), so only these slips
const SLIPS = { stok: 'stock', stoc: 'stock', tankk: 'tank', tnak: 'tank', taank: 'tank', sale: 'sales', sels: 'sales', fleat: 'fleet', flet: 'fleet', staus: 'status', satus: 'status', logz: 'logs', disel: 'diesel', desel: 'diesel', petrl: 'petrol', baki: 'baki' };
export function correct(text) {
  return clean(text).split(' ').map((w) => {
    const lw = w.toLowerCase().replace(/[^a-z]/g, '');
    if (SLIPS[lw]) return SLIPS[lw];
    if (lw.length < 6 || VOCAB.includes(lw)) return w;
    const max = lw.length >= 9 ? 2 : 1;
    const hit = VOCAB.map((v) => [v, editDistance(lw, v, max)]).filter(([, d]) => d <= max).sort((a, b) => a[1] - b[1])[0];
    return hit ? hit[0] : w;
  }).join(' ');
}

// ---- carry-over: what a new sentence changes in the last request ----------------------
const SLOTS = {
  period: ['ledger_sales', 'ledger_customer', 'ledger_query', 'decant_report', 'fleet_trips', 'loading_trips', 'indents_list', 'tally_vouchers', 'ledger_rates', 'business_brief'],
  day: ['ledger_day_bills', 'ledger_daily_pictures'],
  month: ['ledger_statement'],
  product: ['ledger_sales', 'ledger_customer', 'ledger_query', 'ledger_compare', 'ledger_day_bills', 'decant_room'],
  customer: ['ledger_outstanding', 'ledger_statement', 'ledger_customer', 'ledger_pending_bills', 'ledger_pos', 'customer_360', 'payments_recent', 'indents_list', 'ledger_compare'],
  segment: ['ledger_outstanding', 'ledger_query'],
  limit: ['ledger_query'],
  account: ['xtrapower_watch', 'xtrapower_open_window'],
  vehicle: ['fleet_vehicle', 'fleet_diesel'],
};

function carryOver(nl, last, memory) {
  if (!last) return null;
  const input = { ...last.input };
  let changed = false;
  const can = (slot) => SLOTS[slot].includes(last.tool);
  if (nl.period && can('period')) {
    Object.assign(input, { from: nl.period.from, to: nl.period.to, period_label: nl.period.label });
    delete input.period;
    changed = true;
  } else if (nl.period?.day && can('day')) { input.date = nl.period.from; changed = true; }
  else if (nl.period?.month && can('month')) { input.month = nl.period.month; changed = true; }
  if (nl.product && can('product')) { input.product = nl.product; changed = true; }
  else if (says(nl, 'all products', 'all fuels', 'every product') && can('product')) { delete input.product; changed = true; }
  if (nl.segment && can('segment')) { input.segment = nl.segment; changed = true; }
  if (nl.top?.n && can('limit')) { input.limit = nl.top.n; input.order = nl.top.dir; changed = true; }
  const c = nl.names.customers?.item?.name || nl.names.customers?.text;
  const about = nl.text.match(/^(?:and|aur|what about|how about|or|also|then)\s+(.+?)\s*\??$/);
  if (can('customer')) {
    if (c) { input.customer = c; changed = true; } else if (about && !nl.period && !nl.product && nl.rest) { input.customer = nl.rest; changed = true; }
  }
  const a = nl.names.accounts?.item?.name;
  if (a && can('account')) { input.account = a; changed = true; }
  // "stop it" after watching an account
  if (last.tool === 'xtrapower_watch' && says(nl, 'stop', 'start', 'resume', 'unwatch') && (PRONOUN.test(nl.s) || nl.words.size <= 2)) {
    input.watch = !says(nl, 'stop', 'unwatch'); input.account = memory.account || input.account; changed = true;
  }
  return changed ? { tool: last.tool, input } : null;
}

// fill what a pending question asked for from the answer
const FILL = {
  customer: (nl, text) => nl.names.customers?.item?.name || nl.names.customers?.text || nl.rest || clean(text),
  po_no: (nl, text) => nl.po || (clean(text).match(/[a-z0-9][a-z0-9/._-]*\d[a-z0-9/._-]*/i) || [])[0]?.toUpperCase(),
  litres: (nl) => nl.litres?.value ?? nl.numbers.find((n) => !n.unit)?.value,
  amount: (nl) => nl.money?.value ?? nl.numbers.find((n) => !n.unit)?.value,
  product: (nl) => ({ HSD: 'Diesel', MS: 'Petrol', XG: 'XtraGreen' })[nl.product],
  price: (nl) => nl.numbers.find((n) => !n.unit)?.value ?? nl.money?.value,
  indent: (nl) => nl.indent,
  account: (nl, text) => nl.names.accounts?.item?.name || nl.rest || clean(text),
  tanker: (nl, text) => nl.names.tankers?.item?.name || nl.vehicle || clean(text),
  truck: (nl, text) => nl.vehicle || nl.invoice || clean(text),
};

function answerPending(text, nl, pending) {
  const input = { ...pending.input };
  // a PO number's digits aren't litres: "4500/123" fills the PO only
  const poNow = pending.missing.includes('po_no') && !input.po_no ? FILL.po_no(nl, text) : null;
  if (poNow) { input.po_no = poNow; if (!nl.litres) nl = { ...nl, numbers: [] }; }
  for (const k of pending.missing) {
    if (input[k] !== undefined && input[k] !== null && input[k] !== '') continue;
    const v = (k === 'litres' && pending.tool === 'indent_place' && !nl.litres && nl.money) ? null : FILL[k]?.(nl, text);
    if (v !== undefined && v !== null && v !== '') input[k] = v;
  }
  if (pending.tool === 'indent_place' && !input.litres && !input.amount && nl.money) input.amount = nl.money.value;
  // other details said in the answer count too
  if (nl.product && 'product' in FILL && pending.tool === 'indent_place' && !input.product) input.product = FILL.product(nl);
  if (nl.po && !input.po_no && pending.tool === 'ledger_add_po') input.po_no = nl.po;
  if (nl.litres && !input.litres && ['ledger_add_po', 'indent_place', 'loading_add'].includes(pending.tool)) input.litres = nl.litres.value;
  const missing = pending.missing.filter((k) => input[k] === undefined || input[k] === null || input[k] === ''
    && !(k === 'litres' && input.amount));
  return { tool: pending.tool, input, missing: missing.filter((k) => !(k === 'litres' && input.amount)) };
}

// several requests in one sentence ("tank stock and sales today")
function splitAll(text, opts) {
  const parts = text.split(/\s+(?:and|aur|also|then|plus|&)\s+|[;,]\s*|\?\s+/i).map(clean).filter(Boolean);
  if (parts.length < 2) return null;
  const calls = [];
  for (const p of parts) {
    const nl = read(p, opts);
    let top = match(nl)[0];
    if (!top || top.score < OK) { const q = parse(p) || parse(correct(p)); top = q && !q.help ? { ...q, score: OK } : null; }
    if (!top || top.missing?.length) return null;
    calls.push({ tool: top.tool, input: top.input });
  }
  const seen = new Set();
  const out = calls.filter((c) => { const k = JSON.stringify(c); if (seen.has(k)) return false; seen.add(k); return true; });
  return new Set(out.map((c) => c.tool)).size >= 2 || out.length >= 2 ? out : null;
}

// fill a missing customer / account from the memory: "his statement", "stop it"
function withMemory(call, nl, memory) {
  const input = { ...call.input };
  if (SLOTS.customer.includes(call.tool) && memory.customer && (PRONOUN.test(nl.s) || (call.tool === 'ledger_statement' && !input.customer))) {
    if (!input.customer || PRONOUN.test(` ${input.customer} `) || input.customer.split(' ').every((w) => PRONOUN.test(` ${w} `))) {
      input.customer = memory.customer;
      delete input.segment;
    }
  }
  if (call.tool === 'xtrapower_watch' && memory.account && (!input.account || PRONOUN.test(` ${input.account} `))) input.account = memory.account;
  if (['indent_deliver', 'indent_cancel'].includes(call.tool) && !input.indent && memory.indent && PRONOUN.test(nl.s)) input.indent = memory.indent;
  if (['loading_add', 'loading_dispatch'].includes(call.tool) && !input.tanker && memory.tanker && PRONOUN.test(nl.s)) input.tanker = memory.tanker;
  const missing = (call.missing || []).filter((k) => input[k] === undefined || input[k] === null || input[k] === '');
  return { ...call, input, missing };
}

const CROSS = new Set(['ledger_query', 'ledger_compare', 'ledger_customer', 'customer_360', 'ledger_add_po', 'indent_place', 'payment_add', 'ledger_set_ledger_name']);

export function understand(text, opts = {}) {
  const first = understandAs(text, opts);
  if (first.calls && !first.guess) return first;
  if (first.ask) return first;
  const fixed = correct(text);                     // only when the words as typed don't work
  if (fixed.toLowerCase() === clean(text).toLowerCase()) return first;
  const second = understandAs(fixed, opts);
  return (second.calls && !second.guess) || second.ask ? { ...second, corrected: fixed } : first;
}

function understandAs(text, { attachments = [], memory = newMemory(), choices = null, lexicon = {}, today } = {}) {
  const t = clean(text);
  const ropts = { lexicon, today };
  const atts = attachments.map((a) => (typeof a === 'string' ? { id: a, kind: 'image' } : a));
  if (choices?.length && t) {
    const c = pickChoice(t, choices);
    if (c) return { calls: [{ tool: c.tool, input: c.input }] };
  }
  const nl = read(t, ropts);
  const cands = match(nl, { attachments: atts });
  const top = cands[0];

  // an answer to the question asked last
  if (memory.pending && t && !(top && top.score >= 85 && top.tool !== memory.pending.tool && !top.missing?.length)) {
    const r = answerPending(t, nl, memory.pending);
    if (!r.missing.length) return { calls: [{ tool: r.tool, input: r.input }] };
    return { ask: askFor(r), pending: r };
  }
  if (!t && !atts.length) return { suggest: [] };
  if (/^\s*(help|what can you do|commands|madad)\s*\??\s*$/i.test(t)) return { help: true };

  // several requests at once
  if (!atts.length && !(top && CROSS.has(top.tool) && top.score >= 80)) {
    const many = splitAll(t, ropts);
    if (many) return { calls: many.map((c) => withMemory(c, read(t, ropts), memory)).map(({ tool, input }) => ({ tool, input })) };
  }

  if (top && top.score >= OK) {
    const call = withMemory(top, nl, memory);
    // a sentence that only adds details to the last request ("last month?") changes that instead
    if (memory.last && top.score < 70) {
      const co = carryOver(nl, memory.last, memory);
      if (co && co.tool !== call.tool && isOnlyDetails(nl)) return { calls: [co] };
    }
    if (call.missing?.length) return { ask: askFor(call, top.ask), pending: { tool: call.tool, input: call.input, missing: call.missing } };
    return { calls: [{ tool: call.tool, input: call.input }] };
  }

  const co = carryOver(nl, memory.last, memory);
  if (co) return { calls: [co] };

  // the phrase parser, for anything the scorer missed
  const q = parse(t, { attachments: atts.filter((a) => a.kind === 'image').map((a) => a.id) });
  if (q?.help) return { help: true };
  if (q) return { calls: [withMemory({ tool: q.tool, input: q.input }, nl, memory)].map(({ tool, input }) => ({ tool, input })) };

  // "statement" alone, or just a name
  if (says(nl, 'statement', 'ledger') && memory.customer) return { calls: [{ tool: 'ledger_statement', input: { customer: memory.customer } }] };
  const c = nl.names.customers?.item;
  if (c) return { calls: [{ tool: 'customer_360', input: { customer: c.name } }] };
  const words = t.replace(/[?.!]/g, '').split(' ').filter(Boolean);
  if (words.length && words.length <= 3 && /[a-z]{3}/i.test(t)) {
    return { calls: [{ tool: 'ledger_outstanding', input: { customer: t.replace(/[?.!]/g, '') } }], guess: true, suggest: suggestions(t) };
  }
  return { suggest: suggestions(t) };
}

// nothing but details (a period, a product, a name, a number) — no request words
const DETAIL = /\b(and|aur|what|about|how|or|also|then|only|just|for|in|of|the|please|same|now|by|with|diesel|petrol|xtragreen|hsd|ms|xg|today|yesterday|day|before|this|last|previous|current|month|week|year|fy|financial|retail|bulk|top|bottom|lakh|lakhs|crore|cr|k|kl|l|litres?|q[1-4]|since|from|to|till|until|between|vs|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|\d[\d,./-]*)\b/g;
function isOnlyDetails(nl) {
  let left = ` ${nl.text} `;
  for (const h of Object.values(nl.names)) if (h?.text) left = left.replace(` ${h.text} `, ' ');
  left = left.replace(/[?.!,]/g, ' ').replace(DETAIL, ' ').trim();
  return !left;
}

const LABEL = { customer: 'customer', po_no: 'PO number', litres: 'litres', amount: 'amount', product: 'product', price: 'price', indent: 'indent number', account: 'account', tanker: 'tanker', truck: 'truck or invoice' };
function askFor(call, ask) {
  return ask || `Tell me the ${call.missing.map((k) => LABEL[k] || k).join(' and ')}.`;
}

// the closest commands to what was said
export function suggestions(text) {
  const phrases = HELP.filter(([p]) => !p.startsWith('📎')).map(([p, what]) => ({ p, what }));
  const { candidates } = bestMatch(text, phrases, (x) => [x.p, x.what], { min: 25 });
  return candidates.slice(0, 3).map((x) => x.p.split(' / ')[0]);
}

// after a call: what to remember for the next sentence
export function remember(memory, call, result) {
  const m = { ...memory, last: call, pending: null };
  const s = result?.summary || {};
  if (s.customer && typeof s.customer === 'string') m.customer = s.customer;
  if (call.tool.startsWith('xtrapower') && s.account) m.account = s.account;
  if (s.tanker) m.tanker = s.tanker;
  if (s.indent) m.indent = s.indent;
  return m;
}
