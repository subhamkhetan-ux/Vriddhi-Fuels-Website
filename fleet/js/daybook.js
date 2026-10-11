// The day book: everything in the workbook that has a date, day by day —
// trips started, loaded and unloaded (Trip Register), diesel fills (HSD
// Data), urea (Urea DEF), driver advances (Driver Payment) and SSFC payments
// received (Ledger sheet, when the paid date is filled). A trip's other
// costs (fastag, tyre, maintenance …) have no date of their own in the
// register, so they stay on the trip. Pure functions.

import { addDays, daysBetween, monthEnd, monthOf } from './util.js';
import { sourceOf } from './analyse.js';

export const KINDS = [
  { key: 'load', name: 'Loading', color: 'var(--s-1)' },
  { key: 'unload', name: 'Unloading', color: 'var(--s-3)' },
  { key: 'start', name: 'Trip start', color: 'var(--s-6)' },
  { key: 'diesel', name: 'Diesel', color: 'var(--s-4)' },
  { key: 'urea', name: 'Urea', color: 'var(--s-5)' },
  { key: 'advance', name: 'Driver advance', color: 'var(--s-2)' },
  { key: 'ssfc', name: 'SSFC payment', color: 'var(--s-8)' },
];
const ORDER = Object.fromEntries(KINDS.map((k, i) => [k.key, i]));

// every dated entry: { date, kind, veh, t (the trip, when there's one), title, detail, amount, litres, tonnes }
export function entries(data, { driverOf = null, payments = [] } = {}) {
  const out = [];
  const tripOf = new Map(data.trips.map((t) => [`${t.veh}|${t.trip}`, t]));
  for (const t of data.trips) {
    const who = driverOf ? driverOf(t) : '';
    const route = `${t.port || '?'} → ${t.dest || '?'}`;
    if (t.start) out.push({ date: t.start, kind: 'start', veh: t.veh, t, title: `${t.trip} started`, detail: [route, who].filter(Boolean).join(' · ') });
    if (t.loadDate) {
      out.push({
        date: t.loadDate, kind: 'load', veh: t.veh, t, tonnes: t.loadWt || 0, amount: t.bhada || 0,
        title: `Loaded ${t.loadWt ? `${t.loadWt.toFixed(2)} T` : ''} at ${t.port || '?'}`.replace('  ', ' '),
        detail: [`${t.trip} → ${t.dest || '?'}`, t.rate ? `₹${t.rate}/T` : '', t.gross ? `gross ${t.gross.toFixed(2)} T` : '', who].filter(Boolean).join(' · '),
      });
    }
    if (t.unloadDate) {
      out.push({
        date: t.unloadDate, kind: 'unload', veh: t.veh, t, tonnes: t.unloadWt || 0, short: t.diff || 0,
        title: `Unloaded ${t.unloadWt ? `${t.unloadWt.toFixed(2)} T` : ''} at ${t.dest || '?'}`.replace('  ', ' '),
        detail: [t.trip, t.diff ? `${t.diff < 0 ? 'short' : 'excess'} ${Math.abs(t.diff).toFixed(2)} T` : 'no shortage', t.start ? `${daysBetween(t.start, t.unloadDate)} days` : '', who].filter(Boolean).join(' · '),
      });
    }
  }
  for (const h of data.hsd || []) {
    out.push({
      date: h.date, kind: 'diesel', veh: h.veh, t: tripOf.get(`${h.veh}|${h.trip}`) || null, litres: h.qty || 0, amount: h.amount || 0, source: sourceOf(h.source),
      title: `Diesel ${h.qty ? `${Math.round(h.qty * 100) / 100} L` : ''} · ${h.source || 'pump'}`, detail: [h.location, h.trip, h.bill ? `bill ${h.bill}` : '', h.rsp ? `₹${h.rsp.toFixed(2)}/L` : ''].filter(Boolean).join(' · '),
    });
  }
  for (const u of data.urea || []) {
    out.push({
      date: u.date, kind: 'urea', veh: u.veh, t: tripOf.get(`${u.veh}|${u.trip}`) || null, litres: u.qty || 0, amount: u.amount || 0,
      title: `Urea ${u.qty ? `${u.qty} L` : ''}${u.from ? ` · ${u.from}` : ''}`, detail: [u.location, u.trip].filter(Boolean).join(' · '),
    });
  }
  for (const p of data.driverPay || []) {
    out.push({ date: p.date, kind: 'advance', veh: p.veh, t: null, amount: p.amount, title: `Advance to ${p.name || 'driver'}`, detail: p.note || '' });
  }
  for (const p of payments) {
    if (!p.date) continue;
    out.push({ date: p.date, kind: 'ssfc', veh: p.veh, t: null, amount: (p.account || 0) + (p.other || 0), title: `SSFC paid · ${p.how}`, detail: [`for ${p.month}`, p.invoice, p.remarks].filter(Boolean).join(' · ') });
  }
  return out.filter((e) => e.date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : ORDER[a.kind] - ORDER[b.kind] || String(a.veh).localeCompare(String(b.veh))));
}

// the sums of a set of entries
export function sums(list) {
  const s = { entries: list.length, loads: 0, tonnes: 0, freight: 0, unloads: 0, delivered: 0, short: 0, starts: 0, fills: 0, litres: 0, diesel: 0, ssfcLitres: 0, urea: 0, ureaL: 0, advances: 0, advanceN: 0, received: 0, receivedN: 0 };
  for (const e of list) {
    if (e.kind === 'load') { s.loads += 1; s.tonnes += e.tonnes; s.freight += e.amount; }
    else if (e.kind === 'unload') { s.unloads += 1; s.delivered += e.tonnes; if (e.short < 0) s.short += e.short; }
    else if (e.kind === 'start') s.starts += 1;
    else if (e.kind === 'diesel') { s.fills += 1; s.litres += e.litres; s.diesel += e.amount; if (e.source === 'SSFC') s.ssfcLitres += e.litres; }
    else if (e.kind === 'urea') { s.urea += e.amount; s.ureaL += e.litres; }
    else if (e.kind === 'advance') { s.advances += e.amount; s.advanceN += 1; }
    else if (e.kind === 'ssfc') { s.received += e.amount; s.receivedN += 1; }
  }
  return s;
}

// filter and group: newest day first
export function dayBook(all, { from, to, kinds = null, veh = '' } = {}) {
  const list = all.filter((e) => e.date >= from && e.date <= to && (!kinds || kinds.has(e.kind)) && (!veh || e.veh === veh));
  const days = [];
  for (const e of list) {
    if (!days.length || days[days.length - 1].date !== e.date) days.push({ date: e.date, entries: [] });
    days[days.length - 1].entries.push(e);
  }
  for (const d of days) d.sums = sums(d.entries);
  return { from, to, list, days, sums: sums(list) };
}

// the standard ranges, as of today (weeks start on Monday)
export function ranges(today) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const m = monthOf(today);
  const lastM = monthOf(addDays(`${m}-01`, -1));
  const fyStart = Number(m.slice(5, 7)) >= 4 ? `${m.slice(0, 4)}-04-01` : `${Number(m.slice(0, 4)) - 1}-04-01`;
  return {
    today: { label: 'Today', from: today, to: today },
    yesterday: { label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    week: { label: 'This week', from: addDays(today, -dow), to: today },
    last7: { label: 'Last 7 days', from: addDays(today, -6), to: today },
    month: { label: 'This month', from: `${m}-01`, to: today },
    lastMonth: { label: 'Last month', from: `${lastM}-01`, to: monthEnd(lastM) },
    last30: { label: 'Last 30 days', from: addDays(today, -29), to: today },
    fy: { label: 'This FY', from: fyStart, to: today },
  };
}

// a range moved back (−1) or forward (+1) by its own length
export function shiftRange(from, to, dir) {
  const n = daysBetween(from, to) + 1;
  return { from: addDays(from, dir * n), to: addDays(to, dir * n) };
}
