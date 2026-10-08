// The pictures the ledger screens share: drawn in the app's own look (dark
// glass, orange light, Sora) rather than the Excel sheet's.
//   ledgerPagesSvg()     — a customer's statement: balance, summary tiles,
//                          company-wise outstanding for a group, then every
//                          entry by month with the running balance; as many
//                          pages (A4 shape) as it needs
//   outstandingCardSvg() — one customer's outstanding as a card (a group's
//                          card lists each company)
//   outstandingListSvg() — everyone's outstanding today, largest first
// Pure: returns SVG strings (images as data: URLs, fonts as @font-face CSS
// passed in). render.js jpegFromSvg / pdfFromSvgs turn them into files.

export const SHARE_PAGE = { width: 1280, height: 1810 };          // px; A4's shape
export const SHARE_PAGE_PT = { width: 595.28, height: 841.89 };
export const CARD_WIDTH = 1080;

const C = {
  bg: '#0b0807', ink: '#f5f0eb', muted: '#b4aba2', faint: '#7c746c', good: '#2fd08a', bad: '#ff6b5e', warn: '#ffb23e',
  amber: '#ff9e42', HSD: '#3987e5', MS: '#d95926', XG: '#199e70', OTHER: '#9085e9', PAY: '#2fd08a',
};
const SANS = 'Sora, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Roboto, Arial, sans-serif';
const PRODUCT = { HSD: 'Diesel', MS: 'Petrol', XG: 'XtraGreen', OTHER: 'Other' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;

// ---- numbers and dates --------------------------------------------------------------
const ind = (n, d = 0) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
// ₹12,34,567 (whole rupees; paise when under ₹1,000 and not whole)
export function rupees(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const a = Math.abs(v);
  return `${v < 0 ? '−' : ''}₹${ind(a, a < 1000 && a % 1 ? 2 : 0)}`;
}
// a balance the Tally way: ₹12,34,567 Dr (they owe) / ₹45,000 Cr (advance)
export function drCr(n) {
  const v = Math.round(Number(n) || 0);
  if (!v) return '₹0';
  return `₹${ind(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}`;
}
export function qtyText(n) {
  const v = Number(n) || 0;
  return v ? `${ind(v, v % 1 ? 2 : 0)} L` : '';
}
export const dMon = (iso) => (iso ? `${iso.slice(8, 10)} ${MON[Number(iso.slice(5, 7)) - 1]}` : '');
export const dMonY = (iso) => (iso ? `${dMon(iso)} ${iso.slice(0, 4)}` : '');

// ---- text that fits ----------------------------------------------------------------------
// A cautious estimate of Sora's widths (it runs wider than system fonts), so a
// fitted string never overflows whichever font the phone ends up drawing with.
export function textWidth(text, size, weight = 400) {
  let w = 0;
  for (const ch of String(text)) {
    if (ch === ' ') w += 0.28;
    else if (/[0-9]/.test(ch)) w += 0.62;
    else if (/[A-Z]/.test(ch)) w += 0.7;
    else if (/[a-z]/.test(ch)) w += 0.57;
    else if (/[.,:;'|!]/.test(ch)) w += 0.3;
    else w += 0.62;
  }
  return w * size * (weight >= 700 ? 1.07 : weight >= 600 ? 1.04 : 1);
}
export function fit(text, max, size, weight = 400) {
  const s = String(text ?? '');
  if (textWidth(s, size, weight) <= max) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}…`, size, weight) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

const T = (x, y, text, { size = 20, weight = 400, fill = C.ink, anchor = 'start', opacity, spacing, max, extra = '' } = {}) => {
  if (text == null || text === '') return '';
  const s = max ? fit(text, max, size, weight) : String(text);
  return `<text x="${r1(x)}" y="${r1(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${opacity != null ? ` fill-opacity="${opacity}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}${extra}>${esc(s)}</text>`;
};
const R = (x, y, w, h, { rx = 0, fill = '#fff', opacity, stroke, strokeOpacity, extra = '' } = {}) => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"${opacity != null ? ` fill-opacity="${opacity}"` : ''}${stroke ? ` stroke="${stroke}" stroke-opacity="${strokeOpacity ?? 1}" stroke-width="1.5"` : ''}${extra}/>`;

function defs(fontCss = '') {
  return `<defs>
<style>${fontCss || ''} text { font-family: ${SANS.replaceAll('&quot;', '"')}; font-variant-numeric: tabular-nums; }</style>
<linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4511e"/><stop offset=".55" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ff9e42"/></linearGradient>
<radialGradient id="g1" cx=".85" cy="0" r=".65"><stop offset="0" stop-color="#f4511e" stop-opacity=".34"/><stop offset="1" stop-color="#f4511e" stop-opacity="0"/></radialGradient>
<radialGradient id="g2" cx="0" cy=".06" r=".55"><stop offset="0" stop-color="#ff9e42" stop-opacity=".15"/><stop offset="1" stop-color="#ff9e42" stop-opacity="0"/></radialGradient>
<radialGradient id="g3" cx=".5" cy="1.04" r=".6"><stop offset="0" stop-color="#7828b4" stop-opacity=".16"/><stop offset="1" stop-color="#7828b4" stop-opacity="0"/></radialGradient>
<radialGradient id="shine" cx=".92" cy="0" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>`;
}

function backdrop(w, h) {
  return `${R(0, 0, w, h, { fill: C.bg })}${R(0, 0, w, Math.min(h, 1400), { fill: 'url(#g1)' })}${R(0, 0, w, Math.min(h, 1200), { fill: 'url(#g2)' })}${R(0, Math.max(0, h - 1100), w, Math.min(h, 1100), { fill: 'url(#g3)' })}`;
}

// the logo on a rounded tile (the picture is clipped to the tile: its own
// background is off-white)
let clipN = 0;
function logoTile(x, y, size, rx, images) {
  if (!images.logo) return `${R(x, y, size, size, { rx, fill: '#fff' })}${T(x + size / 2, y + size * 0.63, 'VF', { size: size * 0.37, weight: 800, fill: '#f4511e', anchor: 'middle' })}`;
  const id = `logo${clipN++}`;
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}"/></clipPath>
${R(x, y, size, size, { rx, fill: '#fbfaf8' })}<image href="${esc(images.logo)}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
}

// the brand row: logo tile, VRIDDHI FUELS, what this is; the date on the right
function brandRow(w, pad, y, what, asOn, images) {
  return `${logoTile(pad, y, 92, 22, images)}
${T(pad + 116, y + 44, 'VRIDDHI FUELS', { size: 32, weight: 800, spacing: 1.5 })}
${T(pad + 116, y + 78, what, { size: 20, fill: C.muted })}
${asOn ? `${T(w - pad, y + 36, 'AS ON', { size: 15, weight: 700, fill: C.faint, anchor: 'end', spacing: 2 })}${T(w - pad, y + 72, dMonY(asOn), { size: 24, weight: 700, anchor: 'end' })}` : ''}
${R(pad, y + 124, w - 2 * pad, 1.5, { opacity: 0.1 })}`;
}

function pill(x, y, text, color) {
  const w = textWidth(text, 15, 700) + 30;
  return `${R(x, y, w, 32, { rx: 16, fill: color, opacity: 0.16, stroke: color, strokeOpacity: 0.5 })}${T(x + w / 2, y + 22, text, { size: 15, weight: 700, fill: color, anchor: 'middle', spacing: 1.5 })}`;
}

function hero(x, y, w, h, label, amount, right = []) {
  let out = `${R(x, y, w, h, { rx: 30, fill: 'url(#brand)' })}${R(x, y, w, h, { rx: 30, fill: 'url(#shine)' })}
${T(x + 40, y + 56, label, { size: 19, weight: 700, fill: '#fff', opacity: 0.86, spacing: 2 })}
${T(x + 40, y + h - 46, amount, { size: 74, weight: 800, fill: '#fff', spacing: -1.5 })}`;
  right.forEach(([lbl, val], i) => {
    const yy = y + 56 + i * 64;
    out += `${T(x + w - 40, yy, lbl, { size: 16, weight: 700, fill: '#fff', opacity: 0.78, anchor: 'end', spacing: 1.5 })}${T(x + w - 40, yy + 32, val, { size: 25, weight: 700, fill: '#fff', anchor: 'end' })}`;
  });
  return out;
}

function tiles(x, y, w, list) {
  const gap = 16;
  const tw = (w - gap * (list.length - 1)) / list.length;
  return list.map((t, i) => {
    const tx = x + i * (tw + gap);
    return `${R(tx, y, tw, 132, { rx: 22, opacity: 0.05, stroke: '#fff', strokeOpacity: 0.1 })}${R(tx, y + 22, 5, 88, { rx: 2.5, fill: t.color || 'url(#brand)' })}
${T(tx + 26, y + 40, t.label.toUpperCase(), { size: 15, weight: 700, fill: C.muted, spacing: 1.5, max: tw - 40 })}
${T(tx + 26, y + 84, t.value, { size: 31, weight: 800, max: tw - 40, fill: t.valueColor || C.ink })}
${T(tx + 26, y + 113, t.sub || '', { size: 16, fill: C.muted, max: tw - 40 })}`;
  }).join('');
}

function balanceLabel(closing) {
  const v = Math.round(Number(closing) || 0);
  if (v > 0) return { label: 'OUTSTANDING', amount: rupees(v) };
  if (v < 0) return { label: 'ADVANCE WITH US', amount: rupees(-v) };
  return { label: 'ALL SETTLED', amount: '₹0' };
}

function productLine(x, y, products) {
  let cx = x;
  let out = '';
  for (const p of ['HSD', 'MS', 'XG', 'OTHER']) {
    const v = products[p];
    if (!v || !(v.amount || v.qty)) continue;
    const text = `${PRODUCT[p]}  ${p === 'OTHER' ? rupees(v.amount) : `${qtyText(v.qty)} · ${rupees(v.amount)}`}`;
    const w = textWidth(text, 17, 600) + 52;
    out += `${R(cx, y, w, 40, { rx: 20, opacity: 0.06, stroke: '#fff', strokeOpacity: 0.12 })}<circle cx="${cx + 22}" cy="${y + 20}" r="7" fill="${C[p]}"/>${T(cx + 38, y + 26, text, { size: 17, weight: 600 })}`;
    cx += w + 12;
  }
  return out;
}

// company-wise outstanding of a group: one row per company, then the group's opening and total
function companiesBlock(x, y, w, cw) {
  const max = Math.max(1, ...cw.list.map((c) => Math.abs(c.outstanding)));
  let out = T(x, y + 24, 'COMPANY-WISE OUTSTANDING', { size: 16, weight: 700, fill: C.muted, spacing: 2 });
  let yy = y + 44;
  for (const c of cw.list) {
    out += `${R(x, yy, w, 74, { rx: 18, opacity: 0.05, stroke: '#fff', strokeOpacity: 0.09 })}
${T(x + 24, yy + 32, c.name, { size: 21, weight: 700, max: w * 0.55 })}
${T(x + 24, yy + 58, `${c.bills} bills · billed ${rupees(c.billed)} · received ${rupees(c.received)}${c.deductions ? ` · TDS/short ${rupees(c.deductions)}` : ''}`, { size: 15, fill: C.muted, max: w * 0.62 })}
${R(x + w * 0.66, yy + 47, w * 0.34 - 24, 6, { rx: 3, opacity: 0.08 })}${R(x + w * 0.66, yy + 47, Math.max(4, (w * 0.34 - 24) * (Math.abs(c.outstanding) / max)), 6, { rx: 3, fill: c.outstanding >= 0 ? C.warn : C.good, opacity: 0.85 })}
${T(x + w - 24, yy + 34, drCr(c.outstanding), { size: 23, weight: 800, anchor: 'end', fill: c.outstanding < 0 ? C.good : C.ink })}`;
    yy += 84;
  }
  if (Math.round(cw.opening)) {
    out += `${T(x + 24, yy + 22, 'Opening balance of the group', { size: 17, fill: C.muted })}${T(x + w - 24, yy + 22, drCr(cw.opening), { size: 19, weight: 700, anchor: 'end', fill: cw.opening < 0 ? C.good : C.ink })}`;
    yy += 36;
  }
  out += `${R(x, yy, w, 1.5, { opacity: 0.12 })}${T(x + 24, yy + 34, 'Group balance', { size: 19, weight: 700 })}${T(x + w - 24, yy + 34, drCr(cw.total), { size: 23, weight: 800, anchor: 'end', fill: cw.total < 0 ? C.good : C.amber })}`;
  return { svg: out, height: yy + 50 - y };
}
const companiesHeight = (cw) => 44 + cw.list.length * 84 + (Math.round(cw.opening) ? 36 : 0) + 50;

// ---- the statement ---------------------------------------------------------------------
const COL = (w, pad) => ({
  date: pad + 18, part: pad + 132, partMax: w - 2 * pad - 132 - 664, qty: w - pad - 578, rate: w - pad - 486, debit: w - pad - 358, credit: w - pad - 208, bal: w - pad - 18,
});
const H = { head: 50, open: 58, month: 54, row: 66, total: 76 };

function tableHead(x, y, w, col) {
  return `${R(x, y, w, H.head, { rx: 14, opacity: 0.07 })}
${T(col.date, y + 32, 'DATE', { size: 14, weight: 700, fill: C.muted, spacing: 1.5 })}${T(col.part, y + 32, 'PARTICULARS', { size: 14, weight: 700, fill: C.muted, spacing: 1.5 })}
${T(col.qty, y + 32, 'LITRES', { size: 14, weight: 700, fill: C.muted, anchor: 'end', spacing: 1.5 })}${T(col.rate, y + 32, 'RATE', { size: 14, weight: 700, fill: C.muted, anchor: 'end', spacing: 1.5 })}
${T(col.debit, y + 32, 'DEBIT', { size: 14, weight: 700, fill: C.muted, anchor: 'end', spacing: 1.5 })}${T(col.credit, y + 32, 'CREDIT', { size: 14, weight: 700, fill: C.muted, anchor: 'end', spacing: 1.5 })}
${T(col.bal, y + 32, 'BALANCE', { size: 14, weight: 700, fill: C.muted, anchor: 'end', spacing: 1.5 })}`;
}

function line(l, x, y, w, col) {
  const bal = (v, size = 19, weight = 700) => T(col.bal, y + (l.t === 'row' ? 30 : 36), drCr(v), { size, weight, anchor: 'end', fill: v < -0.5 ? C.good : C.ink });
  if (l.t === 'open') {
    return `${T(col.part, y + 36, l.label, { size: 18, weight: 600, fill: C.muted })}${T(col.date, y + 36, dMon(l.date), { size: 17, fill: C.faint })}${bal(l.balance)}`;
  }
  if (l.t === 'month') {
    const m = l.m;
    return `${R(x, y + 8, w, H.month - 12, { rx: 14, fill: 'url(#brand)', opacity: 0.13 })}
${T(col.date, y + 37, m.title.toUpperCase(), { size: 17, weight: 800, fill: C.amber, spacing: 2 })}
${T(col.bal, y + 37, `billed ${rupees(m.billed)}  ·  received ${rupees(m.received)}${m.deductions ? `  ·  TDS/short ${rupees(m.deductions)}` : ''}`, { size: 15, fill: C.muted, anchor: 'end' })}`;
  }
  if (l.t === 'total') {
    return `${R(x, y + 6, w, H.total - 8, { rx: 16, opacity: 0.07, stroke: '#fff', strokeOpacity: 0.14 })}
${T(col.date, y + 49, l.label, { size: 20, weight: 800 })}
${T(col.qty, y + 49, qtyText(l.qty), { size: 18, weight: 700, anchor: 'end' })}
${T(col.debit, y + 49, rupees(l.debit), { size: 18, weight: 700, anchor: 'end' })}
${T(col.credit, y + 49, rupees(l.credit), { size: 18, weight: 700, anchor: 'end', fill: C.good })}
${T(col.bal, y + 49, drCr(l.balance), { size: 21, weight: 800, anchor: 'end', fill: l.balance < -0.5 ? C.good : C.amber })}`;
  }
  const e = l.e;
  const pay = e.type === 'pay';
  const deduct = [e.tds ? `TDS ${rupees(e.tds)}` : '', e.shortage ? `short ${rupees(e.shortage)}` : ''].filter(Boolean).join(' + ');
  return `${l.zebra ? R(x, y + 2, w, H.row - 4, { rx: 12, opacity: 0.028 }) : ''}
${T(col.date, y + 30, dMon(e.date), { size: 18, weight: 600 })}
<circle cx="${col.part - 16}" cy="${y + 24}" r="6" fill="${C[e.product] || C.OTHER}"/>
${T(col.part, y + 30, e.title, { size: 19, weight: 600, max: col.partMax, fill: pay ? C.good : C.ink })}
${T(col.part, y + 54, e.detail, { size: 15, fill: C.muted, max: col.partMax })}
${T(col.qty, y + 30, qtyText(e.qty).replace(' L', ''), { size: 18, anchor: 'end' })}
${T(col.rate, y + 30, e.rate ? e.rate.toFixed(2) : '', { size: 18, anchor: 'end', fill: C.muted })}
${T(col.debit, y + 30, e.debit ? rupees(e.debit) : '', { size: 18, weight: 600, anchor: 'end' })}
${T(col.credit, y + 30, e.credit ? rupees(e.credit) : '', { size: 18, weight: 600, anchor: 'end', fill: e.credit < 0 ? C.bad : C.good })}
${deduct ? T(col.credit, y + 54, `incl. ${deduct}`, { size: 13, fill: C.muted, anchor: 'end' }) : ''}
${bal(e.balance, 18)}`;
}

// st: ledger-view.js bulkStatement() / retailStatement() (optionally cut to a
// month: {..., entries, months, opening, closing, from, to} of that month)
// opts: { asOn, images: {logo}, fontCss, title }
export function ledgerPagesSvg(st, { asOn = '', images = {}, fontCss = '', title = 'Statement of account', tag = '' } = {}) {
  const { width: w, height: h } = SHARE_PAGE;
  const pad = 56;
  const col = COL(w, pad);
  // the statement as lines: opening, then each month's band and entries, then the total
  const lines = [{ t: 'open', label: 'Opening balance', date: st.from, balance: st.opening, h: H.open }];
  let z = 0;
  for (const m of st.months) {
    lines.push({ t: 'month', m, h: H.month });
    for (const e of m.entries) lines.push({ t: 'row', e, zebra: z++ % 2 === 1, h: H.row });
  }
  const t = st.totals;
  lines.push({ t: 'total', label: 'Closing balance', qty: t.qty, debit: t.billed, credit: t.received + t.tds + t.shortage, balance: st.closing, h: H.total });

  // page 1's head: brand, name, balance, tiles, products, companies
  const bl = balanceLabel(st.closing);
  const kind = tag || (st.kind === 'bulk' ? 'BULK LEDGER' : 'LEDGER');
  const head1 = (pageNo, pages) => {
    let y = 48;
    let out = brandRow(w, pad, y, title, asOn, images);
    y += 172;
    out += pill(pad, y, kind, C.amber);
    out += T(pad, y + 86, st.name, { size: 46, weight: 800, max: w - 2 * pad, spacing: -0.5 });
    out += T(pad, y + 128, `${dMonY(st.from)} – ${dMonY(st.to)}  ·  ${t.bills} bill${t.bills === 1 ? '' : 's'}  ·  ${t.payments} payment${t.payments === 1 ? '' : 's'}`, { size: 20, fill: C.muted, max: w - 2 * pad });
    y += 160;
    out += hero(pad, y, w - 2 * pad, 186, bl.label, bl.amount, [
      ['BALANCE', drCr(st.closing)],
      st.lastPayment ? ['LAST PAYMENT', `${rupees(st.lastPayment.amount)} · ${dMon(st.lastPayment.date)}`] : ['LAST PAYMENT', '—'],
    ]);
    y += 210;
    const deductions = t.tds + t.shortage;
    out += tiles(pad, y, w - 2 * pad, [
      { label: 'Opening', value: drCr(st.opening), sub: `on ${dMon(st.from)}`, color: C.faint },
      { label: 'Billed', value: rupees(t.billed), sub: t.qty ? `${qtyText(t.qty)} · ${t.bills} bills` : `${t.bills} bills`, color: C.HSD },
      { label: 'Received', value: rupees(t.received), sub: `${t.payments} payment${t.payments === 1 ? '' : 's'}`, color: C.good },
      deductions
        ? { label: 'TDS & shortage', value: rupees(deductions), sub: `TDS ${rupees(t.tds)} · short ${rupees(t.shortage)}`, color: C.warn }
        : { label: 'Closing', value: drCr(st.closing), sub: `on ${dMon(st.to)}`, color: C.amber },
    ]);
    y += 156;
    const pl = productLine(pad, y, st.products);
    if (pl) { out += pl; y += 64; }
    if (st.companies) {
      const cb = companiesBlock(pad, y, w - 2 * pad, st.companies);
      out += cb.svg;
      y += cb.height + 16;
    }
    return { svg: out, y };
  };
  const headN = (pageNo, pages) => {
    const y = 48;
    let out = logoTile(pad, y, 64, 16, images);
    out += T(pad + 84, y + 28, st.name, { size: 26, weight: 800, max: w - 2 * pad - 420 });
    out += T(pad + 84, y + 56, `${title} · ${dMonY(st.from)} – ${dMonY(st.to)}`, { size: 17, fill: C.muted, max: w - 2 * pad - 420 });
    out += T(w - pad, y + 28, `Page ${pageNo} of ${pages}`, { size: 17, weight: 700, fill: C.muted, anchor: 'end' });
    out += T(w - pad, y + 56, `Balance ${drCr(st.closing)}`, { size: 17, fill: C.muted, anchor: 'end' });
    out += R(pad, y + 86, w - 2 * pad, 1.5, { opacity: 0.1 });
    return { svg: out, y: y + 110 };
  };
  const bottom = h - 96;

  // lay the lines out page by page (a month band never ends a page)
  const first = head1(1, 1).y + H.head;
  const nextTop = headN(2, 2).y + H.head;
  const pagesLines = [];
  let cur = [];
  let y = first;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const needs = l.h + (l.t === 'month' && lines[i + 1] ? lines[i + 1].h : 0);
    if (y + needs > bottom && cur.length) {
      pagesLines.push(cur);
      cur = [];
      y = nextTop;
    }
    cur.push(l);
    y += l.h;
  }
  pagesLines.push(cur);

  const pages = pagesLines.length;
  return pagesLines.map((pl, i) => {
    const head = i === 0 ? head1(1, pages) : headN(i + 1, pages);
    let yy = head.y;
    let body = tableHead(pad, yy, w - 2 * pad, col);
    yy += H.head;
    for (const l of pl) { body += line(l, pad, yy, w - 2 * pad, col); yy += l.h; }
    const foot = `${R(pad, h - 78, w - 2 * pad, 1.5, { opacity: 0.1 })}
${T(pad, h - 40, 'Vriddhi Fuels  ·  computer-generated statement  ·  balances: Dr = due from you, Cr = advance', { size: 15, fill: C.faint, max: w - 2 * pad - 180 })}
${T(w - pad, h - 40, `Page ${i + 1} of ${pages}`, { size: 15, weight: 700, fill: C.faint, anchor: 'end' })}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${defs(fontCss)}${backdrop(w, h)}${head.svg}${body}${foot}</svg>`;
  });
}

// ---- one customer's outstanding card -------------------------------------------------
// card: { name, kind: 'bulk'|'retail', balance, asOn, since, billed, received,
//         deductions, qty, bills, payments, lastPayment {date, amount}, lastBill,
//         companies (ledger-view companyWise() or null) }
export function outstandingCardSvg(card, { images = {}, fontCss = '' } = {}) {
  const w = CARD_WIDTH;
  const pad = 56;
  let y = 48;
  let out = brandRow(w, pad, y, 'Outstanding statement', card.asOn, images);
  y += 172;
  out += pill(pad, y, card.kind === 'bulk' ? 'BULK ACCOUNT' : 'ACCOUNT', C.amber);
  out += T(pad, y + 86, card.name, { size: 44, weight: 800, max: w - 2 * pad, spacing: -0.5 });
  y += 120;
  if (card.note) {
    out += T(pad, y + 6, card.note, { size: 20, fill: C.muted, max: w - 2 * pad });
    y += 34;
  }
  const bl = balanceLabel(card.balance);
  out += hero(pad, y, w - 2 * pad, 200, `${bl.label} AS ON ${dMonY(card.asOn).toUpperCase()}`, bl.amount, []);
  y += 228;
  const facts = [];
  if (card.since) facts.push(['Period', `${dMonY(card.since)} – ${dMonY(card.asOn)}`]);
  if (card.opening != null && Math.round(card.opening)) facts.push(['Opening balance', drCr(card.opening)]);
  if (card.billed != null) facts.push(['Billed', `${rupees(card.billed)}${card.qty ? `  ·  ${qtyText(card.qty)}` : ''}`]);
  if (card.received != null) facts.push(['Received', rupees(card.received)]);
  if (card.deductions) facts.push(['TDS & shortage', rupees(card.deductions)]);
  if (card.lastPayment) facts.push(['Last payment', `${rupees(card.lastPayment.amount)} on ${dMonY(card.lastPayment.date)}`]);
  if (card.lastBill) facts.push(['Last bill', dMonY(card.lastBill)]);
  if (facts.length) {
    const fh = facts.length * 54 + 22;
    out += R(pad, y, w - 2 * pad, fh, { rx: 22, opacity: 0.05, stroke: '#fff', strokeOpacity: 0.1 });
    facts.forEach(([k, v], i) => {
      const yy = y + 46 + i * 54;
      out += `${T(pad + 28, yy, k, { size: 19, fill: C.muted })}${T(w - pad - 28, yy, v, { size: 21, weight: 700, anchor: 'end', max: w - 2 * pad - 280 })}`;
      if (i < facts.length - 1) out += R(pad + 28, yy + 20, w - 2 * pad - 56, 1, { opacity: 0.07 });
    });
    y += fh + 30;
  }
  if (card.companies) {
    const cb = companiesBlock(pad, y, w - 2 * pad, card.companies);
    out += cb.svg;
    y += cb.height + 20;
  }
  y += 16;
  out += `${R(pad, y, w - 2 * pad, 1.5, { opacity: 0.1 })}${T(pad, y + 40, 'Vriddhi Fuels  ·  thank you for your business', { size: 16, fill: C.faint })}${T(w - pad, y + 40, 'Dr = due  ·  Cr = advance', { size: 16, fill: C.faint, anchor: 'end' })}`;
  const h = y + 72;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${defs(fontCss)}${backdrop(w, h)}${out}</svg>`, size: { width: w, height: h } };
}

// ---- everyone's outstanding ------------------------------------------------------------
// list: [{name, kind, balance}] (largest first); total; asOn; label (All / Retail / Bulk)
export function outstandingListSvg({ list, total, asOn, label = '' }, { images = {}, fontCss = '' } = {}) {
  const w = CARD_WIDTH;
  const pad = 56;
  let y = 48;
  let out = brandRow(w, pad, y, `Outstanding today${label ? ` · ${label}` : ''}`, asOn, images);
  y += 172;
  out += hero(pad, y, w - 2 * pad, 180, `TOTAL OUTSTANDING · ${list.length} CUSTOMER${list.length === 1 ? '' : 'S'}`, rupees(total), []);
  y += 210;
  const max = Math.max(1, ...list.map((o) => o.balance));
  list.forEach((o, i) => {
    out += `${i % 2 ? R(pad, y, w - 2 * pad, 64, { rx: 14, opacity: 0.035 }) : ''}
${T(pad + 20, y + 40, String(i + 1), { size: 18, weight: 700, fill: C.faint })}
${T(pad + 70, y + 32, o.name, { size: 20, weight: 700, max: w - 2 * pad - 420 })}
${T(pad + 70, y + 54, o.kind === 'bulk' ? 'Bulk' : 'Retail', { size: 14, weight: 700, fill: o.kind === 'bulk' ? '#9085e9' : C.muted, spacing: 1 })}
${R(w - pad - 330, y + 38, 120, 6, { rx: 3, opacity: 0.08 })}${R(w - pad - 330, y + 38, Math.max(3, 120 * (o.balance / max)), 6, { rx: 3, fill: C.warn, opacity: 0.85 })}
${T(w - pad - 20, y + 42, rupees(o.balance), { size: 22, weight: 800, anchor: 'end' })}`;
    y += 64;
  });
  y += 24;
  out += `${R(pad, y, w - 2 * pad, 1.5, { opacity: 0.1 })}${T(pad, y + 40, 'Vriddhi Fuels  ·  ledger customers as on their sheet, bulk groups as on their Bulk sheet', { size: 15, fill: C.faint, max: w - 2 * pad })}`;
  const h = y + 72;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${defs(fontCss)}${backdrop(w, h)}${out}</svg>`, size: { width: w, height: h } };
}

// a statement cut to one month: that month's entries, its opening and closing
export function monthSlice(st, ym) {
  const m = st.months.find((x) => x.month === ym);
  if (!m) return st;
  const entries = m.entries;
  const t = { billed: m.billed, qty: m.qty, received: m.received, tds: 0, shortage: 0, bills: m.bills, payments: m.payments };
  const products = Object.fromEntries(['HSD', 'MS', 'XG', 'OTHER'].map((p) => [p, { qty: 0, amount: 0, bills: 0 }]));
  let lastPayment = null;
  for (const e of entries) {
    t.tds += e.tds; t.shortage += e.shortage;
    if (e.type === 'bill' && e.debit) { const p = products[e.product] || products.OTHER; p.qty += e.qty; p.amount += e.debit; p.bills += 1; }
    if (e.paid > 0 && (!lastPayment || e.date >= lastPayment.date)) lastPayment = { date: e.date, amount: e.paid };
  }
  const end = `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
  // a month's activity, not an outstanding: no company-wise split
  return {
    ...st, from: `${ym}-01`, to: st.to < end ? st.to : end,
    opening: m.opening, closing: m.closing, months: [m], entries, totals: t, products, lastPayment, companies: null,
  };
}
