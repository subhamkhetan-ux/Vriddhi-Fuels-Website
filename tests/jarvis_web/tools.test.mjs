// Jarvis's operations against the demo data of every app (no network), and the
// optional Claude loop with a fake client. Pictures and file readers need a
// browser and aren't run here. Demo stores live for the whole file, so the
// tests run in order.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Brain, systemPrompt } from '../../jarvis/js/brain.js';
import { TOOL_NAMES } from '../../jarvis/js/intents.js';
import { apiTools, checkInput, MAC_TOOLS, runTool, TOOLS } from '../../jarvis/js/tools.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = iso(new Date());
function ctx(over = {}) {
  const confirms = [];
  return {
    demo: true, today: TODAY, attachments: new Map(), progress: () => {},
    confirm: async (card) => { confirms.push(card); return over.yes ?? true; },
    confirms, ...over,
  };
}
const run = async (name, input, c = ctx()) => {
  const out = await runTool(name, input, c);
  assert.ok(out.ok, `${name}: ${out.error}`);
  return out.result;
};
const firstOfMonth = `${TODAY.slice(0, 7)}-01`;

test('every operation is defined, and reachable by words or a file', () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z0-9_]+$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.input_schema.type, 'object');
    assert.equal(typeof t.label({}), 'string');
  }
  assert.ok(TOOLS.length >= 55);
  assert.equal(apiTools().length, TOOLS.length - MAC_TOOLS.size);            // the Mac side is off
  assert.ok(!apiTools().some((t) => MAC_TOOLS.has(t.name)));
  const byFile = ['ledger_import_daybook', 'decant_update_stock_from_photo', 'decant_add_invoice'];
  assert.deepEqual([...names].filter((n) => !TOOL_NAMES.includes(n) && !byFile.includes(n)), []);
  assert.deepEqual(TOOL_NAMES.filter((n) => !names.has(n)), []);
});

test('inputs are checked before an operation runs', () => {
  const t = TOOLS.find((x) => x.name === 'xtrapower_monitor');
  assert.equal(checkInput(t, {}), '"action" is required.');
  assert.equal(checkInput(t, { action: 'explode' }), '"action" must be one of start, stop.');
  assert.equal(checkInput(t, { action: 'stop' }), null);
});

test('ledger: sales, outstanding, one customer', async () => {
  const s = await run('ledger_sales', { from: firstOfMonth, to: TODAY, period_label: 'This month' });
  assert.ok(s.summary.sales > 0 && s.table.rows.length);
  const d = await run('ledger_sales', { from: firstOfMonth, to: TODAY, product: 'HSD' });
  assert.match(d.say, /Diesel .* L/);
  const list = await run('ledger_outstanding', { picture: false });
  assert.ok(list.summary.total_outstanding > 0);
  const one = await run('ledger_outstanding', { customer: 'demo power', picture: false });
  assert.equal(one.summary.customer, 'Demo Power Ltd');
  assert.equal((await run('ledger_outstanding', { customer: 'tata motors', picture: false })).summary.found, false);
});

test('ledger: filtering and ranking customers', async () => {
  const owe = await run('ledger_query', { metric: 'balance', min_value: 500000 });
  assert.ok(owe.summary.rows.every((r) => r.balance > 500000));
  assert.ok(owe.summary.rows.length >= 2);
  const bulk = await run('ledger_query', { metric: 'balance', segment: 'bulk', min_value: 500000, no_payment_days: 30 });
  assert.ok(bulk.summary.rows.every((r) => r.kind === 'bulk' && (r.days_since_payment === null || r.days_since_payment > 30)));
  const top = await run('ledger_query', { metric: 'litres', limit: 3, from: `${TODAY.slice(0, 4) - (TODAY.slice(5, 7) < '04' ? 1 : 0)}-04-01`, to: TODAY });
  assert.equal(top.summary.rows.length, 3);
  assert.ok(top.summary.rows[0].litres >= top.summary.rows[1].litres);
  assert.match(top.say, /^Top 3 by litres/);
  const low = await run('ledger_query', { metric: 'amount', order: 'asc', limit: 2 });
  assert.ok(low.summary.rows[0].amount <= low.summary.rows[1].amount);
  const paid = await run('ledger_query', { metric: 'paid' });
  assert.ok(paid.summary.rows.every((r) => r.paid > 0));
});

test('ledger: compare periods and one customer\'s business', async () => {
  const lastStart = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 2, 1)).toISOString().slice(0, 10);
  const lastEnd = new Date(Date.UTC(+TODAY.slice(0, 4), +TODAY.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
  const c = await run('ledger_compare', { metric: 'amount', product: 'HSD', a_from: firstOfMonth, a_to: TODAY, a_label: 'This month', b_from: lastStart, b_to: lastEnd, b_label: 'Last month' });
  assert.equal(c.summary.change, c.summary.a.value - c.summary.b.value);
  assert.match(c.say, /This month .* vs Last month/);
  const auto = await run('ledger_compare', { metric: 'litres', a_from: firstOfMonth, a_to: TODAY });
  assert.equal(auto.summary.b.label, 'the period before');
  const cust = await run('ledger_customer', { customer: 'twin steel', product: 'HSD' });
  assert.equal(cust.summary.customer, 'Twin Steel Ltd');
  assert.match(cust.say, /^Twin Steel Ltd took [\d,]+ L of Diesel/);
});

test('ledger: pending bills, POs, adding a PO, day bills, names, status, rates', async () => {
  const all = await run('ledger_pending_bills', { older_than_days: 5 });
  assert.ok(all.summary.accounts >= 1);
  const one = await run('ledger_pending_bills', { customer: 'demo power' });
  assert.ok(one.summary.bills > 0);
  const retail = await run('ledger_pending_bills', { customer: 'sample roadlines' });
  assert.equal(retail.summary.kind, 'retail');
  const pos = await run('ledger_pos', {});
  assert.ok(pos.summary.pos_open > 0);
  const low = await run('ledger_pos', { low: true });
  assert.ok(Array.isArray(low.summary.running_low));
  const no = ctx({ yes: false });
  assert.equal((await run('ledger_add_po', { customer: 'demo power', po_no: 'PO/T/1', litres: 5000 }, no)).summary.saved, false);
  const c = ctx();
  const added = await run('ledger_add_po', { customer: 'demo power', po_no: 'PO/T/1', litres: 5000 }, c);
  assert.equal(added.summary.saved, true);
  assert.equal(c.confirms.length, 1);
  assert.ok((await run('ledger_pos', { customer: 'demo power' })).summary.pos.some((p) => p.po === 'PO/T/1'));
  const units = await run('ledger_add_po', { customer: 'twin steel', po_no: 'X1', litres: 100 });
  assert.equal(units.summary.needs, 'unit');                      // a unit-wise sheet asks which unit
  const day = await run('ledger_day_bills', { date: new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) });
  assert.ok(day.summary.bills >= 1);
  const names = await run('ledger_new_customers', {});
  assert.ok(names.summary.count >= 1);
  const st = await run('ledger_status', {});
  assert.ok(st.summary.sales_until);
  assert.ok('rsp' in (await run('ledger_rates', {})).summary);
});

test('payments: review, match, record, Log to Excel, log into the Ledger', async () => {
  const rev = await run('payments_review', {});
  assert.ok(rev.summary.count >= 1);
  const amt = rev.summary.credits[0].amount;
  const m = await run('payments_match', { amount: amt, customer: 'example infra' });
  assert.equal(m.summary.customer, 'Example Infra');
  assert.equal((await run('payments_review', {})).summary.count, rev.summary.count - 1);
  const add = await run('payment_add', { customer: 'fresh traders', amount: 25000, mode: 'CHEQUE' });
  assert.equal(add.summary.customer, 'Fresh Traders');
  const recent = await run('payments_recent', { days: 2, customer: 'fresh traders' });
  assert.ok(recent.summary.payments.some((p) => p.amount === 25000));
  const xl = await run('payments_log_excel', {});
  assert.ok(xl.summary.queued >= 1);
  assert.equal((await run('payments_log_excel', {})).summary.queued, 0);
  const todo = await run('ledger_unlogged_payments', {});
  assert.ok(todo.summary.not_in_ledger >= 1);
  const logged = await run('ledger_log_payments', {});
  assert.equal(logged.summary.logged, todo.summary.not_in_ledger);
  assert.equal((await run('ledger_unlogged_payments', {})).summary.not_in_ledger, 0);
});

test('decant: stock, typed reading needs an OK, room, trucks, hiding an invoice, report', async () => {
  assert.equal((await run('decant_tank_stock', {})).summary.tanks.length, 4);
  const no = ctx({ yes: false });
  assert.equal((await run('decant_set_stock', { tank_no: 3, litres: 6000 }, no)).summary.saved, false);
  assert.equal((await run('decant_set_stock', { tank_no: 3, litres: 6000 })).summary.saved, true);
  assert.equal((await run('decant_tank_stock', {})).summary.tanks.find((t) => t.tank === 3).stock_litres, 6000);
  const room = await run('decant_room', { product: 'HSD', litres: 12000 });
  assert.match(room.say, /^Yes — Diesel/);
  assert.match((await run('decant_room', { product: 'HSD', litres: 40000 })).say, /^Not yet/);
  assert.ok((await run('decant_trucks', {})).summary.trucks.length >= 1);
  const hide = await run('decant_dismiss_invoice', { truck: '8210', reason: 'outside' });
  assert.equal(hide.summary.saved, true);
  assert.equal((await run('decant_trucks', {})).summary.trucks.length, 0);
  assert.equal((await run('decant_report', {})).summary.tanks_decanted, 0);
  assert.match((await run('decant_update_stock_from_photo', { attachment_id: 'att9' })).say, /Attach/);
});

test('fleet: status, one bulker, diesel recon, trips, SSFC', async () => {
  const st = await run('fleet_status', {});
  assert.ok(st.summary.vehicles.length > 0);
  const v = await run('fleet_vehicle', { vehicle: '1003' });
  assert.equal(v.summary.vehicle, 'XX01AB1003');
  const d = await run('fleet_diesel', {});
  assert.ok(d.summary.vehicles.length > 0);
  const t = await run('fleet_trips', {});
  assert.ok(t.summary.trips >= 0);
  assert.ok('account' in (await run('fleet_ssfc', {})).summary);
});

test('loading: tankers, a loading, sent for sale, trips', async () => {
  const before = (await run('loading_tankers', {})).summary.tankers.find((x) => x.tanker === 'OR15R1110');
  const add = await run('loading_add', { tanker: '1110', litres: 5000 });
  assert.equal(add.summary.added, 5000);
  assert.equal((await run('loading_tankers', {})).summary.tankers.find((x) => x.tanker === 'OR15R1110').filled, before.filled + 5000);
  const tooMuch = await run('loading_add', { tanker: '1110', litres: 999999 });
  assert.match(tooMuch.say, /only/);
  const sent = await run('loading_dispatch', { tanker: '3710', customer: 'Sample Roadlines' });
  assert.equal(sent.summary.dispatched, true);
  assert.equal((await run('loading_tankers', {})).summary.tankers.find((x) => x.tanker === 'OD23A3710').filled, 0);
  assert.equal((await run('loading_trips', {})).summary.trips, 1);
});

test('indents: board, place, deliver, cancel, prices', async () => {
  const board = await run('indents_list', {});
  assert.ok(board.summary.pending >= 1);
  const placed = await run('indent_place', { customer: 'example infra', product: 'Diesel', litres: 300 });
  assert.equal(placed.summary.status, 'Awaiting');
  assert.equal((await run('indent_deliver', { indent: 'IND-1' })).summary.delivered, true);
  assert.match((await run('indent_deliver', { indent: 'IND-1' })).say, /delivered — only pending/);
  assert.equal((await run('indent_cancel', { indent: 'IND-0002' })).summary.cancelled, true);
  await run('price_set', { product: 'Petrol', price: 101.25 });
  assert.equal((await run('prices', {})).summary.prices.find((p) => p.product === 'Petrol').price, 101.25);
});

test('XtraPower through the (pretend) Mac, Tally, apps', async () => {
  const on = await run('xtrapower_watch', { account: 'ember', watch: true });
  assert.match(on.say, /Now watching Ember Coal/);
  assert.equal((await run('xtrapower_status', {})).summary.running, true);
  const bad = await runTool('xtrapower_watch', { account: 'tata', watch: true }, ctx());
  assert.equal(bad.ok, false);
  assert.ok((await run('tally_vouchers', {})).summary.vouchers >= 1);
  assert.equal((await run('open_app', { app: 'decanting' })).links[0].href, '../decant/');
});

test('across the apps: the brief and a customer everywhere', async () => {
  const b = await run('business_brief', {});
  assert.ok(b.summary.sections.length >= 6, b.summary.not_available.join('; '));
  const c = await run('customer_360', { customer: 'twin steel' });
  assert.equal(c.summary.customer, 'Twin Steel Ltd');
  assert.ok(c.summary.this_month && c.summary.pos);
});

// ---- the optional Claude loop ---------------------------------------------------
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => { calls.push(JSON.parse(JSON.stringify(req))); const next = script.shift(); if (next instanceof Error) throw next; return next; } } },
  };
}

test('Claude loop: runs the tools, returns all results together, keeps history whole', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'tu1', name: 'decant_tank_stock', input: {} },
      { type: 'tool_use', id: 'tu2', name: 'open_app', input: { app: 'fleet' } },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tank 2 has 11,630 L.' }] },
  ]);
  const brain = new Brain({ getClient: async () => client });
  const reply = await brain.turn([{ type: 'text', text: 'stock?' }], ctx());
  assert.equal(reply, 'Tank 2 has 11,630 L.');
  const second = client.calls[1];
  assert.equal(second.model, 'claude-opus-5-5');
  assert.equal(second.tools.length, TOOLS.length - MAC_TOOLS.size);
  assert.equal(second.messages[1].content[0].type, 'thinking');
  assert.deepEqual(second.messages[2].content.map((r) => r.tool_use_id), ['tu1', 'tu2']);
  assert.equal(brain.history.length, 4);
});

test('Claude loop: a failed turn leaves no trace, so the built-in brain can take over', async () => {
  const brain = new Brain({ getClient: async () => fakeClient([Object.assign(new Error('Your credit balance is too low'), { status: 400 })]) });
  await assert.rejects(brain.turn([{ type: 'text', text: 'hi' }], ctx()), /credit balance/);
  assert.equal(brain.history.length, 0);
  assert.match(systemPrompt('2026-10-12'), /Today is 2026-10-12/);
});
