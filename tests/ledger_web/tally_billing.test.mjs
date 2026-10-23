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
