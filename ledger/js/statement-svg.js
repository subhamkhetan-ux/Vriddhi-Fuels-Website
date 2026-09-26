// Phase 3 drawings: a customer's ledger, bill statement and the HSD / MS
// daily summaries, laid out like the workbook's exports (measured from the
// 1652 x 2338 px JPEGs of Daily Screenshots: A4 at 200 dpi). Pure SVG
// builders (tested in node); statements.js decides what goes on them.

import { ddmmyy, ddmmyyyy, general, indAuto, rupeeAuto } from './statements.js';

export const PAGE = { width: 1652, height: 2338 };          // drawing units (px at 200 dpi)
export const PAGE_PT = { width: 595.28, height: 841.89 };   // the same page in PDF points (A4)
const BOTTOM = 1990;                                       // tables stop above the stamp
const TOP = 113;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = '&quot;Times New Roman&quot;,Times,&quot;Liberation Serif&quot;,serif';
const ORANGE = '#ED7D31';
const DARK_ORANGE = '#C55A11';

function page(body, stamp) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.width} ${PAGE.height}" width="${PAGE_PT.width}" height="${PAGE_PT.height}" font-family="${FONT}">
<rect x="0" y="0" width="${PAGE.width}" height="${PAGE.height}" fill="#fff"/>
${body}
${stamp ? `<image href="${esc(stamp)}" x="1363" y="2006" width="234" height="234" preserveAspectRatio="xMidYMid meet"/>` : ''}
</svg>`;
}

// Excel's "fit to one page": shrink everything from the top centre.
function fit(body, bottom) {
  if (bottom <= BOTTOM) return body;
  const s = (BOTTOM - TOP) / (bottom - TOP);
  const cx = PAGE.width / 2;
  return `<g transform="translate(${cx} ${TOP}) scale(${s.toFixed(5)}) translate(${-cx} ${-TOP})">${body}</g>`;
}

const text = (x, y, s, attrs = '') => (s === '' || s == null ? '' : `<text x="${x}" y="${y}" ${attrs}>${esc(s)}</text>`);
const right = (x, y, s, attrs = '') => text(x, y, s, `text-anchor="end" ${attrs}`);
const mid = (x, y, s, attrs = '') => text(x, y, s, `text-anchor="middle" ${attrs}`);
const hline = (x1, x2, y, w) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#000" stroke-width="${w}"/>`;
const vline = (x, y1, y2, w) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#000" stroke-width="${w}"/>`;

// ---- ledger -----------------------------------------------------------------------

const L_COLS = [53, 233, 433, 585, 850, 1100, 1315, 1595];
const L_HEAD = 290;
const L_ROW = 49;

// led: statements.js ledger {title, subtitle, period, from, opening, rows, totals, closing, total}
export function ledgerSvg(led, images = {}) {
  const c = L_COLS;
  const out = [];
  const midX = (c[0] + c[7]) / 2;
  if (images.logo) out.push(`<image href="${esc(images.logo)}" x="64" y="131" width="170" height="136" preserveAspectRatio="xMidYMid meet"/>`);
  out.push(mid(midX, 166, led.title, 'font-size="52" font-weight="bold"'));
  out.push(mid(midX, 218, led.subtitle, 'font-size="35" font-style="italic"'));
  out.push(mid(midX, 269, led.period, 'font-size="35" font-style="italic" xml:space="preserve"'));
  ['Date', 'Volume', 'Price', 'Amount', 'Paid', 'Product', 'Balance'].forEach((h, i) => out.push(mid((c[i] + c[i + 1]) / 2, L_HEAD + 38, h)));

  const cells = (y, r, { bold = false, colour = '' } = {}) => {
    const b = bold ? ' font-weight="bold"' : '';
    const col = colour ? ` fill="${colour}"` : '';
    out.push(text(c[0] + 6, y, r.date, b));
    out.push(right(c[2] - 8, y, r.qty, b + col));
    out.push(right(c[3] - 8, y, r.rate, b + col));
    out.push(right(c[4] - 8, y, r.amount, b + col));
    out.push(right(c[5] - 8, y, r.paid, ' font-weight="bold"'));
    const long = String(r.product || '').length > 10;           // Other Sale item names
    out.push(right(c[6] - 8, y, r.product, b + col + (long ? ` font-size="${Math.max(18, Math.floor(380 / r.product.length))}"` : '')));
    out.push(right(c[7] - 8, y, r.balance, b));
  };
  let y = L_HEAD + L_ROW;
  cells(y + 38, { date: ddmmyy(led.from), balance: rupeeAuto(led.opening) });
  y += L_ROW;
  for (const r of led.rows) {
    cells(y + 38, {
      date: r.showDate ? ddmmyy(r.date) : '',
      qty: r.hasSale ? indAuto(r.qty) : '',
      rate: r.hasSale && r.rate != null ? r.rate.toFixed(2) : '',
      amount: r.hasSale ? indAuto(r.amount) : '',
      paid: r.paid ? indAuto(r.paid) : '',
      product: r.label,
      balance: rupeeAuto(r.balance),
    }, { colour: r.petrol ? ORANGE : '' });
    y += L_ROW;
  }
  if (led.total) {
    cells(y + 38, {
      date: 'TOTAL', qty: indAuto(led.totals.qty), rate: '', amount: indAuto(led.totals.amount),
      paid: led.totals.paid ? indAuto(led.totals.paid) : '', product: '', balance: rupeeAuto(led.closing),
    }, { bold: true });
    y += L_ROW;
  }
  const bottom = y;
  for (let ly = L_HEAD + L_ROW; ly < bottom; ly += L_ROW) out.push(hline(c[0], c[7], ly, 2));
  for (let i = 1; i < 7; i++) out.push(vline(c[i], L_HEAD, bottom, 2));
  out.push(hline(c[0], c[7], L_HEAD, 3.5));
  out.push(`<rect x="${c[0]}" y="${TOP}" width="${c[7] - c[0]}" height="${bottom - TOP}" fill="none" stroke="#000" stroke-width="3.5"/>`);
  return page(fit(`<g font-size="38">${out.join('\n')}</g>`, bottom), images.stamp);
}

// ---- bill statement --------------------------------------------------------------------

const B_COLS = [66, 268, 468, 727, 937, 1124, 1372, 1595];
const B_HEAD = 735;
const B_ROW = 53;
const B_HEADS = ['Date', 'Bill No', 'Vehicle', 'Quantity', 'Price/Ltr', 'Amount', 'Product'];

function billTable(top, rows, withHead = true) {
  const c = B_COLS;
  const out = [];
  let y = top;
  if (withHead) {
    out.push(`<rect x="${c[0]}" y="${y}" width="${c[7] - c[0]}" height="${B_ROW}" fill="#D9D9D9"/>`);
    B_HEADS.forEach((h, i) => out.push(mid((c[i] + c[i + 1]) / 2, y + 38, h, 'font-weight="bold"')));
    y += B_ROW;
  }
  for (const r of rows) {
    if (r.note) {
      out.push(mid((c[0] + c[7]) / 2, y + 38, r.note, 'font-style="italic"'));
    } else {
      const attrs = r.total ? 'font-weight="bold" fill="#FF0000"' : r.petrol ? `fill="${DARK_ORANGE}"` : '';
      const vals = r.total
        ? ['', '', 'TOTAL', general(r.qty), '', `₹${general(r.amount)}`, '']
        : [r.showDate ? ddmmyyyy(r.date) : '', r.bill_no, r.vehicle, general(r.qty),
          r.rate == null ? '' : r.rate.toFixed(2), `₹${general(r.amount)}`, r.product];
      vals.forEach((v, i) => out.push(mid((c[i] + c[i + 1]) / 2, y + 38, v, attrs)));
    }
    y += B_ROW;
  }
  for (let ly = top; ly <= y; ly += B_ROW) out.push(hline(c[0], c[7], ly, 2));
  const noteRows = rows.length === 1 && rows[0].note;
  for (let i = 0; i < 8; i++) {
    if (noteRows && i > 0 && i < 7) out.push(vline(c[i], top, top + (withHead ? B_ROW : 0), 2));
    else out.push(vline(c[i], top, y, 2));
  }
  return { svg: out.join('\n'), bottom: y };
}

// bill: statements.js bills {name, address, gstin, from, to, rows, totals, total}
// Monthly / custom: as many pages as needed, the table header repeated on
// each. Daily (bill.total false): one page, shrunk to fit.
export function billStatementSvgs(bill, images = {}) {
  const head = [];
  if (images.letterhead) head.push(`<image href="${esc(images.letterhead)}" x="55" y="113" width="1540" height="456" preserveAspectRatio="none"/>`);
  head.push(text(66, 560, 'Bill To', `font-weight="bold" fill="${ORANGE}"`));
  head.push(text(66, 613, bill.name, 'font-weight="bold"'));
  head.push(text(66, 666, bill.address));
  if (bill.gstin) head.push(text(66, 720, `GSTIN:${bill.gstin}`, 'font-size="30" font-style="italic"'));
  head.push(mid(1249, 560, 'From:', `font-weight="bold" fill="${ORANGE}"`));
  head.push(mid(1249, 613, 'To:', `font-weight="bold" fill="${ORANGE}"`));
  head.push(mid(1249, 666, 'Product:', 'font-weight="bold"'));
  head.push(mid(1482, 560, ddmmyyyy(bill.from)));
  head.push(mid(1482, 613, ddmmyyyy(bill.to)));
  head.push(mid(1482, 666, 'All'));

  const rows = bill.rows.length ? [...bill.rows] : [{ note: 'No bills in range' }];
  if (bill.total && bill.rows.length) rows.push({ total: true, qty: bill.totals.qty, amount: bill.totals.amount });
  if (!bill.total) {
    const t = billTable(B_HEAD, rows);
    return [page(fit(`<g font-size="34">${head.join('\n')}\n${t.svg}</g>`, t.bottom), images.stamp)];
  }
  const pages = [];
  const first = Math.floor((BOTTOM - B_HEAD) / B_ROW) - 1;
  const next = Math.floor((BOTTOM - TOP) / B_ROW) - 1;
  let i = 0;
  while (i < rows.length || !pages.length) {
    const take = pages.length ? next : first;
    const part = rows.slice(i, i + take);
    i += take;
    const t = billTable(pages.length ? TOP : B_HEAD, part);
    pages.push(page(`<g font-size="34">${pages.length ? '' : head.join('\n')}\n${t.svg}</g>`, images.stamp));
  }
  return pages;
}

// ---- daily summary (HSD Daily / MS Daily pivot) ---------------------------------------------

const P_COLS = [138, 980, 1243, 1513];
const P_TOP = 149;
const P_ROW = 38;

// sum: statements.js dailySummary {product, date, amount, qty, rows:[{name, amount, qty}]}
export function dailySummarySvg(sum, images = {}) {
  const c = P_COLS;
  const out = [];
  let y = P_TOP;
  out.push(`<rect x="${c[0]}" y="${y}" width="${c[3] - c[0]}" height="${P_ROW + 2}" fill="#70AD47"/>`);
  out.push(text(c[0] + 5, y + 30, `${sum.product} Daily Sales Summary`, 'font-weight="bold"'));
  out.push(text(c[1] + 5, y + 30, 'Sum of Amount', 'font-weight="bold"'));
  out.push(text(c[2] + 5, y + 30, 'Sum of Quantity', 'font-weight="bold"'));
  y += P_ROW + 2;
  const lines = [P_TOP, y];
  out.push(text(173, y + 29, ddmmyy(sum.date), 'font-weight="bold" fill="#FF0000"'));
  out.push(right(c[2] - 5, y + 29, general(sum.amount), 'font-weight="bold"'));
  out.push(right(c[3] - 5, y + 29, general(sum.qty), 'font-weight="bold"'));
  y += P_ROW;
  lines.push(y);
  for (const r of sum.rows) {
    out.push(text(202, y + 29, r.name));
    out.push(right(c[2] - 5, y + 29, general(r.amount)));
    out.push(right(c[3] - 5, y + 29, general(r.qty)));
    y += P_ROW;
    lines.push(y);
  }
  for (const ly of lines) out.push(hline(c[0], c[3], ly, 2));
  for (const x of c) out.push(vline(x, P_TOP, y, 2));
  return page(fit(`<g font-size="30">${out.join('\n')}</g>`, y), images.stamp);
}
