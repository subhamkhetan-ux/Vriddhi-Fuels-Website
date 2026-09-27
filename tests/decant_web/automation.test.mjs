// Reading the IOCL automation screenshots. The fixture holds the word boxes
// Tesseract.js (decant/js/ocr.js, both passes) got from four real screenshots:
// 1 = all four tanks side by side, 2 = tanks 2 and 3, 3 = tank 3, 4 = tank 2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  findHeaders, labelField, parseAutomation, readNumber, readTime,
} from '../../decant/js/automation.js';
import { DEFAULT_TANKS } from '../../decant/js/core.js';
import { DIP_CHART } from '../../decant/js/dipchart.js';

const OCR = JSON.parse(fs.readFileSync(new URL('./fixtures/automation-ocr.json', import.meta.url)));
const OPTS = { tanks: DEFAULT_TANKS, chart: DIP_CHART, now: Date.parse('2026-09-26T12:20:00+05:30') };
const clone = (x) => JSON.parse(JSON.stringify(x));

// What the screenshots say, card by card.
const EXPECTED = {
  1: [
    [1, 'MS', 3898.77, 16101.23, 495.77, 0, 695.8, 709.7, 30.1, '2026-09-26T12:14:20+05:30'],
    [2, 'HSD', 14973.71, 5026.29, 1372.25, 0, 809.5, 818.8, 28.1, '2026-09-26T12:14:19+05:30'],
    [3, 'HSD', 9989.83, 10010.17, 987.09, 0, 810, 820.3, 29.5, '2026-09-26T12:14:21+05:30'],
    [4, 'XG', 2559.46, 17440.54, 369.33, 0, 799, 809.9, 30.1, '2026-09-26T12:14:23+05:30'],
  ],
  2: [
    [2, 'HSD', 3446.8, 16553.2, 454.58, 0, 1036, 1045.6, 30, '2026-09-26T11:06:53+05:30'],
    [3, 'HSD', 4136.61, 15863.39, 516.97, 0, 894.3, 904.4, 29.9, '2026-09-26T11:06:57+05:30'],
  ],
  3: [[3, 'HSD', 12019.45, 7980.55, 1141.99, 0, 810, 820.3, 29.5, '2026-09-26T11:13:54+05:30']],
  4: [[2, 'HSD', 17376.58, 2623.42, 1572.82, 0, 810, 819.4, 28.3, '2026-09-26T11:18:17+05:30']],
};

for (const [shot, rows] of Object.entries(EXPECTED)) {
  test(`screenshot ${shot}: every tank card read and checked`, () => {
    const res = parseAutomation(OCR[shot], OPTS);
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(res.tanks.map((t) => [t.no, t.product, t.reading.volume, t.reading.ullage, t.reading.height,
      t.reading.water, t.reading.density, t.reading.densityTc, t.reading.temp, t.reading.readingAt]), rows);
    for (const t of res.tanks) {
      assert.equal(t.confidence, 'high', `tank ${t.no}`);
      assert.equal(t.tankId, `T${t.no}`);
      assert.equal(t.checks.sum.ok, true);
      assert.equal(t.checks.chart.ok, true);
      assert.ok(Math.abs(t.checks.chart.diff) < 1);
      assert.deepEqual(t.checks.corrected, []);
    }
  });
}

function editWord(ocr, pass, from, to) {
  const w = ocr.passes[pass].words.find((x) => x.text === from);
  assert.ok(w, `no word ${from}`);
  w.text = to;
}

test('a misread volume is fixed from the ullage and the dip chart', () => {
  const ocr = clone(OCR[1]);
  editWord(ocr, 0, '14,973.71', '18,973.71');         // what plain Tesseract once read
  const t2 = parseAutomation(ocr, OPTS).tanks.find((t) => t.no === 2);
  assert.equal(t2.reading.volume, 14973.71);
  assert.equal(t2.confidence, 'medium');
  assert.deepEqual(t2.checks.corrected, ['volume']);
});

test('a misread ullage is fixed from the volume', () => {
  const ocr = clone(OCR[3]);
  editWord(ocr, 0, '7,980.55', '7,930.55');
  editWord(ocr, 1, '7,980.55', '7,930.55');
  const t3 = parseAutomation(ocr, OPTS).tanks[0];
  assert.equal(t3.reading.volume, 12019.45);
  assert.equal(t3.reading.ullage, 7980.55);
  assert.deepEqual(t3.checks.corrected, ['ullage']);
  assert.equal(t3.confidence, 'medium');
});

test('nothing adds up: low confidence, left for the user to check', () => {
  const ocr = clone(OCR[3]);
  editWord(ocr, 0, '12,019.45', '12,519.45');
  editWord(ocr, 0, '1,141.99', '1,191.99');
  ocr.passes = [ocr.passes[0]];
  editWord(ocr, 0, '7,980.55', '7,930.55');
  const t3 = parseAutomation(ocr, OPTS).tanks[0];
  assert.equal(t3.confidence, 'low');
  assert.equal(t3.reading.volume, 12519.45);           // what the screen said
});

test('the figures pass alone still reads (no time without the labels pass)', () => {
  const ocr = clone(OCR[1]);
  ocr.passes = [ocr.passes[0]];
  const res = parseAutomation(ocr, OPTS);
  assert.equal(res.tanks.length, 4);
  assert.equal(res.tanks[1].reading.volume, 14973.71);
  assert.equal(res.tanks[1].reading.readingAt, null);
});

test('a card without its heading is read as an unknown tank', () => {
  const ocr = clone(OCR[3]);
  for (const p of ocr.passes) p.words = p.words.filter((w) => w.y0 > 40);   // crop the heading off
  const res = parseAutomation(ocr, OPTS);
  assert.equal(res.tanks.length, 1);
  assert.equal(res.tanks[0].no, null);
  assert.equal(res.tanks[0].tankId, null);
  assert.equal(res.tanks[0].reading.volume, 12019.45);
});

test('a tank the app has as another product is flagged', () => {
  const tanks = DEFAULT_TANKS.map((t) => (t.no === 3 ? { ...t, product: 'MS' } : t));
  const res = parseAutomation(OCR[3], { ...OPTS, tanks });
  assert.match(res.warnings[0], /Tank 3 as High Speed Diesel, but the app has Tank 3 as MS/);
});

test('no tank card at all', () => {
  const res = parseAutomation({ width: 100, height: 100, passes: [{ mode: 'values', words: [{ text: 'hello', x0: 0, y0: 0, x1: 10, y1: 10 }] }] }, OPTS);
  assert.equal(res.tanks.length, 0);
  assert.match(res.warnings[0], /Couldn't find a tank card/);
});

test('headings, figures, labels and times', () => {
  assert.deepEqual(findHeaders(OCR[1].passes[0].words).map((h) => [h.no, h.productText]), [
    [1, 'Motor Spirit'], [2, 'High Speed Diesel'], [3, 'High Speed Diesel'], [4, 'XtraGreen']]);
  assert.equal(readNumber('12,019.45'), 12019.45);
  assert.equal(readNumber('1,036.00'), 1036);
  assert.equal(readNumber('0.00'), 0);
  assert.equal(readNumber('$20.30'), 820.3);
  assert.equal(readNumber('9,9O9.83'), 9909.83);
  assert.equal(readNumber('itr'), null);
  assert.equal(readNumber('09/26/2026'), null);
  assert.equal(readNumber('30.1¢'), null);
  assert.equal(labelField('Uiage Space'), 'ullage');
  assert.equal(labelField('Density (tc)'), 'densityTc');
  assert.equal(labelField('Densaty (t€)'), 'densityTc');
  assert.equal(labelField('Density'), 'density');
  assert.equal(labelField('Product Heignt'), 'height');
  assert.equal(labelField('Tarik Capacity'), 'capacity');
  assert.equal(readTime('Last Updated & 09:26:2026 12 14 20'), '2026-09-26T12:14:20+05:30');
  assert.equal(readTime('Last Updated @ 09/26/2026 11 06-57'), '2026-09-26T11:06:57+05:30');
  assert.equal(readTime('26/09/2026 11:13'), '2026-09-26T11:13:00+05:30');                  // day first when it must be
  assert.equal(readTime('09/10/2026 10:00:00'), '2026-09-10T10:00:00+05:30');               // MM/DD by default …
  assert.equal(readTime('09/10/2026 10:00:00', 'MDY', Date.parse('2026-10-09T12:00:00+05:30')), '2026-10-09T10:00:00+05:30'); // … unless only DD/MM is recent
  assert.equal(readTime('no date here'), null);
});

test('times whose separators were lost', () => {
  assert.equal(readTime('Last Upcated 9 09/26:2026 11 1354'), '2026-09-26T11:13:54+05:30');
  assert.equal(readTime('Last Updated § 09/26/2026 11.0653'), '2026-09-26T11:06:53+05:30');
  assert.equal(readTime('U1 Last Updated @ 0926/2026 12:14:20'), '2026-09-26T12:14:20+05:30');
  assert.equal(readTime('Last Updated @ 09/26/2026 1214.21'), '2026-09-26T12:14:21+05:30');
  assert.equal(readTime('Last Updated @ 09/26/2026 12.14'), '2026-09-26T12:14:00+05:30');
  assert.equal(readTime('Last Updated @ 09/26/2026 32:14:23'), null);              // no 32 o'clock
});
