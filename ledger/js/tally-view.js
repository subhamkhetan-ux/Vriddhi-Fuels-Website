// Tally viewer screens: the insights of a Tally file (tally-file.js) as
// HTML. Pure — strings in, strings out; app.js binds the buttons.

import {
  barChart, dailyVolumeChart, legend, litres, money, monthName, rspChart, SERIES, shortDate,
} from './charts.js';
import { FUELS, PRODUCT_NAME } from './dash.js';
import { KIND_NAME } from './tally-file.js';
import { fmtDate } from './util.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const rate = (r) => (r == null ? '—' : `₹${Number(r).toFixed(2)}`);
const exact = (n) => money(n, { exact: true });
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export const PARTY_SORTS = [['sales', 'Sales'], ['qty', 'Litres'], ['receipts', 'Receipts'], ['net', 'Billed − received'], ['discount', 'Discount']];
export const PAGE_SIZE = 100;

// the header: the file, its company and dates, and the period picker
export function fileHeadHtml(file, a, period) {
  const months = [];
  for (let m = a.span.from.slice(0, 7); m <= a.span.to.slice(0, 7);) {
    months.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return `
    <div class="row-between"><div>
      <h2>${esc(file.company || file.name)}</h2>
      <p class="muted small">${file.company ? `${esc(file.name)} · ` : ''}${file.source === 'xml' ? 'Tally XML export' : 'DayBook (Excel)'} · ${plural(file.vouchers.length, 'voucher')} · ${fmtDate(a.span.from)} – ${fmtDate(a.span.to)}</p></div>
      <span class="row-end"><label class="file"><input type="file" id="tally-file-2" accept=".xml,.txt,.xls,.xlsx,.xlsm,.csv"><span class="btn ghost small">Open another file</span></label>
        <button class="btn ghost small" data-tally-clear>Close</button></span></div>
    <div class="chips">
      <button class="chip ${period.key === 'all' ? 'on' : ''}" data-tperiod="all">Whole file</button>
      ${months.length > 1 ? months.map((m) => `<button class="chip ${period.key === m ? 'on' : ''}" data-tperiod="${m}">${monthName(m)}</button>`).join('') : ''}
      <button class="chip ${period.key === 'custom' ? 'on' : ''}" data-tperiod="custom">Custom</button></div>
    ${period.key === 'custom' ? `<form class="custom-range" id="tally-range">
      <label>From <input type="date" name="from" value="${a.from}" min="${a.span.from}" max="${a.span.to}" required></label>
      <label>To <input type="date" name="to" value="${a.to}" min="${a.span.from}" max="${a.span.to}" required></label>
      <button class="btn small" type="submit">Show</button></form>` : ''}
    <p class="muted small">Showing ${fmtDate(a.from)} – ${fmtDate(a.to)} · ${plural(a.days, 'day')}, vouchers on ${a.activeDays} · read on this device, nothing is saved</p>`;
}

export function overviewHtml(a) {
  const k = a.kpi;
  return `
    <h3>Overview</h3>
    <div class="kpis">
      <div class="kpi hero"><span class="lbl">Sales</span><span class="val">${money(k.sales)}</span><span class="sub">${litres(k.qty)} · ${plural(k.bills, 'bill')}</span></div>
      <div class="kpi"><span class="lbl">Receipts</span><span class="val">${money(k.receipts)}</span><span class="sub">${plural(a.byKind.receipt.count, 'receipt')} · ${pct(k.receipts, k.sales)} of sales</span></div>
      <div class="kpi"><span class="lbl">Payments</span><span class="val">${money(k.payments)}</span><span class="sub">${plural(a.byKind.payment.count, 'payment')}${k.purchases ? ` · purchases ${money(k.purchases)}` : ''}</span></div>
      <div class="kpi"><span class="lbl">Earnings (est.)</span><span class="val">${money(k.earning)}</span><span class="sub">₹${k.perLitre.toFixed(2)} per litre</span></div>
      <div class="kpi"><span class="lbl">Average bill</span><span class="val">${money(k.avgBill)}</span><span class="sub">${litres(k.perDay)} a sale day</span></div>
      <div class="kpi"><span class="lbl">Customers</span><span class="val">${k.parties.toLocaleString('en-IN')}</span><span class="sub">${plural(k.vehicles, 'vehicle')}</span></div>
      <div class="kpi"><span class="lbl">Discount given</span><span class="val">${money(k.discount)}</span><span class="sub">under the day's RSP</span></div>
      <div class="kpi${a.counts.cancelled ? ' warn' : ''}"><span class="lbl">Vouchers</span><span class="val">${a.counts.live.toLocaleString('en-IN')}</span><span class="sub">${a.counts.cancelled ? `${plural(a.counts.cancelled, 'cancelled', 'cancelled')}` : 'none cancelled'}</span></div>
    </div>
    <p class="small muted">Earnings and discounts as on Home: ₹2.58/L diesel &amp; XtraGreen, ₹4/L petrol off the day's RSP — here the highest rate billed that day in this file.${k.noRsp ? ` ${plural(k.noRsp, 'line')} had no RSP and are left out.` : ''}</p>`;
}

export function typesHtml(a) {
  if (!a.types.length) return '<h3>Voucher types</h3><p class="muted">No vouchers in these dates.</p>';
  return `<h3>Voucher types</h3>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Type</th><th>Kind</th><th class="r">Vouchers</th><th class="r">Amount</th><th class="r">Litres</th><th class="r">Cancelled</th><th>Dates</th></tr></thead>
      <tbody>${a.types.map((t) => `<tr><td><b>${esc(t.type)}</b></td><td>${esc(KIND_NAME[t.kind])}</td><td class="r">${t.count.toLocaleString('en-IN')}</td><td class="r">${exact(t.amount)}</td>
        <td class="r">${t.qty ? litres(t.qty) : ''}</td><td class="r">${t.cancelled || ''}</td><td class="small muted nowrap">${t.count ? `${shortDate(t.from)} – ${shortDate(t.to)}` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

export function productsHtml(a) {
  const p = a.products;
  const keys = FUELS.filter((f) => p[f].qty > 0 || p[f].amount > 0);
  const total = keys.reduce((s, f) => s + p[f].qty, 0) || 1;
  if (!keys.length && !p.OTHER.amount) return '<h3>By product</h3><p class="muted">No sales in these dates.</p>';
  return `<h3>By product</h3>
    <div class="prods">${keys.map((f) => `
      <div class="prod">
        <div class="prod-head"><i style="background:${SERIES[f].color}"></i><b>${PRODUCT_NAME[f]}</b><span class="small muted">${pct(p[f].qty, total)}</span></div>
        <span class="big">${litres(p[f].qty)}</span>
        <span class="small muted">${money(p[f].amount)} · ${plural(p[f].bills, 'bill')}</span>
        <span class="small">Rate ${p[f].rateMin === p[f].rateMax ? rate(p[f].rateMax) : `${rate(p[f].rateMin)} – ${rate(p[f].rateMax)}`} · avg ${rate(p[f].qty ? p[f].amount / p[f].qty : null)}</span>
        <span class="small">Earned <b>${money(p[f].earning)}</b>${p[f].discount ? ` · discount ${money(p[f].discount)}` : ''}</span>
      </div>`).join('')}
      ${p.OTHER.amount ? `<div class="prod"><div class="prod-head"><b>Other items</b></div><span class="big">${money(p.OTHER.amount)}</span>
        <span class="small muted">${plural(p.OTHER.bills, 'bill')}</span>
        ${p.OTHER.items.slice(0, 4).map((i) => `<span class="small">${esc(i.name)} · ${money(i.amount)}</span>`).join('')}</div>` : ''}</div>
    ${keys.length > 1 ? `<p class="small muted share-label">Share of litres</p>
      <div class="share">${keys.map((f) => `<span style="flex:${p[f].qty / total};background:${SERIES[f].color}" title="${PRODUCT_NAME[f]} ${pct(p[f].qty, total)}"></span>`).join('')}</div>${legend(keys)}` : ''}`;
}

// litres per day (per month past 62 days), receipts against sales, weekdays
export function trendHtml(a) {
  const byMonth = a.days > 62;
  let vol = a.daily;
  if (byMonth) {
    const m = new Map();
    for (const d of a.daily) {
      const k = d.date.slice(0, 7);
      if (!m.has(k)) m.set(k, { date: `${k}-01`, qty: { HSD: 0, MS: 0, XG: 0 }, amount: 0, earning: 0, receipts: 0 });
      const x = m.get(k);
      FUELS.forEach((f) => { x.qty[f] += d.qty[f]; });
      x.amount += d.amount;
      x.earning += d.earning;
      x.receipts += d.receipts;
    }
    vol = [...m.values()];
  }
  const label = (d) => (byMonth ? monthName(d.date.slice(0, 7)) : shortDate(d.date));
  const opts = { labelOf: label, tipLabel: label };
  const rec = vol.map((d) => ({ label: label(d), value: d.receipts, tip: `<b>${label(d)}</b><br>Receipts ${exact(d.receipts)}<br>Sales ${exact(d.amount)}` }));
  const wk = a.weekday.map((w) => ({ label: w.name, value: w.avgQty, tip: `<b>${w.name}</b><br>${litres(w.avgQty)} on average<br>${money(w.avgAmount)} · ${plural(w.days, 'day')}` }));
  const best = [...a.daily].filter((d) => d.bills).sort((x, y) => FUELS.reduce((s, f) => s + y.qty[f], 0) - FUELS.reduce((s, f) => s + x.qty[f], 0))[0];
  return `<h3>Litres ${byMonth ? 'per month' : 'per day'}</h3>
    ${legend(FUELS.filter((f) => a.products[f].qty > 0))}
    ${dailyVolumeChart(vol, opts)}
    ${best ? `<p class="small muted">Busiest day: <b>${fmtDate(best.date)}</b> — ${litres(FUELS.reduce((s, f) => s + best.qty[f], 0))}, ${money(best.amount)} in ${plural(best.bills, 'bill')}.</p>` : ''}
    ${a.kpi.receipts ? `<h3 class="sub-h">Receipts ${byMonth ? 'per month' : 'per day'}</h3>${barChart(rec, { label: 'Receipts', color: 'var(--s-paid)', h: 140 })}` : ''}
    ${a.saleDays > 6 ? `<h3 class="sub-h">Average litres by weekday</h3>${barChart(wk, { label: 'Average litres by weekday', color: 'var(--s-sales)', h: 140, fmt: (v) => (v >= 1000 ? `${Math.round(v / 100) / 10} KL` : `${Math.round(v)} L`) })}` : ''}`;
}

export function partiesHtml(a, { sort = 'sales', q = '', all = false } = {}) {
  const val = { sales: (p) => p.sales, qty: (p) => p.qty, receipts: (p) => p.receipts, net: (p) => p.net, discount: (p) => p.discount };
  const needle = q.trim().toLowerCase();
  const list = a.parties.filter((p) => (p.bills || p.receipts) && (!needle || p.name.toLowerCase().includes(needle)))
    .sort((x, y) => val[sort](y) - val[sort](x));
  const shown = all ? list : list.slice(0, 15);
  const max = Math.max(1, ...list.map((p) => Math.abs(val[sort](p))));
  const main = (p) => (sort === 'qty' ? litres(p.qty) : exact(val[sort](p)));
  return `<div class="row-between"><h3>Customers &amp; parties</h3><span class="small muted">${plural(list.length, 'party', 'parties')}</span></div>
    <div class="chips small-chips">${PARTY_SORTS.map(([k, n]) => `<button class="chip ${k === sort ? 'on' : ''}" data-psort="${k}">${n}</button>`).join('')}</div>
    <input type="search" id="party-q" placeholder="Search a party" value="${esc(q)}" autocomplete="off">
    ${shown.length ? `<ol class="rank">${shown.map((p, i) => `
      <li><button class="rank-row" data-party aria-expanded="false">
        <span class="n">${i + 1}</span>
        <span class="who"><b>${esc(p.name)}</b>
          <span class="mini-track"><span class="mini${sort === 'net' || sort === 'receipts' ? ' owe' : ''}" style="width:${Math.max(2, (Math.abs(val[sort](p)) / max) * 100)}%">${sort === 'net' || sort === 'receipts' ? '' : FUELS.filter((f) => p.products[f].qty > 0).map((f) => `<i style="flex:${p.products[f].qty};background:${SERIES[f].color}"></i>`).join('')}</span></span></span>
        <span class="amt"><b>${main(p)}</b><small>${p.bills ? `${plural(p.bills, 'bill')} · ${litres(p.qty)}` : 'no bills'}${p.receipts && sort !== 'receipts' ? ` · received ${money(p.receipts)}` : ''}</small></span>
      </button>
      <div class="rank-more" hidden>
        <div class="table-wrap"><table class="compact"><tbody>
          ${[...FUELS, 'OTHER'].filter((f) => p.products[f].amount).map((f) => `<tr><td>${f === 'OTHER' ? 'Other items' : PRODUCT_NAME[f]}</td><td class="r">${f === 'OTHER' ? '' : litres(p.products[f].qty)}</td><td class="r">${exact(p.products[f].amount)}</td><td class="r">${f === 'OTHER' || !p.products[f].qty ? '' : `avg ${rate(p.products[f].amount / p.products[f].qty)}`}</td></tr>`).join('')}
          <tr><td>Billed</td><td></td><td class="r"><b>${exact(p.sales)}</b></td><td></td></tr>
          <tr><td>Received</td><td></td><td class="r good-text">${exact(p.receipts)}</td><td class="r small muted">${p.lastReceipt ? `last ${shortDate(p.lastReceipt)}` : ''}</td></tr>
          ${p.payments ? `<tr><td>Paid to them</td><td></td><td class="r">${exact(p.payments)}</td><td></td></tr>` : ''}
          ${p.other ? `<tr><td>Journals &amp; others</td><td></td><td class="r">${exact(p.other)}</td><td></td></tr>` : ''}
          <tr><td>Billed − received</td><td></td><td class="r"><b class="${p.net > 0 ? 'warn-text' : 'good-text'}">${exact(p.net)}</b></td><td></td></tr>
        </tbody></table></div>
        <p class="small muted">${p.first ? `Bills ${shortDate(p.first)} – ${shortDate(p.last)} · ` : ''}${plural(p.vehicles, 'vehicle')} · earned ${money(p.earning)}${p.qty ? ` (₹${p.perLitre.toFixed(2)}/L)` : ''}${p.discount ? ` · discount ${money(p.discount)}` : ''}${p.gstin ? ` · GSTIN ${esc(p.gstin)}` : ''}</p>
        <p class="small"><button class="btn ghost small" data-party-vouchers="${esc(p.name)}">See their vouchers</button></p>
      </div></li>`).join('')}</ol>` : '<p class="muted">No parties match.</p>'}
    ${list.length > 15 ? `<p><button class="btn ghost small" data-pall>${all ? 'Show top 15' : `Show all ${list.length}`}</button></p>` : ''}
    <p class="small muted">Billed − received is only what this file shows for these dates, not the customer's balance.</p>`;
}

export function vehiclesHtml(a, { all = false } = {}) {
  if (!a.vehicles.length) return '<h3>Vehicles</h3><p class="muted">No vehicle numbers on the fuel bills.</p>';
  const shown = all ? a.vehicles : a.vehicles.slice(0, 15);
  const shared = a.vehicles.filter((v) => v.parties.length > 1);
  return `<div class="row-between"><h3>Vehicles</h3><span class="small muted">${plural(a.vehicles.length, 'vehicle')}</span></div>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Vehicle</th><th class="r">Fills</th><th class="r">Litres</th><th class="r">Amount</th><th>Billed to</th><th>Last</th></tr></thead>
      <tbody>${shown.map((v) => `<tr><td class="b-veh">${esc(v.vehicle)}</td><td class="r">${v.fills}</td><td class="r">${litres(v.qty)}</td><td class="r">${money(v.amount)}</td>
        <td class="small">${esc(v.parties.slice(0, 2).join(', '))}${v.parties.length > 2 ? ` +${v.parties.length - 2}` : ''}${v.parties.length > 1 ? ' <span class="pill warn-pill">shared</span>' : ''}</td><td class="small muted nowrap">${shortDate(v.last)}</td></tr>`).join('')}</tbody></table></div>
    ${a.vehicles.length > 15 ? `<p><button class="btn ghost small" data-vall>${all ? 'Show top 15' : `Show all ${a.vehicles.length}`}</button></p>` : ''}
    ${shared.length ? `<p class="small warn-text">${plural(shared.length, 'vehicle')} billed to more than one party.</p>` : ''}`;
}

export function ratesHtml(a) {
  const keys = FUELS.filter((f) => a.rates[f].length);
  if (!keys.length) return '<h3>Rates</h3><p class="muted">No rates on the bills.</p>';
  const dates = [...new Set(keys.flatMap((f) => a.rates[f].map((r) => r.date)))].sort().slice(-90);
  // a day without a bill of that product keeps the rate before it
  const series = Object.fromEntries(keys.map((f) => {
    const m = new Map(a.rates[f].map((r) => [r.date, r.max]));
    let last = null;
    return [f, dates.map((date) => {
      if (m.has(date)) last = m.get(date);
      return { date, rsp: last };
    })];
  }));
  return `<h3>Day's rate${dates.length === 90 ? ' · last 90 sale days' : ''}</h3>
    <p class="small muted">The highest rate billed each day — the RSP the earnings are worked from.</p>
    ${legend(keys)}
    ${rspChart(series)}
    ${a.changes.length ? `<h3 class="sub-h">Rate changes</h3>
      <div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>Product</th><th class="r">From</th><th class="r">To</th><th class="r">Change</th></tr></thead>
        <tbody>${a.changes.slice(0, 30).map((c) => `<tr><td>${fmtDate(c.date)}</td><td>${PRODUCT_NAME[c.product]}</td><td class="r">${rate(c.from)}</td><td class="r">${rate(c.to)}</td>
          <td class="r ${c.to > c.from ? 'bad-text' : 'good-text'}">${c.to > c.from ? '+' : '−'}₹${Math.abs(c.to - c.from).toFixed(2)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">No rate changes in these dates.</p>'}`;
}

export function seriesHtml(a) {
  const list = a.series.filter((s) => s.kind === 'sale' || s.missingCount || s.duplicates.length || s.outOfOrder.length);
  if (!list.length) return '<h3>Bill numbers</h3><p class="muted">No numbered vouchers.</p>';
  return `<h3>Bill numbers</h3>
    <p class="small muted">Each series from its first to its last number in these dates: numbers not in the file, numbers used twice, and bills numbered lower than one dated before them.</p>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Series</th><th>FY</th><th class="r">Vouchers</th><th>Numbers</th><th class="r">Missing</th><th class="r">Twice</th><th class="r">Out of order</th></tr></thead>
      <tbody>${list.map((s) => `<tr><td><b>${esc(s.type)}</b></td><td class="small">${s.fy}</td><td class="r">${s.count}</td>
        <td class="small nowrap">${esc(s.first)} – ${esc(s.last)}</td>
        <td class="r ${s.missingCount ? 'warn-text' : ''}">${s.tooWide ? '<span class="muted">too wide</span>' : s.missingCount || '✓'}</td>
        <td class="r ${s.duplicates.length ? 'bad-text' : ''}">${s.duplicates.length || '✓'}</td>
        <td class="r ${s.outOfOrder.length ? 'warn-text' : ''}">${s.outOfOrder.length || '✓'}</td></tr>`).join('')}</tbody></table></div>
    ${list.filter((s) => s.missingCount || s.duplicates.length || s.outOfOrder.length).map((s) => `<details><summary>${esc(s.type)} ${s.fy}: ${[
    s.missingCount ? plural(s.missingCount, 'number') + ' missing' : '', s.duplicates.length ? plural(s.duplicates.length, 'number') + ' used twice' : '',
    s.outOfOrder.length ? plural(s.outOfOrder.length, 'bill') + ' out of order' : ''].filter(Boolean).join(' · ')}</summary>
      ${s.missing.length ? `<p class="small"><b>Missing:</b> ${s.missing.map(esc).join(', ')}${s.missingCount > s.missing.length ? ` … and ${s.missingCount - s.missing.length} more` : ''}</p>` : ''}
      ${s.duplicates.length ? `<p class="small"><b>Used twice:</b> ${s.duplicates.map((d) => `${esc(d.number)} (×${d.count})`).join(', ')}</p>` : ''}
      ${s.outOfOrder.length ? `<p class="small"><b>Out of order:</b> ${s.outOfOrder.slice(0, 50).map((o) => `${esc(o.number)} on ${shortDate(o.date)}`).join(', ')}</p>` : ''}
    </details>`).join('')}`;
}

const CHECKS = [
  ['mismatch', 'Litres × rate ≠ amount', 'bills whose amount is more than ₹1 off litres × rate'],
  ['noVehicle', 'Fuel bills without a vehicle', ''],
  ['noParty', 'Vouchers without a party', ''],
  ['noNumber', 'Sales without a bill no.', ''],
  ['zero', 'Zero-amount vouchers', ''],
  ['cancelled', 'Cancelled vouchers', ''],
];
export function checksHtml(a) {
  const found = CHECKS.filter(([k]) => a.checks[k].length);
  return `<h3>Checks</h3>
    ${found.length ? found.map(([k, name, note]) => `<details><summary><b class="${k === 'cancelled' ? '' : 'warn-text'}">${a.checks[k].length}</b> · ${name}${note ? ` <span class="faint">— ${note}</span>` : ''}</summary>
      ${voucherTable(a.checks[k].slice(0, 50), { extra: k === 'mismatch' })}${a.checks[k].length > 50 ? `<p class="small muted">First 50 of ${a.checks[k].length}.</p>` : ''}</details>`).join('')
    : '<p class="good-text">Nothing to flag: every bill adds up and has a party, number and vehicle.</p>'}`;
}

export function ledgersHtml(a, parties) {
  const names = new Set(parties.map((p) => p.name.toLowerCase()));
  const list = a.ledgers.filter((l) => !names.has(l.name.toLowerCase()));
  if (!list.length) return '';
  return `<h3>Ledgers</h3>
    <p class="small muted">Every ledger the vouchers post to (customers are above) — sales, cash, bank, round-off…</p>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Ledger</th><th class="r">Entries</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Net</th></tr></thead>
      <tbody>${list.slice(0, 40).map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${l.count}</td><td class="r">${l.debit ? exact(l.debit) : ''}</td><td class="r">${l.credit ? exact(l.credit) : ''}</td>
        <td class="r">${exact(Math.abs(l.debit - l.credit))} ${l.debit >= l.credit ? 'Dr' : 'Cr'}</td></tr>`).join('')}</tbody></table></div>`;
}

export function voucherTable(list, { extra = false } = {}) {
  if (!list.length) return '<p class="muted">No vouchers.</p>';
  return `<div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>Type</th><th>No.</th><th>Particulars</th><th>Vehicle</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th>${extra ? '<th class="r">Qty × rate</th>' : ''}</tr></thead>
    <tbody>${list.map((v) => `<tr${v.cancelled ? ' class="faint"' : ''}><td class="nowrap">${fmtDate(v.date)}</td><td class="small">${esc(v.type)}${v.cancelled ? ' <span class="pill bad-pill">cancelled</span>' : ''}</td>
      <td class="nowrap">${esc(v.number)}</td><td>${esc(v.party)}${v.narration ? `<br><small class="muted">${esc(v.narration)}</small>` : ''}</td><td class="b-veh">${esc(v.vehicle)}</td>
      <td class="r">${v.qty ? Number(v.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 }) : ''}</td><td class="r">${v.rate ? Number(v.rate).toFixed(2) : ''}</td><td class="r">${exact(v.amount)}</td>
      ${extra ? `<td class="r">${exact(v.expected)} <small class="${v.diff > 0 ? 'warn-text' : 'bad-text'}">(${v.diff > 0 ? '+' : ''}${v.diff})</small></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

// the voucher list with its filters
export function vouchersHtml(list, f, kinds, { shown = PAGE_SIZE } = {}) {
  const total = list.reduce((s, v) => s + (v.cancelled ? 0 : v.amount), 0);
  return `<div class="row-between"><h3>All vouchers</h3><button class="btn ghost small" data-vdownload ${list.length ? '' : 'disabled'}>Download Excel</button></div>
    <div class="chips small-chips"><button class="chip ${f.kind === 'all' ? 'on' : ''}" data-vkind="all">All</button>${kinds.map((k) => `<button class="chip ${f.kind === k ? 'on' : ''}" data-vkind="${k}">${KIND_NAME[k]}</button>`).join('')}</div>
    <div class="row-form">
      <label>Search <input type="search" id="v-q" placeholder="Party, vehicle, bill no., narration" value="${esc(f.q)}" autocomplete="off"></label>
      <label>Product <select id="v-product">${[['all', 'All'], ...FUELS.map((p) => [p, PRODUCT_NAME[p]]), ['OTHER', 'Other items']].map(([k, n]) => `<option value="${k}" ${f.product === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>
    <p class="small muted">${plural(list.length, 'voucher')} · ${exact(total)}</p>
    <div id="v-table">${voucherTable(list.slice(0, shown))}</div>
    ${list.length > shown ? `<p><button class="btn ghost small" data-vmore>Show ${Math.min(PAGE_SIZE, list.length - shown)} more</button></p>` : ''}`;
}
