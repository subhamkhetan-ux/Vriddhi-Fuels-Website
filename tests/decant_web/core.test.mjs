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
