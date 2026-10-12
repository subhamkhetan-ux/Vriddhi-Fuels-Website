// Fleet (/fleet/) — Shree Shyam Fleet's bulkers, from the latest Trip Register
// in the Fleet app, with the Fleet app's own analysis (fleet/js/analyse.js).

import { dieselRecon, fleetStatus, inPeriod, periods as fleetPeriods, ssfcAccount, totals, vehiclesOf } from '../../../fleet/js/analyse.js';
import { demoData } from '../../../fleet/js/demo.js';
import { memoryStore, supabaseStore } from '../../../fleet/js/store.js';
import { bestMatch } from '../match.js';
import { signedIn } from '../session.js';

const rs = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const L = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-IN')} L`;
const T = (n) => `${(Math.round((Number(n) || 0) * 10) / 10).toLocaleString('en-IN')} T`;
const dmy = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');

let demo = null;
let cache = null;
export async function register(ctx) {
  if (cache && cache.demo === ctx.demo && Date.now() - cache.at < 5 * 60000) return cache;
  const store = ctx.demo ? (demo || (demo = memoryStore(demoData(ctx.today)))) : supabaseStore(await signedIn('fleet'));
  const [latest, settings] = await Promise.all([store.latest(), store.settings().catch(() => null)]);
  if (!latest) { const e = new Error('No Trip Register is in the Fleet app yet.'); e.empty = true; throw e; }
  cache = { demo: ctx.demo, at: Date.now(), data: latest.payload, settings: settings?.value || null };
  return cache;
}

// a month range (yyyy-mm) from Jarvis's dates
const months = (input, today) => {
  if (input.from) return { from: input.from.slice(0, 7), to: (input.to || today).slice(0, 7), label: input.period_label || `${input.from.slice(0, 7)} – ${(input.to || today).slice(0, 7)}` };
  return { ...fleetPeriods(today).month, label: 'This month' };
};

async function status(input, ctx) {
  const { data } = await register(ctx);
  const st = fleetStatus(data, ctx.today);
  const t = totals(data.trips.filter((x) => inPeriod(x, fleetPeriods(ctx.today).month)));
  const on = st.filter((s) => s.state !== 'idle');
  return {
    summary: {
      register_updated_until: data.latest || null,
      vehicles: st.map((s) => ({ vehicle: s.veh, state: s.state, where: s.long, days: s.days })),
      this_month: { trips: t.trips, unloaded: t.done, tonnes: Math.round(t.tonnes), freight: Math.round(t.bhada), diesel_litres: Math.round(t.dieselL), income: Math.round(t.income), short_trips: t.shortTrips },
    },
    say: `${on.length} of ${st.length} bulkers on the road (${st.filter((s) => s.state === 'loaded').length} loaded). This month: ${t.trips} trips, ${T(t.tonnes)}, freight ${rs(t.bhada)}.`,
    table: { columns: ['Bulker', 'Now', 'Days'], rows: st.map((s) => [s.veh, s.text, s.days == null ? '' : String(s.days)]) },
    app: 'fleet',
  };
}

function pickVehicle(data, said) {
  const list = vehiclesOf(data).map((name) => ({ name, names: [name, name.slice(-4)] }));
  return bestMatch(String(said || ''), list, (x) => x.names);
}

async function vehicle(input, ctx) {
  const { data, settings } = await register(ctx);
  const { best, candidates } = pickVehicle(data, input.vehicle);
  if (!best) return candidates.length ? { summary: { ambiguous: true }, say: `Which bulker: ${candidates.map((c) => c.name).join(', ')}?`, choices: candidates.map((c) => ({ label: c.name, tool: 'fleet_vehicle', input: { vehicle: c.name } })) } : { summary: { error: `No bulker "${input.vehicle}". Bulkers: ${vehiclesOf(data).join(', ')}` } };
  const veh = best.name;
  const now = fleetStatus(data, ctx.today).find((s) => s.veh === veh);
  const mine = data.trips.filter((t) => t.veh === veh);
  const month = totals(mine.filter((t) => inPeriod(t, fleetPeriods(ctx.today).month)));
  const fy = totals(mine.filter((t) => inPeriod(t, fleetPeriods(ctx.today).fy)));
  const recon = dieselRecon(data, settings).vehicles.find((v) => v.veh === veh);
  const recent = [...mine].sort((a, b) => b.row - a.row).slice(0, 6);
  return {
    summary: {
      vehicle: veh, now: now?.long, days: now?.days,
      this_month: { trips: month.trips, tonnes: Math.round(month.tonnes), freight: Math.round(month.bhada), income: Math.round(month.income) },
      this_fy: { trips: fy.trips, tonnes: Math.round(fy.tonnes), freight: Math.round(fy.bhada), income: Math.round(fy.income), short_trips: fy.shortTrips },
      diesel_balance_litres: recon ? Math.round(recon.balance) : null,
      recent_trips: recent.map((t) => ({ start: t.start, route: `${t.port || '?'} → ${t.dest || '?'}`, loaded_t: t.loadWt, unloaded: t.unloadDate, short_t: t.diff })),
    },
    say: `${veh}: ${now?.long || 'no trip yet'}${now?.days != null ? ` (${now.days} days)` : ''}. This month ${month.trips} trips, ${T(month.tonnes)}, freight ${rs(month.bhada)}.${recon ? ` Diesel ${recon.balance >= 0 ? 'balance' : 'over-drawn'} ${L(Math.abs(recon.balance))}.` : ''}`,
    table: { columns: ['Started', 'Route', 'Loaded', 'Unloaded'], rows: recent.map((t) => [dmy(t.start), `${t.port || '?'} → ${t.dest || '?'}`, t.loadWt ? T(t.loadWt) : '—', t.unloadDate ? dmy(t.unloadDate) : 'on the way']) },
    app: 'fleet',
  };
}

async function diesel(input, ctx) {
  const { data, settings } = await register(ctx);
  const r = dieselRecon(data, settings);
  let list = r.vehicles;
  if (input.vehicle) {
    const { best } = pickVehicle(data, input.vehicle);
    if (best) list = list.filter((v) => v.veh === best.name);
  }
  return {
    summary: { since: r.since, total_balance_litres: Math.round(r.total), note: 'Balance = diesel allotted for the trips − diesel taken; negative = taken more than allotted.', vehicles: list.map((v) => ({ vehicle: v.veh, allotted: Math.round(v.allotted), taken: Math.round(v.issued), balance: Math.round(v.balance) })) },
    say: list.length === 1 ? `${list[0].veh}: allotted ${L(list[0].allotted)}, taken ${L(list[0].issued)}, ${list[0].balance >= 0 ? 'balance' : 'over by'} ${L(Math.abs(list[0].balance))}.`
      : `Diesel recon since ${dmy(r.since)}: fleet balance ${L(r.total)}. Over-drawn: ${list.filter((v) => v.balance < 0).map((v) => `${v.veh} ${L(-v.balance)}`).join(', ') || 'none'}.`,
    table: { columns: ['Bulker', 'Allotted', 'Taken', 'Balance'], rows: list.map((v) => [v.veh, L(v.allotted), L(v.issued), L(v.balance)]) },
    app: 'fleet',
  };
}

async function ssfc(input, ctx) {
  const { data } = await register(ctx);
  const a = ssfcAccount(data.ssfc, ctx.today);
  if (!a) return { summary: { error: 'The Trip Register has no SSFC sheet.' } };
  const keep = Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, Math.round(v)]));
  return {
    summary: { ...keep },
    say: `SSFC account: balance in account ${rs(a.account)}, balance in cash ${rs(a.cash)}, net hire ${rs(a.net)}, paid ${rs(a.paid)}.`,
    app: 'fleet',
  };
}

async function trips(input, ctx) {
  const { data } = await register(ctx);
  const per = months(input, ctx.today);
  let list = data.trips.filter((t) => inPeriod(t, per));
  let veh = null;
  if (input.vehicle) {
    const { best } = pickVehicle(data, input.vehicle);
    if (best) { veh = best.name; list = list.filter((t) => t.veh === veh); }
  }
  const t = totals(list);
  const byVeh = vehiclesOf(data).map((v) => ({ v, t: totals(list.filter((x) => x.veh === v)) })).filter((x) => x.t.trips);
  return {
    summary: { period: per.label, vehicle: veh, trips: t.trips, unloaded: t.done, tonnes: Math.round(t.tonnes), delivered: Math.round(t.delivered), shortage_t: Math.round(t.short * 100) / 100, freight: Math.round(t.bhada), ssfc_deductions: Math.round(t.ssfcDed), own_expenses: Math.round(t.own), emi: Math.round(t.emi), income: Math.round(t.income), diesel_litres: Math.round(t.dieselL), avg_days: t.days },
    say: `${per.label}${veh ? `, ${veh}` : ''}: ${t.trips} trips (${t.done} unloaded), ${T(t.tonnes)}, freight ${rs(t.bhada)}, income ${rs(t.income)}${t.shortTrips ? `, ${t.shortTrips} short trips` : ''}.`,
    table: veh ? null : { columns: ['Bulker', 'Trips', 'Tonnes', 'Freight'], rows: byVeh.map((x) => [x.v, String(x.t.trips), T(x.t.tonnes), rs(x.t.bhada)]) },
    app: 'fleet',
  };
}

// names for the sentence reader
export async function lexicon(ctx) {
  try { const { data } = await register(ctx); return vehiclesOf(data).map((name) => ({ name, names: [name, name.slice(-4)] })); } catch { return []; }
}

const V = { type: 'string', description: 'Bulker number, or its last 4 digits.' };
export const tools = [
  {
    name: 'fleet_status', app: 'fleet', label: () => 'Fleet status',
    description: 'Shree Shyam Fleet (bulkers on contract with SSFC), from the Fleet app\'s latest Trip Register: where each bulker is (loaded / going to load / idle, for how many days) and this month\'s trips, tonnes, freight and diesel.',
    input_schema: { type: 'object', properties: {} }, run: status,
  },
  {
    name: 'fleet_vehicle', app: 'fleet', label: (i) => `Bulker ${i.vehicle || ''}`,
    description: 'One bulker: where it is now, this month\'s and this FY\'s trips, tonnes, freight and income, its diesel balance and its recent trips.',
    input_schema: { type: 'object', properties: { vehicle: V }, required: ['vehicle'] }, run: vehicle,
  },
  {
    name: 'fleet_diesel', app: 'fleet', label: () => 'Fleet diesel recon',
    description: 'Diesel recon: per bulker, diesel allotted for its trips vs taken, and the balance (negative = took more than allotted).',
    input_schema: { type: 'object', properties: { vehicle: V } }, run: diesel,
  },
  {
    name: 'fleet_ssfc', app: 'fleet', label: () => 'SSFC account',
    description: 'The SSFC (SS Freight Carrier) account: balance in account and in cash, hire billed, net and paid.',
    input_schema: { type: 'object', properties: {} }, run: ssfc,
  },
  {
    name: 'fleet_trips', app: 'fleet', label: (i) => `Trips · ${i.period_label || 'this month'}`,
    description: 'Trips in a period (by month; default this month), for the fleet or one bulker: trips, tonnes loaded / delivered, shortage, freight, SSFC deductions, own expenses, EMI, income, diesel.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, period_label: { type: 'string' }, vehicle: V } }, run: trips,
  },
];
