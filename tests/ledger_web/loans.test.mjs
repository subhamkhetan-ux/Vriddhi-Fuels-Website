// Loans & EMI in the ledger app: kept per loan (demo store = ledger_loans in
// SQL), the fleet app's reading of the schedules. Made-up loans.
import assert from 'node:assert/strict';
import test from 'node:test';

import { loanFromTerms, loansSummary } from '../../fleet/js/loans.js';
import { demoSeed } from '../../ledger/js/demo.js';
import { memoryStore } from '../../ledger/js/store.js';

const loan = (over = {}) => {
  const l = loanFromTerms({ veh: 'OD01T1111', bank: 'HDFC', lan: 'L-1', amount: 120000, emi: 11000, tenure: 12, first: '2026-01-05', rate: 9, ...over });
  delete l.warnings; delete l.first; delete l.last;
  return { ...l, kind: 'truck', note: '' };
};

test('loans: save, mark an EMI not paid and paid again, replace, rename, remove', async () => {
  const store = memoryStore();
  assert.deepEqual(await store.loans(), []);
  await store.saveLoan(loan());
  await store.saveLoan({ ...loan({ veh: 'OD01C2222', lan: 'L-2', bank: 'Toyota Financial' }), kind: 'car', note: 'Demo car' });
  let all = await store.loans();
  assert.deepEqual(all.map((l) => [l.lan, l.veh, l.kind, l.rows.length, l.unpaid]), [['L-2', 'OD01C2222', 'car', 12, []], ['L-1', 'OD01T1111', 'truck', 12, []]]);
  assert.deepEqual(await store.markLoan('L-1', 3, true), [3]);
  assert.deepEqual(await store.markLoan('L-1', 1, true), [1, 3]);
  assert.deepEqual(await store.markLoan('L-1', 3, false), [1]);
  // the schedule again (a new copy from the bank): the EMIs marked not paid stay
  await store.saveLoan({ ...loan({ emi: 11050 }), note: 'Tanker' });
  all = await store.loans();
  const one = all.find((l) => l.lan === 'L-1');
  assert.deepEqual([one.emi, one.note, one.unpaid], [11050, 'Tanker', [1]]);
  // its account no. typed wrong: renamed, still not-paid #1
  await store.saveLoan({ ...one, lan: 'L-1A' }, null, 'L-1');
  assert.deepEqual((await store.loans()).map((l) => [l.lan, l.unpaid]), [['L-2', []], ['L-1A', [1]]]);
  await assert.rejects(store.saveLoan({ ...one, lan: 'L-2' }, null, 'L-1A'), /already saved/);
  await assert.rejects(store.saveLoan({ ...one, lan: '' }), /account/);
  await assert.rejects(store.saveLoan({ ...one, rows: [] }), /no EMIs/);
  await assert.rejects(store.markLoan('nope', 1, true), /No loan/);
  await store.deleteLoan('L-2');
  assert.deepEqual((await store.loans()).map((l) => l.lan), ['L-1A']);
  await assert.rejects(store.deleteLoan('L-2'), /No loan/);
});

test('demo: an own tanker truck and a car, the car\'s last EMI due marked not paid', async () => {
  const today = new Date('2026-11-11T10:00:00');
  const store = memoryStore(demoSeed(today));
  const loans = await store.loans();
  assert.deepEqual(loans.map((l) => l.kind).sort(), ['car', 'truck']);
  const L = loansSummary(loans, '2026-11-11');
  const car = L.loans.find((x) => x.loan.kind === 'car');
  assert.equal(car.overdueN, 1);
  assert.equal(L.loans.find((x) => x.loan.kind === 'truck').overdueN, 0);
  assert.ok(L.total.principalLeft > 0 && L.total.principalLeft < L.total.amount);
});
