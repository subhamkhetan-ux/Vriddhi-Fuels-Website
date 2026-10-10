// Tanker decanting — the rules, with no DOM and no network (tested under Node).

export const PRODUCTS = {
  MS: { key: 'MS', name: 'Petrol (MS)', short: 'MS', screen: 'Motor Spirit' },
  HSD: { key: 'HSD', name: 'Diesel (HSD)', short: 'HSD', screen: 'High Speed Diesel' },
  XG: { key: 'XG', name: 'XtraGreen', short: 'XG', screen: 'XtraGreen' },
};

// capacity: the tank's rated size (the automation's ullage is measured to it);
// fillTo: how full it may be filled — our 20 KL IndianOil tanks hold about
// 21,000 L, and are filled up to 20,500 L.
export const DEFAULT_TANKS = [
  { id: 'T1', no: 1, product: 'MS', capacity: 20000, fillTo: 20500 },
  { id: 'T2', no: 2, product: 'HSD', capacity: 20000, fillTo: 20500 },
  { id: 'T3', no: 3, product: 'HSD', capacity: 20000, fillTo: 20500 },
  { id: 'T4', no: 4, product: 'XG', capacity: 20000, fillTo: 20500 },
];

export const DEFAULT_SETTINGS = {
  tanks: DEFAULT_TANKS,
  // Tanks removed in Settings, kept by id: their decantations still name them,
  // and a new tank never takes an old one's id.
  retiredTanks: [],
  tolerancePct: 0.25,   // a variation within max(tolerancePct % of the load, toleranceMinL) is "OK"
  toleranceMinL: 25,
  warnRoomL: 150,       // warn when a tank would be left with less room than this
  staleMinutes: 30,     // a stock reading older than this is flagged before decanting
  settleMinutes: 10,    // suggested wait after decanting before the "after" screenshot
  // How long a chamber takes to empty through the pipe, in seconds (5 KL:
  // 8 min 15 s, 4 KL: 7 min); other sizes lie on the line through the two.
  emptySecs5: 495,
  emptySecs4: 420,
  pipeMoveSecs: 45,     // moving the pipe to the tank's next chamber: close the valve, unhook, carry, couple, open
  pendingDays: 3,       // older undecanted invoices fold away under "Older"
  dateOrder: 'MDY',     // the automation prints dates as MM/DD/YYYY
  densityLimit: 3,      // truck density vs the invoice's Density@15, ± kg/m³
  keep: 'fy2',          // what the cloud keeps: 'fy2' (this FY and the last) or 12 / 6 / 3 months (archive.js)
  excludeTankers: ['OD15AF5510'],   // our delivery tankers left out of "room in our tankers"
  // Our own TTs (tank trucks) and their chambers, KL from chamber 1.
  ownTTs: [{ tt: 'OD23U8210', chambers: [5, 5, 4, 4, 4] }],
  // Any other TT is a transport TT: its chambers aren't kept, they follow one of
  // these layouts for its size (KL) — the plan makes room for whichever comes.
  transportTTs: {
    20: [[5, 5, 5, 5], [4, 4, 4, 4, 4]],
    22: [[4.5, 4.5, 4.5, 4.5, 4], [5, 5, 4, 4, 4]],
    23: [[5, 5, 5, 4, 4]],
    24: [[5, 5, 5, 5, 4]],
    25: [[5, 5, 5, 5, 5]],
  },
};

// 'od 23 u 8210' -> 'OD23U8210'
export const normTT = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const kls = (list) => (Array.isArray(list) ? list.map(Number).filter((x) => x > 0 && x <= 30) : []);

// One of our own TTs ({tt, chambers}), or null for a transport TT.
export function ownTT(tt, settings = DEFAULT_SETTINGS) {
  const n = normTT(tt);
  return (settings.ownTTs || []).find((o) => o.tt === n) || null;
}

// "22: 4.5+4.5+4.5+4.5+4 | 5+5+4+4+4" per line <-> {22: [[4.5, …], [5, …]]}
export function parseLayouts(text) {
  const out = {};
  for (const line of String(text || '').split(/\n/)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:kl)?\s*[:=-]\s*(.+)$/i.exec(line);
    if (!m) continue;
    const layouts = m[2].split(/\||\bor\b/i).map((x) => kls(x.split(/[+,\s]+/).filter(Boolean))).filter((x) => x.length);
    if (layouts.length) out[Number(m[1])] = layouts;
  }
  return out;
}
export function layoutsText(table) {
  return Object.keys(table || {}).map(Number).sort((a, b) => a - b)
    .map((size) => `${size}: ${table[size].map((l) => l.join('+')).join(' | ')}`).join('\n');
}

export function settingsWith(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  if (!Array.isArray(s.tanks) || !s.tanks.length) s.tanks = DEFAULT_TANKS;
  if (!Array.isArray(s.excludeTankers)) s.excludeTankers = DEFAULT_SETTINGS.excludeTankers;
  s.ownTTs = Array.isArray(s.ownTTs)
    ? s.ownTTs.map((o) => ({ tt: normTT(o?.tt), chambers: kls(o?.chambers) })).filter((o) => o.tt && o.chambers.length)
    : DEFAULT_SETTINGS.ownTTs;
  const table = s.transportTTs && typeof s.transportTTs === 'object' ? s.transportTTs : {};
  const clean = Object.fromEntries(Object.entries(table).map(([k, v]) => [Number(k), (Array.isArray(v) ? v : []).map(kls).filter((l) => l.length)])
    .filter(([k, v]) => k > 0 && v.length));
  s.transportTTs = Object.keys(clean).length ? clean : DEFAULT_SETTINGS.transportTTs;
  for (const k of ['emptySecs5', 'emptySecs4']) s[k] = Number(s[k]) > 0 ? Number(s[k]) : DEFAULT_SETTINGS[k];
  s.pipeMoveSecs = s.pipeMoveSecs !== null && s.pipeMoveSecs !== '' && Number(s.pipeMoveSecs) >= 0 && Number(s.pipeMoveSecs) <= 600
    ? Number(s.pipeMoveSecs) : DEFAULT_SETTINGS.pipeMoveSecs;
  s.keep = ['fy2', '12', '6', '3'].includes(String(s.keep)) ? String(s.keep) : DEFAULT_SETTINGS.keep;
  s.tanks = s.tanks.map((t, i) => {
    const capacity = Number(t.capacity) > 0 ? Number(t.capacity) : 20000;
    return {
      id: String(t.id || `T${i + 1}`),
      no: Number(t.no) || i + 1,
      product: PRODUCTS[t.product] ? t.product : 'HSD',
      capacity,
      // saved before the fill limit existed: a 20 KL tank fills to 20,500 L
      fillTo: Number(t.fillTo) > 0 ? Number(t.fillTo) : (capacity === 20000 ? 20500 : capacity),
    };
  });
  const active = new Set(s.tanks.map((t) => t.id));
  s.retiredTanks = (Array.isArray(s.retiredTanks) ? s.retiredTanks : [])
    .filter((t) => t && t.id && !active.has(String(t.id)))
    .map((t) => ({
      id: String(t.id), no: Number(t.no) || null, product: PRODUCTS[t.product] ? t.product : null,
      capacity: Number(t.capacity) > 0 ? Number(t.capacity) : null, removedAt: t.removedAt || null,
    }));
  return s;
}

// A new tank's id: T<no> when it's free, else the next free T<n> — never the
// id of a tank in use or one removed (its decantations and stock still point
// at it).
export function newTankId(no, taken) {
  const used = new Set([...(taken || [])].map(String));
  if (Number.isInteger(no) && no > 0 && !used.has(`T${no}`)) return `T${no}`;
  let n = 1;
  while (used.has(`T${n}`)) n++;
  return `T${n}`;
}

// What's wrong with a tank list before it's saved: [] when it's fine. Each
// tank needs a number of its own (the automation's "Tank N" is matched by it),
// a product, a capacity and how full it may be filled.
export function tankProblems(list) {
  const out = [];
  if (!Array.isArray(list) || !list.length) return ['Keep at least one tank.'];
  const seen = new Set();
  for (const t of list) {
    const name = Number.isInteger(t.no) && t.no > 0 ? `Tank ${t.no}` : 'A tank';
    if (!Number.isInteger(t.no) || t.no < 1 || t.no > 99) out.push(`${name}: its number must be a whole number from 1 to 99.`);
    else if (seen.has(t.no)) out.push(`Two tanks are numbered ${t.no} — each needs its own number.`);
    seen.add(t.no);
    if (!PRODUCTS[t.product]) out.push(`${name}: pick its product.`);
    if (!(Number(t.capacity) >= 1000 && Number(t.capacity) <= 100000)) out.push(`${name}: capacity must be from 1,000 to 1,00,000 L.`);
    else if (!(Number(t.fillTo) >= t.capacity * 0.9 && Number(t.fillTo) <= t.capacity * 1.05)) {
      out.push(`${name}: fill up to must be from 90 % to 105 % of its capacity (${Math.ceil(t.capacity * 0.9).toLocaleString('en-IN')}–${Math.floor(t.capacity * 1.05).toLocaleString('en-IN')} L).`);
    }
  }
  return out;
}

// How full a tank may be filled (litres).
export const fillLimit = (tank) => (Number(tank?.fillTo) > 0 ? Number(tank.fillTo) : Number(tank?.capacity) || 20000);

export const round2 = (n) => Math.round(n * 100) / 100;

// variation as a % of the load, to 3 decimals (0.193 %)
export const pctOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100000) / 1000 : 0);

// 'MS' | 'HSD' | 'XG' | 'LSHF' | null from an invoice description / column key /
// the automation's product name.
export function productKey(text) {
  const u = String(text ?? '').toUpperCase();
  if (!u.trim()) return null;
  if (/XTRA\s*GR|XTRAGRN|\bXG\b/.test(u)) return 'XG';
  if (/LSHF/.test(u)) return 'LSHF';
  if (/EBMS|(^|[^A-Z])MS([^A-Z]|$)|PETROL|MOTOR\s*SPIRIT|\bMOTOR\b/.test(u)) return 'MS';
  if (/HSD|DIESEL|HIGH\s*SPEED/.test(u)) return 'HSD';
  return null;
}

export function productName(key) {
  return PRODUCTS[key]?.name || key || 'Unknown';
}

// ---------------------------------------------------------------------------
// Dip chart: litres at a dip (cm), and the dip for a volume
// ---------------------------------------------------------------------------

export function chartMaxCm(chart) {
  return chart.startCm + (chart.litres.length - 1) * chart.stepCm;
}

export function litresAtDip(chart, cm) {
  if (!chart || !chart.litres?.length || !Number.isFinite(cm) || cm < 0) return null;
  const { startCm, stepCm, litres } = chart;
  if (cm > chartMaxCm(chart) + 1e-9) return null;
  if (cm <= startCm) return round2((litres[0] * cm) / startCm);   // straight down to 0 L at 0 cm
  const pos = (cm - startCm) / stepCm;
  const i = Math.min(Math.floor(pos + 1e-9), litres.length - 2);
  return round2(litres[i] + (litres[i + 1] - litres[i]) * (pos - i));
}

// The dip where the chart first reaches `l` litres (the sheet has a few tiny
// dips of a litre or less, so "first reaches" keeps this well defined).
export function dipAtLitres(chart, l) {
  if (!chart || !chart.litres?.length || !Number.isFinite(l) || l < 0) return null;
  const { startCm, stepCm, litres } = chart;
  if (l <= litres[0]) return (startCm * l) / litres[0];
  for (let i = 1; i < litres.length; i++) {
    if (litres[i] >= l) {
      const a = Math.min(litres[i - 1], l);
      const b = litres[i];
      return startCm + (i - 1 + (b > a ? (l - a) / (b - a) : 1)) * stepCm;
    }
  }
  return null;
}

// Mistakes a chart can have: steps where the litres go down or stay flat.
export function chartIssues(chart) {
  const out = [];
  for (let i = 1; i < chart.litres.length; i++) {
    if (chart.litres[i] <= chart.litres[i - 1]) {
      out.push({ cm: round2(chart.startCm + i * chart.stepCm), litres: chart.litres[i], prev: chart.litres[i - 1] });
    }
  }
  return out;
}

// A chart from uploaded rows [[dipCm, litres], …] (header rows are skipped).
// The dips must be evenly spaced and rising.
export function chartFromRows(rows, name = 'Uploaded chart') {
  const pts = [];
  for (const r of rows || []) {
    const cm = Number(String(r?.[0] ?? '').replace(/,/g, ''));
    const l = Number(String(r?.[1] ?? '').replace(/,/g, ''));
    if (String(r?.[0] ?? '').trim() !== '' && Number.isFinite(cm) && Number.isFinite(l)) pts.push([cm, l]);
  }
  if (pts.length < 10) throw new Error('The chart needs a column of dips (cm) and a column of litres — found too few rows.');
  const step = round2(pts[1][0] - pts[0][0]);
  if (!(step > 0)) throw new Error('The dips must go up row by row.');
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i][0] - pts[i - 1][0] - step) > 1e-6) {
      throw new Error(`The dips must be evenly spaced (every ${step} cm); row ${i + 1} is ${pts[i][0]}.`);
    }
  }
  return { name, startCm: round2(pts[0][0]), stepCm: step, litres: pts.map((p) => round2(p[1])) };
}

// ---------------------------------------------------------------------------
// Invoices: which chamber holds which product
// ---------------------------------------------------------------------------

const toLitres = (kl) => Math.round(Number(kl) * 1000);

// The truck's chambers with the product in each, from the invoice:
//  1. "Comp No(s)" on a product line names its chambers outright;
//  2. otherwise MS fills from chamber 1 upward (C1, C2 … until its quantity),
//     then the other products take the next chambers in invoice order;
//  3. a chamber nothing reaches is empty.
// `vehicle` (one of our own TTs, from Settings) stands in when the invoice has no table.
export function chamberLayout(inv, vehicle) {
  const src = inv?.chambers?.length ? inv.chambers : (vehicle?.chambers || []);
  const chambers = src
    .map((c) => ({ no: Number(c.no), litres: toLitres(c.qty_kl), dipCm: c.dip_cm ?? null, product: null, how: 'empty' }))
    .filter((c) => c.no > 0 && c.litres >= 0)
    .sort((a, b) => a.no - b.no);
  const byNo = new Map(chambers.map((c) => [c.no, c]));
  const problems = [];
  const lines = (inv?.lines || []).map((ln, i) => ({
    i,
    key: productKey(ln.column_key || ln.product) || 'HSD',
    product: ln.product || ln.column_key || '',
    litres: toLitres(ln.qty_kl ?? ln.qty),
    compartments: (ln.compartments || []).map(Number).filter((n) => n > 0),
    density15: ln.density15 ?? null,
    pricePerL: ln.value && Number(ln.qty_kl) ? ln.value / toLitres(ln.qty_kl) : null,
    chambers: [],
  }));

  for (const ln of lines) {
    for (const no of ln.compartments) {
      const c = byNo.get(no);
      if (!c) { problems.push(`The invoice puts ${ln.key} in chamber ${no}, but the truck has no chamber ${no}.`); continue; }
      if (c.product && c.product !== ln.key) problems.push(`Chamber ${no} is listed for both ${c.product} and ${ln.key}.`);
      c.product = ln.key;
      c.how = 'invoice';
    }
  }
  const rest = lines.filter((ln) => !ln.compartments.length)
    .sort((a, b) => (a.key === 'MS' ? 0 : 1) - (b.key === 'MS' ? 0 : 1) || a.i - b.i);
  const free = chambers.filter((c) => !c.product && c.litres > 0);
  let k = 0;
  for (const ln of rest) {
    let got = 0;
    while (k < free.length && got < ln.litres) {
      free[k].product = ln.key;
      free[k].how = ln.key === 'MS' ? 'ms-rule' : 'order';
      got += free[k].litres;
      k += 1;
    }
  }
  for (const ln of lines) {
    ln.chambers = chambers.filter((c) => c.product === ln.key).map((c) => c.no);
  }
  // Two lines of one product share its chambers; check each product's total.
  const byProduct = {};
  for (const ln of lines) byProduct[ln.key] = (byProduct[ln.key] || 0) + ln.litres;
  for (const [key, litres] of Object.entries(byProduct)) {
    const inCh = chambers.filter((c) => c.product === key).reduce((s, c) => s + c.litres, 0);
    if (chambers.length && inCh !== litres) {
      problems.push(`The invoice has ${fmtKL(litres)} of ${key} but its chambers hold ${fmtKL(inCh)} — check the chambers.`);
    }
  }
  if (!chambers.length) problems.push('No chamber details — enter the truck\'s chambers.');
  return { chambers, lines, problems };
}

export function fmtKL(litres) {
  const kl = litres / 1000;
  return `${Number.isInteger(kl) ? kl : kl.toFixed(3).replace(/0+$/, '')} KL`;
}

// Chambers of an invoice already emptied (or being emptied) in a decantation.
export function usedChambers(sessions, invoiceNo, exceptId = null) {
  const used = new Set();
  for (const s of sessions || []) {
    if (s.invoice_no !== invoiceNo || s.id === exceptId || s.status === 'cancelled' || s.status === 'draft') continue;
    for (const p of s.data?.plan || []) if (p.tank) used.add(p.no);
  }
  return used;
}

// A decantation's chambers still in the truck: not decanted before and in none
// of its tanks — held back in the plan, kept for later, or not emptied. They
// can go into a tank at any time, whatever its other tanks are doing.
export function chambersLeft(session) {
  const d = session?.data || {};
  const done = new Set(d.done || []);
  const inTank = new Set((d.tanks || []).flatMap((t) => t.chambers || []));
  return (d.chambers || []).filter((c) => c.product && c.litres > 0 && !done.has(c.no) && !inTank.has(c.no));
}

// 'new' | 'active' | 'partial' | 'done' | 'dismissed' for the "to decant" list.
export function invoiceStatus(inv, sessions, layout) {
  if (inv.dismissed) return 'dismissed';
  const mine = (sessions || []).filter((s) => s.invoice_no === inv.invoice_no && s.status !== 'cancelled');
  if (mine.some((s) => s.status === 'decanting' || s.status === 'settling')) return 'active';
  const used = usedChambers(sessions, inv.invoice_no);
  const loaded = (layout?.chambers || []).filter((c) => c.product && c.litres > 0 && tankProduct(c.product));
  if (loaded.length && loaded.every((c) => used.has(c.no))) return 'done';
  return used.size ? 'partial' : 'new';
}

function tankProduct(key) {
  return Boolean(PRODUCTS[key]);
}

// ---------------------------------------------------------------------------
// Planning: which chamber goes into which tank
// ---------------------------------------------------------------------------

// Best split of one product's chambers over its tanks.
//   chambers: [{no, litres}], tanks: [{id, room}] (room = litres the tank can
//   still take), requests: {tankId: litres} when the user has typed amounts,
//   prefer: the tank whose amount was typed last (it wins a tie).
// With requests: get each tank as close to its amount as possible. Without:
// decant as much as fits while leaving every tank at least `warnRoomL` of room
// (only if nothing fits that way, fill closer to the brim), in as few tanks as
// possible, the tank with the most room taking the first chambers. Never puts
// more in a tank than its room.
// Returns {assign: {no: tankId|null}, perTank: {id: litres}, total}.
export function solvePlan({ chambers, tanks, requests = null, prefer = null, warnRoomL = 150 }) {
  const cs = [...chambers].sort((a, b) => a.no - b.no);
  const ts = tanks.filter((t) => Number.isFinite(t.room));
  const n = cs.length;
  const opts = ts.length + 1;                         // each chamber: a tank, or hold
  let best = null;
  let bestSafe = null;
  const choice = new Array(n).fill(ts.length);
  const limit = opts ** n;
  if (!n || !ts.length || limit > 400000) {
    return greedyPlan(cs, ts, requests);
  }
  for (let code = 0; code < limit; code++) {
    let c = code;
    for (let i = 0; i < n; i++) { choice[i] = c % opts; c = Math.floor(c / opts); }
    const per = new Array(ts.length).fill(0);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const t = choice[i];
      if (t < ts.length) {
        per[t] += cs[i].litres;
        if (per[t] > ts[t].room + 1e-6) { ok = false; break; }
      }
    }
    if (!ok) continue;
    const score = scorePlan(cs, ts, choice, per, requests, warnRoomL, prefer);
    const cand = { score, choice: [...choice], per };
    if (!best || lexLess(score, best.score)) best = cand;
    if (!requests && score[1] === 0 && (!bestSafe || lexLess(score, bestSafe.score))) bestSafe = cand;
  }
  if (bestSafe && -bestSafe.score[0] > 0) best = bestSafe;
  const assign = {};
  cs.forEach((c, i) => { assign[c.no] = best.choice[i] < ts.length ? ts[best.choice[i]].id : null; });
  const perTank = {};
  ts.forEach((t, j) => { perTank[t.id] = best.per[j]; });
  return { assign, perTank, total: best.per.reduce((a, b) => a + b, 0) };
}

function scorePlan(cs, ts, choice, per, requests, warnRoomL, prefer) {
  const total = per.reduce((a, b) => a + b, 0);
  let switches = 0;
  for (let i = 1; i < cs.length; i++) if (choice[i] !== choice[i - 1]) switches += 1;
  const used = per.filter((p) => p > 0).length;
  // Chambers in order, the roomiest tank first, holding back the last ones:
  // read the choices as digits (0 = most room … hold = last) — smaller wins.
  const rank = ts.map((t, j) => j).sort((a, b) => ts[b].room - ts[a].room || a - b);
  const rankOf = new Map(rank.map((j, r) => [j, r]));
  let order = 0;
  for (let i = 0; i < cs.length; i++) order = order * (ts.length + 1) + (choice[i] === ts.length ? ts.length : rankOf.get(choice[i]));
  if (requests) {
    let miss = 0;
    let missPrefer = 0;
    ts.forEach((t, j) => {
      const m = Math.abs(per[j] - (Number(requests[t.id]) || 0));
      miss += m;
      if (t.id === prefer) missPrefer = m;
    });
    return [missPrefer, miss, switches, order];
  }
  let tight = 0;
  ts.forEach((t, j) => { if (per[j] > 0 && t.room - per[j] < warnRoomL) tight += 1; });
  // [1] is the brim-full count (solvePlan reads it); the rest break ties.
  return [-total, tight, used, switches, order];
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-9) return true;
    if (a[i] > b[i] + 1e-9) return false;
  }
  return false;
}

function greedyPlan(cs, ts, requests) {
  const perTank = Object.fromEntries(ts.map((t) => [t.id, 0]));
  const assign = {};
  for (const c of cs) {
    const t = ts.find((x) => perTank[x.id] + c.litres <= x.room
      && (!requests || perTank[x.id] + c.litres <= (Number(requests[x.id]) || 0)));
    assign[c.no] = t ? t.id : null;
    if (t) perTank[t.id] += c.litres;
  }
  return { assign, perTank, total: Object.values(perTank).reduce((a, b) => a + b, 0) };
}

// A plan row per chamber, filled with the best split for every product.
//   layout: chamberLayout(); readings: {tankId: reading}; exclude: chamber nos
//   already decanted; requests: {tankId: litres} typed by the user (optional).
export function suggestPlan({ layout, tanks, readings, exclude = new Set(), requests = null, busy = new Set(), settings }) {
  const s = settings || DEFAULT_SETTINGS;
  const plan = [];
  const products = [...new Set(layout.chambers.map((c) => c.product).filter(Boolean))];
  for (const key of products) {
    const chambers = layout.chambers.filter((c) => c.product === key && c.litres > 0 && !exclude.has(c.no));
    const ts = tanks.filter((t) => t.product === key && !busy.has(t.id)).map((t) => ({ id: t.id, room: roomOf(readings?.[t.id], t) }));
    const avail = ts.filter((t) => Number.isFinite(t.room));
    let assign = {};
    if (avail.length && chambers.length) {
      const req = requests ? Object.fromEntries(avail.map((t) => [t.id, requests[t.id] ?? 0])) : null;
      ({ assign } = solvePlan({ chambers, tanks: avail, requests: req, warnRoomL: s.warnRoomL }));
    }
    for (const c of chambers) plan.push({ no: c.no, product: key, litres: c.litres, tank: assign[c.no] ?? null });
  }
  return plan.sort((a, b) => a.no - b.no);
}

// Litres a tank can still take: up to its fill limit (20,500 L for our 20 KL
// tanks) — so more than the automation's ullage, which is measured to 20,000 L.
export function roomOf(reading, tank) {
  if (!reading || !Number.isFinite(reading.volume)) return NaN;
  return round2((tank ? fillLimit(tank) : reading.capacity || 20000) - reading.volume);
}

// For the internal audit: what's behind a stock reading. An automation
// screenshot (also when a misread figure was corrected by hand — the
// automation has its data errors; the screen's figure is kept) or a physical
// dip is proof the stock was genuine; litres typed in by hand are not.
// Returns {proof, short, label, text}, or null for a reading with no source.
export function stockProof(r) {
  const litres = (v) => `${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} L`;
  switch (r?.source) {
    case 'photo':
      return { proof: true, short: 'screenshot', label: 'Screenshot', text: 'read from the automation screenshot' };
    case 'photo-edited': {
      const was = Number.isFinite(r.screenVolume) ? ` (the screen said ${litres(r.screenVolume)})` : '';
      return { proof: true, short: 'screenshot, corrected', label: `Screenshot, corrected by hand${was}`, text: `from the automation screenshot, corrected by hand${was}` };
    }
    case 'dip': {
      const cm = Number.isFinite(r.dip) ? `${r.dip} cm` : '';
      return { proof: true, short: cm ? `dip ${cm}` : 'dip', label: `Dip${cm ? ` ${cm}` : ''}`, text: `from a physical dip${cm ? ` of ${cm}` : ''} (litres by the dip chart)` };
    }
    case 'litres':
      return { proof: false, short: 'typed, no proof', label: 'Typed litres — no solid proof', text: 'litres typed in by hand — no solid proof' };
    default:
      return null;
  }
}

// A decantation's stock readings with no proof: [{tank, tankNo, which: 'before' | 'after'}].
export function unprovenReadings(tanks) {
  const out = [];
  for (const t of tanks || []) {
    for (const which of ['before', 'after']) if (stockProof(t[which])?.proof === false) out.push({ tank: t.tank, tankNo: t.tankNo, which });
  }
  return out;
}

// Everything that should stop or slow down a decantation, per tank.
export function checkPlan({ plan, tanks, readings, busy = new Set(), settings, now = Date.now(), chart = null }) {
  const s = settings || DEFAULT_SETTINGS;
  const blocking = [];
  const warnings = [];
  const perTank = [];
  const byId = new Map(tanks.map((t) => [t.id, t]));
  for (const p of plan) {
    const t = p.tank && byId.get(p.tank);
    if (p.tank && !t) blocking.push(`Chamber ${p.no}: unknown tank ${p.tank}.`);
    if (t && t.product !== p.product) {
      blocking.push(`Chamber ${p.no} holds ${p.product} — it can't go into Tank ${t.no} (${t.product}).`);
    }
  }
  for (const t of tanks) {
    const rows = plan.filter((p) => p.tank === t.id);
    if (!rows.length) continue;
    const litres = rows.reduce((a, p) => a + p.litres, 0);
    const r = readings?.[t.id];
    const row = { tank: t.id, no: t.no, product: t.product, litres, chambers: rows.map((p) => p.no), level: 'ok' };
    if (busy.has(t.id)) blocking.push(`Tank ${t.no} is already being decanted — finish that first.`);
    if (!r || !Number.isFinite(r.volume)) {
      blocking.push(`Add Tank ${t.no}'s stock before decanting.`);
      row.level = 'noreading';
      perTank.push(row);
      continue;
    }
    const room = roomOf(r, t);
    row.room = room;
    row.before = r.volume;
    row.after = round2(r.volume + litres);
    row.leftRoom = round2(room - litres);
    if (chart) {
      row.beforeDip = dipAtLitres(chart, r.volume);
      row.afterDip = dipAtLitres(chart, row.after);
    }
    if (litres > room + 1e-6) {
      row.level = 'over';
      blocking.push(`Tank ${t.no} has room for ${fmtL(room)}; ${fmtL(litres)} is planned. Hold a chamber back.`);
    } else if (row.leftRoom < s.warnRoomL) {
      row.level = 'tight';
      warnings.push(`Tank ${t.no} will be nearly full (${fmtL(row.leftRoom)} room left).`);
    }
    if (r.water > 0) warnings.push(`Tank ${t.no} shows ${fmtL(r.water)} of water.`);
    if (r.status && r.status !== 'ONLINE') warnings.push(`Tank ${t.no}'s probe is ${r.status}.`);
    if (r.readingAt) {
      const age = (now - Date.parse(r.readingAt)) / 60000;
      if (age > s.staleMinutes) warnings.push(`Tank ${t.no}'s reading is ${fmtAge(age)} old — take a fresh screenshot if stock has moved.`);
      if (age < -5) warnings.push(`Tank ${t.no}'s reading time is ahead of this phone's clock.`);
    }
    perTank.push(row);
  }
  if (!plan.some((p) => p.tank)) blocking.push('Pick at least one chamber to decant.');
  return { perTank, blocking, warnings };
}

export function fmtAge(minutes) {
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

export function fmtL(l) {
  if (!Number.isFinite(l)) return '—';
  return `${Math.round(l).toLocaleString('en-IN')} L`;
}

// ---------------------------------------------------------------------------
// Results: stock after vs stock before + what was decanted
// ---------------------------------------------------------------------------

// Where one tank of a decantation is: 'waiting' (planned, not started yet),
// 'decanting', 'settling' (done, no stock after yet) or 'read'. Tanks can go
// one at a time — each with its own stock before (taken just before it starts,
// as it sells until then) and after. Rows saved before that have no stage:
// their tanks all started and finished together.
export function tankStage(session, row) {
  if (row?.stage) return row.stage;
  if (session?.status === 'decanting') return 'decanting';
  if (session?.status === 'draft') return 'waiting';
  return row?.after ? 'read' : 'settling';
}

// ---------------------------------------------------------------------------
// Decanting time: one pipe per tank, moved from chamber to chamber
// ---------------------------------------------------------------------------

// Seconds a chamber of `litres` takes to empty: the settings' 5 KL and 4 KL
// times, other sizes on the straight line through them (4.5 KL: 7:38).
export function chamberSeconds(litres, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const t5 = Number(s.emptySecs5) > 0 ? Number(s.emptySecs5) : DEFAULT_SETTINGS.emptySecs5;
  const t4 = Number(s.emptySecs4) > 0 ? Number(s.emptySecs4) : DEFAULT_SETTINGS.emptySecs4;
  const per = (t5 - t4) / 1000;
  const secs = per >= 0 ? t4 + (litres - 4000) * per
    : litres <= 4500 ? (t4 * litres) / 4000 : (t5 * litres) / 5000;   // a 5 KL set quicker than a 4 KL: pro rata
  return Math.max(30, Math.round(secs));
}

// Seconds to move the pipe to the tank's next chamber (Settings; 0:45).
export function pipeMoveSeconds(settings) {
  const v = Number((settings || DEFAULT_SETTINGS).pipeMoveSecs);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.pipeMoveSecs;
}

// The pipe's round for one tank being decanted: its chambers one after
// another, in the order they were put in — a chamber added while it decants
// goes last, from when it was added. Between two chambers the pipe is moved
// (the emptied chamber's valve closed, the hose carried to the next one,
// coupled and its valve opened), which takes the Settings' pipe time.
// [{no, litres, moveAt, from, to}], times in ms; moveAt: when the pipe
// starts moving onto this chamber (null for the first).
export function drainTimeline(row, chambers, settings) {
  const start = Date.parse(row?.startedAt || '');
  if (!Number.isFinite(start)) return [];
  const move = pipeMoveSeconds(settings) * 1000;
  let at = start;
  return (row.chambers || []).map((no, i) => {
    const litres = (chambers || []).find((c) => c.no === no)?.litres || 0;
    const joined = Date.parse(row.joinedAt?.[no] || '');
    const ready = Number.isFinite(joined) ? Math.max(at, joined) : at;   // the last one empty, and this one added
    const moveAt = i === 0 ? null : ready;
    const from = i === 0 ? ready : ready + move;
    const to = from + chamberSeconds(litres, settings) * 1000;
    at = to;
    return { no, litres, moveAt, from, to };
  });
}

// Where that round is at `now`: the chamber the pipe is on or being moved to
// (the last one once all are empty), how far each chamber has emptied (0 full
// … 1 empty), the litres in the tank so far, the time left (ms), whether it
// flows now, whether all should be empty, and — while the pipe is being
// moved — {from, to, at, until}: the chambers and the move's times (ms).
export function drainAt(timeline, now) {
  if (!timeline?.length) return null;
  const part = (w) => Math.min(1, Math.max(0, (now - w.from) / (w.to - w.from)));
  const last = timeline[timeline.length - 1];
  const i = timeline.findIndex((w) => w.moveAt !== null && w.moveAt !== undefined && now >= w.moveAt && now < w.from);
  const moving = i > 0 ? { from: timeline[i - 1].no, to: timeline[i].no, at: timeline[i].moveAt, until: timeline[i].from } : null;
  return {
    on: (timeline.find((w) => now < w.to) || last).no,
    drained: Object.fromEntries(timeline.map((w) => [w.no, part(w)])),
    litres: timeline.reduce((a, w) => a + w.litres * part(w), 0),
    left: Math.max(0, last.to - now),
    flowing: now < last.to && !moving,
    done: now >= last.to,
    moving,
  };
}

// 495 -> "8:15"
export function fmtMinSec(secs) {
  const r = Math.round(secs);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}

// variation = (after − before) − decanted; negative = the tank got less than
// the chambers held (short). The automation blocks sales from a tank while it
// is decanted, so nothing is sold in between (`salesL` is only for records
// saved by the first version, which asked for it).
export function tankResult({ litres, before, after, salesL = 0 }, settings) {
  const s = settings || DEFAULT_SETTINGS;
  if (!before || !after || !Number.isFinite(before.volume) || !Number.isFinite(after.volume)) return null;
  const gain = round2(after.volume - before.volume);
  const expected = round2(litres - (Number(salesL) || 0));
  const variation = round2(gain - expected);
  const pct = pctOf(variation, litres);
  const tol = Math.max(s.toleranceMinL, (litres * s.tolerancePct) / 100);
  const abs = Math.abs(variation);
  const band = abs <= tol ? 'ok' : abs <= 2 * tol ? 'watch' : 'high';
  return { gain, expected, variation, pct, tol: round2(tol), band, direction: variation < 0 ? 'short' : variation > 0 ? 'excess' : 'exact' };
}

// ---------------------------------------------------------------------------
// Time (the pump and the automation are on IST)
// ---------------------------------------------------------------------------

const IST_MS = 330 * 60000;

// 'YYYY-MM-DD' of an instant in IST.
export function istDate(t) {
  const d = new Date((typeof t === 'number' ? t : Date.parse(t)) + IST_MS);
  return d.toISOString().slice(0, 10);
}

export function istISO(y, mo, d, h = 0, mi = 0, s = 0) {
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}+05:30`;
}

// dd/mm/yyyy (invoice dates) -> 'YYYY-MM-DD'
export function dmyToIso(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

// ---------------------------------------------------------------------------
// Density check of the truck's product (optional, before decanting)
// ---------------------------------------------------------------------------

// ASTM D1250 / IP 200 Table 53B (generalised products): density at 15 °C from a
// glass-hydrometer reading (kg/m³) at t °C. The reading is first corrected for
// the hydrometer glass, then the volume correction factor is solved for.
export function density15From(reading, tempC) {
  if (!(reading > 500 && reading < 1200) || !Number.isFinite(tempC)) return null;
  const dt = tempC - 15;
  const rhoT = reading * (1 - 0.000023 * dt - 0.00000002 * dt * dt);
  let rho = rhoT;
  for (let i = 0; i < 50; i++) {
    let alpha;
    if (rho < 770.5) alpha = 346.4228 / (rho * rho) + 0.4388 / rho;        // gasolines
    else if (rho < 787.5) alpha = -0.00336312 + 2680.3206 / (rho * rho);    // transition zone
    else if (rho < 839) alpha = 594.5418 / (rho * rho);                      // kerosene / diesel band
    else alpha = 186.9696 / (rho * rho) + 0.4862 / rho;                     // fuel oils
    const vcf = Math.exp(-alpha * dt * (1 + 0.8 * alpha * dt));
    const next = rhoT / vcf;
    if (Math.abs(next - rho) < 1e-7) { rho = next; break; }
    rho = next;
  }
  return Math.round(rho * 10) / 10;
}

// {d15, diff, ok} against the invoice's Density@15 (limit ± limitKg, usually 3).
export function densityCheck({ reading, tempC, invoice15, limitKg = 3 }) {
  const d15 = density15From(Number(reading), Number(tempC));
  if (d15 === null || !(invoice15 > 0)) return null;
  const diff = Math.round((d15 - invoice15) * 10) / 10;
  return { d15, diff, ok: Math.abs(diff) <= limitKg };
}

// ---------------------------------------------------------------------------
// After decanting: did the chambers go where the plan said?
// ---------------------------------------------------------------------------

// Which chambers most likely went into which tank, from what each tank
// actually gained (after − before + sold while decanting).
//   chambers: [{no, litres}], tanks: [{id, gain}]
// Returns {assign: {no: id}, perTank: {id: litres}, miss: Σ|gain − litres|}.
export function guessRouting(chambers, tanks) {
  const cs = [...chambers].sort((a, b) => a.no - b.no);
  const k = tanks.length;
  const n = cs.length;
  if (!k || !n || k ** n > 400000) return null;
  let best = null;
  const choice = new Array(n).fill(0);
  for (let code = 0; code < k ** n; code++) {
    let c = code;
    for (let i = 0; i < n; i++) { choice[i] = c % k; c = Math.floor(c / k); }
    const per = new Array(k).fill(0);
    cs.forEach((ch, i) => { per[choice[i]] += ch.litres; });
    const miss = per.reduce((a, p, j) => a + Math.abs(tanks[j].gain - p), 0);
    let switches = 0;
    for (let i = 1; i < n; i++) if (choice[i] !== choice[i - 1]) switches += 1;
    if (!best || miss < best.miss - 1e-6 || (Math.abs(miss - best.miss) < 1e-6 && switches < best.switches)) {
      best = { miss, switches, choice: [...choice], per };
    }
  }
  const assign = {};
  cs.forEach((ch, i) => { assign[ch.no] = tanks[best.choice[i]].id; });
  return { assign, perTank: Object.fromEntries(tanks.map((t, j) => [t.id, best.per[j]])), miss: round2(best.miss) };
}

// A better explanation for a product's after-stock than the plan, if there is
// one: the chambers went differently (two tanks way off in opposite directions
// that nearly cancel). rows: the session's tanks of one product, with after
// readings. Returns {assign, perTank, missNow, missThen} or null.
export function routingHint(rows, chambersByNo, settings = DEFAULT_SETTINGS) {
  if (rows.length < 2 || !rows.every((r) => r.after && r.before)) return null;
  const tanks = rows.map((r) => ({ id: r.tank, gain: r.after.volume - r.before.volume + (Number(r.salesL) || 0) }));
  const chambers = rows.flatMap((r) => r.chambers.map((no) => ({ no, litres: chambersByNo[no] })));
  if (chambers.some((c) => !Number.isFinite(c.litres))) return null;       // a chamber's litres unknown: no guessing
  const missNow = round2(rows.reduce((a, r, j) => a + Math.abs(tanks[j].gain - r.litres), 0));
  const g = guessRouting(chambers, tanks);
  if (!g) return null;
  const tol = Math.max(settings.toleranceMinL, (chambers.reduce((a, c) => a + c.litres, 0) * settings.tolerancePct) / 100);
  const changed = rows.some((r) => r.chambers.some((no) => g.assign[no] !== r.tank));
  if (!changed || g.miss > missNow * 0.5 || missNow - g.miss < 4 * tol) return null;
  return { ...g, missNow, missThen: g.miss };
}

// ---------------------------------------------------------------------------
// Planning the dispensing: room for the indents placed
// ---------------------------------------------------------------------------

// The KL an indent brings.
export function indentKL(p) {
  if (p?.kind === 'transport') return round2(Object.values(p.qty || {}).reduce((a, v) => a + (Number(v) || 0), 0));
  return round2((p?.chambers || []).filter((c) => c.product).reduce((a, c) => a + (Number(c.litres) || 0), 0) / 1000);
}

// The standard layouts for a transport TT bringing `kl` (the smallest size
// that holds it). A transport TT comes full, so nothing under the smallest
// size (20 KL) is one.
export function transportOptions(kl, table = DEFAULT_SETTINGS.transportTTs) {
  const sizes = Object.keys(table || {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const size = kl >= sizes[0] - 0.001 ? sizes.find((n) => n >= kl - 0.001) : null;
  return size ? { size, layouts: table[size] } : { size: null, layouts: [] };
}

// The smallest transport TT (KL).
export const smallestTransport = (table = DEFAULT_SETTINGS.transportTTs) => Math.min(...Object.keys(table || {}).map(Number).filter((n) => n > 0));

// A transport TT with these chambers (KL) carrying `qty` (KL per product), in
// whole chambers as the terminal loads them: MS from chamber 1 up, then HSD,
// then XtraGreen, each taking the run of chambers that comes closest to its KL
// (a tie takes the extra chamber) — so 5 MS + 17 HSD in 4.5×4 + 4 comes as
// 4.5 + 17.5. `left` is the part of the indent the chambers can't carry.
export function loadChambers(caps, qty) {
  const chambers = [];
  let i = 0;
  let want = 0;
  for (const p of ['MS', 'HSD', 'XG']) {
    const need = Math.round((Number(qty?.[p]) || 0) * 1000);
    if (need <= 0) continue;
    want += need;
    let got = 0;
    while (i < caps.length) {
      const litres = Math.round(caps[i] * 1000);
      if (got > 0 && Math.abs(got + litres - need) > Math.abs(got - need)) break;
      chambers.push({ no: i + 1, litres, product: p });
      got += litres;
      i += 1;
    }
  }
  return { chambers, left: Math.max(0, want - chambers.reduce((a, c) => a + c.litres, 0)) };
}

// Amounts one tank can take from these chambers (whole chambers), ascending.
function subsetSums(litres) {
  let sums = new Set([0]);
  for (const l of litres) {
    const next = new Set(sums);
    for (const x of sums) next.add(round2(x + l));
    sums = next;
  }
  return [...sums].sort((a, b) => a - b);
}

// The least to dispense from each of a product's tanks so the chambers fit
// whichever way they come (`ways`: chamber litres, one list per way). `rooms`:
// what each tank can take now, after the margin. Exact for one or two tanks.
function dispenseFor(ways, rooms) {
  const totals = ways.map((w) => w.reduce((a, b) => a + b, 0));
  if (rooms.length === 1) return [round2(Math.max(0, ...totals.map((L) => (L > 0 ? L - rooms[0] : 0))))];
  if (rooms.length === 2) {
    const sums = ways.map(subsetSums);
    const cands = new Set([0]);
    for (const S of sums) for (const x of S) if (x > 0 && x > rooms[0]) cands.add(round2(x - rooms[0]));
    let best = null;
    for (const d0 of [...cands].sort((a, b) => a - b)) {
      let d1 = 0;
      sums.forEach((S, w) => {
        let x = 0;                       // the most the first tank can take (nothing always fits)
        for (const v of S) if (v <= rooms[0] + d0 + 0.005) x = v;
        const rest = round2(totals[w] - x);
        if (rest > 0) d1 = Math.max(d1, rest - rooms[1]);
      });
      d1 = round2(Math.max(0, d1));
      const tot = round2(d0 + d1);
      const most = Math.max(d0, d1);
      if (!best || tot < best.tot - 0.005 || (Math.abs(tot - best.tot) <= 0.005 && most < best.most - 0.005)) best = { d: [d0, d1], tot, most };
    }
    return best.d;
  }
  // three or more tanks: what each tank needs in the worst way
  const d = rooms.map(() => 0);
  for (const w of ways) {
    const best = splitForRoom(w.map((litres, i) => ({ no: i + 1, litres })), rooms.map((room, j) => ({ id: j, room })));
    rooms.forEach((room, j) => { d[j] = Math.max(d[j], (best.perTank[j] || 0) > 0 ? round2((best.perTank[j] || 0) - room) : 0); });
  }
  return d.map((x) => Math.max(0, x));
}

// How much to dispense from each tank so every indent's load fits, each tank
// keeping `margin` litres free. An indent on one of our own TTs has known
// chambers; a transport TT can come with any standard layout of its size, so
// the plan fits every way the loads can come. All the chambers of a product
// are split over its tanks together, for the least dispensing in all.
//   indents: [{id, kind: 'own' | 'transport', chambers (own), qty (transport)}]
//   stock:   {tankId: {volume, ullage}}
// Returns {tanks: {id: {now, room, sell, incoming: [least, most], after: [least, most], spare}},
//          products: {P: {incoming, sell}},
//          ways: [[{caps, left, unknown, split: {no: tankId}, noTank: [no]}]] — one list per way the indents can come,
//          missing: [tankId without stock]}.
export function planIndents({ indents, tanks, stock, margin = 150, table = DEFAULT_SETTINGS.transportTTs }) {
  const list = indents || [];
  let combos = [[]];
  for (const p of list) {
    let opts;
    if (p.kind === 'transport') {
      opts = transportOptions(indentKL(p), table).layouts.map((caps) => ({ caps, ...loadChambers(caps, p.qty) }));
      if (!opts.length) opts = [{ caps: null, chambers: [], left: Math.round(indentKL(p) * 1000), unknown: true }];
    } else {
      opts = [{ caps: null, chambers: (p.chambers || []).filter((c) => c.product && c.litres > 0), left: 0 }];
    }
    combos = combos.flatMap((c) => opts.map((o) => [...c, o])).slice(0, 64);
  }
  const out = {
    tanks: {}, products: {}, missing: [],
    ways: combos.map((c) => c.map((o) => ({ caps: o.caps, left: o.left, unknown: Boolean(o.unknown), split: {}, noTank: [] }))),
  };
  const room = {};
  for (const t of tanks) {
    const r = stock?.[t.id];
    if (!r || !Number.isFinite(r.volume)) { out.missing.push(t.id); continue; }
    const ull = roomOf(r, t);
    room[t.id] = ull - margin;
    out.tanks[t.id] = { now: r.volume, room: ull, sell: 0, incoming: [0, 0], after: [r.volume, r.volume], spare: ull };
  }
  const products = [...new Set(combos.flatMap((c) => c.flatMap((o) => o.chambers.map((ch) => ch.product))))];
  for (const p of products) {
    const ts = tanks.filter((t) => t.product === p && Number.isFinite(room[t.id]));
    const chs = combos.map((c) => c.flatMap((o, li) => o.chambers.filter((ch) => ch.product === p)
      .sort((a, b) => a.no - b.no).map((ch) => ({ li, cno: ch.no, litres: ch.litres }))));
    if (!ts.length) {
      chs.forEach((cs, w) => cs.forEach((x) => out.ways[w][x.li].noTank.push(x.cno)));
      continue;
    }
    const rooms = ts.map((t) => room[t.id]);
    const d = dispenseFor(chs.map((cs) => cs.map((x) => x.litres)), rooms);
    out.products[p] = { incoming: Math.max(...chs.map((cs) => cs.reduce((a, x) => a + x.litres, 0))), sell: round2(d.reduce((a, b) => a + b, 0)) };
    const inc = ts.map(() => [Infinity, 0]);
    chs.forEach((cs, w) => {
      if (!cs.length) return;
      const best = splitForRoom(cs.map((x, i) => ({ no: i + 1, litres: x.litres })), ts.map((t, j) => ({ id: t.id, room: rooms[j] + d[j] + 0.01 })));
      cs.forEach((x, i) => { out.ways[w][x.li].split[x.cno] = best.assign[i + 1]; });
      ts.forEach((t, j) => {
        const v = best.perTank[t.id] || 0;
        inc[j] = [Math.min(inc[j][0], v), Math.max(inc[j][1], v)];
      });
    });
    ts.forEach((t, j) => {
      const row = out.tanks[t.id];
      const [lo, hi] = inc[j][0] === Infinity ? [0, 0] : inc[j];
      row.sell = d[j];
      row.incoming = [lo, hi];
      row.after = [round2(row.now - d[j] + lo), round2(row.now - d[j] + hi)];
      row.spare = round2(row.room - hi + d[j]);        // the least room left, whichever way it comes
    });
  }
  return out;
}

// An indent's load has come in when its invoice arrives: for one of our own
// TTs, the next invoice for that TT; for a transport TT, the next invoice from
// a TT that isn't ours (the closest in quantity first). Only invoices that came
// into the app after the indent was added, and were made no earlier than 15 min
// before it, count — so a TT's previous trip never clears its next indent.
// Returns Map(indent id -> invoice).
export function matchIndents(indents, invoices, ownList = []) {
  const own = new Set(ownList.map(normTT));
  const at = (i) => Date.parse(`${dmyToIso(i.invoice_date)}T${i.invoice_time || '00:00'}:00+05:30`) || Date.parse(i.created_at || 0) || 0;
  const kl = (i) => (i.lines || []).reduce((a, l) => a + (Number(l.qty_kl ?? l.qty) || 0), 0);
  const hidden = (i) => i.dismissed && (i.dismiss_reason ? i.dismiss_reason !== 'outside' : !/before the app|outside the app/i.test(i.note || ''));
  const used = new Set();
  const out = new Map();
  for (const p of [...(indents || [])].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    const made = Date.parse(p.created_at || 0);
    if (!made) continue;
    const skip = new Set(p.ignore || []);
    const want = indentKL(p);
    const cands = (invoices || []).filter((i) => !used.has(i.invoice_no) && !skip.has(i.invoice_no) && !hidden(i)
      && Date.parse(i.created_at || 0) > made && at(i) >= made - 15 * 60000
      && (p.kind === 'transport' ? !own.has(normTT(i.tt_no)) : normTT(i.tt_no) === normTT(p.tt_no)))
      .sort((a, b) => (p.kind === 'transport' ? Math.abs(kl(a) - want) - Math.abs(kl(b) - want) : 0) || at(a) - at(b));
    if (cands.length) {
      used.add(cands[0].invoice_no);
      out.set(p.id, cands[0]);
    }
  }
  return out;
}

// Every chamber goes in (nothing is held back): the split needing the least
// selling, then the least from any one tank, then chambers in order with the
// roomiest tank first.
function splitForRoom(chambers, tanks) {
  const cs = [...chambers].sort((a, b) => a.no - b.no);
  const k = tanks.length;
  const n = cs.length;
  const perOf = (choice) => {
    const per = new Array(k).fill(0);
    cs.forEach((c, i) => { per[choice[i]] += c.litres; });
    return per;
  };
  if (k === 1 || k ** n > 200000) {
    // one tank (or too many to try): fill the roomiest first, in order
    const order = tanks.map((t, j) => j).sort((a, b) => tanks[b].room - tanks[a].room);
    const choice = cs.map(() => order[0]);
    if (k > 1) {
      const per = new Array(k).fill(0);
      cs.forEach((c, i) => {
        const j = order.find((x) => per[x] + c.litres <= tanks[x].room) ?? order[0];
        choice[i] = j;
        per[j] += c.litres;
      });
    }
    const per = perOf(choice);
    return { assign: Object.fromEntries(cs.map((c, i) => [c.no, tanks[choice[i]].id])), perTank: Object.fromEntries(tanks.map((t, j) => [t.id, per[j]])) };
  }
  const rank = tanks.map((t, j) => j).sort((a, b) => tanks[b].room - tanks[a].room || a - b);
  const rankOf = new Map(rank.map((j, r) => [j, r]));
  const choice = new Array(n).fill(0);
  let best = null;
  for (let code = 0; code < k ** n; code++) {
    let c = code;
    for (let i = 0; i < n; i++) { choice[i] = c % k; c = Math.floor(c / k); }
    const per = perOf(choice);
    const sells = per.map((v, j) => (v > 0 ? Math.max(0, v - tanks[j].room) : 0));
    let switches = 0;
    for (let i = 1; i < n; i++) if (choice[i] !== choice[i - 1]) switches += 1;
    let order = 0;
    for (let i = 0; i < n; i++) order = order * k + rankOf.get(choice[i]);
    const score = [sells.reduce((a, b) => a + b, 0), Math.max(...sells), switches, order];
    if (!best || lexLess(score, best.score)) best = { score, choice: [...choice], per };
  }
  return {
    assign: Object.fromEntries(cs.map((c, i) => [c.no, tanks[best.choice[i]].id])),
    perTank: Object.fromEntries(tanks.map((t, j) => [t.id, best.per[j]])),
  };
}

// Our own delivery tankers (from the Loading app): how much each can still
// take — capacity minus what's in it. `exclude` lists plates always left out
// (Settings); `off` the ones marked not available to load now ({plate: {at,
// by}}, shared by every phone) — listed, but not counted. Available ones
// first, the roomiest on top. free: what the available ones can take.
export function tankerSpace(vehicles, exclude = [], off = {}) {
  const norm = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ex = new Set(exclude.map(norm));
  const offs = new Map(Object.entries(off || {}).map(([k, v]) => [norm(k), v || {}]));
  const rows = [];
  const excluded = [];
  for (const v of vehicles || []) {
    if (ex.has(norm(v.plate))) { excluded.push(v.plate); continue; }
    const caps = (v.caps || []).map(Number).filter((x) => x > 0);
    const capacity = caps.reduce((a, b) => a + b, 0);
    const filled = caps.reduce((a, cap, i) => a + Math.min(cap, Math.max(0, Number(v.fill?.[`C${i + 1}`]) || 0)), 0);
    const mark = offs.get(norm(v.plate)) || null;
    rows.push({ plate: v.plate, capacity, filled: round2(filled), free: round2(capacity - filled), available: !mark, off: mark });
  }
  rows.sort((a, b) => b.available - a.available || b.free - a.free || (a.plate < b.plate ? -1 : 1));
  const sum = (list) => round2(list.reduce((a, r) => a + r.free, 0));
  const unavailable = rows.filter((r) => !r.available);
  return { rows, free: sum(rows.filter((r) => r.available)), freeAll: sum(rows), unavailable, excluded };
}
