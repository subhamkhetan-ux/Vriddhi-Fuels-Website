// The Payments tab reads the /payments app's list (its own Supabase project,
// table pay_credit_queue) — read-only: the ledger never writes there, and the
// payments app carries on exactly as before (Log to Excel etc.).
// Pure functions: no DOM, no network.

import { serialToISO } from './util.js';

// Where an entry is in the payments app.
//   ready  — in "Ready to export"
//   queued — sent to the Mac agent, not logged yet
//   excel  — logged into Master Paid / exported
export function appState(r) {
  if (r.exported || r.logged_at) return 'excel';
  if (r.log_requested) return 'queued';
  return 'ready';
}

// pay_credit_queue rows -> { payments: [{ref, pay_date, customer, amount, mode, state}], review }
// Matched entries only (a payment still under "Needs review" has no customer
// yet); dropped ones are left out. Newest first.
export function fromQueue(rows) {
  const payments = [];
  let review = 0;
  const seen = new Set();
  for (const r of rows || []) {
    if (r.flags && r.flags.dropped) continue;
    if (r.status !== 'matched') {
      if (r.status === 'review' && !r.exported) review += 1;
      continue;
    }
    const ref = String(r.entry_id ?? '').trim();
    const payDate = serialToISO(Number(r.date_serial));
    const customer = String(r.customer ?? '').trim();
    const amount = Math.round(Number(r.amount) * 100) / 100;
    if (!ref || !payDate || !customer || !(amount > 0) || seen.has(ref)) continue;
    seen.add(ref);
    payments.push({ ref, pay_date: payDate, customer, amount, mode: String(r.mode ?? '').trim(), state: appState(r) });
  }
  payments.sort((a, b) => b.pay_date.localeCompare(a.pay_date) || a.customer.localeCompare(b.customer) || a.ref.localeCompare(b.ref));
  return { payments, review };
}
