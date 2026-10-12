// Payments (/payments/) — the bank credits the payment agent reads from the
// mails: the ones needing review, matching one to a customer, recording a
// payment by hand (cash, cheque…), and "Log to Excel" (the Mac agent then
// writes them into Master Paid). Same table and same updates as the payments
// app (supabase/payments-schema.sql). Plus Tally (/tally/): the vouchers.

import { bestMatch } from '../match.js';
import { signedIn } from '../session.js';
import { payClientFor, paymentsQueue } from './more.js';

const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const dmyOfSerial = (n) => { const d = new Date(Date.UTC(1899, 11, 30) + Number(n) * 86400000); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
const serialOf = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
const candNames = (r) => (r.candidates || []).map((c) => (typeof c === 'string' ? c : c?.name || c?.customer)).filter(Boolean);
const open = (r) => !r.exported && !(r.flags && r.flags.dropped);

async function customers(ctx) {
  if (ctx.demo) return ['Sample Roadlines', 'Example Infra', 'Demo Power Ltd', 'Fresh Traders', 'Twin Steel Ltd'];
  const { data, error } = await (await payClientFor()).from('pay_customers').select('name');
  if (error) return [];
  return (data || []).map((x) => x.name);
}

async function write(ctx, fn) {
  if (ctx.demo) return null;
  const { error } = await fn(await payClientFor());
  if (error) throw new Error(`The payments app didn't save it: ${error.message}`);
  return null;
}

async function review(input, ctx) {
  const rows = (await paymentsQueue(ctx)).filter((r) => r.status === 'review' && open(r));
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    summary: { count: rows.length, total: Math.round(total), credits: rows.slice(0, 30).map((r) => ({ ref: r.entry_id, date: r.date_str || dmyOfSerial(r.date_serial), amount: Number(r.amount), payer: r.raw_payer, maybe: candNames(r).slice(0, 4) })) },
    say: rows.length ? `${rows.length} credits (${rs(total)}) need review: ${rows.slice(0, 3).map((r) => `${rs(r.amount)} from ${r.raw_payer}${candNames(r).length ? ` (maybe ${candNames(r)[0]})` : ''}`).join(', ')}. Say e.g. "${rs(rows[0].amount).replace('₹', '')} is from ${candNames(rows[0])[0] || 'Customer'}".` : 'No credit needs review.',
    table: { columns: ['Date', 'Amount', 'Payer', 'Maybe'], rows: rows.slice(0, 40).map((r) => [r.date_str || dmyOfSerial(r.date_serial), rs(r.amount), r.raw_payer || '', candNames(r).slice(0, 2).join(' / ')]) },
    app: 'payments',
  };
}

async function matchCredit(input, ctx) {
  const rows = (await paymentsQueue(ctx)).filter((r) => r.status === 'review' && open(r));
  const amt = Number(input.amount);
  const hits = rows.filter((r) => Math.abs(Number(r.amount) - amt) < 1);
  if (!hits.length) return { summary: { error: `No credit of ${rs(amt)} is waiting for review.` }, say: `No credit of ${rs(amt)} is waiting for review.` };
  const names = [...new Set([...hits.flatMap(candNames), ...(await customers(ctx))])].map((name) => ({ name }));
  const { best, candidates } = bestMatch(input.customer || '', names);
  if (!best) return candidates.length ? { summary: { ambiguous: true }, say: `Which customer: ${candidates.map((c) => c.name).join(', ')}?`, choices: candidates.map((c) => ({ label: c.name, tool: 'payments_match', input: { ...input, customer: c.name } })) } : { summary: { error: `"${input.customer}" isn't in the payments app's customer list.` } };
  const r = hits[0];
  const ok = await ctx.confirm({ title: 'Match this credit?', rows: [[r.date_str || dmyOfSerial(r.date_serial), rs(r.amount), `${r.raw_payer || ''} → ${best.name}`]], notes: hits.length > 1 ? [`${hits.length} credits have this amount — matching the oldest.`] : [], ok: 'Match' });
  if (!ok) return { summary: { matched: false, declined_by_owner: true }, say: 'Not matched.' };
  if (ctx.demo) Object.assign(r, { status: 'matched', customer: best.name, match_tier: 'resolved' });
  await write(ctx, (c) => c.from('pay_credit_queue').update({ status: 'matched', customer: best.name, match_tier: 'resolved' }).eq('entry_id', r.entry_id));
  return { summary: { matched: true, amount: Number(r.amount), customer: best.name }, say: `${rs(r.amount)} from ${r.raw_payer || 'the bank'} is now ${best.name}'s payment.`, app: 'payments' };
}

async function logExcel(input, ctx) {
  const rows = (await paymentsQueue(ctx)).filter((r) => open(r) && r.status === 'matched' && !r.log_requested);
  if (!rows.length) return { summary: { queued: 0 }, say: 'Nothing is waiting to go to Excel.' };
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const ok = await ctx.confirm({
    title: `Send ${rows.length} payments (${rs(total)}) to Master Paid?`,
    rows: rows.slice(0, 10).map((r) => [r.date_str || dmyOfSerial(r.date_serial), r.customer, rs(r.amount)]),
    notes: [rows.length > 10 ? `…and ${rows.length - 10} more` : '', 'The Mac agent writes them into the Master Ledger.'],
    ok: 'Log to Excel',
  });
  if (!ok) return { summary: { queued: 0, declined_by_owner: true }, say: 'Not sent.' };
  const ids = rows.map((r) => r.entry_id);
  if (ctx.demo) rows.forEach((r) => { r.log_requested = true; });
  await write(ctx, (c) => c.from('pay_credit_queue').update({ log_requested: true, log_requested_at: new Date().toISOString() }).in('entry_id', ids));
  return { summary: { queued: rows.length, total: Math.round(total) }, say: `Sent ${rows.length} payments (${rs(total)}) to the Mac agent for Master Paid.`, app: 'payments' };
}

async function addPayment(input, ctx) {
  const amount = Number(input.amount);
  if (!(amount > 0)) return { summary: { error: 'What amount?' } };
  const names = (await customers(ctx)).map((name) => ({ name }));
  const { best, candidates } = bestMatch(input.customer || '', names);
  if (!best && candidates.length > 1) return { summary: { ambiguous: true }, say: `Which customer: ${candidates.map((c) => c.name).join(', ')}?`, choices: candidates.map((c) => ({ label: c.name, tool: 'payment_add', input: { ...input, customer: c.name } })) };
  const customer = best?.name || candidates[0]?.name || input.customer;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date : ctx.today;
  const mode = input.mode || 'Cash';
  const ok = await ctx.confirm({
    title: 'Record this payment in the payments app?',
    rows: [[date.split('-').reverse().join('/'), customer, rs(amount), mode]],
    notes: best ? [] : [`"${input.customer}" isn't in the payments app's customer list — it will be added as typed.`],
    ok: 'Record payment',
  });
  if (!ok) return { summary: { saved: false, declined_by_owner: true }, say: 'Not recorded.' };
  const serial = serialOf(date);
  const row = {
    entry_id: `man-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    account: 'manual', bank: '', mode, date_str: dmyOfSerial(serial), date_serial: serial,
    amount, raw_payer: customer, customer, candidates: [customer], match_tier: 'manual', status: 'matched', flags: {}, queued_at: new Date().toISOString(),
  };
  if (ctx.demo) (await paymentsQueue(ctx)).unshift(row);
  await write(ctx, (c) => c.from('pay_credit_queue').insert(row));
  return { summary: { saved: true, customer, amount, mode, date }, say: `Recorded ${rs(amount)} from ${customer} (${mode}). It's ready to log to Excel and the Ledger.`, app: 'payments' };
}

// ---- Tally (/tally/) -------------------------------------------------------------
const SERIES = { hsd: 'Diesel', ms: 'Petrol', xg: 'XtraGreen' };
async function vouchers(input, ctx) {
  const from = input.from || ctx.today;
  const to = input.to || from;
  let rows;
  if (ctx.demo) {
    rows = [
      { series: 'hsd', number: 'HSD1201', date: ctx.today, party: 'Sample Roadlines', qty: 200, item_amt: 17924, party_amt: 17924, status: 'pending' },
      { series: 'ms', number: 'MS319', date: ctx.today, party: 'Example Infra', qty: 49.5, item_amt: 5002, party_amt: 5002, status: 'exported' },
    ].filter((v) => v.date >= from && v.date <= to);
  } else {
    const c = await signedIn('tally', 'the Tally app');
    const { data, error } = await c.from('tally_vouchers').select('series,number,date,party,vehicle,qty,rate,item_amt,party_amt,status').gte('date', from).lte('date', to).order('date').limit(1000);
    if (error) throw new Error(error.message);
    rows = data || [];
  }
  const by = {};
  for (const v of rows) { const k = SERIES[v.series] || v.series; by[k] = by[k] || { vouchers: 0, litres: 0, amount: 0 }; by[k].vouchers += 1; by[k].litres += Number(v.qty) || 0; by[k].amount += Number(v.party_amt) || 0; }
  const pending = rows.filter((v) => v.status === 'pending').length;
  return {
    summary: { from, to, vouchers: rows.length, not_exported: pending, by_series: by, list: rows.slice(0, 40) },
    say: rows.length ? `${rows.length} Tally vouchers (${input.period_label || (from === to ? from : `${from} to ${to}`)}): ${Object.entries(by).map(([k, v]) => `${k} ${v.vouchers}`).join(', ')}; ${pending} not exported to Tally yet.` : 'No Tally vouchers in that period.',
    table: { columns: ['Voucher', 'Party', 'Litres', 'Amount', 'Status'], rows: rows.slice(0, 60).map((v) => [v.number, v.party, String(v.qty), rs(v.party_amt), v.status]) },
    app: 'tally',
  };
}

export const tools = [
  {
    name: 'payments_review', app: 'payments', label: () => 'Credits to review',
    description: 'Bank credits the payments app couldn\'t match to a customer, with the likely customers.',
    input_schema: { type: 'object', properties: {} }, run: review,
  },
  {
    name: 'payments_match', app: 'payments', label: (i) => `Match ${i.amount ? rs(i.amount) : 'credit'}`,
    description: 'Match a credit that needs review (found by its amount) to a customer, as the payments app\'s review does. The owner confirms first.',
    input_schema: { type: 'object', properties: { amount: { type: 'number' }, customer: { type: 'string' } }, required: ['amount', 'customer'] }, run: matchCredit,
  },
  {
    name: 'payments_log_excel', app: 'payments', label: () => 'Log to Excel',
    description: 'Send every matched payment not yet logged to the Mac agent, which writes them into Master Paid (the payments app\'s "Log to Excel"). The owner confirms first.',
    input_schema: { type: 'object', properties: {} }, run: logExcel,
  },
  {
    name: 'payment_add', app: 'payments', label: (i) => `Record payment · ${i.customer || ''}`,
    description: 'Record a payment received by hand (cash, cheque, UPI…) in the payments app, as its "+ Add" does: date (default today), customer, amount, mode. It is then ready to log to Excel and the Ledger. The owner confirms first.',
    input_schema: { type: 'object', properties: { customer: { type: 'string' }, amount: { type: 'number' }, mode: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['customer', 'amount'] }, run: addPayment,
  },
  {
    name: 'tally_vouchers', app: 'tally', label: () => 'Tally vouchers',
    description: 'Sales vouchers in the Tally voucher app for a day or period (default today): count, litres and amount per series (Diesel / Petrol / XtraGreen), and how many aren\'t exported to Tally yet.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, period_label: { type: 'string' } } }, run: vouchers,
  },
];
