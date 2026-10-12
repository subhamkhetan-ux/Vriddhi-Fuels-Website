// Understanding a sentence — no AI service. Everything Jarvis needs is pulled
// out of what the owner said (typed or spoken, English or Hinglish):
//   amounts ("5 lakh", "₹50k", "2.5 cr"), litres ("12 KL", "5000 L"), days
//   ("older than 30 days"), dates and periods ("yesterday", "September",
//   "last week", "1 Oct to 10 Oct", "this month vs last month"), products,
//   comparisons ("more than", "below"), "top 5" / "lowest", what is measured
//   (litres, sales, earnings, outstanding, payments), retail / bulk, tank,
//   chamber, vehicle and PO numbers, indent codes, invoice numbers — and the
//   owner's own names (customers, XtraPower accounts, tankers, apps …) found
//   anywhere in the sentence, from the lexicon the apps provide.
// read(text, {today, lexicon}) -> nl (see the end). Pure.

import { bestMatch, score, words as nameWords } from './match.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthEnd = (y, m) => iso(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
const fyStart = (d) => { const y = +d.slice(0, 4); const m = +d.slice(5, 7); return `${m >= 4 ? y : y - 1}-04-01`; };
const fmtD = (d) => `${+d.slice(8, 10)} ${MON3[+d.slice(5, 7) - 1][0].toUpperCase()}${MON3[+d.slice(5, 7) - 1].slice(1)}`;

// Hinglish and short forms -> the words the rest of Jarvis listens for
const SAY = [
  [/\bm\s*\/\s*s\.?\s/g, ' '], [/\bmessrs\.?\s/g, ' '],
  [/\b(baki|baaki|bakaya|udhaar|udhar|lena|lene|due amount)\b/g, ' outstanding '],
  [/\b(kitna|kitni|kitne)\b/g, ' how much '], [/\b(kaun|kon)\b/g, ' who '], [/\b(kya|kaisa|kaise)\b/g, ' what '],
  [/\b(bikri|bikkri|becha|bechi)\b/g, ' sales '], [/\b(aaj|aj)\b/g, ' today '], [/\bparso\b/g, ' day before yesterday '],
  [/\b(kal)\b/g, ' yesterday '], [/\bpichhle?\s+(mahine|month)\b/g, ' last month '], [/\b(is|iss)\s+(mahine|month)\b/g, ' this month '],
  [/\bpichhle?\s+(hafte|week)\b/g, ' last week '], [/\b(is|iss)\s+(hafte|week)\b/g, ' this week '], [/\b(din)\b/g, ' days '],
  [/\b(gaadi|gadi)\b/g, ' vehicle '], [/\b(tel)\b/g, ' fuel '], [/\b(paisa|paise|rupaye|rupees?|rs\.?|inr)\b/g, ' rs '],
  [/\b(jama|aaya|aya|mila)\b/g, ' received '], [/\b(chalu|shuru)\b/g, ' start '], [/\b(band|bandh)\b/g, ' stop '],
  [/\b(sabse zyada|sabse jyada|sabse)\b/g, ' top '], [/\b(zyada|jyada|adhik)\b/g, ' more '], [/\b(kam)\b/g, ' less '],
  [/\b(nahi|nahin|nhi)\b/g, ' not '], [/\b(haven't|hasn't|didn't|havent|hasnt|didnt|dont|don't|doesn't|doesnt)\b/g, ' not '],
  [/\bhigh speed diesel\b/g, ' diesel '], [/\bmotor spirit\b/g, ' petrol '], [/\bxtra green\b/g, ' xtragreen '],
  [/\bx[ -]?tra ?power\b/g, ' xtrapower '], [/\bvs\.?\b|\bversus\b|\bcompared (to|with)\b/g, ' vs '],
];

export const PRODUCTS = [
  ['HSD', /\b(diesel|hsd)\b/], ['MS', /\b(petrol|ms|gasoline)\b/], ['XG', /\b(xtragreen|xg)\b/], ['OTHER', /\b(lube|lubricant|oil|adblue|other items?)\b/],
];

const METRICS = [
  ['balance', /\b(outstanding|balance|dues?|owes?|owe|owing|receivables?)\b/],
  ['paid', /\b(paid|payments?|collections?|received|credited)\b/],
  ['earning', /\b(earnings?|margin|profit|kamai|munafa)\b/],
  ['litres', /\b(litres?|liters?|ltrs?|volume|quantity|qty|kl)\b/],
  ['amount', /\b(sales?|sold|revenue|business|billing|billed|turnover|amount)\b/],
  ['bills', /\b(bills|invoices)\b/],
];

// words that ask, not name — dropped when looking for a name in what is left
const COMMAND = new Set(`
a an the of for to from in on at by with and or but is are was were be been am do does did can could would should will shall
me my mine i we our us you your he his him she her they them their it its this that these those there here what which who whom whose
how much many any some all every each total list show tell give get send find check see open please pls jarvis hey ok okay now
outstanding balance balances due dues owe owes owing owed receivable receivables statement ledger account accounts sales sale sold
revenue business billing billed turnover amount earnings earning margin profit litres litre liters liter ltr ltrs volume quantity qty
paid payment payments collection collections received credited bill bills invoice invoices pending stock stocks tank tanks dip
truck trucks tt decant decanting report variation fleet bulker bulkers trip trips vehicle vehicles tanker tankers loading load loaded
xtrapower monitor monitoring watch watching start stop status logs log window chrome customer customers party parties retail bulk
top bottom highest lowest most least biggest smallest largest best worst more less than above below over under greater fewer
not no never yet since till until between vs compare compared versus today yesterday tomorrow week month year fy days day ago last
this next previous current daily monthly yearly quarter diesel petrol xtragreen hsd ms xg lube oil po pos purchase order orders
indent indents price prices rate rates rsp add new place set update delete remove cancel deliver delivered approve dispatch sent
sale picture image card pdf share whatsapp rs lakh lakhs lac crore cr thousand k old older age aged overdue unpaid haven hasn
did nothing anything something everyone everybody who's whats what's please kindly also then plus about give mujhe batao bata dikhao
take took taken bought buy buys lifted lift purchased hai ka ki ke ko se tha thi ho gaya liya diya hua chamber vehicle number amount percent
`.trim().split(/\s+/));

// ---- numbers -----------------------------------------------------------------
const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
const toNum = (s) => Number(String(s).replace(/,/g, ''));
const MULT = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, cr: 1e7, crore: 1e7, crores: 1e7, k: 1e3, thousand: 1e3 };
const CMP = [['>', /\b(more than|above|over|greater than|exceeding|at least|minimum|min|>=?|beyond|upar)\s*$/], ['<', /\b(less than|below|under|at most|maximum|max|upto|up to|<=?|within|neeche)\s*$/]];
const cmpBefore = (s) => (CMP.find(([, re]) => re.test(s)) || [null])[0];

// ---- periods -----------------------------------------------------------------
function monthPeriod(mi, year, today) {
  let y = year || +today.slice(0, 4);
  if (!year && iso(y, mi + 1, 1) > today) y -= 1;                       // "September" in March = last September
  const from = iso(y, mi + 1, 1);
  const to = monthEnd(y, mi + 1);
  return { from, to: to > today ? today : to, label: `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${y}`, month: from.slice(0, 7) };
}

function dateOf(text, today) {
  let m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?([a-z]{3,9})\.?(?:\s*,?\s*(\d{4}))?$/);
  if (m && MON3.includes(m[2].slice(0, 3))) {
    const mi = MON3.indexOf(m[2].slice(0, 3));
    let y = m[3] ? +m[3] : +today.slice(0, 4);
    if (!m[3] && iso(y, mi + 1, +m[1]) > today) y -= 1;
    return iso(y, mi + 1, +m[1]);
  }
  m = text.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?$/);
  if (m && MON3.includes(m[1].slice(0, 3))) {
    const mi = MON3.indexOf(m[1].slice(0, 3));
    let y = m[3] ? +m[3] : +today.slice(0, 4);
    if (!m[3] && iso(y, mi + 1, +m[2]) > today) y -= 1;
    return iso(y, mi + 1, +m[2]);
  }
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    let y = m[3] ? +(m[3].length === 2 ? `20${m[3]}` : m[3]) : +today.slice(0, 4);
    if (!m[3] && iso(y, +m[2], +m[1]) > today) y -= 1;
    return iso(y, +m[2], +m[1]);
  }
  return null;
}

const DATE_RE = '(\\d{1,2}(?:st|nd|rd|th)?\\s*(?:of\\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?(?:\\s*,?\\s*\\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,?\\s*\\d{4})?|\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?)';

// every period named, in the order said: [{from, to, label, at}]
function periodsIn(s, today) {
  const found = [];
  const take = (re, fn) => {
    s = s.replace(re, (...a) => {
      const at = a[a.length - 2];
      const p = fn(...a);
      if (!p) return a[0];
      found.push({ ...p, at });
      return ' '.repeat(a[0].length);
    });
  };
  const y = addDays(today, -1);
  take(new RegExp(`\\b(?:from|between)\\s+${DATE_RE}\\s+(?:to|till|until|and|-)\\s+${DATE_RE}`, 'g'), (_, a, b) => {
    const f = dateOf(a, today); const t = dateOf(b, today);
    return f && t ? { from: f, to: t, label: `${fmtD(f)} – ${fmtD(t)}` } : null;
  });
  take(new RegExp(`\\b(?:since|after)\\s+${DATE_RE}`, 'g'), (_, a) => { const f = dateOf(a, today); return f ? { from: f, to: today, label: `since ${fmtD(f)}` } : null; });
  take(new RegExp(`\\b(?:till|until|upto|up to|before)\\s+${DATE_RE}`, 'g'), (_, a) => { const t = dateOf(a, today); return t ? { from: fyStart(t), to: t, label: `till ${fmtD(t)}` } : null; });
  take(/\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/g, (_, n) => ({ from: addDays(today, 1 - +n), to: today, label: `Last ${n} days`, key: 'lastNd' }));
  take(/\bday before yesterday\b/g, () => { const d = addDays(today, -2); return { from: d, to: d, label: fmtD(d), day: true }; });
  take(/\byesterday\b/g, () => ({ from: y, to: y, label: 'Yesterday', day: true, key: 'yesterday' }));
  take(/\btoday\b/g, () => ({ from: today, to: today, label: 'Today', day: true, key: 'today' }));
  take(/\b(?:this|current)\s+week\b/g, () => { const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; return { from: addDays(today, -dow), to: today, label: 'This week', key: 'this_week' }; });
  take(/\b(?:last|previous)\s+week\b/g, () => { const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; const to = addDays(today, -dow - 1); return { from: addDays(to, -6), to, label: 'Last week', key: 'last_week' }; });
  take(/\b(?:this|current)\s+month\b/g, () => ({ from: `${today.slice(0, 7)}-01`, to: today, label: 'This month', key: 'this_month', month: today.slice(0, 7) }));
  take(/\b(?:last|previous)\s+month\b/g, () => { const e = addDays(`${today.slice(0, 7)}-01`, -1); return { from: `${e.slice(0, 7)}-01`, to: e, label: 'Last month', key: 'last_month', month: e.slice(0, 7) }; });
  take(/\b(?:last|previous)\s+(?:fy|financial year|year)\b/g, () => { const f = fyStart(today); const s0 = `${+f.slice(0, 4) - 1}-04-01`; return { from: s0, to: addDays(f, -1), label: 'Last FY', key: 'last_fy' }; });
  take(/\b(?:this|current)?\s*(?:fy|financial year|year)\b/g, () => ({ from: fyStart(today), to: today, label: 'This FY', key: 'this_fy' }));
  take(/\bq([1-4])\b/g, (_, q) => {
    const f = fyStart(today); const fy = +f.slice(0, 4);
    const sm = [4, 7, 10, 1][q - 1]; const yy = q === '4' ? fy + 1 : fy;
    const to = monthEnd(yy, sm + 2);
    return { from: iso(yy, sm, 1), to: to > today ? today : to, label: `Q${q}` };
  });
  take(new RegExp(`\\b(?:on\\s+)?${DATE_RE}`, 'g'), (_, a) => { const d = dateOf(a, today); return d ? { from: d, to: d, label: fmtD(d), day: true } : null; });
  take(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b(?:\s+(\d{4}))?/g, (all, mo, yr) => {
    if (mo === 'may' && !yr && !/\bin may\b/.test(s)) return null;           // "may" is usually a verb
    return monthPeriod(MON3.indexOf(mo.slice(0, 3)), yr ? +yr : null, today);
  });
  return { periods: found.sort((a, b) => a.at - b.at).map(({ at, ...p }) => p), rest: s };
}

// ---- names from the lexicon ------------------------------------------------------
// the best run of 1–5 words naming an entry of `list` ({name, names?})
function findName(tokens, list, { min = 78 } = {}) {
  if (!list || !list.length || !tokens.length) return null;
  let best = null;
  for (let n = Math.min(5, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const span = tokens.slice(i, i + n);
      if (span.every((w) => COMMAND.has(w) || /^\d+$/.test(w))) continue;
      if (COMMAND.has(span[0]) && n > 1) continue;
      const q = span.join(' ');
      const { best: hit, candidates } = bestMatch(q, list, (x) => x.names || [x.name], { min });
      const top = candidates[0];
      if (!top) continue;
      const sc = Math.max(...(top.names || [top.name]).map((nm) => score(q, nm)));
      const cand = { item: hit, candidates: hit ? [hit] : candidates.slice(0, 5), text: q, score: sc + n, start: i, n };
      if (!best || cand.score > best.score) best = cand;
    }
  }
  return best;
}

// ---- read ------------------------------------------------------------------------
export function read(text, { today = new Date().toISOString().slice(0, 10), lexicon = {} } = {}) {
  const raw = String(text ?? '').trim();
  let s = ` ${raw.toLowerCase().replace(/[“”"]/g, ' ').replace(/[’']/g, "'")} `;
  for (const [re, to] of SAY) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ');
  const nl = {
    raw, text: s.trim(), today, products: [], periods: [], numbers: [], money: null, litres: null, days: null,
    top: null, metric: null, metrics: [], segment: null, tank: null, chamber: null, vehicle: null, po: null, indent: null,
    invoice: null, dipCm: null, negated: false, question: null, compare: false, names: {},
  };

  // codes first (they contain digits that aren't amounts)
  s = s.replace(/\bind[- ]?(\d{1,6})\b/g, (_, n) => { nl.indent = `IND-${n.padStart(4, '0')}`; return ' '; });
  s = s.replace(/\bpo\s*(?:no\.?|number|num|#)?\s*[:#-]?\s*([a-z0-9][a-z0-9/._-]*\d[a-z0-9/._-]*)/g, (_, p) => { nl.po = p.toUpperCase(); return ' po '; });
  s = s.replace(/\b(\d{9,12})\b/g, (_, n) => { nl.invoice = n; return ' '; });
  s = s.replace(/\btank\s*(?:no\.?|number)?\s*(\d)\b/g, (_, n) => { nl.tank = +n; return ' tank '; });
  s = s.replace(/\b(?:chamber|c)\s*(\d)\b/g, (_, n) => { nl.chamber = +n; return ' chamber '; });

  // dates and periods
  const pr = periodsIn(s, today);
  nl.periods = pr.periods;
  s = pr.rest;
  nl.period = nl.periods[0] || null;
  // vehicle numbers (after the dates: "12 oct 2026" isn't one)
  s = s.replace(/\b([a-z]{2})\s?(\d{1,2})\s?([a-z]{1,3})\s?(\d{3,4})\b/g, (all, a, b, c, d) => {
    if (MON3.includes(c.slice(0, 3)) || ['to', 'on', 'of', 'in', 'by'].includes(a)) return all;
    nl.vehicle = `${a}${b}${c}${d}`.toUpperCase();
    return ' vehicle ';
  });
  nl.compare = /\bvs\b|\bcompare\b|\bcomparison\b|\bversus\b|\bagainst\b/.test(s) || (nl.periods.length >= 2 && /\band\b|\bthan\b/.test(s));

  // top / bottom N
  s = s.replace(/\b(top|best|biggest|highest|largest|most|first)\s*(\d{1,3})?\b/g, (all, w, n) => {
    if (w === 'first' && !n) return all;
    nl.top = { n: n ? +n : (/\b(who|which)\s+is\b/.test(s) ? 1 : null), dir: 'desc' };
    return ' top ';
  });
  s = s.replace(/\b(bottom|lowest|least|smallest|worst)\s*(\d{1,3})?\b/g, (all, w, n) => { nl.top = { n: n ? +n : null, dir: 'asc' }; return ' bottom '; });

  // quantities with units
  s = s.replace(new RegExp(`(?:(rs|₹)\\s*)?${NUM}\\s*(lakhs?|lacs?|crores?|cr|k|thousand)\\b`, 'g'), (all, _r, n, u, off) => {
    nl.money = { value: toNum(n) * MULT[u], op: cmpBefore(s.slice(0, off)) || '=' };
    nl.numbers.push({ value: nl.money.value, unit: 'rs' });
    return ' amount ';
  });
  s = s.replace(new RegExp(`(?:rs|₹)\\s*${NUM}`, 'g'), (all, n, off) => {
    nl.money = { value: toNum(n), op: cmpBefore(s.slice(0, off)) || '=' };
    nl.numbers.push({ value: nl.money.value, unit: 'rs' });
    return ' amount ';
  });
  s = s.replace(new RegExp(`${NUM}\\s*(kl|kilo ?litres?)\\b`, 'g'), (all, n, u, off) => {
    nl.litres = { value: toNum(n) * 1000, op: cmpBefore(s.slice(0, off)) || '=' };
    nl.numbers.push({ value: nl.litres.value, unit: 'L' });
    return ' litres ';
  });
  s = s.replace(new RegExp(`${NUM}\\s*(l|ltrs?|litres?|liters?)\\b`, 'g'), (all, n, u, off) => {
    nl.litres = { value: toNum(n), op: cmpBefore(s.slice(0, off)) || '=' };
    nl.numbers.push({ value: nl.litres.value, unit: 'L' });
    return ' litres ';
  });
  s = s.replace(new RegExp(`${NUM}\\s*(cm)\\b`, 'g'), (all, n) => { nl.dipCm = toNum(n); return ' dip '; });
  s = s.replace(new RegExp(`${NUM}\\s*(days?|weeks?|months?)\\b(\\s+old)?`, 'g'), (all, n, u, old, off) => {
    const k = u.startsWith('week') ? 7 : u.startsWith('month') ? 30 : 1;
    nl.days = { value: toNum(n) * k, op: cmpBefore(s.slice(0, off)) || (/\b(in|for|since)\s*(the\s+)?(last|past)?\s*$/.test(s.slice(0, off)) ? 'within' : '>') };
    return ' days ';
  });
  s = s.replace(new RegExp(`${NUM}\\s*%`, 'g'), (all, n) => { nl.numbers.push({ value: toNum(n), unit: '%' }); return ' percent '; });
  s = s.replace(new RegExp(`(^|[^a-z0-9])${NUM}(?![a-z0-9])`, 'g'), (all, pre, n, off) => {
    nl.numbers.push({ value: toNum(n), unit: null, op: cmpBefore(s.slice(0, off + pre.length)) });
    return `${pre} # `;
  });

  // kinds of things
  for (const [k, re] of PRODUCTS) if (re.test(s)) nl.products.push(k);
  nl.product = nl.products[0] || null;
  for (const [k, re] of METRICS) if (re.test(s)) nl.metrics.push(k);
  nl.metric = nl.metrics[0] || null;
  if (/\bretail\b/.test(s)) nl.segment = 'retail';
  else if (/\b(bulk|groups?|companies)\b/.test(s)) nl.segment = 'bulk';
  nl.negated = /\b(not|no|never|without|nothing)\b/.test(s);
  nl.question = /\b(which|who)\b/.test(s) ? 'which' : /\bhow (much|many)\b/.test(s) ? 'how much' : /\b(what|show|list|tell)\b/.test(s) ? 'what' : null;

  // names
  const tokens = s.replace(/[^a-z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
  for (const [kind, list] of Object.entries(lexicon || {})) {
    const hit = findName(tokens, list);
    if (hit) nl.names[kind] = hit;
  }
  // a vehicle number said in full: whose is it (a bulker, a tanker…)?
  if (nl.vehicle) {
    for (const [kind, list] of Object.entries(lexicon || {})) {
      const item = (list || []).find((x) => String(x.name).toUpperCase().replace(/[^A-Z0-9]/g, '') === nl.vehicle);
      if (item) nl.names[kind] = { item, candidates: [item], text: nl.vehicle, score: 120 };
    }
  }
  nl.rest = tokens.filter((w) => !COMMAND.has(w) && w !== '#').join(' ');
  nl.words = new Set(tokens);
  nl.s = ` ${tokens.join(' ')} `;
  return nl;
}

// does the sentence say any of these words / phrases?
export const says = (nl, ...words) => words.some((w) => (w.includes(' ') ? nl.s.includes(` ${w} `) : nl.words.has(w)));

// the name the owner gave for a kind (resolved from the lexicon, or the words left over)
export function nameOf(nl, kind) {
  const hit = nl.names[kind];
  if (hit?.item) return hit.item.name;
  if (hit?.candidates?.length) return hit.text;
  return nl.rest || null;
}

export { nameWords };
