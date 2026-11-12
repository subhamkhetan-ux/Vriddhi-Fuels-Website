// Register: the E-DSR, Stock Register and DIP Chart read the way the real
// workbooks are laid out (made-up figures), the DSR book and the Stock
// Register worked out from them, and kept in the demo store.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actualShortage, dipOf, GAIN_LIMIT, latestDays, litresOf, latestMorning, monthFromTitle, mornings, morningOf, productMonth, pumpSales, readDipChart, readDsr, readStock, registerKind,
  registerAlerts, shortageAlert, testingAdjust,
} from '../../ledger/js/register.js';
import { demoRegister } from '../../ledger/js/register-demo.js';
import { adjustHtml, alertText, dsrTableHtml, stockTableHtml } from '../../ledger/js/register-view.js';
import { memoryStore } from '../../ledger/js/store.js';
import { isoToSerial } from '../../ledger/js/util.js';

// a SheetJS-shaped sheet from rows of values ('=…' marks a formula with its cached value)
function sheet(rows, merges = []) {
  const ws = {};
  let maxC = 0;
  rows.forEach((row, r) => (row || []).forEach((v, c) => {
    if (v == null) return;
    const a = String.fromCharCode(65 + c) + (r + 1);
    if (v && typeof v === 'object' && 'f' in v) ws[a] = { t: typeof v.v === 'number' ? 'n' : 's', v: v.v, f: v.f };
    else ws[a] = { t: typeof v === 'number' ? 'n' : 's', v };
    maxC = Math.max(maxC, c);
  }));
  ws['!ref'] = `A1:${String.fromCharCode(65 + maxC)}${rows.length}`;
  ws['!merges'] = merges;
  return ws;
}
const book = (sheets) => ({ SheetNames: Object.keys(sheets), Sheets: sheets });
const M = (r, c1, c2) => ({ s: { r, c: c1 }, e: { r, c: c2 } });

// E-DSR: November 2026 (30 days), a Petrol sheet with 2 nozzles on Machine No. 1
function edsr() {
  const rows = [['PETROL MONTH OF NOVEMBER 2026'], [null, null, null, null, 'MACHINE NO. 1'],
    ['S.No', 'Opening', 'Receipts', 'Total', 'A1', 'B1', 'Test', 'Sale ', 'Cumm. Sale']];
  const m = [1000, 2000];
  for (let d = 1; d <= 31; d++) {
    const row = [d, d === 1 ? 5000 : { f: 'IF(…)', v: '' }, d === 2 ? 4000 : null, null];
    if (d <= 4) { row[4] = m[0]; row[5] = m[1]; m[0] += 300; m[1] += 210; row[6] = d <= 3 ? 10 : null; }
    rows.push(row);
  }
  return book({ Petrol: sheet(rows, [M(1, 4, 5), M(0, 0, 8)]) });
}

test('register: the month from a sheet title, which workbook is which', () => {
  assert.equal(monthFromTitle('DIESEL MONTH OF NOVEMBER 2026'), '2026-11');
  assert.equal(monthFromTitle('XtraGreen month of january, 2027'), '2027-01');
  assert.equal(monthFromTitle('Stock'), null);
  assert.equal(registerKind(edsr()), 'dsr');
  assert.equal(registerKind(book({ MS: {}, HSD: {}, XG: {}, 'Macro Log': {} })), 'stock');
  assert.equal(registerKind(book({ 'Stock to Dip': {}, Log: {} })), 'dipchart');
  assert.equal(registerKind(book({ Sheet1: {} })), null);
});

test('register: E-DSR → book stock, testing and sale as its formulas', () => {
  const d = readDsr(edsr());
  assert.equal(d.month, '2026-11');
  const p = d.products.MS;
  assert.deepEqual(p.nozzles, [{ label: 'A1', machine: 'Machine No. 1' }, { label: 'B1', machine: 'Machine No. 1' }]);
  assert.equal(p.open, 5000);
  assert.equal(p.days.length, 31);                        // 30 days + the morning after
  assert.deepEqual(p.days[1], { receipt: 4000, test: 10, meters: [1300, 2210] });
  const pm = productMonth({ month: '2026-11', key: 'MS', dsr: p, stock: null, by: null, chart: null });
  const [d1, d2, d3, d4] = pm.rows;
  assert.deepEqual([d1.sale, d2.sale, d3.sale, d4.sale], [500, 500, 500, null]);   // 300 + 210 − 10; day 4 has no testing yet
  assert.deepEqual([d1.cum, d3.cum], [500, 1500]);
  assert.deepEqual([d1.bookOpen, d2.bookOpen, d2.bookTotal, d2.bookClose, d4.bookOpen], [5000, 4500, 8500, 8000, 7500]);
  assert.deepEqual(pm.totals, { receipt: 4000, test: 30, sale: 1500, variation: 0 });
  assert.throws(() => readDsr(book({ Sheet1: sheet([['x']]) })), /doesn't look like the E-DSR/);
});

test('register: Stock Register → tank stock, shortage and its variation; the Macro Log', () => {
  const rows = [['PETROL MONTH OF NOVEMBER 2026', null, null, null, null, null, null, null, null, null, 'Opening Shortage', null, 100],
    ['S.No', 'Opening Stock', 'Receipts', 'Total', 'Sale ', 'Actual Tank Stock', 'Shortage', 'Variation of Shortage']];
  for (let d = 1; d <= 31; d++) rows.push([d, null, null, null, null, d === 1 ? 4390 : d === 2 ? 7880 : null]);
  const t = (iso, h) => isoToSerial(iso) + h / 24;
  const log = sheet([['Time', 'Sheet', 'Value', 'Result'],
    [t('2026-11-02', 9), 'MS', 4390, 'LOGGED to F3'], [t('2026-11-02', 9.5), 'MS', 4390, 'SKIPPED - F3 already logged'],
    [t('2026-11-03', 9), 'MS', 7880, 'LOGGED to F4'], [t('2026-11-03', 9), 'HSD', 12000.5, 'LOGGED to F4']]);
  const s = readStock(book({ MS: sheet(rows), 'Macro Log': log }));
  assert.equal(s.month, '2026-11');
  assert.equal(s.products.MS.openShortage, 100);
  assert.deepEqual(s.products.MS.actual.slice(0, 3), [4390, 7880, null]);
  assert.deepEqual(s.log, { '2026-11-02|mac': { MS: 4390 }, '2026-11-03|mac': { MS: 7880, HSD: 12000.5 } });
  const by = mornings(s.log, [s]);
  const pm = productMonth({ month: '2026-11', key: 'MS', dsr: readDsr(edsr()).products.MS, stock: s.products.MS, by, chart: null });
  // shortage = closing book stock − actual tank stock; variation from the opening shortage, then day to day
  assert.deepEqual([pm.rows[0].bookClose, pm.rows[0].actual, pm.rows[0].shortage, pm.rows[0].variation], [4500, 4390, 110, 10]);
  assert.deepEqual([pm.rows[1].bookClose, pm.rows[1].shortage, pm.rows[1].variation], [8000, 120, 10]);
  assert.equal(pm.rows[1].stock, 4390);                    // the morning of the 2nd: the 1st's tank stock
  assert.deepEqual([pm.shortageNow, pm.shortageDay, pm.totals.variation], [120, 2, 20]);
});

test('register: DIP Chart → its chart, this morning per tank, its Log', () => {
  const rows = [['DIP', 'VOLUME', 'DIFF', null, null, null, 'Enter MS VOLUME', 1005, null, { f: 'TODAY()', v: isoToSerial('2026-11-12') }]];
  for (let i = 0; i < 40; i++) rows.push([1 + i / 10, 100 + i * 50]);
  rows[8] = [...(rows[8] || []), null, null, null, null, 'MS Volume', 'DIP Value', null, 'HSD Volume 1', 'DIP Value', null, 'HSD Volume 2', 'DIP Value', null, 'XG Volume'];
  rows[8].length = 17;
  const r9 = rows[9];
  rows[9] = [r9[0], r9[1], null, null, null, null, 1000, 2.8, null, 600, 2.0, null, 700, 2.2, null, 150, 1.1];
  const lg = sheet([['Date', 'MS Volume', 'HSD Volume', 'XG Volume'], [isoToSerial('2026-11-11'), 1050, 1400, 150]]);
  const c = readDipChart(book({ 'Stock to Dip': sheet(rows), Log: lg }));
  assert.equal(c.chart.length, 40);
  assert.deepEqual(c.chart[0], [1, 100]);
  assert.deepEqual(c.reading, { date: '2026-11-12', MS: 1000, HSD1: 600, HSD2: 700, XG: 150 });
  assert.deepEqual(c.log['2026-11-12|chart'], { MS: 1000, HSD1: 600, HSD2: 700, XG: 150, HSD: 1300 });
  assert.deepEqual(c.log['2026-11-11|log'], { MS: 1050, HSD: 1400, XG: 150 });
  // litres <-> dip on the chart (the nearest row; the first one on a tie)
  assert.equal(dipOf(c.chart, 1000), 2.8);
  assert.equal(dipOf(c.chart, 1024), 2.8);
  assert.equal(dipOf(c.chart, 1025), 2.8);
  assert.equal(dipOf(c.chart, 1026), 2.9);
  assert.equal(litresOf(c.chart, 2.8), 1000);
  assert.throws(() => readDipChart(book({ Sheet1: {} })), /DIP Chart/);
});

test('register: whose morning stock wins, and a DIP Chart reading carried to the next day', () => {
  const stock = { month: '2026-11', products: { MS: { actual: [900, 800, ...Array(28).fill(null)] } } };
  const log = {
    '2026-11-02|mac': { MS: 900 },                         // the Stock Register's macro
    '2026-11-03|mac': { MS: 900 },                         // … logged before the DIP Chart was updated
    '2026-11-03|log': { MS: 810 },                         // the DIP Chart's own Log
    '2026-11-05|chart': { MS: 700, HSD1: 1, HSD2: 2, HSD: 3 },
    '2026-11-04|mac': { MS: 700, HSD: 3 },
  };
  const by = mornings(log, [stock]);
  assert.deepEqual(morningOf(by, '2026-11-02'), { MS: 900, src: { MS: 'stock' }, differs: {} });
  // the 3rd: the DIP Chart's Log beats the Stock Register (which has 800), and says so
  assert.deepEqual(morningOf(by, '2026-11-03'), { MS: 810, src: { MS: 'log' }, differs: { MS: 800 } });
  // the reading dated the 5th is the 4th's morning (its figures are the 4th's)
  assert.equal(morningOf(by, '2026-11-05'), null);
  assert.deepEqual(morningOf(by, '2026-11-04'), { MS: 700, HSD: 3, HSD1: 1, HSD2: 2, src: { MS: 'chart', HSD: 'chart' }, differs: {} });
  const chart = [[1, 1], [2, 2], [70, 700], [81, 810]];
  const latest = latestMorning(by, chart, '2026-11-30');
  assert.equal(latest.date, '2026-11-04');
  assert.deepEqual(latest.products.map((p) => [p.key, p.stock, p.dips]), [['HSD', 3, [1, 2]], ['MS', 700, [70]], ['XG', null, []]]);
});

test('register: the paper DSR writes figures as by hand', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ day: i + 1, date: `2026-11-${String(i + 1).padStart(2, '0')}`, dips: [], stock: null }));
  rows[0] = { ...rows[0], stock: 36052.55, total: 36052.55, receipt: null, dips: [181.2, 147.3], meters: [1996010.83, 3242550.03], test: 70, sale: 20694.82, cum: 20694.82 };
  rows[1] = { ...rows[1], stock: 15185.89, total: 81185.89, receipt: 66000, dips: [null, null], meters: [1996438.59, 3246114.37], test: 200, sale: 61598.96, cum: 82293.78 };
  const pm = { key: 'HSD', month: '2026-11', product: { tanks: 2 }, nozzles: [{ label: 'A2', machine: 'Machine No. 1' }, { label: 'B2', machine: 'Machine No. 1' }],
    rows, totals: { receipt: 66000, test: 270, sale: 82293.78, variation: 0 } };
  const html = dsrTableHtml(pm, {});
  const line = (d) => html.split(`<th class="date">${d}</th>`)[1].split('</tr>')[0].replace(/<[^>]+>/g, '|').split('|').map((x) => x.trim()).filter(Boolean);
  assert.deepEqual(line(1), ['181.2', '147.3', '36052', '×', '36052', '1996010', '3242550', '70', '20694.82', '20694.82']);
  assert.deepEqual(line(2), ['?', '?', '15185', '66000', '81185', '1996438', '3246114', '200', '61598.96', '82293.78']);
  assert.match(html, /PRODUCT : HSD \(HIGH SPEED DIESEL\)/);
  assert.equal((html.match(/class="pump/g) || []).length, 8);
});

test('register: kept per workbook and month; the tank log only grows', async () => {
  const s = memoryStore();
  assert.deepEqual(await s.register(), {});
  await assert.rejects(s.registerImport('dsr', 'x.xlsx', { products: {} }), /month wasn't found/);
  await assert.rejects(s.registerImport('other', 'x.xlsx', {}), /Unknown register workbook/);
  await assert.rejects(s.registerImport('stock', 'x.xlsm', { month: '2026-11' }, { 'bad|mac': {} }), /Bad tank log entry/);
  await s.registerImport('stock', 'Stock Register.xlsm', { month: '2026-11', products: {} }, { '2026-11-02|mac': { MS: 1 } });
  await s.registerImport('dipchart', 'DIP Chart.xlsm', { chart: [[1, 2]], reading: {} }, { '2026-11-02|chart': { MS: 2 } });
  await s.registerImport('stock', 'Stock Register.xlsm', { month: '2026-11', products: { MS: {} } }, { '2026-11-03|mac': { MS: 3 } });
  const all = await s.register();
  assert.deepEqual(Object.keys(all).sort(), ['dipchart', 'stock:2026-11', 'tanklog']);
  assert.deepEqual(all['stock:2026-11'].data.products, { MS: {} });
  assert.deepEqual(all.tanklog.data, { '2026-11-02|mac': { MS: 1 }, '2026-11-02|chart': { MS: 2 }, '2026-11-03|mac': { MS: 3 } });
  assert.equal(all.tanklog.updated_by, 'demo@example.com');
});

test('register: the demo month adds up and draws', async () => {
  const seed = demoRegister(new Date(2026, 10, 12));
  const s = memoryStore({ register: seed });
  const all = await s.register();
  const by = mornings(all.tanklog.data, [all['stock:2026-11'].data]);
  for (const key of ['HSD', 'MS', 'XG']) {
    const pm = productMonth({ month: '2026-11', key, by, chart: all.dipchart.data.chart,
      dsr: all['dsr:2026-11'].data.products[key], stock: all['stock:2026-11'].data.products[key] });
    const days = pm.rows.filter((r) => r.sale != null);
    assert.equal(days.length, 11, key);
    // every day: opening + receipt − sale = the next morning's book stock; the dip stock is the chart's
    for (const r of days) assert.ok(Math.abs(r.bookOpen + (r.receipt || 0) - r.sale - r.bookClose) < 0.01);
    assert.ok(pm.rows[11].stock > 0 && pm.rows[11].dips.every((d) => d > 0), key);
    assert.ok(pm.shortageNow > 0 && pm.shortageNow < 3000, `${key} ${pm.shortageNow}`);
    // the paper pages: every date line of the book (31), as printed, today's marked
    const marks = latestDays(pm);
    assert.deepEqual(marks, { latest: 12, prev: 11 });
    const dsr = dsrTableHtml(pm, marks);
    const stock = stockTableHtml(pm, { latest: 12, adj: testingAdjust(all, key).get('2026-11') });
    assert.match(dsr, /<tr class="today"><th class="date">12<\/th>/);
    // the day before: receipt, total stock, testing, sale and cumulative marked (5 cells);
    // this morning: its receipt and total stock not marked, no × for a receipt yet
    assert.equal((dsr.split('<th class="date">11</th>')[1].split('</tr>')[0].match(/ink hl/g) || []).length, 5);
    const today = dsr.split('<th class="date">12</th>')[1].split('</tr>')[0];
    assert.equal((today.match(/ink nohl/g) || []).length, 2);
    assert.doesNotMatch(today, /×/);
    assert.match(stock, /Testing Adjustment/);
    assert.equal((dsr.match(/<th class="date/g) || []).length, 31 + 2);        // 1–31, TOTAL, LAST YEAR SALES
    assert.equal((stock.match(/<th class="date/g) || []).length, 1 + 31 + 1);  // S.No, 1–31, G.TOTAL
    assert.match(dsr, /MONTH <u>NOVEMBER-2026<\/u>/);
    assert.match(stock, /MONTH OF NOVEMBER 2026/);
  }
});

test('register: the pumps\' day sales of petrol and XtraGreen, from every month kept', async () => {
  const s = memoryStore({ register: demoRegister(new Date(2026, 10, 12)) });
  const sales = pumpSales(await s.register());
  const keys = Object.keys(sales).sort();
  assert.equal(keys.length, 22);                           // 11 days × MS, XG (HSD left out)
  assert.ok(keys.every((k) => /^2026-11-(0[1-9]|1[01])\|(MS|XG)$/.test(k)));
  assert.deepEqual(pumpSales({}), {});
});

test('register: dips typed in the app are written over the DIP Chart\'s, and checked on the chart', () => {
  const chart = [[77.7, 7000], [82.7, 8185.89], [147.3, 16208.62], [181.2, 19843.93]];
  const by = mornings({ '2026-11-02|mac': { HSD: 15185.89 }, '2026-11-01|mac': { HSD: 36052.55 } }, []);
  const pm = productMonth({ month: '2026-11', key: 'HSD', dsr: null, stock: null, by, chart, typed: { 1: [181.2, 147.3], 2: [77.7, 147.3] } });
  assert.deepEqual([pm.rows[0].dips, pm.rows[0].dipTyped, pm.rows[0].dipOff], [[181.2, 147.3], true, null]);   // 19843.93 + 16208.62 = 36052.55
  assert.equal(pm.rows[1].dipTyped, true);
  assert.equal(pm.rows[1].dipOff, 8022.73);                                // 7000 + 16208.62, not the morning's 15185.89
  assert.deepEqual([pm.rows[2].dips, pm.rows[2].dipTyped], [[], false]);
  const html = dsrTableHtml(pm, { latest: 2, prev: 1, edit: true });
  assert.equal((html.match(/class="dip-in"/g) || []).length, 4);           // 2 days × 2 tanks
});

test('register: the testing adjustment — actual testing carried day to day, months carried on', () => {
  const dsrMonth = (month, tests) => ({ data: { month, products: { HSD: { days: tests.map((t) => ({ test: t, meters: null, receipt: null })) } } } });
  const nov = Array(31).fill(null); nov.splice(0, 4, 70, 200, 0, 200);
  const dec = Array(32).fill(null); dec.splice(0, 2, 100, 100);
  const all = {
    'dsr:2026-11': dsrMonth('2026-11', nov),
    'stock:2026-11': { data: { month: '2026-11', products: { HSD: { testAdjust: 490 } } } },
    'adjust:2026-11': { data: { actual: { HSD: { 4: 40 } } } },
    'dsr:2026-12': dsrMonth('2026-12', dec),
  };
  const adj = testingAdjust(all, 'HSD');
  const n = adj.get('2026-11');
  // opening from the Stock Register's "Testing Adjustment"; 30 L a day; none on a day the DSR has 0; 40 typed on the 4th
  assert.deepEqual([n.open, n.openSrc], [490, 'sheet']);
  assert.deepEqual(n.days.slice(0, 4).map((x) => [x.dsr, x.actual, x.actualSrc, x.adj, x.running]),
    [[70, 30, 'default', 40, 530], [200, 30, 'default', 170, 700], [0, 0, 'none', 0, 700], [200, 40, 'typed', 160, 860]]);
  assert.deepEqual([n.added, n.closing, n.dsrTotal, n.actualTotal, n.testDays], [370, 860, 470, 100, 4]);
  // December opens with November's closing, and keeps the 40 typed last
  const d = adj.get('2026-12');
  assert.deepEqual([d.open, d.openSrc, d.days[0].actual, d.days[0].actualSrc, d.closing], [860, 'carried', 40, 'carried', 980]);
  // an opening typed for December wins
  all['adjust:2026-12'] = { data: { open: { HSD: 1000 } } };
  assert.deepEqual([testingAdjust(all, 'HSD').get('2026-12').open, testingAdjust(all, 'HSD').get('2026-12').closing], [1000, 1120]);
  // a day the DSR hasn't reached yet still has its actual testing (typed ahead, or carried)
  assert.deepEqual([n.days[9].dsr, n.days[9].actual, n.days[9].actualSrc, n.days[9].adj], [null, 40, 'carried', null]);
  // the Stock Register's shortage = testing adjustment + actual: split day by day
  const rows = Array.from({ length: 30 }, (_, i) => ({ day: i + 1, shortage: null, variation: null }));
  Object.assign(rows[0], { shortage: 2600, variation: 50 });
  Object.assign(rows[1], { shortage: 2780, variation: 180 });
  Object.assign(rows[2], { shortage: 2775, variation: -5 });
  Object.assign(rows[3], { shortage: 2950, variation: 175 });
  const pm = { product: { short: 'HSD' }, month: '2026-11', shortageNow: 2950, rows };
  const split = actualShortage(pm, n);
  assert.deepEqual(split.days.slice(0, 4).map((x) => [x.shortage, x.adjust, x.actual, x.actualVar]),
    [[2600, 530, 2070, 10], [2780, 700, 2080, 10], [2775, 700, 2075, -5], [2950, 860, 2090, 15]]);
  assert.deepEqual([split.shortage, split.adjust, split.actual, split.variation, split.actualVar, split.day], [2950, 860, 2090, 400, 30, 4]);
  const html = adjustHtml(n, pm, split, { nextMonth: '2026-12' });
  assert.match(html, /Actual shortage <span class="faint">to 4 Nov<\/span><\/span><span class="val">2,090.00/);
  assert.match(html, /December 2026's opening/);
  assert.equal((html.match(/class="adj-in"/g) || []).length, 30);           // every day of the month
});

test('register: typed dips and the testing adjustment are kept per month', async () => {
  const s = memoryStore();
  await assert.rejects(s.registerSave('dsr:2026-11', {}), /Unknown register entry/);
  await assert.rejects(s.registerSave('dips:2026-13', {}), /Unknown register entry/);
  await assert.rejects(s.registerSave('adjust:2026-11', []), /Nothing to save/);
  await s.registerSave('dips:2026-11', { HSD: { 1: [181.2, 147.3] } });
  await s.registerSave('adjust:2026-11', { open: { HSD: 490 } });
  const all = await s.register();
  assert.deepEqual(all['dips:2026-11'].data, { HSD: { 1: [181.2, 147.3] } });
  assert.deepEqual(all['adjust:2026-11'].data.open, { HSD: 490 });
});

test('register: a warning when the books gained more than 40 L in the month', () => {
  const pm = (variation, day = 11) => ({ key: 'HSD', month: '2026-11', shortageDay: day, totals: { variation } });
  assert.equal(GAIN_LIMIT, 40);
  assert.equal(shortageAlert(pm(67.01)), null);              // the shortage grew: fine
  assert.equal(shortageAlert(pm(-40)), null);                // a gain of 40 L: still within
  assert.deepEqual(shortageAlert(pm(-120.5)), { key: 'HSD', month: '2026-11', gain: 120.5, day: 11, left: 19, perDay: 7 });
  assert.deepEqual(shortageAlert(pm(-50, 30)), { key: 'HSD', month: '2026-11', gain: 50, day: 30, left: 0, perDay: 50 });
  assert.match(alertText(shortageAlert(pm(-120.5)), 'HSD'), /gained 120.50 L this month \(to 11 Nov\).*about 7 L more DSR testing a day for the 19 days left/);
  // from what's kept: the E-DSR's month and a Stock Register whose tank stock beats the books
  const d = readDsr(edsr());
  const stock = { month: '2026-11', products: { MS: { openShortage: 0, actual: [4600, 8100, 7600, ...Array(27).fill(null)] } } };
  const all = { 'dsr:2026-11': { data: d }, 'stock:2026-11': { data: stock } };
  // books close 4500, 8000, 7500 against tanks 4600, 8100, 7600: a gain of 100 L
  assert.deepEqual(registerAlerts(all).map((a) => [a.key, a.gain, a.day]), [['MS', 100, 3]]);
  assert.deepEqual(registerAlerts({}), []);
});
