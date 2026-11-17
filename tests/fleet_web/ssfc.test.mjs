// SSFC's monthly statement: read whatever its layout, then checked against the books.
// Made-up vehicles (XX01AB1001…), trips and money only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dateOf, tripDates, kindOf, defLine, readStatement, statementFromText, vehOf } from '../../fleet/js/ssfcstmt.js';
import { reconcile, statementMath, defCheck } from '../../fleet/js/ssfcrecon.js';

const A = 'XX01AB1001';
const B = 'XX01AB1002';

// ---- a statement sheet, built the way SSFC lays one out ----------------------------------------
// opts: top (blank rows before the first block), extra (an unused column inserted after LR no.),
// labelCol (where the deduction labels sit), netCol, dates (how the loading dates are typed)
function statementRows(opts = {}) {
  const x = opts.extra ? 1 : 0;
  const C = (c) => (c >= 2 ? c + x : c);     // column after the inserted one
  const W = 21 + x;
  const blank = () => Array(W).fill(null);
  const rows = [['DEMO LOGISTIC SEP- 2026']];
  for (let i = 1; i < (opts.top || 1); i++) rows.push([]);
  const block = (veh, trips, lines) => {
    const title = blank(); title[C(2)] = veh; rows.push(title);
    const h1 = blank();
    Object.assign(h1, { 0: 'SL NO', 1: 'LR NO', [C(2)]: 'VEHICLE NO', [C(3)]: 'DATE', [C(4)]: 'LOADING WT', [C(5)]: 'DATE', [C(6)]: 'UNLDNG WT', [C(7)]: 'SHORTAGE/EXCESS', [C(8)]: 'DATE', [C(9)]: 'RAYAGADA DIESEL/DASPALLA', [C(13)]: 'DATE', [C(14)]: 'VRIDHHI FUEL', [C(19)]: 'FRIEGHT', [C(20)]: 'TOTAL' });
    if (x) h1[2] = 'REMARK';
    const h2 = blank();
    Object.assign(h2, { [C(9)]: 'DIESEL QTY.', [C(10)]: 'FUEL/LTR', [C(11)]: 'FUEL AMOUNT', [C(12)]: 'CASH', [C(14)]: 'DIESEL QTY.', [C(15)]: 'FUEL/LTR', [C(16)]: 'AMOUNT', [C(17)]: 'OFF CASH DATE', [C(18)]: 'CASH OFFICE' });
    rows.push(h1, h2);
    let sub = 0;
    trips.forEach((t, i) => {
      const r = blank();
      const pump = r2(t.qty * t.price);
      const vr = r2((t.vqty || 0) * (t.vprice || 0));
      const total = r2(t.wt * t.rate - pump - (t.cash || 0) - vr - t.office);
      sub += total;
      Object.assign(r, { 0: i + 1, 1: t.lr, [C(2)]: veh, [C(3)]: t.load, [C(4)]: t.wt, [C(5)]: t.unload, [C(6)]: t.uwt, [C(7)]: r2(t.uwt - t.wt), [C(8)]: t.fill, [C(9)]: t.qty, [C(10)]: t.price, [C(11)]: pump, [C(12)]: t.cash || 0,
        [C(13)]: t.vdate || null, [C(14)]: t.vqty || 0, [C(15)]: t.vprice || 0, [C(16)]: vr, [C(17)]: t.cdate, [C(18)]: t.office, [C(19)]: t.rate, [C(20)]: total });
      rows.push(r);
    });
    const s = blank(); s[C(20)] = r2(sub); rows.push(s);
    let ded = 0;
    for (const [label, amt] of lines) {
      const r = blank(); r[opts.labelCol ?? C(19)] = label; r[C(20)] = amt; rows.push(r); ded += amt;
    }
    const n = blank(); n[opts.netCol ?? C(16)] = 'NET AMOUNT'; n[C(20)] = r2(sub - ded); rows.push(n);
    rows.push([]);
  };
  const d = opts.dates || ((dd, mm) => `${dd}/${mm}/2026`);
  block(A, [
    { lr: 'LR101', load: d(3, 9), wt: 40, unload: d(5, 9), uwt: 39.9, fill: d(3, 9), qty: 300, price: 94, office: 5000, cdate: d(3, 9), rate: 1800 },
    { lr: 'LR102', load: d(12, 9), wt: 41.5, unload: d(14, 9), uwt: 41.5, fill: d(12, 9), qty: 310, price: 94, office: 5000, cdate: d(12, 9), rate: 1800, vdate: d(13, 9), vqty: 100, vprice: 92 },
  ], [['LESS FASTAG', 4000], ['LESS MAINT.', 3300], ['LESS OVER./UNLOAD.', 500], ['LESS RTO ENTRY', 9000]]);
  block(B, [
    { lr: 'LR201', load: d(8, 9), wt: 42, unload: d(10, 9), uwt: 41.8, fill: d(8, 9), qty: 305, price: 94, office: 6000, cdate: d(8, 9), rate: 1800 },
  ], [['LESS FASTAG', 2000], ['LESS MAINT.', 2000], ['LESS RTO ENTRY', 12000], ['LESS HYDRA', 3000]]);
  return rows;
}
const r2 = (n) => Math.round(n * 100) / 100;

// the expense sheet, header row and all; `shift` moves every column right (SSFC's months differ)
function expenseRows({ shift = 0, header = true } = {}) {
  const pad = Array(shift).fill(null);
  const rows = header ? [[...pad, 'SL', 'DATE', 'VEHICLE NO', 'PARTICULARS', 'EXPENSE HEAD', 'QTY', 'RATE', 'AMOUNT']] : [];
  const bill = (sl, date, veh, desc, head, qty, rate, amt) => rows.push([...pad, sl, date, veh, desc, head, qty, rate, amt]);
  bill(1, '04/09/2026', A, 'AD BLUE 20 LTR', 'MAINT.', 20, 65, 1300);       // DEF, one of ours
  bill(2, '15/09/2026', A, 'URIA AD ABLUE TARA TRINI', 'MAINT.', 1, 2000, 2000); // DEF, none of ours
  bill(3, '09/09/2026', A, 'DRIVER FOODING', 'DRI. FOODING', null, null, 500);
  bill(4, '10/09/2026', B, 'CLEARLUE 20 LTR', 'MAINT.', 20, 70, 1400);      // DEF, ours charged 1,300
  bill(5, '11/09/2026', B, 'AIR CHECK', 'MAINT.', null, null, 300);
  bill(6, '11/09/2026', B, 'AIR CHECK', 'MAINT.', null, null, 300);          // the same bill again
  return rows;
}

const book = (main, exp, ld) => ({ sheets: { Sheet1: { rows: main, r0: 1 }, ...(exp ? { EXPENSES: { rows: exp, r0: 1 } } : {}), ...(ld ? { 'LD SHEET': { rows: ld, r0: 1 } } : {}) } });

// the books: Trip Register trips, HSD Data, Urea DEF, Rates, Ledger
function books() {
  const trip = (veh, trip, load, wt, unload, uwt, extra = {}) => ({ veh, trip, month: '2026-09', loadDate: load, loadWt: wt, unloadDate: unload, unloadWt: uwt, rate: 1800, bhada: r2(wt * 1800), port: 'Portx', dest: 'PlantY', ssfcLtr: 0, ssfcAmt: 0, drvSsfc: 0, ssfcMisc: 0, fastag: 0, maint: 0, tyre: 0, lessOver: 0, rtoEntry: 0, rtoChallan: 0, shortage: 0, docExp: 0, ssfcNet: 0, row: Math.floor(Math.random() * 1e9), ...extra });
  return {
    trips: [
      trip(A, 'T001', '2026-09-03', 40, '2026-09-05', 39.9),
      trip(A, 'T002', '2026-09-12', 41.5, '2026-09-14', 41.5),
      trip(A, 'T003', '2026-09-20', 40.2, '2026-09-22', 40.1),     // not in the statement
      trip(B, 'T001', '2026-09-08', 42, '2026-09-10', 42),         // SSFC has 41.8 unloaded
    ],
    hsd: [],
    urea: [
      { date: '2026-09-04', veh: A, qty: 20, price: 65, amount: 1300, from: 'SS Freight Carrier' },
      { date: '2026-09-10', veh: B, qty: 20, price: 65, amount: 1300, from: 'SS Freight Carrier' },
      { date: '2026-09-15', veh: A, qty: 20, price: 60, amount: 1200, from: 'Some Pump' },
    ],
    rates: [{ port: 'Portx', dest: 'PlantY', rate: 1800 }, { port: 'Portz', dest: 'PlantY', rate: 1700 }],
    ssfc: { rows: [] },
  };
}

// ---- small readers ---------------------------------------------------------------------------
test('dates: serials, text, month words, and day / month swapped against the statement month', () => {
  assert.equal(dateOf('05/09/2026').iso, '2026-09-05');
  assert.equal(dateOf('5.9.26').iso, '2026-09-05');
  assert.equal(dateOf('5-Sep-2026').iso, '2026-09-05');
  assert.equal(dateOf(46270).iso, '2026-09-05');
  const s = dateOf('09/25/2026', '2026-09');           // typed month-first
  assert.deepEqual([s.iso, s.fixed], ['2026-09-25', 'swapped']);
  assert.equal(dateOf('31/31/2026'), null);
  const w = dateOf('2026-05-09', '2026-09');           // saved as 5 Sep the wrong way round
  assert.deepEqual([w.iso, w.fixed], ['2026-09-05', 'swapped']);
  const y = dateOf('05/09/2025', '2026-09');           // the wrong year
  assert.deepEqual([y.iso, y.fixed], ['2026-09-05', 'year']);
});

test('a trip\'s dates read together: month-first loading date fixed by its unloading date', () => {
  const { l, u } = tripDates('11/12/25', '15/11/2025', '2025-11');
  assert.equal(l.iso, '2025-11-12');
  assert.equal(u.iso, '2025-11-15');
  const ok = tripDates('03/09/2026', '05/09/2026', '2026-09');
  assert.deepEqual([ok.l.iso, ok.u.iso], ['2026-09-03', '2026-09-05']);
});

test('labels and DEF however they are spelt', () => {
  const cases = { 'LESS FASTAG': 'fastag', 'LESS TOLL': 'fastag', 'LESS MAINT.': 'maint', 'LESS OVER./UNLOAD.': 'lessOver', 'LESS RTO ENTRY': 'rtoEntry', 'LESS RTO CHALLAN': 'rtoChallan', 'RTO CHALAN': 'rtoChallan', 'TYRE': 'tyre', 'DOC. EXPENSES': 'docExp', 'LESS INSTALMENT': 'emi', 'NET AMOUNT': 'net', 'GPS LOST': 'gps', 'UNION': 'union', 'LD AMOUNT': 'ld', 'DRI. FOODING': 'fooding', 'LESS HYDRA': 'other' };
  for (const [l, k] of Object.entries(cases)) assert.equal(kindOf(l), k, l);
  for (const d of ['AD BLUE', 'URIA AD ABLUE TARA TRINI', 'CLEARLUE 20 LTR', 'DEF URIA LTR', 'TATA TARINI URIA', 'DEF 1 BUCKET', 'ADBLUE', 'UREA 20L']) assert.ok(defLine(d), d);
  for (const d of ['AIR CHECK', 'DEFENCE COLONY TOLL', 'CLUTCH PLATE', 'DEFLECTOR']) assert.ok(!defLine(d), d);
  assert.equal(vehOf('xx 01 ab 1001'), A);
  assert.equal(vehOf('LR101'), null);
});

// ---- the statement, whatever its layout ------------------------------------------------------
const layouts = {
  'as usual': {},
  'header on row 4': { top: 3 },
  'an extra column': { extra: true },
  'labels one column left': { labelCol: 16 },
  'dates as serials': { dates: (dd, mm) => 46266 + dd - 1 + (mm - 9) * 30 },
  'dates saved day/month swapped': { dates: (dd, mm) => `${mm}/${dd}/2026` },
};
for (const [name, opts] of Object.entries(layouts)) {
  test(`statement layout: ${name}`, () => {
    const st = readStatement(book(statementRows(opts), expenseRows()), { fileName: 'demo.xlsx' });
    assert.equal(st.error, undefined);
    assert.equal(st.month, '2026-09');
    assert.deepEqual(st.vehicles.map((v) => v.veh), [A, B]);
    const [a, b] = st.vehicles;
    assert.equal(a.trips.length, 2);
    assert.equal(b.trips.length, 1);
    assert.deepEqual(a.trips.map((t) => t.loadDate), ['2026-09-03', '2026-09-12']);
    assert.deepEqual(a.trips.map((t) => t.loadWt), [40, 41.5]);
    assert.equal(a.trips[0].unloadWt, 39.9);
    assert.equal(a.trips[0].cashOffice, 5000);
    assert.equal(a.trips[0].rate, 1800);
    assert.equal(a.trips[0].ssfcLitres, 300);
    assert.equal(a.trips[1].ssfcLitres, 410);
    assert.equal(a.trips[1].ssfcDiesel, r2(310 * 94 + 100 * 92));
    assert.deepEqual(a.deductions.map((d) => d.kind), ['fastag', 'maint', 'lessOver', 'rtoEntry']);
    assert.equal(b.deductions.find((d) => d.kind === 'other').label, 'LESS HYDRA');
    assert.equal(a.net, r2(a.subtotal - 16800));
    assert.deepEqual(statementMath(st), []);
    assert.equal(st.expenses.length, 6);
  });
}

test('the expense sheet: columns found by content, with or without a header, shifted', () => {
  for (const o of [{}, { shift: 2 }, { header: false }, { header: false, shift: 1 }]) {
    const st = readStatement(book(statementRows(), expenseRows(o)));
    const e = st.expenses;
    assert.equal(e.length, 6, JSON.stringify(o));
    assert.deepEqual(e.map((x) => x.veh), [A, A, A, B, B, B]);
    assert.deepEqual(e.map((x) => x.amount), [1300, 2000, 500, 1400, 300, 300]);
    assert.deepEqual(e.map((x) => x.def), [true, true, false, true, false, false]);
    assert.equal(e[2].kind, 'fooding');
    assert.equal(e[0].date, '2026-09-04');
    assert.equal(e[0].litres, 20);
  }
});

test('Vriddhi litres with ₹0 are not counted as charged', () => {
  const rows = statementRows();
  const st0 = readStatement(book(rows));
  // zero out the Vriddhi amount on A's second trip
  const tripRow = rows.findIndex((r) => r && r[1] === 'LR102');
  rows[tripRow][16] = 0;
  const st = readStatement(book(rows));
  assert.equal(st0.vehicles[0].trips[1].ssfcLitres, 410);
  assert.equal(st.vehicles[0].trips[1].ssfcLitres, 310);
});

test('statement arithmetic: a row total that does not add up is flagged', () => {
  const rows = statementRows();
  const tripRow = rows.findIndex((r) => r && r[1] === 'LR101');
  rows[tripRow][20] -= 1000;     // SSFC's total ₹1,000 short
  const st = readStatement(book(rows));
  const m = statementMath(st);
  assert.ok(m.some((x) => x.level === 'bad' && /LR101|3 Sep/.test(x.text)), JSON.stringify(m));
});

test('not a statement → a plain error', () => {
  const st = readStatement({ sheets: { S: { rows: [['hello'], [1, 2, 3]] } } }, { fileName: 'x.xlsx' });
  assert.match(st.error, /No vehicle-wise trip table/);
});

// ---- the checks against the books ------------------------------------------------------------
test('reconcile: unpaid trip, shortage risk, unusual deduction, RTO outlier, bills and DEF', () => {
  const st = readStatement(book(statementRows(), expenseRows()), { fileName: 'demo.xlsx' });
  const r = reconcile(st, books());
  const find = (re, level) => r.issues.find((x) => re.test(x.text) && (!level || x.level === level));
  assert.equal(r.pairs.filter((p) => p.t).length, 3);
  assert.ok(find(/T003.*isn't in this statement/, 'warn'), 'unpaid trip (next month not loaded yet)');
  assert.ok(find(/1002 T001: SSFC has 41.8 T unloaded, your register 42 T/, 'warn'));
  assert.ok(find(/“LESS HYDRA” ₹3,000/, 'warn'));
  // one of two vehicles on the higher amount: a question, not a claim
  const rto = find(/1002: RTO entry ₹12,000 — 1 vehicles were charged that, the others ₹9,000: ask SSFC why/, 'warn');
  assert.ok(rto); assert.equal(rto.amount, 3000);
  // maintenance A: SSFC deducted 3,300, bills 1,300 + 2,000 = 3,300 → fine; B: 2,000 + the HYDRA 3,000
  // against bills of 1,400 + 300 + 300 → the HYDRA has no bill
  assert.ok(!find(/1001 · maintenance.*no bill behind it/));
  assert.equal(find(/1002 · maintenance.*no bill behind it/, 'bad').amount, 3000);
  // over / unload A: 500 vs fooding 500 → fine
  assert.ok(!find(/over \/ unload.*no bill/));
  assert.ok(find(/AIR CHECK.*in the bills twice/, 'warn'));
  // DEF: A's 2,000 on 15 Sep has no refill from SSFC — and a refill bought elsewhere that day
  const d = find(/URIA AD ABLUE.*no DEF refill from SSFC/, 'bad');
  assert.ok(d); assert.equal(d.amount, 2000); assert.match(d.text, /Some Pump/);
  // B's DEF: SSFC charged 1,400 for the refill your sheet has at 1,300
  const p = find(/1002: for the DEF refills that pair up, SSFC charged ₹100 more/, 'bad');
  assert.ok(p);
  assert.equal(r.def.paired, 2);
  assert.equal(r.totals.trips, 3);
  assert.ok(r.totals.atStake >= 2000 + 100);
});

test('reconcile: a trip unpaid once next month is in is bad; paid in another month is info', () => {
  const st = readStatement(book(statementRows(), expenseRows()));
  const next = { month: '2026-10', vehicles: [{ veh: A, trips: [] }], expenses: [], ld: [] };
  const r = reconcile(st, books(), { others: [next] });
  const u = r.issues.find((x) => /T003/.test(x.text));
  assert.equal(u.level, 'bad');
  assert.equal(u.amount, r2(40.2 * 1800));
  next.vehicles[0].trips = [{ loadWt: 40.2 }];
  const r2b = reconcile(st, books(), { others: [next] });
  assert.equal(r2b.issues.find((x) => /T003/.test(x.text)).level, 'info');
});

test('reconcile: a lower rate on a route, named when it is another route\'s rate', () => {
  const rows = statementRows();
  for (const r of rows) if (r && r[19] === 1800) { r[20] -= r[4] * 100; r[19] = 1700; }
  const st = readStatement(book(rows));
  const r = reconcile(st, books());
  const g = r.issues.find((x) => x.area === 'rate');
  assert.equal(g.level, 'bad');
  assert.equal(g.amount, r2((40 + 41.5 + 42) * 100));
  assert.match(g.text, /Portz → PlantY rate/);
});

test('reconcile: the same weight a month apart does not steal another trip\'s match', () => {
  const data = books();
  data.trips.push({ ...data.trips[0], trip: 'T000', month: '2026-08', loadDate: '2026-08-03', unloadDate: '2026-08-05', row: 1 });
  const st = readStatement(book(statementRows()));
  const r = reconcile(st, data);
  const p = r.pairs.find((x) => x.s.loadDate === '2026-09-03');
  assert.equal(p.t.trip, 'T001');
});

test('reconcile: posted under other columns but the same total → one note, not a warning per column', () => {
  const data = books();
  const st = readStatement(book(statementRows(), expenseRows()));
  // A's register: everything SSFC deducted, but the over / unload ₹500 typed into maintenance
  Object.assign(data.trips[0], { fastag: 4000, maint: 3800, rtoEntry: 9000, ssfcNet: st.vehicles[0].net });
  const r = reconcile(st, data);
  const a = r.issues.filter((x) => x.area === 'register' && x.veh === A);
  assert.equal(a.length, 1);
  assert.equal(a[0].level, 'info');
});

test('reconcile: an EMI deducted is bad; LD days longer than the register\'s', () => {
  const rows = statementRows();
  const i = rows.findIndex((r) => r && r[19] === 'LESS FASTAG');
  rows[i][19] = 'LESS INSTALMENT';
  const ld = [['TRUCK NO', 'LR NO', 'INV DATE', 'UNLOADING DATE', 'DAYS', 'NET WT', 'LD AMOUNT'], [A, 'LR101', '03/09/2026', '05/09/2026', 6, 40, 12000]];
  const st = readStatement(book(rows, null, ld));
  assert.equal(st.ld.length, 1);
  const r = reconcile(st, books());
  assert.ok(r.issues.find((x) => x.level === 'bad' && /instalment \(EMI\) of ₹4,000/.test(x.text)));
  const l = r.issues.find((x) => x.area === 'ld');
  assert.equal(l.level, 'bad');
  assert.equal(l.amount, 8000);      // 6 days charged, 2 by your dates: 4 × ₹2,000
});

test('DEF: a bill paired once across months — not twice', () => {
  const st = readStatement(book(statementRows(), expenseRows()));
  const prev = { month: '2026-08', vehicles: [], ld: [], expenses: [{ veh: A, date: '2026-09-03', desc: 'AD BLUE', amount: 1300, def: true }] };
  const d = defCheck(st, books(), [prev]);
  // last month's bill took A's 4 Sep refill, so this month's AD BLUE has none left
  assert.ok(d.issues.some((x) => x.level === 'bad' && /AD BLUE 20 LTR/.test(x.text)));
});

// ---- the PDF (older months) -------------------------------------------------------------------
test('PDF text: trips by arithmetic, blank columns missing, deductions and net', () => {
  const text = `DEMO LOGISTIC JULY - 2026
${A}
SL NO LR NO VEHICLE NO DATE LOADING WT DATE UNLDNG WT SHORTAGE/EXCESS
1 LR101 ${A} 7/3/2026 40.000 7/5/2026 39.9 -0.100 03.07.26 300 94 28200 0 0 0 03.07.26 5000 1800 38800
2 77 ${A} 12/07/26 41.500 14/07/2026 41.5 0.000 0 310 94 29140 0 13.07.26 100 92 9200 12.07.26 5000 1800 31360
70160
LESS FASTAG 4000
LESS MAINT. 3300
NET AMOUNT 62860
${B}
1 LR201 ${B} 08/07/26 42.000 10/07/26 41.8 -0.200 08.07.26 305 94 28670 0 0 0 08.07.26 6000 1800 40930
40930
LESS RTO ENTRY 9000
NET AMOUNT 31930`;
  const st = statementFromText(text, { fileName: 'demo.pdf' });
  assert.equal(st.month, '2026-07');
  assert.deepEqual(st.vehicles.map((v) => v.veh), [A, B]);
  const [a, b] = st.vehicles;
  assert.deepEqual(a.trips.map((t) => t.loadDate), ['2026-07-03', '2026-07-12']);
  assert.deepEqual(a.trips.map((t) => t.unloadWt), [39.9, 41.5]);
  assert.equal(a.trips[1].lr, '77');
  assert.equal(a.trips[1].ssfcLitres, 410);
  assert.deepEqual(a.trips.map((t) => t.cashOffice), [5000, 5000]);
  assert.equal(a.net, 62860);
  assert.equal(b.net, 31930);
  assert.equal(a.subtotal, 70160);
  assert.deepEqual(statementMath(st).filter((x) => x.level === 'bad'), []);
});

test('a statement kept compact and read back checks the same', async () => {
  const { compactStatement, expandStatement } = await import('../../fleet/js/ssfcstmt.js');
  const st = readStatement(book(statementRows(), expenseRows()), { fileName: 'demo.xlsx' });
  const c = compactStatement(st);
  assert.ok(!JSON.stringify(c).includes('"cols"'));
  const back = expandStatement(c);
  const a = reconcile(st, books());
  const b = reconcile(back, books());
  assert.deepEqual(b.issues.map((x) => x.text), a.issues.map((x) => x.text));
  assert.deepEqual(b.totals, a.totals);
});

test('RTO entry: one vehicle charged more than what most pay is a claim', () => {
  const veh = (n, amt) => ({ veh: `XX01AB10${n}`, trips: [], subtotal: null, net: null, deductions: [{ label: 'LESS RTO ENTRY', kind: 'rtoEntry', amount: amt }] });
  const st = { month: '2026-09', vehicles: [veh(11, 9000), veh(12, 9000), veh(13, 9000), veh(14, 9000), veh(15, 13500)], expenses: [], ld: [] };
  const r = reconcile(st, { trips: [], hsd: [], urea: [], rates: [], ssfc: { rows: [] } });
  const x = r.issues.filter((i) => /RTO entry ₹13,500/.test(i.text) && i.level === 'bad');
  assert.equal(x.length, 1);
  assert.equal(x[0].amount, 4500);
  assert.match(x[0].text, /the other vehicles pay ₹9,000/);
});

test('diesel trip by trip: paired by weight, ₹ incl. cash diesel, a fill on the next trip, register P / Q', () => {
  const st = readStatement(book(statementRows(), expenseRows()));
  const data = books();
  // HSD Data: SSFC's fills tagged to each trip
  const fill = (veh, trip, date, qty, rsp) => ({ date, veh, trip, qty, rsp, amount: r2(qty * rsp), source: 'SSFC', location: 'Pumpx' });
  data.hsd = [
    fill(A, 'T001', '2026-09-03', 300, 94),                                   // = SSFC's 300 L
    fill(A, 'T001', '2026-09-13', 100, 92),                                   // SSFC charged it on T002 (Vriddhi column)
    fill(A, 'T002', '2026-09-12', 310, 94),
    fill(B, 'T001', '2026-09-08', 300, 94),                                   // SSFC charged 305 L
  ];
  data.trips[0].trip = 'T001'; data.trips[1].trip = 'T002'; data.trips[3].trip = 'T001';
  // register P / Q: A's T002 typed wrong, the rest as SSFC
  Object.assign(data.trips[0], { ssfcLtr: 300, ssfcAmt: 28200 });
  Object.assign(data.trips[1], { ssfcLtr: 310, ssfcAmt: 29140 });
  Object.assign(data.trips[3], { ssfcLtr: 305, ssfcAmt: 28670 });
  const r = reconcile(st, data);
  const dt = r.dieselTrips;
  assert.equal(dt.length, 3);
  const a1 = dt.find((x) => x.veh === A && x.trip === 'T001');
  const a2 = dt.find((x) => x.veh === A && x.trip === 'T002');
  const b1 = dt.find((x) => x.veh === B);
  assert.deepEqual([a1.status, a2.status], ['moved', 'moved']);
  const moved = r.issues.find((x) => /retag the fill to T002/.test(x.text));
  assert.ok(moved); assert.match(moved.text, /100 L of diesel \(₹9,200\) is on T002 in SSFC's statement but on T001 in your HSD Data/);
  assert.equal(b1.status, 'more');
  const more = r.issues.find((x) => x.area === 'diesel' && x.veh === B);
  assert.equal(more.level, 'bad'); assert.equal(more.amount, 470);
  assert.match(more.text, /T001 \(loaded 8 Sep, 42 T\): SSFC charged 305 L \(₹28,670\); your HSD Data has 300 L \(₹28,200\)/);
});

test('diesel trip by trip: pump cash is diesel bought for cash — compared in ₹', () => {
  const rows = statementRows();
  const i = rows.findIndex((x) => x && x[1] === 'LR201');
  rows[i][12] = 3150; rows[i][20] -= 3150;                // ₹3,150 cash diesel at the pump
  const st = readStatement(book(rows, expenseRows()));
  const data = books();
  data.trips[3].trip = 'T001';
  Object.assign(data.trips[3], { ssfcLtr: 305, ssfcAmt: 31820 });            // P / Q: the litres SSFC lists, ₹ with the cash
  data.hsd = [
    { date: '2026-09-08', veh: B, trip: 'T001', qty: 305, rsp: 94, amount: 28670, source: 'SSFC' },
    { date: '2026-09-09', veh: B, trip: 'T001', qty: 30, rsp: 105, amount: 3150, source: 'SSFC' },     // the cash fill
  ];
  const r = reconcile(st, data);
  const b1 = r.dieselTrips.find((x) => x.veh === B);
  assert.equal(b1.cash, 3150);
  assert.equal(b1.status, 'ok');
  assert.ok(!r.issues.some((x) => x.area === 'diesel' && x.veh === B));
  // P / Q left out: correct the register
  data.trips[3].ssfcAmt = 28670;
  const r2b = reconcile(st, data);
  assert.equal(r2b.dieselTrips.find((x) => x.veh === B).status, 'register');
  assert.match(r2b.issues.find((x) => x.area === 'register' && /correct P \/ Q/.test(x.text)).text, /305 L \+ ₹3,150 cash diesel \(₹31,820\) and your HSD Data agrees/);
});
