// Our bulkers, drawn side on (as in the walk-around video) in the same way the
// Loading and Decanting apps draw our diesel tankers: a slim navy livery band
// on top (Shree Shyam Logistics' logo, name and tagline), then one big sight
// glass over most of the mustard V-belly tank, the alumina (white powder)
// filling it from the bottom up to the trip's load, and the twin navy stripes
// along the belly; a white Tata Signa tractor and a grey tri-axle under-frame.
// The glass reads gross weight like a gauge: its bottom is 40 T (every load is
// well over that), its top the highest gross in the register; the RTO passing
// weight (56 T) is a dashed line, and 62 T rated is marked. Its overload fee
// is already paid, so weight over it is good: hatched green, the line turns
// green; a load that stays under it leaves the line red. Plain SVG strings.

import { esc } from './util.js';

export const RTO_GROSS = 56;
export const RATED_GROSS = 62;
export const TAGLINE = 'Driving Your Progress';
export const GAUGE_FROM = 40;                      // gross tonnes at the bottom of the glass

let seq = 0;
const r1 = (v) => Math.round(v * 10) / 10;

// the tank: flat top, round ends, a V belly down to the discharge
const BODY = 'M42,10 H302 Q326,10 326,34 V76 Q326,87 311,90 L176,101 L33,90 Q16,87 16,76 V34 Q16,10 42,10 Z';
const BAND = 24;                                   // bottom of the navy livery band
// the sight glass: the same shape, inside the body under the band
const GLASS = 'M44,28 H298 Q314,28 314,40 V73 Q314,80 300,83 L176,94 L42,83 Q28,80 28,73 V40 Q28,28 44,28 Z';
const G_TOP = 28;
const G_LOW = 94;

// a tyre with a rim, hub and nuts
const wheel = (id, cx, cy = 114, r = 12) => `<g><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}ty)"/><circle cx="${cx}" cy="${cy}" r="${r * 0.62}" fill="url(#${id}rim)" stroke="#6d757d" stroke-width=".6"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.24}" fill="#59616a"/>${[0, 72, 144, 216, 288].map((a) => { const rad = (a * Math.PI) / 180; return `<circle cx="${r1(cx + Math.cos(rad) * r * 0.42)}" cy="${r1(cy + Math.sin(rad) * r * 0.42)}" r=".9" fill="#6d757d"/>`; }).join('')}</g>`;

// XX01T1001 → XX 01 T 1001 (as on the plate)
export const plateText = (v) => {
  const m = String(v || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ') : String(v || '');
};

// opts: { load, tare, gross, max, state: 'loaded'|'empty'|'idle', plate, label, compact, animate, title }
export function bulkerSvg(opts = {}) {
  const id = `bk${++seq}`;
  const max = Math.max(RATED_GROSS, opts.max || 0);
  const loaded = opts.state === 'loaded' || (!!opts.load && opts.state !== 'empty' && opts.state !== 'idle');
  const load = loaded ? Math.max(0, opts.load || 0) : 0;
  const tare = opts.tare || 17;
  const gross = loaded ? (opts.gross || load + tare) : 0;
  const yOf = (g) => r1(G_LOW - Math.min(1, Math.max(0, (g - GAUGE_FROM) / (max - GAUGE_FROM))) * (G_LOW - G_TOP));
  const level = loaded && load ? yOf(gross) : G_LOW + 2;
  const rto = yOf(RTO_GROSS);
  const rated = yOf(RATED_GROSS);
  const over = loaded && gross > RTO_GROSS;
  const compact = !!opts.compact;
  const plate = plateText(opts.plate || opts.label || '');
  const title = opts.title || `${plate ? `${plate} · ` : ''}${loaded ? `loaded ${load.toFixed(2)} T alumina · gross ${gross.toFixed(2)} T (RTO ${RTO_GROSS} T)` : 'empty'}`;
  // the powder's top: small heaps under the three hatches it's blown in through
  const heap = (y) => `M24,${y} ${[104, 176, 248].map((x) => `Q${x - 26},${y} ${x},${r1(y - 3.2)} Q${x + 26},${y} ${x + 36},${y}`).join(' ')} H318 V98 H24 Z`;
  const big = loaded && load ? `${load.toFixed(2)} T` : 'EMPTY';
  const textOnPowder = loaded && load && level < 66;
  return `<svg class="bulker${compact ? ' compact' : ''}${loaded ? ' is-loaded' : ' is-empty'}${over ? ' is-over' : ''}" viewBox="0 -3 424 139" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <defs>
    <clipPath id="${id}b"><path d="${BODY}"/></clipPath>
    <clipPath id="${id}g"><path d="${GLASS}"/></clipPath>
    <linearGradient id="${id}m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc561"/><stop offset=".18" stop-color="#f0a636"/><stop offset=".7" stop-color="#d48716"/><stop offset="1" stop-color="#a9650a"/></linearGradient>
    <linearGradient id="${id}n" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b4fb0"/><stop offset="1" stop-color="#162c6e"/></linearGradient>
    <linearGradient id="${id}gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f1419"/><stop offset="1" stop-color="#28313b"/></linearGradient>
    <linearGradient id="${id}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#eeede6"/><stop offset="1" stop-color="#d6d2c4"/></linearGradient>
    <pattern id="${id}s" width="9" height="7" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".55" fill="#c9c5b8"/><circle cx="6.5" cy="5" r=".45" fill="#cfcbbf"/><circle cx="5" cy="1.5" r=".35" fill="#fff"/></pattern>
    <pattern id="${id}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(47,208,138,.2)"/><rect width="2.2" height="6" fill="rgba(16,150,90,.62)"/></pattern>
    <linearGradient id="${id}sh" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="${id}cab" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e3e6ea"/><stop offset=".35" stop-color="#ffffff"/><stop offset="1" stop-color="#edf0f2"/></linearGradient>
    <linearGradient id="${id}win" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5d7690"/><stop offset=".5" stop-color="#253545"/><stop offset="1" stop-color="#131c25"/></linearGradient>
    <radialGradient id="${id}ty" cx=".4" cy=".35" r=".7"><stop offset="0" stop-color="#3a3d42"/><stop offset="1" stop-color="#101114"/></radialGradient>
    <radialGradient id="${id}rim" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#f4f6f8"/><stop offset="1" stop-color="#9aa3ad"/></radialGradient>
    <radialGradient id="${id}sha" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id}chr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2f4f6"/><stop offset=".5" stop-color="#9aa3ad"/><stop offset="1" stop-color="#d9dde1"/></linearGradient>
  </defs>
  <ellipse cx="214" cy="127" rx="206" ry="6" fill="url(#${id}sha)"/>
  <!-- under-frame, landing legs, air tanks, tri-axle -->
  <rect x="22" y="99" width="300" height="5" rx="2" fill="#3c4148"/>
  <rect x="40" y="100.5" width="96" height="7" rx="2.5" fill="#545b63"/>
  <rect x="150" y="101" width="36" height="7" rx="3.5" fill="url(#${id}chr)"/>
  <rect x="223" y="101" width="4" height="15" fill="#4b5158"/><rect x="218" y="115" width="14" height="3" rx="1" fill="#4b5158"/>
  <path d="M44,104 q14,-12 28,0 M74,104 q14,-12 28,0 M104,104 q14,-12 28,0" fill="#2b2f34"/>
  ${wheel(id, 58)}${wheel(id, 88)}${wheel(id, 118)}
  <!-- the tractor: a white Tata Signa -->
  <rect x="300" y="100" width="104" height="6" rx="2" fill="#3c4148"/>
  <path d="M308,104 q14,-12 28,0 M336,104 q14,-12 28,0 M382,104 q14,-12 28,0" fill="#2b2f34"/>
  ${wheel(id, 322)}${wheel(id, 350)}${wheel(id, 396)}
  <rect x="358" y="102" width="24" height="9" rx="4.5" fill="url(#${id}chr)"/>
  <path d="M350,103 V48 Q350,37 361,37 H401 Q409.5,37 410.5,46 L415.5,89 Q416.5,103 405,103 Z" fill="url(#${id}cab)" stroke="#b9c0c7" stroke-width="1"/>
  <path d="M352,36.5 Q356,30.5 366,30.5 H392 Q398,30.5 400,36.5 Z" fill="#e9ecef" stroke="#c9ced3" stroke-width=".8"/>
  <path d="M392.5,43 H404 Q407.5,43 408.2,47 L411.4,71 H392.5 Z" fill="url(#${id}win)"/>
  <path d="M395,44.5 l5,0 l-6,22 h-2 z" fill="#fff" opacity=".18"/>
  <rect x="364" y="43" width="23" height="22" rx="3" fill="url(#${id}win)"/>
  <path d="M367,45 h5 l-6,16 h-2 z" fill="#fff" opacity=".16"/>
  <rect x="351" y="74" width="65" height="3.4" fill="#f5c02a"/><rect x="351" y="77.4" width="65" height="1.8" fill="#ef6a28"/>
  <line x1="389" x2="389" y1="42" y2="99" stroke="#c3c9cf" stroke-width=".8"/>
  <rect x="383" y="66" width="4" height="1.6" rx=".8" fill="#9aa3ad"/>
  <rect x="402" y="94" width="16" height="9" rx="2.4" fill="#1d2024"/><rect x="402" y="94" width="16" height="1.6" fill="url(#${id}chr)"/>
  <rect x="409.5" y="83" width="7" height="5" rx="1.4" fill="#fff6d8"/><circle cx="414" cy="85.5" r="5" fill="#ffd36b" opacity=".18"/>
  <path d="M413,47 l6,-1.5 v15 h-2.4" fill="none" stroke="#2c3036" stroke-width="1.6"/><rect x="416.5" y="51" width="3.4" height="9" rx="1.2" fill="#2c3036"/>
  ${plate ? `<g class="bk-plate"><rect x="${compact ? 352 : 354}" y="${compact ? 81 : 82}" width="${compact ? 50 : 46}" height="${compact ? 14 : 11.5}" rx="2" fill="#ffcf1a" stroke="#1d2024" stroke-width="1"/><text x="${compact ? 377 : 377}" y="${compact ? 91.6 : 90.4}" text-anchor="middle" class="bk-plate-t${compact ? ' big' : ''}" textLength="${compact ? 44 : 40}" lengthAdjust="spacingAndGlyphs">${esc(plate)}</text></g>` : ''}
  <!-- the tank: mustard body, navy livery band, the sight glass, the belly stripes -->
  <path d="${BODY}" fill="url(#${id}m)"/>
  <g clip-path="url(#${id}b)">
    <rect x="14" y="8" width="314" height="${BAND - 8}" fill="url(#${id}n)"/>
    <rect x="14" y="${BAND}" width="314" height="1.6" fill="#f5c02a"/>
    <rect x="14" y="8" width="314" height="3" fill="#fff" opacity=".16"/>
    <polyline points="14,86 176,97.5 328,86" fill="none" stroke="url(#${id}n)" stroke-width="3.6"/>
    <polyline points="14,90 176,101.5 328,90" fill="none" stroke="#f5c02a" stroke-width="1.3"/>
    <path d="M30,27 Q176,22 312,27" fill="none" stroke="#fff" stroke-width="2" opacity=".12"/>
  </g>
  <rect x="40" y="9.5" width="13" height="13" rx="3.2" fill="#fff"/>
  <image href="assets/logo-mark.png" x="41.5" y="10.8" width="10" height="10.6"/>
  <text x="58" y="19.6" class="bk-livery">SHREE SHYAM LOGISTICS<tspan class="bk-tag" dx="6">${esc(TAGLINE)}</tspan></text>
  <path d="${GLASS}" fill="url(#${id}gl)"/>
  <g clip-path="url(#${id}g)">
    <g class="bk-fill${opts.animate ? ' pour' : ''}" style="--from:${r1(G_LOW - level + 6)}px">
      ${loaded && load ? `<path d="${heap(level)}" fill="url(#${id}p)"/><path d="${heap(level)}" fill="url(#${id}s)"/><path d="${heap(level).replace(/ H316 V96 H28 Z$/, '')}" fill="none" stroke="#fff" stroke-width="1.2" opacity=".9"/>` : ''}
      ${over ? `<rect x="24" y="${r1(level - 4)}" width="296" height="${r1(Math.max(0, rto - level + 4))}" fill="url(#${id}h)"/>` : ''}
    </g>
    <line x1="24" x2="318" y1="${rto}" y2="${rto}" class="bk-rto"/>
    ${rated > G_TOP + 2 ? `<line x1="24" x2="318" y1="${rated}" y2="${rated}" class="bk-rated"/>` : ''}
    <path d="${GLASS}" fill="url(#${id}sh)"/>
    <path d="M56,30 L90,30 L66,92 L32,92 Z" fill="#fff" opacity=".05"/>
  </g>
  <path d="${GLASS}" class="bk-glass-rim"/>
  <text x="176" y="${compact ? 80 : 74}" class="bk-big${textOnPowder ? ' on-powder' : ''}" text-anchor="middle">${big}</text>
  ${!compact && loaded && load ? `<text x="176" y="84" class="bk-small${textOnPowder ? ' on-powder' : ''}" text-anchor="middle">alumina · gross ${gross.toFixed(2)} T</text>` : ''}
  ${opts.route ? `<text x="${compact ? 176 : 36}" y="${compact ? 40 : 38}" class="bk-route${compact ? ' c' : ''}${textOnPowder && level < 41 ? ' on-powder' : ''}" text-anchor="${compact ? 'middle' : 'start'}">${esc(opts.route)}</text>` : ''}
  ${opts.trip && !compact ? `<text x="36" y="47" class="bk-trip${textOnPowder && level < 50 ? ' on-powder' : ''}">${esc(opts.trip)}</text>` : ''}
  ${compact ? '' : `<text x="306" y="${r1(rto - 2.2)}" class="bk-t bk-rto-t" text-anchor="end">RTO ${RTO_GROSS} T</text>
  ${rated > G_TOP + 6 ? `<text x="306" y="${r1(rated - 2.2)}" class="bk-t bk-rated-t" text-anchor="end">${RATED_GROSS} T rated</text>` : ''}`}
  <path d="${BODY}" fill="none" stroke="#8a530a" stroke-width="1.1"/>
  ${[56, 116, 236, 296].map((x) => `<circle cx="${x}" cy="${x < 176 ? r1(90 + ((x - 33) / 143) * 11 - 3) : r1(90 + ((311 - x) / 135) * 11 - 3)}" r="1.5" fill="#ffb21a"/>`).join('')}
  <!-- top: hatches, handrail; rear ladder and lamps -->
  ${[104, 176, 248].map((x) => `<rect x="${x - 10}" y="5" width="20" height="5.5" rx="2.4" fill="url(#${id}chr)" stroke="#6d757d" stroke-width=".6"/>`).join('')}
  <path d="M62,1 H290" stroke="url(#${id}chr)" stroke-width="1.8"/>
  ${[62, 128, 220, 290].map((x) => `<line x1="${x}" x2="${x}" y1="1" y2="10" stroke="#9aa3ad" stroke-width="1.2"/>`).join('')}
  <path d="M21,14 v80 M27,14 v80" stroke="#9aa3ad" stroke-width="1.1"/>${[24, 36, 48, 60, 72, 84].map((y) => `<line x1="21" x2="27" y1="${y}" y2="${y}" stroke="#9aa3ad" stroke-width=".9"/>`).join('')}
  <rect x="7" y="86" width="9" height="7" rx="1.5" fill="#e0402e"/><rect x="7" y="86" width="9" height="2.4" rx="1" fill="#ff8a6e"/>
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
