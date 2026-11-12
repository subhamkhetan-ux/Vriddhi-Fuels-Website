// Register screen pieces (HTML strings) — the Daily Stock Register laid out
// like the paper book, and the Stock Register, from register.js's
// productMonth(). No DOM, no network.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const L2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const litres = (n) => (n == null ? '' : L2.format(n));
const dip = (n) => (n == null ? '' : Number(n).toFixed(1));
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (m) => `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const SRC = { chart: 'the DIP Chart', log: 'the DIP Chart\'s Log', stock: 'the Stock Register', mac: 'the Stock Register\'s Macro Log' };
export const srcName = (s) => SRC[s] || s;
const flag = (title) => `<i class="reg-flag" title="${esc(title)}" aria-label="${esc(title)}">!</i>`;

// ---- the paper books ---------------------------------------------------------
// Laid out like the printed DSR register the figures are copied into: white
// ruled paper, black print, entries in blue ink, written as they are by hand
// (whole litres and meter readings, sales to the paisa).
const PAPER = {
  HSD: { hindi: 'उत्पाद : हाई स्पीड डीजल', title: 'PRODUCT : HSD (HIGH SPEED DIESEL)', tanks: 4, pumps: 8, sheet: 'DIESEL' },
  XG: { hindi: 'उत्पाद : एक्स्ट्रा ग्रीन', title: 'PRODUCT - XTRAGREEN', tanks: 4, pumps: 5, sheet: 'XTRAGREEN' },
  MS: { hindi: 'उत्पाद : पेट्रोल', title: 'PRODUCT - MS (PETROL)', tanks: 3, pumps: 6, sheet: 'PETROL', remarks: true },
};
const whole = (n) => (n == null ? '' : String(Math.trunc(Number(n) + 1e-9)));       // 36052.55 -> 36052, as written
const paisa = (n) => (n == null ? '' : Number(n).toFixed(2));
const testing = (n) => (n == null ? '' : (Number.isInteger(n) ? String(n) : Number(n).toFixed(2)));
const paperMonth = (m) => `${MON[+m.slice(5, 7) - 1].toUpperCase()}-${m.slice(0, 4)}`;
const ink = (v, cls = '') => `<td class="ink${cls ? ` ${cls}` : ''}">${v}</td>`;

function paperHead(pm, title) {
  const pp = PAPER[pm.key];
  return `<div class="paper-head"><span class="hindi">${esc(pp.hindi)}</span><h2>${esc(title || pp.title)}</h2>
    <span class="month">MONTH <u>${esc(paperMonth(pm.month))}</u></span></div>`;
}

// The Daily Stock Register page of one product and month
export function dsrTableHtml(pm, { today } = {}) {
  const pp = PAPER[pm.key];
  const pumps = Math.max(pp.pumps, pm.nozzles.length);
  const tanks = Math.max(pp.tanks, pm.product.tanks);
  const n = pm.rows.length;
  const head = `<thead>
    <tr><th rowspan="3" class="date">DATE</th>
      ${Array.from({ length: tanks }, (_, i) => `<th colspan="2" class="tank">TANK ${i + 1}</th>`).join('')}
      <th rowspan="3" class="w">OPENING<br>STOCK</th><th rowspan="3" class="w">RECEIPT</th><th rowspan="3" class="w">TOTAL<br>STOCK</th>
      <th colspan="${pumps}">OPENING : METER READING</th>
      <th rowspan="3" class="w">TESTING</th><th rowspan="3" class="w">SALES</th><th rowspan="3" class="w cum">COMMUTATIVE<br>SALES</th>
      ${pp.remarks ? '<th rowspan="3" class="gap"></th><th rowspan="3" class="remarks">REMARKS</th>' : ''}</tr>
    <tr>${Array.from({ length: tanks }, () => '<th rowspan="2" class="v">DIP</th><th rowspan="2" class="v small">WATER<br>DIP</th>').join('')}
      <th colspan="${pumps}">PUMPS</th></tr>
    <tr>${Array.from({ length: pumps }, (_, i) => `<th class="pump${pm.nozzles[i] ? '' : ' unused'}"${pm.nozzles[i] ? ` title="${esc(`${pm.nozzles[i].machine} · ${pm.nozzles[i].label}`)}"` : ''}>${i + 1}</th>`).join('')}</tr></thead>`;
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    const r = d <= n ? pm.rows[d - 1] : null;
    const cells = [];
    for (let t = 0; t < tanks; t++) {
      const v = r && t < pm.product.tanks ? r.dips[t] : null;
      const unknown = r && r.stock != null && t < pm.product.tanks && v == null;
      cells.push(unknown ? '<td class="ink q" title="This tank\'s dip isn\'t known for this day: the DIP Chart only kept the total.">?</td>' : ink(v == null ? '' : dip(v)));
      cells.push('<td></td>');
    }
    const flagged = r && r.differs != null ? flag(`The Stock Register has ${whole(r.differs)} for this morning; this is ${srcName(r.stockSrc)}'s.`) : '';
    cells.push(ink(r ? `${whole(r.stock)}${flagged}` : ''));
    cells.push(ink(r && r.receipt ? whole(r.receipt) : r && r.stock != null ? '<span class="nil">×</span>' : ''));
    cells.push(ink(r ? whole(r.total) : ''));
    for (let i = 0; i < pumps; i++) cells.push(ink(r && r.meters && i < r.meters.length ? whole(r.meters[i]) : '', 'm'));
    cells.push(ink(r ? testing(r.test) : ''));
    cells.push(ink(r ? paisa(r.sale) : ''));
    cells.push(ink(r ? paisa(r.cum) : ''));
    if (pp.remarks) cells.push('<td class="gap"></td><td class="remarks"></td>');
    rows.push(`<tr class="${r && r.date === today ? 'today' : ''}"><th class="date">${d}</th>${cells.join('')}</tr>`);
  }
  const t = pm.totals;
  const lead = tanks * 2;
  const tail = (cells) => `${cells}${pp.remarks ? '<td class="gap"></td><td class="remarks"></td>' : ''}`;
  rows.push(`<tr class="tot"><th class="date">TOTAL</th><td colspan="${lead + 1}"></td>${ink(t.receipt ? whole(t.receipt) : '')}<td></td>
    ${'<td></td>'.repeat(pumps)}${tail(`${ink(t.test ? testing(Math.round(t.test * 100) / 100) : '')}${ink(t.sale ? paisa(t.sale) : '')}<td></td>`)}</tr>`);
  rows.push(`<tr class="tot"><th class="date ly">LAST<br>YEAR<br>SALES</th><td colspan="${lead + 3 + pumps + 3}"></td>${pp.remarks ? '<td class="gap"></td><td class="remarks"></td>' : ''}</tr>`);
  return `<div class="paper-scroll"><div class="paper">${paperHead(pm)}
    <table class="paper-t">${head}<tbody>${rows.join('')}</tbody></table></div></div>`;
}

// The Stock Register page, as the workbook's sheet: S.No, Opening Stock,
// Receipts, Total, Sale, Actual Tank Stock, Shortage, Variation of Shortage
// and, beside it, the opening / current shortage and today's tank stock
export function stockTableHtml(pm, { today } = {}) {
  const pp = PAPER[pm.key];
  const n = pm.rows.length;
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    const r = d <= n ? pm.rows[d - 1] : null;
    const alt = r && r.actualAlt != null ? flag(`The DIP Chart has ${paisa(r.actualAlt)} for the next morning.`) : '';
    const via = r && r.actual != null && r.actualSrc !== 'stock' ? '<sup title="Not in the Stock Register yet: from the DIP Chart">*</sup>' : '';
    rows.push(`<tr class="${r && r.date === today ? 'today' : ''}"><th class="date">${d}</th>
      ${ink(r ? paisa(r.bookOpen) : '')}${ink(r && r.receipt ? paisa(r.receipt) : r && r.bookOpen != null ? '0.00' : '')}${ink(r ? paisa(r.bookTotal) : '')}
      ${ink(r ? paisa(r.sale) : '')}${ink(r && r.actual != null ? `${paisa(r.actual)}${via}${alt}` : '')}${ink(r ? paisa(r.shortage) : '')}${ink(r ? paisa(r.variation) : '')}</tr>`);
  }
  const t = pm.totals;
  rows.push(`<tr class="tot"><th class="date">G.TOTAL</th><td></td>${ink(paisa(t.receipt))}<td></td>${ink(paisa(t.sale))}<td></td><td></td>${ink(paisa(t.variation))}</tr>`);
  const last = [...pm.rows].reverse().find((r) => r.actual != null);
  const side = `<table class="paper-t side"><tbody>
    <tr><th>Opening Shortage</th>${ink(paisa(pm.openShortage))}</tr>
    <tr><th>Todays Tank Stock</th>${ink(last ? paisa(last.actual) : '')}</tr>
    <tr><th>Current Shortage</th>${ink(paisa(pm.shortageNow))}</tr>
    ${pm.testAdjust != null ? `<tr><th>Testing Adjustment</th>${ink(paisa(pm.testAdjust))}</tr>` : ''}</tbody></table>`;
  return `<div class="paper-scroll"><div class="paper stock">
    <div class="paper-head"><span class="hindi">${esc(pp.hindi)}</span><h2>${esc(`${pp.sheet} MONTH OF ${paperMonth(pm.month).replace('-', ' ')}`)}</h2><span class="month">STOCK REGISTER</span></div>
    <div class="paper-row"><table class="paper-t"><thead><tr><th class="date">S.No</th><th class="w">Opening Stock</th><th class="w">Receipts</th><th class="w">Total</th><th class="w">Sale</th>
      <th class="w">Actual Tank Stock</th><th class="w">Shortage</th><th class="w">Variation of Shortage</th></tr></thead><tbody>${rows.join('')}</tbody></table>
    ${side}</div></div></div>`;
}

// "This morning": each product's stock and dips, and its shortage
export function morningHtml(latest, shortages = {}) {
  if (!latest) return '';
  return `<div class="kpis reg-kpis">${latest.products.map((x) => {
    const p = x.product;
    const dips = x.tanks ? x.dips.map((d, i) => `Tank ${i + 1} <b>${dip(d)}</b> cm`).join(' · ')
      : x.dips.length && x.dips[0] != null ? `Dip <b>${dip(x.dips[0])}</b> cm` : (p.tanks === 2 && x.stock != null ? '<span class="faint">dips per tank not known</span>' : '');
    const sh = shortages[p.key];
    return `<div class="kpi reg-kpi k-${p.key.toLowerCase()}"><span class="lbl">${esc(p.short)}</span>
      <span class="val">${x.stock == null ? '—' : `${litres(x.stock)}<small>&nbsp;L</small>`}</span>
      <span class="sub">${dips}</span>
      ${sh && sh.value != null ? `<span class="sub">Shortage <b>${litres(sh.value)}</b> L${sh.day ? ` <span class="faint">(to ${sh.day})</span>` : ''}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

