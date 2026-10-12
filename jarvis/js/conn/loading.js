// Loading (/loading/) — our diesel delivery tankers: how full each is, add a
// loading, "sent for sale", the trips. The Loading app's own SQL functions
// (supabase/loading-schema.sql) with the staff login it uses.

import { bestMatch } from '../match.js';
import { session, signedIn } from '../session.js';

const L = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-IN')} L`;
const sum = (o) => Object.values(o || {}).reduce((a, x) => a + (Number(x) || 0), 0);

// ---- the data: the Loading app's database, or a made-up one for the demo ----------
const demo = {
  vehicles: [
    { plate: 'OD23A3710', caps: [3985, 3985, 3985], fill: { C1: 3985, C2: 2100 } },
    { plate: 'OR15R1110', caps: [3985, 3985, 3985], fill: {} },
    { plate: 'OR15R9360', caps: [4485, 4485, 4485, 4485], fill: { C1: 4485, C2: 4485, C3: 4485, C4: 4485 } },
  ],
  trips: [],
};

async function api(ctx) {
  if (ctx.demo) {
    return {
      vehicles: async () => demo.vehicles.map((v) => ({ ...v, fill: { ...v.fill } })),
      add: async (plate, chambers, total) => {
        const v = demo.vehicles.find((x) => x.plate === plate);
        for (const c of chambers) v.fill[c.name] = (v.fill[c.name] || 0) + c.qty;
        return 'demo';
      },
      dispatch: async (plate, remark) => {
        const v = demo.vehicles.find((x) => x.plate === plate);
        demo.trips.push({ ts: new Date().toISOString(), plate, total: sum(v.fill), dest: remark, by: 'demo' });
        v.fill = {};
      },
      trips: async (from, to) => demo.trips.filter((t) => t.ts.slice(0, 10) >= from && t.ts.slice(0, 10) <= to),
      me: 'demo',
    };
  }
  const c = await signedIn('loading', 'the Loading app');
  const rpc = async (fn, args) => { const { data, error } = await c.rpc(fn, args); if (error) throw new Error(error.message); return data; };
  const s = await session('loading');
  const me = String(s?.user?.email || '').split('@')[0];
  return {
    vehicles: async () => {
      const { data, error } = await c.from('loading_vehicles').select('plate,caps,fill').order('plate', { ascending: true });
      if (error) throw new Error(error.message);
      return (data || []).map((v) => ({ plate: v.plate, caps: (v.caps || []).map(Number), fill: v.fill || {} }));
    },
    add: (plate, chambers, total) => rpc('loading_add', { p_vehicle: plate, p_chambers: chambers, p_total: total, p_by: me, p_kind: 'load', p_remark: '' }),
    dispatch: (plate, remark) => rpc('loading_dispatch', { p_vehicle: plate, p_by: me, p_remark: remark || '' }),
    trips: async (from, to) => {
      const { data, error } = await c.from('loading_trips').select('*').gte('created_at', `${from}T00:00:00+05:30`).lte('created_at', `${to}T23:59:59+05:30`).order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      return (data || []).map((t) => ({ ts: t.created_at, plate: t.vehicle, total: Number(t.total) || 0, dest: t.dest || '', by: t.by_name || '' }));
    },
    me,
  };
}

const state = (v) => {
  const cap = v.caps.reduce((a, c) => a + c, 0);
  const fill = sum(v.fill);
  return { tanker: v.plate, capacity: cap, filled: Math.round(fill), left: Math.round(cap - fill), full: fill >= cap - 1,
    chambers: v.caps.map((c, i) => ({ chamber: `C${i + 1}`, capacity: c, filled: Math.round(Number(v.fill[`C${i + 1}`] ?? v.fill[i]) || 0) })) };
};

function pick(vehicles, said, tool, input) {
  const list = vehicles.map((v) => ({ name: v.plate, names: [v.plate, v.plate.slice(-4)] }));
  const { best, candidates } = bestMatch(String(said || ''), list, (x) => x.names);
  if (best) return { plate: best.name };
  return {
    ask: {
      summary: { ambiguous: true, tankers: vehicles.map((v) => v.plate) },
      say: `Which tanker: ${(candidates.length ? candidates : list).map((c) => c.name).join(', ')}?`,
      choices: (candidates.length ? candidates : list).map((c) => ({ label: c.name, tool, input: { ...input, tanker: c.name } })),
    },
  };
}

async function tankers(input, ctx) {
  const a = await api(ctx);
  const rows = (await a.vehicles()).map(state);
  return {
    summary: { tankers: rows.map(({ chambers, ...r }) => r) },
    say: rows.map((r) => `${r.tanker}: ${r.full ? 'FULL' : `${L(r.filled)} of ${L(r.capacity)}`}`).join('. ') + '.',
    table: { columns: ['Tanker', 'Filled', 'Left to fill'], rows: rows.map((r) => [r.tanker, `${L(r.filled)}${r.full ? ' ✓' : ''}`, L(r.left)]) },
    app: 'loading',
  };
}

async function add(input, ctx) {
  const a = await api(ctx);
  const vehicles = await a.vehicles();
  const p = pick(vehicles, input.tanker, 'loading_add', input);
  if (p.ask) return p.ask;
  const v = vehicles.find((x) => x.plate === p.plate);
  const st = state(v);
  let litres = Number(input.litres);
  if (!(litres > 0)) return { summary: { error: 'How many litres?' } };
  if (litres > st.left + 0.5) return { summary: { error: `${v.plate} has only ${L(st.left)} left to fill.` }, say: `${v.plate} has only ${L(st.left)} left to fill.` };
  // the chamber named, or the chambers in order as they have room
  const chambers = [];
  if (input.chamber) {
    const c = st.chambers[input.chamber - 1];
    if (!c) return { summary: { error: `${v.plate} has chambers C1–C${st.chambers.length}.` } };
    if (litres > c.capacity - c.filled + 0.5) return { summary: { error: `C${input.chamber} has only ${L(c.capacity - c.filled)} of room.` }, say: `C${input.chamber} of ${v.plate} has only ${L(c.capacity - c.filled)} of room.` };
    chambers.push({ name: c.chamber, qty: litres });
  } else {
    for (const c of st.chambers) {
      if (litres <= 0) break;
      const room = c.capacity - c.filled;
      if (room <= 0) continue;
      const q = Math.min(room, litres);
      chambers.push({ name: c.chamber, qty: Math.round(q * 100) / 100 });
      litres -= q;
    }
  }
  const total = chambers.reduce((s, c) => s + c.qty, 0);
  const ok = await ctx.confirm({ title: `Add this loading to ${v.plate}?`, rows: chambers.map((c) => [c.name, L(c.qty)]), notes: [`After this: ${L(st.filled + total)} of ${L(st.capacity)}`], ok: 'Save loading' });
  if (!ok) return { summary: { saved: false, declined_by_owner: true }, say: 'Not saved.' };
  await a.add(v.plate, chambers, total);
  return { summary: { saved: true, tanker: v.plate, added: total, now: st.filled + total, capacity: st.capacity }, say: `Added ${L(total)} to ${v.plate} (${chambers.map((c) => `${c.name} ${L(c.qty)}`).join(', ')}). Now ${L(st.filled + total)} of ${L(st.capacity)}.`, app: 'loading' };
}

async function dispatch(input, ctx) {
  const a = await api(ctx);
  const vehicles = await a.vehicles();
  const p = pick(vehicles, input.tanker, 'loading_dispatch', input);
  if (p.ask) return p.ask;
  const st = state(vehicles.find((x) => x.plate === p.plate));
  if (!st.filled) return { summary: { error: `${p.plate} is empty.` }, say: `${p.plate} is empty — nothing to send.` };
  const ok = await ctx.confirm({ title: `${p.plate} sent for sale?`, rows: [[p.plate, L(st.filled), input.customer ? `to ${input.customer}` : 'customer not given']], notes: ['The tanker empties back to 0 in the Loading app.'], ok: 'Sent for sale' });
  if (!ok) return { summary: { saved: false, declined_by_owner: true }, say: 'Not changed.' };
  await a.dispatch(p.plate, input.customer || '');
  return { summary: { dispatched: true, tanker: p.plate, litres: st.filled, customer: input.customer || null }, say: `${p.plate} sent for sale with ${L(st.filled)}${input.customer ? ` to ${input.customer}` : ''}.`, app: 'loading' };
}

async function trips(input, ctx) {
  const a = await api(ctx);
  const from = input.from || new Date(Date.parse(`${ctx.today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const to = input.to || ctx.today;
  const list = await a.trips(from, to);
  const total = list.reduce((s, t) => s + t.total, 0);
  return {
    summary: { from, to, trips: list.length, litres: Math.round(total), list: list.slice(-40) },
    say: list.length ? `${list.length} tanker trips, ${L(total)} (${input.period_label || `${from} to ${to}`}).` : 'No tanker trips in that period (the Loading app keeps about a week).',
    table: { columns: ['When', 'Tanker', 'Litres', 'To'], rows: list.slice(-60).map((t) => [new Date(t.ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), t.plate, L(t.total), t.dest]) },
    app: 'loading',
  };
}

export async function lexicon(ctx) {
  try { return (await (await api(ctx)).vehicles()).map((v) => ({ name: v.plate, names: [v.plate, v.plate.slice(-4)] })); } catch { return []; }
}

const TANKER = { type: 'string', description: 'Tanker number, or its last 4 digits.' };
export const tools = [
  {
    name: 'loading_tankers', app: 'loading', label: () => 'Delivery tankers',
    description: 'Our own diesel delivery tankers from the Loading app: how full each is, chamber by chamber, and how much is left to fill.',
    input_schema: { type: 'object', properties: {} }, run: tankers,
  },
  {
    name: 'loading_add', app: 'loading', label: (i) => `Load ${i.tanker || 'tanker'}`,
    description: 'Record diesel loaded into a delivery tanker (into one chamber, or chambers in order as they have room), as the Loading app\'s "Add diesel". The owner confirms first.',
    input_schema: { type: 'object', properties: { tanker: TANKER, litres: { type: 'number' }, chamber: { type: 'integer' } }, required: ['tanker', 'litres'] }, run: add,
  },
  {
    name: 'loading_dispatch', app: 'loading', label: (i) => `${i.tanker || 'Tanker'} sent for sale`,
    description: 'Mark a full delivery tanker "Sent for sale" (optionally to a customer); it empties back to 0. The owner confirms first.',
    input_schema: { type: 'object', properties: { tanker: TANKER, customer: { type: 'string' } }, required: ['tanker'] }, run: dispatch,
  },
  {
    name: 'loading_trips', app: 'loading', label: () => 'Tanker trips',
    description: 'Delivery tanker trips (sent for sale) in a period, default the last 7 days: tanker, litres, customer.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, period_label: { type: 'string' } } }, run: trips,
  },
];
