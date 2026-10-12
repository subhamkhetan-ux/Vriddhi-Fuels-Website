// The built-in brain — Jarvis with no AI service at all (the default).
// On top of the phrase parser (quick.js) it keeps the thread of the
// conversation, so the owner can talk naturally:
//   - follow-ups:     "outstanding of Keshav" → "his statement" / "and SMC?"
//                     "sales today" → "and yesterday?" / "last month"
//                     "start monitoring Ember" → "stop it"
//   - several at once: "tank stock and sales today"
//   - picking one:     "steel" matched two customers → "the first one" / "shiva"
//   - "did you mean":  close commands when nothing fits
// understand(text, {attachments, memory, choices}) ->
//   {calls: [{tool, input}]} | {help: true} | {suggest: [phrase]}
//   (guess: true — a bare name tried as a customer; if no customer matches,
//   say you didn't understand instead)
// remember(memory, call, result) updates the memory after a call.
// Pure (tests/jarvis_web/engine.test.mjs).

import { bestMatch, editDistance } from './match.js';
import { HELP, parse } from './quick.js';

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const lower = (s) => ` ${clean(s).toLowerCase()} `;

export const newMemory = () => ({ last: null, customer: null, account: null });

const PRONOUN = /\b(his|her|their|its|him|them|it|uska|uski|unka|unki|iska|same|that one|that customer|is customer|us customer)\b/;
const PERIOD_ONLY = [
  [/\b(yesterday|kal)\b/, 'yesterday'],
  [/\b(today|aaj)\b/, 'today'],
  [/\blast month\b|\bpichhle mahine\b/, 'last_month'],
  [/\bthis month\b|\bis mahine\b/, 'this_month'],
  [/\b(this )?(fy|financial year|year)\b/, 'this_fy'],
  [/\blast 30 days\b/, 'last_30_days'],
];
const PERIOD_TOOLS = { ledger_sales: (p) => p, decant_report: (p) => ({ last_30_days: 'this_month', yesterday: 'today' }[p] || p) };
const CUSTOMER_TOOLS = new Set(['ledger_outstanding', 'ledger_statement']);
// checked in this order ("second one" is the second, not "one")
const ORDINAL = [
  ['first', 0], ['1st', 0], ['pehla', 0], ['second', 1], ['2nd', 1], ['doosra', 1], ['dusra', 1], ['third', 2], ['3rd', 2], ['teesra', 2],
  ['fourth', 3], ['4th', 3], ['fifth', 4], ['5th', 4], ['last', -1], ['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4], ['one', 0], ['two', 1], ['three', 2],
];

// "the second one" / "shiva" among the choices offered last time
function pickChoice(text, choices) {
  const t = lower(text);
  for (const [w, i] of ORDINAL) {
    if (new RegExp(`\\b${w}\\b`).test(t) && t.trim().split(' ').length <= 4) return choices.at(i) || null;
  }
  return bestMatch(text, choices, (c) => c.label).best;
}

// a follow-up that only makes sense after the last answer
function followUp(text, memory) {
  const t = lower(text);
  const last = memory.last;
  const words = t.trim().split(' ').filter(Boolean);
  if (!last) return null;

  // "and yesterday?" / "last month" after sales or the decant report
  if (PERIOD_TOOLS[last.tool] && words.length <= 5) {
    const p = PERIOD_ONLY.find(([re]) => re.test(t));
    const other = parse(text);
    if (p && (!other || other.tool === last.tool)) return { tool: last.tool, input: { ...last.input, period: PERIOD_TOOLS[last.tool](p[1]) } };
  }
  // "stop it" / "start it again" after watching an account
  if (memory.account && /\b(stop|band|unwatch|start|resume|chalu|watch)\b/.test(t) && (PRONOUN.test(t) || words.length <= 2)
      && !parse(text)?.input?.account) {
    return { tool: 'xtrapower_watch', input: { account: memory.account, watch: !/\b(stop|band|unwatch)\b/.test(t) } };
  }
  // "and Keshav?" / "what about SMC" after an outstanding or a statement
  const about = t.match(/^\s*(?:and|aur|what about|how about|or|also)\s+(.+?)\s*\??\s*$/);
  if (about && CUSTOMER_TOOLS.has(last.tool) && words.length <= 6 && !parse(about[1])) {
    return { tool: last.tool, input: { ...last.input, customer: clean(about[1].replace(/[?.!]/g, '')) } };
  }
  return null;
}

// fill a missing customer from the memory: "his statement", "send me their outstanding"
function withMemory(call, text, memory) {
  const t = lower(text);
  if (CUSTOMER_TOOLS.has(call.tool) && memory.customer) {
    const said = call.input.customer;
    if (!said ? PRONOUN.test(t) || call.tool === 'ledger_statement' : PRONOUN.test(` ${said} `) && said.split(' ').length <= 2) {
      const { segment: _s, ...input } = call.input;
      return { tool: call.tool, input: { ...input, customer: memory.customer } };
    }
  }
  if (call.tool === 'xtrapower_watch' && memory.account && PRONOUN.test(` ${call.input.account} `)) {
    return { tool: call.tool, input: { ...call.input, account: memory.account } };
  }
  return call;
}

// "statement" alone (no name) needs the memory
function bare(text, memory) {
  const t = lower(text);
  if (/\b(statement|ledger)\b/.test(t) && memory.customer) return { tool: 'ledger_statement', input: { customer: memory.customer } };
  return null;
}

// several requests in one sentence — only when every part is a request
// ("Shyam Metalics and Energy" stays one name)
function splitAll(text, attachments) {
  const parts = text.split(/\s+(?:and|aur|also|then|plus|&)\s+|[;,]\s*|\?\s+/i).map(clean).filter(Boolean);
  if (parts.length < 2) return null;
  const calls = parts.map((p) => parse(p, { attachments }) || parse(correct(p), { attachments }));
  if (calls.some((c) => !c || c.help)) return null;
  const seen = new Set();
  return calls.filter((c) => { const k = JSON.stringify(c); if (seen.has(k)) return false; seen.add(k); return true; });
}

// the command words, for spelling slips ("ballance", "tankk stok", "xtrapowr")
const VOCAB = ['outstanding', 'balance', 'statement', 'ledger', 'sales', 'stock', 'tank', 'tanks', 'monitor', 'monitoring', 'xtrapower',
  'status', 'decant', 'trucks', 'fleet', 'payments', 'tankers', 'loading', 'yesterday', 'today', 'month', 'start', 'stop', 'open',
  'variation', 'report', 'collections', 'earnings', 'list', 'logs', 'window', 'invoices', 'pending', 'scripts'];
// short words are too close to names ("Salem" / "sales"), so only these slips
const SLIPS = { stok: 'stock', stoc: 'stock', tankk: 'tank', tnak: 'tank', taank: 'tank', sale: 'sales', sels: 'sales', fleat: 'fleet', flet: 'fleet', staus: 'status', satus: 'status', logz: 'logs' };
export function correct(text) {
  return clean(text).split(' ').map((w) => {
    const lw = w.toLowerCase().replace(/[^a-z]/g, '');
    if (SLIPS[lw]) return SLIPS[lw];
    if (lw.length < 6 || VOCAB.includes(lw)) return w;
    const max = lw.length >= 9 ? 2 : 1;
    const hit = VOCAB.map((v) => [v, editDistance(lw, v, max)]).filter(([, d]) => d <= max).sort((a, b) => a[1] - b[1])[0];
    return hit ? hit[0] : w;
  }).join(' ');
}

export function understand(text, opts = {}) {
  const first = understandAs(text, opts);
  if (first.calls && !first.guess) return first;
  const fixed = correct(text);                     // only when the words as typed don't work
  if (fixed.toLowerCase() === clean(text).toLowerCase()) return first;
  const second = understandAs(fixed, opts);
  return second.calls && !second.guess ? { ...second, corrected: fixed } : first;
}

function understandAs(text, { attachments = [], memory = newMemory(), choices = null } = {}) {
  const t = clean(text);
  if (choices?.length && t) {
    const c = pickChoice(t, choices);
    if (c) return { calls: [{ tool: c.tool, input: c.input }] };
  }
  const fu = followUp(t, memory);
  if (fu) return { calls: [fu] };
  const many = attachments.length ? null : splitAll(t, attachments);
  if (many) return { calls: many.map((c) => withMemory(c, t, memory)) };
  const one = parse(t, { attachments });
  if (one?.help) return { help: true };
  if (one) return { calls: [withMemory(one, t, memory)] };
  const b = bare(t, memory);
  if (b) return { calls: [b] };
  // just a name ("crew", "keshav roadlines"): maybe a customer — look them up
  const words = t.replace(/[?.!]/g, '').split(' ').filter(Boolean);
  if (words.length && words.length <= 3 && /[a-z]{3}/i.test(t)) return { calls: [{ tool: 'ledger_outstanding', input: { customer: t.replace(/[?.!]/g, '') } }], guess: true, suggest: suggestions(t) };
  return { suggest: suggestions(t) };
}

// the closest commands to what was said
export function suggestions(text) {
  const phrases = HELP.filter(([p]) => !p.startsWith('📎')).map(([p, what]) => ({ p, what }));
  const { candidates } = bestMatch(text, phrases, (x) => [x.p, x.what], { min: 25 });
  return candidates.slice(0, 3).map((x) => x.p.split(' / ')[0]);
}

// after a call: what to remember for the next sentence
export function remember(memory, call, result) {
  const m = { ...memory, last: call };
  const s = result?.summary || {};
  if (CUSTOMER_TOOLS.has(call.tool) && s.customer) m.customer = s.customer;          // the name as the ledger has it
  if (call.tool === 'xtrapower_watch' && s.account) m.account = s.account;
  return m;
}
