// The decanting scene: the tank truck side on (our OD23U8210's livery — navy
// top, white body, orange band), a sight glass per chamber, the bottom-loading
// valves at the front, and the underground tanks. As on the forecourt, each
// tank being filled has one pipe: it sits on one chamber's valve and moves to
// the tank's next chamber once that one is empty. Chambers stay full until
// their turn; the one on the pipe empties over its real time (Settings: 5 KL
// 8:15, 4 KL 7:00) while the tank rises by what it gives, and once all should
// be empty the pipe stops. A tank settling sits at its new level; a tank done
// shows its stock after.
// Plain SVG, drawn as things are now; tickScenes() moves the levels and pipes
// on every second, and CSS (index.html, "decanting scene") runs the ripples
// and the flow — still for reduced motion.

import { drainAt, drainTimeline, tankStage } from './core.js';
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
const FULL = 0.92;                                       // a full chamber's level in its sight glass
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

// Where things are drawn for a level — shared by the drawing and the ticker.
const r1 = (v) => Math.round(v * 10) / 10;
// an empty glass hides its liquid altogether (no ripple left at the bottom)
const glassY = (level) => (level <= 0.001 ? GLASS.bottom + 3 : r1(GLASS.bottom - level * (GLASS.bottom - GLASS.top)));
const tankY = (litres, cap) => r1(TANK.bottom - Math.max(0, Math.min(1.02, (litres || 0) / cap)) * (TANK.bottom - TANK.top));
// sag: each pipe hangs a little differently, so two side by side stay apart
const pipeD = (xo, xi, sag = 0) => `M${xo} ${OUTLET_Y + 2} C${xo} ${GROUND + 14 + sag} ${xi} ${GROUND - 12 + sag / 2} ${xi} ${GROUND + 1}`;
const part = (now, from, to) => Math.min(1, Math.max(0, (now - from) / (to - from)));

// s: a session; tanks: the settings' tanks; stock: the latest reading per tank
// (for the tanks this truck doesn't fill); settings: for the chambers' times.
// compact: for the Home card.
export function decantScene(s, { tanks = [], stock = {}, compact = false, settings = null, now = Date.now() } = {}) {
  const id = `ds${++seq}`;
  const d = s.data || {};
  const rows = d.tanks || [];
  const stageOf = (row) => tankStage(s, row);
  const chambers = (d.chambers || []).filter((c) => c.no > 0).sort((a, b) => a.no - b.no);
  const done = new Set(d.done || []);
  const rowOfChamber = new Map(rows.flatMap((r) => r.chambers.map((no) => [no, r])));
  // each tank decanting: its pipe's round, and where it is now
  const round = new Map(rows.filter((r) => stageOf(r) === 'decanting').map((r) => {
    const tl = drainTimeline(r, chambers, settings);
    return [r, { tl, at: drainAt(tl, now) }];
  }));
  const anim = { g: [], t: [], p: [] };                  // what tickScenes moves on

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
  const outletX = (no) => r1(70 + (no - 1) * Math.min(12.5, 56 / Math.max(1, chambers.length - 1 || 1)));

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
    const rd = row && round.get(row);
    const win = rd?.tl.find((w) => w.no === c.no);
    let level = FULL;
    if (!c.product || done.has(c.no) || st === 'settling' || st === 'read') level = 0;
    else if (win) level = FULL * (1 - part(now, win.from, win.to));
    const gw = Math.min(22, (x1 - x0) * 0.5);
    const gx = mid - gw / 2;
    const gh = GLASS.bottom - GLASS.top;
    const cp = clip(`g${c.no}`, `<rect x="${gx}" y="${GLASS.top}" width="${gw}" height="${gh}" rx="4"/>`);
    const on = Boolean(win) && now >= win.from && now < win.to;    // emptying now
    if (win) anim.g.push({ k: `${c.no}`, from: win.from, to: win.to });
    // the liquid is drawn from 0 and moved down to its level (the glass clips it)
    return `<g class="gl${on ? ' on' : ''}" data-k="g${c.no}"${!row && c.product ? ' opacity=".5"' : ''}>
      <rect x="${gx}" y="${GLASS.top}" width="${gw}" height="${gh}" rx="4" fill="#20262c" stroke="#8d969e" stroke-width="1"/>
      <g clip-path="${cp}"><g data-k="l${c.no}" transform="translate(0 ${glassY(level)})">${level > 0 || win ? liquid(gx, gx + gw, 0, gh + 2, colorOf(c.product), { wave: Boolean(win) }) : ''}</g></g>
      ${win ? `<circle class="bubble" cx="${mid}" cy="${GLASS.bottom - 3}" r="1.3" fill="#fff" opacity=".6"/>` : ''}
    </g>
    <text x="${mid}" y="${BODY.orange + 10}" class="ds-ch">C${c.no}</text>
    <text x="${mid}" y="${BODY.orange + 18}" class="ds-kl">${Math.round((c.litres || 0) / 100) / 10} KL</text>`;
  }).join('');
  const dividers = cx.slice(1).map(({ x0 }) => `<line x1="${x0}" y1="${BODY.navy}" x2="${x0}" y2="${BODY.bottom}" stroke="#000" stroke-opacity=".16"/>`).join('');
  const bodyClip = clip('body', `<rect x="${BODY.x0}" y="${BODY.top}" width="${BODY.x1 - BODY.x0}" height="${BODY.bottom - BODY.top}" rx="11"/>`);
  const outlets = chambers.map((c) => `<circle cx="${outletX(c.no)}" cy="${OUTLET_Y}" r="3.4" fill="#cfd5db" stroke="#59616a" stroke-width="1"/>`).join('');
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

  // ---- one pipe per tank: from the valve of the chamber it's on to the tank's fill point
  const pipes = rows.map((row) => {
    const st = stageOf(row);
    if (st === 'read' || !tankX.has(row.tank) || !row.chambers.length) return '';
    const xi = r1(tankX.get(row.tank));
    const col = colorOf(row.product);
    const sag = (tanks.findIndex((t) => t.id === row.tank) % 3) * 6;
    if (st === 'waiting') {                            // not on yet: where it will go first
      return `<path d="${pipeD(outletX(row.chambers[0]), xi, sag)}" fill="none" stroke="${col}" stroke-width="1.6" stroke-dasharray="2 4" opacity=".55"/>`;
    }
    const rd = round.get(row);
    const onNo = st === 'settling' ? row.chambers[row.chambers.length - 1] : rd?.at ? rd.at.on : row.chambers[0];
    const flowing = st === 'decanting' && (rd?.at ? rd.at.flowing : true);
    const xo = outletX(onNo);
    if (rd?.tl.length) anim.p.push({ k: `p${row.tank}`, xi, sag, wins: rd.tl.map((w) => [w.from, w.to, outletX(w.no)]) });
    return `<g class="dp${flowing ? ' flowing' : ''}${st === 'settling' ? ' still' : ''}" data-k="p${row.tank}">
      <path class="hose" d="${pipeD(xo, xi, sag)}" fill="none" stroke="${INK}" stroke-width="5.2" stroke-linecap="round"/>
      <path class="hose-in" d="${pipeD(xo, xi, sag)}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linecap="round"/>
      <circle class="coupling" cx="${xo}" cy="${OUTLET_Y}" r="3.6" fill="${INK}" stroke="${col}" stroke-width="1.6"/>
    </g>`;
  }).join('');

  // ---- the ground, fill points and the underground tanks
  const tanksSvg = tanks.map((t) => {
    const xc = tankX.get(t.id);
    const row = rows.find((r) => r.tank === t.id);
    const st = row ? stageOf(row) : null;
    const cap = t.capacity || 20000;
    const col = colorOf(t.product);
    const x0 = xc - TANK.half;
    const x1 = xc + TANK.half;
    const th = TANK.bottom - TANK.top;
    const cp = clip(`t${t.id}`, `<rect x="${x0}" y="${TANK.top}" width="${x1 - x0}" height="${th}" rx="${th / 2}"/>`);
    let inside = '';
    let tag = '';
    let flowing = false;
    if (!row) {
      inside = liquid(x0, x1, tankY(stock[t.id]?.volume, cap), TANK.bottom, col);
    } else {
      const before = Number.isFinite(row.before?.volume) ? row.before.volume : 0;
      const target = before + row.litres;
      const outline = `<rect x="${x0}" y="${tankY(target, cap)}" width="${x1 - x0}" height="${Math.max(0, tankY(before, cap) - tankY(target, cap))}" fill="none" stroke="${col}" stroke-dasharray="3 3" opacity=".8"/>`;
      if (st === 'waiting') {
        inside = `${liquid(x0, x1, tankY(before, cap), TANK.bottom, col)}${outline}`;
        tag = '<tspan class="ds-next">next</tspan>';
      } else if (st === 'decanting') {
        const rd = round.get(row);
        flowing = rd?.at ? rd.at.flowing : true;
        const now1 = before + (rd?.at?.litres || 0);
        if (rd?.tl.length) anim.t.push({ k: `t${t.id}`, before, cap, wins: rd.tl.map((w) => [w.from, w.to, w.litres]) });
        inside = `<g data-k="t${t.id}" transform="translate(0 ${tankY(now1, cap)})">${liquid(x0, x1, 0, th + 2, col, { wave: true })}</g>
          ${outline}
          ${[0, 0.35, 0.7].map((delay) => `<circle class="drop" cx="${xc}" cy="${TANK.top + 12}" r="1.7" fill="${col}" style="animation-delay:${delay}s"/>`).join('')}`;
        tag = '<tspan class="ds-live">decanting</tspan>';
      } else if (st === 'settling') {
        inside = liquid(x0, x1, tankY(target, cap), TANK.bottom, col, { wave: true, cls: 'slow' });
        tag = '<tspan class="ds-settle">settling</tspan>';
      } else {
        inside = liquid(x0, x1, tankY(row.after?.volume ?? target, cap), TANK.bottom, col);
        tag = '<tspan class="ds-done">done ✓</tspan>';
      }
    }
    return `<g class="dt${flowing ? ' flowing' : ''}" data-k="d${t.id}"${row ? '' : ' opacity=".42"'}>
      <rect x="${xc - 3.5}" y="${GROUND + 4}" width="7" height="${CURB - GROUND - 4}" fill="#2a2a2a"/>
      <rect x="${xc - 5.5}" y="${GROUND}" width="11" height="4.5" rx="1.2" fill="${col}"/>
      <line x1="${xc}" y1="${SOIL}" x2="${xc}" y2="${TANK.top + 10}" stroke="#5b544e" stroke-width="3"/>
      <rect x="${x0}" y="${TANK.top}" width="${x1 - x0}" height="${th}" rx="${th / 2}" fill="#191512"/>
      <g clip-path="${cp}">${inside}</g>
      <rect x="${x0}" y="${TANK.top}" width="${x1 - x0}" height="${th}" rx="${th / 2}" fill="none" stroke="#7d746c" stroke-width="1.4"/>
      <text x="${xc}" y="${TANK.bottom + 15}" class="ds-tank">Tank ${t.no}<tspan fill="${col}"> ${esc(t.product)}</tspan></text>
      ${tag ? `<text x="${xc}" y="${TANK.bottom + 27}" class="ds-stage">${tag}</text>` : ''}
    </g>`;
  }).join('');

  const said = rows.map((r) => {
    const st = stageOf(r);
    const on = round.get(r)?.at;
    return `C${r.chambers.join(',')} into Tank ${tanks.find((t) => t.id === r.tank)?.no ?? r.tank} (${{ waiting: 'next', decanting: on?.flowing ? `pipe on C${on.on}` : 'decanting', settling: 'settling', read: 'done' }[st]})`;
  }).join('; ');
  const moving = anim.g.length || anim.t.length || anim.p.length;
  return `<svg class="dscene${compact ? ' compact' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${s.tt_no || 'Truck'}: ${said}`)}"${moving ? ` data-anim="${esc(JSON.stringify(anim))}"` : ''}>
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
    ${pipes}
  </svg>`;
}

// Move every decanting picture on the page to `now`: each chamber's level on
// the pipe, each tank's level, and each pipe onto the chamber it's on — and
// stop the flow once all its chambers should be empty.
const parsed = new WeakMap();
export function tickScenes(root = document, now = Date.now()) {
  for (const svg of root.querySelectorAll('svg.dscene[data-anim]')) {
    let a = parsed.get(svg);
    if (!a) {
      try { a = JSON.parse(svg.dataset.anim); } catch { continue; }
      parsed.set(svg, a);
    }
    const el = (k) => svg.querySelector(`[data-k="${k}"]`);
    for (const g of a.g) {
      el(`l${g.k}`)?.setAttribute('transform', `translate(0 ${glassY(FULL * (1 - part(now, g.from, g.to)))})`);
      el(`g${g.k}`)?.classList.toggle('on', now >= g.from && now < g.to);
    }
    for (const t of a.t) {
      const litres = t.before + t.wins.reduce((s, [from, to, l]) => s + l * part(now, from, to), 0);
      el(t.k)?.setAttribute('transform', `translate(0 ${tankY(litres, t.cap)})`);
      el(`d${t.k.slice(1)}`)?.classList.toggle('flowing', now < t.wins[t.wins.length - 1][1]);
    }
    for (const p of a.p) {
      const g = el(p.k);
      if (!g) continue;
      const w = p.wins.find(([, to]) => now < to) || p.wins[p.wins.length - 1];
      const d = pipeD(w[2], p.xi, p.sag);
      g.querySelectorAll('path').forEach((path) => { if (path.getAttribute('d') !== d) path.setAttribute('d', d); });
      g.querySelector('.coupling')?.setAttribute('cx', w[2]);
      g.classList.toggle('flowing', now < p.wins[p.wins.length - 1][1]);
    }
  }
}
