// The tanker bill's customer matching (tally/billing.js): a company billed
// unit-wise, as SMC Power's UNIT I and UNIT II, offers only its own units.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
require('../../tally/billing.js');
const B = globalThis.VFBilling;

const customer = company => ({ company, address: [], payment: [] });
const DATA = { customers: [
  customer('Demo Power Generation LTD, UNIT I'), customer('Demo Power Generation LTD, UNIT II'),
  customer('Sample Logistics Private Limited'), customer('Sample Logistics Pvt Ltd Haulage'),
  customer('Other Steel Ltd, Unit 1'),
] };

test('a unit written any way is the same unit', () => {
  assert.equal(B.unitOf('Demo Power Generation LTD, UNIT II'), '2');
  assert.equal(B.unitOf('demo power generation ltd unit-2'), '2');
  assert.equal(B.unitOf('Unit 1'), '1');
  assert.equal(B.unitOf('Sample Logistics'), '');
  assert.equal(B.findCustomer(DATA, 'DEMO POWER GENERATION LIMITED UNIT 2').company, 'Demo Power Generation LTD, UNIT II');
});

test('a company without its unit offers only its units', () => {
  assert.equal(B.findCustomer(DATA, 'Demo Power Generation Ltd'), null);
  const family = B.unitFamily(DATA, 'Demo Power Generation Limited');
  assert.deepEqual(family.map(c => c.company), ['Demo Power Generation LTD, UNIT I', 'Demo Power Generation LTD, UNIT II']);
  assert.deepEqual(B.unitFamily(DATA, 'Demo Power Generation LTD, UNIT II').map(c => c.company), family.map(c => c.company));
  assert.equal(B.customerForUnit(family, 'UNIT 2').company, 'Demo Power Generation LTD, UNIT II');
  assert.equal(B.customerForUnit(family, '1').company, 'Demo Power Generation LTD, UNIT I');
  assert.equal(B.customerForUnit(family, ''), null);
});

test('customers that are not billed unit-wise keep the whole list', () => {
  assert.deepEqual(B.unitFamily(DATA, 'Sample Logistics Private Limited'), []);
  assert.deepEqual(B.unitFamily(DATA, 'Other Steel Ltd'), []);  // one unit on the sheet is not a choice
  assert.equal(B.findCustomer(DATA, 'Sample Logistics Pvt Ltd').company, 'Sample Logistics Private Limited');
});

test('customer details come from the Ledger’s Tanker Master, never the Tanker Billing workbook', async () => {
  const store = new Map([['vf_tally_billing_v1', '{"customers":[{"company":"From the workbook"}]}']]);
  globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k) };
  globalThis.fetch = () => { throw new Error('nothing is fetched'); };
  const rows = [customer('Demo Power Generation LTD, UNIT I')];
  let answer = { status: 'ok', customers: rows, updatedAt: '2026-10-24T05:00:00Z' };
  globalThis.VFLedgerPO = { tankerMaster: () => answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) };

  const d = await B.load(true);
  assert.equal(d.status, 'ok');
  assert.deepEqual(d.customers.map(c => c.company), ['Demo Power Generation LTD, UNIT I']);
  assert.equal(d.generated_at, '2026-10-24T05:00:00Z');
  assert.ok(!store.has('vf_tally_billing_v1'));  // the workbook's old copy is dropped

  // Ledger unreachable: the copy last read on this device, marked as such.
  answer = new Error('offline');
  const offline = await B.load(true);
  assert.equal(offline.status, 'offline');
  assert.equal(offline.customers[0].company, 'Demo Power Generation LTD, UNIT I');

  // Not connected: no customers (nothing from a cached copy either), and signing out forgets it.
  answer = { status: 'signed-out' };
  assert.deepEqual((await B.load(true)).customers, []);
  B.forget();
  answer = new Error('offline');
  await assert.rejects(B.load(true));
  delete globalThis.VFLedgerPO;
  assert.equal((await B.load(true)).status, 'not-configured');
  assert.equal(B.sheetRate(null, { hsd_rate: '101.5' }, B.HSD), 101.5);
  assert.equal(B.sheetRate(null, { hsd_rate: 101.5 }, 'Motor Spirit'), null);
});
