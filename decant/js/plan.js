// The Plan tab: make room for the loads that are coming.
//   1. Stock now — the latest reading of each tank (after the last decanting
//      or screenshot), which can be updated here.
//   2. Coming next — trucks already invoiced but not decanted (in transit),
//      and the loads ordered next (indent + the tanker bringing it).
//   3. What to sell first — per tank, the litres to dispense before each load
//      arrives so all its chambers go in (keeping the safety margin).
//   4. Our tankers — how much diesel our own tankers (Loading app) can take.

import { PRODUCTS, dipAtLitres, planAhead, round2, tankerSpace, usedChambers } from './core.js';
import { dismissReason, invoiceDay, purchaseSummary } from './report.js';
import { newId, saveConfig, saveTankReading, state } from './store.js';
import { initTankers, onTankers, refreshTankers, retryTankers, tankers, tankersSignIn, tankersSignOut } from './tankers.js';
import {
  ago, ask, closeSheet, esc, fmtDip, fmtKL, fmtL, fmtWhen, openSheet, productChip, productShort, toast, truckStrip,
} from './ui.js';
import { compactNos, layoutFor, readScreenshot, render, tankName, tanks, typedReading } from './app.js';

const OFF_KEY = 'vriddhi-decant-plan-off';         // loads left out of the sums on this phone
let bound = null;
const typed = {};                                  // tank id -> {kind: 'l' | 'd', value} not saved yet
let stockEdit = false;                             // the stock card shows its typing boxes

function offSet() {
  try { return new Set(JSON.parse(localStorage.getItem(OFF_KEY) || '[]')); } catch { return new Set(); }
}
function setOff(id, off) {
  const s = offSet();
  if (off) s.add(id); else s.delete(id);
  try { localStorage.setItem(OFF_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

const invAt = (inv) => Date.parse(`${invoiceDay(inv)}T${inv.invoice_time || '00:00'}:00+05:30`) || Date.parse(inv.created_at || 0) || 0;

// Loads ordered next, from the shared settings. One whose truck has since been
// invoiced — a new invoice for that truck, not one already in the app when the
// load was added (the truck may still be on its previous trip) — is followed
// as that invoice instead. Each invoice answers for one ordered load.
function orderedLoads() {
  const all = [...(state.config.plannedLoads || [])].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const open = [];
  const invoiced = [];
  const taken = new Set();
  for (const l of all) {
    const made = Date.parse(l.created_at || 0) - 12 * 3600000;
    const known = new Set(l.known || []);
    const inv = state.invoices
      .filter((i) => i.tt_no === l.tt_no && !known.has(i.invoice_no) && !taken.has(i.invoice_no) && invAt(i) >= made
        && !(i.dismissed && dismissReason(i) !== 'outside'))
      .sort((a, b) => invAt(a) - invAt(b))[0];
    if (inv) { taken.add(inv.invoice_no); invoiced.push({ load: l, inv }); } else open.push(l);
  }
  return { open, invoiced };
}

// Everything coming, in arrival order: the trucks invoiced but not decanted
// (their chambers not decanted yet), then the loads ordered next. An invoice
// older than "Show undecanted invoices from the last (days)" isn't counted —
// it was most likely decanted outside the app.
export function comingLoads() {
  const cutoff = Date.now() - state.settings.pendingDays * 86400000;
  const transit = [];
  let older = 0;
  for (const t of purchaseSummary(state.invoices, state.sessions, {}).transit) {
    const inv = t.invoice;
    if (!t.partial && !t.decanting && invAt(inv) < cutoff) { older += 1; continue; }
    const used = usedChambers(state.sessions, inv.invoice_no);
    const chambers = layoutFor(inv).chambers
      .filter((c) => c.product && PRODUCTS[c.product] && c.litres > 0 && !used.has(c.no))
      .map((c) => ({ no: c.no, litres: c.litres, product: c.product }));
    if (chambers.length) transit.push({ id: `inv:${inv.invoice_no}`, kind: 'transit', tt: inv.tt_no, inv, chambers, partial: t.partial, at: invAt(inv) });
  }
  transit.sort((a, b) => a.at - b.at);
  const { open, invoiced } = orderedLoads();
  const ordered = open.map((l) => ({ id: `ord:${l.id}`, kind: 'ordered', tt: l.tt_no, load: l, chambers: (l.chambers || []).filter((c) => c.product && c.litres > 0) }))
    .sort((a, b) => ((a.load.expected || '9') < (b.load.expected || '9') ? -1 : 1));
  const decanting = state.sessions.filter((s) => ['decanting', 'settling'].includes(s.status));
  return { transit, ordered, invoiced, decanting, older };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderPlan(el) {
  if (bound !== el) {
    bind(el);
    bound = el;
    initTankers();
    onTankers(() => { if (!el.hidden) render(); });
  }
  const { transit, ordered, invoiced, decanting, older } = comingLoads();
  const off = offSet();
  const loads = [...transit, ...ordered].filter((l) => !off.has(l.id));
  const res = planAhead({ loads, tanks: tanks(), stock: state.tankState, margin: state.settings.warnRoomL });
  const space = tankerSpace(tankers.vehicles, state.settings.excludeTankers || []);
  el.innerHTML = `
    ${stockCard()}
    <h2>Coming next <span class="count">${transit.length + ordered.length}</span></h2>
    ${older ? `<div class="hint" style="margin:-4px 4px 10px">${older} older invoice${older === 1 ? '' : 's'} not decanted in the app ${older === 1 ? 'isn\'t' : 'aren\'t'} counted (from before the last ${state.settings.pendingDays} days) — hide ${older === 1 ? 'it' : 'them'} on the Decant tab if already decanted.</div>` : ''}
    ${decanting.length ? `<div class="banner">${decanting.map((s) => esc(s.tt_no)).join(', ')} ${decanting.length === 1 ? 'is' : 'are'} being decanted now — update the stock when it's done.</div>` : ''}
    ${invoiced.length ? `<div class="banner">${invoiced.map((x) => `The load you ordered on <b>${esc(x.load.tt_no)}</b> has come in as invoice ${esc(x.inv.invoice_no)}`).join('; ')} — it's followed as that invoice now, not as ordered. <button class="btn sm" data-clearinvoiced>OK</button></div>` : ''}
    <div class="card">
      ${transit.length || ordered.length ? '' : '<div class="empty" style="margin-bottom:10px">Nothing on the way. Add what you\'ve ordered next — the indent and the tanker bringing it.</div>'}
      ${transit.map((l) => loadRow(l, off)).join('')}
      ${ordered.map((l) => loadRow(l, off)).join('')}
      <div class="row-actions" style="justify-content:flex-start"><button class="cta sm" data-addload>＋ Add what you've ordered</button></div>
    </div>
    ${loads.length ? '<h2>Make room for it</h2>' : ''}
    ${Object.keys(PRODUCTS).map((p) => productPlan(p, loads, res, space)).join('')}
    ${res.missing.length ? `<div class="banner">No stock for ${res.missing.map(tankName).join(', ')} yet — add it under <b>Stock now</b>.</div>` : ''}
    ${tankersCard(space)}`;
}

function stockCard() {
  const editing = stockEdit || Object.keys(typed).length > 0;
  return `<div class="card">
    <div class="sect-title">Stock now <span class="sp" style="flex:1"></span>
      ${editing ? '' : '<button class="btn sm" data-stedit>✎ Type</button>'}<button class="btn sm" data-shotstock>📷 Screenshot</button></div>
    <div class="hint" style="margin:-4px 0 6px">${editing ? 'Type the new stock in litres or as a dip — the rest of the plan follows.' : 'Each tank\'s latest reading — after the last decanting or screenshot.'}</div>
    ${editing ? '<div class="st-row st-head"><span></span><span>litres</span><span>dip cm</span></div>' : ''}
    <div class="st-list">${tanks().map((t) => {
      const r = state.tankState[t.id];
      const dip = r ? (Number.isFinite(r.dip) ? r.dip : dipAtLitres(state.chart, r.volume)) : null;
      const name = `<div class="st-name"><div class="pt-name">Tank ${t.no} ${productChip(t.product)}</div>
        <div class="hint">${r ? `${srcText(r)} · ${ago(r.readingAt)}` : 'No reading yet'}</div></div>`;
      if (!editing) {
        return `<div class="st-row">${name}
          <div class="st-v"><b>${r ? fmtL(r.volume) : '—'}</b><span>${r ? fmtDip(dip) : 'stock'}</span></div>
          <div class="st-v"><b>${r ? fmtL(r.ullage) : '—'}</b><span>room</span></div></div>`;
      }
      const d = typed[t.id];
      return `<div class="st-row edit">${name}
        <input type="number" inputmode="decimal" step="1" min="0" data-stl="${t.id}" value="${d?.kind === 'l' ? esc(d.value) : ''}" placeholder="${r ? Math.round(r.volume) : 'litres'}" aria-label="Tank ${t.no} stock in litres">
        <input type="number" inputmode="decimal" step="0.1" min="0" data-std="${t.id}" value="${d?.kind === 'd' ? esc(d.value) : ''}" placeholder="${Number.isFinite(dip) ? dip.toFixed(1) : 'dip cm'}" aria-label="Tank ${t.no} dip in cm">
      </div>`;
    }).join('')}</div>
    ${editing ? `<div class="hint" data-sthint style="margin-top:6px">${esc(stockHint())}</div>
      <div class="row-actions"><button class="btn ghost" data-stcancel>Cancel</button><button class="cta sm" data-savestock ${Object.keys(typed).length ? '' : 'disabled'}>Save new stock</button></div>` : ''}
  </div>`;
}

// What the typed figures come to ("Tank 2: 14,974 L (118.4 cm)").
function stockHint() {
  return Object.entries(typed).map(([tid, d]) => {
    try {
      const r = typedReading(tid, d.kind === 'd' ? { dipCm: Number(d.value) } : { litres: Number(d.value) });
      return `${tankName(tid)}: ${fmtL(r.volume)} (${fmtDip(r.dip)})`;
    } catch (err) { return `${tankName(tid)}: ${err.message}`; }
  }).join(' · ');
}

function srcText(r) {
  return { photo: 'screenshot', 'photo-edited': 'screenshot (corrected)', litres: 'typed in', dip: 'from a dip' }[r.source] || 'reading';
}

function loadRow(l, off) {
  const on = !off.has(l.id);
  const byP = {};
  for (const c of l.chambers) (byP[c.product] ||= []).push(c);
  const prods = Object.entries(byP).map(([p, cs]) => productChip(p, `${fmtKL(cs.reduce((a, c) => a + c.litres, 0))} · C${compactNos(cs.map((c) => c.no))}`)).join(' ');
  const meta = l.kind === 'transit'
    ? `Invoice ${esc(l.inv.invoice_no)} · ${esc(l.inv.invoice_date || '')} ${esc(l.inv.invoice_time || '')}${l.partial ? ' · the rest of a part-decanted load' : ''}`
    : `${l.load.expected ? `Expected ${esc(fmtExpected(l.load.expected))}` : 'Not invoiced yet'}${l.load.note ? ` · ${esc(l.load.note)}` : ''}`;
  return `<div class="load-row${on ? '' : ' off'}">
    <label class="load-on"><input type="checkbox" data-loadon="${esc(l.id)}" ${on ? 'checked' : ''} aria-label="Count ${esc(l.tt)} in the plan"></label>
    <div class="load-mid"><div><b>${esc(l.tt)}</b> <span class="badge ${l.kind === 'transit' ? 'watch' : 'info'}">${l.kind === 'transit' ? 'In transit' : 'Ordered'}</span></div>
      <div class="hint">${meta}</div><div class="inv-prods" style="margin:6px 0 0">${prods}</div></div>
    ${l.kind === 'ordered' ? `<div class="load-act"><button class="btn sm" data-editload="${esc(l.load.id)}" aria-label="Edit">✎</button><button class="btn sm ghost" data-delload="${esc(l.load.id)}" aria-label="Remove">✕</button></div>` : ''}
  </div>`;
}

function fmtExpected(v) {
  const t = Date.parse(v.length <= 10 ? `${v}T00:00:00+05:30` : `${v}:00+05:30`);
  return Number.isFinite(t) ? (v.length <= 10 ? fmtWhen(t).replace(/ 00:00$/, '') : fmtWhen(t)) : v;
}

function productPlan(p, loads, res, space) {
  const ts = tanks().filter((t) => t.product === p);
  if (!ts.length) return '';
  const pr = res.products[p];
  const coming = loads.filter((l) => l.chambers.some((c) => c.product === p));
  if (!coming.length) return '';
  const sell = pr?.sell || 0;
  const head = sell > 0
    ? `<span class="badge high"><i>↓</i>Dispense ${fmtL(sell)} first</span>`
    : `<span class="badge ok"><i>✓</i>Room for all of it</span>`;
  const rows = ts.map((t) => {
    const row = res.tanks[t.id];
    if (!row) return `<div class="plan-tank" style="grid-template-columns:1fr"><div><div class="pt-name">Tank ${t.no}</div><div class="pt-sub">No stock reading — add it above.</div></div></div>`;
    const parts = [];
    res.loads.forEach((lr, i) => {
      const nos = Object.entries(lr.split).filter(([, id]) => id === t.id).map(([no]) => Number(no));
      if (!nos.length) return;
      const l = loads[i];
      const litres = l.chambers.filter((c) => nos.includes(c.no)).reduce((a, c) => a + c.litres, 0);
      const s = lr.sell[t.id] || 0;
      parts.push(`<li>C${compactNos(nos)} of <b>${esc(l.tt)}</b>${l.kind === 'ordered' ? ' (ordered)' : ''} · ${fmtKL(litres)} → ${s > 0 ? `<b class="sell">dispense ${fmtL(s)}</b> before it comes` : 'fits'}</li>`);
    });
    const afterDip = dipAtLitres(state.chart, row.after);
    return `<div class="plan-tank" style="grid-template-columns:minmax(0,1fr) auto">
      <div><div class="pt-name">Tank ${t.no}</div>
        <div class="pt-sub">Now <b>${fmtL(row.now)}</b> · room <b>${fmtL(row.room)}</b>${parts.length ? '' : ' · nothing planned in'}</div>
        ${parts.length ? `<ul class="plan-parts">${parts.join('')}</ul>` : ''}
        ${row.incoming ? `<div class="pt-sub">After: <b>${fmtL(row.after)}</b> (${fmtDip(afterDip)}) · room left ${fmtL(row.spare)}</div>` : ''}</div>
      <div class="plan-sell${row.sell > 0 ? ' need' : ''}"><b>${row.sell > 0 ? fmtL(row.sell) : '0 L'}</b><span>to dispense</span></div>
    </div>`;
  }).join('');
  let tankerLine = '';
  if (p === 'HSD' && sell > 0) {
    if (tankers.status === 'live') {
      const enough = space.free >= sell;
      const some = space.rows.filter((r) => r.free > 0);
      tankerLine = `<div class="banner${enough ? ' good' : ''}" style="margin:10px 0 0">${enough ? '✓' : '⚠'} Our tankers can take <b>${fmtL(space.free)}</b> now${some.length ? ` (${some.slice(0, 4).map((r) => `${esc(r.plate)} ${fmtL(r.free)}`).join(' · ')}${some.length > 4 ? ' …' : ''})` : ''}
        — ${enough ? `enough for the ${fmtL(sell)} of diesel to dispense.` : `the other ${fmtL(sell - space.free)} has to go through the pumps.`}</div>`;
    } else {
      tankerLine = '<div class="hint" style="margin-top:8px">Sign in to the Loading app (under <b>Our tankers</b>) to see if our own tankers can take it.</div>';
    }
  }
  return `<div class="card${sell > 0 ? ' accent' : ''}">
    <div class="sect-title">${productChip(p)} ${fmtKL(pr?.incoming || coming.reduce((a, l) => a + l.chambers.filter((c) => c.product === p).reduce((x, c) => x + c.litres, 0), 0))} coming ${head}</div>
    ${rows}
    ${tankerLine}
  </div>`;
}

function tankersCard(space) {
  const st = tankers.status;
  let body;
  if (st === 'live') {
    body = `${space.rows.map((r) => {
      const pct = r.capacity ? Math.round((r.filled / r.capacity) * 100) : 0;
      return `<div class="tk-row">
        <div class="tk-top"><b>${esc(r.plate)}</b><span class="sp"></span><b class="num">${fmtL(r.free)}</b><span class="hint">free</span></div>
        <div class="tk-mid"><span class="tk-bar" role="img" aria-label="${esc(r.plate)}: ${fmtL(r.filled)} in it of ${fmtL(r.capacity)}"><i style="width:${pct}%"></i></span>
          <span class="hint num">${fmtL(r.filled)} in it of ${fmtL(r.capacity)}</span></div>
      </div>`;
    }).join('') || '<div class="hint">No tankers in the Loading app.</div>'}
      <div class="tk-row tot"><div class="tk-top"><b>Free in all</b><span class="sp"></span><b class="num">${fmtL(space.free)}</b></div></div>
      <div class="hint" style="margin-top:6px">${space.excluded.length ? `Left out: ${space.excluded.map(esc).join(', ')} (change in Settings). ` : ''}Read ${ago(tankers.at)} as ${esc(tankers.user)} · updates live.</div>
      <div class="row-actions" style="justify-content:flex-start"><button class="btn sm" data-tkrefresh>↻ Refresh</button><button class="btn sm ghost" data-tksignout>Sign out</button></div>`;
  } else if (st === 'signin') {
    body = `<div class="hint">Sign in once on this phone with a <b>Loading app</b> login to see how much diesel our own tankers can still take. Only how full each tanker is is read.</div>
      <div class="grid2" style="margin-top:10px"><label class="f">Username<input type="text" data-tku autocomplete="username" autocapitalize="off"></label>
      <label class="f">Password<input type="password" data-tkp autocomplete="current-password"></label></div>
      <div class="hint" data-tkerr style="color:var(--bad);margin-top:6px"></div>
      <div class="row-actions"><button class="cta sm" data-tksignin>Sign in</button></div>`;
  } else if (st === 'connecting' || st === 'off') {
    body = '<div class="hint">Connecting to the Loading app…</div>';
  } else {
    body = `<div class="hint">${esc(tankers.error || 'The Loading app isn\'t reachable.')}</div><div class="row-actions" style="justify-content:flex-start"><button class="btn sm" data-tkrefresh>↻ Try again</button></div>`;
  }
  return `<h2>Our tankers <span class="count">from the Loading app</span></h2><div class="card">${body}</div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function bind(el) {
  el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-shotstock]')) {
      const r = await readScreenshot({ kind: 'stock' });
      if (r && Object.keys(r.readings).length) toast(`Stock updated: ${Object.keys(r.readings).map(tankName).join(', ')}.`);
      return;
    }
    if (t.closest('[data-savestock]')) { saveTyped(); return; }
    if (t.closest('[data-stedit]')) {
      stockEdit = true;
      render();
      el.querySelector('[data-stl]')?.focus();
      return;
    }
    if (t.closest('[data-stcancel]')) {
      stockEdit = false;
      for (const k of Object.keys(typed)) delete typed[k];
      render();
      return;
    }
    if (t.closest('[data-addload]')) { loadForm(); return; }
    const ed = t.closest('[data-editload]');
    if (ed) { loadForm((state.config.plannedLoads || []).find((l) => l.id === ed.dataset.editload)); return; }
    const del = t.closest('[data-delload]');
    if (del) {
      if (!(await ask('Remove this load?', 'It stops counting in the plan.', { ok: 'Remove', danger: true }))) return;
      await saveConfig({ plannedLoads: (state.config.plannedLoads || []).filter((l) => l.id !== del.dataset.delload) });
      return;
    }
    if (t.closest('[data-clearinvoiced]')) {
      const { invoiced } = orderedLoads();
      const gone = new Set(invoiced.map((x) => x.load.id));
      await saveConfig({ plannedLoads: (state.config.plannedLoads || []).filter((l) => !gone.has(l.id)) });
      return;
    }
    if (t.closest('[data-tkrefresh]')) {
      if (tankers.status === 'live') refreshTankers(); else retryTankers();
      return;
    }
    if (t.closest('[data-tksignout]')) { tankersSignOut(); return; }
    if (t.closest('[data-tksignin]')) {
      const u = el.querySelector('[data-tku]').value;
      const pw = el.querySelector('[data-tkp]').value;
      const err = el.querySelector('[data-tkerr]');
      if (!u || !pw) { err.textContent = 'Enter the username and password.'; return; }
      err.textContent = 'Signing in…';
      try { await tankersSignIn(u, pw); toast('Signed in to the Loading app.'); } catch (x) { err.textContent = x.message; }
    }
  });
  el.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-loadon]');
    if (cb) { setOff(cb.dataset.loadon, !cb.checked); render(); }
  });
  el.addEventListener('input', (e) => {
    const t = e.target;
    const id = t.dataset.stl || t.dataset.std;
    if (!id) return;
    const other = el.querySelector(t.dataset.stl ? `[data-std="${id}"]` : `[data-stl="${id}"]`);
    if (t.value !== '') {
      typed[id] = { kind: t.dataset.stl ? 'l' : 'd', value: t.value };
      if (other) other.value = '';
    } else if (!other?.value) {
      delete typed[id];
    }
    el.querySelector('[data-savestock]').disabled = !Object.keys(typed).length;
    el.querySelector('[data-sthint]').textContent = stockHint();
  });
}

async function saveTyped() {
  const done = [];
  for (const [id, d] of Object.entries(typed)) {
    try {
      const r = typedReading(id, d.kind === 'd' ? { dipCm: Number(d.value) } : { litres: Number(d.value) });
      await saveTankReading(id, r);
      delete typed[id];
      done.push(tankName(id));
    } catch (err) { toast(`${tankName(id)}: ${err.message}`, 4000); render(); return; }
  }
  if (done.length) toast(`Stock saved: ${done.join(', ')}.`);
  stockEdit = false;
  render();
}

// Put the ordered quantities into the chambers: MS from chamber 1 upward,
// then HSD, then XtraGreen, whole chambers each.
export function fillChambers(caps, qty) {
  const prodOf = {};
  let i = 0;
  for (const p of ['MS', 'HSD', 'XG']) {
    let need = Math.round((Number(qty[p]) || 0) * 1000);
    while (need > 0 && i < caps.length) {
      prodOf[i + 1] = p;
      need -= Math.round(caps[i] * 1000);
      i += 1;
    }
  }
  return prodOf;
}

function loadForm(existing = null) {
  openSheet(existing ? `Edit the load on ${existing.tt_no}` : 'What have you ordered next?', (body) => {
    const vehicles = Object.keys(state.vehicles).sort();
    const ex = existing || {};
    let caps = (ex.chambers || []).map((c) => c.litres / 1000);
    let prodOf = Object.fromEntries((ex.chambers || []).map((c) => [c.no, c.product || '']));
    const qty = { MS: '', HSD: '', XG: '' };
    for (const c of ex.chambers || []) if (c.product) qty[c.product] = round2((Number(qty[c.product]) || 0) + c.litres / 1000);
    body.innerHTML = `
      <div class="grid2">
        <label class="f">Tanker (TT) number<input type="text" id="lfTT" list="lfTTs" autocomplete="off" value="${esc(ex.tt_no || '')}" placeholder="OD23U8210"></label>
        <label class="f">Indent no. / note (optional)<input type="text" id="lfNote" value="${esc(ex.note || '')}"></label>
      </div>
      <datalist id="lfTTs">${vehicles.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
      <div class="hint" id="lfTTHint" style="margin-top:4px"></div>
      <label class="f" style="margin-top:10px">Expected (optional)<input type="datetime-local" id="lfWhen" value="${esc(ex.expected || '')}"></label>
      <div class="sect-title" style="margin-top:14px">Indent (KL)</div>
      <div class="grid3">${['MS', 'HSD', 'XG'].map((p) => `<label class="f">${PRODUCTS[p].name}<input type="number" inputmode="decimal" step="0.5" min="0" data-q="${p}" value="${qty[p] || ''}"></label>`).join('')}</div>
      <label class="f" style="margin-top:10px">The tanker's chambers, KL each from chamber 1<input type="text" id="lfCh" inputmode="decimal" value="${esc(caps.join(', '))}" placeholder="5, 5, 4, 4, 4"></label>
      <div class="hint" id="lfHint"></div>
      <div id="lfTruck"></div>
      <div id="lfProd"></div>
      <div class="row-actions"><button class="btn" data-x>Cancel</button><button class="cta" data-save>${existing ? 'Save' : 'Add to the plan'}</button></div>`;
    const tt = body.querySelector('#lfTT');
    const ch = body.querySelector('#lfCh');
    const parse = () => ch.value.split(/[,\s]+/).map(Number).filter((x) => x > 0 && x <= 30);
    const draw = () => {
      caps = parse();
      const cs = caps.map((kl, i) => ({ no: i + 1, litres: Math.round(kl * 1000), product: prodOf[i + 1] || null }));
      body.querySelector('#lfTruck').innerHTML = cs.length ? truckStrip(cs) : '';
      body.querySelector('#lfProd').innerHTML = cs.map((c) => `<div class="plan-tank" style="grid-template-columns:70px minmax(0,1fr)"><div class="pt-name">C${c.no} <span class="hint">${c.litres / 1000} KL</span></div>
        <div class="seg">${['MS', 'HSD', 'XG', ''].map((p) => `<button type="button" class="${(c.product || '') === p ? 'on' : ''}" data-cp="${c.no}" data-p="${p}">${p ? productShort(p) : 'Empty'}</button>`).join('')}</div></div>`).join('');
      const tot = {};
      for (const c of cs) if (c.product) tot[c.product] = (tot[c.product] || 0) + c.litres;
      const typed = Object.fromEntries(['MS', 'HSD', 'XG'].map((p) => [p, Math.round((Number(body.querySelector(`[data-q="${p}"]`).value) || 0) * 1000)]));
      const off = ['MS', 'HSD', 'XG'].filter((p) => typed[p] && typed[p] !== (tot[p] || 0));
      body.querySelector('#lfHint').textContent = caps.length
        ? `${Object.entries(tot).map(([p, l]) => `${productShort(p)} ${fmtKL(l)}`).join(' · ') || 'Pick the product in each chamber.'}${off.length ? ` — the indent doesn't fill whole chambers for ${off.join(', ')}; check the chambers.` : ''}`
        : 'Type the chambers, or pick a tanker the app has seen before.';
    };
    const fromQty = () => {
      prodOf = fillChambers(parse(), Object.fromEntries(['MS', 'HSD', 'XG'].map((p) => [p, body.querySelector(`[data-q="${p}"]`).value])));
      draw();
    };
    tt.oninput = () => {
      const no = tt.value.trim().toUpperCase().replace(/\s+/g, '');
      const v = state.vehicles[no];
      if (v && !ch.value) { ch.value = v.chambers.map((c) => c.qty_kl).join(', '); fromQty(); }
      const onWay = comingLoads().transit.filter((l) => l.tt === no);
      body.querySelector('#lfTTHint').textContent = onWay.length
        ? `${no} already has ${onWay.map((l) => `invoice ${l.inv.invoice_no} (${l.inv.invoice_date || ''} ${l.inv.invoice_time || ''})`).join(', ')} in transit — add this only for its next trip.`
        : '';
    };
    ch.oninput = fromQty;
    body.querySelectorAll('[data-q]').forEach((q) => { q.oninput = fromQty; });
    body.querySelector('#lfProd').onclick = (e) => {
      const b = e.target.closest('[data-cp]');
      if (b) { prodOf[Number(b.dataset.cp)] = b.dataset.p; draw(); }
    };
    draw();
    body.querySelector('[data-x]').onclick = () => closeSheet();
    body.querySelector('[data-save]').onclick = async () => {
      const ttNo = tt.value.trim().toUpperCase().replace(/\s+/g, '');
      caps = parse();
      if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(ttNo)) { toast('Type the tanker number, e.g. OD23U8210.'); return; }
      if (!caps.length) { toast('Type the tanker\'s chambers (KL each).'); return; }
      const chambers = caps.map((kl, i) => ({ no: i + 1, litres: Math.round(kl * 1000), product: prodOf[i + 1] || null }));
      if (!chambers.some((c) => c.product)) { toast('Type the indent or pick the product in a chamber.'); return; }
      const load = {
        id: ex.id || newId('L'), tt_no: ttNo, chambers, note: body.querySelector('#lfNote').value.trim(),
        expected: body.querySelector('#lfWhen').value || '', created_at: ex.created_at || new Date().toISOString(),
        by: state.device.operator || '',
        // the truck's invoices already here (its current trip isn't this load)
        known: ex.tt_no === ttNo && ex.known ? ex.known : state.invoices.filter((i) => i.tt_no === ttNo).map((i) => i.invoice_no),
      };
      const rest = (state.config.plannedLoads || []).filter((l) => l.id !== load.id);
      await saveConfig({ plannedLoads: [...rest, load] });
      closeSheet();
      toast(existing ? 'Load updated.' : 'Added to the plan.');
    };
  });
}

// For the Home screen: litres in transit per product (trucks not decanted yet).
export function transitTotals() {
  const out = {};
  for (const l of comingLoads().transit) for (const c of l.chambers) out[c.product] = (out[c.product] || 0) + c.litres;
  return out;
}

