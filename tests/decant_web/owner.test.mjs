// The owner's login (store.js): the app syncs for anyone with the link, signed
// in or not; only the Log and Reports tabs wait for the owner's login.
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

const { db, ctl, auth } = await import('./fixtures/mock-supabase.js');
const S = await import('../../decant/js/store.js');
ctl.latency = 5;
db.dec_invoices.set('INV1', { invoice_no: 'INV1', tt_no: 'OD01A0001', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });

test('without any login the app syncs as before; the owner tabs stay shut', async () => {
  await S.initStore();
  assert.equal(S.state.cloud, 'live');
  assert.equal(S.state.invoices.length, 1);
  assert.equal(S.state.owner.ok, false);
});

test('a wrong password, or a login that is not the owner\'s, does not open them', async () => {
  await assert.rejects(S.ownerSignIn('owner@example.com', 'nope'), /Wrong username or password/);
  await assert.rejects(S.ownerSignIn('ramesh', 'pw'), /ramesh@vriddhi.local isn't the owner's login.*dec_add_owner\('ramesh@vriddhi.local'\)/);
  assert.equal(auth.session, null);                                       // signed straight out again
  assert.equal(S.state.owner.ok, false);
});

test('the owner signs in (kept on the phone) and out', async () => {
  await S.ownerSignIn('Owner@example.com', 'pw');
  assert.deepEqual(S.state.owner, { email: 'owner@example.com', ok: true });
  assert.equal(localStorage.getItem('vriddhi-decant-owner'), 'owner@example.com');
  assert.equal(S.state.cloud, 'live');                                    // syncing all along
  await S.ownerSignOut();
  assert.equal(S.state.owner.ok, false);
  assert.equal(localStorage.getItem('vriddhi-decant-owner'), null);
  assert.equal(auth.session, null);
});
