// Test helpers for the Tanker Loading mileage model.
//  loadModel(): the model code exactly as shipped — cut from loading/index.html
//    between "MILEAGE MODEL (robust)" and "function stretchTxt" — with the
//    few app helpers it leans on.
//  simulate(): a tanker running on its own diesel at a known mileage, dipped
//    in whole Anguls (a dip stick reads down to the Angul below), refilled near
//    empty, with optional stock checks and injected faults.
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../../loading/index.html', import.meta.url), 'utf8');
const START = HTML.indexOf('/* ===================== MILEAGE MODEL (robust)');
const END = HTML.indexOf('function stretchTxt(o)');
if (START < 0 || END < START) throw new Error('mileage model markers not found in loading/index.html');
const SRC = HTML.slice(START, END);

export const DESTS = [{ name: 'DBL - Siarmal', rtd: 140 }, { name: 'Shyam Metalics', rtd: 36 }];

export function loadModel(rows, trips = [], src = SRC) {
  const f = new Function('rows', 'trips', 'DESTS', `
    const SETTINGS = { angul_l: 16, alert_pct: 15, reserve_l: 40 };
    const r1 = (n) => Math.round((+n || 0) * 10) / 10, r2 = (n) => Math.round((+n || 0) * 100) / 100;
    const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const dmy = (k) => k, dayKey = (ms) => new Date(ms).toISOString().slice(0, 10), timeLabel = (ms) => new Date(ms).toISOString().slice(11, 16);
    const angulL = () => 16, alertP = () => 0.15, isMeter = (p) => p === 'OD15AF5510';
    const fuelRows = (p) => rows.filter((r) => r.plate === p).sort((a, b) => a.ts - b.ts || (a.cts || 0) - (b.cts || 0));
    const tripsIn = (p, a, b) => trips.filter((t) => t.plate === p && t.ts > a && t.ts <= b);
    const destOf = (n) => DESTS.find((d) => d.name === n);
    const median = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
    const tripKm = (t) => { const d = destOf(t.dest); return d ? d.rtd : 0; };
    const ratioTxt = (v, m) => v == null ? '—' : v.toFixed(2) + (m ? ' L/L' : ' km/L');
    ${src}
    return { analyse, mileagePoints, robustMileage, fuelNow, loosePoints, tankMileage,
      fuelState: (p) => fuelEstimate(p, rows, trips) };`);
  return f(rows, trips, DESTS);
}

export function simulate({ plate = 'OR15R1110', mpl = 2.6, days = 60, start = 291499, fillTo = 380, refillAt = 70,
  stockCheckEvery = 0, seed = 7, meter = false, jobL = [1200, 2400], faults = {} } = {}) {
  let rnd = seed; const R = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  const H = 3600e3; let t = Date.UTC(2026, 7, 1), odo = start, tank = fillTo < 200 ? fillTo * 0.2 : 200, id = 0, nTrip = 0;   // a small tank starts near dry
  const rows = [], trips = [];
  const dip = (v) => Math.floor(Math.max(0, v) / 16);
  const push = (o) => rows.push({ id: 'f' + (id++), plate, cts: t, note: '', ...o });
  push({ ts: t, odo, litres: fillTo - tank, anguls: meter ? null : dip(tank), stock_l: meter ? null : dip(tank) * 16 });
  tank = fillTo;
  for (let day = 0; day < days; day++) {
    for (let k = 0; k < 2; k++) {
      t += 12 * H;
      // a trip (km), or for the dispenser tanker a job (litres dispensed)
      const run = meter ? jobL[0] + R() * (jobL[1] - jobL[0]) : [140, 36, 70, 30, 16, 20][Math.floor(R() * 6)] * (0.97 + R() * 0.06);
      if (!meter) trips.push({ plate, ts: t - 1000, dest: DESTS[Math.floor(R() * 2)].name, total: 3000 });
      tank -= run / mpl; odo += run; nTrip++;
      if (faults.theftAtTrip && !faults.done && nTrip >= faults.theftAtTrip && tank >= (faults.theftL || 80) + (meter ? 5 : 60)) {
        tank -= faults.theftL || 80; faults.done = true;
      }
      if (stockCheckEvery && nTrip % stockCheckEvery === 0 && tank > refillAt) {
        push({ ts: t, odo: Math.round(odo), litres: 0, anguls: meter ? null : dip(tank), stock_l: meter ? Math.round(tank) : dip(tank) * 16 });
      }
      if (tank < refillAt) {
        const fill = meter ? Math.round(fillTo - Math.max(0, tank)) : Math.round(fillTo - Math.max(0, tank) + R() * 10);
        push({ ts: t + 60000, odo: Math.round(odo), litres: fill, anguls: meter ? null : dip(tank), stock_l: meter ? null : dip(tank) * 16 });
        tank = Math.max(0, tank) + fill;
      }
    }
  }
  return { rows, trips, truth: mpl };
}
