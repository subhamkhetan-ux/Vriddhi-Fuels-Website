// Jarvis's built-in brain (no AI): conversations, choices, several requests, typos.
import assert from 'node:assert/strict';
import test from 'node:test';

import { correct, newMemory, remember, understand } from '../../jarvis/js/engine.js';

// play a conversation: each turn's calls are "answered" by `answer` and remembered
function conversation(turns, answer = () => ({ summary: {} })) {
  let memory = newMemory();
  return turns.map(([text, opts = {}]) => {
    const u = understand(text, { memory, ...opts });
    for (const c of u.calls || []) memory = remember(memory, c, answer(c));
    return u;
  });
}

test('follow-ups about a customer use the name the ledger matched', () => {
  const [, his, about, bare] = conversation([
    ['outstanding of keshav'], ['his statement'], ['and SMC?'], ['statement'],
  ], (c) => ({ summary: { customer: c.input.customer === 'keshav' ? 'Keshav Roadlines' : 'SMC Power Ltd' } }));
  assert.deepEqual(his.calls, [{ tool: 'ledger_statement', input: { customer: 'Keshav Roadlines' } }]);
  assert.deepEqual(about.calls, [{ tool: 'ledger_statement', input: { customer: 'smc' } }]);
  assert.deepEqual(bare.calls, [{ tool: 'ledger_statement', input: { customer: 'SMC Power Ltd' } }]);
});

test('follow-ups about a period', () => {
  const [, y, lm] = conversation([['sales today'], ['and yesterday?'], ['last month']]);
  assert.deepEqual(y.calls, [{ tool: 'ledger_sales', input: { period: 'yesterday' } }]);
  assert.deepEqual(lm.calls, [{ tool: 'ledger_sales', input: { period: 'last_month' } }]);
});

test('"stop it" stops the account just started', () => {
  const [, stop] = conversation([['Monitor XtraPower account Ember Coal'], ['stop it']],
    () => ({ summary: { account: 'Ember Coal' } }));
  assert.deepEqual(stop.calls, [{ tool: 'xtrapower_watch', input: { account: 'Ember Coal', watch: false } }]);
});

test('picking one of the choices offered', () => {
  const choices = ['Shree Steel', 'Shiva Steel'].map((label) => ({ label, tool: 'ledger_outstanding', input: { customer: label } }));
  for (const [said, who] of [['the second one', 'Shiva Steel'], ['2', 'Shiva Steel'], ['first', 'Shree Steel'], ['shiva', 'Shiva Steel']]) {
    assert.deepEqual(understand(said, { choices }).calls, [{ tool: 'ledger_outstanding', input: { customer: who } }], said);
  }
});

test('several requests at once — but a name with "and" stays one', () => {
  assert.deepEqual(understand('tank stock and sales today').calls.map((c) => c.tool), ['decant_tank_stock', 'ledger_sales']);
  assert.deepEqual(understand('tankk stok and fleet status').calls.map((c) => c.tool), ['decant_tank_stock', 'fleet_status']);
  assert.deepEqual(understand('outstanding of shyam metalics and energy').calls,
    [{ tool: 'ledger_outstanding', input: { customer: 'shyam metalics and energy' } }]);
});

test('spelling slips in command words are corrected; names are not touched', () => {
  assert.equal(correct('show me the ballance list'), 'show me the balance list');
  assert.equal(correct('xtrapowr status'), 'xtrapower status');
  assert.equal(correct('Salem Traders'), 'Salem Traders');
  assert.equal(understand('salem').calls[0].input.customer, 'salem');               // a name, not "sales"
  assert.equal(correct('outstnding of keshav'), 'outstanding of keshav');
  const u = understand('tankk stok');
  assert.deepEqual(u.calls, [{ tool: 'decant_tank_stock', input: {} }]);
  assert.equal(u.corrected, 'tank stock');
});

test('a bare name is tried as a customer; anything else says so', () => {
  const crew = understand('crew');
  assert.equal(crew.guess, true);
  assert.deepEqual(crew.calls, [{ tool: 'ledger_outstanding', input: { customer: 'crew' } }]);
  const weather = understand('what is the weather today in delhi');
  assert.equal(weather.calls, undefined);
  assert.deepEqual(understand('help'), { help: true });
});
