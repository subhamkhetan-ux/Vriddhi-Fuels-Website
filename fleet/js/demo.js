// Made-up demo data in the shape parse.js produces (/fleet/?demo). Every
// vehicle number, amount and invoice here is invented.

import { addDays, addMonths, monthOf, round2 } from './util.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATES = [
  { port: 'Kakinada', dest: 'BALCO', rate: 3467, diesel: 630, driver: 10000, driverExtra: 0 },
  { port: 'Gangavaram', dest: 'BALCO', rate: 2589, diesel: 530, driver: 9000, driverExtra: 0 },
  { port: 'Gopalpur', dest: 'Vedanta', rate: 1785, diesel: 310, driver: 0, driverExtra: 0 },
  { port: 'Kakinada', dest: 'Vedanta', rate: 3000, diesel: 580, driver: 0, driverExtra: 0 },
];

export function demoData(today) {
  const r = rng(20260611);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const between = (a, b) => a + r() * (b - a);
  const vehicles = ['XX01AB1001', 'XX01AB1002', 'XX01AB1003', 'XX01AB1004', 'XX01AB1005', 'XX01AB1006', 'XX01AB1007', 'XX01AB1008'];
  const emi = Object.fromEntries(vehicles.map((v, i) => [v, i % 2 ? 98000 : 112000]));
  const trips = [];
  const hsd = [];
  const urea = [];
  const start0 = addDays(today, -400);
  const counters = { BALCO: 0, JSG: 0 };
  let row = 3;
  const emiPaid = new Set();
  const plans = vehicles.map((veh, i) => ({ veh, at: addDays(start0, i * 2) }));
  for (;;) {
    plans.sort((a, b) => (a.at < b.at ? -1 : 1));
    const p = plans[0];
    if (p.at > today) break;
    const route = r() < 0.55 ? RATES[0] : r() < 0.5 ? RATES[2] : pick([RATES[1], RATES[3]]);
    const tag = route.dest === 'BALCO' ? 'BALCO' : 'JSG';
    counters[tag] += r() < 0.4 ? 1 : 0;
    const trip = `T${String(counters[tag] + 1).padStart(3, '0')}/${tag}`;
    const start = p.at;
    const loadDate = addDays(start, Math.round(between(1, 4)));
    const unloadDate = addDays(loadDate, Math.round(between(route.dest === 'BALCO' ? 4 : 2, route.dest === 'BALCO' ? 9 : 6)));
    const t = { row, sno: row - 2, trip, veh: p.veh, start, port: route.port, dest: route.dest, remarks: '' };
    row += 1;
    if (loadDate <= today) {
      t.loadDate = loadDate;
      t.loadWt = round2(between(37.5, 43.5));
      t.tare = round2(between(16.6, 17.4));
      t.gross = round2(t.loadWt + t.tare);
      t.rate = route.rate;
      t.bhada = round2(t.loadWt * t.rate);
      const litres = route.diesel + Math.round(between(-20, 30));
      if (r() < 0.75) { t.ssfcLtr = litres; t.ssfcAmt = round2(litres * 98.2); } else { t.ownLtr = litres; t.ownAmt = round2(litres * 92.6); }
      if (r() < 0.08) { t.extraLtr = 20; t.extraAmt = 1854.8; }
      t.drvSsfc = route.dest === 'BALCO' ? 12600 : 6500;
      if (r() < 0.2) t.drvTrip = pick([1000, 2000, 3000]);
      if (r() < 0.4) t.urea = pick([1060, 1590, 2120]);
      if (r() < 0.3) t.fastag = Math.round(between(9000, 20000));
      if (r() < 0.3) t.maint = Math.round(between(2000, 7000));
      if (r() < 0.2) t.tyre = Math.round(between(3000, 10000));
      if (r() < 0.25) t.rtoEntry = pick([8500, 10400, 13900]);
      if (r() < 0.2) t.ownMisc = Math.round(between(2000, 12000));
      const m = monthOf(loadDate);
      if (!emiPaid.has(`${p.veh}|${m}`)) { emiPaid.add(`${p.veh}|${m}`); t.emi = emi[p.veh]; }
      if (unloadDate <= today) {
        t.unloadDate = unloadDate;
        t.diff = r() < 0.12 ? -round2(between(0.05, 0.6)) : r() < 0.2 ? round2(between(0.02, 0.3)) : 0;
        t.unloadWt = round2(t.loadWt + t.diff);
        if (!t.diff) delete t.diff;
      }
      const ded = ['ssfcAmt', 'drvSsfc', 'fastag', 'maint', 'tyre', 'rtoEntry'].reduce((a, k) => a + (t[k] || 0), 0);
      t.ssfcNet = round2(t.bhada - ded);
      t.receivable = round2(t.bhada - (t.ssfcAmt || 0) - t.drvSsfc);
      t.income = round2(t.ssfcNet - ['extraAmt', 'ownAmt', 'urea', 'drvTrip', 'ownMisc', 'emi'].reduce((a, k) => a + (t[k] || 0), 0));
      t.month = m;
      for (const [k, src] of [['ssfcLtr', 'SSFC'], ['ownLtr', 'Vriddhi Fuels']]) {
        if (t[k]) hsd.push({ date: loadDate, bill: `D${row}`, veh: p.veh, qty: t[k], rsp: src === 'SSFC' ? 98.2 : 92.6, amount: t[k === 'ssfcLtr' ? 'ssfcAmt' : 'ownAmt'], source: src, location: src === 'SSFC' ? 'Muniguda' : 'Jharsuguda', trip });
      }
      if (t.urea) urea.push({ date: loadDate, bill: `DEF/${row}`, veh: p.veh, qty: t.urea / 53, price: 53, amount: t.urea, location: 'Jharsuguda', trip, from: pick(['Ganga Motors', 'Vriddhi Fuels', 'J H Motors']), details: `${route.port} to ${route.dest}` });
    }
    t.status = t.unloadDate ? 'done' : t.loadDate ? 'loaded' : 'empty';
    trips.push(t);
    p.at = addDays(t.unloadDate || today, Math.round(between(0, 2)) + 1);
    if (!t.unloadDate) p.at = addDays(today, 30);
  }
  // SSFC ledger: one row per vehicle per month, an invoice a month from the 3rd month
  const rows = [];
  const months = [...new Set(trips.filter((t) => t.month).map((t) => t.month))].sort();
  months.forEach((m, mi) => {
    if (m >= monthOf(today)) return;
    vehicles.forEach((veh) => {
      const net = round2(trips.filter((t) => t.veh === veh && t.month === m).reduce((a, t) => a + (t.ssfcNet || 0), 0));
      const x = { month: m, veh, net, invoice: '', remarks: '' };
      if (mi >= 2) {
        x.hireBase = 150000; x.igst = 27000; x.hireTotal = 177000;
        x.invoice = `INV/${m.replace('-', '')}`;
        x.diffCash = round2(net - 177000);
      }
      rows.push(x);
    });
    if (mi >= 3 && mi < months.length - 4) {
      const pay = rows.find((x) => x.month === m && x.veh === vehicles[0]);
      pay.paidAcct = 2200000;
      pay.paidDate = `${addMonths(m, 2)}-12`;
    }
  });
  return {
    version: 1, fileName: 'Demo Trip Register.xlsm', readAt: new Date().toISOString(),
    latest: trips.map((t) => t.loadDate || t.start).sort().pop(), demo: true,
    trips, hsd, urea, rates: RATES,
    ssfc: { party: { name: 'DEMO FREIGHT CARRIER', gstin: '' }, rows, memos: [{ label: 'Security deposit (made up)', amount: 500000 }], workbook: {} },
    recon: { fromRow: 3, underloadFromRow: 3, overloadOver: 58, underloadBelow: 58, perTonne: 5, noUnderloadPorts: ['Gangavaram'], rows: {} },
    checks: {}, warnings: [],
  };
}
