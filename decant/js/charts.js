// Small SVG charts for the Reports tab. Drawn at the container's real width
// (so text stays crisp on a phone) and redrawn on resize. Every mark has a
// tooltip on hover / tap / keyboard focus; the tables under each chart carry
// the same numbers without hovering.

const NS = 'http://www.w3.org/2000/svg';

// Axis numbers with a real minus sign.
const tickText = (v, unit = '') => `${v < 0 ? '−' : v > 0 && unit === '%' ? '+' : ''}${Math.abs(v).toLocaleString('en-IN')}${unit}`;

function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.append(el);
  return el;
}

// Round axis ticks: 0, ±50, ±100 … covering [lo, hi].
export function niceTicks(lo, hi, count = 4) {
  const span = Math.max(1e-9, hi - lo);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const start = Math.floor(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { ticks: out, step };
}

function tooltip(host) {
  let tip = host.querySelector('.viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    host.append(tip);
  }
  return {
    show(rows, x, y) {
      tip.replaceChildren();
      for (const r of rows) {
        const line = document.createElement('div');
        line.className = r.head ? 'viz-tip-head' : 'viz-tip-row';
        if (r.color) {
          const key = document.createElement('span');
          key.className = 'viz-tip-key';
          key.style.background = r.color;
          line.append(key);
        }
        if (r.value !== undefined) {
          const b = document.createElement('b');
          b.textContent = r.value;
          line.append(b);
        }
        const s = document.createElement('span');
        s.textContent = r.label || '';
        line.append(s);
        tip.append(line);
      }
      tip.classList.add('show');
      const w = host.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(4, Math.min(w - tw - 4, x - tw / 2))}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 12)}px`;
    },
    hide() { tip.classList.remove('show'); },
  };
}

function bindMark(mark, host, tip, rowsFn, anchor) {
  mark.setAttribute('tabindex', '0');
  const show = () => {
    const a = anchor();
    mark.classList.add('hot');
    tip.show(rowsFn(), a.x, a.y);
  };
  const hide = () => { mark.classList.remove('hot'); tip.hide(); };
  mark.addEventListener('pointerenter', show);
  mark.addEventListener('pointerleave', hide);
  mark.addEventListener('focus', show);
  mark.addEventListener('blur', hide);
  mark.addEventListener('click', show);
}

// Net variation per day (or per month), as columns up (excess) and down
// (short) from zero.
//   days: [{key: 'YYYY-MM-DD' | 'YYYY-MM', variation, litres, count}]
export function dailyVariation(host, days, { fmtDay, fmtL, fmtVar, fmtPct, label = 'Net variation per day' }) {
  host.querySelectorAll('svg').forEach((s) => s.remove());
  const W = Math.max(280, host.clientWidth);
  const H = 210;
  const pad = { l: 46, r: 10, t: 12, b: 26 };
  const vals = days.map((d) => d.variation);
  const { ticks } = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals, 1), 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v) => pad.t + ((hi - v) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const band = (W - pad.l - pad.r) / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(24, band - 2));
  const svg = svgEl('svg', { width: W, height: H, class: 'viz', role: 'img', 'aria-label': label });
  host.prepend(svg);
  for (const t of ticks) {
    svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-base' : 'viz-grid' }, svg);
    const lab = svgEl('text', { x: pad.l - 6, y: y(t) + 4, class: 'viz-tick', 'text-anchor': 'end' }, svg);
    lab.textContent = tickText(t);
  }
  const every = Math.max(1, Math.ceil(days.length / Math.floor((W - pad.l - pad.r) / 44)));
  const tip = tooltip(host);
  days.forEach((d, i) => {
    const cx = pad.l + band * i + band / 2;
    // every n-th label, and always the last (dropping one that would crowd it)
    if ((i % every === 0 && days.length - 1 - i >= every) || i === days.length - 1) {
      const lab = svgEl('text', { x: cx, y: H - 8, class: 'viz-tick', 'text-anchor': 'middle' }, svg);
      lab.textContent = fmtDay(d.key);
    }
    const g = svgEl('g', { class: 'viz-mark' }, svg);
    svgEl('rect', { x: pad.l + band * i, y: pad.t, width: band, height: H - pad.t - pad.b, fill: 'transparent' }, g);
    if (d.count) {
      const v = d.variation;
      const y0 = y(0);
      const y1 = y(v);
      const h = Math.max(1, Math.abs(y1 - y0));
      const top = v >= 0 ? y0 - h : y0;
      const r = Math.min(4, h, bw / 2);
      // rounded at the data end, square at the zero line
      const x0 = cx - bw / 2;
      const d0 = v >= 0
        ? `M${x0},${y0} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${y0} Z`
        : `M${x0},${y0} V${top + h - r} Q${x0},${top + h} ${x0 + r},${top + h} H${x0 + bw - r} Q${x0 + bw},${top + h} ${x0 + bw},${top + h - r} V${y0} Z`;
      svgEl('path', { d: d0, class: v < 0 ? 'viz-short' : 'viz-excess' }, g);
    }
    bindMark(g, host, tip, () => (d.count
      ? [{ head: true, label: fmtDay(d.key, true) },
        { value: fmtVar(d.variation), label: ` ${d.variation < 0 ? 'short' : 'excess'} (${fmtPct(d.pct)})` },
        { value: fmtL(d.litres), label: ` decanted · ${d.count} tank${d.count === 1 ? '' : 's'}` }]
      : [{ head: true, label: fmtDay(d.key, true) }, { label: 'No decanting' }]),
    () => ({ x: cx, y: d.count ? Math.min(y(d.variation), y(0)) : y(0) }));
  });
}

// Variation % of every decantation over time, one dot each, coloured by
// product, with the tolerance band behind.
//   points: [{at, pct, variation, litres, tt, product, band}]
export function variationDots(host, points, { tolPct, colors, fmtWhen, fmtL, fmtVar, fmtPct, names }) {
  host.querySelectorAll('svg').forEach((s) => s.remove());
  const W = Math.max(280, host.clientWidth);
  const H = 220;
  const pad = { l: 46, r: 14, t: 12, b: 26 };
  const ts = points.map((p) => Date.parse(p.at));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const span = Math.max(3600000, t1 - t0);
  const x = (t) => pad.l + ((t - t0 + span * 0.04) / (span * 1.08)) * (W - pad.l - pad.r);
  const lim = Math.max(tolPct * 2.2, ...points.map((p) => Math.abs(p.pct)));
  const { ticks } = niceTicks(-lim, lim, 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v) => pad.t + ((hi - v) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const svg = svgEl('svg', { width: W, height: H, class: 'viz', role: 'img', 'aria-label': 'Variation per decantation' });
  host.prepend(svg);
  svgEl('rect', { x: pad.l, width: W - pad.l - pad.r, y: y(tolPct), height: Math.max(1, y(-tolPct) - y(tolPct)), class: 'viz-tolband' }, svg);
  for (const t of ticks) {
    svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-base' : 'viz-grid' }, svg);
    const lab = svgEl('text', { x: pad.l - 6, y: y(t) + 4, class: 'viz-tick', 'text-anchor': 'end' }, svg);
    lab.textContent = tickText(t, '%');
  }
  // a few time labels
  const n = Math.max(2, Math.min(5, Math.floor((W - pad.l - pad.r) / 90)));
  for (let i = 0; i < n; i++) {
    const t = t0 - span * 0.04 + (span * 1.08 * (i + 0.5)) / n;
    const lab = svgEl('text', { x: x(t), y: H - 8, class: 'viz-tick', 'text-anchor': 'middle' }, svg);
    lab.textContent = fmtWhen(t, span);
  }
  const tip = tooltip(host);
  points.forEach((p, i) => {
    const cx = x(ts[i]);
    const cy = y(p.pct);
    const g = svgEl('g', { class: 'viz-mark' }, svg);
    svgEl('circle', { cx, cy, r: 12, fill: 'transparent' }, g);           // 24 px hit area
    svgEl('circle', { cx, cy, r: 5, class: 'viz-dot', fill: colors[p.product] || '#898781' }, g);
    bindMark(g, host, tip, () => [
      { head: true, label: `${fmtWhen(ts[i], 0)} · ${p.tt}` },
      { color: colors[p.product], value: fmtVar(p.variation), label: ` ${fmtPct(p.pct)} · ${names[p.product] || p.product}` },
      { value: fmtL(p.litres), label: ' decanted' },
    ], () => ({ x: cx, y: cy - 6 }));
  });
}
