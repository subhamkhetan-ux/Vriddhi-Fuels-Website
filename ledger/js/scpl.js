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
// Pure: no DOM, no network. scplBillSvg() draws the pages (A4, points);
// scplDocXml() fills the Word template (Steels & Carriers.docx) the way the
// macro does.

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
// a page's rows as the Word table's cells (the TOTAL row last)
export function tableCells(page) {
  return {
    rows: page.rows.map((r) => [ddmmyy(r.date), String(r.bill_no ?? ''), page.cat, numStr(r.qty), r.rate.toFixed(2), indian(r.amount)]),
    total: ['', '', 'TOTAL', page.qty.toFixed(2), '', `₹${indian(page.amount)}`],
  };
}

// the file name: "SCPL Bill 1-10 Nov 2026" (as the macro files it), or
// "SCPL Bill 21 Oct-10 Nov 2026" across months
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function scplFileName(from, to) {
  const d = (x) => Number(x.slice(8, 10));
  const mon = (x) => MON[Number(x.slice(5, 7)) - 1];
  if (from.slice(0, 7) === to.slice(0, 7)) return `SCPL Bill ${d(from)}-${d(to)} ${mon(to)} ${to.slice(0, 4)}`;
  return `SCPL Bill ${d(from)} ${mon(from)}${from.slice(0, 4) !== to.slice(0, 4) ? ` ${from.slice(0, 4)}` : ''}-${d(to)} ${mon(to)} ${to.slice(0, 4)}`;
}

// ---- the pages (A4, points) ------------------------------------------------------
// One page per category (a long period runs on to more pages; the TOTAL on
// the last). images: {letterhead, stamp} as URLs; measure(text, {b, s}) ->
// width in points.
export const SCPL_PAGE = { width: 595.3, height: 841.9 };
const FONT = "'Times New Roman', Tinos, Times, serif";
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ROW = 18;
export function scplBillSvg(bill, { images = {}, fontCss = '', billDate = '' } = {}) {
  const P = SCPL_PAGE;
  const M = 40;
  const W = P.width - 2 * M;
  const cols = [0.15, 0.15, 0.2, 0.15, 0.14, 0.21].map((f) => f * W);
  const heads = ['Date', 'Bill No.', 'Vehicle', 'Quantity', 'Rate/Ltr', 'Amount'];
  const align = ['start', 'start', 'start', 'middle', 'middle', 'end'];
  const headH = images.letterhead ? W * (303 / 979) + 20 : 120;
  const firstTop = headH + 128;
  const bottom = P.height - 150;                               // room for the stamp
  const svgs = [];
  for (const page of bill.pages) {
    const cells = tableCells(page);
    // rows per sheet: the first has the heading, the ones after only the
    // letterhead; the TOTAL row goes on the last
    const contTop = headH + 40;
    const chunks = [];
    let left = cells.rows.length;
    let i = 0;
    while (left > 0 || !chunks.length) {
      const cap = Math.max(2, Math.floor((bottom - (chunks.length ? contTop : firstTop) - ROW) / ROW));
      const take = left <= cap - 1 ? left : Math.min(cap, left - 1);
      chunks.push(cells.rows.slice(i, i + take));
      i += take;
      left -= take;
      if (!left) break;
    }
    chunks.forEach((chunk, ci) => {
      const last = ci === chunks.length - 1;
      let out = '';
      let y = 20;
      if (images.letterhead) out += `<image href="${esc(images.letterhead)}" x="${M}" y="${y}" width="${W}" height="${(W * (303 / 979)).toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`;
      y = headH;
      if (ci) {
        out += `<text x="${M}" y="${y + 6}" font-size="12">${esc(bill.customer)} · ${esc(ddmmyyyy(bill.from))} to ${esc(ddmmyyyy(bill.to))} · <tspan font-weight="bold">${esc(page.cat)}</tspan> (continued, page ${ci + 1} of ${chunks.length})</text>`;
      } else {
      out += `<text x="${P.width / 2}" y="${y + 6}" text-anchor="middle" font-size="17" font-weight="bold" text-decoration="underline">BILL</text>`;
      if (billDate) out += `<text x="${P.width - M}" y="${y + 6}" text-anchor="end" font-size="12">Date: ${esc(ddmmyyyy(billDate))}</text>`;
      out += `<text x="${M}" y="${y + 34}" font-size="13">To,</text>`;
      out += `<text x="${M}" y="${y + 52}" font-size="13" font-weight="bold">${esc(bill.customer)}</text>`;
      out += `<text x="${M}" y="${y + 80}" font-size="13">HSD supplied from <tspan font-weight="bold">${esc(ddmmyyyy(bill.from))}</tspan> to <tspan font-weight="bold">${esc(ddmmyyyy(bill.to))}</tspan> — <tspan font-weight="bold">${esc(page.cat)}</tspan>${chunks.length > 1 ? ` (page 1 of ${chunks.length})` : ''}</text>`;
      }
      y = (ci ? contTop : firstTop) - 12;
      const rowSvg = (vals, { head = false, total = false } = {}) => {
        let cx = M;
        let s = '';
        vals.forEach((v, k) => {
          s += `<rect x="${cx.toFixed(1)}" y="${y.toFixed(1)}" width="${cols[k].toFixed(1)}" height="${ROW}" fill="${head ? '#f2f2f2' : 'none'}" stroke="#000" stroke-width="0.7"/>`;
          const a = head ? 'middle' : align[k];
          const tx = a === 'start' ? cx + 5 : a === 'end' ? cx + cols[k] - 5 : cx + cols[k] / 2;
          s += `<text x="${tx.toFixed(1)}" y="${(y + ROW - 6).toFixed(1)}" font-size="${total ? 14 : 12}"${head || total ? ' font-weight="bold"' : ''}${total ? ' fill="#ff0000"' : ''}${a !== 'start' ? ` text-anchor="${a}"` : ''}>${esc(v)}</text>`;
          cx += cols[k];
        });
        y += ROW;
        return s;
      };
      out += rowSvg(heads, { head: true });
      for (const r of chunk) out += rowSvg(r);
      if (last) {
        const t = cells.total;
        // TOTAL spans the first three cells, as it reads on the sheet
        let s = '';
        const span = cols[0] + cols[1] + cols[2];
        s += `<rect x="${M}" y="${y.toFixed(1)}" width="${span.toFixed(1)}" height="${ROW + 4}" fill="none" stroke="#000" stroke-width="0.7"/>`;
        s += `<text x="${(M + span / 2).toFixed(1)}" y="${(y + ROW - 3).toFixed(1)}" font-size="14" font-weight="bold" fill="#ff0000" text-anchor="middle">TOTAL</text>`;
        let cx = M + span;
        [t[3], t[4], t[5]].forEach((v, k) => {
          const w = cols[k + 3];
          s += `<rect x="${cx.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${ROW + 4}" fill="none" stroke="#000" stroke-width="0.7"/>`;
          if (v) s += `<text x="${(k === 2 ? cx + w - 5 : cx + w / 2).toFixed(1)}" y="${(y + ROW - 3).toFixed(1)}" font-size="14" font-weight="bold" fill="#ff0000" text-anchor="${k === 2 ? 'end' : 'middle'}">${esc(v)}</text>`;
          cx += w;
        });
        out += s;
        y += ROW + 4;
      }
      // the stamp and signature, just above the foot (as the macro pins it)
      const sy = P.height - 132;
      out += `<text x="${P.width - M}" y="${sy}" text-anchor="end" font-size="13" font-weight="bold">For Vriddhi Fuels</text>`;
      if (images.stamp) out += `<image href="${esc(images.stamp)}" x="${P.width - M - 150}" y="${sy + 6}" width="150" height="60" preserveAspectRatio="xMaxYMid meet"/>`;
      out += `<text x="${P.width - M}" y="${sy + 86}" text-anchor="end" font-size="13" font-weight="bold">Authorised Signatory</text>`;
      svgs.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${P.width} ${P.height}" width="${P.width}" height="${P.height}" font-family="${FONT}">${fontCss ? `<style>${fontCss}</style>` : ''}<rect width="100%" height="100%" fill="#fff"/>${out}</svg>`);
    });
  }
  return svgs;
}

// ---- the Word template (Steels & Carriers.docx) ----------------------------------
// document.xml filled as the macro fills it:
//   SetBillToDates — the first date (d-m-yyyy) becomes From, the next To
//   DuplicateBody  — with both categories, the page copied after a page break
//   FillTable      — each page's first table: header and last (TOTAL) row kept,
//                    a row per bill in Times New Roman 12, TOTAL red, bold, 14
const xmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// a piece of document.xml as plain text
export const docText = (x) => unx((x.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''));

// The first dates (d-m-yyyy) in the paragraphs' text become values[0],
// values[1], … — even when Word has split a date over several runs: each
// character remembers its run, and a replaced date goes into the run where
// it started.
const T_RE = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;
const unx = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function replaceDates(xml, values) {
  const left = [...values];
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (p) => {
    if (!left.length) return p;
    const runs = [...p.matchAll(T_RE)].map((m) => unx(m[2]));
    if (!runs.length) return p;
    let text = runs.join('');
    let owner = runs.flatMap((t, i) => Array.from(t, () => i));
    let from = 0;
    let changed = false;
    const re = /\d{1,2}-\d{1,2}-\d{4}/g;
    while (left.length) {
      re.lastIndex = from;
      const m = re.exec(text);
      if (!m) break;
      const v = left.shift();
      const run = owner[m.index];
      text = text.slice(0, m.index) + v + text.slice(m.index + m[0].length);
      owner = [...owner.slice(0, m.index), ...Array.from(v, () => run), ...owner.slice(m.index + m[0].length)];
      from = m.index + v.length;
      changed = true;
    }
    if (!changed) return p;
    const out = runs.map(() => '');
    Array.from(text).forEach((ch, i) => { out[owner[i]] += ch; });
    let k = 0;
    return p.replace(T_RE, (_m, a, _b, c) => `${a.includes('xml:space') ? a : a.replace('<w:t', '<w:t xml:space="preserve"')}${xmlEsc(out[k++])}${c}`);
  });
}

// a cell's text, in the macro's font, size, colour and alignment
function cellXml(tc, text, { align = 'left', bold = false, size = 12, red = false } = {}) {
  const open = tc.match(/^<w:tc\b[^>]*>/)[0];
  const tcPr = (tc.match(/<w:tcPr\b[\s\S]*?<\/w:tcPr>/) || [''])[0];
  const firstP = tc.match(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/);
  let pPr = firstP ? (firstP[0].match(/<w:pPr\b[\s\S]*?<\/w:pPr>/) || [''])[0] : '';
  const jc = `<w:jc w:val="${align === 'center' ? 'center' : align === 'right' ? 'right' : 'left'}"/>`;
  if (!pPr) pPr = `<w:pPr>${jc}</w:pPr>`;
  else if (/<w:jc\b[^>]*\/>/.test(pPr)) pPr = pPr.replace(/<w:jc\b[^>]*\/>/, jc);
  else pPr = pPr.replace(/<w:rPr\b|<\/w:pPr>/, (x) => `${jc}${x}`);
  const rPr = `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${bold ? '<w:b/><w:bCs/>' : '<w:b w:val="0"/><w:bCs w:val="0"/>'}<w:i w:val="0"/><w:color w:val="${red ? 'FF0000' : '000000'}"/><w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/><w:u w:val="none"/></w:rPr>`;
  return `${open}${tcPr}<w:p>${pPr}${text ? `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>` : ''}</w:p></w:tc>`;
}
function rowXml(tr, values, opts) {
  let i = 0;
  return tr.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (tc) => {
    const k = i++;
    if (k >= values.length || values[k] === null) return tc;
    return cellXml(tc, values[k], { ...opts, ...(opts.aligns ? { align: opts.aligns[k] } : {}) });
  });
}
function fillTableXml(tbl, page) {
  const rows = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  if (rows.length < 2) throw new Error('The template\'s table needs a header row and a TOTAL row.');
  const head = rows[0];
  const tot = rows[rows.length - 1];
  const sample = rows.length > 2 ? rows[1] : tot;
  const cells = tableCells(page);
  const aligns = ['left', 'left', 'left', 'center', 'center', 'right'];
  const data = cells.rows.map((v) => rowXml(sample, v, { aligns, size: 12 }));
  const total = rowXml(tot, [null, null, 'TOTAL', cells.total[3], '', cells.total[5]],
    { aligns: ['left', 'left', 'center', 'center', 'center', 'right'], bold: true, size: 14, red: true });
  const start = tbl.indexOf(rows[0]);
  const end = tbl.lastIndexOf(tot) + tot.length;
  return tbl.slice(0, start) + head + data.join('') + total + tbl.slice(end);
}

export function scplDocXml(xml, bill) {
  if (!bill.pages.length) throw new Error('No bills to put in the template.');
  let doc = replaceDates(xml, [ddmmyyyy(bill.from), ddmmyyyy(bill.to)]);
  const bodyStart = doc.indexOf('<w:body>') + '<w:body>'.length;
  const sect = doc.lastIndexOf('<w:sectPr');
  const bodyEnd = doc.lastIndexOf('</w:body>');
  const cut = sect > bodyStart ? sect : bodyEnd;
  let content = doc.slice(bodyStart, cut);
  if (!/<w:tbl\b/.test(content)) throw new Error('The template has no table for the bills.');
  const fillFirst = (c, page) => c.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/, (t) => fillTableXml(t, page));
  let out = fillFirst(content, bill.pages[0]);
  if (bill.pages[1]) {
    // the copy's pictures and text boxes need their own ids
    let n = 0;
    const copy = fillFirst(content, bill.pages[1]).replace(/(<wp:docPr\b[^>]*\bid=")(\d+)"/g, (_m, a, id) => `${a}${Number(id) + 1000 + (n++)}"`);
    out += `<w:p><w:r><w:br w:type="page"/></w:r></w:p>${copy}`;
  }
  return doc.slice(0, bodyStart) + out + doc.slice(cut);
}
