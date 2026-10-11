// Small SVG charts (no library), drawn like the ledger's: each bar carries a
// data-tip and bindCharts() turns those into a tooltip + crosshair.
// Colours are CSS variables from index.html, validated as a set on the dark
// surface (dataviz validator: categorical slots 1–5, all checks pass).

import { esc, money, monthName } from './util.js';

const r1 = (n) => Math.round(n * 10) / 10;

function niceStep(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

let W = 640;
export function setChartWidth(w) { W = Math.max(280, Math.round(w)); }
const PAD = { l: 58, r: 8, t: 10, b: 24 };

// y scale over [lo, hi] (lo ≤ 0 ≤ hi), gridlines at lo, 0, hi (and the middle when one-sided)
function frame(h, lo, hi, fmt, label) {
  const top = niceStep(Math.max(hi, 0)) || 0;
  const bottom = lo < 0 ? -niceStep(-lo) : 0;
  const max = top || (bottom ? 0 : 1);
  const min = bottom;
  const y = (v) => PAD.t + (h - PAD.t - PAD.b) * (1 - (v - min) / (max - min || 1));
  const ticks = min < 0 && max > 0 ? [min, 0, max] : min < 0 ? [min, min / 2, 0] : [0, max / 2, max];
  const grid = ticks.map((v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${r1(y(v))}" y2="${r1(y(v))}" class="gl${v === 0 ? ' zero' : ''}"/>
    <text x="${PAD.l - 6}" y="${r1(y(v) + 4)}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`).join('');
  return { y, grid, open: `<svg viewBox="0 0 ${W} ${h}" class="chart" role="img" aria-label="${esc(label)}">` };
}

// bar from the zero line, 3px rounded on the data end
function bar(x, y0, w, y1, r = 3) {
  const h = Math.abs(y1 - y0);
  if (h < 0.5 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  if (y1 < y0) {                                                  // up
    return `M${r1(x)},${r1(y0)} v${r1(-(h - rr))} q0,${r1(-rr)} ${r1(rr)},${r1(-rr)} h${r1(w - 2 * rr)} q${r1(rr)},0 ${r1(rr)},${r1(rr)} v${r1(h - rr)} z`;
  }
  return `M${r1(x)},${r1(y0)} v${r1(h - rr)} q0,${r1(rr)} ${r1(rr)},${r1(rr)} h${r1(w - 2 * rr)} q${r1(rr)},0 ${r1(rr)},${r1(-rr)} v${r1(-(h - rr))} z`;
}

function xLabels(items, x, h, label) {
  const n = items.length;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - PAD.l - PAD.r) / 58))));
  return items.map((it, i) => ((i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2)
    ? `<text x="${r1(x(i))}" y="${h - 6}" class="tick" text-anchor="middle">${esc(label(it))}</text>` : '')).join('');
}

const hit = (i, step, h, x, tip) => `<rect x="${r1(PAD.l + step * i)}" y="${PAD.t}" width="${r1(step)}" height="${r1(h - PAD.t - PAD.b)}" class="hit" data-x="${r1(x(i))}" data-tip="${esc(tip)}"/>`;

// Side-by-side bars per item, one per series (same unit, one axis).
// items: [{...}], series: [{key, name, color}], tip(item) -> html
export function groupedBars(items, series, { h = 210, fmt = money, label = 'Chart', labelOf = (d) => monthName(d.month), tip } = {}) {
  const vals = items.flatMap((d) => series.map((s) => Number(d[s.key]) || 0));
  const f = frame(h, Math.min(0, ...vals), Math.max(0, ...vals), fmt, label);
  const step = (W - PAD.l - PAD.r) / Math.max(1, items.length);
  const n = series.length;
  const bw = Math.max(2, Math.min(18, (step - 6) / n - 2));
  const x = (i) => PAD.l + step * i + step / 2;
  const base = f.y(0);
  const out = items.map((d, i) => {
    const left = x(i) - (n * bw + (n - 1) * 2) / 2;
    const bars = series.map((s, j) => `<path d="${bar(left + j * (bw + 2), base, bw, f.y(Number(d[s.key]) || 0))}" fill="${s.color}"/>`).join('');
    return bars + hit(i, step, h, x, tip ? tip(d) : `<b>${esc(labelOf(d))}</b><br>${series.map((s) => `<i style="background:${s.color}"></i>${esc(s.name)} ${fmt(d[s.key])}`).join('<br>')}`);
  });
  return `${f.open}${f.grid}${out.join('')}${xLabels(items, x, h, labelOf)}</svg>`;
}

// Stacked bars (all parts ≥ 0), 2px gap between parts. keys: [{key, name, color}], d.parts[key]
export function stackedBars(items, keys, { h = 210, fmt = money, label = 'Chart', labelOf = (d) => monthName(d.month), tip } = {}) {
  const tot = (d) => keys.reduce((a, k) => a + (d.parts[k.key] || 0), 0);
  const f = frame(h, 0, Math.max(0, ...items.map(tot)), fmt, label);
  const step = (W - PAD.l - PAD.r) / Math.max(1, items.length);
  const bw = Math.max(3, Math.min(24, step - 4));
  const x = (i) => PAD.l + step * i + step / 2;
  const out = items.map((d, i) => {
    let cum = 0;
    const segs = keys.filter((k) => (d.parts[k.key] || 0) > 0);
    const marks = segs.map((k, j) => {
      const yb = f.y(cum) - (j ? 2 : 0);
      cum += d.parts[k.key];
      const yt = f.y(cum);
      if (yb - yt <= 0.5) return '';
      return j === segs.length - 1 ? `<path d="${bar(x(i) - bw / 2, yb, bw, yt)}" fill="${k.color}"/>`
        : `<rect x="${r1(x(i) - bw / 2)}" y="${r1(yt)}" width="${r1(bw)}" height="${r1(yb - yt)}" fill="${k.color}"/>`;
    }).join('');
    const t = tip ? tip(d) : `<b>${esc(labelOf(d))}</b><br>${segs.map((k) => `<i style="background:${k.color}"></i>${esc(k.name)} ${fmt(d.parts[k.key])}`).join('<br>')}`;
    return marks + hit(i, step, h, x, t);
  });
  return `${f.open}${f.grid}${out.join('')}${xLabels(items, x, h, labelOf)}</svg>`;
}

// One series that can go below zero (e.g. a vehicle's diesel balance per trip):
// up bars in `up`, down bars in `down`.
export function signedBars(items, { h = 180, fmt = money, label = 'Chart', labelOf, tip, up = 'var(--s-1)', down = 'var(--s-neg)' } = {}) {
  const vals = items.map((d) => d.value);
  const f = frame(h, Math.min(0, ...vals), Math.max(0, ...vals), fmt, label);
  const step = (W - PAD.l - PAD.r) / Math.max(1, items.length);
  const bw = Math.max(2, Math.min(22, step - 3));
  const x = (i) => PAD.l + step * i + step / 2;
  const base = f.y(0);
  const out = items.map((d, i) => `<path d="${bar(x(i) - bw / 2, base, bw, f.y(d.value))}" fill="${d.value < 0 ? down : up}"/>${hit(i, step, h, x, tip(d))}`);
  return `${f.open}${f.grid}${out.join('')}${xLabels(items, x, h, labelOf)}</svg>`;
}

export function legend(series) {
  return `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

// ---- browser: tooltip + crosshair ---------------------------------------------------------------
export function bindCharts(root) {
  let tip = document.getElementById('chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chart-tip';
    tip.setAttribute('role', 'status');
    document.body.append(tip);
  }
  const hide = () => {
    tip.classList.remove('on');
    root.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
  };
  const show = (el, ev) => {
    root.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
    el.classList.add('on');
    tip.innerHTML = el.dataset.tip;
    tip.classList.add('on');
    const rect = el.getBoundingClientRect();
    const px = ev && ev.clientX != null ? ev.clientX : rect.left + rect.width / 2;
    const py = ev && ev.clientY != null ? ev.clientY : rect.top;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, px - tw / 2))}px`;
    tip.style.top = `${Math.max(8, py - tip.offsetHeight - 14)}px`;
  };
  root.querySelectorAll('.chart .hit').forEach((el) => {
    el.addEventListener('pointerenter', (e) => show(el, e));
    el.addEventListener('pointermove', (e) => show(el, e));
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    el.addEventListener('click', (e) => show(el, e));
  });
  root.addEventListener('pointerdown', (e) => { if (!e.target.closest('.hit')) hide(); });
}
