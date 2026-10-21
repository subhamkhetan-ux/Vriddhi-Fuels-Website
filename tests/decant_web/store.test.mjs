// The decant app's cloud sync (store.js) against an in-memory stand-in for
// Supabase (fixtures/mock-supabase.js): a phone's save must never undo work
// the tank stock agent or another phone saved meanwhile, nor lose its own.
import assert from 'node:assert/strict';
import test from 'node:test';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.window = { VRIDDHI_DECANT_CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' }, addEventListener() {} };
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
globalThis.indexedDB = { deleteDatabase() {} };
const realInterval = globalThis.setInterval;
globalThis.setInterval = (f, ms) => { const h = realInterval(f, ms); h.unref?.(); return h; };
globalThis.DECANT_TEST_SUPABASE_JS = new URL('./fixtures/mock-supabase.js', import.meta.url).href;

const { db, ctl } = await import('./fixtures/mock-supabase.js');
const S = await import('../../decant/js/store.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
ctl.latency = 5;
await S.initStore();
const replaced = [];
S.onSessionReplaced((id) => replaced.push(id));

async function pulled(row) {
  db.dec_sessions.set(row.id, structuredClone(row));
  S.refreshNow();
  await sleep(150);
  return S.state.sessions.find((x) => x.id === row.id);
}

test('two quick saves on a slow signal both reach the cloud', async () => {
  const local = await pulled({ id: 'S-1', invoice_no: 'I1', status: 'draft', data: { notes: '' }, created_at: ago(9e4), updated_at: ago(6e4) });
  ctl.latency = 400;
  local.data.checks = { a: 1 };
  const p1 = S.saveSession(local);
  await sleep(500);
  local.data.notes = 'second field';
  const p2 = S.saveSession(local);
  await Promise.all([p1, p2]);
  await sleep(1200);
  ctl.latency = 5;
  assert.equal(db.dec_sessions.get('S-1').data.notes, 'second field');
  assert.deepEqual(db.dec_sessions.get('S-1').data.checks, { a: 1 });
  assert.ok(!replaced.includes('S-1'));
});

test("a failed version check never sends the phone's old copy over the agent's", async () => {
  const local = await pulled({ id: 'S-2', invoice_no: 'I2', status: 'decanting', data: { who: 'phone' }, created_at: ago(9e4), updated_at: ago(6e4) });
  db.dec_sessions.set('S-2', { ...db.dec_sessions.get('S-2'), status: 'settling', data: { who: 'agent' }, updated_at: ago(1000) });
  ctl.fail = (t, op) => (t === 'dec_sessions' && op === 'select' ? { message: 'TypeError: Failed to fetch' } : null);
  local.data.notes = 'typed on the phone';
  await S.saveSession(local);
  ctl.fail = null;
  assert.equal(db.dec_sessions.get('S-2').data.who, 'agent');          // untouched
  assert.ok(S.state.outbox.some((o) => o.key === 'S-2'));               // kept to try again
  await S.flushOutbox();                                                  // signal back: the agent's stays, shown here
  assert.equal(db.dec_sessions.get('S-2').data.who, 'agent');
  assert.ok(replaced.includes('S-2'));
});

test('a row the cloud refuses for good does not hold up the rest', async () => {
  ctl.fail = () => ({ message: 'TypeError: Failed to fetch' });
  await S.saveInvoice({ invoice_no: 'M-1', density15: 'eight hundred', lines: [] });
  await S.saveSession({ id: 'S-9', invoice_no: 'X', status: 'decanting', data: { tanks: [] } });
  ctl.fail = (t, op, row) => (t === 'dec_invoices' && op === 'upsert' && row && Number.isNaN(Number(row.density15))
    ? { code: '22P02', message: 'invalid input syntax for type numeric' } : null);
  await S.flushOutbox();
  ctl.fail = null;
  assert.ok(db.dec_sessions.has('S-9'));                                // the decantation went
  assert.ok(S.state.outbox.some((o) => o.key === 'M-1'));               // the refused one is kept, not lost
});
