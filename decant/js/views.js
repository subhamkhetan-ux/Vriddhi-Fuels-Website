// The Log (every decantation of the last month) and the Reports (by day, by
// truck, by product, by tank, by month, and the variation trend).

import { PRODUCTS, istDate } from './core.js';
import {
  byDay, byMonth, byProduct, byTank, byVehicle, daysBetween, entriesFrom, exportRows, filterEntries, summarize, toCsv, trend,
} from './report.js';
import { state } from './store.js';
import {
  PRODUCT_COLOR, bandBadge, download, esc, fmtIsoDay, fmtKL, fmtL, fmtMoney, fmtNum, fmtPct, fmtSigned, fmtTime, productChip,
  productShort, toast,
} from './ui.js';
import { dailyVariation, variationDots } from './charts.js';
import { compactNos, tankName } from './app.js';
import { openWizard } from './wizard.js';

const F = {
  log: { period: 'week', tt: '', product: '', q: '', showCancelled: false },
  rep: { period: 'month', from: '', to: '', tt: '', product: '' },
};

const today = () => istDate(Date.now());
function monthStart(iso) { return `${iso.slice(0, 7)}-01`; }
function addDays(iso, n) { return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
function lastMonthRange() {
  const first = monthStart(today());
  const end = addDays(first, -1);
  return [monthStart(end), end];
}
function keptFrom() { return addDays(today(), -(state.settings.retentionDays - 1)); }

function rangeFor(period, from, to) {
  const t = today();
  switch (period) {
    case 'today': return [t, t];
    case 'week': return [addDays(t, -6), t];
    case 'month': return [monthStart(t), t];
    case 'lastmonth': return lastMonthRange();
    case 'custom': return [from || keptFrom(), to || t];
    default: return [keptFrom(), t];               // everything kept
  }
}

function vehicleOptions(entries, sel) {
  const tts = [...new Set(entries.map((e) => e.tt).filter(Boolean))].sort();
  return `<option value="">All trucks</option>${tts.map((t) => `<option value="${esc(t)}" ${t === sel ? 'selected' : ''}>${esc(t)}</option>`).join('')}`;
}
function productOptions(sel) {
  return `<option value="">All products</option>${Object.values(PRODUCTS).map((p) => `<option value="${p.key}" ${p.key === sel ? 'selected' : ''}>${p.name}</option>`).join('')}`;
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

let logBound = null;

export function renderLog(el) {
  if (logBound !== el) { bindLog(el); logBound = el; }
  const all = entriesFrom(state.sessions, state.settings);
  const [from, to] = rangeFor(F.log.period);
  const q = F.log.q.trim().toUpperCase();
  const list = filterEntries(all, { from, to, tt: F.log.tt, product: F.log.product })
    .filter((e) => !q || e.tt.includes(q) || String(e.invoiceNo).toUpperCase().includes(q));
  const sum = summarize(list);
  const days = byDay(list);
  const cancelled = state.sessions.filter((s) => s.status === 'cancelled');
  el.innerHTML = `
    <div class="filters">
      <div class="seg" role="group" aria-label="Period">${[['today', 'Today'], ['week', '7 days'], ['month', 'This month'], ['all', `All (${state.settings.retentionDays} d)`]]
        .map(([k, l]) => `<button class="${F.log.period === k ? 'on' : ''}" data-lp="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="filters">
      <select data-lf="tt" aria-label="Truck">${vehicleOptions(all, F.log.tt)}</select>
      <select data-lf="product" aria-label="Product">${productOptions(F.log.product)}</select>
      <input type="search" data-lf="q" placeholder="Truck or invoice no." value="${esc(F.log.q)}" style="flex:1;min-width:140px">
    </div>
    <div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:180px"><b>${sum.trips}</b> decantation${sum.trips === 1 ? '' : 's'} · <b>${fmtKL(sum.litres)}</b>
        <div class="hint">Net variation <b style="color:var(--ink)">${fmtSigned(sum.variation, ' L', 0)}</b> (${fmtPct(sum.pct)})${sum.flagged ? ` · ${sum.flagged} outside tolerance` : ''}</div></div>
      <button class="btn sm" data-export="xlsx" ${list.length ? '' : 'disabled'}>⬇ Excel</button>
      <button class="btn sm" data-export="csv" ${list.length ? '' : 'disabled'}>CSV</button>
    </div>
    ${days.length ? days.map((d) => `
      <div class="day-h"><span>${fmtIsoDay(d.key, true)}</span><span>${d.trips} decant${d.trips === 1 ? '' : 's'} · ${fmtKL(d.litres)} · ${fmtSigned(d.variation, ' L')}</span></div>
      ${d.entries.map(logRow).join('')}`).join('')
    : `<div class="empty">Nothing in this period. Finished decantations are kept here for ${state.settings.retentionDays} days.</div>`}
    ${cancelled.length ? `<h2 style="cursor:pointer" data-cancelled>${F.log.showCancelled ? '▾' : '▸'} Cancelled <span class="count">${cancelled.length}</span></h2>
      ${F.log.showCancelled ? cancelled.map((s) => `<button class="lrow" data-open="${esc(s.id)}"><span class="tm">${fmtIsoDay(istDate(s.created_at))}</span>
        <span class="mid"><b>${esc(s.tt_no || '')}</b><div>${esc(s.data?.cancelReason || '')}</div></span><span class="rt"></span></button>`).join('') : ''}` : ''}`;
}

function logRow(e) {
  return `<button class="lrow" data-open="${esc(e.sessionId)}">
    <span class="tm">${fmtTime(e.at)}</span>
    <span class="mid"><b>${esc(e.tt)}</b> <span class="hint">${esc(e.invoiceNo)}</span>
      <div>${productChip(e.product)} ${tankName(e.tank)} · C${compactNos(e.chambers)} · ${fmtL(e.litres)}${e.salesL ? ` · sold ${fmtL(e.salesL)}` : ''}</div></span>
    <span class="rt"><b>${fmtSigned(e.variation, ' L', 1)}</b><span class="hint">${fmtPct(e.pct)}</span><span class="rt-badge">${bandBadge(e.band, e.direction)}</span></span>
  </button>`;
}

function bindLog(el) {
  el.addEventListener('click', (e) => {
    const t = e.target;
    const p = t.closest('[data-lp]');
    if (p) { F.log.period = p.dataset.lp; renderLog(el); return; }
    const o = t.closest('[data-open]');
    if (o) { openWizard(o.dataset.open); return; }
    if (t.closest('[data-cancelled]')) { F.log.showCancelled = !F.log.showCancelled; renderLog(el); return; }
    const x = t.closest('[data-export]');
    if (x) exportLog(x.dataset.export);
  });
  el.addEventListener('change', (e) => {
    const f = e.target.dataset.lf;
    if (f && f !== 'q') { F.log[f] = e.target.value; e.target.blur(); renderLog(el); }
  });
  el.addEventListener('input', (e) => {
    if (e.target.dataset.lf === 'q') {
      F.log.q = e.target.value;
      clearTimeout(bindLog.t);
      bindLog.t = setTimeout(() => {
        const pos = e.target.selectionStart;
        renderLog(el);
        const inp = el.querySelector('[data-lf="q"]');
        inp?.focus();
        inp?.setSelectionRange(pos, pos);
      }, 250);
    }
  });
}

function exportLog(kind) {
  const all = entriesFrom(state.sessions, state.settings);
  const [from, to] = rangeFor(F.log.period);
  const list = filterEntries(all, { from, to, tt: F.log.tt, product: F.log.product });
  const rows = exportRows([...list].reverse());
  const name = `Decanting ${from} to ${to}${F.log.tt ? ` ${F.log.tt}` : ''}`;
  if (kind === 'csv') {
    download(new Blob([`﻿${toCsv(rows)}`], { type: 'text/csv' }), `${name}.csv`);
  } else {
    import('./xlsx.js').then(({ buildXlsx }) => {
      download(buildXlsx('Decanting', rows, [11, 7, 13, 13, 8, 8, 14, 12, 12, 14, 14, 12, 12, 12, 11, 11]), `${name}.xlsx`);
    }).catch((err) => toast(`Couldn't make the file: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

let repBound = null;

export function renderReports(el) {
  if (repBound !== el) { bindReports(el); repBound = el; }
  const all = entriesFrom(state.sessions, state.settings);
  const [from, to] = rangeFor(F.rep.period, F.rep.from, F.rep.to);
  const list = filterEntries(all, { from, to, tt: F.rep.tt, product: F.rep.product });
  const sum = summarize(list);
  const kept = keptFrom();
  const clipped = from < kept;
  const periodSel = [['month', 'This month'], ['lastmonth', 'Last month'], ['week', 'Last 7 days'], ['all', `Last ${state.settings.retentionDays} days`], ['custom', 'Custom…']]
    .map(([k, l]) => `<option value="${k}" ${F.rep.period === k ? 'selected' : ''}>${l}</option>`).join('');
  const days = daysBetween(from < kept ? kept : from, to).map((key) => {
    const d = byDay(list).find((x) => x.key === key);
    return d ? { key, variation: d.variation, litres: d.litres, count: d.count, pct: d.pct } : { key, variation: 0, litres: 0, count: 0, pct: 0 };
  });
  const tolPct = state.settings.tolerancePct;
  el.innerHTML = `
    <div class="filters">
      <select data-rf="period" aria-label="Period">${periodSel}</select>
      ${F.rep.period === 'custom' ? `<input type="date" data-rf="from" value="${from}" min="${kept}" max="${to}" style="width:auto"><input type="date" data-rf="to" value="${to}" min="${from}" max="${today()}" style="width:auto">` : ''}
      <select data-rf="tt" aria-label="Truck">${vehicleOptions(all, F.rep.tt)}</select>
      <select data-rf="product" aria-label="Product">${productOptions(F.rep.product)}</select>
    </div>
    <div class="hint" style="margin:-4px 2px 10px">${fmtIsoDay(from, true)} – ${fmtIsoDay(to, true)}${F.rep.tt ? ` · ${esc(F.rep.tt)}` : ''}${F.rep.product ? ` · ${PRODUCTS[F.rep.product].name}` : ''}${clipped ? ` · the log keeps ${state.settings.retentionDays} days, so this starts ${fmtIsoDay(kept)}` : ''}</div>
    ${list.length ? `
    <div class="kpis">
      <div class="kpi"><div class="k">Decanted</div><div class="v">${fmtKL(sum.litres)}</div><div class="s">${sum.trips} decantation${sum.trips === 1 ? '' : 's'} · ${sum.count} tank fill${sum.count === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="k">Net variation</div><div class="v">${fmtSigned(sum.variation, ' L')}</div><div class="s">${fmtPct(sum.pct)} of decanted</div></div>
      <div class="kpi"><div class="k">Short / excess</div><div class="v">${fmtNum(-sum.short)} / ${fmtNum(sum.excess)} L</div><div class="s">tank got less / more</div></div>
      <div class="kpi"><div class="k">Outside tolerance</div><div class="v">${sum.flagged} of ${sum.count}</div><div class="s">±${tolPct}% or ±${state.settings.toleranceMinL} L</div></div>
      <div class="kpi"><div class="k">At invoice price</div><div class="v">${fmtMoney(sum.value)}</div><div class="s">net value of the variation</div></div>
      <div class="kpi"><div class="k">Worst</div><div class="v">${sum.worst ? fmtPct(sum.worst.pct) : '—'}</div><div class="s">${sum.worst ? `${esc(sum.worst.tt)} · ${fmtIsoDay(sum.worst.day)} · ${tankName(sum.worst.tank)}` : ''}</div></div>
    </div>
    <div class="card">
      <div class="sect-title">Net variation per day</div>
      <div class="legend"><span><i class="sq" style="background:var(--viz-short)"></i>Short (tank got less than the chambers held)</span><span><i class="sq" style="background:var(--viz-excess)"></i>Excess</span></div>
      <div class="viz-host" id="vzDays"></div>
      <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Day by day table</summary>${dayTable(byDay(list))}</details>
    </div>
    <div class="card">
      <div class="sect-title">Every decantation</div>
      <div class="legend">${['MS', 'HSD', 'XG'].filter((p) => list.some((e) => e.product === p)).map((p) => `<span><i style="background:${PRODUCT_COLOR[p]}"></i>${PRODUCTS[p].name}</span>`).join('')}<span><i class="band"></i>±${tolPct}% tolerance</span></div>
      <div class="viz-host" id="vzDots"></div>
      <div class="hint">Each dot is one tank filled; below the line = short.</div>
    </div>
    <div class="card"><div class="sect-title">By truck <span class="hint">tap one to see only its trips</span></div>${groupTable(byVehicle(list), 'tt')}</div>
    <div class="card"><div class="sect-title">By product</div>${groupTable(byProduct(list), 'product')}</div>
    <div class="card"><div class="sect-title">By tank</div>${groupTable(byTank(list), 'tank')}</div>
    ${byMonth(list).length > 1 ? `<div class="card"><div class="sect-title">By month</div>${groupTable(byMonth(list), 'month')}</div>` : ''}`
    : '<div class="empty">No finished decantations in this period.</div>'}`;
  if (list.length) {
    const fmtVar = (v) => fmtSigned(v, ' L', 1);
    const fmts = { fmtL: (v) => fmtL(v), fmtVar, fmtPct, fmtDay: (k, long) => fmtIsoDay(k, long) };
    dailyVariation(el.querySelector('#vzDays'), days, fmts);
    variationDots(el.querySelector('#vzDots'), trend(list), {
      tolPct, colors: PRODUCT_COLOR, names: Object.fromEntries(Object.values(PRODUCTS).map((p) => [p.key, p.name])),
      fmtL: (v) => fmtL(v), fmtVar, fmtPct,
      fmtWhen: (t, span) => (span > 3 * 86400000 || span === 0 ? `${fmtIsoDay(istDate(t))}${span === 0 ? ` ${fmtTime(t)}` : ''}` : `${fmtIsoDay(istDate(t))} ${fmtTime(t)}`),
    });
  }
}

function dayTable(days) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th class="r">Tanks</th><th class="r">Decanted</th><th class="r">Variation</th><th class="r">%</th><th>Products</th></tr></thead><tbody>
    ${days.map((d) => `<tr><td>${fmtIsoDay(d.key)}</td><td class="r">${d.count}</td><td class="r">${fmtL(d.litres)}</td><td class="r">${fmtSigned(d.variation, ' L', 1)}</td><td class="r">${fmtPct(d.pct)}</td>
      <td>${Object.values(d.products).map((p) => `${productShort(p.key)} ${fmtSigned(p.variation, ' L')}`).join(' · ')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function groupTable(groups, kind) {
  const label = (g) => ({ tt: esc(g.key), product: productChip(g.key), tank: esc(tankName(g.key)), month: esc(fmtIsoDay(`${g.key}-01`, true).replace(/^1 /, '')) }[kind]);
  const maxPct = Math.max(0.5, ...groups.map((g) => Math.abs(g.pct)));
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>${{ tt: 'Truck', product: 'Product', tank: 'Tank', month: 'Month' }[kind]}</th>
    <th class="r">${kind === 'tt' ? 'Trips' : 'Fills'}</th><th class="r">Decanted</th><th class="r">Net</th><th class="r">%</th><th class="r">Short</th><th class="r">Flagged</th>${kind === 'tt' ? '<th>Last</th>' : ''}</tr></thead><tbody>
    ${groups.map((g) => `<tr ${kind === 'tt' ? `class="click${F.rep.tt === g.key ? ' sel' : ''}" data-tt="${esc(g.key)}"` : ''}>
      <td>${label(g)}</td><td class="r">${kind === 'tt' ? g.trips : g.count}</td><td class="r">${fmtKL(g.litres)}</td>
      <td class="r">${fmtSigned(g.variation, ' L')}</td>
      <td class="r">${fmtPct(g.pct)}<span class="minibar" aria-hidden="true"><i style="${g.pct < 0 ? `right:50%;width:${(Math.abs(g.pct) / maxPct) * 50}%;background:var(--viz-short)` : `left:50%;width:${(Math.abs(g.pct) / maxPct) * 50}%;background:var(--viz-excess)`}"></i></span></td>
      <td class="r">${fmtNum(-g.short)} L</td><td class="r">${g.flagged}</td>${kind === 'tt' ? `<td>${fmtIsoDay(g.last)}</td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}

function bindReports(el) {
  el.addEventListener('change', (e) => {
    const f = e.target.dataset.rf;
    if (!f) return;
    F.rep[f] = e.target.value;
    e.target.blur();
    renderReports(el);
  });
  el.addEventListener('click', (e) => {
    const row = e.target.closest('[data-tt]');
    if (!row) return;
    F.rep.tt = F.rep.tt === row.dataset.tt ? '' : row.dataset.tt;
    renderReports(el);
    el.scrollIntoView({ behavior: 'smooth' });
  });
}
