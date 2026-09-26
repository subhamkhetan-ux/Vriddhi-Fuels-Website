// Phase 3 drawings: a customer's ledger, bill statement and the HSD / MS
// daily summaries, drawn the way Excel prints them in Daily Screenshots /
// Monthly Export (measured from the 1652 x 2338 px exports: A4 at 200 dpi).
//
// Excel's page model: every column is (width × 8) px at 96 dpi (Times New
// Roman 12 is the workbook's default font), rows are in points, and "fit to
// one page" picks a whole-number zoom so the range fits the printable area;
// the range is centred across the page. Each ledger sheet has its own column
// widths, brought in with the Master Ledger upload (customer.layout), so the
// pictures come out the same size as Excel's.
//
// Pure SVG builders (tested in node); statements.js decides what goes on them.

import { ddmmyy, ddmmyyyy, general, indAuto, rupeeAuto } from './statements.js';

export const PAGE = { width: 1652, height: 2338 };          // drawing units (px at 200 dpi)
export const PAGE_PT = { width: 595.28, height: 841.89 };   // the same page in PDF points (A4)

const K = 200 / 96;              // px at 96 dpi -> page px
const PT = 200 / 72;             // pt -> page px
const MDW = 8;                   // px per unit of Excel column width
const DESC = 0.216;              // Times New Roman descent (em)

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const FONT_FAMILY = '"Times New Roman", Tinos, "Liberation Serif", Times, serif';
const ORANGE = '#ED7D31';
const DARK_ORANGE = '#C55A11';
const RED = '#FF0000';

// Where Excel's footer stamp lands (the stamp's ink, page px) on each kind of page.
const STAMP_AT = {
  ledger: [1368, 2016, 1577, 2222],
  bill: [1345, 1993, 1591, 2229],
  HSD: [1299, 2033, 1491, 2222],
  MS: [1281, 2016, 1500, 2223],
};

// A ledger sheet's geometry when the upload didn't bring one (a typical sheet).
export const DEFAULT_LAYOUT = {
  cols: [12.16, 14.16, 10, 19.83, 17.16, 14.5, 18.5],            // A:G
  bill: [0.33, 12.66, 12.5, 16.16, 13.16, 11.66, 15.5, 13.83],   // Q:X
  head: 21.5,                                                    // row 4 (pt)
  row: 20,                                                       // rows 5.. (pt)
};
const PIVOT_COLS = { HSD: [62.5, 19.33, 20], MS: [54.16, 19.5, 20.5] };

function layoutOf(l) {
  const ok = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => Number(x) > 0);
  const d = DEFAULT_LAYOUT;
  return {
    cols: ok(l?.cols, 7) ? l.cols.map(Number) : d.cols,
    bill: ok(l?.bill, 8) ? l.bill.map(Number) : d.bill,
    head: Number(l?.head) > 5 ? Number(l.head) : d.head,
    row: Number(l?.row) > 5 ? Number(l.row) : d.row,
    rows: Array.isArray(l?.rows) ? l.rows.map(Number) : [],
  };
}

// Whole-number zoom that fits w (px at 96 dpi) x h (pt) into the space.
function zoomFor(w, h, availW, availH) {
  return Math.floor(Math.min(1, availW / (w * K), availH / (h * PT)) * 100 + 1e-9) / 100;
}

// The stamp is placed so its ink covers Excel's box; `ink` is the ink's
// bounding box inside the picture as fractions [x0, y0, x1, y1].
function stampSvg(images, kind) {
  if (!images.stamp) return '';
  const [x0, y0, x1, y1] = STAMP_AT[kind];
  const ink = Array.isArray(images.stampInk) && images.stampInk.length === 4 ? images.stampInk : [0.02, 0.02, 0.9, 0.9];
  const w = (x1 - x0) / Math.max(0.05, ink[2] - ink[0]);
  const h = (y1 - y0) / Math.max(0.05, ink[3] - ink[1]);
  const s = Math.min(w, h);
  const cx = (x0 + x1) / 2 - ((ink[0] + ink[2]) / 2 - 0.5) * s;
  const cy = (y0 + y1) / 2 - ((ink[1] + ink[3]) / 2 - 0.5) * s;
  return `<image href="${esc(images.stamp)}" x="${(cx - s / 2).toFixed(1)}" y="${(cy - s / 2).toFixed(1)}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" preserveAspectRatio="none"/>`;
}

function page(body, stampPart, fontCss = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.width} ${PAGE.height}" width="${PAGE_PT.width}" height="${PAGE_PT.height}" font-family="${esc(FONT_FAMILY)}">
${fontCss ? `<style>${fontCss}</style>` : ''}<rect x="0" y="0" width="${PAGE.width}" height="${PAGE.height}" fill="#fff"/>
${body}
${stampPart}
</svg>`;
}

const r1 = (n) => Math.round(n * 10) / 10;
const text = (x, y, s, attrs = '') => (s === '' || s == null ? '' : `<text x="${r1(x)}" y="${r1(y)}" ${attrs}>${esc(s)}</text>`);
const right = (x, y, s, attrs = '') => text(x, y, s, `text-anchor="end" ${attrs}`);
const mid = (x, y, s, attrs = '') => text(x, y, s, `text-anchor="middle" ${attrs}`);
// Borders as solid rectangles on whole pixels, like Excel's crisp lines.
const hl = (x1, x2, y, w) => { const t = Math.round(y - w / 2); return `<rect x="${Math.round(x1 - 1)}" y="${t}" width="${Math.round(x2 - x1 + 2)}" height="${w}"/>`; };
const vl = (x, y1, y2, w) => { const l = Math.round(x - w / 2); return `<rect x="${l}" y="${Math.round(y1 - 1)}" width="${w}" height="${Math.round(y2 - y1 + 2)}"/>`; };
const THIN = 2;
const THICK = 4;

// ---- ledger -----------------------------------------------------------------------

// led: statements.js ledger {title, subtitle, period, from, opening, rows, totals, closing, total, layout}
export function ledgerSvg(led, images = {}) {
  const L = layoutOf(led.layout);
  const rows = [{ opening: true }, ...led.rows.map((r) => ({ r })), ...(led.total ? [{ total: true }] : [])];
  const heights = rows.map((_, i) => (L.rows[i] > 5 ? L.rows[i] : L.row));
  const TITLE = 71.2;                                        // rows 1-3 (pt)
  const wPx = L.cols.reduce((a, w) => a + w * MDW, 0);
  const hPt = TITLE + L.head + heights.reduce((a, h) => a + h, 0);
  const z = zoomFor(wPx, hPt, 1543, 1930);
  const u = K * z;                                           // px96 -> page px
  const p = PT * z;                                          // pt -> page px
  const top = 112.5;
  const left = 824 - (wPx * u) / 2;
  const xs = [left];
  L.cols.forEach((w) => xs.push(xs[xs.length - 1] + w * MDW * u));
  const fs = (pt) => r1(pt * p);
  const out = [];

  if (images.logo) {
    out.push(`<image href="${esc(images.logo)}" x="${r1(left + 8.9 * u)}" y="${r1(top + 6.9 * u)}" width="${r1(87 * u)}" height="${r1(81.5 * u)}" preserveAspectRatio="none"/>`);
  }
  const midX = (xs[0] + xs[7]) / 2;
  out.push(mid(midX, top + 23.1 * p, led.title, `font-size="${fs(24)}" font-weight="bold"`));
  out.push(mid(midX, top + 42.9 * p, led.subtitle, `font-size="${fs(16)}" font-style="italic"`));
  out.push(mid(midX + 3, top + 64.8 * p, led.period, `font-size="${fs(16)}" font-style="italic" xml:space="preserve"`));

  const headTop = top + TITLE * p;
  const lines = [headTop, headTop + L.head * p];
  const base = (bottom) => bottom - (18 * DESC - 0.4) * p;
  ['Date', 'Volume', 'Price', 'Amount', 'Paid', 'Product', 'Balance']
    .forEach((h, i) => out.push(mid((xs[i] + xs[i + 1]) / 2 - 1, base(lines[1]), h)));

  const padL = 2.2 * u;
  const padR = 4.8 * u;
  const cells = (y, v, { bold = false, colour = '' } = {}) => {
    const b = bold ? ' font-weight="bold"' : '';
    const col = colour ? ` fill="${colour}"` : '';
    out.push(text(xs[0] + padL - 5, y, v.date, b));
    out.push(right(xs[2] - padR, y, v.qty, b + col));
    out.push(right(xs[3] - padR, y, v.rate, b + col));
    out.push(right(xs[4] - padR, y, v.amount, b + col));
    out.push(right(xs[5] - padR, y, v.paid, ' font-weight="bold"'));
    const long = String(v.product || '').length > 10;           // Other Sale item names
    out.push(right(xs[6] - padR, y, v.product, b + col + (long ? ` font-size="${r1(Math.max(0.55, 10 / v.product.length) * 18 * p)}"` : '')));
    out.push(right(xs[7] - padR, y, v.balance, b));
  };
  let y = lines[1];
  rows.forEach((row, i) => {
    const bottom = y + heights[i] * p;
    if (row.opening) {
      cells(base(bottom), { date: ddmmyy(led.from), balance: rupeeAuto(led.opening) });
    } else if (row.total) {
      cells(base(bottom), {
        date: 'TOTAL', qty: indAuto(led.totals.qty), amount: indAuto(led.totals.amount),
        paid: led.totals.paid ? indAuto(led.totals.paid) : '', balance: rupeeAuto(led.closing),
      }, { bold: true });
    } else {
      const r = row.r;
      cells(base(bottom), {
        date: r.showDate ? ddmmyy(r.date) : '',
        qty: r.hasSale ? indAuto(r.qty) : '',
        rate: r.hasSale && r.rate != null ? r.rate.toFixed(2) : '',
        amount: r.hasSale ? indAuto(r.amount) : '',
        paid: r.paid ? indAuto(r.paid) : '',
        product: r.label,
        balance: rupeeAuto(r.balance),
      }, { colour: r.petrol ? ORANGE : '' });
    }
    y = bottom;
    lines.push(y);
  });
  const g = [];
  lines.slice(1).forEach((ly) => g.push(hl(xs[0], xs[7], ly, THIN)));
  for (let i = 1; i < 7; i++) g.push(vl(xs[i], headTop, y, THIN));
  g.push(hl(xs[0], xs[7], top, THICK), hl(xs[0], xs[7], headTop, THICK));
  g.push(vl(xs[0], top, y, THICK), vl(xs[7], top, y, THICK));
  const body = `<g fill="#000">${g.join('')}</g>\n<g font-size="${fs(18)}">${out.join('\n')}</g>`;
  return page(body, stampSvg(images, 'ledger'), images.fontCss);
}

// ---- bill statement --------------------------------------------------------------------

const B_HEADS = ['Date', 'Bill No', 'Vehicle', 'Quantity', 'Price/Ltr', 'Amount', 'Product'];
const B_ROW = 20;          // pt
const B_TABLE = 232.9;     // pt from the top to the table header
const B_BOTTOM = 2040;     // page px: Excel starts a new page below this

// bill: statements.js bills {name, address, gstin, from, to, rows, totals, total, layout}
// Monthly / custom (bill.total): as many pages as needed, the table header
// repeated on each. Daily: one page, shrunk to fit like Excel.
export function billStatementSvgs(bill, images = {}) {
  const L = layoutOf(bill.layout);
  const rows = bill.rows.length ? [...bill.rows] : [{ note: 'No bills in range' }];
  if (bill.total && bill.rows.length) rows.push({ total: true, qty: bill.totals.qty, amount: bill.totals.amount });
  const wPx = L.bill.reduce((a, w) => a + w * MDW, 0);
  const hPt = B_TABLE + B_ROW * (rows.length + 1);
  const z = zoomFor(wPx, bill.total ? B_TABLE + B_ROW * 2 : hPt, 1543, B_BOTTOM - 112.5);
  const u = K * z;
  const p = PT * z;
  const top = 112.5;
  const left = 826 - (wPx * u) / 2;
  const xs = [left];
  L.bill.forEach((w) => xs.push(xs[xs.length - 1] + w * MDW * u));
  const c = xs.slice(1);                                     // R..X boundaries (Q is a spacer)
  const fs = (pt) => r1(pt * p);
  const padL = 1.5 * u + 2;

  const head = [];
  if (images.letterhead) {
    head.push(`<image href="${esc(images.letterhead)}" x="${r1(c[0] + 0.5 * u)}" y="${r1(top + 0.5)}" width="${r1(c[7] - c[0])}" height="${r1(168 * p)}" preserveAspectRatio="none"/>`);
  }
  const wMid = (c[5] + c[6]) / 2;
  const xMid = (c[6] + c[7]) / 2;
  const yAt = (pt) => top + (pt + 0.4) * p;
  head.push(text(c[0] + padL, yAt(168.75), 'Bill To', `font-weight="bold" fill="${ORANGE}"`));
  head.push(text(c[0] + padL, yAt(189), bill.name, 'font-weight="bold"'));
  head.push(text(c[0] + padL, yAt(208.9), bill.address));
  if (bill.gstin) head.push(text(c[0] + padL, yAt(228.75), `GSTIN:${bill.gstin}`, `font-size="${fs(12)}" font-style="italic"`));
  head.push(mid(wMid - 2, yAt(168.75), 'From:', `font-weight="bold" fill="${ORANGE}"`));
  head.push(mid(wMid - 2, yAt(189), 'To:', `font-weight="bold" fill="${ORANGE}"`));
  head.push(mid(wMid, yAt(208.9), 'Product:', 'font-weight="bold"'));
  head.push(mid(xMid, yAt(168.75), ddmmyyyy(bill.from)));
  head.push(mid(xMid, yAt(189), ddmmyyyy(bill.to)));
  head.push(mid(xMid, yAt(208.9), 'All'));

  const rowPx = B_ROW * p;
  const table = (y0, part) => {
    const t = [];
    const g = [];
    t.push(`<rect x="${r1(c[0])}" y="${r1(y0)}" width="${r1(c[7] - c[0])}" height="${r1(rowPx)}" fill="#D9D9D9"/>`);
    B_HEADS.forEach((h, i) => t.push(mid((c[i] + c[i + 1]) / 2, y0 + rowPx - 4.8 * p, h, 'font-weight="bold"')));
    let y = y0 + rowPx;
    const lines = [y0, y];
    for (const r of part) {
      const b = y + rowPx - 3.6 * p;
      if (r.note) {
        t.push(mid((c[0] + c[7]) / 2, b, r.note, 'font-style="italic"'));
      } else {
        const attrs = r.total ? `font-weight="bold" fill="${RED}"` : r.petrol ? `fill="${DARK_ORANGE}"` : '';
        const vals = r.total
          ? ['', '', 'TOTAL', general(r.qty), '', `₹${general(r.amount)}`, '']
          : [r.showDate ? ddmmyyyy(r.date) : '', r.bill_no, r.vehicle, general(r.qty),
            r.rate == null ? '' : r.rate.toFixed(2), `₹${general(r.amount)}`, r.product];
        vals.forEach((v, i) => t.push(mid((c[i] + c[i + 1]) / 2, b, v, attrs)));
      }
      y += rowPx;
      lines.push(y);
    }
    lines.forEach((ly) => g.push(hl(c[0], c[7], ly, THIN)));
    const note = part.length === 1 && part[0].note;
    c.forEach((x, i) => g.push(vl(x, y0, note && i > 0 && i < 7 ? y0 + rowPx : y, THIN)));
    return `<g fill="#000">${g.join('')}</g>\n${t.join('\n')}`;
  };

  const tableTop = top + B_TABLE * p;
  if (!bill.total) {
    return [page(`<g font-size="${fs(14)}">${head.join('\n')}\n${table(tableTop, rows)}</g>`, stampSvg(images, 'bill'), images.fontCss)];
  }
  const first = Math.max(1, Math.floor((B_BOTTOM - tableTop) / rowPx) - 1);
  const next = Math.max(1, Math.floor((B_BOTTOM - top) / rowPx) - 1);
  const pages = [];
  let i = 0;
  while (i < rows.length || !pages.length) {
    const take = pages.length ? next : first;
    const part = rows.slice(i, i + take);
    i += take;
    const body = pages.length ? table(top, part) : `${head.join('\n')}\n${table(tableTop, part)}`;
    pages.push(page(`<g font-size="${fs(14)}">${body}</g>`, stampSvg(images, 'bill'), images.fontCss));
  }
  return pages;
}

// ---- daily summary (HSD Daily / MS Daily pivot) ---------------------------------------------

// sum: statements.js dailySummary {product, date, amount, qty, rows:[{name, amount, qty}]}
export function dailySummarySvg(sum, images = {}) {
  const cols = PIVOT_COLS[sum.product] || PIVOT_COLS.HSD;
  const HEAD = 17.9;
  const ROW = 17;
  const wPx = cols.reduce((a, w) => a + w * MDW, 0);
  const hPt = HEAD + ROW * (sum.rows.length + 3);
  const z = zoomFor(wPx, hPt, 1380, 1880);                   // this sheet keeps Excel's normal margins
  const u = K * z;
  const p = PT * z;
  const top = 149;
  const left = 824.5 - (wPx * u) / 2;
  const xs = [left];
  cols.forEach((w) => xs.push(xs[xs.length - 1] + w * MDW * u));
  const fs = (pt) => r1(pt * p);
  const t = [];
  const g = [];
  const fill = sum.product === 'MS' ? ORANGE : '#70AD47';
  const headBottom = top + HEAD * p;
  t.push(`<rect x="${r1(xs[0])}" y="${r1(top)}" width="${r1(xs[3] - xs[0])}" height="${r1(headBottom - top)}" fill="${fill}"/>`);
  const hb = headBottom - 4.6 * p - 2;
  t.push(text(xs[0] + 3.2 * u - 2, hb, `${sum.product} Daily Sales Summary`, `font-weight="bold" font-size="${fs(16)}"`));
  t.push(text(xs[1] + 2 * u - 7, hb, 'Sum of Amount', `font-weight="bold" font-size="${fs(16)}"`));
  t.push(text(xs[2] + 2 * u - 8, hb, 'Sum of Quantity', `font-weight="bold" font-size="${fs(16)}"`));
  const lines = [top, headBottom];
  let y = headBottom;
  const row = (name, amount, qty, date) => {
    const b = y + ROW * p - 14 * DESC * p + 1;
    if (date === 'blank') {
      t.push(text(xs[0] + 34 + 1.5 * u, b, name, `font-weight="bold" fill="${RED}"`));
    } else if (date) {
      t.push(text(xs[0] + 34 + 1.5 * u, b, name, `font-weight="bold" fill="${RED}"`));
      t.push(right(xs[2] - 3.2 * u, b, amount, 'font-weight="bold"'));
      t.push(right(xs[3] - 3.2 * u, b, qty, 'font-weight="bold"'));
    } else {
      t.push(text(xs[0] + 60 + 4 * u, b, name));
      t.push(right(xs[2] - 3.2 * u, b, amount));
      t.push(right(xs[3] - 3.2 * u, b, qty));
    }
    y += ROW * p;
    lines.push(y);
  };
  // Excel's pivot always starts with an empty "(blank)" group; kept so the
  // picture looks the same.
  row('(blank)', '', '', 'blank');
  row('(blank)', '', '');
  row(ddmmyy(sum.date), general(sum.amount), general(sum.qty), true);
  for (const r of sum.rows) row(r.name, general(r.amount), general(r.qty));
  lines.forEach((ly) => g.push(hl(xs[0], xs[3], ly, THIN)));
  xs.forEach((x) => g.push(vl(x, top, y, THIN)));
  const body = `${t.shift()}\n<g fill="#000">${g.join('')}</g>\n<g font-size="${fs(14.5)}">${t.join('\n')}</g>`;
  return page(body, stampSvg(images, sum.product === 'MS' ? 'MS' : 'HSD'), images.fontCss);
}
