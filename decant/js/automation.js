// Reading tank cards out of an IOCL automation screenshot (no DOM, tested
// under Node). Input is the word boxes ocr.js gets from Tesseract — one set per
// clean-up pass — and the output is one reading per tank card:
//
//   Tank 3 : High Speed Diesel
//   Last Updated @ 09/26/2026 11:13:54
//   Tank Status     ONLINE
//   Tank Capacity   20,000.00 ltr
//   Product Volume  12,019.45 ltr
//   Product Height  1,141.99 mm
//   Water Volume    0.00 ltr
//   Ullage Space    7,980.55 ltr
//   Density         810.00 kg/m^3
//   Density (tc)    820.30 kg/m^3
//   Temperature     29.50
//
// A screenshot can hold one card or several side by side (or in a grid). Each
// "Tank N :" heading starts a card. The figures are checked against each other
// (volume + ullage = capacity) and against the dip chart (product height ->
// litres), so a misread digit is caught and, where two readings agree, fixed.

import { istISO, litresAtDip, productKey, round2 } from './core.js';

const FIELDS = ['capacity', 'volume', 'height', 'water', 'ullage', 'density', 'densityTc', 'temp'];
const UNIT_OF = { capacity: 'L', volume: 'L', height: 'mm', water: 'L', ullage: 'L', density: 'kg', densityTc: 'kg', temp: '' };

const yc = (w) => (w.y0 + w.y1) / 2;
const xc = (w) => (w.x0 + w.x1) / 2;
const hgt = (w) => w.y1 - w.y0;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Words -> lines (top to bottom), each line's words left to right.
export function groupLines(words) {
  const ws = [...words].sort((a, b) => yc(a) - yc(b));
  const h = median(ws.map(hgt)) || 10;
  const lines = [];
  for (const w of ws) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(yc(w) - line.y) <= 0.6 * h) {
      line.words.push(w);
      line.y = line.words.reduce((a, x) => a + yc(x), 0) / line.words.length;
    } else {
      lines.push({ y: yc(w), words: [w] });
    }
  }
  for (const l of lines) {
    l.words.sort((a, b) => a.x0 - b.x0);
    l.text = l.words.map((w) => w.text).join(' ');
  }
  return lines;
}

// "Tank 3 : High Speed Diesel" headings: [{no, productText, x0, y0, y1, words}]
export function findHeaders(words) {
  const lines = groupLines(words);
  const heads = [];
  for (const line of lines) {
    const ws = line.words;
    for (let i = 0; i < ws.length; i++) {
      const t = ws[i].text;
      let no = null;
      let next = i + 1;
      const glued = /^t[ae]n[kx]([1-9])[:;.]?$/i.exec(t);
      if (glued) {
        no = Number(glued[1]);
      } else if (/^t[ae]n[kx]$/i.test(t) && ws[i + 1]) {
        const m = /^([1-9])[:;.]?$/.exec(ws[i + 1].text);
        if (m) { no = Number(m[1]); next = i + 2; }
      }
      if (!no) continue;
      // the product name runs to the right until the next heading / a big gap
      const prod = [];
      let lastX = ws[next - 1].x1;
      const gap = 3 * hgt(ws[i]);
      for (let j = next; j < ws.length; j++) {
        if (/^t[ae]n[kx]/i.test(ws[j].text)) break;
        if (ws[j].x0 - lastX > gap) break;
        if (!/^[:;.\-|]+$/.test(ws[j].text)) prod.push(ws[j].text);
        lastX = ws[j].x1;
      }
      heads.push({ no, productText: prod.join(' '), x0: ws[i].x0, y0: Math.min(ws[i].y0, ws[next - 1].y0), y1: Math.max(ws[i].y1, ws[next - 1].y1), words: ws.slice(i, next) });
    }
  }
  return heads;
}

// Split the words into cards, one per heading. Cards side by side share a row
// (headings at about the same height); each card runs right to the next
// heading of its row and down to the next row of headings.
export function splitCards(words, width, height) {
  const heads = findHeaders(words);
  if (!heads.length) return [{ no: null, productText: '', words, head: null }];
  const lineH = median(heads.map((h) => h.y1 - h.y0)) || 12;
  const rows = [];
  for (const h of [...heads].sort((a, b) => a.y0 - b.y0)) {
    const row = rows.find((r) => Math.abs(r.y - h.y0) < 2 * lineH);
    if (row) row.heads.push(h); else rows.push({ y: h.y0, heads: [h] });
  }
  const cards = [];
  rows.forEach((row, ri) => {
    const hs = row.heads.sort((a, b) => a.x0 - b.x0);
    const top = row.y - lineH;
    const bottom = ri + 1 < rows.length ? rows[ri + 1].y - lineH : (height || Infinity);
    // the border between two cards sits just left of the next heading
    const edge = (k) => hs[k + 1].x0 - 0.04 * (hs[k + 1].x0 - hs[k].x0);
    hs.forEach((h, hi) => {
      const left = hi === 0 ? -Infinity : edge(hi - 1);
      const right = hi + 1 < hs.length ? edge(hi) : (width || Infinity);
      const ws = words.filter((w) => !h.words.includes(w) && xc(w) >= left && xc(w) < right && yc(w) >= top && yc(w) < bottom
        && !(yc(w) <= h.y1 && w.x0 >= h.x0));             // the heading's own product words
      cards.push({ no: h.no, productText: h.productText, words: ws, head: h, left, right, top, bottom });
    });
  });
  return cards;
}

// A figure as the automation prints it ("12,019.45", "0.00", "1,036.00"),
// allowing the usual misreads ($ for 8, O for 0, l for 1, S for 5).
export function readNumber(token) {
  let t = String(token || '').replace(/^[^0-9A-Za-z$]+|[^0-9A-Za-z]+$/g, '');
  if (!t || !/\d/.test(t)) return null;
  const digits = t.replace(/[^0-9]/g, '').length;
  if (digits < t.replace(/[,.]/g, '').length * 0.6) return null;
  t = t.replace(/[Oo]/g, '0').replace(/[lI|!]/g, '1').replace(/[Ss]/g, '5').replace(/\$/g, '8').replace(/B/g, '8');
  if (!/^\d{1,3}(,\d{3})*\.\d{2}$|^\d+\.\d{2}$/.test(t)) return null;
  return Number(t.replace(/,/g, ''));
}

function unitOf(text) {
  const u = String(text || '').toLowerCase();
  if (!u) return '';
  if (/^m[mn]$|^mm/.test(u)) return 'mm';
  if (/kg|kp|m["'”“~*^]|\/m/.test(u)) return 'kg';
  if (/^[il1|!]?t?r$|^.{0,2}tr$|ltr|itr|^[a-z]{1,2}r$|^[a-z]y$/.test(u)) return 'L';
  return '?';
}

// Which field a label names (fuzzy, the light-grey labels misread a lot).
export function labelField(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  if (/updat|last/.test(t)) return 'time';
  if (/stat/.test(t)) return 'status';
  if (/capa|pacit/.test(t)) return 'capacity';
  if (/heig|eight|hei/.test(t)) return 'height';
  if (/wat|ater/.test(t)) return 'water';
  if (/l+[ia]?age|ull|uti|utt|uia|space|spac/.test(t)) return 'ullage';
  if (/temp|mper|erat/.test(t)) return 'temp';
  if (/dens|ensi|nsit|densa/.test(t)) return /\(|t[ce€¢]\)|\)/.test(t) ? 'densityTc' : 'density';
  if (/prod|volu|olum/.test(t)) return 'volume';
  return null;
}

function statusOf(text) {
  const t = String(text || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!t) return null;
  if (/OFFL|OFLIN|FFLINE/.test(t)) return 'OFFLINE';
  if (/ONLINE|NLINE|ONLIN|ONLNE/.test(t)) return 'ONLINE';
  return null;
}

// "09/26/2026 11:13:54" (and misreads like "09:26:2026 12 14 20", "11 06-57")
export function readTime(text, dateOrder = 'MDY', now = null) {
  const nums = String(text || '').match(/\d+/g) || [];
  const yi = nums.findIndex((n) => n.length === 4 && Number(n) >= 2000 && Number(n) < 2100);
  if (yi < 1) return null;
  // month and day: the two numbers before the year ("0926" when the slash is lost)
  let a;
  let b;
  if (nums[yi - 1].length === 4) {
    a = Number(nums[yi - 1].slice(0, 2));
    b = Number(nums[yi - 1].slice(2));
  } else if (yi >= 2) {
    a = Number(nums[yi - 2].slice(-2));
    b = Number(nums[yi - 1]);
  } else {
    return null;
  }
  const y = Number(nums[yi]);
  // the clock: "11:13:54", or run together when the colons are lost ("11 1354")
  const after = nums.slice(yi + 1, yi + 4);
  const clock = after.every((x) => x.length <= 2) ? after : after.join('').match(/\d{1,2}/g) || [];
  const [hh, mm, ss] = [clock[0], clock[1], clock[2]].map((x) => (x === undefined ? null : Number(x)));
  if (hh === null || mm === null || hh > 23 || mm > 59) return null;
  const sec = ss !== null && ss <= 59 ? ss : 0;
  const mdy = a >= 1 && a <= 12 && b >= 1 && b <= 31 ? istISO(y, a, b, hh, mm, sec) : null;
  const dmy = b >= 1 && b <= 12 && a >= 1 && a <= 31 ? istISO(y, b, a, hh, mm, sec) : null;
  const valid = (iso) => iso && !Number.isNaN(Date.parse(iso)) && new Date(Date.parse(iso) + 330 * 60000).getUTCDate() === Number(iso.slice(8, 10));
  const cands = [mdy, dmy].filter(valid);
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const preferred = dateOrder === 'DMY' ? dmy : mdy;
  const other = preferred === mdy ? dmy : mdy;
  if (now && Math.abs(Date.parse(preferred) - now) > 3 * 86400000 && Math.abs(Date.parse(other) - now) <= 3 * 86400000) return other;
  return preferred;
}

// One card's lines -> raw fields, by label where one is readable and otherwise
// by position (the card always lists the fields in the same order).
export function readCard(card, opts = {}) {
  const lines = groupLines(card.words);
  const out = { time: null, status: null };
  const rows = [];
  for (const line of lines) {
    const ws = line.words;
    const st = statusOf(line.text);
    if (st) out.status = st;
    if (!out.time && (/updat|last/i.test(line.text) || /\d{1,2}\D\d{1,2}\D20\d\d/.test(line.text))) {
      const t = readTime(line.text, opts.dateOrder, opts.now);
      if (t) { out.time = t; continue; }
    }
    let idx = -1;
    let value = null;
    for (let i = 0; i < ws.length; i++) {
      const v = readNumber(ws[i].text);
      if (v !== null) { idx = i; value = v; break; }
    }
    if (idx < 0) continue;
    if (/%/.test(ws[idx].text)) continue;
    const label = labelField(ws.slice(0, idx).map((w) => w.text).join(' '));
    const unit = unitOf(ws.slice(idx + 1).map((w) => w.text).join(''));
    rows.push({ value, unit: unit === '?' && idx === ws.length - 1 ? '' : unit, label, conf: ws[idx].conf ?? 0, y: line.y, y0: Math.min(...ws.map((w) => w.y0)) });
  }
  const fields = alignRows(rows, opts.capacity);
  const gaps = rows.slice(1).map((r, i) => r.y - rows[i].y).filter((g) => g > 0);
  return { ...out, ...fields, rows, figTop: rows.length ? rows[0].y0 : null, pitch: median(gaps) || null };
}

// Match the figures, top to bottom, to the fixed field order — a tiny sequence
// alignment scored by label, unit and plausible range, so a lost or extra line
// doesn't shift every field.
function alignRows(rows, capacity = 20000) {
  const n = rows.length;
  const m = FIELDS.length;
  const fit = (r, f) => {
    let s = 0;
    if (r.label) s += r.label === f ? 4 : -4;
    const want = UNIT_OF[f];
    if (r.unit === want) s += 2;
    else if (r.unit === '' || r.unit === '?') s += want === '' ? 1 : 0;
    else s -= 3;
    const v = r.value;
    if (f === 'capacity') s += Math.abs(v - capacity) <= capacity * 0.1 ? 2 : -1;
    if (f === 'temp') s += v >= -5 && v <= 60 ? 1 : -3;
    if (f === 'density' || f === 'densityTc') s += v >= 600 && v <= 1100 ? 1 : -3;
    if (f === 'height') s += v >= 0 && v <= 4000 ? 0 : -3;
    return s;
  };
  // dp[i][j]: best score using rows[0..i) and fields[0..j)
  const NEG = -1e9;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NEG));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const cur = dp[i][j];
      if (cur === NEG) continue;
      if (i < n && j < m) {
        const s = cur + fit(rows[i], FIELDS[j]);
        if (s > dp[i + 1][j + 1]) { dp[i + 1][j + 1] = s; back[i + 1][j + 1] = 'match'; }
      }
      if (j < m && cur - 1 > dp[i][j + 1]) { dp[i][j + 1] = cur - 1; back[i][j + 1] = 'skipField'; }
      if (i < n && cur - 3 > dp[i + 1][j]) { dp[i + 1][j] = cur - 3; back[i + 1][j] = 'skipRow'; }
    }
  }
  const got = {};
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const b = back[i][j];
    if (b === 'match') { got[FIELDS[j - 1]] = rows[i - 1].value; i -= 1; j -= 1; } else if (b === 'skipField') j -= 1;
    else i -= 1;
  }
  return got;
}

// ---------------------------------------------------------------------------
// Putting the passes together and checking the figures
// ---------------------------------------------------------------------------

function near(a, b, tol) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

function chartTol(v) {
  return Math.max(15, Math.abs(v) * 0.002);
}

// The volume every reading agrees on best: what the screen said, capacity −
// ullage, and the dip chart at the product height are three independent ways
// to get it.
export function settleReading(cands, { capacity, chart }) {
  const first = (k) => cands.map((c) => c[k]).find((v) => Number.isFinite(v));
  const all = (k) => [...new Set(cands.map((c) => c[k]).filter((v) => Number.isFinite(v)))];
  const vols = all('volume');
  const ulls = all('ullage');
  // The capacity on screen when it's the app's (or volume + ullage add up to
  // it — then the app's setting is what's off), else the app's.
  const caps = all('capacity');
  const cap = caps.find((c) => Math.abs(c - capacity) <= capacity * 0.05)
    ?? caps.find((c) => vols.some((v) => ulls.some((u) => near(v + u, c, 1.01))))
    ?? capacity;
  const heights = all('height');
  const chartVols = chart ? heights.map((h) => ({ h, v: litresAtDip(chart, h / 10) })).filter((x) => Number.isFinite(x.v)) : [];

  const options = new Map();
  const add = (v, src) => {
    if (!Number.isFinite(v) || v < 0 || v > cap * 1.2) return;
    const key = round2(v);
    const o = options.get(key) || { v: key, src: new Set() };
    o.src.add(src);
    options.set(key, o);
  };
  vols.forEach((v, i) => add(v, i === 0 && v === cands[0]?.volume ? 'screen' : 'screen2'));
  ulls.forEach((u) => add(round2(cap - u), 'ullage'));
  let best = null;
  for (const o of options.values()) {
    const sumOk = ulls.some((u) => near(o.v + u, cap, 1.01));
    const chartOk = chartVols.some((c) => near(c.v, o.v, chartTol(o.v)));
    const screen = o.src.has('screen') || o.src.has('screen2');
    const score = (screen ? 1 : 0) + (sumOk ? 1 : 0) + (chartOk ? 1 : 0) + (o.src.has('screen') ? 0.1 : 0);
    if (!best || score > best.score) best = { ...o, score, sumOk, chartOk, screen };
  }
  if (!best && chartVols.length) {
    best = { v: round2(chartVols[0].v), src: new Set(['chart']), score: 1, sumOk: false, chartOk: true, screen: false };
  }
  const reading = {
    capacity: cap,
    volume: best ? best.v : null,
    ullage: null,
    height: null,
    water: first('water') ?? null,
    density: pick(all('density'), (v) => v >= 600 && v <= 1100),
    densityTc: pick(all('densityTc'), (v) => v >= 600 && v <= 1100),
    temp: pick(all('temp'), (v) => v >= -5 && v <= 60),
  };
  const corrected = [];
  if (best) {
    const u = ulls.find((x) => near(best.v + x, cap, 1.01));
    reading.ullage = u ?? round2(cap - best.v);
    if (u === undefined && ulls.length) corrected.push('ullage');
    const h = chartVols.find((c) => near(c.v, best.v, chartTol(best.v)));
    reading.height = h ? h.h : (heights[0] ?? null);
    if (!best.screen || (Number.isFinite(cands[0]?.volume) && round2(cands[0].volume) !== best.v)) corrected.push('volume');
  }
  const chartAt = chart && Number.isFinite(reading.height) ? litresAtDip(chart, reading.height / 10) : null;
  const checks = {
    sum: best ? { ok: ulls.some((x) => near(best.v + x, cap, 1.01)), capacity: cap } : { ok: false },
    chart: Number.isFinite(chartAt) ? { ok: near(chartAt, reading.volume, chartTol(reading.volume)), litres: chartAt, diff: round2(reading.volume - chartAt) } : { ok: null },
    corrected,
  };
  let confidence = 'low';
  if (best && checks.sum.ok && checks.chart.ok) confidence = corrected.includes('volume') ? 'medium' : 'high';
  else if (best && (checks.sum.ok || checks.chart.ok) && best.screen) confidence = 'medium';
  return { reading, checks, confidence };
}

function pick(values, ok) {
  return values.find(ok) ?? null;
}

// The whole screenshot: {tanks: [{no, product, productText, reading, checks,
// confidence, time, status}], warnings}. `tanks` is the app's tank list.
export function parseAutomation(ocr, { tanks = [], chart = null, dateOrder = 'MDY', now = null } = {}) {
  const byNo = new Map();
  const warnings = [];
  const passes = (ocr?.passes || []).filter((p) => p.words?.length);
  passes.forEach((pass, pi) => {
    for (const card of splitCards(pass.words, ocr.width, ocr.height)) {
      const tank = tanks.find((t) => t.no === card.no);
      const got = readCard(card, { dateOrder, now, capacity: tank?.capacity || 20000 });
      const key = card.no ?? 'unknown';
      const e = byNo.get(key) || { no: card.no, productText: '', cands: [], time: null, status: null, region: null };
      if (card.productText && (!e.productText || pi === 0)) e.productText = card.productText;
      e.cands.push(got);
      e.time = e.time || got.time;
      e.status = e.status || got.status;
      // where the "Last Updated" line sits: two rows above the first figure
      // (the "Tank Status" row is in between), below the tank drawing
      if (!e.region && card.head && Number.isFinite(got.figTop) && got.pitch) {
        e.region = {
          x0: Math.max(0, card.left), x1: Math.min(ocr.width || Infinity, card.right),
          y0: Math.max(card.head.y1, got.figTop - 2.35 * got.pitch), y1: got.figTop - 1.35 * got.pitch,
        };
      }
      byNo.set(key, e);
    }
  });
  const out = [];
  for (const e of byNo.values()) {
    const tank = tanks.find((t) => t.no === e.no) || null;
    const { reading, checks, confidence } = settleReading(e.cands, { capacity: tank?.capacity || 20000, chart });
    if (!Number.isFinite(reading.volume)) continue;
    const product = productKey(e.productText);
    reading.readingAt = e.time;
    reading.status = e.status;
    const t = {
      no: e.no, tankId: tank?.id || null, productText: e.productText, product, reading, checks, confidence, region: e.region,
    };
    if (tank && product && product !== tank.product) {
      warnings.push(`The screenshot shows Tank ${e.no} as ${e.productText || product}, but the app has Tank ${e.no} as ${tank.product}. Check Settings.`);
    }
    if (!tank && e.no) warnings.push(`Tank ${e.no} is not one of the app's tanks.`);
    out.push(t);
  }
  out.sort((a, b) => (a.no ?? 99) - (b.no ?? 99));
  if (!out.length) warnings.push('Couldn\'t find a tank card in this picture. Use a screenshot of the automation\'s tank page, or type the stock.');
  return { tanks: out, warnings };
}
