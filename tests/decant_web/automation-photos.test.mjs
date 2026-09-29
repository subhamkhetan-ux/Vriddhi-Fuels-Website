// Photos of the automation screen taken with a phone's camera (not screenshots):
// glare, blur, a tilt, the screen's edge cut off. The fixture holds what
// Tesseract.js (decant/js/ocr.js) read from four such photos — the word boxes
// of both full passes and of the closer looks at the cards, and the text of
// the "Last Updated" lines read on their own — and no pictures. Each photo
// shows all four tanks side by side; on some, "Tank 1" is cut off or the
// labels of a card are too faint to read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { cardLayout, findColumns, parseAutomation } from '../../decant/js/automation.js';
import { DEFAULT_TANKS } from '../../decant/js/core.js';
import { DIP_CHART } from '../../decant/js/dipchart.js';

const OCR = JSON.parse(fs.readFileSync(new URL('./fixtures/automation-photos-ocr.json', import.meta.url)));

// What the screen says: [tank, volume, ullage, product height (mm), water, last updated]
const PHOTOS = {
  p1: ['2021-04-08T23:30:00+05:30', [
    [1, 4102.42, 15897.58, 513.94, 0, '2021-04-08T23:26:42+05:30'],
    [2, 7176.53, 12823.47, 769.25, 0, '2021-04-08T23:26:46+05:30'],
    [3, 10549.93, 9450.07, 1029.83, 0, '2021-04-08T23:26:43+05:30'],
    [4, 2560.06, 17439.94, 369.39, 0, '2021-04-08T23:26:45+05:30'],
  ]],
  p2: ['2021-04-09T23:15:00+05:30', [
    [1, 8494.3, 11505.7, 872.25, 0, '2021-04-09T23:11:51+05:30'],
    [2, 10628.62, 9371.38, 1035.83, 0, '2021-04-09T23:11:49+05:30'],
    [3, 7358.14, 12641.86, 783.59, 0, '2021-04-09T23:11:52+05:30'],
    [4, 2559.06, 17440.94, 369.29, 0, '2021-04-09T23:11:48+05:30'],
  ]],
  p3: ['2026-09-28T06:15:00+05:30', [
    [1, 7754.47, 12245.53, 814.71, 0, '2026-09-28T06:11:36+05:30'],
    [2, 14901.11, 5098.89, 1366.44, 0, '2026-09-28T06:11:39+05:30'],
    [3, 16490.4, 3509.6, 1496.62, 0, '2026-09-28T06:11:37+05:30'],
    [4, 2559.16, 17440.84, 369.3, 0, '2026-09-28T06:11:38+05:30'],
  ]],
  p4: ['2026-09-29T06:20:00+05:30', [
    [1, 7209.92, 12790.08, 771.89, 0, '2026-09-29T06:18:26+05:30'],
    [2, 9309.16, 10690.84, 935, 0, '2026-09-29T06:18:29+05:30'],
    [3, 7398.75, 12601.25, 786.79, 0, '2026-09-29T06:18:27+05:30'],
    [4, 2546.84, 17453.16, 368.06, 0, '2026-09-29T06:18:28+05:30'],
  ]],
};

for (const [name, [now, rows]] of Object.entries(PHOTOS)) {
  test(`photo ${name}: all four tanks found and numbered, their stock read and checked`, () => {
    const res = parseAutomation(OCR[name], { tanks: DEFAULT_TANKS, chart: DIP_CHART, now: Date.parse(now) });
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(res.tanks.map((t) => [t.no, t.tankId]), [[1, 'T1'], [2, 'T2'], [3, 'T3'], [4, 'T4']]);
    let timed = 0;
    for (const [no, volume, ullage, height, water, at] of rows) {
      const t = res.tanks.find((x) => x.no === no);
      const r = t.reading;
      assert.deepEqual([r.volume, r.ullage, r.height, r.water], [volume, ullage, height, water], `${name} tank ${no}`);
      assert.equal(t.checks.sum.ok, true);
      assert.equal(t.checks.chart.ok, true);
      assert.notEqual(t.confidence, 'low');
      // the time, to the minute (a photo's seconds can misread), where it read
      if (r.readingAt) {
        timed += 1;
        assert.ok(Math.abs(Date.parse(r.readingAt) - Date.parse(at)) < 60000, `${name} tank ${no}: ${r.readingAt} ≠ ${at}`);
      }
    }
    assert.ok(timed >= 3, `${name}: ${timed} times read`);
  });
}

test('the cards are found by their columns of figures, even where headings and labels are lost', () => {
  for (const [name, ocr] of Object.entries(OCR)) {
    const words = ocr.passes.flatMap((p) => p.words);
    assert.equal(findColumns(words, ocr.width).length, 4, name);
    const layout = cardLayout(ocr.passes.map((p) => p.words), ocr.width, ocr.height, DEFAULT_TANKS);
    assert.deepEqual(layout.map((c) => c.no), [1, 2, 3, 4], name);
  }
});

test('the full passes alone (no closer look) still find every tank', () => {
  for (const [name, [now]] of Object.entries(PHOTOS)) {
    const res = parseAutomation({ ...OCR[name], zoom: [] }, { tanks: DEFAULT_TANKS, chart: DIP_CHART, now: Date.parse(now) });
    assert.deepEqual(res.tanks.map((t) => t.no), [1, 2, 3, 4], name);
  }
});
