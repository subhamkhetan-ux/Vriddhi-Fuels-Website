// Payments (credits matched from the bank mails, read-only here — money.js
// does the writes) and links to open any app.

import { demoSeed } from '../../../ledger/js/demo.js';
import { fromQueue } from '../../../ledger/js/payin.js';
import { bestMatch } from '../match.js';
import { SUPABASE_JS } from '../session.js';

const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const L = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-IN')} L`;

// ---- Payments (the payments app's matched credits) ------------------------------------
let payClient = null;
export async function payClientFor() {
  const cfg = window.VRIDDHI_PAYMENTS_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) throw new Error('The payments app isn\'t set up (payments/config.js).');
  if (!payClient) {
    const { createClient } = await import(SUPABASE_JS);
    payClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'vriddhi-payments-readonly' } });
  }
  return payClient;
}
// the payments app's queue (pay_credit_queue), raw rows
let demoQueue = null;
export async function paymentsQueue(ctx) {
  if (ctx.demo) return demoQueue || (demoQueue = demoSeed().payQueue.map((r) => ({ ...r })));
  const { data, error } = await (await payClientFor()).from('pay_credit_queue').select('*').order('date_serial', { ascending: false }).limit(2000);
  if (error) throw new Error(`Couldn't read the payments app: ${error.message}`);
  return data || [];
}
// matched payments ({payments, review}) the Ledger app's way
export async function paymentsRows(ctx) {
  return fromQueue(await paymentsQueue(ctx));
}
async function payments(input, ctx) {
  const rows = await paymentsQueue(ctx);
  const days = Math.max(1, Math.min(Number(input.days) || 3, 31));
  const since = new Date(Date.parse(`${ctx.today}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const { payments: all, review } = fromQueue(rows);
  let list = all.filter((p) => p.pay_date >= since);
  if (input.customer) {
    const names = [...new Set(list.map((p) => p.customer))].map((name) => ({ name }));
    const { best } = bestMatch(input.customer, names);
    list = best ? list.filter((p) => p.customer === best.name) : [];
  }
  const total = list.reduce((a, p) => a + p.amount, 0);
  return {
    summary: {
      since, total: Math.round(total), count: list.length, needs_review: review,
      payments: list.slice(0, 25).map((p) => ({ date: p.pay_date, customer: p.customer, amount: p.amount, mode: p.mode, status: { ready: 'ready to log', queued: 'queued for Excel', excel: 'in Excel' }[p.state] })),
    },
    say: list.length ? `${list.length} payments since ${since}, ${rs(total)}: ${list.slice(0, 4).map((p) => `${p.customer} ${rs(p.amount)}`).join(', ')}${list.length > 4 ? '…' : ''}.` : `No payments since ${since}.`,
    app: 'payments',
  };
}

// ---- the apps -------------------------------------------------------------------------
export const APPS = [
  { key: 'ledger', name: 'Ledger', icon: '📒', href: '../ledger/', what: 'Master Ledger: sales, outstanding, statements, bills, POs', aka: ['master ledger', 'outstanding', 'khata'] },
  { key: 'decant', name: 'Decant', icon: '⛽', href: '../decant/', what: 'Tanker decanting, tank stock, variation', aka: ['decanting', 'tanks', 'stock'] },
  { key: 'fleet', name: 'Fleet', icon: '🚛', href: '../fleet/', what: 'Shree Shyam Fleet trip register, bulkers, diesel', aka: ['trip register', 'bulkers', 'shree shyam'] },
  { key: 'payments', name: 'Payments', icon: '💳', href: '../payments/', what: 'Bank credits matched to customers, log to Excel', aka: ['credits', 'bank'] },
  { key: 'indents', name: 'Indents', icon: '🧾', href: '../app/', what: 'Customer fuel indents and deliveries', aka: ['indent', 'orders', 'indent app'] },
  { key: 'loading', name: 'Loading', icon: '🛢️', href: '../loading/', what: 'Delivery tanker loading log', aka: ['tanker loading', 'tankers'] },
  { key: 'pay', name: 'Payment entry', icon: '✍️', href: '../pay/', what: 'Type payments, export to Master Paid', aka: ['payment entry', 'pay'] },
  { key: 'tanker', name: 'Tanker billing', icon: '🧮', href: '../tanker/', what: 'Tanker bills', aka: ['tanker bill', 'billing'] },
  { key: 'tally', name: 'Tally vouchers', icon: '📑', href: '../tally/', what: 'Tally voucher app', aka: ['tally', 'vouchers'] },
  { key: 'tally-tools', name: 'Tally import tools', icon: '🔁', href: '../tally-tools/', what: 'Bank / IOCL / fleet card statements to Tally', aka: ['bank to tally', 'iocl', 'fleet card'] },
];

async function openApp(input) {
  const { best, candidates } = bestMatch(input.app || '', APPS, (a) => [a.name, a.key, ...a.aka]);
  if (!best) {
    return { summary: { found: false, apps: (candidates.length ? candidates : APPS).map((a) => a.name) }, say: `Which app? ${(candidates.length ? candidates : APPS).map((a) => a.name).join(', ')}.` };
  }
  return { summary: { opened_link_for: best.name }, say: `Here's the ${best.name} app.`, links: [{ href: best.href, label: `${best.icon} Open ${best.name}` }] };
}

export const tools = [
  {
    name: 'payments_recent',
    app: 'payments',
    label: (i) => `Payments${i.customer ? ` · ${i.customer}` : ''}`,
    description: 'Customer payments (bank credits) the payments app matched from the bank mails, for the last few days, with whether each is logged to Excel yet. needs_review = credits not matched to a customer yet.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 31 }, customer: { type: 'string' } } },
    run: payments,
  },
  {
    name: 'open_app',
    app: 'apps',
    label: (i) => `Open ${i.app}`,
    description: `Give the owner a button to open one of the apps: ${APPS.map((a) => `${a.name} (${a.what})`).join('; ')}.`,
    input_schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
    run: openApp,
  },
];
