// A decantation's result as a picture (PNG) to share — drawn on a canvas in
// the app's colours, so it reads the same on WhatsApp as on the Result screen.
// Takes the figures already formatted (wizard.js resultModel); no DOM needed
// beyond a canvas.

const W = 1080;
const PAD = 48;
const C = {
  bg: '#0f0c0b', card: 'rgba(255,255,255,0.06)', line: 'rgba(255,255,255,0.14)', soft: 'rgba(255,255,255,0.08)',
  ink: '#F5F0EB', muted: '#B4ABA2', faint: '#8a8178',
  short: '#ff9a90', excess: '#2FD08A',          // a tank that got more is good for us: green
};
const BAND = { ok: ['#2FD08A', 'rgba(47,208,138,0.18)'], watch: ['#FFB23E', 'rgba(255,178,62,0.18)'], high: ['#FF6B5E', 'rgba(255,107,94,0.2)'] };
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const DISPLAY = `"Sora", ${SANS}`;
const varColor = (dir) => (dir === 'short' ? C.short : dir === 'excess' ? C.excess : C.ink);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, s, x, y, { font, color = C.ink, align = 'left' }) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

function wrap(ctx, s, font, maxW) {
  ctx.font = font;
  const out = [];
  for (const para of String(s).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxW && line) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

function pill(ctx, label, x, y, [fg, bg], align = 'left') {
  ctx.font = `700 24px ${SANS}`;
  const w = ctx.measureText(label).width + 32;
  const left = align === 'right' ? x - w : x;
  roundRect(ctx, left, y - 30, w, 42, 21);
  ctx.fillStyle = bg;
  ctx.fill();
  text(ctx, label, left + 16, y, { font: `700 24px ${SANS}`, color: fg });
  return w;
}

function card(ctx, y, h) {
  roundRect(ctx, PAD, y, W - 2 * PAD, h, 28);
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.stroke();
}

async function decode(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The stock screenshots under the figures: each tank's stock before and after
// side by side, each cropped to that tank's card (p.crop: shares of the
// picture), a missing one as an empty cell so the pairs stay in line; a whole
// screenshot of several tanks (p.whole) across the width under them.
const PROOF_MAX = 12;
const BLANK_H = 140;
async function proofLayout(proofs) {
  const shots = [];
  for (const p of (proofs || []).slice(0, PROOF_MAX)) {
    if (p.blank) { shots.push({ ...p }); continue; }
    try {
      const img = await decode(p.blob);
      const c = p.crop;
      const src = c ? { sx: c.x0 * img.width, sy: c.y0 * img.height, sw: (c.x1 - c.x0) * img.width, sh: (c.y1 - c.y0) * img.height }
        : { sx: 0, sy: 0, sw: img.width, sh: img.height };
      shots.push({ ...p, img, src });
    } catch { shots.push({ ...p, blank: true, sub: 'The screenshot couldn\'t be opened' }); }
  }
  if (!shots.some((p) => !p.blank)) return null;
  const gap = 24;
  const ctx = document.createElement('canvas').getContext('2d');
  // rows: pairs of cards (before | after), then each whole screenshot on its own
  const pairs = shots.filter((p) => !p.whole);
  const rows = [];
  for (let i = 0; i < pairs.length; i += 2) rows.push(pairs.slice(i, i + 2));
  for (const p of shots.filter((x) => x.whole)) rows.push([p]);
  const cols = (row) => (row[0].whole ? 1 : 2);
  const cellW = (row) => (W - 2 * PAD - (cols(row) - 1) * gap) / cols(row);
  const font = (row) => `700 ${cols(row) === 1 ? 28 : 24}px ${SANS}`;
  const rowH = rows.map((row) => {
    const cw = cellW(row);
    let lines = 1;
    for (const p of row) {
      p.lines = wrap(ctx, p.label || 'Screenshot', font(row), cw - 32).slice(0, 2);
      lines = Math.max(lines, p.lines.length);
      if (p.blank) { p.w = 0; p.h = BLANK_H; continue; }
      const k = Math.min((cw - 32) / p.src.sw, (cols(row) === 1 ? 1400 : 1000) / p.src.sh);
      p.w = Math.round(p.src.sw * k);
      p.h = Math.round(p.src.sh * k);
    }
    row.head = 58 + lines * 34;
    return row.head + Math.max(...row.map((p) => p.h)) + 20;
  });
  const height = 56 + rowH.reduce((a, h) => a + h + gap, 0);
  return { shots: shots.filter((p) => p.img), rows, rowH, cols, cellW, gap, height, font };
}

function drawProofs(ctx, L, y0) {
  text(ctx, 'STOCK PROOF · AUTOMATION SCREENSHOTS', PAD, y0 + 34, { font: `700 22px ${SANS}`, color: C.faint });
  let y = y0 + 56;
  L.rows.forEach((row, ri) => {
    const cw = L.cellW(row);
    row.forEach((p, ci) => {
      const x = PAD + ci * (cw + L.gap);
      roundRect(ctx, x, y, cw, L.rowH[ri], 24);
      ctx.fillStyle = C.card;
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 2;
      ctx.stroke();
      p.lines.forEach((l, i) => text(ctx, l, x + 16, y + 40 + i * 34, { font: L.font(row) }));
      text(ctx, p.sub || '', x + 16, y + 40 + p.lines.length * 34, { font: `500 22px ${SANS}`, color: C.muted });
      if (p.blank || !p.img) return;
      const ix = x + (cw - p.w) / 2;
      const iy = y + row.head;
      ctx.save();
      roundRect(ctx, ix, iy, p.w, p.h, 12);
      ctx.clip();
      ctx.drawImage(p.img, p.src.sx, p.src.sy, p.src.sw, p.src.sh, ix, iy, p.w, p.h);
      ctx.restore();
    });
    y += L.rowH[ri] + L.gap;
  });
}

// m: {title, sub, when, total, variation, direction, summary,
//     tanks: [{name, product, color, band, bandLabel, direction, variation, pctLine, meta, rows: [[label, litres, extra, bold, direction]]}],
//     notes, footer, audit: {ok, text} | null, made,
//     proofs: [{blob, label, sub}] — stock screenshots to show under the figures (optional)}
// The canvas returned carries proofCount: how many screenshots made it in.
export async function resultImage(m) {
  try { await Promise.all(['800 64px Sora', '700 34px Sora'].map((f) => document.fonts.load(f))); } catch { /* system fonts */ }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 5200;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, canvas.height);
  const glow = ctx.createRadialGradient(W * 0.85, 120, 40, W * 0.85, 120, 900);
  glow.addColorStop(0, 'rgba(244,81,30,0.22)');
  glow.addColorStop(1, 'rgba(244,81,30,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, 1400);

  // header band
  const band = ctx.createLinearGradient(0, 0, W, 240);
  band.addColorStop(0, '#F4511E');
  band.addColorStop(1, '#FF8A2B');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, 236);
  text(ctx, 'VRIDDHI FUELS · DECANTING RESULT', PAD, 64, { font: `700 26px ${SANS}`, color: 'rgba(255,255,255,0.88)' });
  text(ctx, m.title, PAD, 146, { font: `800 68px ${DISPLAY}`, color: '#fff' });
  text(ctx, m.sub, PAD, 198, { font: `500 28px ${SANS}`, color: 'rgba(255,255,255,0.92)' });
  let y = 236 + 32;

  // summary
  card(ctx, y, 236);
  text(ctx, `Decanted ${m.total} · ${m.when}`, PAD + 36, y + 58, { font: `500 30px ${SANS}`, color: C.muted });
  text(ctx, m.variation, PAD + 36, y + 152, { font: `800 84px ${DISPLAY}`, color: varColor(m.direction) });
  text(ctx, m.summary, PAD + 36, y + 204, { font: `500 28px ${SANS}`, color: C.muted });
  y += 236 + 24;

  // one card per tank
  for (const t of m.tanks) {
    const h = 262 + (t.rows.length - 1) * 56 + 36;
    card(ctx, y, h);
    const x = PAD + 36;
    const right = W - PAD - 36;
    const nameW = text(ctx, t.name, x, y + 66, { font: `800 42px ${DISPLAY}` });
    // product chip
    ctx.font = `700 26px ${SANS}`;
    const chipW = ctx.measureText(t.product).width + 58;
    roundRect(ctx, x + nameW + 18, y + 34, chipW, 44, 22);
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + nameW + 18 + 24, y + 56, 9, 0, Math.PI * 2);
    ctx.fillStyle = t.color;
    ctx.fill();
    text(ctx, t.product, x + nameW + 18 + 42, y + 65, { font: `700 26px ${SANS}` });
    if (t.band) pill(ctx, t.bandLabel, right, y + 66, BAND[t.band], 'right');
    text(ctx, t.meta, x, y + 110, { font: `500 26px ${SANS}`, color: C.faint });
    text(ctx, t.variation, x, y + 186, { font: `800 60px ${DISPLAY}`, color: varColor(t.direction) });
    text(ctx, t.pctLine, right, y + 180, { font: `500 26px ${SANS}`, color: C.muted, align: 'right' });
    let ry = y + 262;
    for (const [label, litres, extra, bold, dir] of t.rows) {
      const good = dir === 'excess';                                   // more than the chambers held: green
      ctx.fillStyle = C.soft;
      ctx.fillRect(x, ry - 40, right - x, 2);
      text(ctx, label, x, ry, { font: `${bold ? 700 : 500} 28px ${SANS}`, color: bold ? C.ink : C.muted });
      text(ctx, litres, right - 210, ry, { font: `${bold ? 800 : 600} 30px ${SANS}`, color: good ? C.excess : C.ink, align: 'right' });
      if (extra) text(ctx, extra, right, ry, { font: `500 26px ${SANS}`, color: good ? C.excess : C.faint, align: 'right' });
      ry += 56;
    }
    y += h + 24;
  }

  // notes and footer
  if (m.notes) {
    const lines = wrap(ctx, m.notes, `500 28px ${SANS}`, W - 2 * PAD - 72);
    const h = 70 + lines.length * 40;
    card(ctx, y, h);
    text(ctx, 'NOTES', PAD + 36, y + 48, { font: `700 22px ${SANS}`, color: C.faint });
    lines.forEach((l, i) => text(ctx, l, PAD + 36, y + 90 + i * 40, { font: `500 28px ${SANS}` }));
    y += h + 24;
  }
  // the internal-audit line: every stock from a screenshot or a dip, or which were typed in
  if (m.audit) {
    for (const l of wrap(ctx, m.audit.text, `600 26px ${SANS}`, W - 2 * PAD)) {
      y += 36;
      text(ctx, l, PAD, y, { font: `600 26px ${SANS}`, color: m.audit.ok ? '#2FD08A' : '#FFB23E' });
    }
    y += 6;
  }
  for (const l of wrap(ctx, m.footer || '', `500 26px ${SANS}`, W - 2 * PAD)) {
    if (!l) continue;
    y += 36;
    text(ctx, l, PAD, y, { font: `500 26px ${SANS}`, color: C.muted });
  }
  const proofs = await proofLayout(m.proofs);
  const top = Math.ceil(y);
  const height = top + (proofs ? 24 + proofs.height : 0) + 44 + PAD;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = height;
  const octx = out.getContext('2d');
  octx.textBaseline = 'alphabetic';
  octx.fillStyle = C.bg;
  octx.fillRect(0, 0, W, height);
  const keep = proofs ? top : Math.min(height, canvas.height);      // no screenshots: the picture as it always was
  octx.drawImage(canvas, 0, 0, W, keep, 0, 0, W, keep);
  y = top;
  if (proofs) {
    drawProofs(octx, proofs, y + 24);
    y += 24 + proofs.height;
    for (const p of proofs.shots) p.img.close?.();
  }
  y += 44;
  text(octx, m.made, PAD, y, { font: `500 22px ${SANS}`, color: C.faint });
  out.proofCount = proofs ? proofs.shots.length : 0;
  return out;
}
