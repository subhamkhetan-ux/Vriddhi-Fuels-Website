// Checks on a freshly read workbook, before it's saved: things that would make
// the app's figures quietly wrong. Each is { level: 'warn' | 'info', text }.
// 'warn' = a figure the app shows will be off until it's fixed in Excel;
// 'info' = worth a look (a possible typo). Pure functions.

import { SSFC_DEDUCTIONS, OWN_EXPENSES } from './parse.js';
import { sameDriver, tripDrivers } from './drivers.js';

const list = (xs, n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} …and ${xs.length - n} more` : xs.join(', '));
const off = (a, b, tol = 1) => Math.abs((a || 0) - (b || 0)) > tol;

export function dataChecks(data, today = null) {
  const out = [];
  const warn = (text) => out.push({ level: 'warn', text });
  const info = (text) => out.push({ level: 'info', text });
  const trips = data.trips || [];

  // the same trip twice
  const seen = new Map();
  for (const t of trips) {
    const k = `${t.veh}|${t.trip}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(t.row);
  }
  const dup = [...seen.entries()].filter(([, rows]) => rows.length > 1);
  if (dup.length) warn(`The same trip is in the Trip Register more than once: ${list(dup.map(([k, rows]) => `${k.split('|')[1]} ${k.split('|')[0].slice(-4)} (rows ${rows.join(', ')})`))}. Its figures count twice.`);

  const noStart = trips.filter((t) => !t.start && (t.loadDate || t.unloadDate));
  if (noStart.length) warn(`No Trip Start Date on ${noStart.length === 1 ? 'row' : 'rows'} ${list(noStart.map((t) => t.row))} — driver advances and the performance check need it.`);

  // Excel's saved figures against its own formulas: not recalculated, or typed over
  const fx = [];
  for (const t of trips) {
    const why = [];
    if (t.loadWt && t.tare && t.gross != null && off(t.gross, t.tare + t.loadWt, 0.005)) why.push('Gross Weight');
    if (t.loadWt && t.unloadWt && t.diff != null && off(t.diff, t.unloadWt - t.loadWt, 0.005)) why.push('Excess/Short');
    if (t.loadWt && t.rate && t.bhada != null && off(t.bhada, t.loadWt * t.rate)) why.push('Trip Bhada');
    if (t.bhada && t.ssfcNet != null && off(t.ssfcNet, t.bhada - SSFC_DEDUCTIONS.reduce((a, k) => a + (t[k] || 0), 0))) why.push('SSFC Net Amount');
    if (t.bhada && t.ssfcNet != null && t.income != null && off(t.income, t.ssfcNet - OWN_EXPENSES.reduce((a, k) => a + (t[k] || 0), 0))) why.push('Income/Trip');
    if (why.length) fx.push(`row ${t.row} (${why.join(', ')})`);
  }
  if (fx.length) warn(`Excel's saved figures don't add up on ${list(fx, 6)}. Either Excel hasn't recalculated (Formulas → Calculate Now, save, upload again) or a formula was typed over.`);

  const pays = data.driverPay || [];
  if (pays.length) {
    const who = tripDrivers(data);
    const bad = trips.filter((t) => { const w = who.get(t.row); return off(w ? w.paid.reduce((a, p) => a + p.amount, 0) : 0, t.drvTrip, 0.5); });
    if (bad.length) warn(`Trip Driver Payment doesn't match the Driver Payment sheet on ${list(bad.map((t) => `row ${t.row} (${t.trip})`), 6)} — recalculate in Excel (Formulas → Calculate Now), save and upload again.`);

    const vehs = new Set(trips.map((t) => t.veh));
    const first = new Map();
    for (const t of trips) if (t.start && (!first.has(t.veh) || t.start < first.get(t.veh))) first.set(t.veh, t.start);
    const stray = pays.filter((p) => !vehs.has(p.veh));
    if (stray.length) warn(`Driver Payment ${stray.length === 1 ? 'row' : 'rows'} ${list(stray.map((p) => `${p.row} (${p.veh})`))}: no trips for that vehicle — a typo in the vehicle number? Not counted.`);
    const early = pays.filter((p) => vehs.has(p.veh) && first.has(p.veh) && p.date < first.get(p.veh));
    if (early.length) warn(`Driver Payment ${early.length === 1 ? 'row' : 'rows'} ${list(early.map((p) => p.row))}: dated before the vehicle's first trip, so no trip counts ${early.length === 1 ? 'it' : 'them'} — check the date.`);

    const ahead = today ? pays.filter((p) => p.date > today) : [];
    if (ahead.length) warn(`Driver Payment ${ahead.length === 1 ? 'row' : 'rows'} ${list(ahead.map((p) => `${p.row} (${p.date})`))}: dated after today — a typo in the date?`);

    const twice = new Map();
    for (const p of pays) {
      const k = `${p.date}|${p.veh}|${p.amount}|${p.name.toLowerCase()}`;
      twice.set(k, [...(twice.get(k) || []), p.row]);
    }
    const doubled = [...twice.values()].filter((rows) => rows.length > 1);
    if (doubled.length) info(`Same date, vehicle, amount and driver more than once in Driver Payment: rows ${list(doubled.map((r) => r.join(' & ')))} — fine if it was paid twice, else one is typed twice.`);

    // recent ones only (the last 45 days of payments): older one-offs are history, not typos to fix
    const roster = data.roster || [];
    const newest = pays.reduce((m, p) => (p.date > m && (!today || p.date <= today) ? p.date : m), '') || today || '9999-12-31';
    const since = new Date(Date.parse(newest) - 45 * 86400000).toISOString().slice(0, 10);
    const lone = [];
    for (const p of pays) {
      if (!p.name || p.date < since) continue;
      const others = pays.filter((q) => q !== p && q.name && sameDriver(q.name, p.name));
      if (!others.length && !roster.some((r) => sameDriver(r.name, p.name))) lone.push(`“${p.name}” (row ${p.row}, ${p.veh.slice(-4)})`);
    }
    if (lone.length) info(`Paid only once and not on the drivers list: ${list(lone)} — a new driver, or a misspelt name? A misspelling shows up as a driver change.`);
  }

  const roster = data.roster || [];
  if (roster.length) {
    const vehs = new Set(trips.map((t) => t.veh));
    const count = new Map();
    for (const r of roster) count.set(r.veh, (count.get(r.veh) || 0) + 1);
    const twice = [...count.entries()].filter(([, n]) => n > 1).map(([v]) => v);
    if (twice.length) warn(`The drivers list has more than one driver for ${list(twice)} — the last one is taken as the driver now.`);
    const unknown = roster.filter((r) => !vehs.has(r.veh)).map((r) => `${r.veh} (${r.name})`);
    if (unknown.length) info(`On the drivers list but with no trips: ${list(unknown)} — a typo in the vehicle number?`);
    const missing = [...vehs].filter((v) => !count.has(v) && trips.some((t) => t.veh === v && !t.unloadDate));
    if (missing.length) info(`On a trip now but not on the drivers list: ${list(missing)}.`);
  }

  // own diesel: the fills tagged to a trip in HSD Data against what's typed in the Trip Register
  // (OWN DIESEL for Trip; Extra Filling = Own Diesel Extra), from where the diesel recon starts
  const from = (data.recon && data.recon.fromRow) || Infinity;
  const tagged = new Map();
  for (const h of data.hsd || []) {
    const k = `${h.veh}|${h.trip}`;
    if (!tagged.has(k)) tagged.set(k, { own: 0, extra: 0 });
    const src = String(h.source || '').trim().toLowerCase();
    if (!src || src === 'ssfc') continue;                                 // no pump name: can't tell
    tagged.get(k)[src === 'extra filling' ? 'extra' : 'own'] += h.qty || 0;
  }
  const ownOff = trips.filter((t) => t.row >= from).filter((t) => {
    const g = tagged.get(`${t.veh}|${t.trip}`) || { own: 0, extra: 0 };
    return off(g.own, t.ownLtr, 0.5) || off(g.extra, t.extraLtr, 0.5);
  });
  if (ownOff.length) warn(`Own diesel in HSD Data doesn't match the Trip Register's OWN DIESEL columns on ${list(ownOff.map((t) => `row ${t.row} (${t.trip} ${t.veh.slice(-4)})`), 6)} — the diesel recon counts what's typed in the Trip Register.`);

  const fills = new Map();
  for (const h of data.hsd || []) {
    if (!h.bill) continue;
    const k = `${h.veh}|${h.bill}|${h.date}|${h.qty}`;
    fills.set(k, (fills.get(k) || 0) + 1);
  }
  const fillTwice = [...fills.entries()].filter(([, n]) => n > 1).map(([k]) => `${k.split('|')[0].slice(-4)} bill ${k.split('|')[1]}`);
  if (fillTwice.length) info(`HSD Data has the same fill (vehicle, bill, date, litres) more than once: ${list(fillTwice)}.`);
  return out;
}
