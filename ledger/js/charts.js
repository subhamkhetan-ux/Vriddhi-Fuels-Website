// Small SVG charts for the Home dashboard (no library). Each builder returns
// markup; every bar / day carries a data-tip with its numbers and
// bindCharts() (browser) turns those into a tooltip + crosshair.
// Colours are CSS variables from index.html (validated as a set for the dark
// surface): --s-hsd / --s-ms / --s-xg for the products, --s-sales / --s-paid.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;

export const SERIES = {
  HSD: { name: 'Diesel', color: 'var(--s-hsd)' },
  MS: { name: 'Petrol', color: 'var(--s-ms)' },
  XG: { name: 'XtraGreen', color: 'var(--s-xg)' },
};

// ---- numbers ---------------------------------------------------------------------

function indian(n, digits = 0) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
// ₹1.23 Cr / ₹4.56 L / ₹7.8 K / ₹950
export function money(n, { exact = false } = {}) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (exact || a < 1000) return `${s}₹${indian(a, a < 1000 && a % 1 ? 2 : 0)}`;
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`;
  return `${s}₹${(a / 1e3).toFixed(1)} K`;
}
// 12,345 L / 1.23 lakh L
export function litres(n) {
  const a = Math.abs(Number(n) || 0);
  if (a >= 1e5) return `${(a / 1e5).toFixed(2)} lakh L`;
  return `${indian(a, a < 100 && a % 1 ? 1 : 0)} L`;
}
export const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(iso.slice(5, 7)) - 1]}`;
export const monthName = (m) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

// ---- axes ------------------------------------------------------------------------------

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

let W = 640;
// Draw at the real width of the card so text stays 11px on any screen.
export function setChartWidth(w) { W = Math.max(280, Math.round(w)); }
const PAD = { l: 52, r: 8, t: 10, b: 24 };

function frame(h, max, fmt, extra = '') {
  const y = (v) => PAD.t + (h - PAD.t - PAD.b) * (1 - v / max);
  const grid = [0, 0.5, 1].map((f) => {
    const v = max * f;
    return `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${r1(y(v))}" y2="${r1(y(v))}" class="gl"/>
      <text x="${PAD.l - 6}" y="${r1(y(v) + 4)}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`;
  }).join('');
  return { y, grid, open: `<svg viewBox="0 0 ${W} ${h}" class="chart" role="img" ${extra}>` };
}

// top-rounded bar (4px ends on the data side, square on the baseline)
function bar(x, y0, w, h, r = 3) {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${r1(x)},${r1(y0)} v${r1(-(h - rr))} q0,${r1(-rr)} ${r1(rr)},${r1(-rr)} h${r1(w - 2 * rr)} q${r1(rr)},0 ${r1(rr)},${r1(rr)} v${r1(h - rr)} z`;
}

function xLabels(items, x, h, label) {
  const n = items.length;
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - PAD.l - PAD.r) / 64))));   // ~64px per label
  return items.map((it, i) => ((i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2)
    ? `<text x="${r1(x(i))}" y="${h - 6}" class="tick" text-anchor="middle">${esc(label(it))}</text>` : '')).join('');
}

// ---- charts --------------------------------------------------------------------------------

// Litres per day, stacked by product. days: [{date, qty:{HSD,MS,XG}, amount, earning}]
export function dailyVolumeChart(days, { h = 220, labelOf = (d) => shortDate(d.date), tipLabel = (d) => shortDate(d.date) } = {}) {
  const keys = ['HSD', 'MS', 'XG'];
  const tot = (d) => keys.reduce((a, k) => a + d.qty[k], 0);
  const max = niceMax(Math.max(0, ...days.map(tot)));
  const f = frame(h, max, (v) => (v >= 1000 ? `${r1(v / 1000)}k` : `${Math.round(v)}`), 'aria-label="Litres sold per day, by product"');
  const step = (W - PAD.l - PAD.r) / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(22, step - 2));
  const x = (i) => PAD.l + step * i + step / 2;
  const out = [];
  days.forEach((d, i) => {
    const segs = keys.filter((k) => d.qty[k] > 0);
    let cum = 0;
    segs.forEach((k, j) => {
      const yb = f.y(cum) - (j ? 2 : 0);                           // 2px surface gap between stacked fills
      cum += d.qty[k];
      const yt = f.y(cum);
      const hgt = yb - yt;
      if (hgt <= 0.5) return;
      out.push(j === segs.length - 1
        ? `<path d="${bar(x(i) - bw / 2, yb, bw, hgt)}" fill="${SERIES[k].color}"/>`
        : `<rect x="${r1(x(i) - bw / 2)}" y="${r1(yt)}" width="${r1(bw)}" height="${r1(hgt)}" fill="${SERIES[k].color}"/>`);
    });
    const tip = [`<b>${esc(tipLabel(d))}</b>`, ...keys.filter((k) => d.qty[k] > 0).map((k) => `<i style="background:${SERIES[k].color}"></i>${SERIES[k].name} ${litres(d.qty[k])}`),
      tot(d) ? `Sales ${money(d.amount)} · Earned ${money(d.earning)}` : 'No sales'].join('<br>');
    out.push(`<rect x="${r1(PAD.l + step * i)}" y="${PAD.t}" width="${r1(step)}" height="${r1(h - PAD.t - PAD.b)}" class="hit" data-x="${r1(x(i))}" data-tip="${esc(tip)}"/>`);
  });
  return `${f.open}${f.grid}${out.join('')}${xLabels(days, x, h, labelOf)}</svg>`;
}

// One series of bars (e.g. earnings per day). items: [{label, value, tip}]
export function barChart(items, { h = 160, color = 'var(--s-earn)', fmt = money, label = 'Chart' } = {}) {
  const max = niceMax(Math.max(0, ...items.map((d) => d.value)));
  const f = frame(h, max, (v) => fmt(v), `aria-label="${esc(label)}"`);
  const step = (W - PAD.l - PAD.r) / Math.max(1, items.length);
  const bw = Math.max(2, Math.min(22, step - 2));
  const x = (i) => PAD.l + step * i + step / 2;
  const base = f.y(0);
  const out = items.map((d, i) => `${d.value > 0 ? `<path d="${bar(x(i) - bw / 2, base, bw, base - f.y(d.value))}" fill="${color}"/>` : ''}
    <rect x="${r1(PAD.l + step * i)}" y="${PAD.t}" width="${r1(step)}" height="${r1(h - PAD.t - PAD.b)}" class="hit" data-x="${r1(x(i))}" data-tip="${esc(d.tip)}"/>`);
  return `${f.open}${f.grid}${out.join('')}${xLabels(items, x, h, (d) => d.label)}</svg>`;
}

// Sales vs collections per month (same unit, one axis). months: [{month, amount, paid, earning}]
export function monthlyChart(months, { h = 200 } = {}) {
  const max = niceMax(Math.max(0, ...months.flatMap((m) => [m.amount, m.paid])));
  const f = frame(h, max, (v) => money(v), 'aria-label="Sales and collections per month"');
  const step = (W - PAD.l - PAD.r) / Math.max(1, months.length);
  const bw = Math.max(3, Math.min(20, (step - 8) / 2));
  const x = (i) => PAD.l + step * i + step / 2;
  const base = f.y(0);
  const out = months.map((m, i) => {
    const tip = [`<b>${monthName(m.month)}</b>`, `<i style="background:var(--s-sales)"></i>Sales ${money(m.amount)}`,
      `<i style="background:var(--s-paid)"></i>Collections ${money(m.paid)}`, `Earned ${money(m.earning)}`].join('<br>');
    return `<path d="${bar(x(i) - bw - 1, base, bw, base - f.y(m.amount))}" fill="var(--s-sales)"/>
      <path d="${bar(x(i) + 1, base, bw, base - f.y(m.paid))}" fill="var(--s-paid)"/>
      <rect x="${r1(PAD.l + step * i)}" y="${PAD.t}" width="${r1(step)}" height="${r1(h - PAD.t - PAD.b)}" class="hit" data-x="${r1(x(i))}" data-tip="${esc(tip)}"/>`;
  });
  return `${f.open}${f.grid}${out.join('')}${xLabels(months, x, h, (m) => monthName(m.month))}</svg>`;
}

// Day's RSP per product (₹/L). series: {HSD: [{date, rsp}], …}
export function rspChart(series, { h = 200 } = {}) {
  const keys = Object.keys(SERIES).filter((k) => (series[k] || []).some((d) => d.rsp != null));
  const vals = keys.flatMap((k) => series[k].map((d) => d.rsp).filter((v) => v != null));
  if (!vals.length) return '';
  const lo = Math.floor(Math.min(...vals) - 1);
  const hi = Math.ceil(Math.max(...vals) + 1);
  const days = series[keys[0]];
  const y = (v) => PAD.t + (h - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  const step = (W - PAD.l - PAD.r) / Math.max(1, days.length - 1 || 1);
  const x = (i) => PAD.l + (days.length > 1 ? step * i : (W - PAD.l - PAD.r) / 2);
  const grid = [lo, (lo + hi) / 2, hi].map((v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${r1(y(v))}" y2="${r1(y(v))}" class="gl"/>
    <text x="${PAD.l - 6}" y="${r1(y(v) + 4)}" class="tick" text-anchor="end">₹${r1(v)}</text>`).join('');
  const lines = keys.map((k) => {
    let d = '';
    let pen = false;
    series[k].forEach((p, i) => {
      if (p.rsp == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${r1(x(i))},${r1(y(p.rsp))}`;
      pen = true;
    });
    return `<path d="${d}" fill="none" stroke="${SERIES[k].color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const hits = days.map((d, i) => {
    const tip = [`<b>${shortDate(d.date)}</b>`, ...keys.map((k) => `<i style="background:${SERIES[k].color}"></i>${SERIES[k].name} ${series[k][i].rsp != null ? `₹${series[k][i].rsp.toFixed(2)}` : '—'}`)].join('<br>');
    const w = days.length > 1 ? step : W - PAD.l - PAD.r;
    return `<rect x="${r1(x(i) - w / 2)}" y="${PAD.t}" width="${r1(w)}" height="${r1(h - PAD.t - PAD.b)}" class="hit" data-x="${r1(x(i))}" data-tip="${esc(tip)}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${h}" class="chart" role="img" aria-label="Day's RSP per product">${grid}${lines}<line class="xhair" x1="0" x2="0" y1="${PAD.t}" y2="${h - PAD.b}" visibility="hidden"/>${hits}${xLabels(days, x, h, (d) => shortDate(d.date))}</svg>`;
}

export function legend(keys) {
  return `<div class="legend">${keys.map((k) => `<span><i style="background:${(SERIES[k] || {}).color || k.color}"></i>${esc((SERIES[k] || {}).name || k.name)}</span>`).join('')}</div>`;
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
    root.querySelectorAll('.xhair').forEach((l) => l.setAttribute('visibility', 'hidden'));
    root.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
  };
  const show = (hit, ev) => {
    root.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
    hit.classList.add('on');
    tip.innerHTML = hit.dataset.tip;
    tip.classList.add('on');
    const svg = hit.ownerSVGElement;
    const line = svg && svg.querySelector('.xhair');
    if (line) {
      line.setAttribute('x1', hit.dataset.x);
      line.setAttribute('x2', hit.dataset.x);
      line.setAttribute('visibility', 'visible');
    }
    const rect = hit.getBoundingClientRect();
    const px = ev && ev.clientX != null ? ev.clientX : rect.left + rect.width / 2;
    const py = ev && ev.clientY != null ? ev.clientY : rect.top;
    const tw = tip.offsetWidth;
    const left = Math.min(window.innerWidth - tw - 8, Math.max(8, px - tw / 2));
    tip.style.left = `${left}px`;                                   // position: fixed — never widens the page
    tip.style.top = `${Math.max(8, py - tip.offsetHeight - 14)}px`;
  };
  root.querySelectorAll('.chart .hit').forEach((hit) => {
    hit.addEventListener('pointerenter', (e) => show(hit, e));
    hit.addEventListener('pointermove', (e) => show(hit, e));
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    hit.addEventListener('click', (e) => show(hit, e));
  });
  root.addEventListener('pointerdown', (e) => { if (!e.target.closest('.hit')) hide(); });
}
