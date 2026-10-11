// Our bulkers, drawn side on (as in the walk-around video): a white Tata
// Signa tractor pulling a mustard V-belly pneumatic bulker with twin navy
// stripes and a yellow pinstripe, a top handrail, a grey tri-axle under-frame
// — in Shree Shyam Logistics' own livery. The tank is drawn see-through, with
// the alumina (white powder) in it up to the trip's load: the RTO passing
// weight (56 T gross) is a dashed line, the most the vehicle carries (62 T, or
// the highest gross in the register) is the top. Plain SVG strings.

import { esc } from './util.js';

export const RTO_GROSS = 56;
export const RATED_GROSS = 62;
export const TAGLINE = 'Every tonne, on time';

let seq = 0;
const r1 = (v) => Math.round(v * 10) / 10;

// the tank's outline: flat top, round ends, a V belly down to the discharge
const BODY = 'M44,26 H302 Q322,26 322,47 Q322,66 304,72 L176,100 L42,72 Q20,66 20,47 Q20,26 44,26 Z';
const TOP = 26;
const LOW = 100;

function wheel(cx, cy = 115, r = 13) {
  return `<g class="bk-wheel"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#1b1b1d"/><circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#9a9aa0"/><circle cx="${cx}" cy="${cy}" r="${r * 0.2}" fill="#5b5b60"/></g>`;
}

// opts: { load, tare, gross, max, state: 'loaded'|'empty'|'idle', label, compact, animate, title }
export function bulkerSvg(opts = {}) {
  const id = `bk${++seq}`;
  const tare = opts.tare || 17;
  const max = Math.max(RATED_GROSS, opts.max || 0);
  const cap = max - tare;                                       // the most powder that goes in
  const loaded = opts.state === 'loaded' || (!!opts.load && opts.state !== 'empty' && opts.state !== 'idle');
  const load = loaded ? Math.max(0, opts.load || 0) : 0;
  const gross = loaded ? (opts.gross || load + tare) : 0;
  const yOf = (t) => r1(LOW - Math.min(1, Math.max(0, t / cap)) * (LOW - TOP));
  const level = loaded && load ? yOf(load) : LOW + 2;
  const rto = yOf(RTO_GROSS - tare);
  const rated = yOf(RATED_GROSS - tare);
  const over = loaded && gross > RTO_GROSS;
  const compact = !!opts.compact;
  const title = opts.title || (loaded ? `Loaded ${load.toFixed(2)} T alumina · gross ${gross.toFixed(2)} T (RTO ${RTO_GROSS} T)` : 'Empty');
  const fill = `<g clip-path="url(#${id}c)">
      <g class="bk-fill${opts.animate ? ' pour' : ''}" style="--from:${r1(LOW - level + 4)}px">
        <rect x="18" y="${level}" width="306" height="${r1(LOW - level + 4)}" fill="url(#${id}p)" opacity=".93"/>
        ${loaded && load ? `<path d="M18,${level} Q100,${r1(level - 3.5)} 176,${level} T324,${level}" fill="#fbfbf8" opacity=".9"/>` : ''}
        ${over ? `<rect x="18" y="${level}" width="306" height="${r1(Math.max(0, rto - level))}" fill="url(#${id}h)"/>` : ''}
      </g>
      ${compact ? '' : `<line x1="24" x2="318" y1="${rto}" y2="${rto}" class="bk-rto"/><line x1="24" x2="318" y1="${rated}" y2="${rated}" class="bk-rated"/>`}
    </g>`;
  const labels = compact ? '' : `
    <text x="300" y="${r1(rto + 8.5)}" class="bk-t bk-rto-t" text-anchor="end">RTO ${RTO_GROSS} T</text>
    ${rated > TOP + 3 ? `<text x="300" y="${r1(rated - 2)}" class="bk-t" text-anchor="end">${RATED_GROSS} T rated</text>` : ''}
    ${loaded && load ? `<text x="48" y="${r1(Math.max(level + 9, 40))}" class="bk-t bk-load-t">${gross ? `${gross.toFixed(1)} T` : `${load.toFixed(1)} T`}</text>` : ''}`;
  return `<svg class="bulker${compact ? ' compact' : ''}${loaded ? ' is-loaded' : ' is-empty'}${over ? ' is-over' : ''}" viewBox="0 0 424 134" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <defs>
    <clipPath id="${id}c"><path d="${BODY}" transform="translate(171 63) scale(.965) translate(-171 -63)"/></clipPath>
    <clipPath id="${id}b"><path d="${BODY}"/></clipPath>
    <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2b24a"/><stop offset=".55" stop-color="#d9921f"/><stop offset="1" stop-color="#b8740f"/></linearGradient>
    <pattern id="${id}p" width="7" height="7" patternUnits="userSpaceOnUse"><rect width="7" height="7" fill="#f1f0ea"/><circle cx="1.5" cy="2" r=".6" fill="#d6d3c8"/><circle cx="5" cy="5.2" r=".5" fill="#dcd9cf"/><circle cx="4.6" cy="1.2" r=".35" fill="#fff"/></pattern>
    <pattern id="${id}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(255,178,62,.18)"/><rect width="2.4" height="6" fill="rgba(230,120,20,.45)"/></pattern>
  </defs>
  <line x1="6" x2="420" y1="129" y2="129" class="bk-ground"/>
  <!-- trailer under-frame, landing legs, tri-axle -->
  <rect x="24" y="100" width="300" height="6" rx="2" fill="#6c6d70"/>
  <rect x="226" y="104" width="4" height="16" fill="#58595c"/><rect x="221" y="119" width="14" height="3" rx="1" fill="#58595c"/>
  <path d="M40,102 h96 v6 q-48,4 -96,0 z" fill="#5f6063"/>
  ${wheel(56)}${wheel(88)}${wheel(120)}
  <!-- tractor: chassis, wheels, white Tata Signa cab -->
  <rect x="300" y="101" width="104" height="7" rx="2" fill="#4c4d50"/>
  ${wheel(324)}${wheel(354)}${wheel(398)}
  <path d="M352,104 V50 Q352,40 362,40 H402 Q410,40 411,49 L416,92 Q417,104 406,104 Z" fill="#f7f7f5" stroke="#c9c9c4" stroke-width="1"/>
  <path d="M394,45 H405 Q408,45 408.6,49 L411.5,72 H394 Z" fill="#33414f" opacity=".92"/>
  <rect x="368" y="45" width="20" height="23" rx="2.5" fill="#3a4856" opacity=".9"/>
  <rect x="353" y="78" width="63" height="3.4" fill="#f2a71b"/>
  <rect x="353" y="81.4" width="63" height="1.6" fill="#e8601c"/>
  <rect x="404" y="98" width="13" height="8" rx="2" fill="#2a2b2e"/>
  <rect x="362" y="104" width="22" height="9" rx="3" fill="#c9cbcf"/>
  <path d="M414,50 l5,-2 v14 h-2" fill="none" stroke="#3a3b3e" stroke-width="1.6"/>
  <rect x="352" y="38" width="44" height="4" rx="2" fill="#e9e9e5"/>
  <rect x="408" y="86" width="7" height="4" rx="1" fill="#ffd36b"/>
  ${opts.label ? `<text x="380" y="96" class="bk-door" text-anchor="middle">${esc(opts.label)}</text>` : ''}
  <!-- the bulker tank: outline, alumina inside, livery on top -->
  <path d="${BODY}" fill="url(#${id}g)" class="bk-body"/>
  <path d="${BODY}" class="bk-glass" fill="rgba(22,16,12,.38)" transform="translate(171 63) scale(.965) translate(-171 -63)"/>
  ${fill}
  <g clip-path="url(#${id}b)">
    <polyline points="20,59 176,${86} 326,57" fill="none" stroke="#1d3577" stroke-width="5.5"/>
    <polyline points="20,64.5 176,${91.5} 326,62.5" fill="none" stroke="#f5c02a" stroke-width="1.6"/>
    <polyline points="20,69 176,${96} 326,67" fill="none" stroke="#1d3577" stroke-width="3.2"/>
  </g>
  <path d="${BODY}" fill="none" stroke="#8f5c0c" stroke-width="1.2"/>
  <g class="bk-livery">
    <rect x="118" y="31" width="17" height="18" rx="3" fill="#fff" opacity=".92"/>
    <image href="assets/logo-mark.png" x="119.5" y="32.3" width="14" height="15.4"/>
    <text x="140" y="41.5" class="bk-name">SHREE SHYAM</text>
    <text x="140.6" y="49" class="bk-sub">LOGISTICS</text>
    <text x="140.6" y="55.5" class="bk-tag">${esc(TAGLINE)}</text>
  </g>
  <!-- top handrail and hatches; rear ladder -->
  <path d="M70,18 H290" stroke="#c98a2a" stroke-width="1.4"/>
  ${[70, 110, 150, 190, 230, 270, 290].map((x) => `<line x1="${x}" x2="${x}" y1="18" y2="26" stroke="#c98a2a" stroke-width="1.1"/>`).join('')}
  ${[104, 176, 248].map((x) => `<rect x="${x - 9}" y="21.5" width="18" height="5" rx="2" fill="#a86d14"/>`).join('')}
  <path d="M26,30 v66 M33,30 v66" stroke="#9b9ba0" stroke-width="1.1"/>${[40, 52, 64, 76, 88].map((y) => `<line x1="26" x2="33" y1="${y}" y2="${y}" stroke="#9b9ba0" stroke-width="1"/>`).join('')}
  <rect x="12" y="92" width="10" height="7" rx="1" fill="#f06a1f"/>
  ${labels}
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
