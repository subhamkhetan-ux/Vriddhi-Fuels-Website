// Indents (/app/) — customers' fuel orders: the live board, placing an indent
// on a customer's behalf (they approve it in their app), delivering (full or
// partial), cancelling, and the day's prices. The Indents app's own SQL
// functions (supabase/schema.sql), with an owner (admin) login.

import { bestMatch } from '../match.js';
import { signedIn } from '../session.js';

const rs = (n) => `₹${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN')}`;
const L = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-IN')} L`;
const PRODUCTS = ['Diesel', 'Petrol', 'XtraGreen'];
const productOf = (s) => PRODUCTS.find((p) => p.toLowerCase() === String(s || '').toLowerCase())
  || { hsd: 'Diesel', ms: 'Petrol', xg: 'XtraGreen' }[String(s || '').toLowerCase()] || null;
const qty = (i) => (i.order_type === 'Litres' ? L(i.value) : rs(i.value));

// ---- the data -----------------------------------------------------------------------
const demo = {
  seq: 3,
  users: [{ id: 'u1', name: 'Sample Roadlines', role: 'customer' }, { id: 'u2', name: 'Example Infra', role: 'customer' }, { id: 'u3', name: 'Demo Power Ltd', role: 'customer' }],
  prices: { Diesel: 89.62, Petrol: 101.05, XtraGreen: 90.1 },
  indents: [
    { id: 'i1', code: 'IND-0001', customer_id: 'u1', vehicle_no: 'OD02AB1234', product: 'Diesel', order_type: 'Litres', value: 200, status: 'Pending', created_at: new Date().toISOString() },
    { id: 'i2', code: 'IND-0002', customer_id: 'u2', vehicle_no: 'OD05CD5678', product: 'Petrol', order_type: 'Amount', value: 5000, status: 'Pending', created_at: new Date().toISOString() },
    { id: 'i3', code: 'IND-0003', customer_id: 'u3', vehicle_no: '', product: 'Diesel', order_type: 'Litres', value: 1500, status: 'Awaiting', created_at: new Date().toISOString() },
  ],
};

async function api(ctx) {
  if (ctx.demo) {
    return {
      users: async () => demo.users,
      indents: async () => demo.indents.map((i) => ({ ...i })),
      prices: async () => PRODUCTS.map((p) => ({ product: p, price: demo.prices[p] })),
      place: async (a) => { demo.seq += 1; const r = { id: `i${demo.seq}`, code: `IND-${String(demo.seq).padStart(4, '0')}`, customer_id: a.p_customer, vehicle_no: a.p_vehicle || '', product: a.p_product, order_type: a.p_order_type, value: a.p_value, status: 'Awaiting', created_at: new Date().toISOString() }; demo.indents.unshift(r); return r; },
      deliver: async (id) => { const r = demo.indents.find((i) => i.id === id); r.status = 'Delivered'; return r; },
      cancel: async (id) => { const r = demo.indents.find((i) => i.id === id); r.status = 'Cancelled'; return r; },
      setPrice: async (p, v) => { demo.prices[p] = v; },
    };
  }
  const c = await signedIn('indents', 'the Indents app');
  const rpc = async (fn, args) => { const { data, error } = await c.rpc(fn, args); if (error) throw new Error(error.message); return data; };
  return {
    users: async () => { const { data, error } = await c.from('app_users').select('id,name,username,role,is_blocked,is_active'); if (error) throw new Error(error.message); return data || []; },
    indents: async () => { const { data, error } = await c.from('indents').select('*').order('created_at', { ascending: false }).limit(500); if (error) throw new Error(error.message); return data || []; },
    prices: () => rpc('current_prices', {}),
    place: (a) => rpc('place_indent', a),
    deliver: (id, d) => rpc('deliver_indent', { p_id: id, p_delivered: d ?? null }),
    cancel: (id) => rpc('cancel_indent', { p_id: id }),
    setPrice: (p, v) => rpc('set_price', { p_product: p, p_price: v }),
  };
}

const istDay = (t) => new Date(new Date(t).getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

async function list(input, ctx) {
  const a = await api(ctx);
  const [users, all] = await Promise.all([a.users(), a.indents()]);
  const name = new Map(users.map((u) => [u.id, u.name]));
  let rows = all;
  if (input.status) rows = rows.filter((i) => i.status === input.status);
  else rows = rows.filter((i) => i.status === 'Pending' || i.status === 'Awaiting' || (input.from && istDay(i.created_at) >= input.from));
  if (input.from) rows = rows.filter((i) => istDay(i.created_at) >= input.from && istDay(i.created_at) <= (input.to || ctx.today));
  if (input.customer) {
    const { best } = bestMatch(input.customer, users.filter((u) => u.role === 'customer'), (u) => [u.name, u.username].filter(Boolean));
    rows = best ? rows.filter((i) => i.customer_id === best.id) : [];
  }
  const by = (s) => rows.filter((i) => i.status === s).length;
  return {
    summary: { count: rows.length, pending: by('Pending'), awaiting_customer: by('Awaiting'), delivered: by('Delivered'), indents: rows.slice(0, 40).map((i) => ({ code: i.code, customer: name.get(i.customer_id), product: i.product, order: qty(i), vehicle: i.vehicle_no, status: i.status, at: i.created_at })) },
    say: rows.length ? `${rows.length} indents${input.status ? ` (${input.status.toLowerCase()})` : ''}: ${rows.slice(0, 4).map((i) => `${i.code} ${name.get(i.customer_id)} ${i.product} ${qty(i)}`).join(', ')}${rows.length > 4 ? '…' : ''}.` : 'No indents waiting.',
    table: { columns: ['Indent', 'Customer', 'Order', 'Status'], rows: rows.slice(0, 60).map((i) => [i.code, name.get(i.customer_id) || '', `${i.product} ${qty(i)}${i.vehicle_no ? ` · ${i.vehicle_no}` : ''}`, i.status]) },
    app: 'indents',
  };
}

async function place(input, ctx) {
  const a = await api(ctx);
  const users = (await a.users()).filter((u) => u.role === 'customer' && u.is_active !== false);
  const { best, candidates } = bestMatch(input.customer || '', users, (u) => [u.name, u.username].filter(Boolean));
  if (!best) {
    return candidates.length
      ? { summary: { ambiguous: true }, say: `Which customer: ${candidates.map((c) => c.name).join(', ')}?`, choices: candidates.map((c) => ({ label: c.name, tool: 'indent_place', input: { ...input, customer: c.name } })) }
      : { summary: { error: `No Indents-app customer matches "${input.customer}".` } };
  }
  const product = productOf(input.product);
  if (!product) return { summary: { error: 'Which product: Diesel, Petrol or XtraGreen?' } };
  const byLitres = Number(input.litres) > 0;
  const value = byLitres ? Number(input.litres) : Number(input.amount);
  if (!(value > 0)) return { summary: { error: 'How many litres (or what amount)?' } };
  const ok = await ctx.confirm({ title: `Place this indent for ${best.name}?`, rows: [[product, byLitres ? L(value) : rs(value), input.vehicle || 'no vehicle']], notes: ['It goes to the customer to approve (logged on their behalf).'], ok: 'Place indent' });
  if (!ok) return { summary: { placed: false, declined_by_owner: true }, say: 'Not placed.' };
  const r = await a.place({ p_vehicle: input.vehicle || null, p_product: product, p_order_type: byLitres ? 'Litres' : 'Amount', p_value: value, p_customer: best.id });
  return { summary: { placed: true, indent: r.code, customer: best.name, status: r.status }, say: `Placed ${r.code} for ${best.name}: ${product} ${byLitres ? L(value) : rs(value)}. It's waiting for their approval.`, app: 'indents' };
}

async function byCode(a, code) {
  const all = await a.indents();
  const c = String(code || '').toUpperCase().replace(/^IND-?/, '');
  return all.find((i) => i.code.replace(/^IND-?/, '').replace(/^0+/, '') === c.replace(/^0+/, ''));
}

async function deliver(input, ctx) {
  const a = await api(ctx);
  const i = await byCode(a, input.indent);
  if (!i) return { summary: { error: `No indent ${input.indent}.` } };
  if (i.status !== 'Pending') return { summary: { error: `${i.code} is ${i.status.toLowerCase()}, not pending.` }, say: `${i.code} is ${i.status.toLowerCase()} — only pending indents can be delivered.` };
  const part = Number(input.delivered) > 0 && Number(input.delivered) < Number(i.value) ? Number(input.delivered) : null;
  const ok = await ctx.confirm({ title: `Mark ${i.code} delivered?`, rows: [[i.product, part ? `${i.order_type === 'Litres' ? L(part) : rs(part)} of ${qty(i)} (partial)` : qty(i), i.vehicle_no || '']], ok: 'Delivered' });
  if (!ok) return { summary: { delivered: false, declined_by_owner: true }, say: 'Not changed.' };
  await a.deliver(i.id, part);
  return { summary: { delivered: true, indent: i.code, partial: Boolean(part) }, say: `${i.code} marked delivered${part ? ' (partial)' : ''}; the invoice is made and the customer is asked to acknowledge it.`, app: 'indents' };
}

async function cancel(input, ctx) {
  const a = await api(ctx);
  const i = await byCode(a, input.indent);
  if (!i) return { summary: { error: `No indent ${input.indent}.` } };
  const ok = await ctx.confirm({ title: `Cancel ${i.code}?`, rows: [[i.product, qty(i), i.status]], ok: 'Cancel indent' });
  if (!ok) return { summary: { cancelled: false, declined_by_owner: true }, say: 'Not changed.' };
  await a.cancel(i.id);
  return { summary: { cancelled: true, indent: i.code }, say: `${i.code} cancelled.`, app: 'indents' };
}

async function prices(input, ctx) {
  const a = await api(ctx);
  const list = await a.prices();
  return {
    summary: { prices: list },
    say: `Today's prices: ${list.filter((p) => p.price).map((p) => `${p.product} ${rs(p.price)}`).join(', ')}.`,
    app: 'indents',
  };
}

async function setPrice(input, ctx) {
  const a = await api(ctx);
  const product = productOf(input.product);
  const price = Number(input.price);
  if (!product || !(price > 0)) return { summary: { error: 'Which product and what price?' } };
  const ok = await ctx.confirm({ title: `Set today's ${product} price?`, rows: [[product, `${rs(price)} / L`]], notes: ['Used for indents and invoices from today.'], ok: 'Set price' });
  if (!ok) return { summary: { saved: false, declined_by_owner: true }, say: 'Not changed.' };
  await a.setPrice(product, price);
  return { summary: { saved: true, product, price }, say: `${product} is now ${rs(price)} a litre in the Indents app.`, app: 'indents' };
}

const CODE = { type: 'string', description: 'Indent number, e.g. IND-0123' };
export const tools = [
  {
    name: 'indents_list', app: 'indents', label: () => 'Indents',
    description: 'Customers\' fuel indents from the Indents app: by default those pending delivery or awaiting the customer\'s approval; or by status / period / customer.',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['Pending', 'Awaiting', 'Delivered', 'Cancelled'] }, customer: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } }, run: list,
  },
  {
    name: 'indent_place', app: 'indents', label: (i) => `New indent · ${i.customer || ''}`,
    description: 'Place an indent on a customer\'s behalf (it then waits for their approval): product, litres or an amount, optional vehicle. The owner confirms first.',
    input_schema: { type: 'object', properties: { customer: { type: 'string' }, product: { type: 'string', enum: PRODUCTS }, litres: { type: 'number' }, amount: { type: 'number' }, vehicle: { type: 'string' } }, required: ['customer', 'product'] }, run: place,
  },
  {
    name: 'indent_deliver', app: 'indents', label: (i) => `Deliver ${i.indent || ''}`,
    description: 'Mark a pending indent delivered — fully, or partly with the litres / amount actually delivered. The owner confirms first.',
    input_schema: { type: 'object', properties: { indent: CODE, delivered: { type: 'number' } }, required: ['indent'] }, run: deliver,
  },
  {
    name: 'indent_cancel', app: 'indents', label: (i) => `Cancel ${i.indent || ''}`,
    description: 'Cancel an indent. The owner confirms first.',
    input_schema: { type: 'object', properties: { indent: CODE }, required: ['indent'] }, run: cancel,
  },
  {
    name: 'prices', app: 'indents', label: () => 'Today\'s prices',
    description: 'Today\'s prices per litre in the Indents app (used for indents and invoices).',
    input_schema: { type: 'object', properties: {} }, run: prices,
  },
  {
    name: 'price_set', app: 'indents', label: (i) => `Set ${i.product || ''} price`,
    description: 'Set today\'s price per litre of a product in the Indents app. The owner confirms first.',
    input_schema: { type: 'object', properties: { product: { type: 'string', enum: PRODUCTS }, price: { type: 'number' } }, required: ['product', 'price'] }, run: setPrice,
  },
];
