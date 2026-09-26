// Payments tab: the /payments app's list (pay_credit_queue), read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { fromQueue } from '../../ledger/js/payin.js';
import { memoryStore } from '../../ledger/js/store.js';

const serial = (iso) => Math.round((Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86400000);

test('the payments app list: matched entries with where they are there', () => {
  const got = fromQueue([
    { entry_id: 'hdfc:1', status: 'matched', customer: 'Sample Roadlines', amount: 25000, mode: 'HDFC', date_serial: serial('2026-09-25'), exported: false },
    { entry_id: 'hdfc:2', status: 'matched', customer: 'Example Infra', amount: 1200.5, mode: 'UPI', date_serial: serial('2026-09-25'), log_requested: true },
    { entry_id: 'hdfc:3', status: 'matched', customer: 'Sample Roadlines', amount: 9000, mode: 'Cash', date_serial: serial('2026-09-24'), exported: true, logged_at: 'x' },
    { entry_id: 'hdfc:4', status: 'review', raw_payer: 'SOMEONE', amount: 700, date_serial: serial('2026-09-25') },
    { entry_id: 'hdfc:5', status: 'matched', customer: 'Walk In', amount: 100, date_serial: serial('2026-09-25'), exported: true, flags: { dropped: true } },
    { entry_id: 'hdfc:1', status: 'matched', customer: 'Twice', amount: 1, date_serial: serial('2026-09-25') },
    { entry_id: 'bad', status: 'matched', customer: 'X', amount: 0, date_serial: serial('2026-09-25') },
  ]);
  assert.equal(got.review, 1);
  assert.deepEqual(got.payments.map((r) => [r.ref, r.pay_date, r.customer, r.amount, r.state]), [
    ['hdfc:2', '2026-09-25', 'Example Infra', 1200.5, 'queued'],
    ['hdfc:1', '2026-09-25', 'Sample Roadlines', 25000, 'ready'],
    ['hdfc:3', '2026-09-24', 'Sample Roadlines', 9000, 'excel'],
  ]);
});

test('the payments app itself is not touched by the ledger', () => {
  // the ledger only ever reads pay_credit_queue — no insert/update/upsert/delete/rpc on it
  const src = fs.readFileSync(new URL('../../ledger/js/app.js', import.meta.url), 'utf8');
  const uses = [...src.matchAll(/payClient[^;]*/g)].map((m) => m[0]).join('\n');
  assert.ok(uses.includes(".from('pay_credit_queue').select('*')"));
  assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(uses), uses);
});

test('ledger side: check, log once, and Excel takes over at the next upload', async () => {
  const store = memoryStore({});
  await store.importMaster('ML.xlsm', {
    customers: [{ name: 'Sample Roadlines', ledger: 'Sample' }],
    payments: [{ pay_date: '2026-09-24', customer: 'Sample Roadlines', amount: 9000, mode: 'Cash', seq: 2 }],
  });
  const rows = [
    { ref: 'hdfc:3', pay_date: '2026-09-24', customer: 'Sample Roadlines', amount: 9000, mode: 'Cash' },
    { ref: 'hdfc:1', pay_date: '2026-09-25', customer: 'sample roadlines', amount: 25000, mode: 'HDFC' },
    { ref: 'man:6', pay_date: '2026-09-26', customer: 'Unknown Co', amount: 5000, mode: 'Cheque' },
  ];
  assert.deepEqual((await store.appPaymentsCheck(rows)).map((c) => [c.ref, c.state, c.known]),
    [['hdfc:3', 'in_excel', true], ['hdfc:1', 'new', true], ['man:6', 'new', false]]);
  assert.equal((await store.appPaymentsLog(rows.slice(1))).added, 2);
  assert.equal((await store.appPaymentsLog(rows.slice(1))).added, 0);            // same entries: once only
  assert.equal((await store.appPaymentsCheck(rows))[1].state, 'logged');
  // they count in the balance straight away
  const bal = async () => (await store.statementData('2026-09-27', '2026-09-27')).customers[0].opening;
  assert.equal(await bal(), -9000 - 25000);
  // Excel logs hdfc:1 (the name spelt as in Master Paid); the next upload drops the app's copy
  const res = await store.importMaster('ML2.xlsm', {
    customers: [{ name: 'Sample Roadlines', ledger: 'Sample' }],
    payments: [{ pay_date: '2026-09-24', customer: 'Sample Roadlines', amount: 9000, seq: 2 },
      { pay_date: '2026-09-25', customer: 'Sample Roadlines', amount: 25000, seq: 3 }],
  });
  assert.deepEqual([res.app_payments_in_excel, res.app_payments_open], [1, 1]);
  assert.equal(await bal(), -9000 - 25000);                                          // counted once
  const left = await store.appPaymentsList();
  assert.deepEqual(left.map((p) => p.ref), ['man:6']);
  await store.appPaymentsDelete(left[0].id);
  assert.deepEqual(await store.appPaymentsList(), []);
});
