// Who drove which trip — from the Driver Payment sheet.
//
// The Trip Register's Trip Driver Payment adds up the advances paid on a
// vehicle between the trip's start and that vehicle's next trip start; the
// same window here gives each trip the drivers paid during it, and the last
// of them is the trip's driver (a new driver takes his first advance on his
// first trip). A trip with no advance keeps the driver before it, and trips
// before a vehicle's first advance get its first driver.
//
// A payment noted as a settlement (security deposit, bonus, balance, voucher
// clear, last trip …) says nothing about who's driving now, and a former
// driver paid once more after someone else took over (a final settlement)
// isn't counted as coming back unless the next trip is his too. Nor is a
// payment to someone who was driving another truck at the time (paid on it
// within two months before and after) — typed against the wrong vehicle, or
// handed over for someone else.
//
// Names are typed by hand, so they're matched loosely (and a one-letter slip
// in the surname is forgiven): Rafiq / Rafik,
// Ramesh / Ramesh Kumar, M D Anwar / MD Anwar are one person. The drivers
// list (who drives each truck now) gives the spelling shown. Pure functions.

const SETTLEMENT = /secur|bonus|balance|settle|clear|last\s*trip|full\s*(and|&)?\s*final|refund/i;

// a name in a form two spellings of the same name agree on
function tokens(name) {
  let s = String(name || '').toLowerCase().replace(/[^a-z ]/g, ' ');
  s = s.replace(/\b(mohd|mohammad|mohammed|muhammad|md)\b/g, 'md');
  const parts = s.split(/\s+/).filter(Boolean);
  const out = [];
  let initials = '';
  for (const p of parts) {                                      // "m d anwar" → "md anwar"
    if (p.length === 1) { initials += p; continue; }
    if (initials) { out.push(initials); initials = ''; }
    out.push(p);
  }
  if (initials) out.push(initials);
  return out.map((p) => p.replace(/q/g, 'k').replace(/z/g, 'j').replace(/ph/g, 'f').replace(/w/g, 'v')
    .replace(/([bcdfgjklmnprstv])h/g, '$1').replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/(.)\1+/g, '$1'));
}

export function sameDriver(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short[0] === long[0] && short.every((t) => long.includes(t))) return true;   // "Ramesh" ⊂ "Ramesh Kumar"
  // a slip in the surname: "Ramesh Yadv" / "Ramesh Yadav"
  return x.length === y.length && x.length > 1 && x[0] === y[0] && x.every((t, i) => t === y[i] || (t.length >= 4 && y[i].length >= 4 && edits(t, y[i]) <= 1));
}

function edits(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

export const isSettlement = (p) => SETTLEMENT.test(p.note || '');

// one person, one name: the drivers list's spelling, else the fullest one seen
export function driverNames(data) {
  const people = [];
  const add = (name, pref) => {
    if (!String(name || '').trim()) return;
    const p = people.find((x) => x.all.some((n) => sameDriver(n, name)));
    if (!p) { people.push({ name, pref, all: [name] }); return; }
    p.all.push(name);
    if (pref && !p.pref) { p.name = name; p.pref = true; } else if (!p.pref && name.length > p.name.length) p.name = name;
  };
  for (const r of data.roster || []) add(r.name, true);
  for (const p of data.driverPay || []) add(p.name, false);
  return (name) => (people.find((x) => x.all.some((n) => sameDriver(n, name))) || { name: String(name || '').trim() }).name;
}

// trip row → { name, paid: [payments in its window], carried: no advance of its own }
export function tripDrivers(data) {
  const out = new Map();
  const pays = data.driverPay || [];
  if (!pays.length) return out;
  const canon = driverNames(data);
  const DAY = 86400000;
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 60 * DAY;
  const elsewhere = (p) => {
    const other = pays.filter((q) => q.veh !== p.veh && sameDriver(q.name, p.name) && near(q.date, p.date));
    return other.some((q) => q.date <= p.date) && other.some((q) => q.date >= p.date)
      && !pays.some((q) => q !== p && q.veh === p.veh && sameDriver(q.name, p.name));
  };
  const vehicles = [...new Set(data.trips.map((t) => t.veh))];
  for (const veh of vehicles) {
    const trips = data.trips.filter((t) => t.veh === veh && t.start).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.row - b.row));
    const mine = pays.filter((p) => p.veh === veh).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.row - b.row));
    // the Excel window: start ≤ date < the next later start
    const windows = trips.map((t) => {
      const next = trips.find((x) => x.start > t.start);
      return mine.filter((p) => p.date >= t.start && (!next || p.date < next.start));
    });
    const said = windows.map((w) => {
      const named = w.filter((p) => p.name && !isSettlement(p) && !elsewhere(p));
      return named.length ? canon(named[named.length - 1].name) : null;
    });
    let cur = said.find(Boolean) || null;
    const before = new Set();
    trips.forEach((t, i) => {
      const s = said[i];
      if (s && s !== cur) {
        const nextSaid = said.slice(i + 1).find(Boolean);
        const returning = before.has(s);
        if (!returning || !nextSaid || nextSaid === s) { if (cur) before.add(cur); cur = s; }
      }
      out.set(t.row, { name: cur, paid: windows[i].map((p) => ({ ...p, name: canon(p.name) })), carried: !s });
    });
  }
  return out;
}

// who drives each vehicle now: the drivers list, else the last trip's driver
export function currentDrivers(data, trips = tripDrivers(data)) {
  const out = new Map();
  for (const t of [...data.trips].sort((a, b) => a.row - b.row)) {
    const d = trips.get(t.row);
    if (d && d.name) out.set(t.veh, { name: d.name, from: 'payments' });
  }
  const canon = driverNames(data);
  for (const r of data.roster || []) {
    const last = out.get(r.veh);
    out.set(r.veh, { name: canon(r.name), from: 'list', lastPaid: last ? last.name : null, matches: !last || sameDriver(last.name, r.name) });
  }
  return out;
}
