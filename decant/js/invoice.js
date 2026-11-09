// An IOCL tax invoice PDF read in the browser — the fallback for when the
// payment agent hasn't picked the invoice up from mail yet. Same fields as
// agent/invoice.py + agent/decant.py (no DOM; the PDF text comes from pdf.js).

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/pdf.worker.min.mjs';

// pdf.js text items [{str, x, y, h}] -> visual lines, top to bottom.
export function linesFromItems(items) {
  const its = items.filter((i) => String(i.str).trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of its) {
    const tol = Math.max(2, (it.h || 8) * 0.35);
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tol);
    if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => l.items.sort((a, b) => a.x - b.x).map((i) => String(i.str).trim()).join(' ').replace(/\s+/g, ' '));
}

const PRODUCT_RE = /HSD|MS|EBMS|LSHF|PETROL|DIESEL|XTRA/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function dmy(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${m[1].padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`;
}

// The TT number, as agent/invoice.py parse_tt(): the value by the "T.T.No."
// label, whatever the registration's format (OD23U8210, or OD156815 with no
// series letters); else the usual format anywhere; else one without series letters.
const TT_ANY = '[A-Z]{2}\\s?\\d{1,2}\\s?[A-Z]{0,3}\\s?\\d{3,4}';
const TT_LABEL = /\bT\.\s*T\.\s*No\b\.?/i;
export function parseTT(lines, text) {
  for (let i = 0; i < lines.length; i++) {
    if (!TT_LABEL.test(lines[i])) continue;
    for (const cand of [lines[i].replace(TT_LABEL, ' '), lines[i - 1] || '', lines[i + 1] || '']) {
      const m = new RegExp(`\\b(${TT_ANY})\\b`).exec(cand.trim());
      if (m) return m[1].replace(/\s+/g, '');
    }
  }
  const m = /\b([A-Z]{2}\d{2}[A-Z]{1,3}\d{3,4})\b/.exec(text) || /\b([A-Z]{2}\d{2}\d{4})\b/.exec(text);
  return m ? m[1] : null;
}

// Visual lines -> the dec_invoices row shape.
export function parseInvoiceLines(lines, filename = '') {
  const text = lines.join('\n');
  const fileNo = /70\d{8}/.exec(filename || '')?.[0];
  const invoiceNo = fileNo || /\b(70\d{8})\b/.exec(text)?.[1] || null;
  const date = /\b(\d{1,2}-[A-Za-z]{3}-\d{2,4})\b/.exec(text);
  const time = /\bTime\s*:?\s*([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text) || /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
  const ttNo = parseTT(lines, text);
  const den = /Den\s*@\s*15\s*:?\s*(\d{3,4}(?:\.\d+)?)/.exec(text);
  const seal = /Seal\s*\/\s*Lock\s*no\s*:?\s*(.+)$/im.exec(text);

  const heads = [];
  lines.forEach((ln, i) => {
    const m = /^(?:\d{1,3}\s+)?(\d{4,6})\s+([A-Z][A-Z0-9 \-[\]/.]*?)\s+(\d+(?:\.\d+)?)\s+KL\b/.exec(ln);
    if (m && PRODUCT_RE.test(m[2].toUpperCase())) heads.push({ i, product: m[2].trim(), qty: Number(m[3]) });
  });
  const invLines = heads.map((h, k) => {
    const block = lines.slice(h.i + 1, k + 1 < heads.length ? heads[k + 1].i : lines.length).join('\n');
    const comp = /Comp\s*No\(?s?\)?\s*:?\s*([\d, ]+)/i.exec(block);
    const d15 = /Density\s*@\s*15\s*:?\s*(\d+(?:\.\d+)?)/i.exec(block);
    const tank = /Tank\s*no\s*:?\s*([A-Z0-9]+)/i.exec(block);
    const val = /Total for material\s*:?\s*(\d+(?:\.\d+)?)/i.exec(block);
    return {
      product: h.product,
      column_key: columnKey(h.product),
      qty_kl: h.qty,
      compartments: comp ? (comp[1].match(/\d+/g) || []).map(Number) : [],
      density15: d15 ? Number(d15[1]) : null,
      terminal_tank: tank ? tank[1] : null,
      value: val ? Math.round(Number(val[1])) : null,
    };
  });

  const chambers = [];
  const hi = lines.findIndex((l) => /QTY\s*-\s*kl/i.test(l));
  if (hi >= 0) {
    const nums = [];
    for (const ln of lines.slice(hi + 1)) {
      const toks = ln.split(/\s+/).filter(Boolean);
      if (!toks.length) continue;
      if (!toks.every((t) => /^\d+(?:\.\d+)?$/.test(t))) break;
      nums.push(...toks.map(Number));
    }
    if (nums.length && nums.length % 3 === 0) {
      for (let n = 0; n < nums.length / 3; n++) {
        const [pl, dip, qty] = nums.slice(3 * n, 3 * n + 3);
        if (!(qty >= 0 && qty <= 30 && dip >= 0 && dip <= 400)) { chambers.length = 0; break; }
        chambers.push({ no: n + 1, pl_cm: pl, dip_cm: dip, qty_kl: qty });
      }
    }
  }
  const totals = [...text.matchAll(/^Total\s+(\d+(?:\.\d+)?)\s*$/gm)];
  return {
    invoice_no: invoiceNo,
    invoice_date: date ? dmy(date[1]) : null,
    invoice_time: time ? `${time[1].padStart(2, '0')}:${time[2]}` : null,
    tt_no: ttNo,
    lines: invLines,
    chambers,
    density15: den ? Number(den[1]) : null,
    seals: seal ? seal[1].trim() : null,
    amount: totals.length ? Math.round(Number(totals[totals.length - 1][1])) : null,
    origin: parseOrigin(text),
    source: 'pdf',
  };
}

// Same as agent/invoice.py parse_origin(): the loading terminal named on the
// invoice, as the consignment note's "Place of Origin" (Jharsuguda by default).
const TERMINALS = [
  ['JHARSUGUDA', 'Jharsuguda Terminal, Jharsuguda, Odisha'],
  ['PARADEEP', 'Paradeep Terminal, Paradeep, Odisha'],
  ['PARADIP', 'Paradeep Terminal, Paradeep, Odisha'],
];
export function parseOrigin(text) {
  const u = String(text || '').toUpperCase();
  return (TERMINALS.find(([tok]) => u.includes(tok)) || TERMINALS[0])[1];
}

// Same mapping as agent/invoice.py product_column().
export function columnKey(product) {
  const u = String(product || '').toUpperCase();
  if (/XTRA\s*GR|XTRAGRN|\bXG\b/.test(u)) return 'XtraGreen HSD';   // IOCL prints XtraGreen as HSD-XG-BSVI
  if (/LSHF/.test(u)) return 'LSHFHSD';
  if (/EBMS/.test(u) || /^\s*MS\b/.test(u)) return 'MS | EBMS';
  return 'HSD';
}

// Browser only: read an invoice PDF File.
export async function readInvoicePdf(file) {
  const pdfjs = await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    lines.push(...linesFromItems(tc.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], h: i.height }))));
  }
  const inv = parseInvoiceLines(lines, file.name);
  if (!inv.tt_no || !inv.lines.length) throw new Error('This doesn\'t look like an IndianOil tax invoice (no truck number or product found).');
  return inv;
}
