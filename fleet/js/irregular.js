// Entries that look wrong — what to check in the workbook before the month is
// closed. Each is { level: 'bad' | 'warn', kind, veh, date, text, href, src
// (the HSD Data / Urea DEF / Driver Payment row) | row (the trip's row) }:
//   overdraw    more diesel tagged to a trip than its allotment + the mid-way buffer (always
//               120–140 L, Setup): an entry to check (less over is the driver's extra — the
//               diesel recon deducts it — not an entry gone wrong)
//   dup-fill    the same fill twice (same truck, litres, within a day) or a slip no. used twice
//   wrong-trip  a fill dated outside its trip (it falls in another trip of the truck), or tagged
//               to a trip the truck doesn't have, or to no trip
//   fill-math   a fill's amount ≠ litres × ₹/L, or a ₹/L far off the other fills that week
//   slow-unload unloaded far later after loading than the route's trucks lately take
//   dates       dates out of order or in the future
//   weight      a load far off the route's lately, or more unloaded than loaded
//   rate        a rate a tonne unlike the route's other trips that month; freight ≠ load × rate
//   dup-urea / dup-advance  the same urea fill or driver advance twice
// Only entries dated from `since` (60 days back) are looked at. Pure functions.

import { addDays, daysBetween } from './util.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}` : '');
const short = (v) => String(v || '').slice(-4);
const lc = (s) => String(s || '').trim().toLowerCase();
const ind = (n, d = 0) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const L = (n) => `${ind(n, Math.abs(n) % 1 && Math.abs(n) < 100 ? 1 : 0)} L`;
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const isIncentive = (h) => lc(h.source) === 'extra filling';
const slip = (h) => String(h.bill || '').trim();

// ctx: { tripDiesel (tripdiesel.js), today, since }
export function irregulars(data, { tripDiesel = null, today, since = null } = {}) {
  const from = since || addDays(today, -60);
  const out = [];
  const add = (x) => out.push(x);
  const trips = data.trips || [];
  const hsd = (data.hsd || []).filter((h) => h.date && h.date >= from && h.date <= today);
  const tripOf = new Map(trips.map((t) => [`${t.veh}|${lc(t.trip)}`, t]));
  const byVeh = new Map();
  for (const t of trips) { if (!byVeh.has(t.veh)) byVeh.set(t.veh, []); byVeh.get(t.veh).push(t); }
  const tripUrl = (t) => `#/trip/${t.row}`;
  const end = (t) => (t.unloadDate ? addDays(t.unloadDate, 1) : today);

  // more diesel tagged to a trip than its allotment and the mid-way buffer (filled at Muniguda so the
  // truck unloads and gets back there without refilling at Korba: always 120–140 L, carried to the next
  // trip) — an entry to check
  if (tripDiesel) {
    const zs = [...tripDiesel.values()].filter((z) => z.allotted != null);
    const rkey = (t) => `${lc(t.port)}|${lc(t.dest)}`;
    const usualOf = new Map();
    for (const z of zs) {
      if (z.live || z.est || !z.t.unloadDate || daysBetween(z.t.unloadDate, today) > 180) continue;
      if (!usualOf.has(rkey(z.t))) usualOf.set(rkey(z.t), []);
      usualOf.get(rkey(z.t)).push(z.taken);
    }
    for (const z of zs) {
      const t = z.t;
      if (!(t.loadDate || t.start) || (t.loadDate || t.start) < from) continue;
      const over = z.taken - z.allotted;
      const xs = usualOf.get(rkey(t)) || [];
      const usual = xs.length >= 5 ? median(xs) : null;
      const buffer = z.buffer && Number.isFinite(z.buffer.max) ? z.buffer : { min: 120, max: 140 };   // the planned mid-way buffer
      if (over > buffer.max + 2) {
        // a trip next to it that's as far under: the first / last fill probably belongs there
        const mine = (byVeh.get(t.veh) || []).slice().sort((x, y) => x.row - y.row);
        const k = mine.indexOf(t);
        const near = [[mine[k - 1], z.fills[0]], [mine[k + 1], z.fills[z.fills.length - 1]]]
          .map(([n, h]) => ({ n, h, nz: n && tripDiesel.get(n.row) }))
          .find(({ nz, h }) => nz && h && nz.allotted != null && nz.allotted - nz.taken >= 0.6 * Math.min(over, h.qty) && Math.abs(h.qty - (nz.allotted - nz.taken)) <= Math.max(40, 0.4 * h.qty));
        const lead = `${short(t.veh)} ${t.trip}: ${L(z.taken)} of diesel tagged against ${L(z.allotted)} allotted (+${L(over)} — more than the ${buffer.min}–${buffer.max} L mid-way buffer)${usual != null ? ` — trucks on this route usually take ${L(usual)}` : ''}.`;
        add({ level: 'bad', kind: 'overdraw', veh: t.veh, date: t.loadDate || t.start, row: t.row, href: tripUrl(t), src: near ? near.h : undefined,
          text: near
            ? `${lead} The ${L(near.h.qty)} fill on ${dm(near.h.date)}${near.h.location ? ` at ${near.h.location}` : ''}${slip(near.h) ? ` (${slip(near.h)})` : ''} probably belongs to ${near.n.trip}, which is ${L(near.nz.allotted - near.nz.taken)} under its allotment — tagged to the wrong trip?`
            : `${lead} A fill tagged to the wrong trip, or extra taken?` });
      }
    }
  }

  // the same fill twice, a slip no. used twice
  const counted = hsd.filter((h) => !isIncentive(h));
  const seenDup = new Set();
  for (let i = 0; i < counted.length; i++) {
    for (let j = i + 1; j < counted.length; j++) {
      const a = counted[i];
      const b = counted[j];
      if (a.veh !== b.veh || !a.qty || a.qty !== b.qty || Math.abs(daysBetween(a.date, b.date)) > 1) continue;
      if (a.bill && b.bill && lc(a.bill) !== lc(b.bill)) continue;               // two different slips: two fills
      seenDup.add(a); seenDup.add(b);
      add({ level: 'bad', kind: 'dup-fill', veh: a.veh, date: b.date > a.date ? b.date : a.date, src: b, also: a, href: `#/vehicle/${encodeURIComponent(a.veh)}`,
        text: `${short(a.veh)}: ${L(a.qty)} diesel entered twice? ${dm(a.date)}${slip(a) ? ` (${slip(a)})` : ''} and ${dm(b.date)}${slip(b) ? ` (${slip(b)})` : ''}${a.location || b.location ? ` at ${a.location || b.location}` : ''}` });
    }
  }
  const bills = new Map();
  for (const h of data.hsd || []) {
    if (!h.bill || !String(h.bill).trim()) continue;
    const k = lc(h.bill);
    if (!bills.has(k)) bills.set(k, []);
    bills.get(k).push(h);
  }
  for (const [, list] of bills) {
    if (list.length < 2 || !list.some((h) => h.date >= from)) continue;
    if (list.every((h) => seenDup.has(h))) continue;
    const last = list.reduce((a, h) => (h.date > a.date ? h : a));
    add({ level: 'bad', kind: 'dup-fill', veh: last.veh, date: last.date, src: last, href: `#/vehicle/${encodeURIComponent(last.veh)}`,
      text: `Slip ${slip(last)} entered ${list.length} times: ${list.map((h) => `${short(h.veh)} ${dm(h.date)} ${L(h.qty)}`).join(', ')}` });
  }

  // a fill on the wrong trip
  for (const h of hsd) {
    if (!String(h.trip || '').trim()) {
      add({ level: 'warn', kind: 'wrong-trip', veh: h.veh, date: h.date, src: h, href: `#/vehicle/${encodeURIComponent(h.veh)}`, text: `${short(h.veh)} · ${dm(h.date)}: ${L(h.qty)} diesel${slip(h) ? ` (${slip(h)})` : ''} isn't tagged to any trip` });
      continue;
    }
    const t = tripOf.get(`${h.veh}|${lc(h.trip)}`);
    if (!t) {
      add({ level: 'bad', kind: 'wrong-trip', veh: h.veh, date: h.date, src: h, href: `#/vehicle/${encodeURIComponent(h.veh)}`, text: `${short(h.veh)} · ${dm(h.date)}: ${L(h.qty)} diesel${slip(h) ? ` (${slip(h)})` : ''} is tagged to ${h.trip}, which this truck doesn't have in the Trip Register` });
      continue;
    }
    if (!t.start) continue;
    if (h.date >= addDays(t.start, -1) && h.date <= end(t)) continue;
    const other = (byVeh.get(h.veh) || []).find((x) => x !== t && x.start && h.date >= x.start && h.date <= end(x));
    add({ level: other ? 'bad' : 'warn', kind: 'wrong-trip', veh: h.veh, date: h.date, src: h, href: tripUrl(t),
      text: `${short(h.veh)} · ${dm(h.date)}: ${L(h.qty)} diesel${slip(h) ? ` (${slip(h)})` : ''} is tagged to ${t.trip} (started ${dm(t.start)}${t.unloadDate ? `, unloaded ${dm(t.unloadDate)}` : ''})${other ? ` — but that day the truck was on ${other.trip}` : ' — outside that trip\'s dates'}` });
  }

  // a fill's amount and price
  const byWeek = (h) => counted.filter((x) => x !== h && x.rsp && Math.abs(daysBetween(x.date, h.date)) <= 7 && lc(x.location) === lc(h.location));
  for (const h of counted) {
    if (h.qty && h.rsp && h.amount && Math.abs(h.qty * h.rsp - h.amount) > 5) {
      add({ level: 'warn', kind: 'fill-math', veh: h.veh, date: h.date, src: h, href: `#/vehicle/${encodeURIComponent(h.veh)}`, text: `${short(h.veh)} · ${dm(h.date)}${slip(h) ? ` (${slip(h)})` : ''}: ${L(h.qty)} × ₹${h.rsp.toFixed(2)} = ₹${ind(h.qty * h.rsp)}, but the amount is ₹${ind(h.amount)}` });
      continue;
    }
    const near = byWeek(h);
    const m = near.length >= 3 ? median(near.map((x) => x.rsp)) : null;
    if (m && h.rsp && Math.abs(h.rsp - m) > 2) {
      add({ level: 'warn', kind: 'fill-math', veh: h.veh, date: h.date, src: h, href: `#/vehicle/${encodeURIComponent(h.veh)}`, text: `${short(h.veh)} · ${dm(h.date)}${slip(h) ? ` (${slip(h)})` : ''}: diesel at ₹${h.rsp.toFixed(2)}/L — other fills at ${h.location || 'the same pump'} that week were ₹${m.toFixed(2)}` });
    }
  }

  // trips: dates, how long they took to unload, weights, rates
  const route = (t) => `${lc(t.port)}|${lc(t.dest)}`;
  const lately = trips.filter((t) => t.loadDate && t.unloadDate && t.unloadDate <= today && daysBetween(t.unloadDate, today) <= 150);
  const daysOn = new Map();
  const loadsOn = new Map();
  for (const t of lately) {
    const d = daysBetween(t.loadDate, t.unloadDate);
    if (d < 0 || d > 60) continue;
    if (!daysOn.has(route(t))) daysOn.set(route(t), []);
    daysOn.get(route(t)).push(d);
  }
  for (const t of trips.filter((x) => x.loadWt && x.loadDate && daysBetween(x.loadDate, today) <= 150)) {
    if (!loadsOn.has(route(t))) loadsOn.set(route(t), []);
    loadsOn.get(route(t)).push(t.loadWt);
  }
  for (const t of trips) {
    const when = t.unloadDate || t.loadDate || t.start;
    if (!when || when < from) continue;
    const r = `${t.port || '?'} → ${t.dest || '?'}`;
    // dates
    let bad = '';
    if (t.unloadDate && t.unloadDate > today) bad = `unload date ${dm(t.unloadDate)} ${t.unloadDate.slice(0, 4)} is after today`;
    else if (t.loadDate && t.unloadDate && t.unloadDate < t.loadDate) bad = `unloaded (${dm(t.unloadDate)}) before it was loaded (${dm(t.loadDate)})`;
    else if (t.start && t.loadDate && t.loadDate < t.start) bad = `loaded (${dm(t.loadDate)}) before the trip started (${dm(t.start)})`;
    else if (t.start && t.unloadDate && daysBetween(t.start, t.unloadDate) > 60) bad = `${daysBetween(t.start, t.unloadDate)} days from the trip start (${dm(t.start)} ${t.start.slice(0, 4)}) to unloading — a year typed wrong?`;
    if (bad) add({ level: 'bad', kind: 'dates', veh: t.veh, date: when, row: t.row, href: tripUrl(t), text: `${short(t.veh)} ${t.trip}: ${bad}` });
    // unloading far later than the route takes lately
    const usual = median(daysOn.get(route(t)) || []);
    const took = t.loadDate && t.unloadDate ? daysBetween(t.loadDate, t.unloadDate) : null;
    if (!bad && took != null && usual != null && (daysOn.get(route(t)) || []).length >= 5 && took >= Math.max(usual + 3, usual * 2)) {
      add({ level: took >= usual + 7 ? 'bad' : 'warn', kind: 'slow-unload', veh: t.veh, date: t.unloadDate, row: t.row, href: tripUrl(t),
        text: `${short(t.veh)} ${t.trip}: unloaded ${took} days after loading (${dm(t.loadDate)} → ${dm(t.unloadDate)}) — on ${r} trucks lately take ${usual} — a date typed wrong, or held up?` });
    }
    // weights
    const ws = loadsOn.get(route(t)) || [];
    const mw = ws.length >= 5 ? median(ws) : null;
    if (t.loadWt && mw && t.loadDate >= from && (t.loadWt < mw - 6 || t.loadWt > mw + 8)) {
      add({ level: 'warn', kind: 'weight', veh: t.veh, date: t.loadDate, row: t.row, href: tripUrl(t), text: `${short(t.veh)} ${t.trip}: loaded ${t.loadWt.toFixed(2)} T — trucks on ${r} usually load about ${mw.toFixed(2)} T. A typo?` });
    }
    if (t.loadWt && t.unloadWt && t.unloadWt - t.loadWt > 0.3) {
      add({ level: 'warn', kind: 'weight', veh: t.veh, date: t.unloadDate || when, row: t.row, href: tripUrl(t), text: `${short(t.veh)} ${t.trip}: ${t.unloadWt.toFixed(2)} T unloaded from ${t.loadWt.toFixed(2)} T loaded (+${(t.unloadWt - t.loadWt).toFixed(2)} T)` });
    }
    // the rate and the freight
    if (t.loadWt && t.rate && t.bhada != null && Math.abs(t.bhada - t.loadWt * t.rate) > 10) {
      add({ level: 'warn', kind: 'rate', veh: t.veh, date: t.loadDate || when, row: t.row, href: tripUrl(t), text: `${short(t.veh)} ${t.trip}: freight ₹${ind(t.bhada)} ≠ ${t.loadWt.toFixed(2)} T × ₹${ind(t.rate)} (₹${ind(t.loadWt * t.rate)})` });
    }
    if (t.rate && t.month) {
      const same = trips.filter((x) => x !== t && x.rate && x.month === t.month && route(x) === route(t)).map((x) => x.rate);
      const m = same.length >= 3 ? median(same) : null;
      if (m && Math.abs(t.rate - m) > 1 && same.filter((x) => x === m).length >= same.length * 0.6) {
        add({ level: 'warn', kind: 'rate', veh: t.veh, date: t.loadDate || when, row: t.row, href: tripUrl(t), text: `${short(t.veh)} ${t.trip}: rate ₹${ind(t.rate)}/T — the other trips on ${r} that month are ₹${ind(m)}/T` });
      }
    }
  }

  // the same urea fill or advance twice
  const twice = (rows, key, kind, what) => {
    const seen = new Map();
    for (const x of rows) {
      if (!x.date || x.date < from || x.date > today) continue;
      const k = key(x);
      if (seen.has(k)) add({ level: 'warn', kind, veh: x.veh, date: x.date, src: x, href: kind === 'dup-advance' ? `#/drivers/${encodeURIComponent(x.veh)}` : `#/vehicle/${encodeURIComponent(x.veh)}`, text: what(x) });
      else seen.set(k, x);
    }
  };
  twice(data.urea || [], (u) => `${u.veh}|${u.date}|${u.qty}|${u.amount}`, 'dup-urea', (u) => `${short(u.veh)} · ${dm(u.date)}: urea ${u.qty} L (₹${ind(u.amount)}) entered twice?`);
  twice(data.driverPay || [], (p) => `${p.veh}|${p.date}|${p.amount}`, 'dup-advance', (p) => `${short(p.veh)} · ${dm(p.date)}: advance ₹${ind(p.amount)}${p.name ? ` to ${p.name}` : ''} entered twice?`);

  const order = { bad: 0, warn: 1 };
  return out.sort((a, b) => order[a.level] - order[b.level] || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// for marking the day book: a fill / urea / advance row or a trip row → its problems
export function irregularIndex(list) {
  const bySrc = new Map();
  const byRow = new Map();
  for (const x of list) {
    for (const r of [x.src, x.also]) { if (r) { if (!bySrc.has(r)) bySrc.set(r, []); bySrc.get(r).push(x); } }
    if (x.row != null) { if (!byRow.has(x.row)) byRow.set(x.row, []); byRow.get(x.row).push(x); }
  }
  return { bySrc, byRow };
}
