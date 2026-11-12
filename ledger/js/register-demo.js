// The demo's Register (/ledger/?demo → Register): a made-up month of the
// E-DSR, Stock Register and DIP Chart, shaped exactly as register.js reads
// the real workbooks. Nothing here is real: a made-up tank chart (a
// horizontal cylinder), meter readings, receipts and dips, the same every
// time for the same day.

import { PRODUCTS, dateOf, daysIn, dipOf } from './register.js';

const round2 = (n) => Math.round(n * 100) / 100;

// the chart: dip 1.0 … 209.0 cm -> litres, a 210 cm × 6.27 m cylinder (~21,700 L)
export function demoChart() {
  const r = 105;
  const len = 627;
  const out = [];
  for (let i = 10; i <= 2090; i++) {
    const h = i / 10;
    const area = r * r * Math.acos((r - h) / r) - (r - h) * Math.sqrt(2 * r * h - h * h);
    out.push([h, round2((area * len) / 1000)]);
  }
  return out;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const NOZZLES = {
  HSD: [['Machine No. 1', 'A1'], ['Machine No. 1', 'B1'], ['Machine No. 2', 'A1'], ['Machine No. 2', 'B1']],
  MS: [['Machine No. 1', 'A2'], ['Machine No. 1', 'B2']],
  XG: [['Machine No. 3', 'A1'], ['Machine No. 3', 'B1']],
};
const SALE = { HSD: [5200, 9800], MS: [650, 980], XG: [0, 45] };
const TEST = { HSD: 40, MS: 20, XG: 10 };
const LOAD = { HSD: 24000, MS: 6000, XG: 4000 };
const START = { HSD: [16800, 15400], MS: [9600], XG: [5100] };
const SHORT = { HSD: 1240.5, MS: 310.25, XG: 85.4 };
const TITLE = { HSD: 'DIESEL', MS: 'PETROL', XG: 'XTRAGREEN' };

// -> [{kind, fileName, doc, log}] for memoryStore's seed.register
export function demoRegister(today = new Date()) {
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const month = iso.slice(0, 7);
  const n = daysIn(month);
  const upTo = Math.min(+iso.slice(8, 10), n);            // this morning's readings are in; its sale isn't yet
  const chart = demoChart();
  const snap = (v) => { const d = dipOf(chart, v); return chart.find((x) => x[0] === d)[1]; };   // as the DIP Chart reads a stock
  const rand = rng(+month.replace('-', ''));
  const dsr = { month, products: {} };
  const stock = { month, products: {} };
  const log = {};
  const mornings = {};                                      // date -> {MS, HSD, XG, HSD1, HSD2}
  for (const p of PRODUCTS) {
    const k = p.key;
    const tanks = START[k].map(snap);
    const meters = NOZZLES[k].map((_, i) => round2(184000 + i * 91000 + rand() * 50000));
    let book = round2(tanks.reduce((a, v) => a + v, 0) + SHORT[k]);
    const days = [];
    const actual = [];
    const open = book;
    for (let d = 1; d <= n + 1; d++) {
      const date = dateOf(month, d);
      const m = mornings[date] || (mornings[date] = {});
      if (d <= upTo) {
        m[k] = round2(tanks.reduce((a, v) => a + v, 0));
        if (k === 'HSD') { m.HSD1 = tanks[0]; m.HSD2 = tanks[1]; }
      }
      if (d > upTo) { days.push({ receipt: null, test: null, meters: null }); continue; }
      const day = { receipt: null, test: null, meters: [...meters] };
      days.push(day);
      if (d === upTo || d > n) continue;                   // today: only the morning's readings
      // a load when the tanks run low
      const room = tanks.map((v) => 21000 - v);
      const low = tanks.reduce((a, v) => a + v, 0) < (k === 'HSD' ? 17000 : 6000);
      if (low && (k !== 'XG' || d % 9 === 4)) {
        day.receipt = LOAD[k];
        let left = LOAD[k];
        for (let t = 0; t < tanks.length && left > 0; t++) { const put = Math.min(left, room[t] > 0 ? room[t] : 0); tanks[t] = round2(tanks[t] + put); left -= put; }
        if (left > 0) tanks[0] = round2(tanks[0] + left);
      }
      day.test = TEST[k];
      const sale = round2(SALE[k][0] + rand() * (SALE[k][1] - SALE[k][0]));
      // the meters run sale + testing, split over the nozzles
      const w = NOZZLES[k].map(() => 0.5 + rand());
      const wt = w.reduce((a, v) => a + v, 0);
      let run = 0;
      w.forEach((x, i) => {
        const add = i === w.length - 1 ? round2(sale + TEST[k] - run) : round2(((sale + TEST[k]) * x) / wt);
        run = round2(run + add);
        meters[i] = round2(meters[i] + add);
      });
      book = round2(book + (day.receipt || 0) - sale);
      // what leaves the tanks: the sale and a little more (the demo's shortage)
      const loss = round2(sale * (0.0006 + rand() * 0.0012));
      const out = sale + loss;
      tanks.forEach((v, t) => { tanks[t] = snap(Math.max(500, v - out / tanks.length)); });
      actual.push(round2(tanks.reduce((a, v) => a + v, 0)));
    }
    while (actual.length < n) actual.push(null);
    dsr.products[k] = { sheet: TITLE[k][0] + TITLE[k].slice(1).toLowerCase(), title: `${TITLE[k]} MONTH OF ${month}`, month,
      nozzles: NOZZLES[k].map(([machine, label]) => ({ label, machine })), open, days };
    stock.products[k] = { sheet: k, month, sno: true, openShortage: SHORT[k], testAdjust: k === 'HSD' ? 0 : null, actual };
  }
  for (const [date, m] of Object.entries(mornings)) {
    if (m.MS == null) continue;
    log[`${date}|mac`] = { MS: m.MS, HSD: m.HSD, XG: m.XG };
    log[`${date}|chart`] = { MS: m.MS, HSD: m.HSD, XG: m.XG, HSD1: m.HSD1, HSD2: m.HSD2 };
  }
  const last = mornings[dateOf(month, upTo)];
  const reading = { date: dateOf(month, upTo), MS: last.MS, HSD1: last.HSD1, HSD2: last.HSD2, XG: last.XG };
  // the month before: only its last morning (the first day's opening stock)
  const first = mornings[dateOf(month, 1)];
  log[`${dateOf(month, 1)}|log`] = { MS: first.MS, HSD: first.HSD, XG: first.XG };
  return [
    { kind: 'dsr', fileName: 'Demo E-DSR.xlsx', doc: dsr, log: {} },
    { kind: 'stock', fileName: 'Demo Stock Register.xlsm', doc: stock, log: Object.fromEntries(Object.entries(log).filter(([x]) => x.endsWith('|mac'))) },
    { kind: 'dipchart', fileName: 'Demo DIP Chart.xlsm', doc: { chart, reading }, log: Object.fromEntries(Object.entries(log).filter(([x]) => !x.endsWith('|mac'))) },
  ];
}
