// Phase 2: drawing the bills and making the PDFs.
//   tankerBillSvg() — the Billing sheet (A4), same layout and coordinates as
//                     the /tanker app (measured from the Excel export)
//   slipSvg()       — the HSD Bill sheet's credit memo (A5)
// The SVG builders are pure (tested in node); pdf / zip helpers need a browser.

import { dmy } from './bills.js';

export const A4 = { width: 595.28, height: 841.89 };
export const A5 = { width: 420, height: 595 };

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

// 1791000 -> 17,91,000.00 (Excel's "#,##0.00" on an Indian-locale Mac)
export function inr2(n) {
  const v = Number(n) || 0;
  const [whole, frac] = Math.abs(v).toFixed(2).split('.');
  const grouped = whole.length <= 3 ? whole : `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;
  return `${v < 0 ? '-' : ''}${grouped}.${frac}`;
}

const ARIAL = 'Arial,&quot;Arial Unicode MS&quot;,Arimo,&quot;Liberation Sans&quot;,Helvetica,sans-serif';
const TIMES = '&quot;Times New Roman&quot;,Times,&quot;Liberation Serif&quot;,serif';

// The HSD Bill sheet's credit memo (A5). Positions, sizes and lines are
// measured from a real Excel export of Print Bills.
// header: {title, mobile, lines[]} (A1, D1, A2:A8); stamp: image URL or ''
export function slipSvg(bill, header = {}, stamp = '') {
  const W = A5.width;
  const H = A5.height;
  const out = [];
  // text placed by its PDF box top (y0) -> SVG baseline (Arial ascent .905, Times .891)
  const t = (x, y0, size, text, { bold = false, anchor = 'start', font = ARIAL, fill = '#000', clip = '' } = {}) => {
    const base = y0 + size * (font === TIMES ? 0.891 : 0.905);
    out.push(`<text x="${x}" y="${base.toFixed(2)}" font-size="${size}" font-family="${font}"${bold ? ' font-weight="bold"' : ''}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${fill !== '#000' ? ` fill="${fill}"` : ''}${clip ? ` clip-path="url(#${clip})"` : ''}>${esc(text)}</text>`);
  };
  const rect = (x0, y0, x1, y1) => out.push(`<rect x="${x0}" y="${y0}" width="${(x1 - x0).toFixed(2)}" height="${(y1 - y0).toFixed(2)}" fill="#000"/>`);

  rect(18.62, 17.64, 128.38, 35.28);
  t(21.6, 18.9, 13.7, header.title || 'CREDIT MEMO', { bold: true, fill: '#fff' });
  if (header.mobile) t(396.9, 19.1, 13.7, header.mobile, { bold: true, anchor: 'end', font: TIMES });
  const tops = [40.9, 59.0, 74.7, 90.4, 106.1, 121.8, 138.4];
  (header.lines || []).slice(0, 7).forEach((line, i) => {
    if (i === 0) t(210, tops[0], 15.7, line, { bold: true, anchor: 'middle', font: TIMES });
    else t(210, tops[i], 12.7, line, { anchor: 'middle' });
  });

  t(21.6, 162.0, 13.7, 'No. :');
  t(130.3, 162.0, 13.7, bill.bill_no, { bold: true });
  t(264.6, 162.0, 13.7, 'Date :');
  t(306.7, 162.0, 13.7, dmyShort(bill.sale_date), { bold: true });
  t(21.6, 187.5, 13.7, 'M/s :');
  t(130.3, 188.4, 12.7, bill.customer, { bold: true, clip: 'edge' });
  t(21.6, 210.0, 13.7, 'Vehicle No. :');
  t(130.3, 210.0, 13.7, bill.vehicle || '', { bold: true, clip: 'edge' });

  // table borders: 0.98 pt filled bars, as in the export
  rect(18.62, 239.12, 19.6, 513.52);
  rect(398.86, 240.1, 399.84, 513.52);
  rect(166.6, 240.1, 167.58, 393.96);
  rect(258.72, 240.1, 259.7, 410.62);
  rect(303.8, 240.1, 304.78, 410.62);
  for (const y of [239.12, 255.78, 392.98, 409.64, 426.3, 512.54]) rect(19.6, y, 399.84, y + 0.98);

  t(21.6, 240.4, 13.7, 'Particulars');
  t(213.15, 240.4, 13.7, 'Quantity', { anchor: 'middle' });
  t(282.1, 240.4, 13.7, 'Rate', { anchor: 'middle' });
  t(352.25, 240.4, 13.7, 'Amount', { anchor: 'middle' });
  const qty = Number(bill.qty) || 0;
  t(21.6, 263.9, 13.7, PRODUCT_NAME[bill.product] || PRODUCT_NAME.HSD, { bold: true, clip: 'col1' });
  t(213.85, 264.8, 12.7, `${qty.toFixed(2)} LTR`, { bold: true, anchor: 'middle' });
  t(302.1, 264.8, 12.7, (Number(bill.rate) || 0).toFixed(2), { bold: true, anchor: 'end' });
  t(397.1, 264.8, 12.7, inr2(bill.amount), { bold: true, anchor: 'end' });

  t(139.15, 394.3, 13.7, 'Thank You', { bold: true, anchor: 'middle' });
  t(301.7, 394.3, 13.7, 'Total', { bold: true, anchor: 'end' });
  t(397.1, 395.2, 12.7, `₹ ${inr2(bill.amount)}`, { bold: true, anchor: 'end' });

  if (stamp) out.push(`<image href="${esc(stamp)}" x="300.86" y="428.26" width="83.3" height="65.66" preserveAspectRatio="none"/>`);
  t(21.6, 497.2, 13.7, "Customer's Sign.", { bold: true });
  t(396.5, 497.2, 13.7, 'Sign.of Salesman', { bold: true, anchor: 'end' });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs><clipPath id="edge"><rect x="0" y="0" width="398.8" height="${H}"/></clipPath><clipPath id="col1"><rect x="0" y="0" width="166.6" height="${H}"/></clipPath></defs>
<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
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
