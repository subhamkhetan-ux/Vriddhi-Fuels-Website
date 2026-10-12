// The other apps: Fleet (bulkers on the road), Loading (our delivery tankers'
// fill), Payments (credits matched from the bank mails), and links to open
// any app. Each reads its own app's data with that app's own code and login.

import { fleetStatus, inPeriod, periods as fleetPeriods, totals } from '../../../fleet/js/analyse.js';
import { demoData as fleetDemo } from '../../../fleet/js/demo.js';
import { memoryStore as fleetMemory, supabaseStore as fleetStore } from '../../../fleet/js/store.js';
import { demoSeed } from '../../../ledger/js/demo.js';
import { fromQueue } from '../../../ledger/js/payin.js';
import { bestMatch } from '../match.js';
import { SUPABASE_JS, signedIn } from '../session.js';

const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const L = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-IN')} L`;

// ---- Fleet --------------------------------------------------------------------------
let fleetDemoStore = null;
async function fleet(input, ctx) {
  const store = ctx.demo ? (fleetDemoStore || (fleetDemoStore = fleetMemory(fleetDemo(ctx.today)))) : fleetStore(await signedIn('fleet', 'the Fleet'));
  const latest = await store.latest();
  if (!latest) return { summary: { error: 'No Trip Register uploaded to the Fleet app yet.' }, say: 'No Trip Register is in the Fleet app yet.' };
  const d = latest.payload;
  const status = fleetStatus(d, ctx.today);
  const t = totals(d.trips.filter((x) => inPeriod(x, fleetPeriods(ctx.today).month)));
  const on = status.filter((s) => s.state !== 'idle');
  return {
    summary: {
      register_updated_until: d.latest || null,
      on_the_road: status.map((s) => ({ vehicle: s.veh, state: s.state, where: s.long, days: s.days })),
      this_month: { trips: t.trips, unloaded: t.done, tonnes: Math.round(t.tonnes), freight: Math.round(t.bhada), diesel_litres: Math.round(t.dieselL), income: Math.round(t.income), short_trips: t.shortTrips },
    },
    say: `${on.length} of ${status.length} bulkers on the road (${status.filter((s) => s.state === 'loaded').length} loaded). This month: ${t.trips} trips, ${Math.round(t.tonnes)} T, freight ${rs(t.bhada)}.`,
    app: 'fleet',
  };
}

// ---- Loading (our delivery tankers) ---------------------------------------------------
async function loading(input, ctx) {
  let vehicles;
  if (ctx.demo) {
    vehicles = [
      { plate: 'OD23A3710', caps: [3985, 3985, 3985], fill: { 0: 3985, 1: 2100 } },
      { plate: 'OR15R1110', caps: [3985, 3985, 3985], fill: {} },
      { plate: 'OR15R9360', caps: [4485, 4485, 4485, 4485], fill: { 0: 4485, 1: 4485, 2: 4485, 3: 4485 } },
    ];
  } else {
    const t = await import('../../../decant/js/tankers.js');
    await t.initTankers();
    if (t.tankers.status === 'signin') {
      const err = new Error('Not signed in to the Loading app. Open ⚙ Settings → Logins → Loading (a Loading-app username + password).');
      err.needsLogin = 'loading';
      throw err;
    }
    if (t.tankers.status !== 'live') throw new Error(t.tankers.error || 'The Loading app isn\'t reachable.');
    vehicles = t.tankers.vehicles;
  }
  const rows = vehicles.map((v) => {
    const cap = v.caps.reduce((a, c) => a + c, 0);
    const fill = Object.values(v.fill || {}).reduce((a, x) => a + (Number(x) || 0), 0);
    return { tanker: v.plate, capacity: cap, filled: Math.round(fill), left_to_fill: Math.round(cap - fill), full: fill >= cap - 1 };
  });
  return {
    summary: { tankers: rows },
    say: rows.map((r) => `${r.tanker}: ${r.full ? 'FULL' : `${L(r.filled)} of ${L(r.capacity)}`}`).join('. ') + '.',
    app: 'loading',
  };
}

// ---- Payments (the payments app's matched credits) ------------------------------------
let payClient = null;
async function payments(input, ctx) {
  let rows;
  if (ctx.demo) rows = demoSeed().payQueue;
  else {
    const cfg = window.VRIDDHI_PAYMENTS_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) throw new Error('The payments app isn\'t set up (payments/config.js).');
    if (!payClient) {
      const { createClient } = await import(SUPABASE_JS);
      payClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'vriddhi-payments-readonly' } });
    }
    const { data, error } = await payClient.from('pay_credit_queue').select('*').order('date_serial', { ascending: false }).limit(500);
    if (error) throw new Error(`Couldn't read the payments app: ${error.message}`);
    rows = data || [];
  }
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
  { key: 'indents', name: 'Indents', icon: '🧾', href: '../app/', what: 'Customer fuel indents and deliveries', aka: ['indent', 'orders', 'app'] },
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
    name: 'fleet_status',
    app: 'fleet',
    label: () => 'Fleet status',
    description: 'Shree Shyam Fleet (the bulkers on contract with SSFC), from the Fleet app\'s latest Trip Register: where each bulker is (loaded / going to load / idle) and this month\'s trips, tonnes, freight and diesel.',
    input_schema: { type: 'object', properties: {} },
    run: fleet,
  },
  {
    name: 'loading_tankers',
    app: 'loading',
    label: () => 'Delivery tankers',
    description: 'Our own diesel delivery tankers from the Loading app: how full each is and how much is left to fill.',
    input_schema: { type: 'object', properties: {} },
    run: loading,
  },
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
