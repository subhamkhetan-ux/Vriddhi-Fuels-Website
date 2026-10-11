// The pictures the fleet screens share, in the app's own look (dark glass,
// orange light, Sora), like the Ledger app's: Shree Shyam Logistics' logo and
// name on top, the figure that matters as a big orange hero, tiles, then
// every row — as many A4-shaped pages as it needs (or one card).
//   ssfcPagesSvg()     — the SSFC account: what SSFC owes, invoices cleared
//                        oldest first, month by month, every payment
//   vehiclePagesSvg()  — a vehicle's statement for a period: every trip with
//                        its freight, SSFC deductions, own costs and income
//   reconPagesSvg()    — a vehicle's diesel recon, trip by trip
//   tripCardSvg()      — one trip: the bulker, dates, weights, money, diesel
//   driverPagesSvg()   — a driver's spell on a truck: trips, salary, advances
//   fleetPagesSvg()    — the fleet for a period: by vehicle, route and month
//   roadCardSvg()      — on the road now, every vehicle
// Pure: SVG strings in, images as data: URLs and fonts as @font-face CSS
// passed in. app.js turns them into JPEGs (and a PDF) to share.

import { costBreakdown, dieselAmount, dieselLitres, ownExpenses, routeOf, ssfcDeductions, totals, tripDays } from './analyse.js';
import { plateText, RTO_GROSS } from './bulker.js';

export const PAGE = { width: 1280, height: 1810 };                 // px; A4's shape
export const PAGE_PT = { width: 595.28, height: 841.89 };
export const CARD_WIDTH = 1080;

const C = {
  bg: '#0b0807', ink: '#f5f0eb', muted: '#b4aba2', faint: '#7c746c', good: '#2fd08a', bad: '#ff6b5e', warn: '#ffb23e',
  amber: '#ff9e42', s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500', s5: '#d55181', s6: '#9085e9', s7: '#e66767', s8: '#008300',
};
const LOAD_COLOR = { top: C.good, ok: C.ink, low: C.warn, poor: C.bad };
const loadNote = (b) => (!b ? '' : b.grade === 'top' ? '★ full load' : `−${b.gapNear.toFixed(2)} T vs best`);
const SERIES = [C.s1, C.s2, C.s3, C.s4, C.s5, C.s6, C.s7, C.s8, C.faint];
const SANS = 'Sora, "Noto Sans Devanagari", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULLMON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;
const sum = (xs, f) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- numbers and dates ----------------------------------------------------------------
const ind = (n, d = 0) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
export function rupees(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const a = Math.abs(v);
  return `${v < 0 ? '−' : ''}₹${ind(a, a < 1000 && a % 1 ? 2 : 0)}`;
}
const signedRupees = (n) => `${n > 0.5 ? '+' : ''}${rupees(n)}`;
const litres = (n) => `${ind(n, Math.abs(n) < 100 && n % 1 ? 1 : 0)} L`;
const signedLitres = (n) => `${n > 0.05 ? '+' : n < -0.05 ? '−' : ''}${ind(Math.abs(n), Math.abs(n) < 100 && n % 1 ? 1 : 0)} L`;
const tonnes = (n, d = 2) => `${ind(n, d)} T`;
export const dMon = (iso) => (iso ? `${iso.slice(8, 10)} ${MON[Number(iso.slice(5, 7)) - 1]}` : '');
export const dMonY = (iso) => (iso ? `${dMon(iso)} ${iso.slice(0, 4)}` : '');
const monY = (ym) => (ym ? `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : '');
const monthLong = (ym) => (ym ? `${FULLMON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : '');
const shortVeh = (v) => String(v || '').slice(-4);

// ---- text that fits (a cautious estimate of Sora's widths) -------------------------------
export function textWidth(text, size, weight = 400) {
  let w = 0;
  for (const ch of String(text)) {
    if (/[\u0900-\u0903\u093a-\u094f\u0951-\u0957\u0962\u0963]/.test(ch)) w += 0.06;      // Devanagari vowel signs: no width of their own
    else if (/[\u0900-\u097f]/.test(ch)) w += 0.66;
    else if (ch === ' ') w += 0.28;
    else if (/[0-9]/.test(ch)) w += 0.62;
    else if (/[A-Z]/.test(ch)) w += 0.7;
    else if (/[a-z]/.test(ch)) w += 0.57;
    else if (/[.,:;'|!]/.test(ch)) w += 0.3;
    else w += 0.62;
  }
  return w * size * (weight >= 700 ? 1.07 : weight >= 600 ? 1.04 : 1);
}
// words into lines no wider than max
export function wrap(text, max, size, weight = 400) {
  const lines = [];
  let cur = '';
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && textWidth(next, size, weight) > max) { lines.push(cur); cur = word; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
export function fit(text, max, size, weight = 400) {
  const s = String(text ?? '');
  if (textWidth(s, size, weight) <= max) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}…`, size, weight) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

const T = (x, y, text, { size = 20, weight = 400, fill = C.ink, anchor = 'start', opacity, spacing, max } = {}) => {
  if (text == null || text === '') return '';
  const s = max ? fit(text, max, size, weight) : String(text);
  return `<text x="${r1(x)}" y="${r1(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${opacity != null ? ` fill-opacity="${opacity}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(s)}</text>`;
};
const R = (x, y, w, h, { rx = 0, fill = '#fff', opacity, stroke, strokeOpacity } = {}) => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(0, w))}" height="${r1(Math.max(0, h))}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"${opacity != null ? ` fill-opacity="${opacity}"` : ''}${stroke ? ` stroke="${stroke}" stroke-opacity="${strokeOpacity ?? 1}" stroke-width="1.5"` : ''}/>`;

function defs(fontCss = '', extraCss = '') {
  return `<defs>
<style>${fontCss || ''} text { font-family: ${SANS}; font-variant-numeric: tabular-nums; } ${extraCss || ''}</style>
<linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4511e"/><stop offset=".55" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ff9e42"/></linearGradient>
<radialGradient id="g1" cx=".85" cy="0" r=".65"><stop offset="0" stop-color="#f4511e" stop-opacity=".34"/><stop offset="1" stop-color="#f4511e" stop-opacity="0"/></radialGradient>
<radialGradient id="g2" cx="0" cy=".06" r=".55"><stop offset="0" stop-color="#ff9e42" stop-opacity=".15"/><stop offset="1" stop-color="#ff9e42" stop-opacity="0"/></radialGradient>
<radialGradient id="g3" cx=".5" cy="1.04" r=".6"><stop offset="0" stop-color="#2b4fb0" stop-opacity=".2"/><stop offset="1" stop-color="#2b4fb0" stop-opacity="0"/></radialGradient>
<radialGradient id="shine" cx=".92" cy="0" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>`;
}
const backdrop = (w, h) => `${R(0, 0, w, h, { fill: C.bg })}${R(0, 0, w, Math.min(h, 1400), { fill: 'url(#g1)' })}${R(0, 0, w, Math.min(h, 1200), { fill: 'url(#g2)' })}${R(0, Math.max(0, h - 1100), w, Math.min(h, 1100), { fill: 'url(#g3)' })}`;

// ---- brand ---------------------------------------------------------------------------------
// the logo mark and the wordmark (light letters), else the name in type
function brandRow(w, pad, y, what, asOn, images) {
  const mark = images.mark ? `<image href="${esc(images.mark)}" x="${pad}" y="${y}" width="86" height="92" preserveAspectRatio="xMidYMid meet"/>` : `${R(pad, y, 86, 92, { rx: 20, fill: 'url(#brand)' })}${T(pad + 43, y + 60, 'S', { size: 44, weight: 800, anchor: 'middle' })}`;
  const word = images.word
    ? `<image href="${esc(images.word)}" x="${pad + 104}" y="${y + 6}" width="${r1(46 * 886 / 228)}" height="46" preserveAspectRatio="xMinYMid meet"/>`
    : T(pad + 104, y + 42, 'SHREE SHYAM LOGISTICS', { size: 30, weight: 800, spacing: 1.2 });
  return `${mark}${word}
${T(pad + 104, y + 82, what, { size: 20, fill: C.muted, max: w - 2 * pad - 104 - 230 })}
${asOn ? `${T(w - pad, y + 36, 'AS ON', { size: 15, weight: 700, fill: C.faint, anchor: 'end', spacing: 2 })}${T(w - pad, y + 72, dMonY(asOn), { size: 24, weight: 700, anchor: 'end' })}` : ''}
${R(pad, y + 120, w - 2 * pad, 1.5, { opacity: 0.1 })}`;
}
function pill(x, y, text, color) {
  const w = textWidth(text, 15, 700) + 30;
  return `${R(x, y, w, 32, { rx: 16, fill: color, opacity: 0.16, stroke: color, strokeOpacity: 0.5 })}${T(x + w / 2, y + 22, text, { size: 15, weight: 700, fill: color, anchor: 'middle', spacing: 1.5 })}`;
}
function hero(x, y, w, h, label, amount, right = []) {
  let out = `${R(x, y, w, h, { rx: 30, fill: 'url(#brand)' })}${R(x, y, w, h, { rx: 30, fill: 'url(#shine)' })}
${T(x + 40, y + 56, label, { size: 19, weight: 700, fill: '#fff', opacity: 0.86, spacing: 2, max: w * 0.55 })}
${T(x + 40, y + h - 46, amount, { size: 74, weight: 800, fill: '#fff', spacing: -1.5 })}`;
  right.forEach(([lbl, val], i) => {
    const yy = y + 56 + i * 64;
    out += `${T(x + w - 40, yy, lbl, { size: 16, weight: 700, fill: '#fff', opacity: 0.78, anchor: 'end', spacing: 1.5 })}${T(x + w - 40, yy + 32, val, { size: 25, weight: 700, fill: '#fff', anchor: 'end', max: w * 0.4 })}`;
  });
  return out;
}
function tiles(x, y, w, list) {
  const gap = 16;
  const tw = (w - gap * (list.length - 1)) / list.length;
  const vs = list.length > 4 ? 26 : 31;
  return list.map((t, i) => {
    const tx = x + i * (tw + gap);
    return `${R(tx, y, tw, 132, { rx: 22, opacity: 0.05, stroke: '#fff', strokeOpacity: 0.1 })}${R(tx, y + 22, 5, 88, { rx: 2.5, fill: t.color || 'url(#brand)' })}
${T(tx + 24, y + 40, String(t.label).toUpperCase(), { size: 14, weight: 700, fill: C.muted, spacing: 1.2, max: tw - 36 })}
${T(tx + 24, y + 84, t.value, { size: vs, weight: 800, max: tw - 36, fill: t.valueColor || C.ink })}
${T(tx + 24, y + 113, t.sub || '', { size: 15, fill: C.muted, max: tw - 36 })}`;
  }).join('');
}

// ---- blocks: what a page is made of ---------------------------------------------------------
// { h, draw(x, y, w) → svg, keep: keep with the next block, under: the table head it belongs to }
const block = (h, draw, extra = {}) => ({ h, draw, ...extra });

function section(title, right = '', rightColor = C.amber) {
  return block(70, (x, y, w) => `${T(x, y + 36, title.toUpperCase(), { size: 16, weight: 700, fill: C.muted, spacing: 2, max: w * 0.55 })}
${T(x + w, y + 36, right, { size: 17, weight: 700, anchor: 'end', fill: rightColor, max: w * 0.45 })}${R(x, y + 52, w, 1.5, { opacity: 0.1 })}`, { keep: true });
}
function band(title, right = '') {
  return block(56, (x, y, w) => `${R(x, y + 8, w, 42, { rx: 14, fill: 'url(#brand)', opacity: 0.13 })}
${T(x + 18, y + 36, title.toUpperCase(), { size: 17, weight: 800, fill: C.amber, spacing: 2 })}
${T(x + w - 18, y + 36, right, { size: 15, fill: C.muted, anchor: 'end', max: w * 0.66 })}`, { keep: true });
}
function note(text, color = C.muted, size = 16) {
  return block(36, (x, y, w) => T(x + 4, y + 24, text, { size, fill: color, max: w - 8 }));
}
const gap = (h = 18) => block(h, () => '');

// a table: cols [{ label, at, align: 'end' | 'start', max }]: at < 0 = from the right edge
function colX(c, x, w) { return c.at < 0 ? x + w + c.at : x + c.at; }
function table(cols, rows, { total = null, zebra = true } = {}) {
  const head = block(50, (x, y, w) => `${R(x, y, w, 46, { rx: 14, opacity: 0.07 })}${cols.map((c) => T(colX(c, x, w), y + 30, c.label.toUpperCase(), { size: 13, weight: 700, fill: C.muted, anchor: c.align === 'end' ? 'end' : 'start', spacing: 1.3 })).join('')}`, { keep: true, isHead: true });
  const cell = (c, v, x, y, w, sub) => {
    if (v == null || v === '') return '';
    const o = typeof v === 'object' ? v : { text: v };
    const ax = colX(c, x, w);
    const anchor = c.align === 'end' ? 'end' : 'start';
    return `${o.dot ? `<circle cx="${ax - 14}" cy="${y + 24}" r="6" fill="${o.dot}"/>` : ''}${T(ax, y + (sub ? 30 : 33), o.text, { size: o.size || 18, weight: o.weight || 600, fill: o.color || C.ink, anchor, max: c.max })}
${o.sub ? T(ax, y + 54, o.sub, { size: 14, fill: o.subColor || C.muted, anchor, max: c.max }) : ''}`;
  };
  const out = [head];
  rows.forEach((r, i) => {
    if (r.band) { out.push(band(r.band, r.right || '')); return; }
    const sub = r.cells.some((v) => v && typeof v === 'object' && v.sub);
    const h = sub ? 66 : 50;
    out.push(block(h, (x, y, w) => `${zebra && i % 2 ? R(x, y + 2, w, h - 4, { rx: 12, opacity: 0.03 }) : ''}${r.tint ? R(x, y + 2, w, h - 4, { rx: 12, fill: r.tint, opacity: 0.08 }) : ''}${cols.map((c, k) => cell(c, r.cells[k], x, y, w, sub)).join('')}`, { under: head }));
  });
  if (total) {
    out.push(block(76, (x, y, w) => `${R(x, y + 6, w, 66, { rx: 16, opacity: 0.07, stroke: '#fff', strokeOpacity: 0.14 })}${cols.map((c, k) => {
      const v = total[k];
      if (v == null || v === '') return '';
      const o = typeof v === 'object' ? v : { text: v };
      return T(colX(c, x, w), y + 48, o.text, { size: o.size || 19, weight: 800, fill: o.color || C.ink, anchor: c.align === 'end' ? 'end' : 'start', max: c.max });
    }).join('')}`, { under: head }));
  }
  return out;
}

// key → value lines in a glass box
function facts(list, { title = '' } = {}) {
  const rows = list.filter(Boolean);
  const th = title ? 48 : 0;
  const h = th + rows.length * 52 + 22;
  return block(h + 18, (x, y, w) => {
    let out = R(x, y, w, h, { rx: 22, opacity: 0.05, stroke: '#fff', strokeOpacity: 0.1 });
    if (title) out += T(x + 28, y + 38, title.toUpperCase(), { size: 15, weight: 700, fill: C.muted, spacing: 1.8 });
    rows.forEach((r, i) => {
      const [k, v, o = {}] = r;
      const yy = y + th + 44 + i * 52;
      out += `${T(x + 28 + (o.indent || 0), yy, k, { size: o.size || 18, fill: o.strong ? C.ink : C.muted, weight: o.strong ? 700 : 400, max: w * 0.5 })}${T(x + w - 28, yy, v, { size: o.size ? o.size + 2 : 20, weight: o.strong ? 800 : 700, anchor: 'end', fill: o.color || C.ink, max: w * 0.46 })}`;
      if (o.rule) out += R(x + 28, yy - 34, w - 56, 1.5, { opacity: 0.12 });
    });
    return out;
  });
}

// where the freight went: one bar, and the parts with their share
function splitBar(parts, total, title = 'Where the freight went') {
  const list = parts.filter((p) => p.amount > 0.5);
  const lines = Math.ceil(list.length / 3);
  return block(130 + lines * 34, (x, y, w) => {
    let out = T(x, y + 30, title.toUpperCase(), { size: 16, weight: 700, fill: C.muted, spacing: 2 });
    out += T(x + w, y + 30, `freight ${rupees(total)}`, { size: 17, weight: 700, anchor: 'end', fill: C.amber });
    let cx = x;
    const by = y + 50;
    const tot = list.reduce((a, p) => a + p.amount, 0) || 1;
    out += `<clipPath id="sb${Math.round(y)}"><rect x="${x}" y="${by}" width="${w}" height="34" rx="12"/></clipPath><g clip-path="url(#sb${Math.round(y)})">`;
    list.forEach((p) => {
      const pw = (p.amount / tot) * w;
      out += R(cx, by, pw + 0.5, 34, { fill: p.color });
      if (pw > 64) out += T(cx + pw / 2, by + 23, `${Math.round((p.amount / total) * 100)}%`, { size: 15, weight: 700, fill: '#fff', anchor: 'middle' });
      cx += pw;
    });
    out += '</g>';
    list.forEach((p, i) => {
      const lx = x + (i % 3) * (w / 3);
      const ly = by + 70 + Math.floor(i / 3) * 34;
      out += `<circle cx="${lx + 7}" cy="${ly - 6}" r="7" fill="${p.color}"/>${T(lx + 22, ly, `${p.name} ${rupees(p.amount)} · ${Math.round((p.amount / (total || 1)) * 100)}%`, { size: 15, fill: C.ink, max: w / 3 - 30 })}`;
    });
    return out;
  });
}

// ---- pages and cards ----------------------------------------------------------------------
// spec: { what, tag, name, sub, asOn, hero: { label, amount, right }, tiles, blocks,
//         footNote, images, fontCss, extraCss }
function firstHead(spec, w) {
  const pad = 56;
  let y = 48;
  let out = brandRow(w, pad, y, spec.what, spec.asOn, spec.images || {});
  y += 160;
  if (spec.tag) out += pill(pad, y, spec.tag, spec.tagColor || C.amber);
  out += T(pad, y + 86, spec.name, { size: 46, weight: 800, max: w - 2 * pad, spacing: -0.5 });
  if (spec.sub) out += T(pad, y + 126, spec.sub, { size: 20, fill: C.muted, max: w - 2 * pad });
  y += spec.sub ? 158 : 118;
  if (spec.hero) {
    const hh = spec.hero.right && spec.hero.right.length > 2 ? 230 : 186;
    out += hero(pad, y, w - 2 * pad, hh, spec.hero.label, spec.hero.amount, spec.hero.right || []);
    y += hh + 24;
  }
  if (spec.tiles && spec.tiles.length) {
    out += tiles(pad, y, w - 2 * pad, spec.tiles);
    y += 156;
  }
  return { svg: out, y };
}
function laterHead(spec, w, pageNo, pages) {
  const pad = 56;
  const y = 48;
  const images = spec.images || {};
  let out = images.mark ? `<image href="${esc(images.mark)}" x="${pad}" y="${y}" width="56" height="60" preserveAspectRatio="xMidYMid meet"/>` : R(pad, y, 56, 60, { rx: 14, fill: 'url(#brand)' });
  out += T(pad + 76, y + 28, spec.name, { size: 26, weight: 800, max: w - 2 * pad - 400 });
  out += T(pad + 76, y + 56, spec.what, { size: 17, fill: C.muted, max: w - 2 * pad - 400 });
  out += T(w - pad, y + 28, `Page ${pageNo} of ${pages}`, { size: 17, weight: 700, fill: C.muted, anchor: 'end' });
  if (spec.hero) out += T(w - pad, y + 56, `${spec.hero.label.toLowerCase().replace(/^./, (c) => c.toUpperCase())} ${spec.hero.amount}`, { size: 17, fill: C.muted, anchor: 'end', max: 380 });
  out += R(pad, y + 86, w - 2 * pad, 1.5, { opacity: 0.1 });
  return { svg: out, y: y + 108 };
}
const footText = (spec) => `Shree Shyam Logistics  ·  Driving Your Progress  ·  ${spec.footNote || 'from the Trip Register'}`;

export function pagesSvg(spec) {
  const { width: w, height: h } = PAGE;
  const pad = 56;
  const cw = w - 2 * pad;
  const bottom = h - 100;
  const top1 = firstHead(spec, w).y;
  const topN = laterHead(spec, w, 2, 2).y;
  const pages = [];
  let cur = [];
  let y = top1;
  const blocks = spec.blocks.filter(Boolean);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];
    const needs = b.h + (b.keep && next ? next.h : 0);
    if (y + needs > bottom && cur.length) {
      pages.push(cur);
      cur = [];
      y = topN;
      if (b.under && !b.isHead) { cur.push(b.under); y += b.under.h; }   // a table carries on: its head again
    }
    cur.push(b);
    y += b.h;
  }
  pages.push(cur);
  const n = pages.length;
  return pages.map((list, i) => {
    const head = i === 0 ? firstHead(spec, w) : laterHead(spec, w, i + 1, n);
    let yy = head.y;
    let body = '';
    for (const b of list) { body += b.draw(pad, yy, cw); yy += b.h; }
    const foot = `${R(pad, h - 78, cw, 1.5, { opacity: 0.1 })}${T(pad, h - 40, footText(spec), { size: 15, fill: C.faint, max: cw - 180 })}${T(w - pad, h - 40, `Page ${i + 1} of ${n}`, { size: 15, weight: 700, fill: C.faint, anchor: 'end' })}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${defs(spec.fontCss, spec.extraCss)}${backdrop(w, h)}${head.svg}${body}${foot}</svg>`;
  });
}

export function cardSvg(spec) {
  const w = CARD_WIDTH;
  const pad = 56;
  const cw = w - 2 * pad;
  const head = firstHead(spec, w);
  let y = head.y;
  let body = '';
  for (const b of spec.blocks.filter(Boolean)) { body += b.draw(pad, y, cw); y += b.h; }
  y += 10;
  const foot = `${R(pad, y, cw, 1.5, { opacity: 0.1 })}${T(pad, y + 40, footText(spec), { size: 15, fill: C.faint, max: cw })}`;
  const h = Math.round(y + 72);
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${defs(spec.fontCss, spec.extraCss)}${backdrop(w, h)}${head.svg}${body}${foot}</svg>`, size: { width: w, height: h } };
}

// A bulker drawing (bulker.js) placed in the picture: its own <svg> becomes a
// group (keeping its classes, which its look hangs on) inside a frame of the
// size wanted — the page's sizing rules for .bulker must not apply here.
export function placeBulker(svg, x, y, w, h) {
  const m = String(svg).match(/^<svg([^>]*)>([\s\S]*)<\/svg>\s*$/);
  if (!m) return '';
  const cls = (m[1].match(/class="([^"]*)"/) || [])[1] || 'bulker';
  const vb = (m[1].match(/viewBox="([^"]*)"/) || [])[1] || '0 -3 424 139';
  return `<svg x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" overflow="visible"><g class="${cls}">${m[2]}</g></svg>`;
}
function bulkerBlock(svg, h = 300, caption = '') {
  return block(h + (caption ? 44 : 10), (x, y, w) => {
    const bw = Math.min(w, (h * 424) / 139);
    const inner = placeBulker(svg, x + (w - bw) / 2, y, bw, h);
    return `${R(x, y - 6, w, h + 12, { rx: 24, opacity: 0.04, stroke: '#fff', strokeOpacity: 0.08 })}${inner}${caption ? T(x + w / 2, y + h + 34, caption, { size: 18, fill: C.muted, anchor: 'middle', max: w - 20 }) : ''}`;
  });
}

const costParts = (trips) => costBreakdown(trips).groups.map((g, i) => ({ name: g.name, amount: g.amount, color: SERIES[i % SERIES.length] }));
function freightSplit(trips) {
  const cb = costBreakdown(trips);
  const parts = costParts(trips);
  if (cb.income > 0.5) parts.push({ name: 'Kept (net after EMI)', amount: cb.income, color: C.good });
  return splitBar(parts, cb.bhada);
}

// ---- SSFC account ----------------------------------------------------------------------------
// a: analyse.js ssfcAccount(); gst: clear with GST (the invoices' amounts) or without
export function ssfcPagesSvg(a, { gst = true, asOn = '', images = {}, fontCss = '', checks = null } = {}) {
  const list = gst ? a.withGst : a.exGstList;
  const pending = list.filter((b) => b.pending > 0.005);
  const lastPay = [...a.payments].sort((x, y) => ((x.date || x.month) < (y.date || y.month) ? 1 : -1))[0];
  const owed = gst ? a.total : a.exGst;
  const blocks = [];
  if (a.memos && a.memos.length) blocks.push(facts(a.memos.map((m) => [m.label, rupees(m.amount)]), { title: 'Also with SSFC' }));
  if (checks && checks.ssfcTotal != null && gst) blocks.push(note(Math.abs(checks.ssfcTotal - a.total) < 1 ? '✓ Same as the Ledger sheet’s Total Outstanding' : `The Ledger sheet shows ${rupees(checks.ssfcTotal)}`, Math.abs(checks.ssfcTotal - a.total) < 1 ? C.good : C.warn));
  blocks.push(gap(8));
  blocks.push(section(`Pending invoices · cleared oldest first${gst ? '' : ' (without GST)'}`, `${plural(pending.length, 'invoice')} · ${rupees(sum(pending, (b) => b.pending))}`));
  const age = (b) => (b.age == null ? '' : { text: `${b.age} d`, color: b.age > 90 ? C.bad : b.age > 45 ? C.warn : C.muted, weight: 700 });
  blocks.push(...table([
    { label: 'Month', at: 18 }, { label: 'Invoice', at: 230, max: 360 }, { label: 'Amount', at: -330, align: 'end' }, { label: 'Pending', at: -120, align: 'end' }, { label: 'Age', at: -18, align: 'end' },
  ], [...pending].reverse().map((b) => ({ cells: [
    { text: `${monY(b.month)}${b.toMonth && b.toMonth !== b.month ? ` – ${monY(b.toMonth)}` : ''}`, weight: 700 },
    { text: b.no || 'Not invoiced yet', weight: 700, sub: `${plural(b.vehicles, 'vehicle row')}${b.status === 'part' ? ` · ${rupees(b.cleared)} cleared` : ''}` },
    rupees(b.amount), { text: rupees(b.pending), weight: 800, color: C.amber }, age(b),
  ] })), { total: ['Total pending', '', '', { text: rupees(sum(pending, (b) => b.pending)), color: C.amber }, ''] }));
  blocks.push(gap());
  blocks.push(section('Month by month', `earned ${rupees(a.net)} · received ${rupees(a.paid)}`));
  blocks.push(...table([
    { label: 'Month', at: 18 }, { label: 'Invoice', at: 200, max: 250 }, { label: 'SSFC net', at: -660, align: 'end' }, { label: 'Invoiced', at: -500, align: 'end' }, { label: 'GST', at: -340, align: 'end' }, { label: 'Received', at: -18, align: 'end' },
  ], [...a.months].reverse().map((m) => ({ cells: [
    { text: monY(m.month), weight: 700, sub: plural(m.vehicles, 'vehicle') }, { text: m.invoices.join(', ') || '—', size: 16, color: m.invoices.length ? C.ink : C.faint },
    rupees(m.net), m.base ? rupees(m.base) : '—', m.igst ? rupees(m.igst) : '—', { text: m.paid ? rupees(m.paid) : '—', color: m.paid ? C.good : C.faint },
  ] })), { total: ['Total', '', rupees(a.net), '', rupees(a.igst), { text: rupees(a.paid), color: C.good }] }));
  blocks.push(gap());
  blocks.push(section('Payments received', `${plural(a.payments.length, 'payment')} · ${rupees(a.paid)}`, C.good));
  blocks.push(...table([
    { label: 'Date', at: 18 }, { label: 'How', at: 200, max: 330 }, { label: 'Against', at: 560, max: 360 }, { label: 'Amount', at: -18, align: 'end' },
  ], [...a.payments].reverse().map((x) => ({ cells: [
    { text: x.date ? dMonY(x.date) : monY(x.month), weight: 700 }, { text: x.how, size: 16 },
    { text: `${monY(x.month)} · ${shortVeh(x.veh)}`, size: 16, sub: x.invoice || x.remarks || '' }, { text: rupees(x.account + x.other), weight: 800, color: C.good },
  ] }))));
  return pagesSvg({
    what: 'SSFC account statement', tag: 'SSFC ACCOUNT', name: a.party.name, asOn, images, fontCss,
    sub: `${a.party.gstin ? `GSTIN ${a.party.gstin}  ·  ` : ''}bulker hiring  ·  ${monY(a.months[0] && a.months[0].month)} – ${monY(a.months.length && a.months[a.months.length - 1].month)}`,
    hero: { label: gst ? 'SSFC OWES US (WITH GST)' : 'SSFC OWES US (WITHOUT GST)', amount: rupees(owed), right: [
      [gst ? 'WITHOUT GST' : 'WITH GST', rupees(gst ? a.exGst : a.total)],
      ['LAST PAYMENT', lastPay ? `${rupees(lastPay.account + lastPay.other)} · ${lastPay.date ? dMon(lastPay.date) : monY(lastPay.month)}` : '—'],
    ] },
    tiles: [
      { label: 'To come in SSL account', value: rupees(a.account), sub: 'invoices − paid in account', color: C.s1 },
      { label: 'To settle in cash', value: rupees(a.cashWithGst), sub: `GST ${rupees(a.igst)} ± cash balance`, color: C.s4 },
      { label: 'Earned (SSFC net)', value: rupees(a.net), sub: `invoiced ${rupees(a.hireTotal)}`, color: C.s6 },
      { label: 'Received', value: rupees(a.paid), sub: `${rupees(a.paidAcct)} in account`, color: C.good },
    ],
    blocks, footNote: 'payments clear the months not invoiced first, then each invoice in order',
  });
}

// ---- a vehicle's statement for a period -----------------------------------------------------
// trips: the vehicle's trips in the period; opts.recon: dieselRecon().vehicles entry; opts.driverOf(t)
export function vehiclePagesSvg(veh, trips, { period = '', asOn = '', images = {}, fontCss = '', recon = null, driver = '', driverOf = null, emi = 0, loads = null } = {}) {
  const T0 = totals(trips);
  const list = [...trips].sort((a, b) => ((a.loadDate || a.start || '') < (b.loadDate || b.start || '') ? -1 : 1) || a.row - b.row);
  const months = [...new Set(list.map((t) => t.month || (t.start || '').slice(0, 7)))];
  const rows = [];
  for (const m of months) {
    const mt = list.filter((t) => (t.month || (t.start || '').slice(0, 7)) === m);
    const mT = totals(mt);
    rows.push({ band: monthLong(m), right: `${plural(mt.length, 'trip')} · freight ${rupees(mT.bhada)} · net ${rupees(mT.income)}` });
    for (const t of mt) {
      const d = tripDays(t);
      const who = driverOf ? driverOf(t) : '';
      rows.push({ cells: [
        { text: dMon(t.loadDate || t.start), weight: 700, sub: t.unloadDate ? `→ ${dMon(t.unloadDate)}` : 'on the way' },
        { text: `${t.trip} · ${routeOf(t)}`, weight: 700, sub: [t.diff && Math.abs(t.diff) >= 0.01 ? `${t.diff < 0 ? 'short' : 'excess'} ${Math.abs(t.diff).toFixed(2)}` : '', d != null ? `${d} d` : '', dieselLitres(t) ? `${Math.round(dieselLitres(t))} L` : '', who].filter(Boolean).join(' · ') },
        (() => { const b = loads && loads.get(t.row); return { text: t.bhada ? rupees(t.bhada) : '—', sub: t.loadWt ? `${t.loadWt.toFixed(2)} T${b ? ` · ${loadNote(b)}` : ''}` : '', subColor: b ? LOAD_COLOR[b.grade] : C.muted }; })(),
        { text: ssfcDeductions(t) ? rupees(ssfcDeductions(t)) : '—', color: C.muted },
        { text: ownExpenses(t) ? rupees(ownExpenses(t)) : '—', color: C.muted, sub: t.emi ? `incl. EMI ${rupees(t.emi)}` : '' },
        { text: t.income != null ? rupees(t.income) : '—', weight: 800, color: t.income < 0 ? C.bad : C.ink },
      ] });
    }
  }
  const blocks = [];
  if (trips.length) blocks.push(freightSplit(trips));
  blocks.push(section('Trips', `${plural(T0.trips, 'trip')} · ${tonnes(T0.tonnes, 1)}`));
  blocks.push(...table([
    { label: 'Loaded', at: 18 }, { label: 'Trip · route', at: 140, max: 360 }, { label: 'Freight · load', at: -500, align: 'end' }, { label: 'SSFC cut', at: -350, align: 'end' }, { label: 'Own costs', at: -185, align: 'end' }, { label: 'Net', at: -18, align: 'end' },
  ], rows, { total: ['Total', `${plural(T0.trips, 'trip')} · ${tonnes(T0.tonnes, 1)}`, rupees(T0.bhada), rupees(T0.ssfcDed), rupees(T0.own), { text: rupees(T0.income), color: T0.income < 0 ? C.bad : C.amber }] }));
  if (recon && recon.list.length) {
    blocks.push(gap());
    blocks.push(facts([
      ['Diesel allotted (all trips in the recon)', litres(recon.allotted)],
      ['Diesel issued (SSFC + own pump)', litres(recon.issued)],
      ['Running balance', signedLitres(recon.balance), { strong: true, color: recon.balance < 0 ? C.bad : C.good, rule: true }],
    ], { title: 'Diesel recon' }));
  }
  return pagesSvg({
    what: `Vehicle statement · ${period}`, tag: 'VEHICLE STATEMENT', name: plateText(veh), asOn, images, fontCss,
    sub: [period, plural(T0.trips, 'trip'), driver ? `driver ${driver}` : '', emi ? `EMI ${rupees(emi)} a month` : ''].filter(Boolean).join('  ·  '),
    hero: { label: 'NET AFTER EMI', amount: rupees(T0.income), right: [['FREIGHT', rupees(T0.bhada)], ['BEFORE EMI', rupees(T0.income + T0.emi)]] },
    tiles: [
      { label: 'Trips', value: String(T0.trips), sub: `${tonnes(T0.tonnes, 1)} carried`, color: C.s1 },
      { label: 'SSFC net', value: rupees(T0.ssfcNet), sub: `${rupees(T0.ssfcDed)} deducted`, color: C.s6 },
      { label: 'Own costs', value: rupees(T0.own - T0.emi), sub: `+ EMI ${rupees(T0.emi)}`, color: C.s2 },
      { label: 'Diesel', value: litres(T0.dieselL), sub: T0.trips ? `${Math.round(T0.dieselL / T0.trips)} L a trip` : '', color: C.s4 },
      { label: 'Avg trip', value: T0.days ? `${T0.days.toFixed(1)} d` : '—', sub: 'start → unloading', color: C.s3 },
    ],
    blocks,
  });
}

// ---- a vehicle's diesel recon ----------------------------------------------------------------
export function reconPagesSvg(v, { asOn = '', images = {}, fontCss = '', since = '' } = {}) {
  const rows = [...v.list].reverse().map((x) => ({ cells: [
    { text: dMon(x.t.loadDate || x.t.start), weight: 700, sub: (x.t.loadDate || x.t.start || '').slice(0, 4) },
    { text: `${x.t.trip}  ·  ${routeOf(x.t)}`, weight: 700, sub: x.t.gross ? `gross ${x.t.gross.toFixed(2)} T${Math.round(x.over) ? ` · overload +${Math.round(x.over)} L` : ''}${Math.round(x.under) ? ` · underload −${Math.round(x.under)} L` : ''}` : 'not loaded yet' },
    x.allotted != null ? litres(x.allotted) : '—', litres(x.issued),
    { text: signedLitres(x.balance), color: x.balance < -0.5 ? C.bad : x.balance > 0.5 ? C.good : C.muted },
    { text: signedLitres(x.running), weight: 800, color: x.running < 0 ? C.bad : C.ink },
  ] }));
  return pagesSvg({
    what: 'Diesel recon', tag: 'DIESEL RECON', name: plateText(v.veh), asOn, images, fontCss,
    sub: `${plural(v.list.length, 'trip')}${since ? ` since ${dMonY(since)}` : ''}  ·  allotted = route diesel + overload − underload`,
    hero: { label: v.balance < 0 ? 'DIESEL OVER THE ALLOTMENT' : 'DIESEL SAVED', amount: signedLitres(v.balance), right: [['ALLOTTED', litres(v.allotted)], ['ISSUED', litres(v.issued)]] },
    blocks: table([
      { label: 'Loaded', at: 18 }, { label: 'Trip · route', at: 140, max: 400 }, { label: 'Allotted', at: -540, align: 'end' }, { label: 'Issued', at: -400, align: 'end' }, { label: 'Trip ±', at: -220, align: 'end' }, { label: 'Running', at: -18, align: 'end' },
    ], rows, { total: ['Total', '', litres(v.allotted), litres(v.issued), '', { text: signedLitres(v.balance), color: v.balance < 0 ? C.bad : C.good }] }),
    footNote: '+ = diesel saved, − = used more than allotted',
  });
}

// ---- one trip ----------------------------------------------------------------------------------
// opts: bulker (bulker.js SVG), bulkerCss, fills (HSD rows), recon row, driver, paid (advances), salary check row
export function tripCardSvg(t, { asOn = '', images = {}, fontCss = '', bulker = '', bulkerCss = '', fills = [], recon = null, driver = '', paid = [], check = null, load = null, diesel = null } = {}) {
  const blocks = [];
  if (bulker) {
    const cap = t.loadWt ? `${t.loadWt.toFixed(2)} T alumina  ·  tare ${t.tare ? t.tare.toFixed(2) : '—'} T  ·  gross ${t.gross ? t.gross.toFixed(2) : '—'} T${t.gross ? `  ·  ${t.gross > RTO_GROSS ? `+${(t.gross - RTO_GROSS).toFixed(2)} T overload, RTO paid ✓` : `${(RTO_GROSS - t.gross).toFixed(2)} T under the RTO ${RTO_GROSS} T`}` : ''}` : 'Not loaded yet';
    blocks.push(bulkerBlock(bulker, 300, cap));
  }
  const d = tripDays(t) ?? (t.start && asOn ? Math.round((Date.parse(asOn) - Date.parse(t.start)) / 86400000) : null);
  blocks.push(facts([
    ['Trip start', t.start ? dMonY(t.start) : '—'],
    [`Loaded at ${t.port}`, t.loadDate ? `${dMonY(t.loadDate)}${t.loadWt ? `  ·  ${tonnes(t.loadWt)}` : ''}` : '—'],
    [`Unloaded at ${t.dest}`, t.unloadDate ? `${dMonY(t.unloadDate)}${t.unloadWt ? `  ·  ${tonnes(t.unloadWt)}` : ''}` : 'on the way'],
    t.diff ? [t.diff < 0 ? 'Short' : 'Excess', tonnes(Math.abs(t.diff)), { color: t.diff < 0 ? C.bad : C.good }] : null,
    load ? ['Load vs the best on the route then', load.grade === 'top' ? `★ full load (best ${tonnes(load.near)})` : `${tonnes(load.gapNear)} below ${tonnes(load.near)} · ${rupees(load.lostRs)} freight`, { color: LOAD_COLOR[load.grade] }] : null,
    t.gross ? ['Gross against the RTO 56 T', t.gross > RTO_GROSS ? `+${tonnes(t.gross - RTO_GROSS)} overload · RTO paid` : `${tonnes(RTO_GROSS - t.gross)} under`, { color: t.gross > RTO_GROSS ? C.good : C.bad }] : null,
    [t.unloadDate ? 'Trip took' : 'On the road', d != null ? `${d} days` : '—', { strong: true }],
  ], { title: 'The trip' }));
  if (t.bhada) {
    const L = (k, v, o = {}) => (v ? [k, `− ${rupees(v)}`, { indent: 20, ...o }] : null);
    blocks.push(facts([
      ['Freight (bhada)', rupees(t.bhada), { strong: true, size: 20 }],
      [`${t.loadWt ? `${t.loadWt.toFixed(2)} T × ₹${ind(t.rate || 0)}` : ''}`, ''],
      L(`SSFC diesel${t.ssfcLtr ? ` (${ind(t.ssfcLtr)} L)` : ''}`, t.ssfcAmt), L('Driver SSFC payment', t.drvSsfc), L('SSFC misc', t.ssfcMisc),
      L('Fastag', t.fastag), L('Maintenance', t.maint), L('Tyre', t.tyre), L('Less over/unload', t.lessOver), L('RTO entry', t.rtoEntry),
      L('RTO challan', t.rtoChallan), L('Shortage', t.shortage), L('Document expense', t.docExp),
      ['SSFC net amount', rupees(t.ssfcNet), { strong: true, rule: true }],
      L(`Own diesel${t.ownLtr ? ` (${ind(t.ownLtr)} L)` : ''}`, t.ownAmt), L(`Extra HSD${t.extraLtr ? ` (${ind(t.extraLtr)} L)` : ''}`, t.extraAmt),
      L('Urea', t.urea), L('Extra driver pay', t.drvExtra), L('Trip driver payment', t.drvTrip), L('Own document expense', t.docOwn),
      L('Own misc kharcha', t.ownMisc), L('EMI (installment)', t.emi),
      ['Income from the trip', rupees(t.income), { strong: true, rule: true, size: 21, color: t.income < 0 ? C.bad : C.good }],
      t.drvDebit ? ['Driver debit (not in income)', rupees(t.drvDebit)] : null,
    ].filter((r) => r && (r[0] || r[1])), { title: 'The money' }));
  }
  if (fills.length || diesel) {
    blocks.push(section('Diesel', `${litres(dieselLitres(t))} · ${rupees(dieselAmount(t))}`));
    if (fills.length) {
      blocks.push(...table([{ label: 'Date', at: 18 }, { label: 'Where', at: 170, max: 420 }, { label: 'Litres', at: -200, align: 'end' }, { label: 'Amount', at: -18, align: 'end' }],
        fills.map((h) => ({ cells: [{ text: dMon(h.date), weight: 700 }, { text: h.source || '—', sub: h.location || '' }, litres(h.qty), rupees(h.amount)] }))));
    }
    const z = diesel;
    if (z && z.allotted != null) {
      const sl = (n) => `${n > 0.5 ? '+' : n < -0.5 ? '−' : ''}${litres(Math.abs(n))}`;
      blocks.push(facts([
        ['Allotted', `${litres(z.allotted)}${z.est ? ' (route diesel, until loaded)' : `${Math.round(z.over) ? `  (incl. +${Math.round(z.over)} L overload)` : ''}${Math.round(z.under) ? `  (incl. −${Math.round(z.under)} L underload)` : ''}`}`],
        ['Taken', z.ownL ? `${litres(z.taken)}  (SSFC ${litres(z.ssfcL)} + own ${litres(z.ownL)})` : litres(z.taken)],
        z.ownL ? ['Own diesel bought for the trip (SSFC couldn\'t supply)', `${litres(z.ownL)}${z.ownRs ? ` · ${rupees(z.ownRs)}` : ''}`] : null,
        z.live ? ['To take (left of this trip\'s allotment)', litres(z.toTake)] : null,
        ['Extra this trip', z.extra > 0.5 ? `+${litres(z.extra)}` : '—', { color: z.extra > 0.5 ? C.bad : C.good }],
        ['Carried in from earlier trips', z.carryIn < -0.5 ? `${sl(z.carryIn)} owed` : z.carryIn > 0.5 ? `${sl(z.carryIn)} saved` : '—', { color: z.carryIn < -0.5 ? C.warn : C.ink }],
        z.live ? ['May still take', litres(z.mayTake), { strong: true, color: z.mayTake < 0.5 ? C.bad : C.good, rule: true }] : null,
        [z.live ? 'Balance if no more is taken' : 'Balance after the trip', `${sl(z.after)}${z.after < -0.5 ? ' — comes off the next trips' : ''}`, { strong: true, color: z.after < -0.5 ? C.bad : C.good, rule: !z.live }],
        z.incentive ? ['Own Diesel Extra (driver incentive, settled)', `${litres(z.incentive)} — not counted`, { color: C.muted }] : null,
      ], { title: 'Diesel against the allotment' }));
    }
  }
  if (paid.length || check) {
    const rows = [];
    if (check && check.salary != null) {
      rows.push(['Driver salary for the route', rupees(check.salary)], ['− Our advances', rupees(check.advance)], ['= SSFC should pay', rupees(check.expected)], ['SSFC paid', rupees(check.ssfc)]);
      rows.push([check.over > 100 ? 'Paid over salary' : check.over < -100 ? 'Paid less' : 'Matches', check.over > 100 || check.over < -100 ? rupees(Math.abs(check.over)) : '✓', { strong: true, color: check.over > 100 ? C.bad : C.good, rule: true }]);
    }
    for (const p of paid) rows.push([`${dMon(p.date)} advance to ${p.name}${p.note ? ` (${p.note})` : ''}`, rupees(p.amount)]);
    blocks.push(facts(rows, { title: `Driver${driver ? ` · ${driver}` : ''}` }));
  }
  if (t.remarks) blocks.push(note(`“${t.remarks}”`, C.muted, 17));
  return cardSvg({
    what: 'Trip statement', tag: t.unloadDate ? 'TRIP · UNLOADED' : t.loadDate ? 'TRIP · LOADED, ON THE WAY' : 'TRIP · TO THE PORT', name: t.trip, asOn, images, fontCss,
    sub: [plateText(t.veh), routeOf(t), driver ? `driver ${driver}` : ''].filter(Boolean).join('  ·  '),
    hero: t.bhada ? { label: t.status === 'done' ? 'INCOME FROM THE TRIP' : 'INCOME SO FAR', amount: rupees(t.income), right: [['FREIGHT', rupees(t.bhada)], ['SSFC NET', rupees(t.ssfcNet)]] } : null,
    blocks, extraCss: bulkerCss,
  });
}

// ---- a driver's spell on a truck ---------------------------------------------------------------
// sp: rules.js driverCheck() spell; rows: its checked trip rows
export function driverPagesSvg(sp, rows, { asOn = '', images = {}, fontCss = '', now = false } = {}) {
  const pays = sp.payments || [];
  const paidTotal = sum(pays, (p) => p.amount);
  const checked = rows.filter((r) => r.salary != null);
  const blocks = [];
  if (checked.length) {
    blocks.push(section('Trips checked', `salary ${rupees(sp.salary)} · SSFC ${rupees(sp.ssfc)} + advances ${rupees(sp.advance)}`));
    blocks.push(...table([
      { label: 'Loaded', at: 18 }, { label: 'Trip · route', at: 150, max: 320 }, { label: 'Salary', at: -600, align: 'end' }, { label: 'Advance', at: -450, align: 'end' }, { label: 'SSFC paid', at: -300, align: 'end' }, { label: 'Trip ±', at: -160, align: 'end' }, { label: 'Running', at: -18, align: 'end' },
    ], checked.map((r) => ({ cells: [
      { text: dMon(r.t.loadDate || r.t.start), weight: 700 }, { text: `${r.t.trip} · ${routeOf(r.t)}`, size: 16, weight: 600 },
      rupees(r.salary), r.advance ? rupees(r.advance) : '—', rupees(r.ssfc),
      { text: `${r.over > 0.5 ? '+' : ''}${rupees(r.over)}`, color: r.over > 100 ? C.bad : C.muted },
      { text: signedRupees(r.running), weight: 800, color: r.running > 500 ? C.bad : C.ink },
    ] })), { total: ['Balance', '', rupees(sp.salary), rupees(sp.advance), rupees(sp.ssfc), '', { text: signedRupees(sp.balance), color: sp.balance > 500 ? C.bad : C.good }] }));
    blocks.push(note('Trip ± = SSFC paid − (salary − advance). Running includes debits; + = paid more than earned.', C.faint, 14));
    blocks.push(gap());
  }
  if (pays.length) {
    blocks.push(section('Advances paid', `${plural(pays.length, 'payment')} · ${rupees(paidTotal)}`, C.good));
    blocks.push(...table([{ label: 'Date', at: 18 }, { label: 'To', at: 200, max: 300 }, { label: 'Note', at: 520, max: 380 }, { label: 'Amount', at: -18, align: 'end' }],
      [...pays].reverse().map((p) => ({ cells: [{ text: dMonY(p.date), weight: 700 }, p.name, { text: p.note || '', size: 15, color: C.muted }, { text: rupees(p.amount), weight: 800, color: C.good }] })),
      { total: ['Total', '', '', { text: rupees(paidTotal), color: C.good }] }));
  }
  blocks.push(gap());
  blocks.push(section('Trips driven', plural(sp.all.length, 'trip')));
  blocks.push(...table([{ label: 'Started', at: 18 }, { label: 'Trip', at: 180 }, { label: 'Route', at: 400, max: 360 }, { label: 'Load', at: -160, align: 'end' }, { label: 'Days', at: -18, align: 'end' }],
    [...sp.all].reverse().map((t) => ({ cells: [{ text: t.start ? dMonY(t.start) : '—', weight: 700 }, { text: t.trip, weight: 700 }, routeOf(t), t.loadWt ? tonnes(t.loadWt) : '—', tripDays(t) != null ? `${tripDays(t)} d` : (t.unloadDate ? '—' : 'on the way')] }))));
  const bal = checked.length ? sp.balance : null;
  return pagesSvg({
    what: 'Driver statement', tag: now ? 'DRIVER · NOW ON THE TRUCK' : 'DRIVER', name: sp.label, asOn, images, fontCss,
    sub: `${plateText(sp.veh)}  ·  ${dMonY(sp.from)} → ${now ? 'now' : dMonY(sp.to)}  ·  ${plural(sp.all.length, 'trip')} driven`,
    hero: bal != null
      ? { label: bal > 500 ? 'PAID MORE THAN EARNED' : bal < -500 ? 'STILL TO BE PAID' : 'SALARY SETTLED', amount: rupees(Math.abs(bal)), right: [['ADVANCES PAID', rupees(paidTotal)], ['TRIPS DRIVEN', String(sp.all.length)]] }
      : { label: 'ADVANCES PAID', amount: rupees(paidTotal), right: [['TRIPS DRIVEN', String(sp.all.length)], ['PAYMENTS', String(pays.length)]] },
    blocks, footNote: 'advances from the Driver Payment sheet',
  });
}

// ---- the fleet for a period -----------------------------------------------------------------------
// opts: vehicles (byVehicle rows), routes (byRoute rows), months (monthly rows), driverOf(veh), account (ssfcAccount)
export function fleetPagesSvg(trips, { period = '', asOn = '', images = {}, fontCss = '', vehicles = [], routes = [], months = [], driverOf = null, account = null, onRoad = null } = {}) {
  const T0 = totals(trips);
  const blocks = [];
  if (trips.length) blocks.push(freightSplit(trips));
  blocks.push(section('By vehicle', `${plural(vehicles.filter((v) => v.trips).length, 'vehicle')}`));
  const vs = [...vehicles].filter((v) => v.trips).sort((a, b) => b.income - a.income);
  blocks.push(...table([
    { label: 'Vehicle', at: 18, max: 300 }, { label: 'Trips', at: -760, align: 'end' }, { label: 'Tonnes', at: -620, align: 'end' }, { label: 'Freight', at: -440, align: 'end' }, { label: 'Before EMI', at: -240, align: 'end' }, { label: 'Net', at: -18, align: 'end' },
  ], vs.map((v) => ({ cells: [
    { text: plateText(v.veh), weight: 800, sub: driverOf ? driverOf(v.veh) : '' }, String(v.trips), ind(v.tonnes, 1), rupees(v.bhada), rupees(v.income + v.emi),
    { text: rupees(v.income), weight: 800, color: v.income < 0 ? C.bad : C.ink },
  ] })), { total: ['Fleet', String(T0.trips), ind(T0.tonnes, 1), rupees(T0.bhada), rupees(T0.income + T0.emi), { text: rupees(T0.income), color: C.amber }] }));
  if (routes.length) {
    blocks.push(gap());
    blocks.push(section('By route', plural(routes.length, 'route')));
    blocks.push(...table([
      { label: 'Route', at: 18, max: 380 }, { label: 'Trips', at: -700, align: 'end' }, { label: 'Avg load', at: -560, align: 'end' }, { label: '₹ / ton', at: -420, align: 'end' }, { label: 'Diesel / trip', at: -230, align: 'end' }, { label: 'Net / trip', at: -18, align: 'end' },
    ], routes.map((r) => ({ cells: [{ text: r.route, weight: 700, sub: r.days ? `${r.days.toFixed(1)} days a trip` : '' }, String(r.trips), tonnes(r.avgLoad, 1), `₹${ind(r.perTonne)}`, litres(r.dieselPerTrip), { text: rupees(r.perTrip), weight: 800 }] }))));
  }
  if (months.length > 1) {
    blocks.push(gap());
    blocks.push(section('Month by month'));
    blocks.push(...table([
      { label: 'Month', at: 18 }, { label: 'Trips', at: -760, align: 'end' }, { label: 'Tonnes', at: -620, align: 'end' }, { label: 'Freight', at: -440, align: 'end' }, { label: 'SSFC net', at: -240, align: 'end' }, { label: 'Net', at: -18, align: 'end' },
    ], [...months].reverse().map((m) => ({ cells: [{ text: monthLong(m.month), weight: 700 }, String(m.trips), ind(m.tonnes, 1), rupees(m.bhada), rupees(m.ssfcNet), { text: rupees(m.income), weight: 800, color: m.income < 0 ? C.bad : C.ink }] }))));
  }
  if (account) {
    blocks.push(gap());
    blocks.push(facts([
      ['SSFC owes us (with GST)', rupees(account.total), { strong: true, color: C.amber }],
      ['To come in SSL account', rupees(account.account)], ['To settle in cash', rupees(account.cashWithGst)],
    ], { title: 'SSFC account today' }));
  }
  return pagesSvg({
    what: `Fleet report · ${period}`, tag: 'FLEET REPORT', name: 'Shree Shyam Logistics fleet', asOn, images, fontCss,
    sub: [period, plural(vehicles.length, 'vehicle'), onRoad != null ? `${onRoad} on the road now` : ''].filter(Boolean).join('  ·  '),
    hero: { label: 'NET AFTER EMI', amount: rupees(T0.income), right: [['FREIGHT', rupees(T0.bhada)], ['BEFORE EMI', `${rupees(T0.income + T0.emi)}${T0.bhada ? ` · ${Math.round(((T0.income + T0.emi) / T0.bhada) * 100)}%` : ''}`]] },
    tiles: [
      { label: 'Trips', value: String(T0.trips), sub: T0.open ? `${T0.done} done · ${T0.open} open` : 'all unloaded', color: C.s1 },
      { label: 'Tonnes', value: ind(T0.tonnes, 0), sub: T0.short ? `${tonnes(-T0.short)} short` : 'carried', color: C.s3 },
      { label: 'SSFC net', value: rupees(T0.ssfcNet), sub: `${rupees(T0.ssfcDed)} deducted`, color: C.s6 },
      { label: 'Own costs', value: rupees(T0.own - T0.emi), sub: `+ EMI ${rupees(T0.emi)}`, color: C.s2 },
      { label: 'Diesel', value: litres(T0.dieselL), sub: `${rupees(T0.dieselAmt)}`, color: C.s4 },
    ],
    blocks,
  });
}

// ---- on the road now --------------------------------------------------------------------------------
// rows: [{ veh, driver, state: 'loaded'|'empty'|'idle', title (the route), phase, sub, pace, paceColor: 'good'|'warn'|'bad'|'', bulker }]
export function roadCardSvg(rows, { asOn = '', images = {}, fontCss = '', bulkerCss = '' } = {}) {
  const loaded = rows.filter((r) => r.state === 'loaded').length;
  const empty = rows.filter((r) => r.state === 'empty').length;
  const idle = rows.filter((r) => r.state === 'idle').length;
  const tone = { good: C.good, warn: C.warn, bad: C.bad };
  const blocks = rows.map((r) => block(r.diesel ? 200 : 176, (x, y, w) => {
    const bw = 300;
    const bh = (bw * 139) / 424;
    const inner = r.bulker ? placeBulker(r.bulker, x + 10, y + 26, bw, bh) : '';
    const tx = x + bw + 36;
    const tw = w - bw - 56;
    const st = r.state === 'loaded' ? C.amber : r.state === 'empty' ? C.s1 : C.faint;
    return `${R(x, y + 4, w, r.diesel ? 188 : 164, { rx: 22, opacity: 0.05, stroke: '#fff', strokeOpacity: 0.1 })}${R(x, y + 30, 5, 112, { rx: 2.5, fill: st })}${inner}
${T(tx, y + 42, plateText(r.veh), { size: 24, weight: 800, max: tw * 0.6 })}${T(x + w - 22, y + 42, r.driver || '', { size: 17, fill: C.muted, anchor: 'end', max: tw * 0.4 })}
${T(tx, y + 74, r.title, { size: 20, weight: 800, fill: st, max: tw })}
${T(tx, y + 101, r.phase || '', { size: 17, weight: 600, max: tw })}
${T(tx, y + 127, r.sub || '', { size: 15, fill: C.muted, max: tw })}
${T(tx, y + 152, r.pace || '', { size: 15, weight: 700, fill: tone[r.paceColor] || C.muted, max: tw })}
${r.diesel ? T(tx, y + 177, `Diesel ${r.diesel}`, { size: 15, weight: 600, fill: tone[r.dieselColor] || C.muted, max: tw }) : ''}`;
  }));
  return cardSvg({
    what: 'On the road now', tag: 'FLEET NOW', name: `${rows.length - idle} of ${plural(rows.length, 'bulker')} on a trip`, asOn, images, fontCss,
    sub: `${loaded} loaded on the way  ·  ${empty} empty to the port  ·  ${idle} idle`,
    blocks, extraCss: bulkerCss,
  });
}

// ---- the day book -----------------------------------------------------------------------------------
// book: daybook.js dayBook(); label: the dates; what: the filter (types / vehicle)
const DAY_COLOR = { load: C.s1, unload: C.s3, start: C.s6, diesel: C.s4, urea: C.s5, advance: C.s2, ssfc: C.s8 };
const DAY_NAME = { load: 'Loading', unload: 'Unloading', start: 'Trip start', diesel: 'Diesel', urea: 'Urea', advance: 'Advance', ssfc: 'SSFC paid' };
const longDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]}, ${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
};
export function daybookPagesSvg(book, { label = '', what = '', asOn = '', images = {}, fontCss = '', driverOf = null, loads = null } = {}) {
  const S = book.sums;
  const dayLine = (s) => [s.loads ? `${s.loads} loaded ${ind(s.tonnes, 1)} T` : '', s.unloads ? `${s.unloads} unloaded` : '', s.fills ? `diesel ${litres(s.litres)}` : '', s.advances ? `advances ${rupees(s.advances)}` : '', s.received ? `SSFC ${rupees(s.received)}` : ''].filter(Boolean).join(' · ');
  const amt = (e) => {
    if (e.kind === 'load') { const b = loads && e.t && loads.get(e.t.row); return { text: rupees(e.amount), weight: 800, sub: b ? loadNote(b) : 'freight', subColor: b ? LOAD_COLOR[b.grade] : C.muted }; }
    if (e.kind === 'unload') return { text: e.tonnes ? tonnes(e.tonnes) : '—', weight: 800, sub: e.short < 0 ? `${tonnes(-e.short)} short` : 'delivered', subColor: e.short < 0 ? C.bad : C.muted };
    if (e.kind === 'diesel') return { text: rupees(e.amount), weight: 800, sub: litres(e.litres) };
    if (e.kind === 'urea') return { text: rupees(e.amount), weight: 800, sub: e.litres ? `${ind(e.litres, 1)} L` : '' };
    if (e.kind === 'advance') return { text: rupees(e.amount), weight: 800, color: C.warn, sub: 'paid out' };
    if (e.kind === 'ssfc') return { text: rupees(e.amount), weight: 800, color: C.good, sub: 'received' };
    return '';
  };
  const rows = [];
  for (const day of book.days) {
    rows.push({ band: longDay(day.date), right: dayLine(day.sums) });
    for (const e of day.entries) {
      rows.push({ cells: [
        { text: shortVeh(e.veh), weight: 800, dot: DAY_COLOR[e.kind], sub: DAY_NAME[e.kind], subColor: DAY_COLOR[e.kind] },
        { text: e.title, weight: 700, sub: e.detail || (driverOf && e.veh ? driverOf(e.veh) : '') },
        amt(e),
      ] });
    }
  }
  const blocks = book.list.length
    ? table([{ label: 'Vehicle', at: 34 }, { label: 'Entry', at: 170, max: 760 }, { label: 'Amount', at: -18, align: 'end' }], rows)
    : [note('Nothing on these days.')];
  return pagesSvg({
    what: `Day book · ${label}`, tag: 'DAY BOOK', name: label, asOn, images, fontCss,
    sub: [plural(book.list.length, 'entry', 'entries'), plural(book.days.length, 'day'), what].filter(Boolean).join('  ·  '),
    hero: { label: 'FREIGHT LOADED', amount: rupees(S.freight), right: [['DIESEL', S.fills ? `${litres(S.litres)} · ${rupees(S.diesel)}` : '—'], [S.received ? 'SSFC RECEIVED' : 'ADVANCES PAID', S.received ? rupees(S.received) : rupees(S.advances)]] },
    tiles: [
      { label: 'Loaded', value: S.loads ? `${S.loads} · ${ind(S.tonnes, 1)} T` : '—', sub: S.loads ? `freight ${rupees(S.freight)}` : 'no loading', color: C.s1 },
      { label: 'Unloaded', value: S.unloads ? `${S.unloads} · ${ind(S.delivered, 1)} T` : '—', sub: S.short < 0 ? `${tonnes(-S.short)} short` : S.unloads ? 'no shortage' : 'no unloading', color: C.s3 },
      { label: 'Diesel', value: S.fills ? litres(S.litres) : '—', sub: S.fills ? `${rupees(S.diesel)} · ${plural(S.fills, 'fill')}` : 'no fill', color: C.s4 },
      { label: 'Urea', value: S.urea ? rupees(S.urea) : '—', sub: S.ureaL ? `${ind(S.ureaL, 1)} L` : 'none', color: C.s5 },
      { label: 'Advances', value: S.advances ? rupees(S.advances) : '—', sub: S.advanceN ? plural(S.advanceN, 'payment') : 'none', color: C.s2 },
    ],
    blocks, footNote: 'every dated entry in the Trip Register workbook',
  });
}

// ---- the daily brief -------------------------------------------------------------------------------
const TONE = { good: C.good, warn: C.warn, bad: C.bad, info: C.ink };
// lines of text that wrap: [{ text, size, weight, color, gap }]
function textLines(x, y, w, lines) {
  let out = '';
  let yy = y;
  for (const l of lines) {
    if (!l || !l.text) continue;
    const size = l.size || 20;
    yy += l.gap || 0;
    for (const part of wrap(l.text, w, size, l.weight || 400)) {
      yy += size * 1.45;
      out += T(x, yy, part, { size, weight: l.weight || 400, fill: l.color || C.ink });
    }
  }
  return { svg: out, h: yy - y };
}
const linesHeight = (w, lines) => textLines(0, 0, w, lines).h;

// the drivers' instructions, in Hindi (brief.js driverBrief())
export function driverBriefSvg(b, { asOn = '', images = {}, fontCss = '' } = {}) {
  const W = CARD_WIDTH - 112;
  const blocks = [];
  // the standing rules
  const rules = b.rules.map((r, i) => ({ text: `${i + 1}. ${r}`, size: 25, weight: 700, gap: i ? 8 : 0 }));
  const rh = linesHeight(W - 56, rules);
  blocks.push(block(rh + 70, (x, y, w) => `${R(x, y, w, rh + 50, { rx: 22, fill: C.warn, opacity: 0.1, stroke: C.warn, strokeOpacity: 0.45 })}${textLines(x + 28, y + 14, w - 56, rules).svg}`));
  const top = [{ text: b.yesterday, size: 24, color: C.muted }, b.shout ? { text: `★ ${b.shout}`, size: 24, weight: 700, color: C.good, gap: 6 } : null].filter(Boolean);
  const th = linesHeight(W, top);
  blocks.push(block(th + 26, (x, y, w) => textLines(x, y, w, top).svg));
  for (const r of b.rows) {
    const lines = [
      { text: `अभी: ${r.now}`, size: 24 },
      r.next ? { text: `अगला: ${r.next}${r.by ? ` — ${hiDate(r.by)} तक (${r.byRel})` : ''}`, size: 26, weight: 800, color: r.urgent ? C.bad : C.amber, gap: 6 } : null,
      r.pace ? { text: r.pace, size: 24, weight: 700, color: TONE[r.paceTone], gap: 6 } : null,
      r.load ? { text: r.load, size: 24, weight: 600, color: TONE[r.loadTone], gap: 6 } : null,
      r.diesel ? { text: r.diesel, size: 24, weight: 600, color: TONE[r.dieselTone], gap: 6 } : null,
    ].filter(Boolean);
    const lh = linesHeight(W - 56, lines);
    const accent = r.state === 'idle' ? C.faint : TONE[r.paceTone] === C.ink ? C.s1 : TONE[r.paceTone];
    blocks.push(block(lh + 108, (x, y, w) => `${R(x, y, w, lh + 90, { rx: 22, opacity: 0.05, stroke: '#fff', strokeOpacity: 0.1 })}${R(x, y + 18, 6, lh + 54, { rx: 3, fill: accent })}
${T(x + 28, y + 50, plateText(r.veh), { size: 32, weight: 800 })}${T(x + w - 28, y + 50, r.driver || '', { size: 23, weight: 700, fill: C.muted, anchor: 'end', max: w * 0.42 })}
${r.day != null ? T(x + 28 + textWidth(plateText(r.veh), 32, 800) + 18, y + 49, r.day ? `${r.day}वाँ दिन` : 'आज निकली', { size: 20, fill: C.faint }) : ''}
${textLines(x + 28, y + 60, w - 56, lines).svg}`));
  }
  return cardSvg({
    what: 'ड्राइवरों के लिए आज के निर्देश', tag: 'आज के निर्देश', name: hiLongDate(b.date), sub: 'सभी ड्राइवर ध्यान से पढ़ें और समय पर पहुँचें', asOn, images, fontCss,
    blocks, footNote: 'Trip Register से',
  });
}
const HMON = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
const hiDate = (iso) => `${Number(iso.slice(8, 10))} ${HMON[Number(iso.slice(5, 7)) - 1]}`;
const hiLongDate = (iso) => `${['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'][new Date(`${iso}T00:00:00Z`).getUTCDay()]}, ${hiDate(iso)} ${iso.slice(0, 4)}`;

// the owner's insight (brief.js ownerBrief())
export function ownerBriefSvg(b, { asOn = '', images = {}, fontCss = '' } = {}) {
  const W = CARD_WIDTH - 112;
  const blocks = [];
  for (const sec of b.sections) {
    blocks.push(section(sec.title));
    for (const it of sec.items) {
      const lines = it.head
        ? [{ text: it.head, size: 19, weight: 700, color: it.tone === 'info' || it.tone === 'good' ? C.ink : TONE[it.tone] }, { text: it.text, size: 16, color: C.muted }, ...(it.more || []).map((x) => ({ text: x, size: 16, color: C.ink }))]
        : [{ text: it.text, size: 19, weight: it.tone === 'info' ? 400 : 600, color: it.tone === 'info' ? C.ink : TONE[it.tone] }];
      const h = linesHeight(W - 40, lines);
      blocks.push(block(h + 18, (x, y, w) => `<circle cx="${x + 10}" cy="${y + 21}" r="6" fill="${it.tone === 'info' ? C.s1 : TONE[it.tone]}"/>${textLines(x + 32, y - 4, w - 40, lines).svg}`));
    }
    blocks.push(gap(10));
  }
  return cardSvg({ what: "Owner's daily insight", tag: 'DAILY INSIGHT', name: dMonY(b.date), sub: 'what moved yesterday, what needs you today', asOn, images, fontCss, blocks });
}
