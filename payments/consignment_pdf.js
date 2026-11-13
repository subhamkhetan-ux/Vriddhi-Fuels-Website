// The consignment note as a PDF, on the firm's own blank note
// (consignment_note_template.pdf): the values are written onto it as text, in
// Times like the form, so the printout is exactly that form — letterhead,
// logos and table as they are. The page is then put on A5 (the template is
// A4; A5 is the same shape, ~70%).
//
// Works in the browser (pdf-lib from the CDN) and in Node (tests pass the
// pdf-lib module in). No DOM here.

export const PDFLIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';

// A5 in points; the template page is A4 (595.32 x 841.92).
export const A5 = [419.53, 595.28];
const A4H = 841.92;

// The financial-year code for a date: 1 Apr–31 Mar. '2627' runs from
// 1 Apr 2026 to 31 Mar 2027, '2728' from 1 Apr 2027, and so on (the same rule
// as pay_consignment_fy_code in the database). `d` is a Date, read in IST.
export function fyCode(d = new Date()) {
  const ist = new Date(d.getTime() + 330 * 60000);
  const y = ist.getUTCFullYear();
  const ys = ist.getUTCMonth() + 1 >= 4 ? y : y - 1;
  const two = (n) => String(n % 100).padStart(2, '0');
  return two(ys) + two(ys + 1);
}

// The serial prefix printed on a blank note: VF/CN2627/ for FY 2026-27.
export function blankPrefix(d = new Date()) {
  return `VF/CN${fyCode(d)}/`;
}

const ORIGIN = 'Jharsuguda Terminal, Jharsuguda, Odisha';   // printed on the template
const COLUMNS = ['MS | EBMS', 'XtraGreen HSD', 'HSD', 'LSHFHSD'];
// Where each value goes on the template (A4 points, from the top; x = left
// edge, or the cell's centre for the quantities; y = the text's baseline).
const AT = {
  serial: { x: 166.0, y: 228.24, size: 12.0, bold: true, underline: true, cover: [165, 216, 229, 232] },
  date: { x: 476.5, y: 228.24, size: 12.0 },
  origin: { x: 134.16, y: 299.4, size: 12.96, bold: true, cover: [133, 286, 376, 303] },
  qty: { y: 500.76, size: 11.04, centres: { 'MS | EBMS': 179.85, 'XtraGreen HSD': 275.65, HSD: 371.4, LSHFHSD: 467.15 } },
  value: { x: 146.2, y: 555.0, size: 12.96, bold: true },
  invoiceNo: { x: 146.2, y: 585.0, size: 12.96, bold: true },
  invoiceDate: { x: 341.0, y: 585.0, size: 12.96, bold: true },
};

// The note's values -> what is written. A blank note writes only the
// FY-correct serial prefix (and leaves the number, date and the rest for hand).
//   note: { serial_str, reporting_date|date, origin, columns {col: qty},
//           value, invoice_no, invoice_date }
export function noteFields(note) {
  if (!note) return { serial: blankPrefix(), blank: true };
  const cols = {};
  for (const [c, q] of Object.entries(note.columns || {})) if (COLUMNS.includes(c) && q !== '' && q != null) cols[c] = String(q);
  return {
    serial: note.serial_str || '',
    date: note.reporting_date || note.invoice_date || '',
    origin: note.origin && note.origin !== ORIGIN ? note.origin : null,
    qty: cols,
    value: note.value == null || note.value === '' ? '' : `${note.value}/-`,
    invoiceNo: note.invoice_no || '',
    invoiceDate: note.invoice_date || '',
  };
}

// Template bytes + fields -> A5 PDF bytes.
export async function buildNotePdf(PDFLib, templateBytes, fields) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const tpl = await PDFDocument.load(templateBytes);
  const page = tpl.getPage(0);
  const reg = await tpl.embedFont(StandardFonts.TimesRoman);
  const bold = await tpl.embedFont(StandardFonts.TimesRomanBold);
  const black = rgb(0, 0, 0);
  const Y = (y) => A4H - y;

  const cover = ([x0, y0, x1, y1]) => page.drawRectangle({ x: x0, y: Y(y1), width: x1 - x0, height: y1 - y0, color: rgb(1, 1, 1) });
  const text = (s, at, { x = at.x, centre = false } = {}) => {
    if (!s) return 0;
    const font = at.bold ? bold : reg;
    const w = font.widthOfTextAtSize(s, at.size);
    const left = centre ? x - w / 2 : x;
    page.drawText(s, { x: left, y: Y(at.y), size: at.size, font, color: black });
    if (at.underline) page.drawRectangle({ x: left, y: Y(at.y + 2.6), width: w, height: 0.9, color: black });
    return w;
  };

  // the serial: the template's own "VF/CN2627" is replaced by the FY-correct one
  cover(AT.serial.cover);
  const w = text(fields.serial, AT.serial);
  if (fields.blank) {                 // a line to write the number on
    page.drawRectangle({ x: AT.serial.x + w + 1, y: Y(AT.serial.y + 2.6), width: 46, height: 0.6, color: black });
  }
  if (!fields.blank) {
    text(fields.date, AT.date);
    if (fields.origin) { cover(AT.origin.cover); text(fields.origin, AT.origin); }
    for (const [col, q] of Object.entries(fields.qty || {})) text(q, AT.qty, { x: AT.qty.centres[col], centre: true });
    text(fields.value, AT.value);
    text(fields.invoiceNo, AT.invoiceNo);
    text(fields.invoiceDate, AT.invoiceDate);
  }

  // onto A5: the same page, scaled to fit and centred
  const filled = await tpl.save();
  const out = await PDFDocument.create();
  const [emb] = await out.embedPdf(filled, [0]);
  const s = Math.min(A5[0] / emb.width, A5[1] / emb.height);
  const a5 = out.addPage(A5);
  a5.drawPage(emb, { x: (A5[0] - emb.width * s) / 2, y: (A5[1] - emb.height * s) / 2, xScale: s, yScale: s });
  out.setTitle(fields.blank ? 'Consignment note (blank)' : `Consignment note ${fields.serial}`);
  return out.save();
}
