// Phase 2: drawing the bills and making the PDFs.
//   tankerBillSvg() — the Billing sheet (A4), same layout and coordinates as
//                     the /tanker app (measured from the Excel export)
//   slipSvg()       — the HSD Bill sheet's credit memo (A5)
// The SVG builders are pure (tested in node); pdf / zip helpers need a browser.

import { dmy } from './bills.js';

export const A4 = { width: 595.28, height: 841.89 };
export const A5 = { width: 419.53, height: 595.28 };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = '&quot;Times New Roman&quot;,Times,&quot;Liberation Serif&quot;,serif';

// 1234567 -> 12,34,567 (whole rupees, like the tanker bill)
export function inr(n) {
  const s = String(Math.trunc(Math.abs(Number(n) || 0)));
  if (s.length <= 3) return s;
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${s.slice(-3)}`;
}

// Excel's "#,##0.00"
export function money2(n) {
  return (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ddmmyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '');

// bill: {sale_date, bill_no, vehicle, qty, rate, amount, po}
// company: Tanker Master row {company, address[3], payment[5]}
// images: {letterhead, stamp} — URLs (data: URLs when turned into a PDF)
export function tankerBillSvg(bill, company, images = {}) {
  const qty = Number(bill.qty) || 0;
  const heavy = qty > 3000;                        // Density / Seal lines (Billing B25, B28)
  const a = (company && company.address) || [];
  const pay = (company && company.payment) || [];
  const po = String(bill.po || '').trim();
  const t = (x, y, text, attrs = '') => (text ? `<text x="${x}" y="${y}" ${attrs}>${esc(text)}</text>` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${A4.width} ${A4.height}" width="${A4.width}" height="${A4.height}" font-family="${FONT}">
<rect x="0" y="0" width="${A4.width}" height="${A4.height}" fill="#fff"/>
${images.letterhead ? `<image href="${esc(images.letterhead)}" x="34.2" y="41.3" width="529.3" height="159.4" preserveAspectRatio="none"/>` : ''}
${images.stamp ? `<image href="${esc(images.stamp)}" x="52.7" y="746.2" width="150.8" height="57.1" preserveAspectRatio="none"/>` : ''}
<g font-size="15.4" font-weight="bold" fill="#ED7D31">
<text x="56.6" y="212.2">Bill To</text><text x="380.2" y="212.2">Date:</text><text x="357.1" y="267.8">Product:</text>
</g>
<text x="56.6" y="319.7" font-size="13.4" font-weight="bold">Invoice Details:</text>
<g stroke="#000" stroke-width="0.9">
<line x1="54.25" y1="322.6" x2="54.25" y2="366.7"/><line x1="125.3" y1="322.6" x2="125.3" y2="366.7"/>
<line x1="187.7" y1="322.6" x2="187.7" y2="366.7"/><line x1="288.5" y1="322.6" x2="288.5" y2="366.7"/>
<line x1="352.8" y1="322.6" x2="352.8" y2="366.7"/><line x1="418.1" y1="322.6" x2="418.1" y2="366.7"/>
<line x1="501.6" y1="322.6" x2="501.6" y2="366.7"/>
<line x1="54.25" y1="323.05" x2="501.6" y2="323.05"/><line x1="54.25" y1="344.15" x2="501.6" y2="344.15"/>
<line x1="54.25" y1="366.25" x2="501.6" y2="366.25"/>
</g>
<g font-size="15.4" font-weight="bold" text-anchor="middle">
<text x="89.8" y="338.9">Date</text><text x="156.5" y="338.9">Bill No</text><text x="238.1" y="338.9">Vehicle</text>
<text x="320.65" y="338.9">Quantity</text><text x="385.45" y="338.9">Price/Ltr</text><text x="459.85" y="338.9">Amount</text>
</g>
<g font-size="15.4" text-anchor="middle">
${t(89.8, 361.0, ddmmyy(bill.sale_date))}${t(156.5, 361.0, bill.bill_no)}${t(238.1, 361.0, String(bill.vehicle || '').toUpperCase())}
${t(320.65, 361.0, qty ? String(Math.trunc(qty)) : '')}${t(385.45, 361.0, bill.rate != null && bill.rate !== '' ? Number(bill.rate).toFixed(2) : '')}
${t(498, 361.0, bill.amount ? `₹${inr(bill.amount)}` : '', 'text-anchor="end" font-weight="bold" fill="#FF0000"')}
</g>
<g font-size="15.4">
${t(420.5, 212.2, ddmmyy(bill.sale_date), 'font-weight="bold"')}${t(420.5, 267.8, 'High Speed Diesel', 'font-weight="bold"')}
${t(56.6, 230.4, company ? company.company : '', 'font-weight="bold"')}
${t(56.6, 248.6, a[0])}${t(56.6, 267.8, a[1])}${t(56.6, 286.1, a[2], 'font-style="italic"')}
${po ? `${t(56.6, 409.0, 'P.O. No.:', 'font-weight="bold"')}${t(127.7, 409.0, po, 'font-weight="bold"')}` : ''}
${heavy ? `${t(56.6, 443.5, 'Density-', 'font-style="italic"')}${t(56.6, 498.2, 'Seal No-', 'font-style="italic"')}` : ''}
${t(56.6, 569.3, pay[0], 'font-weight="bold"')}${t(56.6, 586.6, pay[1])}${t(56.6, 603.8, pay[2])}${t(56.6, 621.1, pay[3])}${t(56.6, 638.4, pay[4])}
<text x="56.6" y="818.9">for VRIDDHI FUELS</text><text x="421.4" y="818.9" font-style="italic">Signature of Customer</text>
</g>
</svg>`;
}

export const PRODUCT_NAME = { HSD: 'High Speed Diesel', MS: 'Motor Spirit', XG: 'XtraGreen Diesel' };

const dmyShort = (iso) => (iso ? `${Number(iso.slice(8, 10))}-${Number(iso.slice(5, 7))}-${iso.slice(0, 4)}` : '');

// header: {title, mobile, lines[]} — the HSD Bill sheet's A1, D1 and A2:A8
export function slipSvg(bill, header = {}) {
  const W = A5.width;
  const L = 22;
  const R = W - 22;
  const lines = (header.lines || []).filter((x) => String(x || '').trim());
  const out = [];
  const t = (x, y, text, attrs = '') => out.push(`<text x="${x}" y="${y}" ${attrs}>${esc(text)}</text>`);
  t(L, 36, header.title || 'CREDIT MEMO', 'font-size="13" font-weight="bold"');
  if (header.mobile) t(R, 36, header.mobile, 'font-size="11" text-anchor="end"');
  let y = 62;
  lines.forEach((line, i) => {
    t(W / 2, y, line, i === 0 ? 'font-size="17" font-weight="bold" text-anchor="middle"' : 'font-size="10.5" text-anchor="middle"');
    y += i === 0 ? 18 : 14;
  });
  y += 8;
  out.push(`<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="#000" stroke-width="0.8"/>`);
  y += 20;
  t(L, y, 'No. :', 'font-size="11.5" font-weight="bold"');
  t(L + 40, y, bill.bill_no, 'font-size="11.5"');
  t(R - 110, y, 'Date :', 'font-size="11.5" font-weight="bold"');
  t(R, y, dmyShort(bill.sale_date), 'font-size="11.5" text-anchor="end"');
  y += 20;
  t(L, y, 'M/s :', 'font-size="11.5" font-weight="bold"');
  t(L + 40, y, bill.customer, 'font-size="11.5" font-weight="bold"');
  y += 20;
  t(L, y, 'Vehicle No. :', 'font-size="11.5" font-weight="bold"');
  t(L + 80, y, bill.vehicle || '', 'font-size="11.5"');
  y += 22;
  // table: Particulars | Quantity | Rate | Amount
  const cols = [L, L + 150, L + 245, L + 300, R];
  const top = y;
  const head = top + 20;
  const bottom = top + 200;
  out.push(`<g stroke="#000" stroke-width="0.8" fill="none"><rect x="${L}" y="${top}" width="${R - L}" height="${bottom - top}"/>
<line x1="${L}" y1="${head}" x2="${R}" y2="${head}"/>${cols.slice(1, 4).map((x) => `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom - 22}"/>`).join('')}
<line x1="${L}" y1="${bottom - 22}" x2="${R}" y2="${bottom - 22}"/><line x1="${cols[3]}" y1="${bottom - 22}" x2="${cols[3]}" y2="${bottom}"/></g>`);
  const mid = (i) => (cols[i] + cols[i + 1]) / 2;
  ['Particulars', 'Quantity', 'Rate', 'Amount'].forEach((h, i) => t(mid(i), top + 14, h, 'font-size="11.5" font-weight="bold" text-anchor="middle"'));
  const qty = Number(bill.qty) || 0;
  t(cols[0] + 6, head + 18, PRODUCT_NAME[bill.product] || PRODUCT_NAME.HSD, 'font-size="11.5"');
  t(cols[2] - 6, head + 18, `${qty.toFixed(2)} LTR`, 'font-size="11.5" text-anchor="end"');
  t(cols[3] - 6, head + 18, (Number(bill.rate) || 0).toFixed(2), 'font-size="11.5" text-anchor="end"');
  t(cols[4] - 6, head + 18, money2(bill.amount), 'font-size="11.5" text-anchor="end"');
  t(cols[0] + 6, bottom - 7, 'Thank You', 'font-size="11.5" font-style="italic"');
  t(cols[3] - 6, bottom - 7, 'Total', 'font-size="11.5" font-weight="bold" text-anchor="end"');
  t(cols[4] - 6, bottom - 7, `₹ ${money2(bill.amount)}`, 'font-size="11.5" font-weight="bold" text-anchor="end"');
  const sy = Math.min(A5.height - 30, bottom + 110);
  t(L, sy, "Customer's Sign.", 'font-size="11"');
  t(R, sy, 'Sign.of Salesman', 'font-size="11" text-anchor="end"');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${A5.height}" width="${W}" height="${A5.height}" font-family="${FONT}">
<rect x="0" y="0" width="${W}" height="${A5.height}" fill="#fff"/>
${out.join('\n')}
</svg>`;
}

// ---- browser-only: PDF and zip -------------------------------------------------

const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

function loadScript(src, ready) {
  if (ready()) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (ready() ? resolve(ready()) : reject(new Error(`${src} loaded without its library`)));
    s.onerror = () => reject(new Error(`Couldn't load ${new URL(src).hostname}. Check the internet connection.`));
    document.head.append(s);
  });
}

const dataUrlCache = new Map();
export async function toDataUrl(url) {
  if (!dataUrlCache.has(url)) {
    dataUrlCache.set(url, fetch(url).then((r) => r.blob()).then((b) => new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(b);
    })));
  }
  return dataUrlCache.get(url);
}

async function svgToJpeg(svg, size, scale) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// svgs: page SVG strings (images already as data: URLs) -> PDF Blob
export async function pdfFromSvgs(svgs, size, { scale = 2 } = {}) {
  const { jsPDF } = await loadScript(JSPDF, () => window.jspdf);
  const pdf = new jsPDF({ unit: 'pt', format: [size.width, size.height], orientation: 'portrait', compress: true });
  for (let i = 0; i < svgs.length; i++) {
    if (i) pdf.addPage([size.width, size.height], 'portrait');
    pdf.addImage(await svgToJpeg(svgs[i], size, scale), 'JPEG', 0, 0, size.width, size.height);
  }
  return pdf.output('blob');
}

export async function zipBlob(files, folder = '') {
  const JSZip = await loadScript(JSZIP, () => window.JSZip);
  const zip = new JSZip();
  const dir = folder ? zip.folder(folder) : zip;
  for (const f of files) dir.file(f.name, f.blob);
  return zip.generateAsync({ type: 'blob' });
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export { dmy };
