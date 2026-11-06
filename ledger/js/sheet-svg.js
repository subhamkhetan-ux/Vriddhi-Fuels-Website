// Draws a sheet's print area (docs.js layoutOf) as one A4 page, the way
// Excel prints it: fit to one page, horizontally centred, the sheet's own
// column widths, row heights, merged cells, fills, borders, fonts and
// alignment, wrapped and justified text, the letterhead and the stamp.
// Pure — the browser passes a measure() that uses the real fonts; node tests
// use the rough default.

const A4 = { width: 595.28, height: 841.89 };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// cell text: leading and repeated spaces stay, as Excel shows them (SVG would collapse them)
const escText = (v) => esc(v).replace(/^ +| {2,}/g, (m) => '\u00A0'.repeat(m.length));

// Excel's fonts, with look-alikes for devices that don't have them.
const FAMILY = {
  Arial: 'Arial, "Liberation Sans", Arimo, Helvetica, sans-serif',
  'Times New Roman': '"Times New Roman", Times, "Liberation Serif", Tinos, serif',
  // "VF Narrow" is Roboto Condensed, embedded by the app (render.js narrowFontCss)
  'Aptos Narrow': '"Aptos Narrow", "VF Narrow", "Arial Narrow", "Roboto Condensed", Arial, sans-serif',
};
export const familyCss = (name) => FAMILY[name] || `"${name}", Arial, sans-serif`;
const LINE = { Arial: 1.15, 'Times New Roman': 1.15 };      // line height / font size when wrapping
const lineFactor = (name) => LINE[name] || 1.22;

// width of `text` in points at font size `st.s` — rough, for tests
export function roughMeasure(text, st) {
  const k = st.f === 'Aptos Narrow' ? 0.44 : st.f === 'Times New Roman' ? 0.47 : 0.52;
  return String(text).length * st.s * k * (st.b ? 1.06 : 1);
}

// "AB12" -> [row, col] (0-based)
export function cellRef(a) {
  const m = /^([A-Z]+)(\d+)$/.exec(a);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]) - 1, c - 1];
}
const rangeRef = (r) => { const [a, b] = r.split(':'); return [cellRef(a), cellRef(b)]; };

// Split text into lines that fit `width` (explicit line breaks kept).
export function wrapLines(text, width, st, measure) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(' ');            // runs of spaces are kept, as Excel shows them
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && measure(next, st) > width) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

// layout: one LAYOUTS entry. opts:
//   values  {addr: text | {text, b, c, num}} — what the formulas / inputs show
//   texts   {addr: text} — fixed wording read from the workbook (overrides the layout's)
//   images  {letterhead, stamp} — URLs ('' = none)
//   measure (text, style) -> points
//   fontCss @font-face rules to embed (a picture made from the SVG can't load fonts)
export function sheetSvg(layout, { values = {}, texts = {}, images = {}, measure = roughMeasure, page = A4, fontCss = '' } = {}) {
  const { cols, rows, styles, cells } = layout;
  const xs = [0];
  cols.forEach((w) => xs.push(xs[xs.length - 1] + w));
  const ys = [0];
  rows.forEach((h) => ys.push(ys[ys.length - 1] + h));
  const W = xs[xs.length - 1];
  const H = ys[ys.length - 1];
  const m = layout.margins;
  const scale = Math.min(1, (page.width - m.left - m.right) / W, (page.height - m.top - m.bottom) / H);
  const ox = layout.center ? (page.width - W * scale) / 2 : m.left;
  const oy = m.top;

  const merges = new Map();                 // "r,c" of the top-left -> [[r0,c0],[r1,c1]]
  const covered = new Map();                // "r,c" -> the merge it is inside
  for (const rg of layout.merges) {
    const [[r0, c0], [r1, c1]] = rangeRef(rg);
    const mg = [[r0, c0], [Math.min(r1, rows.length - 1), Math.min(c1, cols.length - 1)]];
    merges.set(`${r0},${c0}`, mg);
    for (let r = r0; r <= mg[1][0]; r++) for (let c = c0; c <= mg[1][1]; c++) covered.set(`${r},${c}`, mg);
  }
  const at = (r, c) => cells[addrOf(r, c)];
  const styleAt = (r, c) => { const x = at(r, c); return x ? styles[x.s] : null; };
  const content = (a) => {
    const v = values[a];
    if (v != null && v !== '') return typeof v === 'object' ? (v.text === '' || v.text == null ? null : v) : { text: String(v) };
    const x = cells[a];
    if (!x || x.fx || x.in) return null;
    const t = texts[a] ?? x.t;
    return t ? { text: String(t) } : null;
  };

  const out = [];
  // 1) fills (a merged area takes its top-left cell's fill)
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const key = `${r},${c}`;
      const mg = covered.get(key);
      if (mg && (mg[0][0] !== r || mg[0][1] !== c)) continue;
      const st = styleAt(r, c);
      const cf = values[addrOf(r, c)];
      const bg = (cf && typeof cf === 'object' && cf.bg) || (st && st.bg);       // a conditional format's fill wins
      if (!bg || bg === '#FFFFFF') continue;
      const [[r0, c0], [r1, c1]] = mg || [[r, c], [r, c]];
      out.push(`<rect x="${xs[c0]}" y="${ys[r0]}" width="${(xs[c1 + 1] - xs[c0]).toFixed(2)}" height="${(ys[r1 + 1] - ys[r0]).toFixed(2)}" fill="${bg}"/>`);
    }
  }

  // 2) borders: every cell's own edges, none inside a merged area; the
  //    heavier of two touching cells wins
  const segs = new Map();
  const edge = (x1, y1, x2, y2, w) => {
    const k = `${x1.toFixed(2)},${y1.toFixed(2)},${x2.toFixed(2)},${y2.toFixed(2)}`;
    if ((segs.get(k)?.w || 0) < w) segs.set(k, { x1, y1, x2, y2, w });
  };
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const st = styleAt(r, c);
      if (!st || !st.bd) continue;
      const mg = covered.get(`${r},${c}`);
      const [l, rt, t, b] = st.bd;
      const inside = (dr, dc) => mg && covered.get(`${r + dr},${c + dc}`) === mg;
      if (l && !inside(0, -1)) edge(xs[c], ys[r], xs[c], ys[r + 1], l);
      if (rt && !inside(0, 1)) edge(xs[c + 1], ys[r], xs[c + 1], ys[r + 1], rt);
      if (t && !inside(-1, 0)) edge(xs[c], ys[r], xs[c + 1], ys[r], t);
      if (b && !inside(1, 0)) edge(xs[c], ys[r + 1], xs[c + 1], ys[r + 1], b);
    }
  }
  const px = 0.75 / scale;                   // a printed pixel, in sheet points
  // touching pieces of one line are drawn as one (no darker joins)
  const runs = new Map();
  for (const sg of segs.values()) {
    const flat = sg.y1 === sg.y2;
    const k = `${flat ? 'h' : 'v'}|${(flat ? sg.y1 : sg.x1).toFixed(2)}|${sg.w}`;
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k).push(flat ? [sg.x1, sg.x2] : [sg.y1, sg.y2]);
  }
  const lines = [];
  for (const [k, list] of runs) {
    const [dir, at, w] = k.split('|');
    list.sort((a, b) => a[0] - b[0]);
    let cur = null;
    const flush = () => cur && lines.push(dir === 'h'
      ? { x1: cur[0], y1: +at, x2: cur[1], y2: +at, w: +w } : { x1: +at, y1: cur[0], x2: +at, y2: cur[1], w: +w });
    for (const seg of list) {
      if (cur && seg[0] <= cur[1] + 0.01) cur[1] = Math.max(cur[1], seg[1]);
      else { flush(); cur = [...seg]; }
    }
    flush();
  }
  for (const s of lines) {
    out.push(`<line x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke="#000" stroke-width="${(s.w * px * 0.9).toFixed(2)}" stroke-linecap="square"/>`);
  }

  // 3) pictures
  for (const img of layout.images || []) {
    const href = images[img.key];
    if (href) out.push(`<image href="${esc(href)}" x="${img.x}" y="${img.y}" width="${img.w}" height="${img.h}" preserveAspectRatio="none"/>`);
  }

  // 4) text
  const PAD = 2.25;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const key = `${r},${c}`;
      const mg = covered.get(key);
      if (mg && (mg[0][0] !== r || mg[0][1] !== c)) continue;
      const a = addrOf(r, c);
      const v = content(a);
      if (!v) continue;
      const base = styleAt(r, c) || { f: 'Aptos Narrow', s: 12, c: '#000000' };
      const st = { ...base, ...(v.b != null ? { b: v.b } : {}), ...(v.i != null ? { i: v.i } : {}), ...(v.c ? { c: v.c } : {}) };
      const [[r0, c0], [r1, c1]] = mg || [[r, c], [r, c]];
      let x0 = xs[c0];
      let x1 = xs[c1 + 1];
      const y0 = ys[r0];
      const y1 = ys[r1 + 1];
      const h = st.h || (v.num ? 'right' : 'left');
      const fontOf = (size) => `font-family="${esc(familyCss(st.f))}" font-size="${+size.toFixed(2)}"${st.b ? ' font-weight="bold"' : ''}${st.i ? ' font-style="italic"' : ''}${st.c && st.c !== '#000000' ? ` fill="${st.c}"` : ''}`;
      let font = fontOf(st.s);
      const wrap = st.w || h === 'justify';
      if (wrap) {
        const width = x1 - x0 - 2 * PAD;
        // a font wider than Excel's could need more lines than the row has:
        // then the text gets smaller until it fits (never below 70%)
        let lines;
        let lh;
        for (let size = st.s; ; size -= 0.25) {
          const sized = { ...st, s: size };
          lines = wrapLines(v.text, width, sized, measure);
          lh = size * lineFactor(st.f);
          if (lines.length * lh <= y1 - y0 + 0.5 || size <= st.s * 0.7) {
            if (size !== st.s) { Object.assign(st, { s: size }); font = fontOf(size); }
            break;
          }
        }
        const block = lines.length * lh;
        const vAlign = st.v || 'bottom';
        let top = vAlign === 'top' ? y0 + 1 : vAlign === 'center' ? (y0 + y1 - block) / 2 : y1 - 1 - block;
        if (vAlign !== 'top' && top < y0) top = y0;
        lines.forEach((line, i) => {
          const y = top + i * lh + (lh - st.s) / 2 + st.s * 0.8;
          const words = line.split(' ');
          if (h === 'justify' && i < lines.length - 1 && words.length > 1) {
            const used = words.reduce((s, w) => s + measure(w, st), 0);
            const gap = (width - used) / (words.length - 1);
            let x = x0 + PAD;
            const spans = words.map((w) => { const sp = `<tspan x="${x.toFixed(2)}">${escText(w)}</tspan>`; x += measure(w, st) + gap; return sp; });
            out.push(`<text y="${y.toFixed(2)}" ${font}>${spans.join('')}</text>`);
          } else {
            const { x, anchor } = hpos(h === 'justify' ? 'left' : h, x0, x1, PAD);
            out.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}"${anchor} ${font}>${escText(line)}</text>`);
          }
        });
        continue;
      }
      // one line; it may run over empty neighbours, like Excel's
      if (!mg) {
        const empty = (cc) => cc >= 0 && cc < cols.length && !covered.has(`${r},${cc}`) && !content(addrOf(r, cc));
        if (h === 'left') { let cc = c + 1; while (empty(cc)) { x1 = xs[cc + 1]; cc++; } }
        if (h === 'right') { let cc = c - 1; while (empty(cc)) { x0 = xs[cc]; cc--; } }
        if (h === 'center') {
          let k = 1;
          while (empty(c - k) && empty(c + k)) { x0 = xs[c - k]; x1 = xs[c + k + 1]; k++; }
        }
      }
      const text = v.text.replace(/\n/g, ' ');
      const vAlign = st.v || 'bottom';
      const y = vAlign === 'top' ? y0 + 1 + st.s * 0.9 : vAlign === 'center' ? (y0 + y1) / 2 + st.s * 0.34 : y1 - 1 - st.s * 0.22;
      const room = x1 - x0 - 2 * PAD;
      const wide = measure(text, st);
      const fit = wide > room && room > 0 ? ` textLength="${room.toFixed(2)}" lengthAdjust="spacingAndGlyphs"` : '';
      const { x, anchor } = hpos(h, x0, x1, PAD);
      out.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}"${anchor}${fit} ${font}>${escText(text)}</text>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 ${page.width} ${page.height}" width="${page.width}" height="${page.height}">
<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="#fff"/>
${fontCss ? `<defs><style>${fontCss}</style></defs>` : ''}
<g transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${scale.toFixed(5)})" style="white-space:pre">
${out.join('\n')}
</g>
</svg>`;
}

function hpos(h, x0, x1, pad) {
  if (h === 'center' || h === 'centerContinuous') return { x: (x0 + x1) / 2, anchor: ' text-anchor="middle"' };
  if (h === 'right') return { x: x1 - pad, anchor: ' text-anchor="end"' };
  return { x: x0 + pad, anchor: '' };
}

export function addrOf(r, c) {
  let s = '';
  let n = c + 1;
  while (n) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); }
  return `${s}${r + 1}`;
}

// The browser's measure(): the same font list the page is drawn with.
export function canvasMeasure() {
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (text, st) => {
    const font = `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${st.s}px ${familyCss(st.f)}`;
    const k = `${font}|${text}`;
    if (!cache.has(k)) {
      ctx.font = font;
      cache.set(k, ctx.measureText(String(text)).width);
    }
    return cache.get(k);
  };
}
