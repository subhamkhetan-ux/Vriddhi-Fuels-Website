// The SCPL bill (Statements → SCPL Bill): Steels & Carriers' HSD bills for a
// 10-day period, split into Transporting (page 1) and Consumer (page 2) by
// the bill's Vehicle label — the workbook's modSCPLBilling macro
// (SCPL_GenerateBills) done in the app:
//   - the period it offers: 1–10, 11–20 or 21–end of the month just gone
//   - Vehicle labels read as the macro reads them: exactly Transporting /
//     Consumer, or close enough to one (a typo); any other label must be
//     set before the bill is made (the macro stops on them too)
//   - each page: Date (dd/mm/yy), Bill No., the category, Quantity, Rate/Ltr,
//     Amount; sorted by date then bill no.; a red, bold TOTAL row
// Pure: no DOM, no network. scplBillSvg() draws the pages (A4, points) as
// the Word template (Steels & Carriers.docx) lays them out.

export const SCPL_CUSTOMER = 'Steels and Carriers Private Limited';
export const CATS = ['Transporting', 'Consumer'];

const round2 = (n) => Math.round(n * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
};

// AskDateRange: on the 1st–10th the 21st–end of last month, on the 11th–20th
// the 1st–10th, after that the 11th–20th
export function scplDefaultRange(today) {
  const [y, m, d] = today.split('-').map(Number);
  if (d <= 10) { const to = iso(y, m, 0); return { from: `${to.slice(0, 8)}21`, to }; }
  if (d <= 20) return { from: iso(y, m, 1), to: iso(y, m, 10) };
  return { from: iso(y, m, 11), to: iso(y, m, 20) };
}

// the 10-day periods around a date (for the period list): newest first
export function scplPeriods(today, count = 9) {
  const out = [];
  let r = scplDefaultRange(today);
  for (let i = 0; i < count; i++) {
    out.push(r);
    const d = Number(r.from.slice(8, 10));
    const [y, m] = r.from.split('-').map(Number);
    r = d === 21 ? { from: iso(y, m, 11), to: iso(y, m, 20) }
      : d === 11 ? { from: iso(y, m, 1), to: iso(y, m, 10) }
        : { from: iso(y, m - 1, 21), to: iso(y, m, 0) };
  }
  return out;
}

// ---- the Vehicle label ----------------------------------------------------------
export function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// BestGuess: the nearer category when it's near enough, else ''
export function bestGuess(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return '';
  const d1 = levenshtein(t, CATS[0].toLowerCase());
  const d2 = levenshtein(t, CATS[1].toLowerCase());
  const [best, bd] = d1 <= d2 ? [CATS[0], d1] : [CATS[1], d2];
  if (bd <= Math.max(2, Math.floor(best.length / 3))) return best;
  if (t[0] === best[0].toLowerCase() && bd <= 3) return best;
  return '';
}
// Classify: exactly a category (any case), else the best guess
export function classify(s) {
  const t = String(s ?? '').trim().toLowerCase();
  const exact = CATS.find((c) => c.toLowerCase() === t);
  return exact || bestGuess(s);
}

// BillKey: number bills in number order (9 before 10), text bills after
function billCmp(a, b) {
  const na = Number(a);
  const nb = Number(b);
  const an = a !== '' && a != null && Number.isFinite(na);
  const bn = b !== '' && b != null && Number.isFinite(nb);
  if (an && bn) return na - nb;
  if (an !== bn) return an ? -1 : 1;
  return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// The customers whose HSD bills carry Transporting / Consumer labels (most
// such bills first) — SCPL, or whoever else is billed this way.
export function scplCustomers(sales) {
  const n = new Map();
  for (const s of sales || []) {
    if (s.product !== 'HSD' || !CATS.includes(classify(s.vehicle))) continue;
    const k = String(s.customer || '').trim();
    n.set(k, (n.get(k) || 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

// The bills of a period, split. sales: salesRange() rows; picked: {saleId:
// 'Transporting' | 'Consumer' | 'skip'} for labels the app can't read.
// -> { pages: [{cat, rows: [{id, date, bill_no, qty, rate, amount, label}], qty, amount}],
//      unread: [{id, date, bill_no, label, qty, amount}] (still to set),
//      guessed: [{id, bill_no, label, cat}] (a typo read as a category),
//      skipped, count }
export function scplBill(sales, { customer = SCPL_CUSTOMER, from, to, picked = {} } = {}) {
  const who = norm(customer);
  const mine = (sales || []).filter((s) => s.product === 'HSD' && norm(s.customer) === who
    && s.sale_date >= from && s.sale_date <= to);
  const by = { [CATS[0]]: [], [CATS[1]]: [] };
  const unread = [];
  const guessed = [];
  let skipped = 0;
  for (const s of mine) {
    const label = String(s.vehicle ?? '').trim();
    let cat = classify(label);
    const pick = picked[s.id];
    if (!cat && pick) {
      if (pick === 'skip') { skipped += 1; continue; }
      cat = pick;
    }
    const row = { id: s.id, date: s.sale_date, bill_no: s.bill_no, qty: Number(s.qty) || 0, rate: Number(s.rate) || 0, amount: Number(s.amount) || 0, label };
    if (!cat) { unread.push(row); continue; }
    if (cat.toLowerCase() !== label.toLowerCase() && !pick) guessed.push({ id: s.id, bill_no: s.bill_no, label, cat });
    by[cat].push(row);
  }
  const pages = CATS.filter((c) => by[c].length).map((cat) => {
    const rows = by[cat].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : billCmp(a.bill_no, b.bill_no)));
    return { cat, rows, qty: round2(rows.reduce((a, r) => a + r.qty, 0)), amount: round2(rows.reduce((a, r) => a + r.amount, 0)) };
  });
  return { customer, from, to, pages, unread, guessed, skipped, count: pages.reduce((a, p) => a + p.rows.length, 0) };
}

// ---- the macro's number formats -------------------------------------------------
// Indian(): 1,23,456.80 — paise kept when there are any
export function indian(n) {
  const v = round2(Number(n) || 0);
  const neg = v < 0;
  const a = Math.abs(v);
  const whole = Math.floor(a);
  const paise = Math.round((a - whole) * 100);
  let x = String(whole);
  if (x.length > 3) {
    let rest = x.slice(0, -3);
    let r = '';
    while (rest.length > 2) { r = `,${rest.slice(-2)}${r}`; rest = rest.slice(0, -2); }
    x = `${rest}${r},${x.slice(-3)}`;
  }
  return `${neg ? '-' : ''}${x}${paise ? `.${pad2(paise)}` : ''}`;
}
// NumStr(): 1500 or 1500.5 (no trailing zeros)
export const numStr = (v) => (Number.isInteger(v) ? String(v) : String(round2(v)));
export const ddmmyy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
export const ddmmyyyy = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
// ---- customer bills, split by vehicle tag (Statements → Customer bills) -------------
// Any customer, set up once and saved (setting bill_setups):
//   split    'tag'  — a page per tag (Shivaay Logistics: JSW, 700 Acre, …): each
//                     vehicle no. is tagged once; a Vehicle column that holds a
//                     word rather than a vehicle no. ("Transporting", "JSW")
//                     is its own tag without asking (auto)
//            'none' — one page with every bill
//   period   'month' (default) | '10day' (1–10, 11–20, 21–end, as SCPL)
//   products ['HSD'] (default) — with more than one, a page per tag and product
//   billTo   {name, address: [..], gstin} — over what the customer's sheet has
// A bill with no tag (or no vehicle no.) gets one by hand, or is left out.
export const plateKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// an Indian vehicle no. (OD15AF5510, OD2U755, 22BH1234AA) rather than a word
export const isVehicleNo = (v) => /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(plateKey(v)) || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(plateKey(v));
// a word typed where the vehicle no. goes, as a tag: trimmed, one space
const autoTag = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

export const SETUP_DEFAULT = { split: 'tag', period: 'month', products: ['HSD'], tags: {}, billTo: null };
export const setupOf = (saved) => ({ ...SETUP_DEFAULT, ...(saved || {}), tags: { ...((saved && saved.tags) || {}) }, products: (saved && saved.products && saved.products.length) ? [...saved.products] : ['HSD'] });

const PRODUCT_TITLE = { HSD: 'HSD', MS: 'MS', XG: 'XtraGreen' };
// setup: setupOf(); picked: {saleId: tag | 'skip'}
// -> { customer, from, to, pages: [{cat, product, byTag, rows, qty, amount}],
//      vehicles: [{key, vehicle, bills, qty, tag, auto}] (most litres first),
//      unread, skipped, count, guessed: [] }
export function tagBill(sales, { customer, from, to, setup = SETUP_DEFAULT, tags = null, picked = {} } = {}) {
  const st = setupOf(tags ? { ...setup, tags } : setup);
  const who = norm(customer);
  const prods = st.products;
  const mine = (sales || []).filter((x) => prods.includes(x.product) && norm(x.customer) === who && x.sale_date >= from && x.sale_date <= to);
  const by = new Map();
  const veh = new Map();
  const unread = [];
  let skipped = 0;
  for (const x of mine) {
    const key = plateKey(x.vehicle);
    const auto = key && !isVehicleNo(x.vehicle) ? autoTag(x.vehicle) : '';
    const row = { id: x.id, date: x.sale_date, bill_no: x.bill_no, product: x.product, vehicle: String(x.vehicle ?? '').trim(), qty: Number(x.qty) || 0, rate: Number(x.rate) || 0, amount: Number(x.amount) || 0 };
    if (key && st.split === 'tag') {
      if (!veh.has(key)) veh.set(key, { key, vehicle: row.vehicle, bills: 0, qty: 0, tag: st.tags[key] || '', auto });
      const v = veh.get(key);
      v.bills += 1;
      v.qty = round2(v.qty + row.qty);
    }
    let tag = st.split === 'none' ? ' ' : (key ? st.tags[key] || auto : '');
    if (!tag && picked[x.id]) {
      if (picked[x.id] === 'skip') { skipped += 1; continue; }
      tag = picked[x.id];
    }
    if (!tag) { unread.push(row); continue; }
    const page = `${tag}\u0000${prods.length > 1 ? x.product : ''}`;
    if (!by.has(page)) by.set(page, []);
    by.get(page).push(row);
  }
  const order = (p) => prods.indexOf(p);
  const pages = [...by.keys()].map((k) => k.split('\u0000')).sort((a, b) => a[0].localeCompare(b[0]) || order(a[1]) - order(b[1])).map(([tag, product]) => {
    const rows = by.get(`${tag}\u0000${product}`).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : billCmp(a.bill_no, b.bill_no)));
    return {
      cat: tag.trim(), product: PRODUCT_TITLE[product || prods[0]] || product || prods[0], byTag: true, rows,
      qty: round2(rows.reduce((a, r) => a + r.qty, 0)), amount: round2(rows.reduce((a, r) => a + r.amount, 0)),
    };
  });
  return {
    customer, from, to, pages, unread, skipped, guessed: [],
    vehicles: [...veh.values()].sort((a, b) => b.qty - a.qty),
    count: pages.reduce((a, p) => a + p.rows.length, 0),
  };
}

// the months to bill: this month (to date) and the eleven before, newest first
export function billMonths(today, count = 12) {
  const [y, m] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(Date.UTC(y, m - 1 - i, 1));
    const from = t.toISOString().slice(0, 10);
    const end = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { from, to: i === 0 ? today : end, month: from.slice(0, 7) };
  });
}

// "Shivaay Logistics Bill Nov 2026", or "… Bill 1-15 Nov 2026" for part of a month
export function tagFileName(customer, from, to) {
  const d = (x) => Number(x.slice(8, 10));
  const mon = (x) => `${MON[Number(x.slice(5, 7)) - 1]} ${x.slice(0, 4)}`;
  const monthEnd = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const whole = from.slice(0, 7) === to.slice(0, 7) && d(from) === 1 && to === monthEnd;
  const span = whole ? mon(to) : from.slice(0, 7) === to.slice(0, 7) ? `${d(from)}-${d(to)} ${mon(to)}` : `${d(from)} ${MON[Number(from.slice(5, 7)) - 1]}-${d(to)} ${mon(to)}`;
  return `${String(customer || '').replace(/[\\/:*?"<>|]+/g, ' ').trim()} Bill ${span}`;
}

// a page's rows as the table's cells (the TOTAL row last)
export function tableCells(page) {
  return {
    rows: page.rows.map((r) => [ddmmyy(r.date), String(r.bill_no ?? ''), page.byTag ? r.vehicle : page.cat, numStr(r.qty), r.rate.toFixed(2), indian(r.amount)]),
    total: ['', '', 'TOTAL', page.qty.toFixed(2), '', `₹${indian(page.amount)}`],
  };
}

// the file name, as the macro files it: "SCPL Bill 1-10 Nov", or
// "SCPL Bill 21 Oct-3 Nov" across months
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function scplFileName(from, to) {
  const d = (x) => Number(x.slice(8, 10));
  const mon = (x) => MON[Number(x.slice(5, 7)) - 1];
  if (from.slice(0, 7) === to.slice(0, 7)) return `SCPL Bill ${d(from)}-${d(to)} ${mon(to)}`;
  return `SCPL Bill ${d(from)} ${mon(from)}-${d(to)} ${mon(to)}`;
}

// ---- the pages (A4, points), laid out as the Word template --------------------
// "Steels & Carriers.docx": A4, 0.5" margins, Times New Roman; the letterhead
// across the top; "Bill To" and the customer on the left, "Date: <from> To
// <to>" and "Product: HSD" on the right (headings in orange C45911); the
// table; the payment details; the stamp pinned just above the footer line
// "For VRIDDHI FUELS ... Signature of Customer" (as PinStamps puts it).
// The template's bill-to; the payment details are the bank details saved in
// the app (Quotes → Bank Details), in the template's four lines.
export const SCPL_TEMPLATE = {
  name: 'Steels & Carriers PVT LTD',
  address: ['Rourkela, Sundargarh.'],
  gstin: '21AAICS8597H2ZV',
  product: 'HSD',
};
// bank: {name, account, ifsc, bank, branch} (bank-board.js) -> the lines;
// a line too long for the page goes on to a second, indented one
export function scplPaymentLines(bank = {}) {
  const lines = [
    `Account No. – ${bank.account || ''}`,
    `IFSC Code – ${bank.ifsc || ''}`,
    `Branch Name – ${[bank.bank, bank.branch].filter(Boolean).join(', ')}`,
    `Name on account – ${bank.name || ''}`,
  ];
  const MAX = 74;                                            // characters at 14 pt from the text's edge to the page's margin
  return lines.flatMap((l) => {
    if (l.length <= MAX) return [l];
    const cut = l.lastIndexOf(' ', MAX);
    return [l.slice(0, cut > 20 ? cut : MAX), `    ${l.slice(cut > 20 ? cut + 1 : MAX)}`];
  });
}
export const SCPL_PAGE = { width: 595.3, height: 841.9 };
// the bill's font: the real Times New Roman (cut down to the characters a bill
// uses: assets/fonts/times*-bill.woff2), embedded in each page so every phone
// draws it the same; its ₹ — which Times New Roman lacks (Word falls back to
// another font too) — from Noto Serif
const FONT = "'Bill Times', 'Bill Rupee', 'Times New Roman', Tinos, Times, serif";
export const SCPL_FONTS = {
  regular: 'assets/fonts/times-bill.woff2', bold: 'assets/fonts/timesbd-bill.woff2',
  italic: 'assets/fonts/timesi-bill.woff2', rupee: 'assets/fonts/rupee-noto-serif.woff2',
};
// urls: the same keys as data: URLs -> @font-face CSS for the pages
export function scplFontCss(urls = {}) {
  const face = (family, url, weight, style, range = '') => (url
    ? `@font-face { font-family: '${family}'; src: url(${url}) format('woff2'); font-weight: ${weight}; font-style: ${style};${range ? ` unicode-range: ${range};` : ''} }`
    : '');
  return [face('Bill Times', urls.regular, 400, 'normal'), face('Bill Times', urls.bold, 700, 'normal'),
    face('Bill Times', urls.italic, 400, 'italic'), face('Bill Rupee', urls.rupee, '100 900', 'normal', 'U+20B9')].filter(Boolean).join('\n');
}
const ORANGE = '#C45911';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const X = 72;                                                // the text's left edge (margin + first-line indent)
const XR = 360;                                              // the right-hand block (Date:, Product:)
const COLS = [53.5, 49.65, 95.3, 63.3, 55.45, 91.7];          // the template's columns (twips / 20)
const HEAD_H = 18.5;
const ROW_H = 16.1;
const TABLE_TOP = 281.5;
const FOOT_Y = 826;                                          // the footer's baseline
const STAMP = { x: 76, y: 743, w: 146.4, h: 59.6 };          // the stamp's picture, above the footer

export function scplBillSvg(bill, { images = {}, fontCss = '', bank = {}, billTo = null } = {}) {
  const P = SCPL_PAGE;
  const isScpl = norm(bill.customer) === norm(SCPL_CUSTOMER);
  // billTo: {name, address: [lines], gstin} from the customer's sheet (split bills)
  const to = billTo ? { product: 'HSD', address: [], gstin: '', ...billTo } : isScpl ? SCPL_TEMPLATE : { name: bill.customer, address: [], gstin: '', product: 'HSD' };
  const payment = scplPaymentLines(bank);
  const PAY_H = 2 * 13.8 + 18.4 + payment.length * 16.1 + 8;  // two empty lines, the heading, the lines
  const aligns = ['start', 'start', 'start', 'middle', 'middle', 'end'];
  const lastBottom = STAMP.y - 8 - PAY_H;                    // the last sheet: room for the payment details
  const fullBottom = STAMP.y - 12;
  const svgs = [];
  for (const page of bill.pages) {
    const cells = tableCells(page);
    // rows per sheet; the TOTAL and the payment details on the last
    const capLast = Math.floor((lastBottom - TABLE_TOP - HEAD_H) / ROW_H) - 1;
    const capFull = Math.floor((fullBottom - TABLE_TOP - HEAD_H) / ROW_H);
    const chunks = [];
    let left = cells.rows.length;
    let i = 0;
    while (left > capLast) {
      const take = Math.min(capFull, left - 1);
      chunks.push(cells.rows.slice(i, i + take));
      i += take;
      left -= take;
    }
    chunks.push(cells.rows.slice(i));
    chunks.forEach((chunk, ci) => {
      const last = ci === chunks.length - 1;
      let out = '';
      if (images.letterhead) out += `<image href="${esc(images.letterhead)}" x="0" y="0" width="${P.width}" height="${(P.width * 303 / 979).toFixed(1)}" preserveAspectRatio="xMidYMin meet"/>`;
      // Bill To / Date … To …
      out += `<text x="${X}" y="190.5" font-size="16" font-weight="bold" fill="${ORANGE}">Bill To</text>`;
      out += `<text x="${XR}" y="190.5" font-size="16" font-weight="bold"><tspan fill="${ORANGE}">Date:</tspan><tspan x="${XR + 45}">${esc(ddmmyyyy(bill.from))}</tspan></text>`;
      out += `<text x="${X}" y="209" font-size="14" font-weight="bold">${esc(to.name)}</text>`;
      out += `<text x="${XR + 76}" y="209" font-size="16" font-weight="bold" text-anchor="middle">To</text>`;
      let ly = 227;
      to.address.forEach((a, k) => { out += `<text x="${X}" y="${ly + k * 17}" font-size="14">${esc(a)}</text>`; });
      out += `<text x="${XR + 47.5}" y="227" font-size="16" font-weight="bold">${esc(ddmmyyyy(bill.to))}</text>`;
      ly += Math.max(1, to.address.length) * 17 - 0.5;
      if (to.gstin) out += `<text x="${X}" y="${ly}" font-size="14" font-style="italic">GSTIN: ${esc(to.gstin)}</text>`;
      out += `<text x="${XR}" y="262" font-size="16" font-weight="bold"><tspan fill="${ORANGE}">Product:</tspan> ${esc(page.product || to.product)}</text>`;
      // a split bill: which vehicles this page is for
      if (page.byTag && page.cat) out += `<text x="${X}" y="${Math.max(262, ly + 18)}" font-size="16" font-weight="bold"><tspan fill="${ORANGE}">Vehicles:</tspan> ${esc(page.cat)}</text>`;
      if (chunks.length > 1) out += `<text x="${X + COLS.reduce((a, b) => a + b, 0)}" y="${TABLE_TOP - 6}" font-size="10" text-anchor="end" fill="#555">${esc(page.cat)} · sheet ${ci + 1} of ${chunks.length}</text>`;
      // the table
      let y = TABLE_TOP;
      const row = (vals, h, { head = false, total = false } = {}) => {
        let cx = X;
        let r = '';
        vals.forEach((v, k) => {
          r += `<rect x="${cx}" y="${y.toFixed(2)}" width="${COLS[k]}" height="${h}" fill="none" stroke="#000" stroke-width="0.5"/>`;
          const a = head ? 'middle' : total ? (k === 5 ? 'end' : 'middle') : aligns[k];
          const tx = a === 'start' ? cx + 5.4 : a === 'end' ? cx + COLS[k] - 5.4 : cx + COLS[k] / 2;
          if (v !== '') r += `<text x="${tx.toFixed(1)}" y="${(y + h - 3.2).toFixed(2)}" font-size="${total ? 14 : 12}"${head || total ? ' font-weight="bold"' : ''}${total ? ' fill="#FF0000"' : ''}${a !== 'start' ? ` text-anchor="${a}"` : ''}>${esc(v)}</text>`;
          cx += COLS[k];
        });
        y += h;
        return r;
      };
      out += row(['Date', 'Bill No', 'Vehicle', 'Quantity', 'Rate/Ltr', 'Amount'], HEAD_H, { head: true });
      for (const r of chunk) out += row(r, ROW_H);
      if (last) {
        out += row(cells.total, ROW_H + 2, { total: true });
        // Payment Details
        let py = y + 51.5;
        out += `<text x="${X}" y="${py.toFixed(1)}" font-size="16" font-weight="bold">Payment Details:</text>`;
        payment.forEach((l) => { py += 16.1; out += `<text x="${X}" y="${py.toFixed(1)}" font-size="14">${esc(l)}</text>`; });
      }
      // the stamp, pinned above the footer; the footer
      if (images.stamp) out += `<image href="${esc(images.stamp)}" x="${STAMP.x}" y="${STAMP.y}" width="${STAMP.w}" height="${STAMP.h}" preserveAspectRatio="xMidYMid meet"/>`;
      out += `<text x="${X}" y="${FOOT_Y}" font-size="16">For VRIDDHI FUELS</text>`;
      out += `<text x="${XR}" y="${FOOT_Y}" font-size="16" font-style="italic">Signature of Customer</text>`;
      svgs.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${P.width} ${P.height}" width="${P.width}" height="${P.height}" font-family="${FONT}">${fontCss ? `<style>${fontCss}</style>` : ''}<rect width="100%" height="100%" fill="#fff"/>${out}</svg>`);
    });
  }
  return svgs;
}
