// The fleet's figures, worked out from what parse.js read. Pure functions — no
// DOM — so the tests run them on made-up data and on a real workbook.
//
// The rules are the workbook's:
//   * a trip counts in the month it was loaded (Trip Register "Month" =
//     the 1st of the Loading Date's month);
//   * SSFC Net Amount = Trip Bhada − SSFC diesel − driver SSFC payment − the
//     SSFC deductions (fastag, maintenance, tyre, RTO …);
//     Income/Trip = SSFC Net − own diesel, urea, driver extras, own misc, EMI;
//   * Diesel Recon: allotted = the route's diesel (Rates) + 5 L per tonne over
//     58 T gross − 5 L per tonne under 56 T (from the recon's start row, not
//     for Gangavaram); balance = allotted − SSFC litres − own trip litres;
//   * SSFC account: payments (SSL account + own diesel + cash) clear the
//     not-invoiced months first, then each invoice oldest first.

import { SSFC_DEDUCTIONS, OWN_EXPENSES } from './parse.js';
import { routeFor, withDefaults } from './rules.js';
import { addMonths, daysBetween, fyStart, monthEnd, monthOf, round2 } from './util.js';

const sum = (list, f) => list.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const by = (list, f) => {
  const m = new Map();
  for (const x of list) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

export const vehiclesOf = (data) => [...new Set(data.trips.map((t) => t.veh))].sort();
export const routeOf = (t) => `${t.port || '?'} → ${t.dest || '?'}`;
export const dieselLitres = (t) => (t.ssfcLtr || 0) + (t.ownLtr || 0) + (t.extraLtr || 0);
export const dieselAmount = (t) => (t.ssfcAmt || 0) + (t.ownAmt || 0) + (t.extraAmt || 0);
export const ssfcDeductions = (t) => SSFC_DEDUCTIONS.reduce((a, k) => a + (t[k] || 0), 0);
export const ownExpenses = (t) => OWN_EXPENSES.reduce((a, k) => a + (t[k] || 0), 0);

// ---- periods ---------------------------------------------------------------------------
// Months as yyyy-mm, both ends included.
export function periods(today, latestMonth) {
  const m = monthOf(today);
  const fy = fyStart(today);
  const first = '2000-01';
  return {
    month: { key: 'month', label: 'This month', from: m, to: m },
    last: { key: 'last', label: 'Last month', from: addMonths(m, -1), to: addMonths(m, -1) },
    q: { key: 'q', label: 'Last 3 months', from: addMonths(m, -2), to: m },
    fy: { key: 'fy', label: 'This FY', from: fy, to: addMonths(fy, 11) },
    lastfy: { key: 'lastfy', label: 'Last FY', from: addMonths(fy, -12), to: addMonths(fy, -1) },
    all: { key: 'all', label: 'All time', from: first, to: latestMonth && latestMonth > m ? latestMonth : m },
  };
}
export const inPeriod = (t, p) => !!t.month && t.month >= p.from && t.month <= p.to;

// ---- money on a set of trips --------------------------------------------------------------
export const COST_GROUPS = [
  { key: 'diesel', name: 'Diesel', of: (t) => dieselAmount(t), note: 'SSFC diesel + own pump + extra HSD' },
  { key: 'driver', name: 'Driver', of: (t) => (t.drvSsfc || 0) + (t.drvTrip || 0) + (t.drvExtra || 0), note: 'SSFC payment + trip payment + extra pay' },
  { key: 'fastag', name: 'Fastag & tolls', of: (t) => t.fastag || 0 },
  { key: 'maint', name: 'Maintenance & tyres', of: (t) => (t.maint || 0) + (t.tyre || 0) },
  { key: 'rto', name: 'RTO & documents', of: (t) => (t.rtoEntry || 0) + (t.rtoChallan || 0) + (t.docExp || 0) + (t.docOwn || 0), note: 'RTO entry, challans, document expense' },
  { key: 'emi', name: 'EMI', of: (t) => t.emi || 0, note: 'vehicle installments' },
  { key: 'urea', name: 'Urea (DEF)', of: (t) => t.urea || 0 },
  { key: 'load', name: 'Over/underload & shortage', of: (t) => (t.lessOver || 0) + (t.shortage || 0) },
  { key: 'misc', name: 'Misc kharcha', of: (t) => (t.ssfcMisc || 0) + (t.ownMisc || 0) },
];

export function totals(trips) {
  const done = trips.filter((t) => t.status === 'done');
  const bhada = sum(trips, (t) => t.bhada);
  return {
    trips: trips.length,
    done: done.length,
    open: trips.length - done.length,
    tonnes: sum(trips, (t) => t.loadWt),
    delivered: sum(done, (t) => t.unloadWt),
    short: sum(done, (t) => Math.min(0, t.diff || 0)),
    excess: sum(done, (t) => Math.max(0, t.diff || 0)),
    shortTrips: done.filter((t) => (t.diff || 0) < -0.1).length,
    bhada,
    ssfcDed: sum(trips, ssfcDeductions),
    ssfcNet: sum(trips, (t) => t.ssfcNet),
    own: sum(trips, ownExpenses),
    emi: sum(trips, (t) => t.emi),
    income: sum(trips, (t) => t.income),
    dieselL: sum(trips, dieselLitres),
    dieselAmt: sum(trips, dieselAmount),
    days: avg(trips.map(tripDays).filter((d) => d != null)),
    get perTrip() { return this.trips ? this.income / this.trips : 0; },
    get margin() { return this.bhada ? this.income / this.bhada : 0; },
    get perTonne() { return this.tonnes ? this.bhada / this.tonnes : 0; },
  };
}

export function costBreakdown(trips) {
  const bhada = sum(trips, (t) => t.bhada);
  const groups = COST_GROUPS.map((g) => ({ ...g, amount: sum(trips, g.of) }));
  const income = sum(trips, (t) => t.income);
  return { bhada, income, groups: groups.filter((g) => g.amount).sort((a, b) => b.amount - a.amount) };
}

// per month, oldest first; empty months in between are kept
export function monthly(trips, from, to) {
  const m = by(trips.filter((t) => t.month && t.month >= from && t.month <= to), (t) => t.month);
  const out = [];
  for (let x = from; x <= to; x = addMonths(x, 1)) {
    const list = m.get(x) || [];
    out.push({ month: x, ...plainTotals(list) });
    if (out.length > 240) break;
  }
  return out;
}
const plainTotals = (list) => {
  const t = totals(list);
  return { trips: t.trips, done: t.done, tonnes: t.tonnes, bhada: t.bhada, ssfcNet: t.ssfcNet, own: t.own, emi: t.emi, income: t.income, dieselL: t.dieselL, short: t.short };
};

export function byVehicle(trips, vehicles) {
  const m = by(trips, (t) => t.veh);
  return vehicles.map((veh) => ({ veh, ...plainTotals(m.get(veh) || []), list: m.get(veh) || [] }));
}

export function byRoute(trips) {
  const m = by(trips, routeOf);
  return [...m.entries()].map(([route, list]) => {
    const t = totals(list);
    return {
      route, port: list[0].port, dest: list[0].dest, ...plainTotals(list),
      avgLoad: t.trips ? t.tonnes / t.trips : 0,
      perTonne: t.tonnes ? t.bhada / t.tonnes : 0,
      perTrip: t.trips ? t.income / t.trips : 0,
      dieselPerTrip: t.trips ? t.dieselL / t.trips : 0,
      days: t.days,
    };
  }).sort((a, b) => b.trips - a.trips);
}

// ---- live fleet (the On-Trip Dashboard) -----------------------------------------------------
// A vehicle is on a trip when its latest started trip isn't unloaded yet:
// loaded (has a loading date) → on the way to the destination; otherwise
// empty → on the way to the loading port. Else it's idle where it unloaded last.
export function fleetStatus(data, today) {
  return vehiclesOf(data).map((veh) => {
    const mine = data.trips.filter((t) => t.veh === veh).sort((a, b) => a.row - b.row);
    const live = [...mine].reverse().find((t) => t.start && !t.unloadDate);
    const last = [...mine].reverse().find((t) => t.unloadDate);
    if (live) {
      const loaded = !!live.loadDate;
      return {
        veh, trip: live, state: loaded ? 'loaded' : 'empty',
        text: loaded ? `Loaded → ${live.dest}` : `Empty → ${live.port}`,
        long: loaded ? `Loaded on the way to ${live.dest}` : `Empty, on the way to ${live.port} to load`,
        days: daysBetween(live.start, today), last,
      };
    }
    return {
      veh, trip: null, state: 'idle', text: last ? `Idle at ${last.dest}` : 'Idle',
      long: last ? `Idle — available at ${last.dest}` : 'Idle', days: last ? daysBetween(last.unloadDate, today) : null, last,
    };
  });
}

// ---- Diesel Recon -----------------------------------------------------------------------------
// settings (Setup tab): a route's diesel set in the app is used for trips the
// Recon Engine doesn't cover; with recon.useApp, for every trip instead of
// Excel's figures.
export function dieselRecon(data, settings = null) {
  const r = data.recon || {};
  const set = withDefaults(settings);
  const rules = {
    fromRow: r.fromRow ?? 0, underloadFromRow: r.underloadFromRow ?? r.fromRow ?? 0, overloadOver: r.overloadOver ?? 58,
    underloadBelow: r.underloadBelow ?? 58, perTonne: r.perTonne ?? 5, noUnderloadPorts: r.noUnderloadPorts || ['Gangavaram'],
  };
  const rate = (t) => (data.rates || []).find((x) => x.port.toLowerCase() === (t.port || '').toLowerCase() && x.dest.toLowerCase() === (t.dest || '').toLowerCase());
  const typed = set.recon.useApp ? {} : r.rows || {};
  const rows = data.trips.filter((t) => t.row >= rules.fromRow).sort((a, b) => a.row - b.row).map((t) => {
    const issued = (t.ssfcLtr || 0) + (t.ownLtr || 0);
    if (!t.gross) return { t, base: null, over: 0, under: 0, allotted: null, issued, balance: 0 };
    const x = typed[t.row];
    if (x) {                                                       // Excel's own row
      const [base, over, under, allotted] = x;
      return { t, base, over, under, allotted, issued, balance: allotted - issued, excel: true };
    }
    const app = routeFor(data, set, t.port, t.dest, t.month);
    const base = app.diesel ?? (rate(t) ? rate(t).diesel : 0);
    const over = t.gross > rules.overloadOver ? (t.gross - rules.overloadOver) * rules.perTonne : 0;
    const g = Math.round(t.gross);
    const under = t.row >= rules.underloadFromRow && g < rules.underloadBelow
      && !rules.noUnderloadPorts.some((p) => p.toLowerCase() === (t.port || '').toLowerCase())
      ? (rules.underloadBelow - g) * rules.perTonne : 0;
    const allotted = base + over - under;
    return { t, base, over, under, allotted, issued, balance: allotted - issued };
  });
  const vehicles = vehiclesOf(data).map((veh) => {
    let run = 0;
    const list = rows.filter((x) => x.t.veh === veh).map((x) => { run += x.balance; return { ...x, running: round2(run) }; });
    return { veh, balance: round2(run), list, allotted: sum(list, (x) => x.allotted), issued: sum(list, (x) => x.issued) };
  });
  const since = rows.length ? rows[0].t.loadDate || rows[0].t.start : null;
  return { rules, since, vehicles, total: round2(sum(vehicles, (v) => v.balance)), useApp: set.recon.useApp };
}

// ---- SSFC account (the Ledger sheet) -------------------------------------------------------------
export function ssfcAccount(ssfc, today) {
  if (!ssfc || !ssfc.rows.length) return null;
  const rows = ssfc.rows;
  const S = (k) => sum(rows, (r) => r[k]);
  const net = S('net');
  const igst = S('igst');
  const hireTotal = S('hireTotal');
  const paidAcct = S('paidAcct');
  const paidOther = S('ownDiesel') + S('paidCash') + S('marketHsd');
  const paid = paidAcct + paidOther;
  const exGst = net - paid;
  const account = hireTotal - paidAcct;                    // the last "Balance In Account"
  const cash = net - hireTotal - paidOther;                // the last "Balance In Cash"

  // buckets: not invoiced first, then each invoice by its month
  const inv = by(rows.filter((r) => r.invoice), (r) => r.invoice);
  const invoices = [...inv.entries()].map(([no, list]) => ({
    no, month: list.map((r) => r.month).sort()[0], vehicles: list.length,
    net: sum(list, (r) => r.net), base: sum(list, (r) => r.hireBase), igst: sum(list, (r) => r.igst), billed: sum(list, (r) => r.hireTotal),
  })).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.no.localeCompare(b.no)));
  const loose = rows.filter((r) => !r.invoice);
  const buckets = [];
  if (loose.length) {
    const months = [...new Set(loose.map((r) => r.month))].sort();
    buckets.push({ no: null, month: months[0], toMonth: months[months.length - 1], vehicles: loose.length, net: sum(loose, (r) => r.net), igst: sum(loose, (r) => r.igst), base: 0, billed: 0 });
  }
  buckets.push(...invoices);
  const clear = (withGst) => {
    let pool = paid;
    return buckets.map((b) => {
      const amount = round2(b.net + (withGst ? b.igst : 0));
      const cleared = Math.max(0, Math.min(amount, pool));
      pool -= cleared;
      const pending = round2(amount - cleared);
      const due = monthEnd(b.toMonth || b.month);
      return {
        ...b, amount, cleared: round2(cleared), pending,
        status: pending <= 0.005 ? 'cleared' : cleared <= 0.005 ? 'pending' : 'part',
        age: today && pending > 0.005 ? Math.max(0, daysBetween(due, today)) : null,
      };
    });
  };
  const months = [...by(rows, (r) => r.month).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, list]) => ({
    month, vehicles: list.length, net: sum(list, (r) => r.net), base: sum(list, (r) => r.hireBase), igst: sum(list, (r) => r.igst),
    billed: sum(list, (r) => r.hireTotal), paid: sum(list, (r) => (r.paidAcct || 0) + (r.ownDiesel || 0) + (r.paidCash || 0) + (r.marketHsd || 0)),
    invoices: [...new Set(list.map((r) => r.invoice).filter(Boolean))],
  }));
  const payments = rows.filter((r) => r.paidAcct || r.ownDiesel || r.paidCash || r.marketHsd).map((r) => ({
    month: r.month, date: r.paidDate, veh: r.veh, invoice: r.invoice, remarks: r.remarks,
    account: r.paidAcct || 0, other: (r.ownDiesel || 0) + (r.paidCash || 0) + (r.marketHsd || 0),
    how: r.paidAcct ? 'In SSL account' : r.ownDiesel ? 'Own diesel (paid in my pump)' : r.marketHsd ? 'Market HSD' : 'In cash',
  }));
  return {
    party: ssfc.party, memos: ssfc.memos || [],
    net, igst, hireTotal, paid, paidAcct, paidOther,
    exGst: round2(exGst), total: round2(exGst + igst), account: round2(account), cash: round2(cash), cashWithGst: round2(cash + igst),
    withGst: clear(true), exGstList: clear(false), months, payments,
  };
}

// ---- fuel and urea -----------------------------------------------------------------------------
export const SOURCES = ['SSFC', 'Vriddhi Fuels', 'SSL Own Filling', 'Extra Filling'];
export const sourceOf = (s) => SOURCES.find((x) => x.toLowerCase() === String(s || '').toLowerCase()) || 'Other';

export function fuel(hsd, p) {
  const list = hsd.filter((h) => { const m = monthOf(h.date); return m >= p.from && m <= p.to; });
  const src = [...SOURCES, 'Other'].map((name) => {
    const l = list.filter((h) => sourceOf(h.source) === name);
    return { name, litres: sum(l, (h) => h.qty), amount: sum(l, (h) => h.amount), fills: l.length };
  }).filter((s) => s.fills);
  const months = [...by(list, (h) => monthOf(h.date)).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, l]) => ({
    month, litres: sum(l, (h) => h.qty), amount: sum(l, (h) => h.amount),
    bySource: Object.fromEntries([...SOURCES, 'Other'].map((s) => [s, sum(l.filter((h) => sourceOf(h.source) === s), (h) => h.qty)])),
  }));
  const places = [...by(list, (h) => h.location || '—').entries()].map(([place, l]) => ({ place, litres: sum(l, (h) => h.qty), amount: sum(l, (h) => h.amount), fills: l.length }))
    .sort((a, b) => b.litres - a.litres);
  const litres = sum(list, (h) => h.qty);
  const amount = sum(list, (h) => h.amount);
  return { list, litres, amount, avg: litres ? amount / litres : 0, sources: src, months, places };
}

export function urea(rows, p) {
  const list = rows.filter((u) => { const m = monthOf(u.date); return m >= p.from && m <= p.to; });
  const vendors = [...by(list, (u) => u.from || '—').entries()].map(([name, l]) => ({ name, litres: sum(l, (u) => u.qty), amount: sum(l, (u) => u.amount), buys: l.length }))
    .sort((a, b) => b.amount - a.amount);
  return { list, litres: sum(list, (u) => u.qty), amount: sum(list, (u) => u.amount), vendors };
}

// ---- what needs a look ------------------------------------------------------------------------------
// Dates that can't be right: unloaded after today, or before loading, or a
// trip that took longer than two months (usually a day/month typed the wrong
// way round in Excel).
export function dateIssues(data, today) {
  const out = [];
  for (const t of data.trips) {
    let why = '';
    if (t.unloadDate && t.unloadDate > today) why = `unload date ${t.unloadDate.slice(8)}-${t.unloadDate.slice(5, 7)}-${t.unloadDate.slice(0, 4)} is after today`;
    else if (t.loadDate && t.unloadDate && t.unloadDate < t.loadDate) why = 'unloaded before it was loaded';
    else if (t.start && t.loadDate && t.loadDate < t.start) why = 'loaded before the trip started';
    else if (t.loadDate && t.unloadDate && daysBetween(t.loadDate, t.unloadDate) > 60) why = `${daysBetween(t.loadDate, t.unloadDate)} days from loading to unloading`;
    if (why) out.push({ t, why });
  }
  return out;
}
// trip length in days (start → unload) when the dates make sense
export function tripDays(t) {
  if (!t.start || !t.unloadDate) return null;
  const d = daysBetween(t.start, t.unloadDate);
  return d >= 0 && d <= 60 ? d : null;
}

export function attention(data, today, { recon, account } = {}) {
  const out = [];
  const odd = dateIssues(data, today);
  if (odd.length) out.push({ kind: 'warn', href: '#/trips?f=check', text: `${odd.length} trip${odd.length === 1 ? ' has a date' : 's have dates'} that look mistyped in the Trip Register — check them in Excel` });
  const stuck = data.trips.filter((t) => t.status === 'loaded' && t.loadDate && daysBetween(t.loadDate, today) > 7);
  for (const t of stuck) out.push({ kind: 'warn', href: `#/trip/${t.row}`, text: `${t.veh} loaded ${daysBetween(t.loadDate, today)} days ago (${t.trip}) — not unloaded yet` });
  const recent = data.trips.filter((t) => t.status === 'done' && t.unloadDate && t.unloadDate <= today && daysBetween(t.unloadDate, today) <= 45 && (t.diff || 0) < -0.1);
  for (const t of recent) out.push({ kind: 'warn', href: `#/trip/${t.row}`, text: `${t.veh} ${t.trip}: ${Math.abs(t.diff).toFixed(2)} T short at unloading (${t.unloadDate.slice(8)}/${t.unloadDate.slice(5, 7)})` });
  if (recon) {
    for (const v of recon.vehicles.filter((x) => x.balance <= -300)) out.push({ kind: 'warn', href: `#/diesel/${v.veh}`, text: `${v.veh}: ${Math.round(-v.balance)} L more diesel issued than allotted` });
  }
  if (account) {
    const old = account.withGst.filter((b) => b.pending > 0 && b.age > 90);
    if (old.length) out.push({ kind: 'info', href: '#/ssfc', text: `${old.length} SSFC invoice${old.length === 1 ? '' : 's'} pending over 90 days` });
  }
  return out;
}
