// Phone photos of the automation screen taken close up: one with two tanks
// side by side, two with a single tank filling the frame (its big "Tank N :"
// heading is skipped by the whole-picture passes), and the two-tank photo
// blurred. The fixture holds what Tesseract.js (decant/js/ocr.js) read from
// them — every pass, the closer looks, the lines and headings read on their
// own — and no pictures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { findHeaders, parseAutomation, readCard } from '../../decant/js/automation.js';
import { DEFAULT_TANKS } from '../../decant/js/core.js';
import { DIP_CHART } from '../../decant/js/dipchart.js';

const OCR = JSON.parse(fs.readFileSync(new URL('./fixtures/automation-photos-close-ocr.json', import.meta.url)));
const NOW = Date.parse('2026-10-07T20:45:00+05:30');
const opts = { tanks: DEFAULT_TANKS, chart: DIP_CHART, now: NOW };

// What the screen says: [tank, volume, ullage, product height (mm), last updated]
const SCREEN = {
  2: [18475.55, 1524.45, 1672.89],
  3: [18488.93, 1511.07, 1674.16],
};
const PHOTOS = {
  two: [[2, '2026-10-07T20:40:41+05:30'], [3, '2026-10-07T20:40:42+05:30']],
  tank2: [[2, '2026-10-07T20:40:53+05:30']],
  tank3: [[3, '2026-10-07T20:41:01+05:30']],
};

for (const [name, rows] of Object.entries(PHOTOS)) {
  test(`close-up photo ${name}: each tank found and numbered, its stock read and checked`, () => {
    const res = parseAutomation(OCR[name], opts);
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(res.tanks.map((t) => [t.no, t.tankId]), rows.map(([no]) => [no, `T${no}`]));
    for (const [no, at] of rows) {
      const t = res.tanks.find((x) => x.no === no);
      const r = t.reading;
      assert.deepEqual([r.volume, r.ullage, r.height], SCREEN[no], `${name} tank ${no}`);
      assert.equal(t.confidence, 'high');
      assert.equal(r.readingAt, at);
    }
  });
}

test('a single tank close up: the evened-light pass reads the heading the first two skip', () => {
  const two = { ...OCR.tank2, passes: OCR.tank2.passes.filter((p) => p.mode !== 'even') };
  assert.deepEqual(parseAutomation(two, opts).tanks.map((t) => t.no), [null]);
  assert.deepEqual(parseAutomation(OCR.tank2, opts).tanks.map((t) => t.no), [2]);
});

test('a single tank close up: else its heading read on its own numbers it', () => {
  assert.deepEqual(parseAutomation({ ...OCR.tank3, heads: [] }, opts).tanks.map((t) => t.no), [null]);
  const res = parseAutomation(OCR.tank3, opts);
  assert.deepEqual(res.tanks.map((t) => [t.no, t.productText]), [[3, 'High Speed Diesel']]);
});

test('a blurred photo: both cards found, and no misread stock passed off as checked', () => {
  const res = parseAutomation(OCR.two_blurred, opts);
  assert.deepEqual(res.tanks.map((t) => t.no), [2, 3]);
  for (const t of res.tanks) {
    // within a few litres of the screen, or flagged for the user to check
    if (t.confidence !== 'low') assert.ok(Math.abs(t.reading.volume - SCREEN[t.no][0]) < 5, `tank ${t.no}: ${t.reading.volume} (${t.confidence})`);
  }
});

test('headings with a speck or the card border glued on still read', () => {
  const w = (text, x0) => ({ text, x0, x1: x0 + 10 * text.length, y0: 100, y1: 130 });
  for (const first of ['(Tank', '[Tank', '“Tank', '|Tank']) {
    const heads = findHeaders([w(first, 10), w('3', 80), w(':', 100), w('High', 120), w('Speed', 170), w('Diesel', 230)]);
    assert.deepEqual(heads.map((h) => [h.no, h.productText]), [[3, 'High Speed Diesel']], first);
  }
});

test('"20.000 00": a thousands comma read as a point and the decimal point as a gap', () => {
  const line = (y, ...texts) => {
    let x = 20;
    return texts.map((text) => { const o = { text, x0: x, x1: x + 9 * text.length, y0: y, y1: y + 20 }; x = o.x1 + 6; return o; });
  };
  const words = [
    ...line(100, 'Tank', 'Capacity', '20.000', '00', 'ltr'),
    ...line(140, 'Product', 'Volume', '18.488', '93', 'ltr'),
    ...line(180, 'Product', 'Height', '1,674.16', 'mm'),
    ...line(220, 'Ullage', 'Space', '1,511.07', 'ltr'),
  ];
  const got = readCard({ words });
  assert.deepEqual([got.capacity, got.volume, got.height, got.ullage], [20000, 18488.93, 1674.16, 1511.07]);
  // the speck after two decimals is still dropped ("368.068" is 368.06)
  assert.equal(readCard({ words: line(100, 'Product', 'Height', '368.068', 'mm') }).height, 368.06);
});
