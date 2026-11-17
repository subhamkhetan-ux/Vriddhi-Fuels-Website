// The bank details poster (Quotes → Bank Details): an A4 page to print and
// stick by the dispensers, so anyone can pay by NEFT / RTGS / IMPS. The
// details are kept in the app's settings (bank_details) and can be changed
// any time; the page is drawn from whatever is saved or typed.
// Pure: returns an SVG string (the logo as a data: URL, the font as
// @font-face CSS passed in); render.js pdfFromSvgs turns it into the PDF.

import { textWidth } from './share-svg.js';

// the first details (the current account the firm is paid into)
export const BANK_DEFAULT = {
  name: 'VRIDDHI FUELS',
  type: 'Current Account',
  account: '046805004716',
  ifsc: 'ICIC0000468',
  bank: 'ICICI BANK Ltd',
  branch: 'Jharsuguda Main Branch, Kalimandir Road',
  note: 'After paying, please show the payment message to the cashier.',
};
export const BANK_FIELDS = [
  ['name', 'Account name'], ['type', 'Account type'], ['account', 'Account no.'], ['ifsc', 'IFSC code'],
  ['bank', 'Bank name'], ['branch', 'Branch'], ['note', 'Note at the bottom'],
];

// the details tidied: spaces trimmed, the account number and IFSC without
// spaces, IFSC in capitals
export function cleanBank(d = {}) {
  const t = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  return {
    name: t(d.name), type: t(d.type), account: t(d.account).replace(/[\s-]+/g, ''),
    ifsc: t(d.ifsc).replace(/\s+/g, '').toUpperCase(), bank: t(d.bank), branch: t(d.branch), note: t(d.note),
  };
}

// what's wrong with them (an empty list when they're fine to print)
export function bankProblems(d) {
  const out = [];
  if (!d.account) out.push('Type the account number.');
  else if (!/^\d{6,20}$/.test(d.account)) out.push('The account number should be 6–20 digits.');
  if (!d.ifsc) out.push('Type the IFSC code.');
  else if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(d.ifsc)) out.push('An IFSC code is 11 characters: 4 letters, a 0, then 6 letters or digits (like ICIC0000468).');
  if (!d.bank) out.push('Type the bank name.');
  return out;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SANS = 'Plus Jakarta Sans, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Roboto, Arial, sans-serif';
const INK = '#111111';
const MUTED = '#5c5550';
const ORANGE = '#f4511e';
export const BOARD_SIZE = { width: 1240, height: 1754 };       // A4's shape

// Sora runs wider than share-svg's estimate at these sizes: a margin so a
// fitted line never runs off the page
const wide = (text, size, weight, spacing = 0) => textWidth(text, size, weight) * 1.12 + spacing * String(text).length;
// the largest size (≤ max) at which text fits the width
function sizeToFit(text, width, max, weight = 800, min = 24, spacing = 0) {
  let s = max;
  while (s > min && wide(text, s, weight, spacing) > width) s -= 2;
  return s;
}
// text into lines no wider than width
function wrap(text, width, size, weight = 400) {
  const lines = [];
  let cur = '';
  for (const w of String(text).split(' ')) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && wide(next, size, weight) > width) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
const T = (x, y, text, { size, weight = 400, fill = INK, anchor = 'start', spacing } = {}) => `<text x="${Math.round(x)}" y="${Math.round(y)}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(text)}</text>`;

export const groupDigits = (s) => String(s).replace(/(\d{4})(?=\d)/g, '$1 ');

export function bankBoardSvg(details, { images = {}, fontCss = '' } = {}) {
  const d = cleanBank(details);
  const { width: w, height: h } = BOARD_SIZE;
  const pad = 90;
  const inner = w - 2 * pad;
  let out = '';
  // the band: logo, firm name, how to pay
  out += `<rect x="0" y="0" width="${w}" height="260" fill="url(#band)"/>`;
  out += `<rect x="${pad}" y="55" width="150" height="150" rx="32" fill="#fff"/>`;
  out += images.logo
    ? `<clipPath id="lg"><rect x="${pad}" y="55" width="150" height="150" rx="32"/></clipPath><image href="${esc(images.logo)}" x="${pad}" y="55" width="150" height="150" preserveAspectRatio="xMidYMid slice" clip-path="url(#lg)"/>`
    : T(pad + 75, 152, 'VF', { size: 58, weight: 800, fill: ORANGE, anchor: 'middle' });
  out += T(pad + 190, 132, 'VRIDDHI FUELS', { size: 72, weight: 800, fill: '#fff', spacing: 2 });
  out += T(pad + 190, 188, 'Pay by bank transfer  ·  NEFT  ·  RTGS  ·  IMPS', { size: 30, weight: 600, fill: '#fff' });
  out += T(w / 2, 372, 'BANK DETAILS', { size: 76, weight: 800, anchor: 'middle', spacing: 6 });
  out += `<rect x="${w / 2 - 90}" y="398" width="180" height="8" rx="4" fill="${ORANGE}"/>`;
  let y = 490;
  const rule = () => { out += `<rect x="${pad}" y="${y}" width="${inner}" height="2" fill="#000" fill-opacity="0.12"/>`; y += 66; };

  // a labelled line: the label small above, the value large (wrapped when
  // even the smallest size is too wide)
  const line = (label, value, { max = 64, min = 40, weight = 700, spacing = 0 } = {}) => {
    if (!value) return;
    out += T(pad, y, label.toUpperCase(), { size: 26, weight: 700, fill: MUTED, spacing: 3 });
    const size = sizeToFit(value, inner, max, weight, min, spacing);
    const lines = wide(value, size, weight, spacing) > inner ? wrap(value, inner, size, weight) : [value];
    y += 12;
    for (const l of lines) {
      y += size * 1.12;
      out += T(pad, y, l, { size, weight, spacing: spacing || undefined });
    }
    y += 34;
    rule();
  };
  line('Account name', d.name, { max: 64, weight: 800 });

  // the account number: the biggest thing on the page, in a box
  if (d.account) {
    const shown = groupDigits(d.account);
    const size = sizeToFit(shown, inner - 80, 116, 800, 56, 3);
    const bh = size + 120;
    out += `<rect x="${pad}" y="${y - 16}" width="${inner}" height="${bh}" rx="28" fill="${ORANGE}" fill-opacity="0.07" stroke="${ORANGE}" stroke-width="5"/>`;
    out += T(pad + 40, y + 36, `${d.type ? `${d.type}  ·  ` : ''}Account No.`.toUpperCase(), { size: 26, weight: 700, fill: ORANGE, spacing: 3 });
    out += T(pad + 40, y + 50 + size * 0.95, shown, { size, weight: 800, spacing: 3 });
    y += bh + 50;
  }
  line('IFSC code', d.ifsc, { max: 96, min: 60, weight: 800, spacing: 6 });
  line('Bank name', d.bank, { max: 60 });
  line('Branch', d.branch, { max: 46, min: 36, weight: 600 });

  // the note, then a reminder at the foot
  const noteLines = d.note ? wrap(d.note, inner - 80, 32, 600) : [];
  if (noteLines.length) {
    const nh = 50 + noteLines.length * 44;
    out += `<rect x="${pad}" y="${y - 30}" width="${inner}" height="${nh}" rx="22" fill="#000" fill-opacity="0.05"/>`;
    noteLines.forEach((l, i) => { out += T(w / 2, y + 16 + i * 44, l, { size: 32, weight: 600, anchor: 'middle' }); });
  }
  out += T(w / 2, h - 60, 'Check the account name and number before you pay.', { size: 24, fill: MUTED, anchor: 'middle' });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><defs>
<style>${fontCss || ''} text { font-family: ${SANS.replaceAll('&quot;', '"')}; font-variant-numeric: tabular-nums; }</style>
<linearGradient id="band" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4511e"/><stop offset=".55" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ff9e42"/></linearGradient>
</defs><rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/>${out}</svg>`;
}
