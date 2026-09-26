// The app calls the database only through supabaseStore(); every call must
// name a real ledger_* function and pass its parameters by their exact
// names, or Supabase answers "function not found".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../../supabase/ledger-schema.sql', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../ledger/js/store.js', import.meta.url), 'utf8');

function sqlFunctions() {
  const out = new Map();
  const re = /create or replace function public\.(ledger_\w+)\(([^)]*)\)/g;
  for (const [, name, params] of sql.matchAll(re)) {
    const list = params.split(',').map((p) => p.trim()).filter(Boolean).map((p) => ({
      name: p.split(/\s+/)[0],
      optional: /\bdefault\b/i.test(p),
    }));
    out.set(name, list);
  }
  return out;
}

function jsCalls() {
  const supa = js.slice(js.indexOf('export function supabaseStore'), js.indexOf('export function memoryStore'));
  return [...supa.matchAll(/rpc\('(\w+)'(?:,\s*\{([^}]*)\})?\)/g)].map(([, name, args]) => ({
    name,
    keys: (args || '').split(',').map((a) => a.split(':')[0].trim()).filter(Boolean),
  }));
}

test('every rpc names a real function with its exact parameters', () => {
  const fns = sqlFunctions();
  const calls = jsCalls();
  assert.ok(calls.length >= 14, `found only ${calls.length} rpc calls`);
  for (const call of calls) {
    assert.ok(fns.has(call.name), `${call.name} is not in ledger-schema.sql`);
    const params = fns.get(call.name);
    const names = params.map((p) => p.name);
    for (const k of call.keys) assert.ok(names.includes(k), `${call.name}: unknown parameter ${k}`);
    for (const p of params) {
      if (!p.optional) assert.ok(call.keys.includes(p.name), `${call.name}: missing ${p.name}`);
    }
  }
});

test('the SQL-editor-only functions are not callable by the app', () => {
  const names = jsCalls().map((c) => c.name);
  assert.ok(!names.includes('ledger_add_member'));
  assert.ok(!names.includes('ledger_remove_member'));
  assert.match(sql, /if f\.proname in \('ledger_add_member', 'ledger_remove_member'\) then\s+execute format\('revoke all on function %s from authenticated'/);
});
