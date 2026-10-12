// Across the apps:
//   business_brief  "good morning" / "how's business": yesterday's sales, what
//                   is owed, tank stock and trucks waiting, payments, indents,
//                   the fleet, the tankers and XtraPower — each from its app
//   customer_360    "tell me everything about SMC": the customer in every app
// Each part runs the app's own tool; a part that isn't available (not signed
// in, Mac offline) is left out with a note.

import { addDays } from '../nlu.js';

let registry = null;                         // set by tools.js (avoids a circular import)
let isOn = () => true;
export const useRegistry = (map, on) => { registry = map; if (on) isOn = on; };
const call = async (name, input, ctx) => {
  if (!isOn(name)) return { ok: false, off: true };
  const t = registry.get(name);
  const quiet = { ...ctx, progress: () => {}, confirm: async () => false };
  try { return { ok: true, r: await t.run(input, quiet) }; } catch (e) { return { ok: false, error: e.message, needsLogin: e.needsLogin }; }
};

async function brief(input, ctx) {
  const day = input.from && input.from === input.to ? input.from : addDays(ctx.today, -1);
  ctx.progress('Checking every app…');
  const parts = await Promise.all([
    call('ledger_sales', { from: day, to: day, period_label: day === addDays(ctx.today, -1) ? 'Yesterday' : day }, ctx),
    call('ledger_outstanding', { picture: false }, ctx),
    call('decant_tank_stock', {}, ctx),
    call('decant_trucks', {}, ctx),
    call('payments_recent', { days: 1 }, ctx),
    call('payments_review', {}, ctx),
    call('indents_list', {}, ctx),
    call('fleet_status', {}, ctx),
    call('loading_tankers', {}, ctx),
    call('xtrapower_status', {}, ctx),
  ]);
  const [sales, out, stock, trucks, pays, review, indents, fleet, tankers, xp] = parts;
  const lines = [];
  const skipped = [];
  const add = (p, name, text) => { if (p.ok && text) lines.push(text); else if (!p.ok && !p.off) skipped.push(`${name} (${p.needsLogin ? 'not signed in' : p.error})`); };
  add(sales, 'Ledger sales', sales.ok && sales.r.say);
  add(out, 'Outstanding', out.ok && `Outstanding: ${out.r.say}`);
  add(stock, 'Tank stock', stock.ok && `Tanks — ${stock.r.say}`);
  add(trucks, 'Trucks', trucks.ok && (trucks.r.summary.trucks.length ? `Trucks to decant: ${trucks.r.say}` : null));
  add(pays, 'Payments', pays.ok && `Payments today: ${pays.r.say}`);
  add(review, 'Payments review', review.ok && (review.r.summary.count ? `${review.r.summary.count} bank credits need review.` : null));
  add(indents, 'Indents', indents.ok && (indents.r.summary.count ? `Indents: ${indents.r.summary.pending} pending, ${indents.r.summary.awaiting_customer} awaiting the customer.` : 'No indents waiting.'));
  add(fleet, 'Fleet', fleet.ok && `Fleet: ${fleet.r.say}`);
  add(tankers, 'Tankers', tankers.ok && `Tankers: ${tankers.r.say}`);
  add(xp, 'XtraPower', xp.ok && `XtraPower: ${xp.r.say}`);
  return {
    summary: { day, sections: lines, not_available: skipped },
    say: lines.join('\n\n') + (skipped.length ? `\n\n_(Not included: ${skipped.join('; ')}.)_` : ''),
    app: 'all',
  };
}

async function customer360(input, ctx) {
  ctx.progress(`Looking up ${input.customer} in every app…`);
  let card = await call('ledger_outstanding', { customer: input.customer, picture: true }, { ...ctx });
  if (!card.ok) card = await call('ledger_outstanding', { customer: input.customer, picture: false }, ctx);   // figures without the picture
  if (card.ok && card.r.choices?.length) return card.r;                  // which one?
  const name = card.ok ? card.r.summary.customer || input.customer : input.customer;
  const bulk = card.ok && card.r.summary.kind === 'bulk';
  const [month, pos, pays, indents] = await Promise.all([
    call('ledger_customer', { customer: name }, ctx),
    bulk ? call('ledger_pos', { customer: name }, ctx) : Promise.resolve(null),
    call('payments_recent', { days: 31, customer: name }, ctx),
    call('indents_list', { customer: name }, ctx),
  ]);
  const lines = [];
  if (card.ok) lines.push(card.r.say);
  if (month?.ok) lines.push(month.r.say.replace(/ Outstanding today.*$/, ''));
  if (pos?.ok && pos.r.summary.pos_open !== undefined) lines.push(`POs: ${pos.r.say}`);
  if (pays?.ok && pays.r.summary.count) lines.push(`Payments (last 31 days): ${pays.r.say}`);
  if (indents?.ok && indents.r.summary.count) lines.push(`Indents: ${indents.r.say}`);
  return {
    summary: { customer: name, outstanding: card.ok ? card.r.summary : null, this_month: month?.ok ? month.r.summary : null, pos: pos?.ok ? pos.r.summary : null, payments: pays?.ok ? pays.r.summary : null, indents: indents?.ok ? indents.r.summary : null },
    say: lines.join('\n\n') || `I couldn't find ${input.customer} in the apps.`,
    images: card.ok ? card.r.images : [],
    table: month?.ok ? month.r.table : null,
    app: 'all',
  };
}

export const tools = [
  {
    name: 'business_brief', app: 'all', label: () => 'Business brief',
    description: 'A morning brief across every app: yesterday\'s (or a day\'s) sales, total outstanding, tank stock and trucks waiting, today\'s payments and credits to review, indents waiting, the fleet, the delivery tankers and the XtraPower monitor.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } }, run: brief,
  },
  {
    name: 'customer_360', app: 'all', label: (i) => `All about ${i.customer || ''}`,
    description: 'Everything about one customer across the apps: outstanding card (picture), this month\'s business by product, POs (bulk), payments in the last month and indents.',
    input_schema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, run: customer360,
  },
];
