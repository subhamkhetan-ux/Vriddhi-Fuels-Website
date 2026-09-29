// The Log (every decantation of this month and last) and the Reports: per
// product what was decanted, what was bought and what is still on the road,
// then the variation by day, truck, product, tank and month.

import { PRODUCTS, istDate, pctOf, usedChambers } from './core.js';
import {
  PERIODS, byDay, byInvoice, byMonth, byProduct, byTank, byVehicle, daysBetween, decantedByProduct, entriesFrom, exportRows,
  filterEntries, localFrom, monthsBetween, periodRange, purchaseSummary, summarize, toCsv, trend, withOlder,
} from './report.js';
import { cloudHistory, cloudMonths, fetchMonth, loadHistory, loadMonths, monthFiles, saveConfig, state, tidyMonths } from './store.js';
import { KEEP_OPTIONS, fileName, keepFrom, logSheets, monthCounts, monthName } from './archive.js';
import {
  PRODUCT_COLOR, bandBadge, download, esc, fmtDate, fmtIsoDay, fmtKL, fmtL, fmtMoney, fmtNum, fmtPct, fmtSigned, fmtTime, productChip,
  productShort, toast,
} from './ui.js';
import { dailyVariation, variationDots } from './charts.js';
import { compactNos, layoutFor, tankName } from './app.js';
import { openWizard } from './wizard.js';

const F = {
  log: { period: 'week', tt: '', product: '', q: '', showCancelled: false },
  rep: { period: 'month', from: '', to: '', tt: '', product: '' },
};

const LOG_PERIODS = [['today', 'Today'], ['week', '7 days'], ['month', 'This month'], ['lastmonth', 'Last month']];

const today = () => istDate(Date.now());
// 'YYYY-MM' -> 'Apr' (or 'Apr 2026')
function fmtMonth(key, long = false) {
  const s = fmtIsoDay(`${key}-01`, true).replace(/^1 /, '');
  return long ? s : s.replace(/ \d{4}$/, '');
}

function vehicleOptions(tts, sel) {
  const list = [...new Set(tts.filter(Boolean))].sort();
  return `<option value="">All trucks</option>${list.map((t) => `<option value="${esc(t)}" ${t === sel ? 'selected' : ''}>${esc(t)}</option>`).join('')}`;
}
function productOptions(sel) {
  return `<option value="">All products</option>${Object.values(PRODUCTS).map((p) => `<option value="${p.key}" ${p.key === sel ? 'selected' : ''}>${p.name}</option>`).join('')}`;
}

function exportEntries(list, name, kind) {
  const rows = exportRows([...list].reverse());
  if (kind === 'csv') {
    download(new Blob([`﻿${toCsv(rows)}`], { type: 'text/csv' }), `${name}.csv`);
  } else {
    import('./xlsx.js').then(({ buildXlsx }) => {
      download(buildXlsx('Decanting', rows, [11, 7, 13, 13, 8, 8, 14, 12, 14, 14, 12, 12, 12, 11, 11, 30, 30, 16]), `${name}.xlsx`);
    }).catch((err) => toast(`Couldn't make the file: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

let logBound = null;

function logList() {
  const all = entriesFrom(state.sessions, state.settings);
  const [from, to] = periodRange(F.log.period, today());
  return { all, from, to, list: filterEntries(all, { from, to, tt: F.log.tt, product: F.log.product }) };
}

export function renderLog(el) {
  if (logBound !== el) { bindLog(el); logBound = el; }
  const { all, list: inPeriod } = logList();
  const q = F.log.q.trim().toUpperCase();
  const list = inPeriod.filter((e) => !q || e.tt.includes(q) || String(e.invoiceNo).toUpperCase().includes(q));
  const sum = summarize(list);
  const days = byDay(list);
  const cancelled = state.sessions.filter((s) => s.status === 'cancelled');
  el.innerHTML = `${filesCard()}
    <div class="filters">
      <div class="seg" role="group" aria-label="Period">${LOG_PERIODS
        .map(([k, l]) => `<button class="${F.log.period === k ? 'on' : ''}" data-lp="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="filters">
      <select data-lf="tt" aria-label="Truck">${vehicleOptions(all.map((e) => e.tt), F.log.tt)}</select>
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
      ${byInvoice(d.entries).map(logCard).join('')}`).join('')
    : '<div class="empty">Nothing in this period. Older months are in Reports, and in the monthly log files.</div>'}
    ${cancelled.length ? `<h2 style="cursor:pointer" data-cancelled>${F.log.showCancelled ? '▾' : '▸'} Cancelled <span class="count">${cancelled.length}</span></h2>
      ${F.log.showCancelled ? cancelled.map((s) => `<button class="lrow" data-open="${esc(s.id)}"><span class="tm">${fmtIsoDay(istDate(s.created_at))}</span>
        <span class="mid"><b>${esc(s.tt_no || '')}</b><div>${esc(s.data?.cancelReason || '')}</div></span><span class="rt"></span></button>`).join('') : ''}` : ''}`;
}

// The monthly log files: each finished month's records as an Excel file — to
// keep, and for the Excel workbook that rebuilds the reports. The Log tab's
// badge counts the ones to download.
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function filesCard() {
  loadMonths();                                        // does nothing while fresh
  const files = monthFiles();
  // this month so far (not a month's file yet: for a look in Excel before it ends)
  const now = today().slice(0, 7);
  const cur = monthCounts(state.sessions, state.invoices)[now];
  const soFar = cur && (cur.sessions || cur.invoices) ? `<div class="file-row">
      <div class="mid">${monthName(now)} <span class="hint">so far</span><div class="hint">${plural(cur.sessions, 'decantation')} · ${plural(cur.invoices, 'invoice')} · its file comes on the 1st</div></div>
      <button class="btn sm" data-month="${now}" data-sofar="1">⬇ So far</button></div>` : '';
  if (!files.length && !soFar) return '';
  const due = files.filter((f) => f.state === 'new' || f.state === 'changed');
  const rest = files.filter((f) => !due.includes(f)).reverse();
  const keep = (KEEP_OPTIONS.find(([k]) => k === state.settings.keep) || KEEP_OPTIONS[0])[1];
  const what = (f) => [plural(f.sessions, 'decantation'), plural(f.invoices, 'invoice'), f.open ? `${f.open} still open` : ''].filter(Boolean).join(' · ');
  return `<div class="card files${due.length ? ' due' : ''}">
    <div class="sect-title">📥 Monthly log files${due.length ? ` <span class="count">${due.length} to download</span>` : ''}</div>
    ${due.map((f) => `<div class="file-row">
      <div class="mid"><b>${monthName(f.month)}</b><div class="hint">${what(f)}${f.state === 'changed' ? ` · <b style="color:var(--warn)">changed since its file of ${fmtDate(f.file.at)} — download it again</b>` : ''}</div></div>
      <button class="btn sm" data-month="${f.month}">⬇ Excel</button></div>`).join('')}
    ${soFar}
    ${rest.length ? `<details class="files-done"${due.length ? '' : ' open'}><summary class="hint">Downloaded (${rest.length})</summary>
      ${rest.map((f) => `<div class="file-row"><div class="mid">${monthName(f.month)} <span class="hint">· ${fmtDate(f.file.at, true)}${f.file.by ? ` by ${esc(f.file.by)}` : ''}${f.state === 'cleared' ? ' · cleared from the cloud' : ''}</span></div>
        ${f.state === 'cleared' ? '' : `<button class="btn sm" data-month="${f.month}" aria-label="Download ${monthName(f.month)} again">⬇</button>`}</div>`).join('')}</details>` : ''}
    <div class="hint" style="margin-top:6px">The cloud keeps ${esc(keep.toLowerCase())} (Settings). An older month is cleared from it once its file is downloaded — never before.</div>
  </div>`;
}

async function downloadMonth(m, el, soFar = false) {
  const btn = el.querySelector(`[data-month="${m}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const { sessions, invoices } = await fetchMonth(m);
    const { buildWorkbook } = await import('./xlsx.js');
    const madeAt = new Date().toISOString();
    const by = state.device.operator || '';
    download(buildWorkbook(logSheets({
      month: m, sessions, invoices, known: [...state.sessions, ...sessions], settings: state.settings, madeAt, madeBy: by, tanks: state.settings.tanks, soFar,
    })), fileName(m, soFar));
    if (soFar) {                                       // not the month's file: nothing recorded, nothing cleared
      toast(`${monthName(m)} so far: saved to this phone's downloads.`);
      renderLog(el);
      return;
    }
    const last = monthCounts(sessions, invoices)[m]?.updated || madeAt;
    await saveConfig({ archive: { ...(state.config.archive || {}), [m]: { at: madeAt, by, s: sessions.length, i: invoices.length, u: last } } });
    toast(`${monthName(m)}: saved to this phone's downloads.`);
    tidyMonths();                                      // past what the cloud keeps? then it's cleared now
  } catch (e) {
    toast(`Couldn't make the file: ${e.message || e}`, 5000);
    renderLog(el);
  }
}

// One card per invoice: the truck, and a line per tank it filled. The card
// opens the decantation; an invoice decanted in more than one go opens each
// go from its own lines.
function logCard(g) {
  const many = g.sessions.length > 1;
  const open = (id) => ` data-open="${esc(id)}" role="button" tabindex="0"`;
  const lines = g.entries.map((e) => `<div class="lc-line"${many ? open(e.sessionId) : ''}>
      <div class="mid">${many ? `<span class="tm">${fmtTime(e.at)}</span> ` : ''}${productChip(e.product)} ${tankName(e.tank)} · C${compactNos(e.chambers)} · ${fmtL(e.litres)}${e.beforeFrom?.proof === false || e.afterFrom?.proof === false ? ' <span class="np">✎ typed stock, no proof</span>' : ''}</div>
      <span class="rt"><b${e.variation > 0 ? ' class="pos"' : ''}>${fmtSigned(e.variation, ' L', 1)}</b><span class="hint">${fmtPct(e.pct)}</span><span class="rt-badge">${bandBadge(e.band, e.direction)}</span></span>
    </div>`).join('');
  return `<div class="lrow lcard"${many ? '' : open(g.sessions[0])}>
    <div class="lc-head"><span class="tm">${fmtTime(g.at)}</span>
      <span class="mid"><b>${esc(g.tt)}</b> <span class="hint">${esc(g.invoiceNo)}</span></span>
      ${g.entries.length > 1 ? `<span class="rt"><b${g.variation > 0 ? ' class="pos"' : ''}>${fmtSigned(g.variation, ' L', 1)}</b><span class="hint">${fmtPct(g.pct)} · ${fmtKL(g.litres)}</span></span>` : ''}</div>
    ${lines}
  </div>`;
}

function bindLog(el) {
  el.addEventListener('keydown', (e) => {
    const o = (e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-open][role="button"]') ? e.target : null;
    if (o) { e.preventDefault(); openWizard(o.dataset.open); }
  });
  el.addEventListener('click', (e) => {
    const t = e.target;
    const p = t.closest('[data-lp]');
    if (p) { F.log.period = p.dataset.lp; renderLog(el); return; }
    const o = t.closest('[data-open]');
    if (o) { openWizard(o.dataset.open); return; }
    const mo = t.closest('[data-month]');
    if (mo) { downloadMonth(mo.dataset.month, el, Boolean(mo.dataset.sofar)); return; }
    if (t.closest('[data-cancelled]')) { F.log.showCancelled = !F.log.showCancelled; renderLog(el); return; }
    const x = t.closest('[data-export]');
    if (x) {
      const { from, to, list } = logList();
      exportEntries(list, `Decanting ${from} to ${to}${F.log.tt ? ` ${F.log.tt}` : ''}`, x.dataset.export);
    }
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

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

let repBound = null;

// The oldest day the reports reach: what the cloud keeps (Settings), or its
// oldest month still there if older (a month stays until its file is saved).
function oldestDay(t) {
  const keep = `${keepFrom(t, state.settings.keep)}-01`;
  const first = Object.keys(cloudMonths.counts || {}).sort()[0];
  return first && `${first}-01` < keep ? `${first}-01` : keep;
}

// Everything the Reports need for the chosen period: the phone's months plus,
// when the period reaches further back, the older ones from the cloud.
function reportData() {
  const t = today();
  const kept = oldestDay(t);
  const [f0, to] = periodRange(F.rep.period, t, { from: F.rep.from, to: F.rep.to });
  const from = !f0 || f0 < kept ? kept : f0;
  const older = from < localFrom(t);
  if (older) loadHistory();                 // does nothing while fresh
  const sessions = older ? withOlder(state.sessions, cloudHistory.sessions, 'id') : state.sessions;
  const invoices = older ? withOlder(state.invoices, cloudHistory.invoices, 'invoice_no') : state.invoices;
  const all = entriesFrom(sessions, state.settings);
  const list = filterEntries(all, { from, to, tt: F.rep.tt, product: F.rep.product });
  const buy = purchaseSummary(invoices, sessions, { from, to, tt: F.rep.tt, product: F.rep.product });
  return { t, kept, f0, from, to, older, sessions, invoices, all, list, buy };
}

function historyNote(older) {
  if (!older) return '';
  return {
    loading: ' · <b style="color:var(--ink)">fetching the older months from the cloud…</b>',
    error: ` · couldn't fetch the older months (${esc(cloudHistory.error)}) <button class="btn sm" data-rehist>↻ Try again</button>`,
    off: ' · only this phone\'s months (the cloud isn\'t set up)',
    offline: ' · offline — only this phone\'s months',
  }[cloudHistory.status] || '';
}

export function renderReports(el) {
  if (repBound !== el) { bindReports(el); repBound = el; }
  const { t, kept, f0, from, to, older, sessions, invoices, all, list, buy } = reportData();
  const sum = summarize(list);
  const periodSel = PERIODS.map(([k, l]) => `<option value="${k}" ${F.rep.period === k ? 'selected' : ''}>${l}</option>`).join('');
  const monthly = daysBetween(from, to).length > 62;
  const cols = monthly
    ? monthsBetween(from, to).map((key) => byMonth(list).find((m) => m.key === key) || { key, variation: 0, litres: 0, count: 0, pct: 0 })
    : daysBetween(from, to).map((key) => byDay(list).find((d) => d.key === key) || { key, variation: 0, litres: 0, count: 0, pct: 0 });
  const tolPct = state.settings.tolerancePct;
  el.innerHTML = `
    <div class="filters">
      <select data-rf="period" aria-label="Period">${periodSel}</select>
      ${F.rep.period === 'custom' ? `<input type="date" data-rf="from" value="${from}" min="${kept}" max="${to}" style="width:auto"><input type="date" data-rf="to" value="${to}" min="${from}" max="${t}" style="width:auto">` : ''}
      <select data-rf="tt" aria-label="Truck">${vehicleOptions([...all.map((e) => e.tt), ...invoices.map((i) => i.tt_no)], F.rep.tt)}</select>
      <select data-rf="product" aria-label="Product">${productOptions(F.rep.product)}</select>
      <button class="btn sm" data-rexport ${list.length ? '' : 'disabled'}>⬇ Excel</button>
    </div>
    <div class="hint" style="margin:-4px 2px 10px">${fmtIsoDay(from, true)} – ${fmtIsoDay(to, true)}${F.rep.tt ? ` · ${esc(F.rep.tt)}` : ''}${F.rep.product ? ` · ${PRODUCTS[F.rep.product].name}` : ''}${F.rep.period === 'all' || f0 < kept ? ' · all the cloud keeps — older months are in the monthly log files' : ''}${historyNote(older)}</div>
    ${productCards(list, buy, sessions)}
    <h2>Variation <span class="count">tank gain vs the chambers</span></h2>
    ${list.length ? `
    <div class="kpis">
      <div class="kpi"><div class="k">Decanted</div><div class="v">${fmtKL(sum.litres)}</div><div class="s">${sum.trips} decantation${sum.trips === 1 ? '' : 's'} · ${sum.count} tank fill${sum.count === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="k">Net variation</div><div class="v${sum.variation > 0 ? ' pos' : ''}">${fmtSigned(sum.variation, ' L')}</div><div class="s">${fmtPct(sum.pct)} of decanted</div></div>
      <div class="kpi"><div class="k">Short / excess</div><div class="v">${fmtNum(-sum.short)} / ${fmtNum(sum.excess)} L</div><div class="s">tank got less / more</div></div>
      <div class="kpi"><div class="k">Outside tolerance</div><div class="v">${sum.flagged} of ${sum.count}</div><div class="s">±${tolPct}% or ±${state.settings.toleranceMinL} L</div></div>
      <div class="kpi"><div class="k">At invoice price</div><div class="v">${fmtMoney(sum.value)}</div><div class="s">net value of the variation</div></div>
      <div class="kpi"><div class="k">Worst</div><div class="v">${sum.worst ? fmtPct(sum.worst.pct) : '—'}</div><div class="s">${sum.worst ? `${esc(sum.worst.tt)} · ${fmtIsoDay(sum.worst.day)} · ${tankName(sum.worst.tank)}` : ''}</div></div>
    </div>
    <div class="card">
      <div class="sect-title">Net variation per ${monthly ? 'month' : 'day'}</div>
      <div class="legend"><span><i class="sq" style="background:var(--viz-short)"></i>Short (tank got less than the chambers held)</span><span><i class="sq" style="background:var(--viz-excess)"></i>Excess</span></div>
      <div class="viz-host" id="vzDays"></div>
      <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">${monthly ? 'Month by month' : 'Day by day'} table</summary>${monthly ? groupTable(byMonth(list), 'month') : dayTable(byDay(list))}</details>
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
    ${!monthly && byMonth(list).length > 1 ? `<div class="card"><div class="sect-title">By month</div>${groupTable(byMonth(list), 'month')}</div>` : ''}`
    : `<div class="empty">No finished decantations in this period${older && cloudHistory.status === 'loading' ? ' yet — still fetching the older months' : ''}.</div>`}`;
  if (list.length) {
    const fmtVar = (v) => fmtSigned(v, ' L', 1);
    const fmtDay = (k, long) => (k.length === 7 ? fmtMonth(k, long) : fmtIsoDay(k, long));
    dailyVariation(el.querySelector('#vzDays'), cols, { fmtL: (v) => fmtL(v), fmtVar, fmtPct, fmtDay, label: `Net variation per ${monthly ? 'month' : 'day'}` });
    variationDots(el.querySelector('#vzDots'), trend(list), {
      tolPct, colors: PRODUCT_COLOR, names: Object.fromEntries(Object.values(PRODUCTS).map((p) => [p.key, p.name])),
      fmtL: (v) => fmtL(v), fmtVar, fmtPct,
      fmtWhen: (tm, span) => (span > 3 * 86400000 || span === 0 ? `${fmtIsoDay(istDate(tm))}${span === 0 ? ` ${fmtTime(tm)}` : ''}` : `${fmtIsoDay(istDate(tm))} ${fmtTime(tm)}`),
    });
  }
}

// One card per product: decanted in the period (by the day it went into the
// tank), and purchased (by invoice date) split into decanted in the app,
// decanted outside it, and still on the truck — with the trucks in transit.
function productCards(list, buy, sessions) {
  const dec = decantedByProduct(list);
  const keys = Object.keys(PRODUCTS).filter((p) => (!F.rep.product || p === F.rep.product)
    && (state.settings.tanks.some((t) => t.product === p) || dec[p].litres > 0 || buy.byProduct[p].purchased > 0));
  if (!keys.length) return '';
  return `<div class="psum-grid">${keys.map((p) => productCard(p, dec[p], buy.byProduct[p], buy.transit, list, sessions)).join('')}</div>`;
}

function productCard(p, d, b, transit, list, sessions) {
  const trucks = new Set(list.filter((e) => e.product === p).map((e) => e.sessionId)).size;
  const rows = transit.filter((x) => x.products.some((y) => y.product === p));
  const parts = [['dec', 'Decanted in the app', b.decanted], ['out', 'Decanted outside the app', b.outside], ['tr', 'In transit', b.transit]];
  const shown = parts.filter(([k, , v]) => v > 0 || k !== 'out');
  return `<div class="card psum" style="--pc:${PRODUCT_COLOR[p]}">
    <div class="psum-head">${productChip(p)}<span class="sp"></span><span class="hint">${trucks ? `${trucks} truck${trucks === 1 ? '' : 's'} · ${d.count} tank fill${d.count === 1 ? '' : 's'}` : 'none decanted'}</span></div>
    <div class="psum-big">${fmtKL(d.litres)}</div>
    <div class="psum-sub">decanted${d.count ? ` · net variation <b>${fmtSigned(d.variation, ' L')}</b> (${fmtPct(pctOf(d.variation, d.litres))})` : ''}</div>
    <div class="psum-buy"><span>Purchased <span class="hint">by invoice date</span></span><b>${fmtKL(b.purchased)}</b></div>
    ${b.purchased ? `<div class="pbar" role="img" aria-label="${esc(shown.map(([, l, v]) => `${l} ${fmtKL(v)}`).join(', '))}">
        ${parts.filter(([, , v]) => v > 0).map(([k, , v]) => `<i class="s-${k}" style="flex:${v} 1 0"></i>`).join('')}</div>
      <div class="plegend">${shown.map(([k, l, v]) => `<span><i class="s-${k}"></i>${l} <b>${fmtKL(v)}</b></span>`).join('')}</div>`
    : '<div class="hint" style="margin-top:4px">No invoices dated in this period.</div>'}
    ${rows.length ? `<div class="psum-tr"><div class="k">In transit — invoiced, not decanted yet</div>${rows.map((x) => transitRow(x, p, sessions)).join('')}</div>` : ''}
  </div>`;
}

function transitRow(x, p, sessions) {
  const y = x.products.find((q) => q.product === p);
  const inv = x.invoice;
  let nos = [];
  if (inv.chambers?.length || (inv.lines || []).some((l) => l.compartments?.length)) {
    const used = usedChambers(sessions, inv.invoice_no);
    nos = layoutFor(inv).chambers.filter((c) => c.product === p && c.litres > 0 && !used.has(c.no)).map((c) => c.no);
  }
  const days = x.day ? Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${x.day}T00:00:00Z`)) / 86400000) : 0;
  const stale = !x.partial && !y.decanting && days > state.settings.pendingDays;
  const badge = y.decanting ? '<span class="badge watch"><i>●</i>Decanting now</span>'
    : x.partial ? '<span class="badge watch"><i>◐</i>Rest of a part-decanted load</span>'
      : stale ? `<span class="badge high"><i>!</i>${days} days old</span>` : '<span class="badge info">On the way</span>';
  return `<div class="tr-row">
    <div class="tr-top"><b>${esc(x.tt || 'Unknown truck')}</b><b class="num">${fmtKL(y.litres)}</b>${nos.length ? `<span class="hint">C${compactNos(nos)}</span>` : ''}<span class="sp"></span>${badge}</div>
    <div class="hint">Invoice ${esc(inv.invoice_no)} · ${esc(inv.invoice_date || fmtIsoDay(x.day))}${x.time ? ` ${esc(x.time)}` : ''}${stale ? ' · if it was decanted outside the app, hide it from its ⋯ menu on the Decant tab' : ''}</div>
  </div>`;
}

function dayTable(days) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th class="r">Tanks</th><th class="r">Decanted</th><th class="r">Variation</th><th class="r">%</th><th>Products</th></tr></thead><tbody>
    ${days.map((d) => `<tr><td>${fmtIsoDay(d.key)}</td><td class="r">${d.count}</td><td class="r">${fmtL(d.litres)}</td><td class="r">${fmtSigned(d.variation, ' L', 1)}</td><td class="r">${fmtPct(d.pct)}</td>
      <td>${Object.values(d.products).map((p) => `${productShort(p.key)} ${fmtSigned(p.variation, ' L')}`).join(' · ')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function groupTable(groups, kind) {
  const label = (g) => ({ tt: esc(g.key), product: productChip(g.key), tank: esc(tankName(g.key)), month: esc(fmtMonth(g.key, true)) }[kind]);
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
    if (e.target.closest('[data-rehist]')) {
      cloudHistory.status = 'idle';
      cloudHistory.at = 0;
      loadHistory();
      return;
    }
    if (e.target.closest('[data-rexport]')) {
      const { from, to, list } = reportData();
      exportEntries(list, `Decanting ${from} to ${to}${F.rep.tt ? ` ${F.rep.tt}` : ''}`, 'xlsx');
      return;
    }
    const row = e.target.closest('[data-tt]');
    if (!row) return;
    F.rep.tt = F.rep.tt === row.dataset.tt ? '' : row.dataset.tt;
    renderReports(el);
    el.scrollIntoView({ behavior: 'smooth' });
  });
}
