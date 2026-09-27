// Tanker decanting — the rules, with no DOM and no network (tested under Node).

export const PRODUCTS = {
  MS: { key: 'MS', name: 'Petrol (MS)', short: 'MS', screen: 'Motor Spirit' },
  HSD: { key: 'HSD', name: 'Diesel (HSD)', short: 'HSD', screen: 'High Speed Diesel' },
  XG: { key: 'XG', name: 'XtraGreen', short: 'XG', screen: 'XtraGreen' },
};

export const DEFAULT_TANKS = [
  { id: 'T1', no: 1, product: 'MS', capacity: 20000 },
  { id: 'T2', no: 2, product: 'HSD', capacity: 20000 },
  { id: 'T3', no: 3, product: 'HSD', capacity: 20000 },
  { id: 'T4', no: 4, product: 'XG', capacity: 20000 },
];

export const DEFAULT_SETTINGS = {
  tanks: DEFAULT_TANKS,
  tolerancePct: 0.25,   // a variation within max(tolerancePct % of the load, toleranceMinL) is "OK"
  toleranceMinL: 25,
  warnRoomL: 150,       // warn when a tank would be left with less room than this
  staleMinutes: 30,     // a stock reading older than this is flagged before decanting
  settleMinutes: 10,    // suggested wait after decanting before the "after" screenshot
  retentionDays: 31,    // the log keeps one month
  pendingDays: 3,       // older undecanted invoices fold away under "Older"
  dateOrder: 'MDY',     // the automation prints dates as MM/DD/YYYY
  densityLimit: 3,      // truck density vs the invoice's Density@15, ± kg/m³
};

export function settingsWith(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  if (!Array.isArray(s.tanks) || !s.tanks.length) s.tanks = DEFAULT_TANKS;
  s.tanks = s.tanks.map((t, i) => ({
    id: String(t.id || `T${i + 1}`),
    no: Number(t.no) || i + 1,
    product: PRODUCTS[t.product] ? t.product : 'HSD',
    capacity: Number(t.capacity) > 0 ? Number(t.capacity) : 20000,
  }));
  return s;
}

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
// `vehicle` (the truck's saved layout) stands in when the invoice has no table.
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

// Litres a tank can still take (its automation "ullage"; else capacity − volume).
export function roomOf(reading, tank) {
  if (!reading || !Number.isFinite(reading.volume)) return NaN;
  if (Number.isFinite(reading.ullage)) return reading.ullage;
  return (tank?.capacity || reading.capacity || 20000) - reading.volume;
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

// variation = (after − before) − (decanted − sold during decanting);
// negative = the tank got less than the chambers held (short).
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
  const missNow = round2(rows.reduce((a, r, j) => a + Math.abs(tanks[j].gain - r.litres), 0));
  const g = guessRouting(chambers, tanks);
  if (!g) return null;
  const tol = Math.max(settings.toleranceMinL, (chambers.reduce((a, c) => a + c.litres, 0) * settings.tolerancePct) / 100);
  const changed = rows.some((r) => r.chambers.some((no) => g.assign[no] !== r.tank));
  if (!changed || g.miss > missNow * 0.5 || missNow - g.miss < 4 * tol) return null;
  return { ...g, missNow, missThen: g.miss };
}
