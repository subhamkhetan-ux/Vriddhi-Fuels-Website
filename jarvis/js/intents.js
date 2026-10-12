// Which operation a sentence asks for, and with what — the decision layer of
// the built-in brain. Every operation has a matcher that scores the sentence
// (read by nlu.js) from 0 to 100 and fills its input. The best score wins; a
// matcher can also say what is still missing and how to ask for it.
//   match(nl, {attachments}) -> [{tool, score, input, missing?, ask?}]
// Pure (tests/jarvis_web/engine.test.mjs).

import { nameOf, says } from './nlu.js';

const period = (p) => (p ? { from: p.from, to: p.to, period_label: p.label } : {});
const customerIn = (nl) => (nl.names.customers?.item ? nl.names.customers.item.name : nl.names.customers?.text || null);
const loose = (nl) => {                              // a name from the left-over words
  const r = (nl.rest || '').replace(/\b(sir|ji|ka|ki|ke|hai|wala|wale|log|people|party|parties)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return r.length >= 2 ? r : null;
};
const who = (nl) => customerIn(nl) || loose(nl);
const num = (nl, unit = null) => nl.numbers.find((n) => n.unit === unit)?.value ?? null;
const OUT = ['outstanding', 'balance', 'dues', 'due', 'owe', 'owes', 'owing', 'receivable', 'receivables', 'udhaar'];
const SALE = ['sales', 'sale', 'sold', 'revenue', 'business', 'turnover', 'billing', 'billed'];
const LIFT = ['take', 'took', 'taken', 'bought', 'buy', 'lifted', 'lift', 'purchased', 'consumed', 'used', 'liya'];
const PRODUCT_NAMES = { HSD: 'Diesel', MS: 'Petrol', XG: 'XtraGreen' };

// The matchers. Each returns null or {score, input, missing?, ask?}.
const M = {
  // ---------------------------------------------------------------- Ledger
  ledger_query(nl) {
    // "which bulk customers owe more than 5 lakh", "top 5 customers by litres",
    // "who hasn't paid in 30 days", "who bought petrol yesterday"
    if (says(nl, 'ledger name', 'ledger names', 'need ledger')) return null;
    const listy = nl.question === 'which' || nl.top || says(nl, 'customers', 'parties', 'everyone', 'list of');
    const filter = nl.money || nl.days || nl.negated || nl.top || nl.litres;
    if (!listy) return null;
    if (customerIn(nl) && !nl.top && !nl.money) return null;
    // just "top 10" — a change to the last list, not a new one
    if (nl.top && !nl.metric && !nl.period && !nl.product && !nl.segment && !nl.money && !says(nl, 'customers', 'parties', 'buyers')) return { score: 50, input: { limit: nl.top.n || 5, order: nl.top.dir } };
    const lift = says(nl, ...LIFT) || says(nl, 'customer', 'customers');
    let metric = nl.top || nl.money ? (nl.metrics.find((m) => m !== 'bills') || (nl.money ? 'balance' : 'amount')) : nl.metric;
    if (!metric) metric = lift || nl.products.length ? 'litres' : 'amount';
    if (nl.litres && !nl.money) metric = 'litres';
    const input = { metric, order: nl.top?.dir || 'desc' };
    if (nl.top?.n) input.limit = nl.top.n;
    if (nl.segment) input.segment = nl.segment;
    if (nl.product) input.product = nl.product;
    Object.assign(input, period(nl.period));
    if (nl.money) {
      const m = nl.metrics.find((x) => x !== 'bills' && x !== 'litres') || 'balance';
      input.metric = input.metric === 'litres' && !nl.litres ? m : input.metric;
      input[nl.money.op === '<' ? 'max_value' : 'min_value'] = nl.money.value;
      if (!nl.top) input.metric = m;
    }
    if (nl.litres) input[nl.litres.op === '<' ? 'max_value' : 'min_value'] = nl.litres.value;
    if (nl.days && (nl.negated || says(nl, 'paid', 'payment', 'payments'))) input.no_payment_days = nl.days.value;
    else if (nl.negated && says(nl, 'paid', 'payment', 'payments')) input.no_payment_days = 30;
    if (nl.days && says(nl, 'bills', 'bill', 'pending', 'overdue', 'old', 'older')) input.bills_older_than_days = nl.days.value;
    if (nl.negated && lift && nl.period) input.not_bought = true;
    return { score: filter || nl.question === 'which' ? 82 : 60, input };
  },

  ledger_compare(nl) {
    if (!(nl.compare && nl.periods.length >= 2) && !(says(nl, 'compare', 'comparison', 'growth', 'grew', 'increase', 'decrease', 'change') && nl.periods.length >= 1)) return null;
    const [a, b] = nl.periods.length >= 2 ? nl.periods : [nl.periods[0], null];
    const metric = nl.metrics.find((m) => ['amount', 'litres', 'earning', 'paid'].includes(m)) || (nl.products.length ? 'litres' : 'amount');
    const input = { metric, a_from: a.from, a_to: a.to, a_label: a.label };
    if (b) Object.assign(input, { b_from: b.from, b_to: b.to, b_label: b.label });
    if (nl.product) input.product = nl.product;
    const c = customerIn(nl);
    if (c) input.customer = c;
    return { score: 88, input };
  },

  ledger_customer(nl) {
    // "how much petrol did SMC take in September", "SMC's diesel this month"
    const c = customerIn(nl);
    if (!c) return null;
    const lifted = says(nl, ...LIFT) || nl.products.length || says(nl, 'litres', 'sales', 'business', 'purchases', 'payments', 'paid');
    if (!lifted || says(nl, ...OUT) || says(nl, 'statement', 'ledger')) return null;
    if (nl.compare && nl.periods.length >= 2) return null;
    const input = { customer: c, ...period(nl.period) };
    if (nl.product) input.product = nl.product;
    return { score: 84, input };
  },

  ledger_outstanding(nl) {
    if (!says(nl, ...OUT)) return null;
    const c = who(nl);
    if (says(nl, 'list', 'all', 'everyone', 'everybody', 'total') || !c) {
      return { score: 70, input: nl.segment ? { segment: nl.segment } : {} };
    }
    return { score: 76, input: { customer: c } };
  },

  ledger_statement(nl) {
    if (!says(nl, 'statement', 'ledger', 'soa', 'khata', 'hisab', 'hisaab')) return null;
    const c = who(nl);
    const input = c ? { customer: c } : {};
    if (nl.period?.month) input.month = nl.period.month;
    return c ? { score: 80, input } : { score: 72, input, missing: ['customer'], ask: 'Whose statement?' };
  },

  ledger_sales(nl) {
    if (!(says(nl, ...SALE) || (says(nl, 'earnings', 'earning', 'margin', 'profit', 'collections', 'collection') && !says(nl, 'customer', 'customers')))) return null;
    const input = { ...period(nl.period || { from: nl.today, to: nl.today, label: 'Today' }) };
    if (nl.product) input.product = nl.product;
    return { score: 66, input };
  },

  ledger_pending_bills(nl) {
    if (!says(nl, 'bills', 'bill', 'invoices') || !says(nl, 'pending', 'unpaid', 'overdue', 'old', 'older', 'outstanding', 'due', 'aging', 'ageing')) return null;
    const input = {};
    const c = customerIn(nl) || loose(nl);
    if (c) input.customer = c;
    if (nl.days) input.older_than_days = nl.days.value;
    return { score: 86, input };
  },

  ledger_pos(nl) {
    if (!says(nl, 'po', 'pos', 'purchase order', 'purchase orders') || says(nl, 'add', 'new', 'create')) return null;
    const low = /\b(running low|low|almost|nearly|finishing|exhausted|over|ending|khatam)\b/.test(nl.text);
    const left = loose(nl)?.replace(/\b(running|low|almost|nearly|finishing|exhausted|over|ending|khatam|out|used up|up)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const c = customerIn(nl) || (left || null);
    const input = c ? { customer: c } : {};
    if (low) input.low = true;
    return { score: 84, input };
  },

  ledger_add_po(nl) {
    if (!says(nl, 'po', 'purchase order') || !says(nl, 'add', 'new', 'create', 'enter', 'record')) return null;
    const input = {};
    const c = customerIn(nl) || loose(nl);
    if (c) input.customer = c;
    if (nl.po) input.po_no = nl.po;
    const l = nl.litres?.value ?? num(nl);
    if (l) input.litres = l;
    const missing = ['customer', 'po_no', 'litres'].filter((k) => !input[k]);
    return { score: 90, input, missing, ask: missing.length ? `Tell me the ${missing.map((k) => ({ customer: 'customer', po_no: 'PO number', litres: 'litres' })[k]).join(' and ')}.` : undefined };
  },

  ledger_day_bills(nl) {
    if (!says(nl, 'bills', 'bill', 'invoices', 'slips') || says(nl, 'pending', 'unpaid', 'overdue', 'older', 'tanker bill', 'tanker bills')) return null;
    const d = nl.period?.day ? nl.period.from : nl.today;
    const input = { date: d };
    const c = customerIn(nl);
    if (c) input.customer = c;
    if (nl.product) input.product = nl.product;
    return { score: 74, input };
  },

  ledger_daily_pictures(nl) {
    if (!says(nl, 'daily screenshots', 'daily pictures', 'daily statements', 'screenshots', 'whatsapp statements')) return null;
    return { score: 88, input: { date: nl.period?.day ? nl.period.from : undefined } };
  },

  ledger_rates(nl) {
    if (!says(nl, 'rate', 'rates', 'rsp', 'price', 'prices') || says(nl, 'set', 'change', 'update')) return null;
    return { score: 70, input: { ...period(nl.period) } };
  },

  ledger_new_customers(nl) {
    if (!(says(nl, 'new customers', 'new customer', 'need ledger', 'ledger name', 'ledger names', 'without a ledger', 'no ledger')) || /ledger(?: name)? (?:for|of) .+ (?:is|=|as)/.test(nl.text)) return null;
    return { score: 90, input: {} };
  },

  ledger_set_ledger_name(nl) {
    const m = nl.raw.toLowerCase().match(/ledger(?: name)? (?:for|of) (.+?) (?:is|=|as|should be) (.+)$/) || nl.raw.toLowerCase().match(/(?:call|name) (.+?)'?s? ledger (.+)$/);
    if (m) return { score: 92, input: { customer: m[1].trim(), ledger_name: m[2].trim().replace(/[".]+$/g, '') } };
    const n = nl.raw.toLowerCase().match(/no ledger (?:needed )?for (.+)$/);
    if (n) return { score: 92, input: { customer: n[1].trim(), no_ledger: true } };
    return null;
  },

  ledger_status(nl) {
    if (!says(nl, 'last import', 'updated till', 'updated until', 'data till', 'master file', 'last upload', 'daybook status', 'updated', 'up to date', 'latest data', 'last updated')) return null;
    if (!says(nl, 'ledger', 'data', 'daybook', 'master file', 'sales', 'import', 'upload')) return null;
    return { score: 90, input: {} };
  },

  ledger_unlogged_payments(nl) {
    if (!says(nl, 'payments') || !says(nl, 'ledger', 'log', 'logged', 'not in ledger', 'unlogged')) return null;
    if (says(nl, 'log them', 'log all', 'log payments', 'add to ledger')) return null;
    return { score: 78, input: {} };
  },

  ledger_log_payments(nl) {
    if (!says(nl, 'log', 'add') || !says(nl, 'payments', 'payment', 'them') || !says(nl, 'ledger', 'them', 'all')) return null;
    if (says(nl, 'excel')) return null;
    return { score: 82, input: {} };
  },

  // ---------------------------------------------------------------- Decant
  decant_tank_stock(nl) {
    if (!says(nl, 'stock', 'tank', 'tanks', 'underground', 'ullage', 'dip') || nl.numbers.length || nl.dipCm) return null;
    if (says(nl, 'room', 'space', 'fit', 'can i order', 'order')) return null;
    return { score: 64, input: {} };
  },

  decant_set_stock(nl) {
    if (!nl.tank || !(nl.dipCm || num(nl) || nl.litres)) return null;
    const input = { tank_no: nl.tank };
    if (nl.dipCm || (says(nl, 'dip') && num(nl))) input.dip_cm = nl.dipCm ?? num(nl);
    else input.litres = nl.litres?.value ?? num(nl);
    return { score: 88, input };
  },

  decant_room(nl) {
    if (!(says(nl, 'room', 'space', 'ullage', 'fit', 'can i order', 'how much can', 'order more', 'empty space') && (nl.products.length || says(nl, 'tank', 'tanks', 'room')))) return null;
    const input = {};
    if (nl.product) input.product = nl.product;
    if (nl.litres) input.litres = nl.litres.value;
    return { score: 84, input };
  },

  decant_trucks(nl) {
    if (!(says(nl, 'trucks', 'truck', 'tt', 'tts', 'tankers', 'invoices') && says(nl, 'decant', 'waiting', 'arrived', 'to decant', 'pending', 'come', 'came')) && !says(nl, 'to decant')) return null;
    return { score: 80, input: {} };
  },

  decant_report(nl) {
    if (!says(nl, 'variation', 'decant report', 'decanting report', 'shortage', 'short', 'excess') || says(nl, 'trip', 'trips', 'tonnes')) return null;
    return { score: 80, input: { ...period(nl.period || { from: `${nl.today.slice(0, 7)}-01`, to: nl.today, label: 'This month' }) } };
  },

  decant_dismiss_invoice(nl) {
    if (!says(nl, 'dismiss', 'hide', 'remove', 'not ours', 'already decanted')) return null;
    if (!(says(nl, 'invoice', 'truck', 'tt') || nl.vehicle || nl.invoice)) return null;
    const input = {};
    if (nl.vehicle) input.truck = nl.vehicle;
    if (nl.invoice) input.invoice_no = nl.invoice;
    input.reason = says(nl, 'not ours') ? 'not_ours' : 'outside';
    return { score: 86, input, missing: input.truck || input.invoice_no ? [] : ['truck'], ask: 'Which truck or invoice?' };
  },

  // ---------------------------------------------------------------- XtraPower / Mac
  xtrapower_watch(nl) {
    const acct = nl.names.accounts;
    const xp = says(nl, 'xtrapower', 'xp', 'ccms', 'monitor', 'monitoring', 'watch', 'watching', 'unwatch');
    if (!xp) return null;
    const off = says(nl, 'stop', 'pause', 'off', 'unwatch', 'end', 'disable');
    const name = acct?.item?.name || acct?.text || (says(nl, 'monitor', 'watch', 'watching', 'monitoring') ? loose(nl) : null);
    if (!name) return null;
    if (says(nl, 'status', 'running', 'logs', 'log', 'window', 'chrome') && !says(nl, 'start', 'stop', 'watch', 'monitor')) return null;
    return { score: 90, input: { account: name, watch: !off } };
  },

  xtrapower_monitor(nl) {
    if (!says(nl, 'xtrapower', 'ccms', 'monitor', 'monitoring')) return null;
    const on = says(nl, 'start', 'resume', 'on', 'begin', 'enable');
    const off = says(nl, 'stop', 'pause', 'off', 'end', 'disable');
    if (!on && !off) return null;
    return { score: 80, input: { action: off ? 'stop' : 'start' } };
  },

  xtrapower_status(nl) {
    if (!says(nl, 'xtrapower', 'ccms', 'monitor', 'monitoring', 'fleet card')) return null;
    if (says(nl, 'logs', 'log')) return null;
    return { score: 62, input: {} };
  },

  xtrapower_logs(nl) {
    if (!says(nl, 'xtrapower', 'monitor', 'monitoring', 'ccms') || !says(nl, 'logs', 'log')) return null;
    return { score: 86, input: { lines: num(nl) || 20 } };
  },

  xtrapower_open_window(nl) {
    if (!says(nl, 'window', 'chrome', 'browser', 'login window') || !says(nl, 'open', 'launch')) return null;
    const a = nl.names.accounts?.item?.name || nl.names.accounts?.text || loose(nl);
    return a ? { score: 88, input: { account: a } } : { score: 70, input: {}, missing: ['account'], ask: 'Which XtraPower account?' };
  },

  mac_scripts(nl) {
    if (!says(nl, 'scripts', 'script') || says(nl, 'run')) return null;
    return { score: 80, input: {} };
  },

  mac_run_script(nl) {
    if (!says(nl, 'run', 'restart', 'launch') || !(nl.names.scripts || says(nl, 'script', 'agent', 'tally app'))) return null;
    const s = nl.names.scripts?.item?.name || nl.names.scripts?.text || loose(nl);
    return s ? { score: 84, input: { name: s } } : null;
  },

  // ---------------------------------------------------------------- Fleet
  fleet_status(nl) {
    if (!says(nl, 'fleet', 'bulker', 'bulkers', 'on the road', 'on road', 'shree shyam')) return null;
    if (says(nl, 'diesel', 'recon', 'ssfc', 'trips') && !says(nl, 'status', 'where')) return null;
    return { score: 70, input: {} };
  },

  fleet_vehicle(nl) {
    const v = nl.names.fleet?.item?.name || (nl.vehicle && says(nl, 'bulker', 'trip', 'trips', 'fleet') ? nl.vehicle : null);
    if (!v || says(nl, 'diesel', 'recon')) return null;
    return { score: 86, input: { vehicle: v } };
  },

  fleet_diesel(nl) {
    if (!says(nl, 'fleet', 'bulker', 'bulkers', 'ssfc', 'trip') || !says(nl, 'diesel', 'recon', 'allotment', 'allotted', 'excess diesel')) return null;
    const input = {};
    if (nl.names.fleet?.item) input.vehicle = nl.names.fleet.item.name;
    return { score: 84, input };
  },

  fleet_ssfc(nl) {
    if (!says(nl, 'ssfc', 'freight carrier', 'hire')) return null;
    return { score: 82, input: {} };
  },

  fleet_trips(nl) {
    if (!says(nl, 'trips', 'trip', 'tonnes', 'freight', 'bhada') || says(nl, 'diesel', 'recon')) return null;
    const input = { ...period(nl.period) };
    if (nl.names.fleet?.item) input.vehicle = nl.names.fleet.item.name;
    return { score: 76, input };
  },

  // ---------------------------------------------------------------- Loading
  loading_tankers(nl) {
    if (!says(nl, 'tankers', 'tanker', 'loading', 'fill level', 'delivery tankers') || nl.litres || says(nl, 'trips', 'dispatch', 'sent', 'sold')) return null;
    if (says(nl, 'billing', 'bill', 'bills')) return null;
    return { score: 66, input: {} };
  },

  loading_add(nl) {
    const t = nl.names.tankers?.item?.name || nl.vehicle;
    if (!nl.litres || !(t || says(nl, 'tanker', 'loaded', 'load', 'loading'))) return null;
    if (!says(nl, 'add', 'load', 'loaded', 'filled', 'fill', 'put')) return null;
    const input = { litres: nl.litres.value };
    if (t) input.tanker = t;
    if (nl.chamber) input.chamber = nl.chamber;
    return t ? { score: 90, input } : { score: 80, input, missing: ['tanker'], ask: 'Which tanker?' };
  },

  loading_dispatch(nl) {
    const t = nl.names.tankers?.item?.name || nl.vehicle;
    if (!says(nl, 'dispatch', 'dispatched', 'sent for sale', 'send for sale', 'sent', 'sold to', 'gone to')) return null;
    if (!(t || says(nl, 'tanker'))) return null;
    const input = {};
    if (t) input.tanker = t;
    const c = customerIn(nl);
    if (c) input.customer = c;
    return t ? { score: 88, input } : { score: 78, input, missing: ['tanker'], ask: 'Which tanker?' };
  },

  loading_trips(nl) {
    if (!says(nl, 'tanker', 'tankers', 'loading') || !says(nl, 'trips', 'dispatches', 'sales', 'sent', 'deliveries', 'history')) return null;
    return { score: 80, input: { ...period(nl.period) } };
  },

  // ---------------------------------------------------------------- Indents
  indents_list(nl) {
    if (says(nl, 'open', 'launch', 'go to', 'take me to')) return null;
    if (!says(nl, 'indent', 'indents', 'orders', 'order') || says(nl, 'place', 'new', 'cancel', 'deliver', 'delivered', 'book', 'po')) {
      if (!(says(nl, 'indents') && says(nl, 'delivered'))) return null;
    }
    if (nl.indent) return null;
    const input = { ...period(nl.period) };
    if (says(nl, 'pending', 'open')) input.status = 'Pending';
    if (says(nl, 'awaiting', 'approval')) input.status = 'Awaiting';
    if (says(nl, 'delivered')) input.status = 'Delivered';
    if (says(nl, 'cancelled')) input.status = 'Cancelled';
    const c = customerIn(nl);
    if (c) input.customer = c;
    return { score: 76, input };
  },

  indent_place(nl) {
    if (!says(nl, 'indent', 'order', 'book') || !says(nl, 'place', 'new', 'create', 'book', 'log', 'make')) return null;
    if (says(nl, 'po', 'purchase order')) return null;
    const input = {};
    const c = customerIn(nl) || loose(nl);
    if (c) input.customer = c;
    if (nl.product) input.product = PRODUCT_NAMES[nl.product] || nl.product;
    if (nl.litres) input.litres = nl.litres.value;
    else if (nl.money) input.amount = nl.money.value;
    if (nl.vehicle) input.vehicle = nl.vehicle;
    const missing = ['customer', 'product'].filter((k) => !input[k]);
    if (!input.litres && !input.amount) missing.push('litres');
    return { score: 90, input, missing, ask: missing.length ? `For the indent, tell me the ${missing.map((k) => ({ customer: 'customer', product: 'product (diesel / petrol / XtraGreen)', litres: 'litres or amount' })[k]).join(', ')}.` : undefined };
  },

  indent_deliver(nl) {
    if (!says(nl, 'deliver', 'delivered', 'mark delivered', 'filled')) return null;
    if (!nl.indent && !says(nl, 'indent')) return null;
    const input = nl.indent ? { indent: nl.indent } : {};
    if (nl.litres) input.delivered = nl.litres.value;
    else if (nl.money) input.delivered = nl.money.value;
    return nl.indent ? { score: 92, input } : { score: 74, input, missing: ['indent'], ask: 'Which indent (e.g. IND-0123)?' };
  },

  indent_cancel(nl) {
    if (!says(nl, 'cancel') || !(nl.indent || says(nl, 'indent'))) return null;
    return nl.indent ? { score: 92, input: { indent: nl.indent } } : { score: 74, input: {}, missing: ['indent'], ask: 'Which indent (e.g. IND-0123)?' };
  },

  prices(nl) {
    if (!says(nl, 'price', 'prices', 'rate', 'rates') || says(nl, 'set', 'change', 'update', 'chart')) return null;
    if (nl.period && !nl.period.day) return null;
    return { score: 72, input: {} };
  },

  price_set(nl) {
    if (!says(nl, 'price', 'rate') || !says(nl, 'set', 'change', 'update', 'new', 'make')) return null;
    const p = num(nl) ?? nl.money?.value;
    const input = {};
    if (nl.product) input.product = PRODUCT_NAMES[nl.product];
    if (p) input.price = p;
    const missing = ['product', 'price'].filter((k) => !input[k]);
    return { score: 90, input, missing, ask: missing.length ? 'Which product and what price per litre?' : undefined };
  },

  // ---------------------------------------------------------------- Payments
  payments_recent(nl) {
    if (!says(nl, 'payments', 'payment', 'received', 'credits', 'credited', 'collections', 'collection')) return null;
    if (says(nl, 'review', 'unmatched', 'not matched', 'unknown', 'excel', 'ledger', 'log')) return null;
    const input = {};
    if (nl.period) input.days = Math.max(1, Math.round((Date.parse(nl.today) - Date.parse(nl.period.from)) / 86400000) + 1);
    if (nl.days) input.days = nl.days.value;
    const c = customerIn(nl);
    if (c) input.customer = c;
    return { score: 64, input };
  },

  payments_review(nl) {
    if (!says(nl, 'payments', 'payment', 'credits', 'credit') || !says(nl, 'review', 'unmatched', 'not matched', 'unknown', 'needs review', 'match')) return null;
    if (customerIn(nl) && says(nl, 'match', 'is')) return null;
    return { score: 84, input: {} };
  },

  payments_match(nl) {
    if (!says(nl, 'match', 'is from', 'belongs to', 'was from', 'assign')) return null;
    const amt = nl.money?.value ?? num(nl);
    const c = customerIn(nl);
    if (!c && !amt) return null;
    const input = {};
    if (amt) input.amount = amt;
    if (c) input.customer = c;
    const missing = ['amount', 'customer'].filter((k) => !input[k]);
    return { score: 86, input, missing, ask: missing.length ? 'Which credit (its amount) and which customer?' : undefined };
  },

  payments_log_excel(nl) {
    if (!says(nl, 'excel', 'master paid') || !says(nl, 'log', 'send', 'push', 'post')) return null;
    return { score: 88, input: {} };
  },

  payment_add(nl) {
    if (!says(nl, 'payment', 'paid', 'received', 'deposited', 'cheque', 'cash', 'upi', 'neft', 'rtgs')) return null;
    if (!says(nl, 'add', 'enter', 'record', 'entry', 'note')) return null;
    const amt = nl.money?.value ?? num(nl);
    const input = {};
    const c = customerIn(nl) || loose(nl);
    if (c) input.customer = c;
    if (amt) input.amount = amt;
    const mode = ['upi', 'cash', 'cheque', 'neft', 'rtgs', 'imps', 'bank'].find((m) => says(nl, m));
    if (mode) input.mode = mode.toUpperCase();
    if (nl.period?.day) input.date = nl.period.from;
    const missing = ['customer', 'amount'].filter((k) => !input[k]);
    return { score: 88, input, missing, ask: missing.length ? `Tell me the ${missing.join(' and ')}.` : undefined };
  },

  // ---------------------------------------------------------------- Tally
  tally_vouchers(nl) {
    if (!says(nl, 'tally', 'voucher', 'vouchers')) return null;
    return { score: 80, input: { ...period(nl.period) } };
  },

  // ---------------------------------------------------------------- across the apps
  business_brief(nl) {
    if (!says(nl, 'brief', 'briefing', 'summary', 'overview', 'how is business', 'how are things', 'dashboard', 'good morning', 'what happened', 'update me', 'report card')) return null;
    if (customerIn(nl)) return null;
    return { score: 74, input: { ...period(nl.period?.day ? nl.period : null) } };
  },

  customer_360(nl) {
    const c = customerIn(nl);
    if (!c) return null;
    if (!says(nl, 'everything', 'all about', 'details', 'profile', 'full picture', 'tell me about', 'about', 'summary', 'info', 'information', '360')) return null;
    return { score: 86, input: { customer: c } };
  },

  open_app(nl) {
    if (!says(nl, 'open', 'launch', 'go to', 'take me to')) return null;
    if (says(nl, 'window', 'chrome')) return null;
    const said = nl.text.match(/\b(?:open|launch|go to|take me to)\s+(?:the\s+|my\s+)?(.+?)(?:\s+app)?\s*\??$/);
    const app = (said && said[1]) || nl.names.apps?.item?.name || loose(nl);
    if (!app) return null;
    return { score: nl.names.apps?.item || says(nl, 'app', 'application') ? 94 : 72, input: { app } };
  },
};

export function match(nl, { attachments = [] } = {}) {
  const out = [];
  // a file says what to do with it
  for (const a of attachments) {
    if (a.kind === 'excel') out.push({ tool: 'ledger_import_daybook', score: says(nl, 'daybook', 'import', 'sales', 'upload') || !nl.text ? 95 : 70, input: { attachment_id: a.id } });
    if (a.kind === 'pdf') out.push({ tool: 'decant_add_invoice', score: 90, input: { attachment_id: a.id } });
    if (a.kind === 'image') out.push({ tool: 'decant_update_stock_from_photo', score: says(nl, 'stock', 'tank', 'tanks', 'dip', 'decant', 'automation', 'update', 'upload', 'screenshot', 'photo') || !nl.text ? 95 : 55, input: { attachment_id: a.id } });
  }
  for (const [tool, fn] of Object.entries(M)) {
    const r = fn(nl);
    if (r) out.push({ tool, ...r });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const TOOL_NAMES = Object.keys(M);
export { nameOf };
