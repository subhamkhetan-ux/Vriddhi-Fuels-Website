// Jarvis: finding who is meant, and quick commands (no AI).
import assert from 'node:assert/strict';
import test from 'node:test';

import { bestMatch, editDistance, score } from '../../jarvis/js/match.js';
import { HELP, parse } from '../../jarvis/js/quick.js';

const PEOPLE = ['Shyam Metalics and Energy Ltd', 'SMC Power Generation Ltd', 'Keshav Roadlines', 'Ember Coal', 'Shree Steel', 'Shiva Steel']
  .map((name) => ({ name }));
const who = (q) => bestMatch(q, PEOPLE).best?.name ?? null;

test('names: exact, initials, part, spoken slips', () => {
  assert.equal(who('keshav'), 'Keshav Roadlines');
  assert.equal(who('SMC'), 'SMC Power Generation Ltd');
  assert.equal(who('M/s Ember Coal'), 'Ember Coal');
  assert.equal(who('shyam metallics'), 'Shyam Metalics and Energy Ltd');   // voice typing
  assert.equal(who('shiv steel'), 'Shiva Steel');
  assert.equal(who('ember coal ka'), 'Ember Coal');                        // Hinglish
  assert.ok(score('keshav', 'Keshav Roadlines') > score('keshav', 'Ember Coal'));
  assert.equal(editDistance('metallics', 'metalics'), 1);
});

test('names: ambiguous or unknown asks instead of guessing', () => {
  const steel = bestMatch('steel', PEOPLE);
  assert.equal(steel.best, null);
  assert.deepEqual(steel.candidates.map((c) => c.name).sort(), ['Shiva Steel', 'Shree Steel']);
  assert.deepEqual(bestMatch('tata motors', PEOPLE), { best: null, candidates: [] });
});

test('quick: the owner\'s own phrasings', () => {
  const cases = {
    'get me the outstanding balance for all': ['ledger_outstanding', { segment: 'all' }],
    'outstanding of SMC Power please': ['ledger_outstanding', { customer: 'smc power' }],
    'SMC ka baki kitna hai': ['ledger_outstanding', { customer: 'smc' }],
    'Monitor XtraPower account Ember Coal': ['xtrapower_watch', { account: 'ember coal', watch: true }],
    'start monitoring shyam metalics': ['xtrapower_watch', { account: 'shyam metalics', watch: true }],
    'stop monitoring ember coal': ['xtrapower_watch', { account: 'ember coal', watch: false }],
    'stop xtrapower monitoring': ['xtrapower_monitor', { action: 'stop' }],
    'is xtrapower monitoring running?': ['xtrapower_status', {}],
    'sales yesterday': ['ledger_sales', { period: 'yesterday' }],
    'aaj ki sales': ['ledger_sales', { period: 'today' }],
    'statement of keshav': ['ledger_statement', { customer: 'keshav' }],
    'tank stock': ['decant_tank_stock', {}],
    'tank 2 stock 11,630': ['decant_set_stock', { tank_no: 2, litres: 11630 }],
    'tank 3 dip 120 cm': ['decant_set_stock', { tank_no: 3, dip_cm: 120 }],
    'trucks to decant': ['decant_trucks', {}],
    'fleet status': ['fleet_status', {}],
    'open decant app': ['open_app', { app: 'decant' }],
  };
  for (const [text, [tool, input]] of Object.entries(cases)) {
    assert.deepEqual(parse(text), { tool, input }, text);
  }
});

test('quick: a picture with stock words goes to Decant', () => {
  assert.deepEqual(parse('update stock', { attachments: ['att3'] }), { tool: 'decant_update_stock_from_photo', input: { attachment_id: 'att3' } });
  assert.deepEqual(parse('', { attachments: ['att1'] }), { tool: 'decant_update_stock_from_photo', input: { attachment_id: 'att1' } });
  assert.deepEqual(parse('help'), { help: true });
  assert.equal(parse('what is the meaning of life'), null);
  assert.ok(HELP.length > 5);
});
