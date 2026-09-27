// Shared bits of the decanting UI: formatting, dialogs and the small drawings
// (tank gauge, tanker chambers, status badges).

import { PRODUCTS, dipAtLitres, round2 } from './core.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Product colours (validated as a set on the dark surface; they also match the
// automation's own: HSD blue, MS orange, XtraGreen green).
export const PRODUCT_COLOR = { HSD: '#3987e5', MS: '#d95926', XG: '#199e70' };
export const productShort = (k) => PRODUCTS[k]?.short || k || '—';

export function fmtL(l, digits = 0) {
  if (!Number.isFinite(l)) return '—';
  return `${Number(l).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })} L`;
}
export function fmtNum(n, digits = 0) {
  if (!Number.isFinite(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtKL(l) {
  if (!Number.isFinite(l)) return '—';
  const kl = l / 1000;
  return `${kl.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KL`;
}
export function fmtSigned(l, unit = ' L', digits = 0) {
  if (!Number.isFinite(l)) return '—';
  const s = Math.abs(l).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${l > 0 ? '+' : l < 0 ? '−' : '±'}${s}${unit}`;
}
export function fmtPct(p) {
  if (!Number.isFinite(p)) return '—';
  return `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p).toFixed(2)}%`;
}
export function fmtDip(cm) {
  return Number.isFinite(cm) ? `${cm.toFixed(1)} cm` : '—';
}
export function fmtMoney(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '−' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
}

const IST = 330 * 60000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function istParts(t) {
  const d = new Date((typeof t === 'number' ? t : Date.parse(t)) + IST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}
export function fmtTime(t) {
  if (!t) return '—';
  const p = istParts(t);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}
export function fmtDate(t, withYear = false) {
  if (!t) return '—';
  const p = istParts(t);
  return `${p.d} ${MON[p.m]}${withYear ? ` ${p.y}` : ''}`;
}
export function fmtWhen(t) {
  if (!t) return '—';
  const today = istParts(Date.now());
  const p = istParts(t);
  const sameDay = p.y === today.y && p.m === today.m && p.d === today.d;
  return sameDay ? `today ${fmtTime(t)}` : `${fmtDate(t)} ${fmtTime(t)}`;
}
export function fmtIsoDay(iso, long = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return long ? `${d} ${MON[m - 1]} ${y}` : `${d} ${MON[m - 1]}`;
}
export function ago(t) {
  if (!t) return '';
  const min = (Date.now() - Date.parse(t)) / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h ${Math.round(min % 60)} min ago`;
  return `${Math.round(min / 1440)} days ago`;
}
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Toast & dialogs
// ---------------------------------------------------------------------------

export function toast(msg, ms = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

let sheetClose = null;
// A bottom sheet (a centred dialog on wide screens). `render(body)` fills it
// and may return a cleanup function.
export function openSheet(title, render, { wide = false } = {}) {
  closeSheet();
  const root = document.getElementById('sheet');
  root.innerHTML = `<div class="sheet-back" data-close></div>
    <div class="sheet-card${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h3>${esc(title)}</h3><button class="btn sm ghost" data-close aria-label="Close">✕</button></div>
      <div class="sheet-body"></div>
    </div>`;
  root.hidden = false;
  document.body.classList.add('noscroll');
  const body = root.querySelector('.sheet-body');
  const cleanup = render(body);
  const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
  root.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => closeSheet()));
  document.addEventListener('keydown', onKey);
  sheetClose = () => {
    document.removeEventListener('keydown', onKey);
    if (typeof cleanup === 'function') cleanup();
    root.hidden = true;
    root.innerHTML = '';
    document.body.classList.remove('noscroll');
  };
  return body;
}
export function closeSheet() {
  const f = sheetClose;
  sheetClose = null;
  if (f) f();
}

// Promise-based confirm in the app's style.
export function ask(title, html, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeSheet();
      resolve(v);
    };
    openSheet(title, (body) => {
      body.innerHTML = `<div class="ask-text">${html}</div>
        <div class="row-actions"><button class="btn" data-no>${esc(cancel)}</button>
        <button class="cta${danger ? ' danger' : ''}" data-yes>${esc(ok)}</button></div>`;
      body.querySelector('[data-yes]').onclick = () => finish(true);
      body.querySelector('[data-no]').onclick = () => finish(false);
      return () => finish(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Little drawings
// ---------------------------------------------------------------------------

export function productChip(key, extra = '') {
  return `<span class="pchip" style="--pc:${PRODUCT_COLOR[key] || '#898781'}"><i></i>${esc(productShort(key))}${extra ? ` <b>${extra}</b>` : ''}</span>`;
}

export function bandBadge(band, direction) {
  if (!band) return '';
  const label = { ok: 'OK', watch: 'Watch', high: direction === 'excess' ? 'High excess' : 'High short' }[band];
  const icon = { ok: '✓', watch: '!', high: '✕' }[band];
  return `<span class="badge ${band}"><i aria-hidden="true">${icon}</i>${label}</span>`;
}

export function confBadge(conf, checks) {
  const tips = [];
  if (checks?.sum?.ok) tips.push('volume + room = capacity');
  if (checks?.chart?.ok) tips.push('matches the dip chart');
  if (checks?.corrected?.length) tips.push(`fixed a misread ${checks.corrected.join(' & ')}`);
  const label = { high: 'Checked', medium: 'Fixed & checked', low: 'Please check' }[conf] || '';
  if (!label) return '';
  return `<span class="badge ${conf === 'low' ? 'high' : conf === 'medium' ? 'watch' : 'ok'}" title="${esc(tips.join(' · '))}"><i aria-hidden="true">${conf === 'low' ? '!' : '✓'}</i>${label}</span>`;
}

// The automation's tank drawing: a capsule filled to the stock level, with an
// optional brighter layer for what's about to go in.
let gaugeSeq = 0;
export function tankGauge({ product, volume, capacity = 20000, incoming = 0, label = '' }) {
  const clip = `gc${++gaugeSeq}`;
  const c = PRODUCT_COLOR[product] || '#898781';
  const W = 120;
  const H = 54;
  const f = Math.max(0, Math.min(1, (volume || 0) / capacity));
  const g = Math.max(0, Math.min(1 - f, (incoming || 0) / capacity));
  const innerH = H - 8;
  const yFill = 4 + innerH * (1 - f);
  const yInc = 4 + innerH * (1 - f - g);
  const pct = Number.isFinite(volume) ? Math.round(f * 100) : null;
  const over = incoming && (volume || 0) + incoming > capacity;
  return `<svg class="gauge" viewBox="0 0 ${W} ${H + 6}" role="img" aria-label="${esc(label || `${pct ?? '—'}% full`)}">
    <defs><clipPath id="${clip}"><rect x="4" y="4" width="${W - 8}" height="${innerH}" rx="${innerH / 2}"/></clipPath></defs>
    <g clip-path="url(#${clip})">
      <rect x="0" y="0" width="${W}" height="${H}" class="gauge-empty"/>
      ${g > 0 ? `<rect x="0" y="${yInc}" width="${W}" height="${yFill - yInc}" fill="${c}" opacity=".38"/>` : ''}
      <rect x="0" y="${yFill}" width="${W}" height="${H}" fill="${c}"/>
    </g>
    <rect x="4" y="4" width="${W - 8}" height="${innerH}" rx="${innerH / 2}" class="gauge-rim${over ? ' over' : ''}"/>
    <rect x="30" y="${H - 1}" width="14" height="5" rx="1.5" class="gauge-leg"/><rect x="${W - 44}" y="${H - 1}" width="14" height="5" rx="1.5" class="gauge-leg"/>
    ${pct !== null ? `<text x="${W / 2}" y="${H / 2 + 5}" text-anchor="middle" class="gauge-pct">${pct}%</text>` : ''}
  </svg>`;
}

// The tank truck from the side: a cab and one box per chamber (width by size),
// coloured by product. opts.target(no) -> label under a chamber ('T2', 'hold').
export function truckStrip(chambers, { done = new Set(), target = null, active = null, onTap = false } = {}) {
  const total = chambers.reduce((a, c) => a + Math.max(c.litres, 1500), 0) || 1;
  const cells = chambers.map((c) => {
    const w = (Math.max(c.litres, 1500) / total) * 100;
    const col = PRODUCT_COLOR[c.product] || '#5a5550';
    const isDone = done.has(c.no);
    const t = target ? target(c.no) : null;
    const cls = ['ch', isDone ? 'done' : '', c.product ? '' : 'empty', active && active.has(c.no) ? 'active' : '', onTap && !isDone && c.product ? 'tap' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" style="flex:${w};--pc:${col}" ${onTap && !isDone && c.product ? `data-ch="${c.no}" role="button" tabindex="0"` : ''}
      aria-label="Chamber ${c.no}, ${fmtKL(c.litres)} ${esc(productShort(c.product) || 'empty')}${isDone ? ', decanted' : ''}">
      <div class="ch-fill"></div>
      <div class="ch-lab"><b>C${c.no}</b><span>${fmtKL(c.litres).replace(' KL', '')}<small> KL</small></span><em>${isDone ? 'done' : esc(productShort(c.product) || 'empty')}</em></div>
      ${t ? `<div class="ch-to ${t === 'hold' ? 'hold' : ''}">${t === 'hold' ? 'hold' : `→ ${esc(t)}`}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="truck"><div class="truck-cab" aria-hidden="true"></div><div class="truck-body">${cells}</div></div>`;
}

export function dipLine(chart, litres) {
  const d = dipAtLitres(chart, litres);
  return Number.isFinite(d) ? fmtDip(round2(d)) : '—';
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
