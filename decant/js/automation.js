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
// densities the screen can show (kg/m³) — wide: a probe out of calibration
// shows 530 for XtraGreen or 1,036 for diesel, and it's what the screen says
const DENSITY = [400, 1200];
// an underground tank's temperature, °C ("3.00" is "31.00" misread)
const TEMP = [5, 55];
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
      // a photo's speck or the card's border glued on: "(Tank", "[Tank", "“Tank"
      const t = ws[i].text.replace(/^[^A-Za-z0-9]+/, '');
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

// The same heading read in more than one pass counts once. Read as two numbers
// in one place ("Tank 1" / "Tank 3"), it's the number read more often — on a
// tie, the one no other heading has.
function dedupeHeads(heads) {
  const groups = [];
  for (const h of heads) {
    const lh = h.y1 - h.y0 || 12;
    const g = groups.find((o) => Math.abs(o[0].x0 - h.x0) < 4 * lh && Math.abs(o[0].y0 - h.y0) < 2 * lh);
    if (g) g.push(h); else groups.push([h]);
  }
  // each place's numbers, most read first; null where two tie
  const tops = groups.map((g) => {
    const n = new Map();
    for (const h of g) n.set(h.no, (n.get(h.no) || 0) + 1);
    const most = Math.max(...n.values());
    return [...n.keys()].filter((no) => n.get(no) === most);
  });
  const taken = new Set(tops.filter((t) => t.length === 1).map((t) => t[0]));
  return groups.map((g, i) => {
    const no = tops[i].length === 1 ? tops[i][0] : (tops[i].find((x) => !taken.has(x)) ?? tops[i][0]);
    return g.find((h) => h.no === no);
  });
}

// Cards split by their headings. Cards side by side share a row (headings at
// about the same height); each card runs right to the next heading of its row
// and down to the next row of headings.
function headCards(heads, width, height) {
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
      cards.push({ no: h.no, productText: h.productText, head: h, left, right, top, bottom });
    });
  });
  return cards;
}

// The first word of each field's label ("Tank Status", "Product Volume", "Water
// Volume", "Ullage Space", "Density", "Temperature", "Last Updated") — even
// misread, as on a photo of the screen: they all start at a card's left edge.
const LABEL_START = /^(t[ae][nrm][kxi]?[a-z]?|tar[a-z]{0,2}|pro[dcu][a-z]*|wat[a-z]*|eater|[vw]ater|u[lri1|]{1,2}[a-z]*|dens[a-z]*|den|te[mnrp][a-z]*|[lt]ast[a-z]*)$/i;

// Left edges several rows share: [{x, n}] (n = rows), left to right.
function edges(ws, W) {
  if (!ws.length) return [];
  const xs = ws.map((w) => ({ x: w.x0, y: Math.round(yc(w) / Math.max(4, hgt(w))) })).sort((a, b) => a.x - b.x);
  const groups = [];
  for (const p of xs) {
    const g = groups[groups.length - 1];
    if (g && p.x - g.last <= Math.max(18, 0.03 * W)) { g.pts.push(p); g.last = p.x; } else groups.push({ pts: [p], last: p.x });
  }
  const cols = groups.map((g) => ({ x: median(g.pts.map((p) => p.x)), n: new Set(g.pts.map((p) => p.y)).size })).filter((c) => c.n >= 3);
  // cards are wide: two edges close together belong to one card
  return cols.reduce((out, c) => {
    const prev = out[out.length - 1];
    if (prev && c.x - prev.x < 0.12 * W) { if (c.n > prev.n) out[out.length - 1] = c; } else out.push(c);
    return out;
  }, []);
}

// Where the cards are across the picture. The figures (black, bold — they
// read best, even on a photo) start at the same x all down a card; the labels
// start further left, at the card's edge, but read worse (light grey). Each
// column of figures is a card; its left edge is where its labels start, or —
// labels unread — as far left of the figures as on the cards where both read.
// [{x (the card's left edge), n}], left to right.
export function findColumns(words, width) {
  const W = width || Math.max(1, ...words.map((w) => w.x1));
  const labels = edges(words.filter((w) => LABEL_START.test(String(w.text).replace(/[^A-Za-z|1]/g, '')) && w.x1 - w.x0 > 1.2 * hgt(w)), W);
  const figures = edges(words.filter((w) => readNumber(w.text) !== null), W);
  if (!figures.length) return labels;
  const spacing = figures.length > 1 ? median(figures.slice(1).map((c, i) => c.x - figures[i].x)) : W;
  const labelOf = (f) => labels.filter((l) => l.x < f.x && f.x - l.x < 0.5 * spacing).pop();
  const gaps = figures.map((f) => { const l = labelOf(f); return l ? f.x - l.x : null; }).filter((g) => g !== null);
  const lw = gaps.length ? median(gaps) : 0.26 * spacing;
  return figures.map((f) => ({ x: labelOf(f)?.x ?? Math.max(0, f.x - lw), n: f.n }));
}

// Product names written on a heading whose "Tank N" was lost ("…ank 1 : Motor
// Spirit" at the edge of a photo): [{product, x0, y0}]. `lists`: each pass's words.
function productHeads(lists) {
  const out = [];
  for (const line of lists.flatMap((ws) => groupLines(ws))) {
    const t = line.text;
    const m = /motor\s*spir|high\s*spe|speed\s*die|xtra\s*gr|xtragr/i.exec(t);
    if (!m) continue;
    const key = /motor/i.test(m[0]) ? 'MS' : /xtra/i.test(m[0]) ? 'XG' : 'HSD';
    // where the phrase starts on the line
    const w = line.words.find((x) => /motor|high|speed|xtra/i.test(x.text)) || line.words[0];
    out.push({ product: key, x0: w.x0, y0: w.y0 });
  }
  return out;
}

// Cards split by their label columns — for photos, where headings are often
// cut off or unreadable. Each card is numbered by its heading when one was
// read; else by a product only one tank holds; else counted on from a
// neighbour (the automation shows the tanks in order); else — with as many
// cards as the app has tanks — left to right. Otherwise unknown.
function columnCards(cols, heads, lists, width, tanks) {
  const n = cols.length;
  const spacing = n > 1 ? median(cols.slice(1).map((c, i) => c.x - cols[i].x)) : (width || 1000);
  const cards = cols.map((c, i) => {
    const left = i === 0 ? -Infinity : c.x - 0.03 * (c.x - cols[i - 1].x);
    const right = i + 1 < n ? cols[i + 1].x - 0.03 * (cols[i + 1].x - c.x) : Infinity;
    const head = heads.find((h) => h.x0 >= c.x - 0.25 * spacing && h.x0 < c.x + 0.5 * spacing) || null;
    return { no: head?.no ?? null, by: head ? 3 : 0, productText: head?.productText || '', head, left, right, top: -Infinity, bottom: Infinity };
  });
  // a product only one of the app's tanks holds
  for (const ph of productHeads(lists)) {
    const card = cards.find((c) => ph.x0 >= c.left && ph.x0 < c.right);
    if (!card || card.productText) continue;
    card.productText = { MS: 'Motor Spirit', HSD: 'High Speed Diesel', XG: 'XtraGreen' }[ph.product];
    const only = tanks.filter((t) => t.product === ph.product);
    if (card.no === null && only.length === 1) { card.no = only[0].no; card.by = 2; }
  }
  // counted on from a neighbour
  for (let pass = 0; pass < n; pass++) {
    cards.forEach((c, i) => {
      if (c.no !== null) return;
      const l = cards[i - 1];
      const r = cards[i + 1];
      if (l?.no) { c.no = l.no + 1; c.by = 1; } else if (r?.no > 1) { c.no = r.no - 1; c.by = 1; }
    });
  }
  if (cards.every((c) => c.no === null) && tanks.length && n === tanks.length) cards.forEach((c, i) => { c.no = tanks[i]?.no ?? i + 1; c.by = 1; });
  // two cards can't be the same tank: the better-founded number stays
  for (const c of cards) {
    if (c.no === null) continue;
    const rival = cards.find((o) => o !== c && o.no === c.no);
    if (rival) (rival.by > c.by ? c : rival.by < c.by ? rival : c).no = null;
  }
  return cards;
}

// Where each card is in the picture — worked out once from every pass's words
// (`lists`: one list of words per pass). Screenshots: by the "Tank N :"
// headings. Photos (headings cut off or lost): by the cards' columns.
export function cardLayout(lists, width, height, tanks = []) {
  const heads = dedupeHeads(lists.flatMap((ws) => findHeaders(ws)));
  const cols = findColumns(lists.flat(), width);
  if (heads.length && (cols.length <= heads.length || cols.length < 2)) return headCards(heads, width, height);
  if (cols.length) return columnCards(cols, heads, lists, width, tanks);
  return [{ no: null, productText: '', head: null, left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity }];
}

// One pass's words that belong to a card (not its heading line).
export function wordsIn(card, words) {
  const h = card.head;
  return words.filter((w) => xc(w) >= card.left && xc(w) < card.right && yc(w) >= card.top && yc(w) < card.bottom
    && !(h && yc(w) >= h.y0 - 2 && yc(w) <= h.y1 + 2 && w.x0 >= h.x0 - 2));
}

// A figure as the automation prints it ("12,019.45", "0.00", "1,036.00"),
// allowing the usual misreads ($ for 8, O for 0, l for 1, S for 5).
export function readNumber(token) {
  let t = String(token || '').replace(/^[^0-9A-Za-z$£]+|[^0-9A-Za-z]+$/g, '');
  if (!t || !/\d/.test(t)) return null;
  const digits = t.replace(/[^0-9]/g, '').length;
  if (digits < t.replace(/[,.]/g, '').length * 0.6) return null;
  t = t.replace(/[Oo]/g, '0').replace(/[lI|!]/g, '1').replace(/[Ss]/g, '5').replace(/[$£B]/g, '8').replace(/(\d)%(?=[\d.,])/g, '$19');
  // a photo's speck after the last digit ("368.068"): the screen always shows two decimals
  if (/^\d{1,3}(,\d{3})*\.\d{3}$|^\d+\.\d{3}$/.test(t)) t = t.slice(0, -1);
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
  // "09282026": a photo's date with its slashes lost
  const nums = (String(text || '').match(/\d+/g) || []).flatMap((n) => (/^\d{4}20\d\d$/.test(n) ? [n.slice(0, 2), n.slice(2, 4), n.slice(4)] : [n]));
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
  // a year far from when the picture was taken is a misread ("09262004")
  if (now && (y < new Date(now).getUTCFullYear() - 10 || y > new Date(now).getUTCFullYear() + 1)) return null;
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

// Just the clock of a "Last Updated" line whose date didn't read ("… ON79202€
// 06 18 26" on a photo): the reading is from the day the picture was taken
// (`now`), or the day before if that puts it over an hour after the picture
// (an hour: the automation's clock may run a little ahead of the phone's).
export function readClock(text, now) {
  const m = /(?:^|\D)(\d\d)\D{1,3}(\d\d)\D{1,3}(\d\d)\D*$/.exec(String(text || ''));
  if (!m || !Number.isFinite(now)) return null;
  const [hh, mm, ss] = m.slice(1).map(Number);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const on = (t) => { const d = new Date(t + 330 * 60000); return istISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm, ss); };
  const iso = on(now);
  return Date.parse(iso) > now + 3600000 ? on(now - 86400000) : iso;
}

// One card's lines -> raw fields, by label where one is readable and otherwise
// by position (the card always lists the fields in the same order).
export function readCard(card, opts = {}) {
  const lines = groupLines(card.words);
  const out = { time: null, clock: null, status: null };
  const rows = [];
  for (const line of lines) {
    const ws = line.words;
    const st = statusOf(line.text);
    if (st) out.status = st;
    if (!out.time && (/updat|last/i.test(line.text) || /\d{1,2}\D\d{1,2}\D20\d\d/.test(line.text))) {
      const t = readTime(line.text, opts.dateOrder, opts.now);
      if (t) { out.time = t; continue; }
      const c = /updat|last/i.test(line.text) ? readClock(line.text, opts.now) : null;
      if (c) { out.clock ||= c; continue; }
    }
    let idx = -1;
    let value = null;
    let span = 1;
    for (let i = 0; i < ws.length; i++) {
      const nx = ws[i + 1];
      const close = nx && nx.x0 - ws[i].x1 < 0.8 * hgt(ws[i]);
      let v = null;
      // "20.000 00", "18.488 93": a blurred photo's thousands comma read as a
      // point and the decimal point as a gap (not "20.00" with a speck)
      if (close && /^\d{1,3}\.\d{3}$/.test(ws[i].text) && /^\d{2}$/.test(nx.text)) {
        v = readNumber(`${ws[i].text.replace('.', ',')}.${nx.text}`);
        if (v !== null) span = 2;
      }
      if (v === null) v = readNumber(ws[i].text);
      // "2546 04", "809 30": the decimal point read as a gap (a photo)
      if (v === null && close && /^(\d{3,}|\d{1,3}(,\d{3})+)$/.test(ws[i].text) && /^\d{2}$/.test(nx.text)) {
        v = readNumber(`${ws[i].text}.${nx.text}`);
        if (v !== null) span = 2;
      }
      if (v !== null) { idx = i; value = v; break; }
    }
    if (idx < 0) continue;
    if (/%\s*$/.test(ws[idx].text)) continue;              // the tank drawing's "75%"
    const label = labelField(ws.slice(0, idx).map((w) => w.text).join(' '));
    const unit = unitOf(ws.slice(idx + span).map((w) => w.text).join(''));
    rows.push({ value, unit: unit === '?' && idx === ws.length - 1 ? '' : unit, label, conf: ws[idx].conf ?? 0, y: line.y, y0: Math.min(...ws.map((w) => w.y0)), y1: Math.max(...ws.map((w) => w.y1)) });
  }
  const fields = alignRows(rows, opts.capacity);
  const gaps = rows.slice(1).map((r, i) => r.y - rows[i].y).filter((g) => g > 0);
  return { ...out, ...fields, rows, figTop: rows.length ? rows[0].y0 : null, figBottom: rows.length ? Math.max(...rows.map((r) => r.y1)) : null, pitch: median(gaps) || null };
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
    if (f === 'volume' || f === 'ullage') s += Math.abs(v - capacity) < 1 ? -2 : 0;   // that's the capacity row
    if (f === 'water') s += v < 1000 ? 1 : -4;                                         // water is a few litres at most
    if (f === 'temp') s += v >= TEMP[0] && v <= TEMP[1] ? 1 : -3;
    if (f === 'density' || f === 'densityTc') s += v >= DENSITY[0] && v <= DENSITY[1] ? 1 : -3;
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
    const o = options.get(key) || { v: key, src: new Set(), votes: 0 };
    o.src.add(src);
    o.votes += 1;                                         // how many readings back it
    options.set(key, o);
  };
  cands.forEach((c, i) => {
    if (Number.isFinite(c.volume)) add(c.volume, i === 0 ? 'screen' : 'screen2');
    if (Number.isFinite(c.ullage)) add(round2(cap - c.ullage), 'ullage');
  });
  let best = null;
  for (const o of options.values()) {
    const sumOk = ulls.some((u) => near(o.v + u, cap, 1.01));
    const dist = Math.min(Infinity, ...chartVols.map((c) => Math.abs(c.v - o.v)));
    const chartOk = dist <= chartTol(o.v);
    const screen = o.src.has('screen') || o.src.has('screen2');
    // the dip chart matches the automation's own figure to a litre or two
    // (it's the same tank chart), so a figure that close is all but certain;
    // between figures that close, a volume read that adds up to the capacity
    // with an ullage read, to the last digit, settles it (the screen's two do)
    const exact = screen && o.src.has('ullage');
    const score = (screen ? 1 : 0) + (sumOk ? 1 : 0) + (dist <= 2.5 ? 1.5 - 0.05 * dist : chartOk ? 1 : 0) + (exact ? 0.2 : 0) + 0.05 * o.votes + (o.src.has('screen') ? 0.01 : 0);
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
    density: pick(all('density'), (v) => v >= DENSITY[0] && v <= DENSITY[1]),
    densityTc: pick(all('densityTc'), (v) => v >= DENSITY[0] && v <= DENSITY[1]),
    temp: pick(all('temp'), (v) => v >= TEMP[0] && v <= TEMP[1]),
  };
  const corrected = [];
  if (best) {
    // the ullage read that adds up most exactly (a 0.8 L misread is within the tolerance too)
    const u = ulls.filter((x) => near(best.v + x, cap, 1.01)).sort((a, b) => Math.abs(best.v + a - cap) - Math.abs(best.v + b - cap))[0];
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
  // a figure only the dip chart backs, while another height read on the card
  // points elsewhere: the rows may have slipped (a blurred photo's "20.000"
  // taken for the volume and "18.488" for the height agree with the chart too)
  const disputed = !checks.sum.ok && chartVols.some((c) => !near(c.v, reading.volume, chartTol(reading.volume)) && c.v > 2 * Math.max(reading.volume, 100));
  let confidence = 'low';
  if (best && checks.sum.ok && checks.chart.ok) confidence = corrected.includes('volume') ? 'medium' : 'high';
  else if (best && (checks.sum.ok || checks.chart.ok) && best.screen && !disputed) confidence = 'medium';
  return { reading, checks, confidence };
}

function pick(values, ok) {
  return values.find(ok) ?? null;
}

// How much a reading of a card's time counts: read with its date by the whole
// picture's pass, by its line alone, by the card's closer look — or just its
// clock (dated the day the picture was taken).
const TIME_WEIGHT = { screen: 1.2, line: 1.1, zoom: 1, clock: 0.8 };

// Each card's time from all its readings — cards: one list per card of
// [{at, kind, src}] (src: which read it came from); now: when the picture was
// taken. The same read cleaned up several ways counts once (a misread repeats
// itself). The tanks on one screen are updated together, seconds apart, so a
// time within 5 minutes of another card's reading counts 1 more for each such
// card; a stuck probe's own time still stands, as nothing on its card
// contradicts it.
// -> one {at, kind} (or null) per card.
export function pickTimes(cards, now = null) {
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 5 * 60000;
  const picked = cards.map((reads, i) => {
    const byAt = new Map();
    for (const r of reads) {
      const w = TIME_WEIGHT[r.kind];
      const o = byAt.get(r.at) || { at: r.at, kind: r.kind, w, src: new Map() };
      o.src.set(r.src, Math.max(o.src.get(r.src) || 0, w));
      if (w > o.w) Object.assign(o, { kind: r.kind, w });
      byAt.set(r.at, o);
    }
    let best = null;
    for (const o of byAt.values()) {
      const others = cards.filter((c, j) => j !== i && c.some((r) => near(r.at, o.at))).length;
      const score = [...o.src.values()].reduce((a, w) => a + w, 0) + others;
      if (!best || score > best.score + 1e-9 || (score > best.score - 1e-9 && o.w > best.w)) best = { ...o, score };
    }
    return best && { at: best.at, kind: best.kind };
  });
  // A clock that matches other cards' on a date that doesn't ("09262024" for
  // 09/26/2026, or a clock alone dated the photo's day): the date most of those
  // cards have — nearest the picture's time on a tie.
  return picked.map((p, i) => {
    if (!p) return p;
    const votes = new Map([[p.at.slice(0, 10), 1]]);
    picked.forEach((o, j) => {
      if (j === i || !o) return;
      // agreeing as they are (either side of midnight too), or on the other's date
      const own = p.at.slice(0, 10);
      const theirs = o.at.slice(0, 10);
      const day = near(p.at, o.at) ? own : near(theirs + p.at.slice(10), o.at) ? theirs : null;
      if (day) votes.set(day, (votes.get(day) || 0) + 1);
    });
    const off = (day) => (Number.isFinite(now) ? Math.abs(Date.parse(day + p.at.slice(10)) - now) : 0);
    const day = [...votes.entries()].sort((a, b) => b[1] - a[1] || off(a[0]) - off(b[0]))[0][0];
    return { ...p, at: day + p.at.slice(10) };
  });
}

// The whole screenshot: {tanks: [{no, product, productText, reading, checks,
// confidence, timeFrom, status}], warnings}. `tanks` is the app's tank list.
//   ocr.zoom (optional): closer readings of single cards — [{card, words}], the
//   card's index in the layout and its words in the zoomed picture's pixels.
//   ocr.lines (optional): cards' "Last Updated" lines read on their own —
//   [{card, text}].
//   ocr.heads (optional): the headings of cards found without one, read on
//   their own — [{card, words}], the words in the picture's pixels.
export function parseAutomation(ocr, { tanks = [], chart = null, dateOrder = 'MDY', now = null } = {}) {
  const byNo = new Map();
  const warnings = [];
  const passes = (ocr?.passes || []).filter((p) => p.words?.length);
  const layout = cardLayout(passes.map((p) => p.words), ocr?.width, ocr?.height, tanks);
  // a card left without a number: its heading, read on its own (ocr.heads)
  for (const hb of ocr?.heads || []) {
    const frame = layout[hb.card];
    if (!frame || frame.no !== null) continue;
    const head = findHeaders(hb.words || []).find((h) => !layout.some((c) => c.no === h.no));
    if (head) Object.assign(frame, { no: head.no, by: 3, productText: frame.productText || head.productText });
  }
  const entry = (frame, ci) => {
    const key = frame.no ?? `?${ci}`;
    if (!byNo.has(key)) byNo.set(key, { no: frame.no, productText: frame.productText || '', cands: [], times: [], status: null, region: null, frame: null });
    return byNo.get(key);
  };
  // got: a card's reading; kind: 'screen' (a whole-picture pass) or 'zoom'
  const take = (e, got, kind, src) => {
    e.cands.push(got);
    if (got.time) e.times.push({ at: got.time, kind, src });
    if (got.clock) e.times.push({ at: got.clock, kind: 'clock', src });
    e.status = e.status || got.status;
  };
  passes.forEach((pass) => {
    layout.forEach((frame, ci) => {
      const card = { ...frame, words: wordsIn(frame, pass.words) };
      if (!card.words.length) return;
      const tank = tanks.find((t) => t.no === card.no);
      const got = readCard(card, { dateOrder, now, capacity: tank?.capacity || 20000 });
      if (!got.rows.length && !got.time && !got.clock) return;
      const e = entry(frame, ci);
      take(e, got, 'screen', pass.mode);
      // where the "Last Updated" line sits: two rows above the first figure
      // (the "Tank Status" row is in between), below the tank drawing
      if (!e.region && Number.isFinite(got.figTop) && got.pitch) {
        e.region = {
          ci, x0: Math.max(0, card.left), x1: Math.min(ocr.width || Infinity, card.right),
          y0: Math.max(card.head ? card.head.y1 : 0, got.figTop - 2.35 * got.pitch), y1: got.figTop - 1.35 * got.pitch,
        };
      }
      // the card in the picture, for a closer look (ocr.js): its figures' rows,
      // from the highest any pass read to the lowest
      if (Number.isFinite(got.figTop) && got.pitch) {
        const f = e.frame;
        e.frame = {
          ci, x0: Math.max(0, card.left), x1: Math.min(ocr.width || Infinity, card.right),
          figTop: Math.min(f?.figTop ?? Infinity, got.figTop), figBottom: Math.max(f?.figBottom ?? -Infinity, got.figBottom), pitch: f?.pitch || got.pitch,
        };
      }
    });
  });
  for (const z of ocr?.zoom || []) {
    const frame = layout[z.card];
    if (!frame || !z.words?.length) continue;
    const tank = tanks.find((t) => t.no === frame.no);
    const got = readCard({ ...frame, words: z.words }, { dateOrder, now, capacity: tank?.capacity || 20000 });
    if (got.rows.length || got.time || got.clock) take(entry(frame, z.card), got, 'zoom', `zoom ${z.how}`);
  }
  for (const l of ocr?.lines || []) {
    const frame = layout[l.card];
    if (!frame || !l.text) continue;
    const at = readTime(l.text, dateOrder, now);
    const clock = at ? null : readClock(l.text, now);
    // the line's clean-ups read the same crop: one source
    if (at || clock) entry(frame, l.card).times.push({ at: at || clock, kind: at ? 'line' : 'clock', src: 'line' });
  }
  const entries = [...byNo.values()];
  const times = pickTimes(entries.map((e) => e.times), now);
  const out = [];
  for (const [i, e] of entries.entries()) {
    const tank = tanks.find((t) => t.no === e.no) || null;
    const { reading, checks, confidence } = settleReading(e.cands, { capacity: tank?.capacity || 20000, chart });
    if (!Number.isFinite(reading.volume)) continue;
    const product = productKey(e.productText);
    reading.readingAt = times[i]?.at ?? null;
    reading.status = e.status;
    const timeFrom = times[i]?.kind ?? null;              // how the time was read (ocr.js looks closer unless 'screen')
    const t = {
      no: e.no, tankId: tank?.id || null, productText: e.productText, product, reading, checks, confidence, timeFrom, region: e.region, frame: e.frame,
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
