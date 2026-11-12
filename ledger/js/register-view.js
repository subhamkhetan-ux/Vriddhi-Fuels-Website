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

// The Daily Stock Register page of one product and month. latest: this
// morning's day (its line is highlighted) and, on the day before, the receipt,
// testing, sale and cumulative those readings complete; edit: dips as inputs.
export function dsrTableHtml(pm, { latest = null, prev = null, edit = false } = {}) {
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
    const canEdit = edit && r && (r.stock != null || r.meters || (latest && d <= latest));
    for (let t = 0; t < tanks; t++) {
      const v = r && t < pm.product.tanks ? r.dips[t] : null;
      const unknown = r && r.stock != null && t < pm.product.tanks && v == null;
      if (canEdit && t < pm.product.tanks) {
        cells.push(`<td class="ink edit"><input class="dip-in" inputmode="decimal" data-dip-day="${d}" data-dip-tank="${t}" value="${v == null ? '' : dip(v)}" aria-label="Tank ${t + 1} dip, ${d}"></td>`);
      } else if (unknown) {
        cells.push('<td class="ink q" title="This tank\'s dip isn\'t known for this day: the DIP Chart only kept the total. Edit dips to write it.">?</td>');
      } else {
        const off = r && r.dipOff != null && t === 0 ? flag(`These dips on the DIP Chart come to ${whole(r.stock + r.dipOff)} L, not the ${whole(r.stock)} L of this morning's stock.`) : '';
        cells.push(ink(v == null ? '' : `${dip(v)}${off}`, r && r.dipTyped && v != null ? 'typed' : ''));
      }
      cells.push('<td></td>');
    }
    const flagged = r && r.differs != null ? flag(`The Stock Register has ${whole(r.differs)} for this morning; this is ${srcName(r.stockSrc)}'s.`) : '';
    const hl = d === prev ? 'hl' : '';                     // the day before: what this morning's readings complete
    // this morning's receipt and total stock aren't known yet (what comes in today): not marked
    const open = d === latest ? 'nohl' : hl;
    cells.push(ink(r ? `${whole(r.stock)}${flagged}` : ''));
    cells.push(ink(r && r.receipt ? whole(r.receipt) : r && r.stock != null && d !== latest ? '<span class="nil">×</span>' : '', open));
    cells.push(ink(r ? whole(r.total) : '', open));
    for (let i = 0; i < pumps; i++) cells.push(ink(r && r.meters && i < r.meters.length ? whole(r.meters[i]) : '', 'm'));
    cells.push(ink(r ? testing(r.test) : '', hl));
    cells.push(ink(r ? paisa(r.sale) : '', hl));
    cells.push(ink(r ? paisa(r.cum) : '', hl));
    if (pp.remarks) cells.push('<td class="gap"></td><td class="remarks"></td>');
    rows.push(`<tr class="${d === latest ? 'today' : ''}"><th class="date">${d}</th>${cells.join('')}</tr>`);
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
// adj: testingAdjust()'s month for this product (or null)
export function stockTableHtml(pm, { latest = null, adj = null } = {}) {
  const pp = PAPER[pm.key];
  const n = pm.rows.length;
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    const r = d <= n ? pm.rows[d - 1] : null;
    const alt = r && r.actualAlt != null ? flag(`The DIP Chart has ${paisa(r.actualAlt)} for the next morning.`) : '';
    const via = r && r.actual != null && r.actualSrc !== 'stock' ? '<sup title="Not in the Stock Register yet: from the DIP Chart">*</sup>' : '';
    rows.push(`<tr class="${latest && d === latest - 1 ? 'today' : ''}"><th class="date">${d}</th>
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
    ${adj ? `<tr><th>Testing Adj. (opening)</th>${ink(adj.open == null ? '' : paisa(adj.open))}</tr>
    <tr><th>Testing Adj. (this month)</th>${ink(paisa(adj.added))}</tr>
    <tr><th>Testing Adjustment</th>${ink(paisa(adj.closing))}</tr>` : pm.testAdjust != null ? `<tr><th>Testing Adjustment</th>${ink(paisa(pm.testAdjust))}</tr>` : ''}</tbody></table>`;
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

// The testing adjustment of one product and month (app style: it's worked
// here, not copied): opening, each day's DSR testing against the actual,
// closing; the shortage on the books and without the adjustment.
const OPEN_SRC = { typed: 'typed here', carried: 'last month\'s closing', sheet: 'the Stock Register\'s "Testing Adjustment"', none: 'not set — type it' };
export function adjustHtml(adj, pm, { prevMonth = null, nextMonth = null } = {}) {
  const p = pm.product;
  const net = pm.shortageNow != null ? Math.round((pm.shortageNow - adj.closing) * 100) / 100 : null;
  const rows = adj.days.filter((x) => x.dsr != null);
  const two = (n) => (n == null ? '' : L2.format(n));
  return `<div class="row-between"><h2>Testing adjustment <span class="muted">· ${esc(p.short)} · ${esc(monthLabel(pm.month))}</span></h2></div>
    <p class="muted small">The DSR's testing against what's really tested — a day's actual testing is as typed, else the day before's (to start: HSD 30, MS 20, XtraGreen 10 L). The difference stays in the tank on the books, adding to the shortage; it's carried from month to month.</p>
    <div class="kpis">
      <div class="kpi"><span class="lbl">Opening</span>
        <span class="val"><input class="adj-open" id="adj-open" inputmode="decimal" value="${adj.openSrc === 'typed' ? esc(String(adj.open)) : ''}" placeholder="${adj.open == null ? '0.00' : esc(adj.open.toFixed(2))}" aria-label="Opening testing adjustment"></span>
        <span class="sub">${esc(OPEN_SRC[adj.openSrc])}${adj.openSrc === 'carried' && prevMonth ? ` (${esc(monthLabel(prevMonth))})` : ''}</span></div>
      <div class="kpi"><span class="lbl">Added this month</span><span class="val">${adj.added >= 0 ? '+' : ''}${two(adj.added)}</span>
        <span class="sub">DSR ${two(adj.dsrTotal)} − actual ${two(adj.actualTotal)} · ${adj.testDays} day${adj.testDays === 1 ? '' : 's'}</span></div>
      <div class="kpi hero"><span class="lbl">Closing</span><span class="val">${two(adj.closing)}<small>&nbsp;L</small></span>
        <span class="sub">${nextMonth ? `${esc(monthLabel(nextMonth))}'s opening` : 'goes to next month\'s opening'}</span></div>
      <div class="kpi"><span class="lbl">Shortage on the books</span><span class="val">${two(pm.shortageNow)}</span>
        <span class="sub">without the adjustment: <b>${two(net)}</b> L</span></div>
    </div>
    <div class="table-wrap"><table class="compact adj">
      <thead><tr><th>Date</th><th class="r">DSR testing</th><th class="r">Actual testing</th><th class="r">Adjustment</th><th class="r">Running</th></tr></thead>
      <tbody>${rows.map((x) => `<tr><td class="nowrap">${x.day} ${esc(monthLabel(pm.month).slice(0, 3))}</td><td class="r">${two(x.dsr)}</td>
        <td class="r"><input class="adj-in" inputmode="decimal" data-adj-day="${x.day}" value="${x.actualSrc === 'typed' ? esc(String(x.actual)) : ''}" placeholder="${x.actual == null ? '' : esc(String(x.actual))}" aria-label="Actual testing, ${x.day}">
          ${x.actualSrc === 'carried' ? '<small class="faint">as before</small>' : x.actualSrc === 'default' ? '<small class="faint">standard</small>' : ''}</td>
        <td class="r">${x.adj >= 0 ? '+' : ''}${two(x.adj)}</td><td class="r"><b>${two(x.running)}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><th>Total</th><td class="r">${two(adj.dsrTotal)}</td><td class="r">${two(adj.actualTotal)}</td><td class="r">${adj.added >= 0 ? '+' : ''}${two(adj.added)}</td><td class="r"><b>${two(adj.closing)}</b></td></tr></tfoot>
    </table></div>
    <p class="muted small">Type a day's actual testing when it changes — the next days follow it. A day the DSR has no testing has none. Leave the opening blank to carry last month's closing.</p>`;
}
