// Things the workbook doesn't hold, set in the app (Setup tab) and kept in the
// database: each route's distance, driver salary and diesel allotment, which
// vehicles count in the tyre / fastag analysis, and how driver pay is read.
// Then the checks built on them: km per trip, the driver salary check and
// the fastag / tyre trend check. Pure functions (the tests import them).

import { daysBetween, monthOf } from './util.js';

// Tyres on these vehicles aren't charged by SSFC month by month, so they're
// left out of the tyre analysis until switched on in Setup.
export const DEFAULT_TYRE_OFF = ['4010', '7010', '9010'];

const lc = (s) => String(s || '').trim().toLowerCase();
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export function defaultSettings() {
  return {
    routes: [],                       // [{ port, dest, from: 'yyyy-mm' | '', km, salary, diesel }]
    vehicles: {},                     // { 'XX01AB1001': { tyre: false, fastag: true } }
    // Extra Own Driver Pay is the extra promised for those trips — on top of the salary, settled
    driver: { extraIsAdvance: false, debitCounts: true, tolerance: 100 },
    recon: { useApp: false },
  };
}
export function withDefaults(s) {
  const d = defaultSettings();
  const x = s && typeof s === 'object' ? s : {};
  return {
    routes: Array.isArray(x.routes) ? x.routes : d.routes,
    vehicles: x.vehicles && typeof x.vehicles === 'object' ? x.vehicles : d.vehicles,
    driver: { ...d.driver, ...(x.driver || {}) },
    recon: { ...d.recon, ...(x.recon || {}) },
  };
}

export function vehicleFlags(settings, veh) {
  const v = (settings.vehicles || {})[veh] || {};
  const tyreDefault = !DEFAULT_TYRE_OFF.some((s) => String(veh).endsWith(s));
  return { tyre: v.tyre ?? tyreDefault, fastag: v.fastag ?? true };
}

// ---- routes ------------------------------------------------------------------------
// Every loading port × destination seen in the trips or the Rates sheet.
export function routePairs(data, settings) {
  const ports = new Set();
  const dests = new Set();
  for (const t of data.trips) { if (t.port) ports.add(t.port); if (t.dest) dests.add(t.dest); }
  for (const r of data.rates || []) { ports.add(r.port); dests.add(r.dest); }
  for (const r of settings.routes || []) { if (r.port) ports.add(r.port); if (r.dest) dests.add(r.dest); }
  const out = [];
  for (const p of [...ports].sort()) for (const d of [...dests].sort()) {
    if (lc(p) !== lc(d)) out.push({ port: p, dest: d, trips: data.trips.filter((t) => lc(t.port) === lc(p) && lc(t.dest) === lc(d)).length });
  }
  return out;
}

// The route's values for a month: the newest entry from on or before it.
// Salary and diesel fall back to the Rates sheet's Driver Payment / Diesel.
export function routeFor(data, settings, port, dest, month = null) {
  const list = (settings.routes || []).filter((r) => lc(r.port) === lc(port) && lc(r.dest) === lc(dest))
    .filter((r) => !r.from || !month || r.from <= month)
    .sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
  const pick = (k) => { for (let i = list.length - 1; i >= 0; i--) if (Number(list[i][k]) > 0) return Number(list[i][k]); return null; };
  const rate = (data.rates || []).find((r) => lc(r.port) === lc(port) && lc(r.dest) === lc(dest));
  const salary = pick('salary');
  const diesel = pick('diesel');
  return {
    km: pick('km'),
    salary: salary ?? (rate && rate.driver > 0 ? rate.driver : null),
    salaryFrom: salary != null ? 'app' : rate && rate.driver > 0 ? 'rates' : null,
    diesel: diesel ?? (rate && rate.diesel > 0 ? rate.diesel : null),
    dieselFrom: diesel != null ? 'app' : rate && rate.diesel > 0 ? 'rates' : null,
  };
}

// distance between two places, either way round
export function distance(data, settings, a, b, month = null) {
  if (!a || !b) return null;
  return routeFor(data, settings, a, b, month).km ?? routeFor(data, settings, b, a, month).km;
}

// km a trip ran: empty from where the vehicle unloaded last to this port, then loaded to the destination
export function tripKms(data, settings) {
  const out = new Map();
  const byVeh = new Map();
  for (const t of [...data.trips].sort((x, y) => x.row - y.row)) {
    const prev = byVeh.get(t.veh);
    const loaded = distance(data, settings, t.port, t.dest, t.month);
    const empty = prev ? (lc(prev.dest) === lc(t.port) ? 0 : distance(data, settings, prev.dest, t.port, t.month)) : null;
    out.set(t.row, { loaded, empty, km: (loaded || 0) + (empty || 0), complete: loaded != null && (empty != null || !prev) });
    byVeh.set(t.veh, t);
  }
  return out;
}

// ---- drivers -------------------------------------------------------------------------
// A trip's driver salary is paid partly by you (advances: Trip Driver Payment,
// and Extra Own Driver Pay when it counts as an advance) and the rest by SSFC
// (Driver SSFC Payment). SSFC should pay salary − your advances; more is an
// overpayment. Driver Debit (damage, fines…) is money the driver owes back,
// usually recovered by paying less on later trips — so it's tracked in the
// running balance of each driver's spell on the vehicle, not trip by trip.
const NEW_DRIVER = /new\s+driver|driver\s+chang/i;
export function driverName(remark) {
  const r = String(remark || '');
  let m = r.match(/driver\s+changed?\s+from\s+.+?\s+to\s+([A-Za-z][A-Za-z .]{1,30}?)(?:[,(;]|$)/i);
  if (m) return m[1].trim();
  m = r.match(/[Nn]ew\s+[Dd]river[\s:-]+([A-Z][A-Za-z .]{1,30}?)(?:[,(;]|$)/);
  if (m && !/^,/.test(m[1])) return m[1].trim();
  m = r.match(/([A-Z][A-Za-z .]{1,30}?)\s+new\s+driver/i);
  if (m) return m[1].trim();
  return '';
}

export function driverCheck(data, settings) {
  const opt = settings.driver || {};
  const tol = Number(opt.tolerance ?? 100);
  const vehicles = [...new Set(data.trips.map((t) => t.veh))].sort();
  const missing = new Map();
  const rows = [];
  const spells = [];
  for (const veh of vehicles) {
    const trips = data.trips.filter((t) => t.veh === veh).sort((a, b) => a.row - b.row);
    let spell = null;
    for (const t of trips) {
      if (!spell || NEW_DRIVER.test(t.remarks)) {
        spell = { veh, name: spell ? driverName(t.remarks) : '', from: t.loadDate || t.start, fromTrip: t, remark: spell ? t.remarks : '', trips: [], salary: 0, ssfc: 0, advance: 0, debit: 0, balance: 0, overTrips: 0, first: !spell };
        spells.push(spell);
      }
      const settled = t.drvSsfc != null || t.status === 'done';
      if (!settled) continue;
      const r = routeFor(data, settings, t.port, t.dest, t.month);
      const advance = (t.drvTrip || 0) + (opt.extraIsAdvance ? t.drvExtra || 0 : 0);
      const ssfc = t.drvSsfc || 0;
      const debit = opt.debitCounts ? t.drvDebit || 0 : 0;
      if (r.salary == null) {
        const k = `${t.port} → ${t.dest}`;
        missing.set(k, (missing.get(k) || 0) + 1);
        rows.push({ t, veh, spell, salary: null, advance, ssfc, debit, expected: null, over: null });
        continue;
      }
      const expected = r.salary - advance;                         // what SSFC should pay
      const over = ssfc - expected;                                // + = paid more than the salary
      spell.trips.push(t);
      spell.salary += r.salary;
      spell.ssfc += ssfc;
      spell.advance += advance;
      spell.debit += debit;
      spell.balance += over + debit;                               // + = driver has more than he earned
      if (over > tol) spell.overTrips += 1;
      rows.push({ t, veh, spell, salary: r.salary, salaryFrom: r.salaryFrom, advance, ssfc, debit, expected, over, running: spell.balance });
    }
  }
  spells.forEach((s) => { s.label = s.name || (s.first ? 'Driver from the start' : `Driver from ${s.fromTrip.trip}`); s.current = false; });
  for (const veh of vehicles) { const mine = spells.filter((s) => s.veh === veh); if (mine.length) mine[mine.length - 1].current = true; }
  return { rows, spells, missing: [...missing.entries()].map(([route, trips]) => ({ route, trips })), tolerance: tol };
}

// ---- fastag / tyre: the monthly SSFC charges ---------------------------------------------
// Each vehicle is charged once a month (on one of its trips). A month is out
// of trend when its charge, per trip run that month (per km once distances are
// set), is well above the fleet's that month AND above the vehicle's own last
// six months; or well below both (often a charge not booked yet); or booked
// twice in a month.
// basis: what the charge grows with when distances aren't set — fastag with
// the trips run, tyre is about the same every month. With every route's
// distance set, both go per km.
export const WARMUP_MONTHS = 2;
export const CHARGE_RULES = {
  fastag: { name: 'Fastag', high: 1.3, low: 0.6, alone: 1.6, gap: 2500, basis: 'trips' },
  tyre: { name: 'Tyre', high: 1.3, low: 0.6, alone: 1.6, gap: 5000, basis: 'month' },
};

export function monthlyCharges(data, settings, key, kms = null) {
  const rule = CHARGE_RULES[key];
  const all = [...new Set(data.trips.map((t) => t.veh))].sort();
  const included = all.filter((v) => vehicleFlags(settings, v)[key]);
  const months = [...new Set(data.trips.map((t) => t.month).filter(Boolean))].sort();
  const latest = months[months.length - 1];
  const kmOf = (t) => (kms && kms.get(t.row) && kms.get(t.row).complete ? kms.get(t.row).km : null);
  const cell = {};
  for (const v of all) {
    cell[v] = {};
    for (const m of months) {
      const trips = data.trips.filter((t) => t.veh === v && t.month === m);
      const entries = trips.filter((t) => t[key]);
      const km = trips.length && trips.every((t) => kmOf(t) != null) ? trips.reduce((a, t) => a + kmOf(t), 0) : null;
      cell[v][m] = { veh: v, month: m, amount: entries.reduce((a, t) => a + t[key], 0), entries, trips: trips.length, km };
    }
  }
  const useKm = months.every((m) => included.every((v) => !cell[v][m].trips || cell[v][m].km != null)) && included.some((v) => months.some((m) => cell[v][m].km));
  const basis = useKm ? 'km' : rule.basis;
  const units = (c) => (basis === 'km' ? c.km : basis === 'trips' ? c.trips : c.trips || c.amount ? 1 : 0);
  const peer = {};
  for (const m of months) {
    peer[m] = median(included.map((v) => cell[v][m]).filter((c) => c.amount > 0 && units(c) > 0).map((c) => c.amount / units(c)));
  }
  const flags = [];
  for (const v of included) {
    // a vehicle's first two months with trips can't be judged (nothing to
    // compare with yet) and don't count in its trend either
    const active = months.filter((m) => cell[v][m].trips);
    const settling = new Set(active.slice(0, WARMUP_MONTHS));
    months.forEach((m, i) => {
      const c = cell[v][m];
      const prior = months.slice(0, i).filter((x) => !settling.has(x)).slice(-6).map((x) => cell[v][x]).filter((x) => x.amount > 0 && units(x) > 0);
      const own = prior.length >= 3 ? median(prior.map((x) => x.amount / units(x))) : null;
      c.expected = peer[m] != null && units(c) ? peer[m] * units(c) : null;
      c.trend = own != null && units(c) ? own * units(c) : null;
      c.rate = units(c) ? c.amount / units(c) : null;
      if (settling.has(m)) { c.settling = true; return; }
      if (c.entries.length > 1) {
        c.flag = 'twice';
        flags.push({ kind: 'twice', key, veh: v, month: m, cell: c });
      }
      if (c.expected == null) return;
      // with no history of its own yet, only a bigger gap from the fleet counts
      const hiPeer = c.amount > c.expected * (c.trend == null ? rule.alone : rule.high) && c.amount - c.expected >= rule.gap;
      const hiOwn = c.trend == null || c.amount > c.trend * rule.high;
      const loPeer = c.amount < c.expected * (c.trend == null ? rule.low / 1.5 : rule.low) && c.expected - c.amount >= rule.gap;
      const loOwn = c.trend == null || c.amount < c.trend * rule.low;
      if (hiPeer && hiOwn) {
        c.flag = c.flag || 'high';
        flags.push({ kind: 'high', key, veh: v, month: m, cell: c });
      } else if (loPeer && loOwn && m !== latest && c.trips) {
        c.flag = c.flag || 'low';
        flags.push({ kind: 'low', key, veh: v, month: m, cell: c });
      }
    });
  }
  return { key, rule, months, latest, vehicles: all, included, excluded: all.filter((v) => !included.includes(v)), cell, peer, flags, basis };
}

// ---- small helpers for the screens ---------------------------------------------------------
export const ageDays = (iso, today) => (iso ? daysBetween(iso, today) : null);
export const monthKey = (iso) => monthOf(iso);
