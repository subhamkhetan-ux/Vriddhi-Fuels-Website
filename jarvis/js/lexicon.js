// The owner's own names, so the built-in brain can spot them anywhere in a
// sentence: every Ledger customer and bulk account, the XtraPower accounts,
// the delivery tankers, the bulkers, the apps and the Mac scripts. Built from
// each app (whatever is signed in) and refreshed now and then.

import { APPS } from './conn/more.js';

const KEY = 'jarvis-names';                         // accounts / scripts seen from the Mac
function saved() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
export function noteNames(kind, list) {
  if (!list?.length) return;
  try { localStorage.setItem(KEY, JSON.stringify({ ...saved(), [kind]: list })); } catch { /* private window */ }
}

const DEMO_ACCOUNTS = ['Shyam Metalics', 'Ember Coal', 'SSL XP'];

export async function buildLexicon(ctx) {
  const lex = { apps: APPS.map((a) => ({ name: a.name, names: [a.name, a.key, ...a.aka] })) };
  const s = saved();
  lex.accounts = (ctx.demo ? DEMO_ACCOUNTS : s.accounts || []).map((name) => ({ name }));
  lex.scripts = (s.scripts || []).map((x) => ({ name: x.label || x.name, names: [x.label, x.name].filter(Boolean) }));
  const [customers, tankers, fleet] = await Promise.all([
    import('./conn/ledger.js').then((m) => m.book(ctx)).then((b) => b.people.map((p) => ({ name: p.name, names: p.names }))).catch(() => []),
    import('./conn/loading.js').then((m) => m.lexicon(ctx)).catch(() => []),
    import('./conn/fleet.js').then((m) => m.lexicon(ctx)).catch(() => []),
  ]);
  lex.customers = customers;
  lex.tankers = tankers;
  lex.fleet = fleet;
  return lex;
}
