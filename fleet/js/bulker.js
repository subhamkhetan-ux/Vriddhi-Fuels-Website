// Our bulkers, drawn side on (as in the walk-around video) in the same way the
// Loading and Decanting apps draw our diesel tankers: a slim navy livery band
// on top (Shree Shyam Logistics' logo, name and tagline), then one big sight
// glass over most of the mustard V-belly tank, the alumina (white powder)
// filling it from the bottom up to the trip's load, and the twin navy stripes
// along the belly; a white Tata Signa tractor and a grey tri-axle under-frame.
// The glass reads gross weight like a gauge: its bottom is 40 T (every load is
// well over that), its top the highest gross in the register; the RTO passing
// weight (56 T) is a dashed line with any weight over it hatched amber, and
// 62 T rated is marked. Plain SVG strings.

import { esc } from './util.js';

export const RTO_GROSS = 56;
export const RATED_GROSS = 62;
export const TAGLINE = 'Driving Your Progress';
export const GAUGE_FROM = 40;                      // gross tonnes at the bottom of the glass

let seq = 0;
const r1 = (v) => Math.round(v * 10) / 10;

// the tank: flat top, round ends, a V belly down to the discharge
const BODY = 'M46,24 H300 Q322,24 322,46 Q322,64 305,70 L176,99 L45,70 Q20,64 20,46 Q20,24 46,24 Z';
const BAND = 35;                                   // bottom of the navy livery band
// the sight glass: the same shape, inside the body under the band
const GLASS = 'M50,39 H296 Q311,39 311,50 Q311,59 297,63 L176,90 L54,63 Q31,59 31,50 Q31,39 50,39 Z';
const G_TOP = 39;
const G_LOW = 90;

const wheel = (cx, cy = 114, r = 12) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#1b1b1b"/><circle cx="${cx}" cy="${cy}" r="${r * 0.42}" fill="#b9bfc6"/>`;

// opts: { load, tare, gross, max, state: 'loaded'|'empty'|'idle', label, compact, animate, title }
export function bulkerSvg(opts = {}) {
  const id = `bk${++seq}`;
  const tare = opts.tare || 17;
  const max = Math.max(RATED_GROSS, opts.max || 0);
  const loaded = opts.state === 'loaded' || (!!opts.load && opts.state !== 'empty' && opts.state !== 'idle');
  const load = loaded ? Math.max(0, opts.load || 0) : 0;
  const gross = loaded ? (opts.gross || load + tare) : 0;
  const yOf = (g) => r1(G_LOW - Math.min(1, Math.max(0, (g - GAUGE_FROM) / (max - GAUGE_FROM))) * (G_LOW - G_TOP));
  const level = loaded && load ? yOf(gross) : G_LOW + 2;
  const rto = yOf(RTO_GROSS);
  const rated = yOf(RATED_GROSS);
  const over = loaded && gross > RTO_GROSS;
  const compact = !!opts.compact;
  const title = opts.title || (loaded ? `Loaded ${load.toFixed(2)} T alumina · gross ${gross.toFixed(2)} T (RTO ${RTO_GROSS} T)` : 'Empty');
  // the powder's top: small heaps under the three hatches it's blown in through
  const heap = (y) => `M28,${y} ${[104, 176, 248].map((x) => `Q${x - 26},${y} ${x},${r1(y - 3.2)} Q${x + 26},${y} ${x + 36},${y}`).join(' ')} H316 V96 H28 Z`;
  const big = loaded && load ? `${load.toFixed(2)} T` : 'EMPTY';
  // the big figure sits low in the V, in the powder whenever there's a load
  const textOnPowder = loaded && load && level < 64;
  return `<svg class="bulker${compact ? ' compact' : ''}${loaded ? ' is-loaded' : ' is-empty'}${over ? ' is-over' : ''}" viewBox="0 0 424 134" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <defs>
    <clipPath id="${id}b"><path d="${BODY}"/></clipPath>
    <clipPath id="${id}g"><path d="${GLASS}"/></clipPath>
    <linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eba63a"/><stop offset="1" stop-color="#c98317"/></linearGradient>
    <linearGradient id="${id}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdfcf8"/><stop offset=".6" stop-color="#ecebe4"/><stop offset="1" stop-color="#d9d6cb"/></linearGradient>
    <pattern id="${id}s" width="9" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".55" fill="#c9c5b8"/><circle cx="6.5" cy="5" r=".45" fill="#cfcbbf"/></pattern>
    <pattern id="${id}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(255,178,62,.22)"/><rect width="2.2" height="6" fill="rgba(232,120,20,.55)"/></pattern>
    <linearGradient id="${id}sh" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <line x1="4" x2="420" y1="127" y2="127" class="bk-ground"/>
  <!-- under-frame, landing legs, tri-axle -->
  <rect x="26" y="98" width="296" height="5" rx="2" fill="#86c5de" class="bk-chassis"/>
  <rect x="40" y="101" width="96" height="6" rx="2" fill="#a8b0b8" stroke="#6d757d" stroke-width=".8"/>
  <rect x="223" y="101" width="4" height="15" fill="#6d757d"/><rect x="218" y="115" width="14" height="3" rx="1" fill="#6d757d"/>
  ${wheel(58)}${wheel(88)}${wheel(118)}
  <!-- the tractor: a white Tata Signa -->
  <rect x="300" y="100" width="104" height="6" rx="2" fill="#86c5de" class="bk-chassis"/>
  ${wheel(322)}${wheel(350)}${wheel(396)}
  <path d="M350,103 V48 Q350,38 360,38 H401 Q409,38 410,47 L415,90 Q416,103 405,103 Z" fill="#f4f4f2" stroke="#c9ccd0" stroke-width="1"/>
  <rect x="352" y="35" width="42" height="4" rx="2" fill="#e6e6e2"/>
  <path d="M393,44 H404 Q407,44 407.6,48 L410.5,70 H393 Z" fill="#9fb3c8" opacity=".9"/>
  <rect x="365" y="44" width="22" height="22" rx="3" fill="#9fb3c8" opacity=".9"/>
  <rect x="351" y="76" width="64" height="3.2" fill="#f5c02a"/><rect x="351" y="79.2" width="64" height="1.6" fill="#ef6a28"/>
  <rect x="403" y="96" width="14" height="8" rx="2" fill="#2a2d31"/>
  <rect x="360" y="103" width="22" height="8" rx="3" fill="#a8b0b8" stroke="#6d757d" stroke-width=".8"/>
  <path d="M413,48 l5,-1.5 v13" fill="none" stroke="#3a3f45" stroke-width="1.5"/>
  ${opts.label ? `<text x="378" y="94" class="bk-door" text-anchor="middle">${esc(opts.label)}</text>` : ''}
  <!-- the tank: mustard body, navy livery band, the sight glass, the belly stripes -->
  <path d="${BODY}" fill="url(#${id}m)"/>
  <g clip-path="url(#${id}b)">
    <rect x="18" y="20" width="308" height="${BAND - 20}" fill="#1e3a8a"/>
    <rect x="18" y="${BAND}" width="308" height="1.4" fill="#f5c02a"/>
    <polyline points="18,68 176,${95.5} 326,66" fill="none" stroke="#1e3a8a" stroke-width="3.4"/>
    <polyline points="18,72.5 176,${100} 326,70.5" fill="none" stroke="#f5c02a" stroke-width="1.3"/>
  </g>
  <rect x="58" y="${(20 + BAND) / 2 + 2 - 5.5}" width="11" height="11" rx="2.4" fill="#fff"/>
  <image href="assets/logo-mark.png" x="59.3" y="${(20 + BAND) / 2 + 2 - 4.3}" width="8.4" height="9"/>
  <text x="74" y="${(20 + BAND) / 2 + 4.6}" class="bk-livery">SHREE SHYAM LOGISTICS<tspan class="bk-tag" dx="6">${esc(TAGLINE)}</tspan></text>
  <path d="${GLASS}" class="bk-glass"/>
  <g clip-path="url(#${id}g)">
    <g class="bk-fill${opts.animate ? ' pour' : ''}" style="--from:${r1(G_LOW - level + 6)}px">
      ${loaded && load ? `<path d="${heap(level)}" fill="url(#${id}p)"/><path d="${heap(level)}" fill="url(#${id}s)"/>` : ''}
      ${over ? `<rect x="28" y="${r1(level - 4)}" width="290" height="${r1(Math.max(0, rto - level + 4))}" fill="url(#${id}h)"/>` : ''}
    </g>
    <line x1="28" x2="316" y1="${rto}" y2="${rto}" class="bk-rto"/>
    ${rated > G_TOP + 2 ? `<line x1="28" x2="316" y1="${rated}" y2="${rated}" class="bk-rated"/>` : ''}
    <path d="${GLASS}" fill="url(#${id}sh)"/>
  </g>
  <path d="${GLASS}" class="bk-glass-rim"/>
  <text x="176" y="${compact ? 78 : 75}" class="bk-big${textOnPowder ? ' on-powder' : ''}" text-anchor="middle">${big}</text>
  ${!compact && loaded && load ? `<text x="176" y="84" class="bk-small${textOnPowder ? ' on-powder' : ''}" text-anchor="middle">alumina · gross ${gross.toFixed(2)} T</text>` : ''}
  ${compact ? '' : `<text x="300" y="${r1(rto - 2.2)}" class="bk-t bk-rto-t" text-anchor="end">RTO ${RTO_GROSS} T</text>
  ${rated > G_TOP + 6 ? `<text x="300" y="${r1(rated - 2.2)}" class="bk-t bk-rated-t" text-anchor="end">${RATED_GROSS} T rated</text>` : ''}`}
  <path d="${BODY}" fill="none" stroke="#9a5f0c" stroke-width="1.1"/>
  <!-- top: hatches and handrail; rear ladder and lamp -->
  ${[104, 176, 248].map((x) => `<rect x="${x - 9}" y="19.5" width="18" height="5" rx="2" fill="#59616a"/>`).join('')}
  <path d="M66,15 H286" stroke="#8d969e" stroke-width="1.3"/>
  ${[66, 128, 220, 286].map((x) => `<line x1="${x}" x2="${x}" y1="15" y2="24" stroke="#8d969e" stroke-width="1.1"/>`).join('')}
  <path d="M25,28 v64 M31,28 v64" stroke="#8d969e" stroke-width="1"/>${[38, 50, 62, 74, 86].map((y) => `<line x1="25" x2="31" y1="${y}" y2="${y}" stroke="#8d969e" stroke-width=".9"/>`).join('')}
  <rect x="12" y="90" width="9" height="6" rx="1" fill="#ef6a28"/>
</svg>`;
}

// One lane per trip on a shared day axis: started → diesel fills → loaded →
// fills → unloaded (or today, for one still on the road).
// rows: [{ label, sub, start, load, unload, fills: [iso], best, live, mark }]
export function lanesSvg(rows, { today, width = 640 } = {}) {
  const day = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  const all = rows.flatMap((r) => [r.start, r.load, r.unload || (r.live ? today : null), ...(r.fills || [])]).filter(Boolean);
  if (!all.length) return '';
  const lo = Math.min(...all.map(day));
  const hi = Math.max(...all.map(day), lo + 1);
  const L = 128;
  const R = 14;
  const x = (iso) => r1(L + ((day(iso) - lo) / (hi - lo)) * (width - L - R));
  const H = 30;
  const top = 8;
  const h = top + rows.length * H + 26;
  const ticks = [];
  const step = Math.max(1, Math.ceil((hi - lo) / Math.max(2, Math.floor((width - L - R) / 46))));
  for (let d = lo; d <= hi; d += step) {
    const iso = new Date(d * 86400000).toISOString().slice(0, 10);
    ticks.push(`<line x1="${x(iso)}" x2="${x(iso)}" y1="${top}" y2="${h - 22}" class="ln-grid"/><text x="${x(iso)}" y="${h - 8}" class="ln-tick" text-anchor="middle">${Number(iso.slice(8))}/${Number(iso.slice(5, 7))}</text>`);
  }
  const lanes = rows.map((r, i) => {
    const y = top + i * H + H / 2;
    const end = r.unload || (r.live ? today : null);
    const seg = (a, b, cls) => (a && b ? `<line x1="${x(a)}" x2="${x(b)}" y1="${y}" y2="${y}" class="${cls}"/>` : '');
    const fills = (r.fills || []).map((f) => `<g class="ln-fill" transform="translate(${x(f)} ${y - 9})"><path d="M0,-4.5 C2.6,-1 3.6,1 3.6,2.6 A3.6,3.6 0 0 1 -3.6,2.6 C-3.6,1 -2.6,-1 0,-4.5 Z"/></g>`).join('');
    const tip = [`<b>${esc(r.label)}</b>${r.sub ? ` · ${esc(r.sub)}` : ''}`, `Start ${r.start}`, r.load ? `Loaded ${r.load}` : 'Not loaded yet', r.unload ? `Unloaded ${r.unload}` : r.live ? 'On the road' : '', (r.fills || []).length ? `Diesel fills ${r.fills.join(', ')}` : ''].filter(Boolean).join('<br>');
    return `<g class="ln-row${r.best ? ' best' : ''}${r.mark ? ' mark' : ''}">
      <rect x="0" y="${y - H / 2 + 2}" width="${width}" height="${H - 4}" rx="7" class="ln-bg"/>
      <text x="8" y="${y + 1}" class="ln-name">${esc(r.label)}</text>${r.sub ? `<text x="8" y="${y + 11}" class="ln-sub">${esc(r.sub)}</text>` : ''}
      ${seg(r.start, r.load || (r.live ? today : null), 'ln-empty')}${seg(r.load, end, 'ln-loaded')}
      <circle cx="${x(r.start)}" cy="${y}" r="4" class="ln-start"/>
      ${r.load ? `<rect x="${x(r.load) - 4.5}" y="${y - 4.5}" width="9" height="9" rx="2" class="ln-load"/>` : ''}
      ${r.unload ? `<path d="M${x(r.unload)},${y - 5.5} l5.5,5.5 l-5.5,5.5 l-5.5,-5.5 z" class="ln-unload"/>` : r.live ? `<circle cx="${x(today)}" cy="${y}" r="5" class="ln-now"/>` : ''}
      ${fills}
      <rect x="0" y="${y - H / 2 + 2}" width="${width}" height="${H - 4}" class="hit" data-x="0" data-tip="${esc(tip)}"/>
    </g>`;
  }).join('');
  return `<svg class="chart lanes" viewBox="0 0 ${width} ${h}" role="img" aria-label="Trips side by side: start, diesel fills, loading, unloading">${ticks.join('')}${lanes}</svg>`;
}

export function lanesLegend() {
  return `<div class="legend lanes-legend">
    <span><svg width="12" height="12" viewBox="-6 -6 12 12"><circle r="4" class="ln-start"/></svg>Start</span>
    <span><svg width="22" height="8"><line x1="0" x2="22" y1="4" y2="4" class="ln-empty"/></svg>Empty run</span>
    <span><svg width="12" height="12" viewBox="-6 -6 12 12"><rect x="-4.5" y="-4.5" width="9" height="9" rx="2" class="ln-load"/></svg>Loaded</span>
    <span><svg width="22" height="8"><line x1="0" x2="22" y1="4" y2="4" class="ln-loaded"/></svg>Loaded run</span>
    <span><svg width="12" height="12" viewBox="-6 -6 12 12"><path d="M0,-5.5 l5.5,5.5 l-5.5,5.5 l-5.5,-5.5 z" class="ln-unload"/></svg>Unloaded</span>
    <span><svg width="12" height="12" viewBox="-6 -7 12 12" class="ln-fill"><path d="M0,-4.5 C2.6,-1 3.6,1 3.6,2.6 A3.6,3.6 0 0 1 -3.6,2.6 C-3.6,1 -2.6,-1 0,-4.5 Z"/></svg>Diesel fill</span>
  </div>`;
}
