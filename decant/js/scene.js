// The decanting scene: the tank truck side on (our OD23U8210's livery — navy
// top, white body, orange band), a sight glass per chamber, the bottom-loading
// valves at the front, hoses to the fill points on the curb, and the
// underground tanks. While a tank decants its hoses run in the product's
// colour, product drops into the tank and its planned level shimmers; a tank
// settling sits at its new level; a tank done shows its stock after.
// Plain SVG — CSS (index.html, "decanting scene") animates it and keeps it
// still for reduced motion.

import { tankStage } from './core.js';
import { PRODUCT_COLOR, esc } from './ui.js';

const W = 360;
const H = 240;
const BODY = { x0: 58, x1: 304, top: 16, navy: 28, orange: 64, bottom: 86 };
const GLASS = { top: 34, bottom: 60 };
const OUTLET_Y = 101;
const GROUND = 115;
const CURB = 134;
const SOIL = 146;
const TANK = { top: 160, bottom: 204, half: 37 };
const WAVE = 12;                                         // wave length (the CSS moves it by this)
const INK = '#15110f';
const colorOf = (p) => PRODUCT_COLOR[p] || '#8a8178';
let seq = 0;

// A liquid from `top` down to `bottom`, with a moving wave on top when `wave`.
function liquid(x0, x1, top, bottom, color, { wave = false, cls = '', opacity = 1 } = {}) {
  if (bottom - top < 0.5) return '';
  const o = opacity < 1 ? ` opacity="${opacity}"` : '';
  if (!wave) return `<rect x="${x0}" y="${top}" width="${x1 - x0}" height="${bottom - top}" fill="${color}"${o}${cls ? ` class="${cls}"` : ''}/>`;
  let d = `M${x0 - WAVE} ${top}`;
  for (let x = x0 - WAVE; x < x1 + WAVE; x += WAVE) d += ` q${WAVE / 4} -1.6 ${WAVE / 2} 0 t${WAVE / 2} 0`;
  d += ` V${bottom} H${x0 - WAVE} Z`;
  return `<path class="wave${cls ? ` ${cls}` : ''}" d="${d}" fill="${color}"${o}/>`;
}

// s: a session; tanks: the settings' tanks; stock: the latest reading per tank
// (for the tanks this truck doesn't fill). compact: for the Home card.
export function decantScene(s, { tanks = [], stock = {}, compact = false } = {}) {
  const id = `ds${++seq}`;
  const d = s.data || {};
  const rows = d.tanks || [];
  const stageOf = (row) => tankStage(s, row);
  const chambers = (d.chambers || []).filter((c) => c.no > 0).sort((a, b) => a.no - b.no);
  const done = new Set(d.done || []);
  const rowOfChamber = new Map(rows.flatMap((r) => r.chambers.map((no) => [no, r])));

  // chambers along the body, by size; the truck's capacity for its name band
  const total = chambers.reduce((a, c) => a + (c.litres || 4000), 0) || 1;
  const capKL = Math.round(chambers.reduce((a, c) => a + (c.litres || 0), 0) / 100) / 10;
  let x = BODY.x0 + 6;
  const span = BODY.x1 - BODY.x0 - 12;
  const cx = chambers.map((c) => {
    const w = ((c.litres || 4000) / total) * span;
    const out = { c, x0: x, x1: x + w, mid: x + w / 2 };
    x += w;
    return out;
  });
  const outletX = (no) => 70 + (no - 1) * Math.min(12.5, 56 / Math.max(1, chambers.length - 1 || 1));

  // the underground tanks and their fill points
  const n = Math.max(1, tanks.length);
  const tx = (i) => 20 + ((W - 40) / n) * (i + 0.5);
  const tankX = new Map(tanks.map((t, i) => [t.id, tx(i)]));

  const defs = [];
  const clip = (name, shape) => { defs.push(`<clipPath id="${id}${name}">${shape}</clipPath>`); return `url(#${id}${name})`; };

  // ---- the truck
  const glasses = cx.map(({ c, x0, x1, mid }) => {
    const row = rowOfChamber.get(c.no);
    const st = row ? stageOf(row) : null;
    const empty = !c.product || done.has(c.no) || st === 'settling' || st === 'read';
    const draining = st === 'decanting' && !done.has(c.no);
    const gw = Math.min(22, (x1 - x0) * 0.5);
    const gx = mid - gw / 2;
    const level = empty ? 0 : draining ? 0.5 : 0.86;
    const top = GLASS.bottom - level * (GLASS.bottom - GLASS.top);
    const cp = clip(`g${c.no}`, `<rect x="${gx}" y="${GLASS.top}" width="${gw}" height="${GLASS.bottom - GLASS.top}" rx="4"/>`);
    return `<g${!row && c.product ? ' opacity=".5"' : ''}>
      <rect x="${gx}" y="${GLASS.top}" width="${gw}" height="${GLASS.bottom - GLASS.top}" rx="4" fill="#20262c" stroke="#8d969e" stroke-width="1"/>
      <g clip-path="${cp}">${liquid(gx, gx + gw, top, GLASS.bottom, colorOf(c.product), { wave: draining })}</g>
      ${draining ? `<circle class="bubble" cx="${mid}" cy="${GLASS.bottom - 3}" r="1.3" fill="#fff" opacity=".6"/>` : ''}
    </g>
    <text x="${mid}" y="${BODY.orange + 10}" class="ds-ch">C${c.no}</text>
    <text x="${mid}" y="${BODY.orange + 18}" class="ds-kl">${Math.round((c.litres || 0) / 100) / 10} KL</text>`;
  }).join('');
  const dividers = cx.slice(1).map(({ x0 }) => `<line x1="${x0}" y1="${BODY.navy}" x2="${x0}" y2="${BODY.bottom}" stroke="#000" stroke-opacity=".16"/>`).join('');
  const bodyClip = clip('body', `<rect x="${BODY.x0}" y="${BODY.top}" width="${BODY.x1 - BODY.x0}" height="${BODY.bottom - BODY.top}" rx="11"/>`);
  const outlets = chambers.map((c) => {
    const row = rowOfChamber.get(c.no);
    const on = row && ['decanting', 'settling'].includes(stageOf(row));
    return `<circle cx="${outletX(c.no)}" cy="${OUTLET_Y}" r="3.4" fill="#cfd5db" stroke="${on ? colorOf(c.product) : '#59616a'}" stroke-width="${on ? 1.6 : 1}"/>`;
  }).join('');
  const truck = `
    <g class="ds-truck">
      <rect x="10" y="32" width="48" height="68" rx="7" fill="#1e3a8a"/>
      <rect x="10" y="64" width="48" height="28" fill="#f4f4f2"/>
      <rect x="14" y="37" width="40" height="3.2" rx="1" fill="#f36a21"/>
      <rect x="14" y="42" width="40" height="17" rx="3" fill="#9fb3c8" opacity=".85"/>
      <rect x="8" y="92" width="52" height="8" rx="2" fill="#86c5de"/>
      <g clip-path="${bodyClip}">
        <rect x="${BODY.x0}" y="${BODY.top}" width="${BODY.x1 - BODY.x0}" height="${BODY.bottom - BODY.top}" fill="#f4f4f2"/>
        <rect x="${BODY.x0}" y="${BODY.top}" width="${BODY.x1 - BODY.x0}" height="${BODY.navy - BODY.top}" fill="#1e3a8a"/>
        <rect x="${BODY.x0}" y="${BODY.orange}" width="${BODY.x1 - BODY.x0}" height="${BODY.bottom - BODY.orange}" fill="#ef6a28"/>
        <rect x="${BODY.x0}" y="${BODY.orange - 1}" width="${BODY.x1 - BODY.x0}" height="1.8" fill="#f5c02a"/>
        ${dividers}
      </g>
      <text x="${(BODY.x0 + BODY.x1) / 2}" y="${BODY.navy - 3.2}" class="ds-livery">${esc([s.tt_no, capKL ? `${capKL} KL` : ''].filter(Boolean).join(' · '))}</text>
      ${glasses}
      <rect x="56" y="${BODY.bottom}" width="${BODY.x1 - 54}" height="6" fill="#86c5de"/>
      <rect x="64" y="${BODY.bottom + 4}" width="66" height="11" rx="2" fill="#a8b0b8" stroke="#6d757d"/>
      ${outlets}
      ${[34, 214, 246].map((wx) => `<circle cx="${wx}" cy="104" r="11.5" fill="#1b1b1b"/><circle cx="${wx}" cy="104" r="4.8" fill="#b9bfc6"/>`).join('')}
    </g>`;

  // ---- hoses: one per chamber, from its valve to its tank's fill point
  const hoses = chambers.map((c) => {
    const row = rowOfChamber.get(c.no);
    if (!row || !tankX.has(row.tank)) return '';
    const st = stageOf(row);
    if (st === 'read' || (done.has(c.no) && st !== 'decanting' && st !== 'settling')) return '';
    const xo = outletX(c.no);
    const xi = tankX.get(row.tank);
    const path = `M${xo} ${OUTLET_Y + 2} C${xo} ${GROUND + 14} ${xi} ${GROUND - 12} ${xi} ${GROUND + 1}`;
    const col = colorOf(c.product);
    if (st === 'waiting') return `<path d="${path}" fill="none" stroke="${col}" stroke-width="1.6" stroke-dasharray="2 4" opacity=".55"/>`;
    const flowing = st === 'decanting';
    return `<path d="${path}" fill="none" stroke="${INK}" stroke-width="5.2" stroke-linecap="round"/>
      <path d="${path}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round"${flowing ? ' class="hose-flow"' : ' opacity=".55"'}/>`;
  }).join('');

  // ---- the ground, fill points and the underground tanks
  const tanksSvg = tanks.map((t) => {
    const xc = tankX.get(t.id);
    const row = rows.find((r) => r.tank === t.id);
    const st = row ? stageOf(row) : null;
    const cap = t.capacity || 20000;
    const yOf = (v) => TANK.bottom - Math.max(0, Math.min(1.02, (v || 0) / cap)) * (TANK.bottom - TANK.top);
    const col = colorOf(t.product);
    const x0 = xc - TANK.half;
    const x1 = xc + TANK.half;
    const cp = clip(`t${t.id}`, `<rect x="${x0}" y="${TANK.top}" width="${x1 - x0}" height="${TANK.bottom - TANK.top}" rx="${(TANK.bottom - TANK.top) / 2}"/>`);
    let inside = '';
    let tag = '';
    if (!row) {
      inside = liquid(x0, x1, yOf(stock[t.id]?.volume), TANK.bottom, col);
    } else {
      const before = row.before?.volume;
      const target = (Number.isFinite(before) ? before : 0) + row.litres;
      if (st === 'waiting') {
        inside = `${liquid(x0, x1, yOf(before), TANK.bottom, col)}
          <rect x="${x0}" y="${yOf(target)}" width="${x1 - x0}" height="${Math.max(0, yOf(before) - yOf(target))}" fill="none" stroke="${col}" stroke-dasharray="3 3" opacity=".8"/>`;
        tag = '<tspan class="ds-next">next</tspan>';
      } else if (st === 'decanting') {
        inside = `${liquid(x0, x1, yOf(target), yOf(before), col, { wave: true, cls: 'filling', opacity: 0.45 })}
          ${liquid(x0, x1, yOf(before), TANK.bottom, col)}
          ${[0, 0.35, 0.7].map((delay) => `<circle class="drop" cx="${xc}" cy="${TANK.top + 12}" r="1.7" fill="${col}" style="animation-delay:${delay}s"/>`).join('')}`;
        tag = '<tspan class="ds-live">decanting</tspan>';
      } else if (st === 'settling') {
        inside = liquid(x0, x1, yOf(target), TANK.bottom, col, { wave: true, cls: 'slow' });
        tag = '<tspan class="ds-settle">settling</tspan>';
      } else {
        inside = liquid(x0, x1, yOf(row.after?.volume ?? target), TANK.bottom, col);
        tag = '<tspan class="ds-done">done ✓</tspan>';
      }
    }
    return `<g${row ? '' : ' opacity=".42"'}>
      <rect x="${xc - 3.5}" y="${GROUND + 4}" width="7" height="${CURB - GROUND - 4}" fill="#2a2a2a"/>
      <rect x="${xc - 5.5}" y="${GROUND}" width="11" height="4.5" rx="1.2" fill="${col}"/>
      <line x1="${xc}" y1="${SOIL}" x2="${xc}" y2="${TANK.top + 10}" stroke="#5b544e" stroke-width="3"/>
      <rect x="${x0}" y="${TANK.top}" width="${x1 - x0}" height="${TANK.bottom - TANK.top}" rx="${(TANK.bottom - TANK.top) / 2}" fill="#191512"/>
      <g clip-path="${cp}">${inside}</g>
      <rect x="${x0}" y="${TANK.top}" width="${x1 - x0}" height="${TANK.bottom - TANK.top}" rx="${(TANK.bottom - TANK.top) / 2}" fill="none" stroke="#7d746c" stroke-width="1.4"/>
      <text x="${xc}" y="${TANK.bottom + 15}" class="ds-tank">Tank ${t.no}<tspan fill="${col}"> ${esc(t.product)}</tspan></text>
      ${tag ? `<text x="${xc}" y="${TANK.bottom + 27}" class="ds-stage">${tag}</text>` : ''}
    </g>`;
  }).join('');

  const said = rows.map((r) => `C${r.chambers.join(',')} into Tank ${tanks.find((t) => t.id === r.tank)?.no ?? r.tank} (${{ waiting: 'next', decanting: 'decanting', settling: 'settling', read: 'done' }[stageOf(r)]})`).join('; ');
  return `<svg class="dscene${compact ? ' compact' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${s.tt_no || 'Truck'}: ${said}`)}">
    <defs>${defs.join('')}
      <linearGradient id="${id}soil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1e16"/><stop offset="1" stop-color="#140e0a"/></linearGradient>
    </defs>
    <!-- the ground runs past the sides, so a wide card shows the whole site -->
    <rect x="-1000" y="${GROUND}" width="${W + 2000}" height="${SOIL - GROUND}" fill="#2b2826"/>
    <rect x="-1000" y="${CURB}" width="${W + 2000}" height="${SOIL - CURB}" fill="#57524c"/>
    <rect x="-1000" y="${CURB}" width="${W + 2000}" height="1.4" fill="#76706a"/>
    <rect x="-1000" y="${SOIL}" width="${W + 2000}" height="${H - SOIL}" fill="url(#${id}soil)"/>
    ${tanksSvg}
    ${truck}
    ${hoses}
  </svg>`;
}
