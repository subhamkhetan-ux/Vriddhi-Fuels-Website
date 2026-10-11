// What a new upload changes against the one saved now — so a day's edits can
// be checked before saving, and an old copy of the workbook (or a file with a
// sheet missing) is caught before it replaces newer data.
//
// Every upload replaces the saved data as a whole (the Excel file is the
// truth): trips added, edited or deleted in Excel show up here and then in
// the app exactly as they are in the file. Trips are matched by vehicle and
// trip number (row numbers move when rows are inserted or deleted); the
// other sheets' entries by their contents. Pure functions.

const TRIP_FIELDS = {
  start: 'Trip Start Date', loadDate: 'Loading Date', loadWt: 'Load Weight', unloadDate: 'Unload Date', unloadWt: 'Unload Weight',
  port: 'Loading Port', dest: 'Destination', tare: 'Tare Weight', gross: 'Gross Weight', rate: 'Price/Ton', bhada: 'Trip Bhada',
  ssfcLtr: 'SSFC Diesel Ltr', ssfcAmt: 'SSFC Diesel Amount', extraLtr: 'Extra HSD Ltr', extraAmt: 'Extra HSD Amt',
  ownLtr: 'Trip Diesel Ltr', ownAmt: 'Trip Diesel Amount', urea: 'Own Urea', drvExtra: 'Extra Own Driver Pay',
  drvTrip: 'Trip Driver Payment', drvSsfc: 'Driver SSFC Payment', docOwn: 'Own Document Exp.', ssfcMisc: 'SSFC Misc',
  ownMisc: 'Own Misc Kharcha', fastag: 'Fastag', maint: 'Maintenance', tyre: 'Tyre', lessOver: 'Less Over/Unload',
  rtoEntry: 'RTO Entry', rtoChallan: 'RTO Challan', shortage: 'Shortage', docExp: 'Document Expense', ssfcNet: 'SSFC Net Amount',
  emi: 'Installment', income: 'Income/Trip', drvDebit: 'Driver Debit', remarks: 'Remarks',
};
const DATES = new Set(['start', 'loadDate', 'unloadDate']);
const same = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Math.abs((a || 0) - (b || 0)) < 0.005 : (a || '') === (b || ''));

// key → item, the 2nd of a repeated key gets “#2”
function keyed(xs, key) {
  const m = new Map();
  const n = new Map();
  for (const x of xs || []) {
    const k = key(x);
    const i = (n.get(k) || 0) + 1;
    n.set(k, i);
    m.set(i > 1 ? `${k}#${i}` : k, x);
  }
  return m;
}
// entries as a multiset of their contents: added / removed
function bag(before, after, key) {
  const a = keyed(before, key);
  const b = keyed(after, key);
  return { added: [...b.entries()].filter(([k]) => !a.has(k)).map(([, x]) => x), removed: [...a.entries()].filter(([k]) => !b.has(k)).map(([, x]) => x) };
}

export function compareUploads(prev, next) {
  const tk = (t) => `${t.veh}|${t.trip}`;
  const a = keyed(prev.trips, tk);
  const b = keyed(next.trips, tk);
  const added = [];
  const changed = [];
  for (const [k, t] of b) {
    const o = a.get(k);
    if (!o) { added.push(t); continue; }
    const fields = Object.keys(TRIP_FIELDS).filter((f) => !same(o[f], t[f])).map((f) => ({ key: f, name: TRIP_FIELDS[f], from: o[f] ?? null, to: t[f] ?? null, date: DATES.has(f) }));
    if (fields.length) changed.push({ t, before: o, fields });
  }
  const removed = [...a.entries()].filter(([k]) => !b.has(k)).map(([, t]) => t);
  // went back: a date or weight filled before is blank now (an old copy looks like this)
  const backwards = changed.filter((c) => c.fields.some((f) => ['loadDate', 'unloadDate', 'loadWt', 'unloadWt'].includes(f.key) && f.from != null && f.to == null));

  const pay = bag(prev.driverPay, next.driverPay, (p) => `${p.date}|${p.veh}|${p.amount}|${p.name}|${p.note || ''}`);
  const hsd = bag(prev.hsd, next.hsd, (h) => `${h.date}|${h.veh}|${h.bill}|${h.qty}|${h.amount}|${h.trip}`);
  const urea = bag(prev.urea, next.urea, (u) => `${u.date}|${u.veh}|${u.bill}|${u.qty}|${u.amount}|${u.trip}`);
  const roster = bag(prev.roster, next.roster, (r) => `${r.veh}|${r.name}`);
  const lrows = (d) => (d.ssfc && d.ssfc.rows) || [];
  const ledger = bag(lrows(prev), lrows(next), (r) => JSON.stringify([r.month, r.veh, r.net, r.paidCash, r.paidAcct, r.invoice, r.paidDate, r.balCash, r.balAcct]));

  const sheets = [];
  if ((prev.driverPay || []).length && !(next.driverPay || []).length) sheets.push('Driver Payment');
  if ((prev.hsd || []).length && !(next.hsd || []).length) sheets.push('HSD Data');
  if ((prev.urea || []).length && !(next.urea || []).length) sheets.push('Urea DEF');
  if (lrows(prev).length && !lrows(next).length) sheets.push('Ledger');

  const trips = { added, removed, changed, backwards };
  const out = { trips, pay, hsd, urea, roster, ledger, sheets, latest: { from: prev.latest || null, to: next.latest || null } };
  out.none = !added.length && !removed.length && !changed.length && ![pay, hsd, urea, roster, ledger].some((x) => x.added.length || x.removed.length);
  out.risks = risks(prev, next, out);
  return out;
}

// reasons to stop and look before saving: { level: 'stop' | 'warn', text }
function risks(prev, next, c) {
  const out = [];
  const stop = (text) => out.push({ level: 'stop', text });
  const warn = (text) => out.push({ level: 'warn', text });
  if (c.sheets.length) stop(`${c.sheets.join(', ')} ${c.sheets.length === 1 ? 'is' : 'are'} empty or missing in this file but saved now — the app would lose ${c.sheets.length === 1 ? 'it' : 'them'}.`);
  if (c.latest.from && c.latest.to && c.latest.to < c.latest.from) stop(`This file's newest trip (${c.latest.to}) is older than the saved one's (${c.latest.from}) — an old copy of the workbook?`);
  const gone = c.trips.removed.length;
  if (gone >= 3) stop(`${gone} saved trips aren't in this file — an old copy, or rows deleted by mistake?`);
  else if (gone) warn(`${gone === 1 ? 'A saved trip is' : `${gone} saved trips are`} not in this file (deleted in Excel?).`);
  const back = c.trips.backwards.length;
  if (back >= 3) stop(`${back} trips have lost a loading / unloading date or weight that's saved now — an old copy?`);
  else if (back) warn(`${back === 1 ? 'A trip has' : `${back} trips have`} lost a loading / unloading date or weight (cleared in Excel?).`);
  for (const [name, x, n] of [['HSD fills', c.hsd, prev.hsd], ['urea entries', c.urea, prev.urea], ['driver advances', c.pay, prev.driverPay]]) {
    const r = x.removed.length;
    if (!r || !(n || []).length) continue;
    if (r >= 5 && r > x.added.length) stop(`${r} saved ${name} aren't in this file.`);
    else if (r > x.added.length) warn(`${r} saved ${name} ${r === 1 ? 'is' : 'are'} not in this file (deleted or edited in Excel?).`);
  }
  return out;
}

export const blocking = (c) => c.risks.some((r) => r.level === 'stop');
