// Random — often messy — fuel logs for the Tanker Loading diesel estimate, with
// what the app's model says for each tanker. tests/test_loading_schema.py loads
// the same logs into Postgres and checks the database says the same.
// Usage: node tests/loading_web/fuzz_cases.mjs [cases] [seed]   → JSON on stdout
import { loadModel, DESTS } from './sim.mjs';

const PLATES = ['OD23A3710', 'OR15R1110', 'OR15R5510', 'OD15AF5510'];
const T0 = Date.UTC(2026, 8, 1, 6, 0), H = 3600e3;

export function makeCase(seed) {
  let s = seed >>> 0 || 1;
  const R = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = (a) => a[Math.floor(R() * a.length)];
  const rows = [], trips = [];
  let id = 0, cts = 0;
  for (const plate of PLATES.filter(() => R() < 0.75)) {
    const meter = plate === 'OD15AF5510';
    let t = T0 + Math.floor(R() * 48) * H, odo = meter ? 100000 + Math.floor(R() * 5000) : 20000 + Math.floor(R() * 90000);
    const n = Math.floor(R() * 9);
    for (let i = 0; i < n; i++) {
      t += (1 + Math.floor(R() * 60)) * H;
      odo += meter ? Math.round(300 + R() * 4000) : Math.round(R() < 0.15 ? R() * 40 : 60 + R() * 700);
      const kind = R();
      let litres = kind < 0.3 ? 0 : Math.round((meter ? 20 + R() * 35 : 40 + R() * 330) * 100) / 100;
      let anguls = meter || R() < 0.25 ? null : Math.floor(R() * 22);
      let stock_l = anguls != null ? anguls * 16 : (R() < 0.3 ? Math.round(R() * (meter ? 40 : 300)) : null);
      if (litres === 0 && stock_l == null) { anguls = meter ? null : Math.floor(R() * 20); stock_l = anguls != null ? anguls * 16 : Math.round(R() * 40); }
      let o = odo;
      const mess = R();
      if (mess < 0.04) o = odo * 10;                               // an extra digit
      else if (mess < 0.08) o = Math.max(0, odo - 900);            // going back
      else if (mess < 0.11) litres = litres * 10;                  // litres typed ×10
      const row = { id: 'r' + id++, plate, ts: t, cts: ++cts, odo: o, litres, anguls, stock_l };
      rows.push(row);
      if (R() < 0.08) rows.push({ ...row, id: 'r' + id++, cts: ++cts });   // saved twice
      // trips after this entry, some to a customer not in the list
      for (let k = Math.floor(R() * 3); k > 0; k--) {
        trips.push({ plate, ts: t + k * 2 * H, dest: R() < 0.15 ? 'Nowhere Ltd' : pick(DESTS).name, total: meter ? Math.round(1000 + R() * 9000) : 12000 });
      }
    }
  }
  rows.sort((a, b) => a.ts - b.ts || a.cts - b.cts);
  const m = loadModel(rows, trips);
  const expect = {};
  for (const plate of PLATES) expect[plate] = m.fuelState(plate);
  return { seed, rows, trips, expect };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const n = +process.argv[2] || 60, seed = +process.argv[3] || 1;
  const out = [];
  for (let i = 0; i < n; i++) out.push(makeCase(seed * 7919 + i * 104729));
  process.stdout.write(JSON.stringify(out));
}
