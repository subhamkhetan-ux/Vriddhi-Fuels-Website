// Decanting rules: dip chart, chambers, planning, checks, results.
// Run: node --test tests/decant_web
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS, DEFAULT_TANKS, chamberLayout, chartFromRows, chartIssues, checkPlan, dipAtLitres, invoiceStatus,
  istDate, litresAtDip, productKey, settingsWith, solvePlan, suggestPlan, tankResult, usedChambers,
} from '../../decant/js/core.js';
import { DIP_CHART } from '../../decant/js/dipchart.js';

// The two real invoices (26-Sep-26): a full HSD load, and MS in C1 + HSD in C2-5.
const CHAMBERS = [
  { no: 1, pl_cm: 184.9, dip_cm: 140, qty_kl: 5 }, { no: 2, pl_cm: 185.2, dip_cm: 145.3, qty_kl: 5 },
  { no: 3, pl_cm: 186.9, dip_cm: 144.9, qty_kl: 4 }, { no: 4, pl_cm: 184.6, dip_cm: 149, qty_kl: 4 },
  { no: 5, pl_cm: 184.8, dip_cm: 136.6, qty_kl: 4 },
];
export const INV_HSD = {
  invoice_no: '7011263776', invoice_date: '26/09/2026', invoice_time: '09:34', tt_no: 'OD23U8210',
  lines: [{ product: 'HSD-BSVI [PDRP]', column_key: 'HSD', qty_kl: 22, compartments: [], density15: 831, value: 2159219 }],
  chambers: CHAMBERS,
};
export const INV_MIX = {
  invoice_no: '7011294526', invoice_date: '26/09/2026', invoice_time: '14:15', tt_no: 'OD23U8210',
  lines: [
    { product: 'EBMS [PDRP]', column_key: 'MS | EBMS', qty_kl: 5, compartments: [1], density15: 748.2, value: 524764 },
    { product: 'HSD-BSVI [PDRP]', column_key: 'HSD', qty_kl: 17, compartments: [2, 3, 4, 5], density15: 829.3, value: 1668487 },
  ],
  chambers: CHAMBERS,
};
// Stock at 12:14 on 26-Sep (screenshot 1).
export const READINGS = {
  T1: { volume: 3898.77, ullage: 16101.23, capacity: 20000, water: 0, readingAt: '2026-09-26T12:14:20+05:30' },
  T2: { volume: 14973.71, ullage: 5026.29, capacity: 20000, water: 0, readingAt: '2026-09-26T12:14:19+05:30' },
  T3: { volume: 9989.83, ullage: 10010.17, capacity: 20000, water: 0, readingAt: '2026-09-26T12:14:21+05:30' },
  T4: { volume: 2559.46, ullage: 17440.54, capacity: 20000, water: 0, readingAt: '2026-09-26T12:14:23+05:30' },
};
const NOW = Date.parse('2026-09-26T12:20:00+05:30');

test('product names from invoices and the automation', () => {
  assert.equal(productKey('EBMS [PDRP]'), 'MS');
  assert.equal(productKey('MS | EBMS'), 'MS');
  assert.equal(productKey('MS-BSVI [PDRP]'), 'MS');
  assert.equal(productKey('Motor Spirit'), 'MS');
  assert.equal(productKey('HSD-BSVI [PDRP]'), 'HSD');
  assert.equal(productKey('High Speed Diesel'), 'HSD');
  assert.equal(productKey('XtraGreen HSD'), 'XG');
  assert.equal(productKey('XtraGrean'), 'XG');
  assert.equal(productKey('LSHFHSD'), 'LSHF');
  assert.equal(productKey('SMS'), null);
  assert.equal(productKey(''), null);
});

test('dip chart: litres at a dip and back', () => {
  // the automation's own readings: height (mm) / 10 -> its volume, within a litre
  for (const [mm, litres] of [[495.77, 3898.77], [1372.25, 14973.71], [987.09, 9989.83], [369.33, 2559.46],
    [1141.99, 12019.45], [1572.82, 17376.58], [454.58, 3446.8], [516.97, 4136.61]]) {
    assert.ok(Math.abs(litresAtDip(DIP_CHART, mm / 10) - litres) < 1, `${mm} mm`);
    assert.ok(Math.abs(dipAtLitres(DIP_CHART, litres) - mm / 10) < 0.01, `${litres} L`);
  }
  assert.equal(litresAtDip(DIP_CHART, 1), 11.97);
  assert.equal(litresAtDip(DIP_CHART, 0.5), 5.99);          // straight down to 0 below the first mark
  assert.equal(litresAtDip(DIP_CHART, 209), 21623.34);
  assert.equal(litresAtDip(DIP_CHART, 209.1), null);         // above the chart
  assert.equal(litresAtDip(DIP_CHART, -1), null);
  assert.equal(dipAtLitres(DIP_CHART, 30000), null);
  assert.equal(litresAtDip(DIP_CHART, 143.5), 15748.49);     // the repaired 143.2-143.9 run
  assert.ok(litresAtDip(DIP_CHART, 143.9) < litresAtDip(DIP_CHART, 144));
  // what's left in the sheet: three sub-litre dips
  assert.deepEqual(chartIssues(DIP_CHART).map((i) => i.cm), [118.1, 207, 208]);
});

test('dip chart upload', () => {
  const chart = chartFromRows([['DIP Value', 'VOLUME (in Ltr)'], ...Array.from({ length: 20 }, (_, i) => [1 + i * 0.1, 10 + i])]);
  assert.equal(chart.startCm, 1);
  assert.equal(chart.stepCm, 0.1);
  assert.equal(chart.litres.length, 20);
  assert.equal(litresAtDip(chart, 1.25), 12.5);
  assert.throws(() => chartFromRows([[1, 2], [2, 3]]), /too few rows/);
  assert.throws(() => chartFromRows([...Array.from({ length: 12 }, (_, i) => [i, i]), [20, 20]]), /evenly spaced/);
});

test('settings fill in defaults and tidy tank rows', () => {
  const s = settingsWith({ tolerancePct: 0.5, tanks: [{ id: 'T1', no: 1, product: 'XX', capacity: 'x' }] });
  assert.equal(s.tolerancePct, 0.5);
  assert.equal(s.warnRoomL, DEFAULT_SETTINGS.warnRoomL);
  assert.deepEqual(s.tanks, [{ id: 'T1', no: 1, product: 'HSD', capacity: 20000 }]);
  assert.deepEqual(settingsWith(null).tanks, DEFAULT_TANKS);
});

test('chambers: the invoice\'s "Comp No(s)" decide', () => {
  const lay = chamberLayout(INV_MIX);
  assert.deepEqual(lay.chambers.map((c) => [c.no, c.litres, c.product, c.how]), [
    [1, 5000, 'MS', 'invoice'], [2, 5000, 'HSD', 'invoice'], [3, 4000, 'HSD', 'invoice'],
    [4, 4000, 'HSD', 'invoice'], [5, 4000, 'HSD', 'invoice']]);
  assert.deepEqual(lay.problems, []);
  assert.deepEqual(lay.lines.map((l) => l.chambers), [[1], [2, 3, 4, 5]]);
  assert.ok(Math.abs(lay.lines[1].pricePerL - 98.15) < 0.01);
});

test('chambers: one product fills them all', () => {
  const lay = chamberLayout(INV_HSD);
  assert.ok(lay.chambers.every((c) => c.product === 'HSD'));
  assert.deepEqual(lay.problems, []);
});

test('chambers: MS fills from chamber 1 upward when the invoice doesn\'t say', () => {
  const inv = {
    lines: [{ column_key: 'HSD', qty_kl: 12 }, { column_key: 'MS | EBMS', qty_kl: 10 }],
    chambers: CHAMBERS,
  };
  const lay = chamberLayout(inv);
  assert.deepEqual(lay.chambers.map((c) => c.product), ['MS', 'MS', 'HSD', 'HSD', 'HSD']);
  assert.equal(lay.chambers[0].how, 'ms-rule');
  assert.deepEqual(lay.problems, []);
  // 9 KL of MS can't come out of whole chambers from C1 (5 + 5 = 10)
  const odd = chamberLayout({ lines: [{ column_key: 'MS', qty_kl: 9 }, { column_key: 'HSD', qty_kl: 13 }], chambers: CHAMBERS });
  assert.equal(odd.problems.length, 2);
  assert.match(odd.problems[0], /9 KL of MS but its chambers hold 10 KL/);
});

test('chambers: a part load leaves the last chambers empty; no table uses the truck\'s saved one', () => {
  const part = chamberLayout({ lines: [{ column_key: 'HSD', qty_kl: 18 }], chambers: CHAMBERS });
  assert.deepEqual(part.chambers.map((c) => c.product), ['HSD', 'HSD', 'HSD', 'HSD', null]);
  const saved = chamberLayout({ lines: [{ column_key: 'HSD', qty_kl: 22 }], chambers: [] }, { chambers: CHAMBERS });
  assert.equal(saved.chambers.length, 5);
  const none = chamberLayout({ lines: [{ column_key: 'HSD', qty_kl: 22 }], chambers: [] });
  assert.match(none.problems.at(-1), /No chamber details/);
  const bad = chamberLayout({ lines: [{ column_key: 'HSD', qty_kl: 4, compartments: [7] }], chambers: CHAMBERS });
  assert.match(bad.problems[0], /no chamber 7/);
});

test('plan: fits the most without leaving a tank brim-full', () => {
  // HSD C2 5 KL + C3-C5 4 KL into Tank 2 (5,026 L room) and Tank 3 (10,010 L room)
  const chambers = [{ no: 2, litres: 5000 }, { no: 3, litres: 4000 }, { no: 4, litres: 4000 }, { no: 5, litres: 4000 }];
  const tanks = [{ id: 'T2', room: 5026.29 }, { id: 'T3', room: 10010.17 }];
  const r = solvePlan({ chambers, tanks });
  assert.equal(r.total, 13000);
  assert.deepEqual(r.assign, { 2: 'T3', 3: 'T3', 4: 'T2', 5: null });
  // what the user asked for: 5 KL in Tank 2, 8 KL in Tank 3
  const asked = solvePlan({ chambers, tanks, requests: { T2: 5000, T3: 8000 } });
  assert.deepEqual(asked.assign, { 2: 'T2', 3: 'T3', 4: 'T3', 5: null });
  // never over the room, even when asked
  const greedy = solvePlan({ chambers, tanks, requests: { T2: 9000, T3: 0 } });
  assert.ok(greedy.perTank.T2 <= 5026.29);
  // the tank typed last wins a tie: 5 KL typed for Tank 2 while Tank 3 still says 9
  const typed = solvePlan({ chambers, tanks, requests: { T2: 5000, T3: 9000 }, prefer: 'T2' });
  assert.deepEqual(typed.perTank, { T2: 5000, T3: 8000 });
  assert.deepEqual(solvePlan({ chambers, tanks, requests: { T2: 5000, T3: 9000 }, prefer: 'T3' }).perTank, { T2: 4000, T3: 9000 });
});

test('plan: the roomiest tank takes the first chambers (the 26-Sep 09:34 load)', () => {
  // HSD 5+5+4+4+4 into Tank 2 (16,553 L room) and Tank 3 (15,863 L room) —
  // as it was decanted that morning: C1-C3 into Tank 2, C4-C5 into Tank 3.
  const chambers = [5000, 5000, 4000, 4000, 4000].map((litres, i) => ({ no: i + 1, litres }));
  const r = solvePlan({ chambers, tanks: [{ id: 'T2', room: 16553.2 }, { id: 'T3', room: 15863.39 }] });
  assert.deepEqual(r.assign, { 1: 'T2', 2: 'T2', 3: 'T2', 4: 'T3', 5: 'T3' });
  assert.equal(r.total, 22000);
});

test('plan: a brim-full fill only when nothing else fits; MS from chamber 1', () => {
  assert.deepEqual(solvePlan({ chambers: [{ no: 1, litres: 5000 }], tanks: [{ id: 'T1', room: 5050 }] }).assign, { 1: 'T1' });
  assert.deepEqual(solvePlan({ chambers: [{ no: 1, litres: 4000 }], tanks: [{ id: 'T1', room: 3000 }] }).assign, { 1: null });
  const ms = solvePlan({ chambers: [{ no: 1, litres: 5000 }, { no: 2, litres: 5000 }], tanks: [{ id: 'T1', room: 6000 }] });
  assert.deepEqual(ms.assign, { 1: 'T1', 2: null });
});

test('plan for a whole invoice, and its checks', () => {
  const layout = chamberLayout(INV_MIX);
  const plan = suggestPlan({ layout, tanks: DEFAULT_TANKS, readings: READINGS });
  assert.deepEqual(plan.map((p) => [p.no, p.product, p.tank]), [
    [1, 'MS', 'T1'], [2, 'HSD', 'T3'], [3, 'HSD', 'T3'], [4, 'HSD', 'T2'], [5, 'HSD', null]]);
  const chk = checkPlan({ plan, tanks: DEFAULT_TANKS, readings: READINGS, now: NOW, chart: DIP_CHART });
  assert.deepEqual(chk.blocking, []);
  assert.deepEqual(chk.warnings, []);
  const t3 = chk.perTank.find((r) => r.tank === 'T3');
  assert.equal(t3.litres, 9000);
  assert.equal(t3.after, 18989.83);
  assert.equal(t3.leftRoom, 1010.17);
  assert.ok(Math.abs(t3.beforeDip - 98.709) < 0.01);
  assert.ok(t3.afterDip > t3.beforeDip);
  // chambers already emptied are left out of the next plan
  const rest = suggestPlan({ layout, tanks: DEFAULT_TANKS, readings: READINGS, exclude: new Set([1, 2, 3, 4]) });
  assert.deepEqual(rest.map((p) => p.no), [5]);
});

test('checks stop the wrong product, too much, no stock and a busy tank', () => {
  const plan = [
    { no: 1, product: 'MS', litres: 5000, tank: 'T2' },
    { no: 2, product: 'HSD', litres: 5000, tank: 'T2' },
    { no: 3, product: 'HSD', litres: 4000, tank: 'T2' },
    { no: 4, product: 'XG', litres: 4000, tank: 'T4' },
  ];
  const readings = { ...READINGS, T4: undefined };
  const chk = checkPlan({ plan, tanks: DEFAULT_TANKS, readings, busy: new Set(['T2']), now: NOW });
  assert.equal(chk.blocking.length, 4);
  assert.match(chk.blocking[0], /Chamber 1 holds MS — it can't go into Tank 2/);
  assert.ok(chk.blocking.some((b) => /Tank 2 is already being decanted/.test(b)));
  assert.ok(chk.blocking.some((b) => /Tank 2 has room for 5,026 L; 14,000 L is planned/.test(b)));
  assert.ok(chk.blocking.some((b) => /Add Tank 4's stock/.test(b)));
  const none = checkPlan({ plan: [{ no: 1, product: 'MS', litres: 5000, tank: null }], tanks: DEFAULT_TANKS, readings: READINGS });
  assert.match(none.blocking[0], /Pick at least one chamber/);
});

test('checks warn about a tight fit, water, an old reading and an offline probe', () => {
  const readings = { T2: { ...READINGS.T2, water: 12.5, status: 'OFFLINE', readingAt: '2026-09-26T09:00:00+05:30' } };
  const chk = checkPlan({ plan: [{ no: 1, product: 'HSD', litres: 5000, tank: 'T2' }], tanks: DEFAULT_TANKS, readings, now: NOW });
  assert.deepEqual(chk.blocking, []);
  assert.equal(chk.perTank[0].level, 'tight');
  assert.equal(chk.warnings.length, 4);
  assert.match(chk.warnings[0], /nearly full \(26 L room left\)/);
  assert.match(chk.warnings[1], /13 L of water/);
  assert.match(chk.warnings[2], /OFFLINE/);
  assert.match(chk.warnings[3], /3 h old/);
});

test('variation: what the tank gained against what was decanted', () => {
  const r = tankResult({ litres: 5000, before: { volume: 3898.77 }, after: { volume: 8889.12 } });
  assert.deepEqual(r, { gain: 4990.35, expected: 5000, variation: -9.65, pct: -0.193, tol: 25, band: 'ok', direction: 'short' });
  const sold = tankResult({ litres: 5000, before: { volume: 3898.77 }, after: { volume: 8889.12 }, salesL: 20 });
  assert.equal(sold.variation, 10.35);
  assert.equal(sold.direction, 'excess');
  const big = tankResult({ litres: 17000, before: { volume: 1000 }, after: { volume: 17900 } });
  assert.equal(big.variation, -100);
  assert.equal(big.tol, 42.5);
  assert.equal(big.band, 'high');
  assert.equal(tankResult({ litres: 17000, before: { volume: 1000 }, after: { volume: 17940 } }).band, 'watch');
  assert.equal(tankResult({ litres: 5000, before: { volume: 1 }, after: null }), null);
});

test('invoice status follows its decantations', () => {
  const layout = chamberLayout(INV_MIX);
  const inv = { invoice_no: INV_MIX.invoice_no };
  const s = (status, tanks) => ({ id: status + tanks, invoice_no: inv.invoice_no, status, data: { plan: tanks.map(([no, tank]) => ({ no, tank })) } });
  assert.equal(invoiceStatus(inv, [], layout), 'new');
  assert.equal(invoiceStatus(inv, [s('decanting', [[1, 'T1']])], layout), 'active');
  assert.equal(invoiceStatus(inv, [s('done', [[1, 'T1'], [2, 'T3']])], layout), 'partial');
  assert.equal(invoiceStatus(inv, [s('done', [[1, 'T1'], [2, 'T3'], [3, 'T3'], [4, 'T2']]), s('done', [[5, 'T2']])], layout), 'done');
  assert.equal(invoiceStatus(inv, [s('cancelled', [[1, 'T1']])], layout), 'new');
  assert.equal(invoiceStatus({ ...inv, dismissed: true }, [], layout), 'dismissed');
  assert.deepEqual([...usedChambers([s('done', [[1, 'T1'], [2, null]])], inv.invoice_no)], [1]);
});

test('IST dates', () => {
  assert.equal(istDate('2026-09-26T20:00:00Z'), '2026-09-27');
  assert.equal(istDate(Date.parse('2026-09-26T18:29:00Z')), '2026-09-26');
});

test('density at 15 °C from a hydrometer reading (Table 53B)', async () => {
  const { density15From, densityCheck } = await import('../../decant/js/core.js');
  assert.equal(density15From(829.3, 15), 829.3);                       // at 15 °C nothing to correct
  assert.equal(density15From(820, 30), 830.5);                          // diesel read warm
  assert.equal(density15From(737, 32), 752.1);                          // petrol
  // the automation's own figures: 810.0 at 29.5 °C is shown as 820.3 (tc)
  assert.ok(Math.abs(density15From(810, 29.5) - 820.3) < 0.5);
  assert.equal(density15From(50, 30), null);
  assert.deepEqual(densityCheck({ reading: 820, tempC: 30, invoice15: 829.3 }), { d15: 830.5, diff: 1.2, ok: true });
  assert.deepEqual(densityCheck({ reading: 812, tempC: 30, invoice15: 829.3 }), { d15: 822.6, diff: -6.7, ok: false });
  assert.equal(densityCheck({ reading: 820, tempC: 30, invoice15: null }), null);
});

test('after decanting: chambers that went into the other tank are spotted', async () => {
  const { guessRouting, routingHint } = await import('../../decant/js/core.js');
  // Planned C1,C2 -> Tank 3 and C3-C5 -> Tank 2, but the stock says Tank 2
  // gained 13,929.78 L and Tank 3 7,882.84 L (the real 26-Sep screenshots).
  const byNo = { 1: 5000, 2: 5000, 3: 4000, 4: 4000, 5: 4000 };
  const rows = [
    { tank: 'T2', chambers: [3, 4, 5], litres: 12000, before: { volume: 3446.8 }, after: { volume: 17376.58 } },
    { tank: 'T3', chambers: [1, 2], litres: 10000, before: { volume: 4136.61 }, after: { volume: 12019.45 } },
  ];
  const h = routingHint(rows, byNo);
  assert.deepEqual(h.assign, { 1: 'T2', 2: 'T2', 3: 'T2', 4: 'T3', 5: 'T3' });
  assert.deepEqual(h.perTank, { T2: 14000, T3: 8000 });
  assert.equal(h.missNow, 4046.94);
  assert.equal(h.missThen, 187.38);
  // as planned (the right chambers): nothing to say
  const right = [
    { ...rows[0], chambers: [1, 2, 3], litres: 14000 },
    { ...rows[1], chambers: [4, 5], litres: 8000 },
  ];
  assert.equal(routingHint(right, byNo), null);
  assert.equal(routingHint(rows.slice(0, 1), byNo), null);
  assert.deepEqual(guessRouting([{ no: 1, litres: 4000 }], [{ id: 'T2', gain: 3990 }]).assign, { 1: 'T2' });
});

const OWN = (id, chambers, extra = {}) => ({ id, kind: 'own', tt_no: 'OD23U8210', chambers, created_at: '2026-09-27T04:30:00Z', ...extra });
const TRANSPORT = (id, qty, extra = {}) => ({ id, kind: 'transport', qty, created_at: '2026-09-27T04:30:00Z', ...extra });

test('plan: the least to dispense so every indent fits (own TTs)', async () => {
  const { planIndents } = await import('../../decant/js/core.js');
  // stock after the 26-Sep afternoon decanting
  const stock = {
    T1: { volume: 8886.77, ullage: 11113.23 }, T2: { volume: 18965.71, ullage: 1034.29 },
    T3: { volume: 18962.36, ullage: 1037.64 }, T4: { volume: 2559.46, ullage: 17440.54 },
  };
  const indents = [
    OWN('a', [{ no: 5, litres: 4000, product: 'HSD' }]),
    OWN('b', [{ no: 1, litres: 5000, product: 'MS' }, ...[2, 3, 4, 5].map((no) => ({ no, litres: no === 2 ? 5000 : 4000, product: 'HSD' }))]),
  ];
  const r = planIndents({ indents, tanks: DEFAULT_TANKS, stock, margin: 150 });
  // all the HSD chambers split together: 9 KL to Tank 2, 12 KL to Tank 3 —
  // the least dispensing in total (21 KL less the room), and the most even
  assert.equal(r.ways.length, 1);
  assert.deepEqual(r.ways[0][0].split, { 5: 'T2' });
  assert.deepEqual(r.ways[0][1].split, { 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T3', 5: 'T3' });
  assert.deepEqual(r.products.HSD, { incoming: 21000, sell: 19228.07 });
  assert.deepEqual(r.products.MS, { incoming: 5000, sell: 0 });
  assert.equal(r.tanks.T2.sell, 8115.71);
  assert.equal(r.tanks.T3.sell, 11112.36);
  assert.deepEqual(r.tanks.T3.after, [19850, 19850]);                                   // full, less the 150 L margin
  assert.equal(r.tanks.T1.spare, 6113.23);
  assert.equal(r.tanks.T4.sell, 0);
  assert.deepEqual(r.missing, []);
  // whole chambers only: 21 KL into two tanks of 10,850 L room each splits 9 + 12 KL
  const tight = { ...stock, T2: { volume: 9000, ullage: 11000 }, T3: { volume: 9000, ullage: 11000 } };
  assert.equal(planIndents({ indents, tanks: DEFAULT_TANKS, stock: tight }).products.HSD.sell, 1150);
  const roomy = { ...stock, T2: { volume: 7000, ullage: 13000 }, T3: { volume: 7000, ullage: 13000 } };
  assert.equal(planIndents({ indents, tanks: DEFAULT_TANKS, stock: roomy }).products.HSD.sell, 0);
  // no stock for a tank: said so, and its product can't be planned
  const partial = planIndents({ indents, tanks: DEFAULT_TANKS, stock: { T1: stock.T1 }, margin: 150 });
  assert.deepEqual(partial.missing, ['T2', 'T3', 'T4']);
  assert.deepEqual(partial.ways[0][1].noTank, [2, 3, 4, 5]);
});

test('plan: a transport TT fits whichever standard layout comes', async () => {
  const { planIndents, transportOptions } = await import('../../decant/js/core.js');
  const stock = { T1: { volume: 12000, ullage: 8000 }, T2: { volume: 14973.71, ullage: 5026.29 }, T3: { volume: 15850, ullage: 4150 }, T4: { volume: 9000, ullage: 11000 } };
  const r = planIndents({ indents: [TRANSPORT('t', { HSD: 22 })], tanks: DEFAULT_TANKS, stock });
  // 22 KL comes as 4.5×4 + 4 or as 5+5+4+4+4: 13,123.71 L to dispense covers both —
  // no more than the room shortfall itself (22,000 − 8,876.29), split 8,123.71 / 5,000
  assert.equal(r.ways.length, 2);
  assert.deepEqual(r.ways.map((w) => w[0].caps), transportOptions(22).layouts);
  assert.deepEqual(r.products.HSD, { incoming: 22000, sell: 13123.71 });
  assert.equal(r.tanks.T2.sell, 8123.71);
  assert.equal(r.tanks.T3.sell, 5000);
  for (const [w] of r.ways) {                                       // each layout really fits
    const into = { T2: 0, T3: 0 };
    w.caps.forEach((kl, i) => { into[w.split[i + 1]] += kl * 1000; });
    assert.ok(into.T2 <= 5026.29 - 150 + 8123.71 + 0.01 && into.T3 <= 4150 - 150 + 5000 + 0.01, JSON.stringify(into));
  }
  assert.ok(r.tanks.T3.spare >= 150 && r.tanks.T2.spare >= 150);
  // together with our own TT's next load: 2 ways × 1
  const both = planIndents({ indents: [OWN('o', [5, 5, 4, 4, 4].map((kl, i) => ({ no: i + 1, litres: kl * 1000, product: 'HSD' }))), TRANSPORT('t', { HSD: 22 })], tanks: DEFAULT_TANKS, stock });
  assert.equal(both.ways.length, 2);
  assert.deepEqual(both.products.HSD, { incoming: 44000, sell: 35123.71 });
  // MS and HSD on a transport TT: planned for the most each can bring in whole chambers
  const mixed = planIndents({ indents: [TRANSPORT('m', { MS: 5, HSD: 17 })], tanks: DEFAULT_TANKS, stock });
  assert.deepEqual(mixed.ways.map((w) => w[0].left), [0, 0]);
  assert.equal(mixed.products.MS.incoming, 5000);
  assert.equal(mixed.products.HSD.incoming, 17500);                 // 4.5×4 + 4: HSD gets C2–5
  assert.deepEqual(mixed.tanks.T1.incoming, [4500, 5000]);
  // a size with no standard layout: said so, nothing assumed
  const odd = planIndents({ indents: [TRANSPORT('x', { HSD: 30 })], tanks: DEFAULT_TANKS, stock });
  assert.equal(odd.ways[0][0].unknown, true);
  assert.equal(odd.products.HSD, undefined);
});

test('transport TT layouts, chamber loading, settings', async () => {
  const { layoutsText, loadChambers, normTT, ownTT, parseLayouts, settingsWith, transportOptions } = await import('../../decant/js/core.js');
  assert.deepEqual(transportOptions(22).layouts, [[4.5, 4.5, 4.5, 4.5, 4], [5, 5, 4, 4, 4]]);
  assert.equal(transportOptions(21).size, 22);                       // the smallest size that holds it
  assert.equal(transportOptions(20).layouts.length, 2);
  assert.equal(transportOptions(26).size, null);
  assert.equal(transportOptions(12).size, null);                     // no transport TT under 20 KL
  assert.deepEqual(loadChambers([4.5, 4.5, 4.5, 4.5, 4], { MS: 4.5, HSD: 17.5 }).chambers.map((c) => `${c.product}${c.litres}`),
    ['MS4500', 'HSD4500', 'HSD4500', 'HSD4500', 'HSD4000']);
  // whole chambers, each product the run closest to its KL: the same indent in a
  // 5+5+4+4+4 TT comes as MS 5 + HSD 17, and MS 5 + HSD 17 as 4.5×4 + 4 is MS 4.5 + HSD 17.5
  const of = (caps, qty) => { const r = loadChambers(caps, qty); return [r.chambers.map((c) => `${c.product}${c.litres}`).join(' '), r.left]; };
  assert.deepEqual(of([5, 5, 4, 4, 4], { MS: 4.5, HSD: 17.5 }), ['MS5000 HSD5000 HSD4000 HSD4000 HSD4000', 0]);
  assert.deepEqual(of([4.5, 4.5, 4.5, 4.5, 4], { MS: 5, HSD: 17 }), ['MS4500 HSD4500 HSD4500 HSD4500 HSD4000', 0]);
  assert.deepEqual(of([5, 5, 4, 4, 4], { MS: 9, HSD: 13 }), ['MS5000 MS5000 HSD4000 HSD4000 HSD4000', 0]);
  assert.deepEqual(of([5, 5], { MS: 5, HSD: 5, XG: 5 }), ['MS5000 HSD5000', 5000]);               // more than it holds
  assert.deepEqual(of([5, 5, 4, 4, 4], { HSD: 21 }), ['HSD5000 HSD5000 HSD4000 HSD4000 HSD4000', 0]);   // 22 is closer than 18
  assert.deepEqual(of([5, 4, 4, 4, 4], { MS: 7, HSD: 12 }), ['MS5000 MS4000 HSD4000 HSD4000 HSD4000', 0]);  // a tie takes the chamber
  assert.deepEqual(of([5, 5, 5, 5], { XG: 5, MS: 5 }), ['MS5000 XG5000', 0]);
  const text = '20: 5+5+5+5 | 4+4+4+4+4\n22: 4.5+4.5+4.5+4.5+4 | 5+5+4+4+4\n23: 5+5+5+4+4\n24: 5+5+5+5+4\n25: 5+5+5+5+5';
  assert.equal(layoutsText(DEFAULT_SETTINGS.transportTTs), text);
  assert.deepEqual(parseLayouts(text), DEFAULT_SETTINGS.transportTTs);
  assert.deepEqual(parseLayouts('18 kl: 6, 6, 6\nnonsense'), { 18: [[6, 6, 6]] });
  assert.equal(normTT('od 23 u-8210'), 'OD23U8210');
  assert.deepEqual(ownTT('od23u8210')?.chambers, [5, 5, 4, 4, 4]);
  assert.equal(ownTT('OD02X9999'), null);
  const s = settingsWith({ ownTTs: [{ tt: 'or 15 r 9360', chambers: ['4', 4, 4, 'x'] }, { tt: '', chambers: [5] }], transportTTs: 'bad' });
  assert.deepEqual(s.ownTTs, [{ tt: 'OR15R9360', chambers: [4, 4, 4] }]);
  assert.deepEqual(s.transportTTs, DEFAULT_SETTINGS.transportTTs);
});

test('indents come off the plan as their invoices arrive', async () => {
  const { matchIndents } = await import('../../decant/js/core.js');
  const inv = (no, tt, date, time, arrived, kl, extra = {}) => ({ invoice_no: no, tt_no: tt, invoice_date: date, invoice_time: time,
    created_at: arrived, lines: [{ column_key: 'HSD', qty_kl: kl }], ...extra });
  const indents = [
    OWN('own1', [{ no: 1, litres: 22000, product: 'HSD' }], { created_at: '2026-09-27T04:30:00Z' }),   // 10:00 IST
    TRANSPORT('tr1', { HSD: 22 }, { created_at: '2026-09-27T04:30:00Z' }),
    TRANSPORT('tr2', { HSD: 17 }, { created_at: '2026-09-27T05:00:00Z' }),
  ];
  const invoices = [
    inv('prev', 'OD23U8210', '27/09/2026', '09:30', '2026-09-27T04:35:00Z', 22),          // our TT's previous trip, arrived just after
    inv('next', 'OD23U8210', '27/09/2026', '12:10', '2026-09-27T06:50:00Z', 22),          // its next trip
    inv('t17', 'OD15AB1234', '27/09/2026', '11:00', '2026-09-27T05:40:00Z', 17),
    inv('t22', 'OD02X9999', '27/09/2026', '11:30', '2026-09-27T06:10:00Z', 22),
    inv('old', 'OD11Z1111', '20/09/2026', '08:00', '2026-09-27T05:00:00Z', 22),           // back-filled: made long before
    inv('nope', 'OD11Z2222', '27/09/2026', '10:30', '2026-09-27T05:10:00Z', 22, { dismissed: true, dismiss_reason: 'not_ours' }),
  ];
  const m = matchIndents(indents, invoices, ['OD23U8210']);
  assert.equal(m.get('own1').invoice_no, 'next');
  assert.equal(m.get('tr1').invoice_no, 't22');                      // the closest quantity
  assert.equal(m.get('tr2').invoice_no, 't17');
  // "not this one": skipped
  assert.equal(matchIndents([{ ...indents[0], ignore: ['next'] }], invoices, ['OD23U8210']).size, 0);
  // an invoice from before the indent was added never matches
  assert.equal(matchIndents([OWN('late', [], { created_at: '2026-09-27T07:00:00Z' })], invoices, ['OD23U8210']).size, 0);
});

test('own tankers: free space, leaving some out', async () => {
  const { tankerSpace } = await import('../../decant/js/core.js');
  const vehicles = [
    { plate: 'OD23A3710', caps: [3985, 3985, 3985], fill: { C1: 3985, C2: 1500 } },
    { plate: 'OR15R9360', caps: [4485, 4485, 4485, 4485], fill: {} },
    { plate: 'OD15AF5510', caps: [5000, 5000], fill: {} },
    { plate: 'OR15R1110', caps: [3985, 3985, 3985], fill: { C1: 5000, C2: 3985, C3: 3985 } },   // an over-read stays full, not negative
  ];
  const r = tankerSpace(vehicles, ['OD15 AF 5510']);
  assert.deepEqual(r.rows.map((x) => [x.plate, x.free]), [['OR15R9360', 17940], ['OD23A3710', 6470], ['OR15R1110', 0]]);
  assert.equal(r.free, 24410);
  assert.deepEqual(r.excluded, ['OD15AF5510']);
});

test('tank by tank: where each tank of a decantation is', async () => {
  const { tankStage } = await import('../../decant/js/core.js');
  const s = { status: 'decanting' };
  assert.equal(tankStage(s, { stage: 'waiting' }), 'waiting');       // Tank 3 not started yet (still selling)
  assert.equal(tankStage(s, { stage: 'decanting' }), 'decanting');
  assert.equal(tankStage(s, { stage: 'settling' }), 'settling');
  assert.equal(tankStage(s, { stage: 'read' }), 'read');
  // rows saved before tank by tank: they all went together, as the session did
  assert.equal(tankStage({ status: 'decanting' }, {}), 'decanting');
  assert.equal(tankStage({ status: 'settling' }, {}), 'settling');
  assert.equal(tankStage({ status: 'settling' }, { after: { volume: 1 } }), 'read');
  assert.equal(tankStage({ status: 'done' }, { after: { volume: 1 } }), 'read');
  assert.equal(tankStage({ status: 'draft' }, {}), 'waiting');
});

test('variation: nothing is sold while a tank decants', () => {
  // (after − before) − chambers; the first version's "sold during" still counts for its old records
  const r = tankResult({ litres: 14000, before: { volume: 4973.71 }, after: { volume: 18903.49 } });
  assert.equal(r.gain, 13929.78);
  assert.equal(r.variation, -70.22);
  assert.equal(r.expected, 14000);
});
