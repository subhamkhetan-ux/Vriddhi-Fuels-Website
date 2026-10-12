// Jarvis's built-in brain (no AI): reading sentences, choosing the operation,
// conversations (questions, carry-over, pronouns, choices), several requests,
// spelling. All made-up names.
import assert from 'node:assert/strict';
import test from 'node:test';

import { correct, newMemory, remember, understand } from '../../jarvis/js/engine.js';
import { read } from '../../jarvis/js/nlu.js';

const TODAY = '2026-10-12';
const LEX = {
  customers: [{ name: 'SMC Power Generation Ltd', names: ['SMC Power Generation Ltd', 'SMC'] }, { name: 'Keshav Roadlines' }, { name: 'Shyam Metalics and Energy Ltd' }, { name: 'Demo Power Ltd' }],
  accounts: [{ name: 'Ember Coal' }, { name: 'Shyam Metalics' }, { name: 'SSL XP' }],
  tankers: [{ name: 'OD23A3710', names: ['OD23A3710', '3710'] }],
  fleet: [{ name: 'XX01AB1003', names: ['XX01AB1003', '1003'] }],
};
const one = (text, opts = {}) => understand(text, { today: TODAY, lexicon: LEX, ...opts });
const call = (text, opts) => one(text, opts).calls?.[0];

// a conversation: each turn's calls are "answered" and remembered
function talk(turns, answer = (c) => ({ summary: { customer: c.input.customer, account: c.input.account } })) {
  let memory = newMemory();
  return turns.map((text) => {
    const u = one(text, { memory });
    if (u.pending) memory = { ...memory, pending: u.pending };
    for (const c of u.calls || []) memory = remember(memory, c, answer(c));
    return u;
  });
}

test('reading: amounts, days, periods, products, top-N, codes, names', () => {
  const a = read("which bulk customers owe more than 5 lakh and haven't paid in 30 days", { today: TODAY, lexicon: LEX });
  assert.deepEqual(a.money, { value: 500000, op: '>' });
  assert.equal(a.days.value, 30);
  assert.equal(a.segment, 'bulk');
  assert.equal(a.negated, true);
  const b = read('compare diesel sales this month vs last month', { today: TODAY });
  assert.deepEqual(b.periods.map((p) => [p.from, p.to]), [['2026-10-01', '2026-10-12'], ['2026-09-01', '2026-09-30']]);
  assert.equal(b.product, 'HSD');
  assert.equal(b.compare, true);
  assert.deepEqual(read('sales from 1 oct to 10 oct', { today: TODAY }).period, { from: '2026-10-01', to: '2026-10-10', label: '1 Oct – 10 Oct' });
  assert.equal(read('in november', { today: TODAY }).period.from, '2025-11-01');      // the last November
  assert.deepEqual(read('top 5 customers by litres', { today: TODAY }).top, { n: 5, dir: 'desc' });
  assert.equal(read('add PO 4500/123 for SMC 20 KL', { today: TODAY }).po, '4500/123');
  assert.equal(read('add PO 4500/123 for SMC 20 KL', { today: TODAY }).litres.value, 20000);
  assert.equal(read('deliver IND-12', { today: TODAY }).indent, 'IND-0012');
  assert.equal(read('bills on 12 oct 2026', { today: TODAY }).vehicle, null);       // a date, not a vehicle
  assert.equal(read('add 2000 litres to OD23A3710 chamber 2', { today: TODAY }).vehicle, 'OD23A3710');
  assert.equal(read('how much petrol did SMC take', { today: TODAY, lexicon: LEX }).names.customers.item.name, 'SMC Power Generation Ltd');
  assert.equal(read('shyam metalics ka baki kitna hai', { today: TODAY, lexicon: LEX }).metric, 'balance');   // Hinglish
});

test('complex questions go to the right operation with the right details', () => {
  assert.deepEqual(call("which bulk customers owe more than 5 lakh and haven't paid in 30 days"),
    { tool: 'ledger_query', input: { metric: 'balance', order: 'desc', segment: 'bulk', min_value: 500000, no_payment_days: 30 } });
  assert.deepEqual(call('top 5 customers by litres this FY').input, { metric: 'litres', order: 'desc', limit: 5, from: '2026-04-01', to: TODAY, period_label: 'This FY' });
  assert.deepEqual(call('how much petrol did SMC take in September'),
    { tool: 'ledger_customer', input: { customer: 'SMC Power Generation Ltd', from: '2026-09-01', to: '2026-09-30', period_label: 'September 2026', product: 'MS' } });
  assert.equal(call('compare diesel sales this month vs last month').tool, 'ledger_compare');
  assert.deepEqual(call('pending bills older than 45 days for keshav').input, { customer: 'Keshav Roadlines', older_than_days: 45 });
  assert.deepEqual(call('POs running low').input, { low: true });
  assert.deepEqual(call('can I order 12 KL diesel'), { tool: 'decant_room', input: { product: 'HSD', litres: 12000 } });
  assert.deepEqual(call('tank 2 stock 11630'), { tool: 'decant_set_stock', input: { tank_no: 2, litres: 11630 } });
  assert.deepEqual(call('add 2000 litres to OD23A3710 chamber 2'), { tool: 'loading_add', input: { litres: 2000, tanker: 'OD23A3710', chamber: 2 } });
  assert.deepEqual(call('deliver IND-12'), { tool: 'indent_deliver', input: { indent: 'IND-0012' } });
  assert.deepEqual(call('set diesel price to 89.62'), { tool: 'price_set', input: { product: 'Diesel', price: 89.62 } });
  assert.deepEqual(call('record payment 50000 from keshav by upi'), { tool: 'payment_add', input: { customer: 'Keshav Roadlines', amount: 50000, mode: 'UPI' } });
  assert.deepEqual(call('Monitor XtraPower account Ember Coal'), { tool: 'xtrapower_watch', input: { account: 'Ember Coal', watch: true } });
  assert.deepEqual(call('how is XX01AB1003 doing'), { tool: 'fleet_vehicle', input: { vehicle: 'XX01AB1003' } });
  assert.equal(call('good morning jarvis').tool, 'business_brief');
  assert.equal(call('tell me everything about SMC').tool, 'customer_360');
  assert.equal(call('SMC').tool, 'customer_360');                                     // just a known name
  assert.equal(call('which customers need a ledger name').tool, 'ledger_new_customers');
  assert.deepEqual(call('ledger name for fresh traders is Fresh').input, { customer: 'fresh traders', ledger_name: 'fresh' });
  assert.equal(call('is the ledger updated').tool, 'ledger_status');
  assert.deepEqual(call('open the indents app'), { tool: 'open_app', input: { app: 'indents' } });
});

test('a file says what to do with it', () => {
  assert.equal(call('update stock', { attachments: [{ id: 'att1', kind: 'image' }] }).tool, 'decant_update_stock_from_photo');
  assert.equal(call('', { attachments: [{ id: 'att2', kind: 'excel' }] }).tool, 'ledger_import_daybook');
  assert.equal(call('', { attachments: [{ id: 'att3', kind: 'pdf' }] }).tool, 'decant_add_invoice');
});

test('missing details are asked for and filled from the answers', () => {
  const [ask1, ask2, done] = talk(['add a PO for SMC', '4500/123', '20 KL']);
  assert.equal(ask1.ask, 'Tell me the PO number and litres.');
  assert.equal(ask2.ask, 'Tell me the litres.');                                     // the PO's digits aren't litres
  assert.deepEqual(done.calls, [{ tool: 'ledger_add_po', input: { customer: 'SMC Power Generation Ltd', po_no: '4500/123', litres: 20000 } }]);
  const [, indent] = talk(['place an indent for keshav', 'diesel 5000 litres']);
  assert.deepEqual(indent.calls, [{ tool: 'indent_place', input: { customer: 'Keshav Roadlines', product: 'Diesel', litres: 5000 } }]);
});

test('carry-over: a sentence of only new details changes the last request', () => {
  const r = talk(['how much petrol did SMC take in September', 'and diesel?', 'sales today', 'yesterday', 'and petrol?', 'top 5 customers by litres this FY', 'top 10', 'retail only']);
  assert.deepEqual(r[1].calls[0].input.product, 'HSD');
  assert.equal(r[1].calls[0].tool, 'ledger_customer');
  assert.deepEqual(r[3].calls[0].input, { from: '2026-10-11', to: '2026-10-11', period_label: 'Yesterday' });
  assert.deepEqual(r[4].calls[0], { tool: 'ledger_sales', input: { from: '2026-10-11', to: '2026-10-11', period_label: 'Yesterday', product: 'MS' } });
  assert.equal(r[6].calls[0].input.limit, 10);
  assert.equal(r[6].calls[0].input.metric, 'litres');
  assert.equal(r[7].calls[0].input.segment, 'retail');
  // a new question is not a carry-over
  const s = talk(['bottom 3 customers by sales this FY', 'diesel sales yesterday']);
  assert.equal(s[1].calls[0].tool, 'ledger_sales');
});

test('pronouns and "and X?" use the conversation', () => {
  const r = talk(['outstanding of keshav', 'his statement', 'outstanding of smc', 'and keshav?', 'Monitor XtraPower account Ember Coal', 'stop it']);
  assert.deepEqual(r[1].calls[0], { tool: 'ledger_statement', input: { customer: 'Keshav Roadlines' } });
  assert.deepEqual(r[3].calls[0], { tool: 'ledger_outstanding', input: { customer: 'Keshav Roadlines' } });
  assert.deepEqual(r[5].calls[0], { tool: 'xtrapower_watch', input: { account: 'Ember Coal', watch: false } });
});

test('picking one of the choices offered', () => {
  const choices = ['Shree Steel', 'Shiva Steel'].map((label) => ({ label, tool: 'ledger_outstanding', input: { customer: label } }));
  for (const [said, who] of [['the second one', 'Shiva Steel'], ['2', 'Shiva Steel'], ['first', 'Shree Steel'], ['shiva', 'Shiva Steel']]) {
    assert.deepEqual(one(said, { choices }).calls, [{ tool: 'ledger_outstanding', input: { customer: who } }], said);
  }
});

test('several requests at once — but one question with "and" stays one', () => {
  assert.deepEqual(one('tank stock and sales today').calls.map((c) => c.tool), ['decant_tank_stock', 'ledger_sales']);
  assert.deepEqual(one('tankk stok and fleet status').calls.map((c) => c.tool), ['decant_tank_stock', 'fleet_status']);
  assert.equal(one("which bulk customers owe more than 5 lakh and haven't paid in 30 days").calls.length, 1);
  assert.deepEqual(one('outstanding of shyam metalics and energy').calls, [{ tool: 'ledger_outstanding', input: { customer: 'Shyam Metalics and Energy Ltd' } }]);
});

test('spelling slips in command words; names are left alone', () => {
  assert.equal(correct('show me the ballance list'), 'show me the balance list');
  assert.equal(correct('xtrapowr status'), 'xtrapower status');
  assert.equal(correct('Salem Traders'), 'Salem Traders');
  const u = understand('tankk stok', { today: TODAY });
  assert.deepEqual(u.calls, [{ tool: 'decant_tank_stock', input: {} }]);
  assert.equal(u.corrected, 'tank stock');
  assert.equal(understand('salem', { today: TODAY }).calls[0].input.customer, 'salem');   // a name, not "sales"
});

test('nothing fits: say so, with help', () => {
  assert.equal(understand('what is the weather in delhi today', { today: TODAY }).calls, undefined);
  assert.deepEqual(understand('help', { today: TODAY }), { help: true });
});

test('the Mac side switched off: say so instead of guessing', () => {
  const off = new Set(['xtrapower_watch', 'xtrapower_status', 'xtrapower_monitor', 'xtrapower_logs', 'xtrapower_open_window', 'mac_scripts', 'mac_run_script']);
  assert.match(one('Monitor XtraPower account Ember Coal', { off }).note, /switched off/);
  assert.equal(one('tank stock', { off }).calls[0].tool, 'decant_tank_stock');
});
