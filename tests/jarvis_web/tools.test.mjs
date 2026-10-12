// Jarvis's tools against the demo data (no network), and the optional Claude
// loop with a fake client. The pictures need a browser and aren't drawn here.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Brain, systemPrompt } from '../../jarvis/js/brain.js';
import { apiTools, checkInput, runTool, TOOLS } from '../../jarvis/js/tools.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function ctx(over = {}) {
  const confirms = [];
  return {
    demo: true, today: iso(new Date()), attachments: new Map(), progress: () => {},
    confirm: async (card) => { confirms.push(card); return over.yes ?? true; },
    confirms, ...over,
  };
}
const run = async (name, input, c = ctx()) => {
  const out = await runTool(name, input, c);
  assert.ok(out.ok, `${name}: ${out.error}`);
  return out.result;
};

test('every tool has a usable definition', () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.input_schema.type, 'object');
    assert.equal(typeof t.label({}), 'string');
  }
  assert.equal(apiTools().length, TOOLS.length);
  assert.ok(!JSON.stringify(apiTools()).includes('"run"'));
});

test('inputs are checked before a tool runs', () => {
  const t = TOOLS.find((x) => x.name === 'xtrapower_monitor');
  assert.equal(checkInput(t, {}), '"action" is required.');
  assert.equal(checkInput(t, { action: 'explode' }), '"action" must be one of start, stop.');
  assert.equal(checkInput(t, { action: 'stop' }), null);
});

test('ledger: sales, outstanding list and one customer (demo)', async () => {
  const s = await run('ledger_sales', { period: 'this_month' });
  assert.ok(s.summary.sales > 0 && s.summary.products.length);
  const list = await run('ledger_outstanding', { picture: false });
  assert.ok(list.summary.total_outstanding > 0 && list.summary.top[0].balance >= list.summary.top.at(-1).balance);
  const one = await run('ledger_outstanding', { customer: 'demo power', picture: false });
  assert.equal(one.summary.customer, 'Demo Power Ltd');
  assert.ok(one.summary.pending_bills.bills > 0);
  assert.match(one.say, /^Demo Power Ltd: outstanding ₹/);
  const none = await run('ledger_outstanding', { customer: 'tata motors', picture: false });
  assert.equal(none.summary.found, false);
});

test('decant: stock, a typed reading needs the owner\'s OK, trucks, report (demo)', async () => {
  const stock = await run('decant_tank_stock', {});
  assert.equal(stock.summary.tanks.length, 4);
  const no = ctx({ yes: false });
  const declined = await run('decant_set_stock', { tank_no: 3, litres: 6000 }, no);
  assert.equal(declined.summary.saved, false);
  assert.equal(no.confirms.length, 1);
  const c = ctx();
  const saved = await run('decant_set_stock', { tank_no: 3, litres: 6000 }, c);
  assert.equal(saved.summary.saved, true);
  const after = await run('decant_tank_stock', {});
  assert.equal(after.summary.tanks.find((t) => t.tank === 3).stock_litres, 6000);
  const dip = await run('decant_set_stock', { tank_no: 2, dip_cm: 120 });
  assert.ok(dip.summary.stock > 10000 && dip.summary.dip_cm === 120);
  const bad = await run('decant_set_stock', { tank_no: 9, litres: 1 });
  assert.match(bad.summary.error, /No tank 9/);
  assert.ok((await run('decant_trucks', {})).summary.trucks.length >= 1);
  assert.equal((await run('decant_report', { period: 'this_month' })).summary.tanks_decanted, 0);
  const noPic = await run('decant_update_stock_from_photo', { attachment_id: 'att9' });
  assert.match(noPic.say, /Attach/);
});

test('XtraPower through the (pretend) Mac: watch, stop, ambiguous names', async () => {
  const on = await run('xtrapower_watch', { account: 'ember', watch: true });
  assert.match(on.say, /Now watching Ember Coal/);
  assert.equal(on.summary.account, 'Ember Coal');
  const st = await run('xtrapower_status', {});
  assert.equal(st.summary.running, true);
  const out = await runTool('xtrapower_watch', { account: 'tata', watch: true }, ctx());
  assert.equal(out.ok, false);
  assert.match(out.error, /No XtraPower account matches/);
});

test('fleet, payments, apps (demo)', async () => {
  const f = await run('fleet_status', {});
  assert.ok(f.summary.on_the_road.length > 0);
  const p = await run('payments_recent', { days: 31 });
  assert.ok(p.summary.count >= 1);
  const a = await run('open_app', { app: 'decanting' });
  assert.equal(a.links[0].href, '../decant/');
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
  const steps = [];
  const reply = await brain.turn([{ type: 'text', text: 'stock?' }], ctx(), { step: (n, i, s) => steps.push(`${n}:${s}`) });
  assert.equal(reply, 'Tank 2 has 11,630 L.');
  assert.deepEqual(steps.sort(), ['decant_tank_stock:done', 'decant_tank_stock:running', 'open_app:done', 'open_app:running']);
  const second = client.calls[1];
  assert.equal(second.model, 'claude-opus-5-5');
  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[1].content[0].type, 'thinking');                // kept as sent
  const results = second.messages[2].content;
  assert.deepEqual(results.map((r) => r.tool_use_id), ['tu1', 'tu2']);         // one message, every result
  assert.equal(brain.history.length, 4);
});

test('Claude loop: a failed turn leaves no trace, so the built-in brain can take over', async () => {
  const brain = new Brain({ getClient: async () => fakeClient([Object.assign(new Error('Your credit balance is too low'), { status: 400 })]) });
  await assert.rejects(brain.turn([{ type: 'text', text: 'hi' }], ctx()), /credit balance/);
  assert.equal(brain.history.length, 0);
  assert.match(systemPrompt('2026-10-12'), /Today is 2026-10-12/);
});
