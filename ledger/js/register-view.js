// Register screen pieces (HTML strings) — the Daily Stock Register laid out
// like the paper book, and the Stock Register, from register.js's
// productMonth(). No DOM, no network.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const L2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const litres = (n) => (n == null ? '' : L2.format(n));
const meter = (n) => (n == null ? '' : Number(n).toFixed(2));
const dip = (n) => (n == null ? '' : Number(n).toFixed(1));
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (iso) => WEEK[new Date(`${iso}T00:00:00Z`).getUTCDay()];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (m) => `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const SRC = { chart: 'the DIP Chart', log: 'the DIP Chart\'s Log', stock: 'the Stock Register', mac: 'the Stock Register\'s Macro Log' };
export const srcName = (s) => SRC[s] || s;
const signed = (n) => (n == null ? '' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${L2.format(Math.abs(n))}`);
const flag = (title) => `<i class="reg-flag" title="${esc(title)}" aria-label="${esc(title)}">!</i>`;

function dateCell(r, today) {
  return `<th scope="row" class="reg-date${r.date === today ? ' today' : ''}"><b>${r.day}</b><small>${weekday(r.date)}</small></th>`;
}
// a row the books have nothing for yet
const isEmpty = (r) => r.stock == null && r.meters == null && r.sale == null && r.receipt == null;

// The Daily Stock Register (the paper DSR): dips, opening / receipt / total
// stock, each nozzle's opening meter reading, testing, sale, cumulative sale.
export function dsrTableHtml(pm, { today } = {}) {
  const tanks = pm.product.tanks;
  const machines = [];
  for (const z of pm.nozzles) {
    const last = machines[machines.length - 1];
    if (last && last.name === z.machine) last.n += 1; else machines.push({ name: z.machine, n: 1 });
  }
  const head = `<thead>
    <tr><th rowspan="2" class="reg-date">Date</th>
      <th colspan="${tanks}" class="grp">Dip <span>(cm)</span></th>
      <th colspan="3" class="grp">Stock <span>(L)</span></th>
      ${machines.map((m) => `<th colspan="${m.n}" class="grp mach">${esc(m.name || 'Meter reading')}</th>`).join('')}
      <th colspan="3" class="grp">Sales <span>(L)</span></th></tr>
    <tr>${tanks === 2 ? '<th class="r">Tank 1</th><th class="r">Tank 2</th>' : '<th class="r">Tank 1</th>'}
      <th class="r">Opening</th><th class="r">Receipt</th><th class="r">Total</th>
      ${pm.nozzles.map((z, i) => `<th class="r${i === 0 || pm.nozzles[i - 1].machine !== z.machine ? ' first' : ''}">${esc(z.label)}</th>`).join('')}
      <th class="r first">Testing</th><th class="r">Sale</th><th class="r">Cumulative</th></tr></thead>`;
  const body = pm.rows.map((r) => {
    const empty = isEmpty(r);
    const dips = tanks === 2 ? [0, 1].map((i) => r.dips[i]) : [r.dips[0]];
    const dipTip = r.stock != null && tanks === 2 && r.tanks == null ? 'Each tank\'s stock is kept from the DIP Chart from the day it\'s first brought in; this day only has the total.' : '';
    const stockFlag = r.differs != null ? flag(`The Stock Register has ${litres(r.differs)} L for this morning; this is ${srcName(r.stockSrc)}'s.`) : '';
    return `<tr class="${empty ? 'empty' : ''}${r.date === today ? ' today' : ''}">${dateCell(r, today)}
      ${dips.map((v) => `<td class="r dip"${dipTip && v == null ? ` title="${esc(dipTip)}"` : ''}>${v == null ? (dipTip ? '<span class="faint">—</span>' : '') : dip(v)}</td>`).join('')}
      <td class="r">${litres(r.stock)}${stockFlag}</td>
      <td class="r${r.receipt ? ' rec' : ''}">${r.receipt ? litres(r.receipt) : (r.stock != null ? '<span class="faint">—</span>' : '')}</td>
      <td class="r">${litres(r.total)}</td>
      ${pm.nozzles.map((_, i) => `<td class="r mono${i === 0 || pm.nozzles[i - 1].machine !== pm.nozzles[i].machine ? ' first' : ''}">${r.meters ? meter(r.meters[i]) : ''}</td>`).join('')}
      <td class="r first">${r.test == null ? '' : litres(r.test)}</td>
      <td class="r"><b>${litres(r.sale)}</b></td>
      <td class="r">${litres(r.cum)}</td></tr>`;
  }).join('');
  const t = pm.totals;
  const foot = `<tfoot><tr><th scope="row" class="reg-date">Total</th><td colspan="${tanks + 1}"></td>
    <td class="r">${t.receipt ? litres(t.receipt) : ''}</td><td></td>${pm.nozzles.map(() => '<td></td>').join('')}
    <td class="r first">${litres(t.test)}</td><td class="r"><b>${litres(t.sale)}</b></td><td></td></tr></tfoot>`;
  return `<div class="table-wrap reg-wrap"><table class="reg">${head}<tbody>${body}</tbody>${foot}</table></div>`;
}

// The Stock Register: book stock (opening + receipts − sale) against the
// actual tank stock (the next morning's dips), the shortage and its change.
export function stockTableHtml(pm, { today } = {}) {
  const head = `<thead><tr><th class="reg-date">Date</th><th class="r">Opening <span>(book)</span></th><th class="r">Receipts</th><th class="r">Total</th>
    <th class="r">Sale</th><th class="r">Closing <span>(book)</span></th><th class="r first">Actual tank stock</th><th class="r">Shortage</th><th class="r">Variation</th></tr></thead>`;
  const body = pm.rows.map((r) => {
    const empty = r.bookOpen == null && r.actual == null;
    const alt = r.actualAlt != null ? flag(`The DIP Chart has ${litres(r.actualAlt)} L for the next morning.`) : '';
    const via = r.actual != null && r.actualSrc && r.actualSrc !== 'stock' ? ` title="${esc(`Not in the Stock Register yet: from ${srcName(r.actualSrc)}`)}"` : '';
    return `<tr class="${empty ? 'empty' : ''}${r.date === today ? ' today' : ''}">${dateCell(r, today)}
      <td class="r">${litres(r.bookOpen)}</td>
      <td class="r${r.receipt ? ' rec' : ''}">${r.receipt ? litres(r.receipt) : ''}</td>
      <td class="r">${litres(r.bookTotal)}</td>
      <td class="r">${litres(r.sale)}</td>
      <td class="r">${litres(r.bookClose)}</td>
      <td class="r first"${via}>${litres(r.actual)}${r.actual != null && r.actualSrc !== 'stock' ? '<sup class="faint">*</sup>' : ''}${alt}</td>
      <td class="r"><b>${litres(r.shortage)}</b></td>
      <td class="r ${r.variation > 0 ? 'bad-text' : r.variation < 0 ? 'good-text' : ''}">${signed(r.variation)}</td></tr>`;
  }).join('');
  const t = pm.totals;
  const foot = `<tfoot><tr><th scope="row" class="reg-date">Total</th><td></td><td class="r">${t.receipt ? litres(t.receipt) : ''}</td><td></td>
    <td class="r">${litres(t.sale)}</td><td></td><td class="first"></td><td></td>
    <td class="r ${t.variation > 0 ? 'bad-text' : t.variation < 0 ? 'good-text' : ''}"><b>${signed(t.variation)}</b></td></tr></tfoot>`;
  return `<div class="table-wrap reg-wrap"><table class="reg">${head}<tbody>${body}</tbody>${foot}</table></div>`;
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

