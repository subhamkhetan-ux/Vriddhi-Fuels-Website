// The price letter ("TO WHOMSOEVER IT MAY CONCERN" — the RSP of a product at
// our outlet on a day, or over a period), in the format of the Word file it
// was made from (assets/price-letter.docx: the same letterhead header, font
// sizes, bold parts and signature block).
//   rupeeWords()    100.74 -> "Rupees One Hundred and Paise Seventy-Four Only"
//   priceRanges()   each day's price -> runs of days at one price
//   letterText()    the certificate's sentence, in parts (bold or not), and
//                   for a period with more than one price, a table
//   letterDocx()    the Word file: the template with the sentence (and table)
//                   put in, and the stamp's picture
//   letterSvg()     the same letter as an A4 page (for the PDF and the screen)
// Pure apart from letterDocx (needs JSZip, given).

export const LETTER_PRODUCTS = {
  HSD: { name: 'High Speed Diesel', short: 'HSD' },
  MS: { name: 'Motor Spirit', short: 'MS' },
  XG: { name: 'XtraGreen Diesel', short: 'XG' },
};
export const OUTLET = 'M/s Vriddhi Fuels, Dealer – Indian Oil Corporation Limited, At Kherual, Post Badmal, Jharsuguda, Odisha – 768202';

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
// 0..99: "Seventy-Four" (hyphenated, as in the letter)
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);
// whole rupees the Indian way: crore, lakh, thousand, hundred
function whole(n) {
  if (!n) return 'Zero';
  const parts = [];
  const cr = Math.floor(n / 1e7);
  const lk = Math.floor((n % 1e7) / 1e5);
  const th = Math.floor((n % 1e5) / 1e3);
  const hd = Math.floor((n % 1e3) / 100);
  const rs = n % 100;
  if (cr) parts.push(`${whole(cr)} Crore`);
  if (lk) parts.push(`${two(lk)} Lakh`);
  if (th) parts.push(`${two(th)} Thousand`);
  if (hd) parts.push(`${ONES[hd]} Hundred`);
  if (rs) parts.push(two(rs));
  return parts.join(' ');
}
// 100.74 -> "Rupees One Hundred and Paise Seventy-Four Only"
export function rupeeWords(v) {
  const paise = Math.round(Number(v) * 100);
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${whole(r)}${p ? ` and Paise ${two(p)}` : ''} Only`;
}
export const price2 = (v) => Number(v).toFixed(2);
export const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

// days: [{date, price}] in order -> [{from, to, price}] (price null where none)
export function priceRanges(days) {
  const out = [];
  for (const d of days) {
    const p = d.price == null || d.price === '' || !Number.isFinite(Number(d.price)) ? null : Math.round(Number(d.price) * 100) / 100;
    const last = out[out.length - 1];
    if (last && last.price === p) last.to = d.date;
    else out.push({ from: d.date, to: d.date, price: p });
  }
  return out;
}

// The certificate's sentence: [{t, b}] (b = bold, as in the Word file), and
// rows for a table when a period had more than one price.
//   product: HSD / MS / XG; from, to: ISO dates (to = from for one day);
//   ranges: priceRanges() of the days (every price filled in)
export function letterText({ product = 'HSD', from, to, ranges }) {
  const P = LETTER_PRODUCTS[product] || LETTER_PRODUCTS.HSD;
  const parts = [
    { t: 'This is to certify and confirm that the Retail Selling Price (' }, { t: 'RSP', b: true }, { t: `) of ${P.name} (` },
    { t: P.short, b: true }, { t: `) at our retail outlet, ${OUTLET}, ` },
  ];
  const one = !to || to === from;
  if (one) parts.push({ t: 'on ' }, { t: dmy(from), b: true });
  else parts.push({ t: 'during the period from ' }, { t: dmy(from), b: true }, { t: ' to ' }, { t: dmy(to), b: true });
  const prices = [...new Set(ranges.map((r) => r.price))];
  let table = null;
  if (prices.length === 1) {
    parts.push({ t: one ? ' was ' : ' was ' }, { t: `₹ ${price2(prices[0])} (${rupeeWords(prices[0])}) per Litre.`, b: true });
  } else {
    parts.push({ t: ' was as under:' });
    table = ranges.map((r) => ({ period: r.from === r.to ? dmy(r.from) : `${dmy(r.from)} to ${dmy(r.to)}`, price: `₹ ${price2(r.price)}`, words: rupeeWords(r.price) }));
  }
  const closing = one
    ? 'This certificate is issued for reference and record purposes, on the request of the concerned party.'
    : 'This certificate is issued for reference and record purposes, on the request of the concerned party. The price shown is the Retail Selling Price in force at our outlet on each day of the period.';
  return { parts, table, closing };
}

// ---- the Word file ---------------------------------------------------------------------
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RPR = (b) => `<w:rPr>${b ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="en-US"/></w:rPr>`;
const run = (t, b) => `<w:r>${RPR(b)}<w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
const para = (runs, { jc = '' } = {}) => `<w:p><w:pPr>${jc ? `<w:jc w:val="${jc}"/>` : ''}<w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="en-US"/></w:rPr></w:pPr>${runs}</w:p>`;
const EMPTY = para('');
function tableXml(rows) {
  const cell = (t, w, { b = false, jc = 'left' } = {}) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr>${run(t, b)}</w:p></w:tc>`;
  const border = '<w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="000000"/>';
  const W = [3000, 2000, 5400];
  const head = `<w:tr>${cell('Period', W[0], { b: true })}${cell('RSP (₹/Litre)', W[1], { b: true, jc: 'right' })}${cell('In words', W[2], { b: true })}</w:tr>`;
  const body = rows.map((r) => `<w:tr>${cell(r.period, W[0])}${cell(r.price, W[1], { b: true, jc: 'right' })}${cell(r.words, W[2])}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${W.reduce((a, x) => a + x, 0)}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${W.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl>`;
}
// template: the .docx (ArrayBuffer); stamp: PNG bytes (Uint8Array) or null
export async function letterDocx(JSZip, template, text, stamp = null) {
  const zip = await JSZip.loadAsync(template);
  let doc = await zip.file('word/document.xml').async('string');
  const paras = doc.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
  const find = (re) => paras.find((p) => re.test(p.replace(/<[^>]+>/g, '')));
  const main = find(/This is to certify/);
  const closing = find(/This certificate is issued/);
  if (!main) throw new Error('The price letter template has no "This is to certify" paragraph.');
  let body = para(text.parts.map((p) => run(p.t, p.b)).join(''));
  if (text.table) body += EMPTY + tableXml(text.table);
  doc = doc.replace(main, body);
  if (closing) doc = doc.replace(closing, para(run(text.closing)));
  if (stamp) zip.file('word/media/image1.png', stamp);
  else doc = doc.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/, '');                // no stamp: the signature block without it
  zip.file('word/document.xml', doc);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

// ---- the same letter as an A4 page (points) ---------------------------------------------
// images: {letterhead, stamp} as URLs; measure(text, {b, s}) -> width in points
const PAGE = { width: 595.3, height: 841.9 };
const FONT = "'Times New Roman', Tinos, Times, serif";
const svgEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function letterSvg(text, { images = {}, measure, fontCss = '' } = {}) {
  const M = 36;                                              // 0.5 inch margins, as the Word file
  const W = PAGE.width - 2 * M;
  const S = 14;                                              // 14 pt text
  const LH = S * 1.16;
  let y = 20;
  let out = '';
  if (images.letterhead) {
    const h = W * (303 / 979);
    out += `<image href="${svgEsc(images.letterhead)}" x="${M}" y="${y}" width="${W}" height="${h.toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`;
    y += h + 30;
  } else y += 140;
  out += `<text x="${PAGE.width / 2}" y="${y}" text-anchor="middle" font-size="18" font-weight="bold" text-decoration="underline">TO WHOMSOEVER IT MAY CONCERN</text>`;
  const tw = measure('TO WHOMSOEVER IT MAY CONCERN', { b: true, s: 18 });
  out += `<line x1="${(PAGE.width - tw) / 2}" x2="${(PAGE.width + tw) / 2}" y1="${y + 2.5}" y2="${y + 2.5}" stroke="#000" stroke-width="1"/>`;
  y += 52;
  // the sentence, wrapped word by word, bold where it's bold; pieces with no
  // space between them ("(" + "HSD" + ")") stay together
  const toks = text.parts.flatMap((p) => p.t.split(/(\s+)/).filter((w) => w !== '').map((w) => ({ w, b: Boolean(p.b) })));
  const units = [];
  for (const t of toks) {
    const sp = /^\s+$/.test(t.w);
    const last = units[units.length - 1];
    if (!sp && last && !last.sp) last.parts.push(t);
    else units.push({ sp, parts: [t] });
  }
  const lines = [[]];
  let x = 0;
  for (const u of units) {
    const wd = u.parts.reduce((a, t) => a + measure(t.w, { b: t.b, s: S }), 0);
    if (u.sp) { if (x) { lines[lines.length - 1].push(...u.parts); x += wd; } continue; }
    if (x + wd > W * 0.97 && x) { lines.push([]); x = 0; }             // a little room: the PDF's font may run wider
    lines[lines.length - 1].push(...u.parts);
    x += wd;
  }
  for (const ln of lines) {
    // the line flows on its own (the words' widths in the PDF's font may differ a little from the measure)
    const shown = ln[ln.length - 1] && /^\s+$/.test(ln[ln.length - 1].w) ? ln.slice(0, -1) : ln;
    out += `<text x="${M}" y="${y.toFixed(1)}" font-size="${S}" xml:space="preserve">${shown.map((t) => `<tspan${t.b ? ' font-weight="bold"' : ''}>${svgEsc(t.w)}</tspan>`).join('')}</text>`;
    y += LH;
  }
  if (text.table) {
    y += 10;
    const cw = [W * 0.31, W * 0.17, W * 0.52];
    const rowH = 22;
    const rows = [{ period: 'Period', price: 'RSP (₹/Litre)', words: 'In words', head: true }, ...text.table];
    rows.forEach((r) => {
      let cx = M;
      [r.period, r.price, r.words].forEach((v, i) => {
        out += `<rect x="${cx.toFixed(1)}" y="${y.toFixed(1)}" width="${cw[i].toFixed(1)}" height="${rowH}" fill="none" stroke="#000" stroke-width="0.7"/>`;
        const fs = i === 2 && !r.head ? 10.5 : 12;
        out += `<text x="${(i === 1 ? cx + cw[i] - 5 : cx + 5).toFixed(1)}" y="${(y + 15).toFixed(1)}" font-size="${fs}"${r.head || i === 1 ? ' font-weight="bold"' : ''}${i === 1 ? ' text-anchor="end"' : ''}>${svgEsc(v)}</text>`;
        cx += cw[i];
      });
      y += rowH;
    });
    y += 6;
  }
  y += LH;
  const closing = text.closing.split(/(\s+)/);
  let line = '';
  for (const w of closing) {
    if (measure(line + w, { s: S }) > W && line.trim()) { out += `<text x="${M}" y="${y.toFixed(1)}" font-size="${S}">${svgEsc(line.trim())}</text>`; y += LH; line = w.trimStart(); } else line += w;
  }
  if (line.trim()) { out += `<text x="${M}" y="${y.toFixed(1)}" font-size="${S}">${svgEsc(line.trim())}</text>`; y += LH; }
  y += LH;
  out += `<text x="${M}" y="${y.toFixed(1)}" font-size="${S}">Thanking You.</text>`;
  y += LH * 2;
  out += `<text x="${M}" y="${y.toFixed(1)}" font-size="${S}">Yours faithfully,</text>`;
  y += LH * 3;
  out += `<text x="${M}" y="${y.toFixed(1)}" font-size="${S}" font-weight="bold">For Vriddhi Fuels</text>`;
  if (images.stamp) out += `<image href="${svgEsc(images.stamp)}" x="${M - 2}" y="${(y + 8).toFixed(1)}" width="150" height="60" preserveAspectRatio="xMinYMid meet"/>`;
  y += 92;
  out += `<text x="${M}" y="${y.toFixed(1)}" font-size="${S}" font-weight="bold">Authorised Signatory</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.width} ${PAGE.height}" width="${PAGE.width}" height="${PAGE.height}" font-family="${FONT}">${fontCss ? `<style>${fontCss}</style>` : ''}<rect width="100%" height="100%" fill="#fff"/>${out}</svg>`;
}
export { PAGE as LETTER_PAGE };
