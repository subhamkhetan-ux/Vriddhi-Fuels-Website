// The phrase parser of the built-in brain (engine.js): one plain sentence,
// typed or spoken, English or Hinglish, mapped to one tool — no AI service.
// engine.js adds the conversation (follow-ups, choices, several requests).
// parse(text, {attachments}) -> {tool, input} | {help: true} | null
// Pure (tests/jarvis_web/quick.test.mjs).

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

// what's left after the command words: "outstanding of SMC Power please" -> "SMC Power"
function subject(text, ...cut) {
  let s = ` ${text.toLowerCase()} `;
  for (const re of cut) s = s.replace(re, ' ');
  s = s.replace(/\b(please|pls|plz|jarvis|hey|ok|okay|me|my|the|show|tell|give|get|send|what is|what's|whats|how much|is|for|of|from|to|batao|bata|dikhao|do|does|did|can|could|you|i|we|now|right now|currently|current|today's|kitna|kya|hai|ka|ki|ke)\b/g, ' ')
    .replace(/[?.!,]/g, ' ');
  return clean(s);
}

const PERIODS = [
  [/\byesterday\b|\bkal\b/, 'yesterday'],
  [/\blast month\b|\bpichhle mahine\b/, 'last_month'],
  [/\bthis month\b|\bis mahine\b|\bmonth\b/, 'this_month'],
  [/\b(this )?(fy|financial year|year)\b/, 'this_fy'],
  [/\blast 30 days\b/, 'last_30_days'],
  [/\btoday\b|\baaj\b/, 'today'],
];
const periodOf = (t, dflt) => (PERIODS.find(([re]) => re.test(t)) || [null, dflt])[1];

export function parse(text, { attachments = [] } = {}) {
  const t = ` ${clean(text).toLowerCase()} `;
  if (!t.trim()) return attachments.length ? { tool: 'decant_update_stock_from_photo', input: { attachment_id: attachments[0] } } : null;
  if (/^\s*(help|what can you do|commands)\s*\??\s*$/.test(t)) return { help: true };

  // a picture + stock words: read it into Decant
  if (attachments.length && /\b(stock|tank|dip|decant|automation|update|upload|screenshot|photo)\b/.test(t)) {
    return { tool: 'decant_update_stock_from_photo', input: { attachment_id: attachments[0] } };
  }

  // XtraPower
  if (/\b(xtra ?power|xp|ccms|monitor(ing)?)\b/.test(t)) {
    const on = /\b(start|begin|resume|on|chalu|shuru|watch)\b/.test(t);
    const off = /\b(stop|end|pause|off|band|unwatch)\b/.test(t);
    if (/\blogs?\b/.test(t)) return { tool: 'xtrapower_logs', input: { lines: 20 } };
    if (/\b(open|launch)\b.*\b(window|chrome|browser)\b/.test(t)) {
      return { tool: 'xtrapower_open_window', input: { account: subject(t, /\b(open|launch|window|chrome|browser|xtra ?power|xp|ccms)\b/g) } };
    }
    if (/\b(status|running|chal raha|check|balance|credited)\b/.test(t) && !on && !off) return { tool: 'xtrapower_status', input: {} };
    // "monitor XtraPower account Ember Coal" / "start monitoring Shyam" / "stop monitoring ember"
    const who = subject(t, /\b(start|begin|resume|on|chalu|shuru|karo|kar|watch(ing)?|stop|end|pause|off|band|unwatch|xtra ?power|xp|ccms|monitor(ing)?|the|account|accounts|all|a|an)\b/g);
    if (who) return { tool: 'xtrapower_watch', input: { account: who, watch: !off } };
    if (on || off) return { tool: 'xtrapower_monitor', input: { action: off ? 'stop' : 'start' } };
    return { tool: 'xtrapower_status', input: {} };
  }

  // Ledger
  if (/\b(outstanding|balance|dues?|baki|baaki|pending amount|receivables?|owes?|udhaar|udhar)\b/.test(t)) {
    const seg = /\bretail\b/.test(t) ? 'retail' : /\bbulk\b/.test(t) ? 'bulk' : 'all';
    const who = subject(t, /\b(outstanding|balances?|dues?|baki|baaki|pending amount|receivables?|owes?|udhaar|udhar|all|everyone|everybody|customers?|list|total|retail|bulk|image|picture|card)\b/g);
    return { tool: 'ledger_outstanding', input: who ? { customer: who } : { segment: seg } };
  }
  if (/\b(statement|ledger)\b/.test(t)) {
    const who = subject(t, /\b(statement|ledger|account|of account|soa|this month|last month)\b/g);
    if (who) return { tool: 'ledger_statement', input: { customer: who } };
  }
  if (/\b(sales?|sold|bikri|business|earnings?|collections?)\b/.test(t)) {
    return { tool: 'ledger_sales', input: { period: periodOf(t, 'today') } };
  }
  if (/\bpayments?\b|\breceived\b|\bcredits?\b/.test(t)) return { tool: 'payments_recent', input: { days: 3 } };

  // Decant
  const set = t.match(/\btank\s*(?:no\.?\s*)?(\d)\b.*?\b(stock|dip)\b\D*?([\d,]+(?:\.\d+)?)\s*(cm|l|litres?|liters?)?\b/);
  if (set) {
    const n = Number(set[3].replace(/,/g, ''));
    const dip = set[2] === 'dip' || set[4] === 'cm';
    return { tool: 'decant_set_stock', input: dip ? { tank_no: Number(set[1]), dip_cm: n } : { tank_no: Number(set[1]), litres: n } };
  }
  if (/\b(trucks?|tt|invoices?)\b.*\b(decant|waiting|pending|arrived|to decant)\b|\bto decant\b/.test(t)) return { tool: 'decant_trucks', input: {} };
  if (/\b(variation|decant(ing|ation)? report|shortage)\b/.test(t)) return { tool: 'decant_report', input: { period: /\btoday\b/.test(t) ? 'today' : periodOf(t, 'this_month') } };
  if (/\b(stock|tanks?|dip|ullage|underground)\b/.test(t)) return { tool: 'decant_tank_stock', input: {} };

  // Fleet & loading
  if (/\b(fleet|bulkers?|on the road|trips?)\b/.test(t)) return { tool: 'fleet_status', input: {} };
  if (/\b(tankers?|loading|fill level)\b/.test(t)) return { tool: 'loading_tankers', input: {} };

  // Mac scripts
  if (/\b(scripts?|mac)\b/.test(t) && /\b(list|what|which)\b/.test(t)) return { tool: 'mac_scripts', input: {} };

  // open an app
  const open = t.match(/\b(open|launch|go to)\b\s+(the\s+)?(.+?)(\s+app)?\s*$/);
  if (open) return { tool: 'open_app', input: { app: clean(open[3]) } };
  return null;
}

export const HELP = [
  ['Outstanding of SMC', 'the customer\'s outstanding card (picture)'],
  ['Outstanding list', 'everyone who owes, as a picture'],
  ['Statement of Keshav', 'their ledger for this month'],
  ['Sales today / yesterday / this month', 'sales, litres, earnings'],
  ['Tank stock', 'the underground tanks right now'],
  ['📎 a screenshot + "update stock"', 'reads it into the Decant app'],
  ['Trucks to decant', 'invoices waiting'],
  ['Start monitoring Ember Coal', 'XtraPower: watch that account (on the Mac)'],
  ['Stop XtraPower monitoring', 'turns the monitor off'],
  ['XtraPower status', 'monitor on/off, each account\'s CCMS'],
  ['Fleet status', 'which bulkers are on the road'],
  ['Payments', 'the last few days\' payments'],
  ['Open decant app', 'a link to any app'],
];
