// The Plan tab: how much to dispense from each tank so the loads you've
// placed an indent for fit.
//   1. Stock now — each tank's latest reading (after the last decanting or
//      screenshot); type a new figure to update it.
//   2. Indents placed — on one of our own TTs (its chambers are known) or on a
//      transport TT (only the KL: it can come with any standard layout of its
//      size). An indent comes off the plan when its invoice arrives.
//   3. Dispense first — per tank, the least to dispense so every chamber goes
//      in whichever way the loads come (keeping the room margin).
//   4. Our delivery tankers — how much diesel they can take (Loading app).

import {
  PRODUCTS, dipAtLitres, indentKL, loadChambers, matchIndents, normTT, ownTT, planIndents, round2, smallestTransport, tankerSpace,
  transportOptions,
} from './core.js';
import { newId, saveConfig, saveTankReading, state } from './store.js';
import { initTankers, onTankers, refreshTankers, retryTankers, tankers, tankersSignIn, tankersSignOut } from './tankers.js';
import {
  ago, ask, closeSheet, esc, fmtDip, fmtKL, fmtL, fmtWhen, openSheet, productChip, productShort, toast, truckStrip,
} from './ui.js';
import { compactNos, readScreenshot, render, tankName, tanks, typedReading } from './app.js';

let bound = null;
const typed = {};                                  // tank id -> {kind: 'l' | 'd', value} not saved yet
let stockEdit = false;                             // the stock card shows its typing boxes
let tidying = false;

const kl = (x) => `${round2(x)} KL`;
const layoutText = (caps) => caps.join('+');

// A transport TT's layout, with how the indent loads in it when whole chambers
// change the split ("5+5+4+4+4 (MS 5 + HSD 17)").
function layoutLoad(caps, qty) {
  const got = {};
  for (const c of loadChambers(caps, qty).chambers) got[c.product] = (got[c.product] || 0) + c.litres;
  const same = Object.entries(qty || {}).every(([p, v]) => Math.round((Number(v) || 0) * 1000) === (got[p] || 0));
  return same ? layoutText(caps) : `${layoutText(caps)} (${Object.entries(got).map(([p, l]) => `${productShort(p)} ${round2(l / 1000)}`).join(' + ')})`;
}

// Why a transport indent of `total` KL has no standard TT.
function noTransport(total) {
  const min = smallestTransport(state.settings.transportTTs);
  return total < min ? `Transport TTs are ${min} KL or more.` : `No standard transport TT holds ${kl(total)} — add its layout in Settings.`;
}

// "the transport TT", or "transport TT 2" when more than one is indented
// ("Transport TT" / "Transport TT 2" as a title).
function transportName(active, i, title = false) {
  const list = active.filter((p) => p.kind === 'transport');
  if (list.length > 1) return `${title ? 'T' : 't'}ransport TT ${list.indexOf(active[i]) + 1}`;
  return title ? 'Transport TT' : 'the transport TT';
}

// The indents placed. Ones saved before transport TTs existed are our own TT's.
function allIndents() {
  return (state.config.plannedLoads || []).map((l) => ({
    ...l, kind: l.kind === 'transport' ? 'transport' : 'own', chambers: (l.chambers || []).filter((c) => c.product && c.litres > 0),
  }));
}
const ownPlates = () => (state.settings.ownTTs || []).map((o) => o.tt);

// Indents whose invoice came in over a day and a half ago leave the list.
function tidyArrived(all, arrived) {
  const cut = Date.now() - 36 * 3600000;
  const gone = new Set(all.filter((p) => arrived.has(p.id) && Date.parse(arrived.get(p.id).created_at || 0) < cut).map((p) => p.id));
  if (!gone.size || tidying) return;
  tidying = true;
  saveConfig({ plannedLoads: (state.config.plannedLoads || []).filter((l) => !gone.has(l.id)) }).finally(() => { tidying = false; });
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
  const all = allIndents();
  const arrived = matchIndents(all, state.invoices, ownPlates());
  tidyArrived(all, arrived);
  const active = all.filter((p) => !arrived.has(p.id));
  const res = planIndents({ indents: active, tanks: tanks(), stock: state.tankState, margin: state.settings.warnRoomL, table: state.settings.transportTTs });
  const space = tankerSpace(tankers.vehicles, state.settings.excludeTankers || []);
  el.innerHTML = `
    ${stockCard()}
    <h2>Indents placed <span class="count">${active.length}</span><span class="sp"></span>${active.length > 1 ? '<button class="btn sm ghost" data-clearloads>Clear all</button>' : ''}</h2>
    <div class="card">
      ${active.length ? active.map((p, i) => indentRow(p, active, i)).join('') : '<div class="empty" style="margin-bottom:10px">Add each load you\'ve placed an indent for — on our TT or a transport TT.</div>'}
      <div class="row-actions" style="justify-content:flex-start"><button class="cta sm" data-addload>＋ Add an indent</button></div>
    </div>
    ${arrivedCard(all, arrived)}
    ${active.length ? `<h2>Dispense first</h2>
      ${Object.keys(PRODUCTS).map((p) => productPlan(p, active, res, space)).join('')}
      ${res.missing.length ? `<div class="banner">No stock for ${res.missing.map(tankName).join(', ')} yet — add it under <b>Stock now</b>.</div>` : ''}` : ''}
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

function indentRow(p, active, i) {
  let what;
  let meta;
  if (p.kind === 'transport') {
    const { size, layouts } = transportOptions(indentKL(p), state.settings.transportTTs);
    what = `<b>${transportName(active, i, true)}</b> <span class="badge info">${size ? `${size} KL` : `${kl(indentKL(p))}?`}</span>`;
    meta = size ? `Any of: ${layouts.map((c) => layoutLoad(c, p.qty)).join(' · ')}` : `${noTransport(indentKL(p))} Not planned.`;
    const chips = Object.entries(p.qty || {}).filter(([, v]) => Number(v) > 0).map(([pr, v]) => productChip(pr, kl(v))).join(' ');
    return row(p, what, chips, meta);
  }
  const byP = {};
  for (const c of p.chambers) (byP[c.product] ||= []).push(c);
  what = `<b>${esc(p.tt_no)}</b> ${ownTT(p.tt_no, state.settings) ? '<span class="badge info">Our TT</span>' : ''}`;
  const chips = Object.entries(byP).map(([pr, cs]) => productChip(pr, `${fmtKL(cs.reduce((a, c) => a + c.litres, 0))} · C${compactNos(cs.map((c) => c.no))}`)).join(' ');
  meta = '';
  return row(p, what, chips, meta);
}

function row(p, what, chips, meta) {
  return `<div class="load-row">
    <div class="load-mid"><div>${what}${p.note ? ` <span class="hint">${esc(p.note)}</span>` : ''}</div>
      <div class="inv-prods" style="margin:6px 0 0">${chips}</div>
      <div class="hint">${meta ? `${esc(meta)} · ` : ''}added ${fmtWhen(p.created_at)}</div></div>
    <div class="load-act"><button class="btn sm" data-editload="${esc(p.id)}" aria-label="Edit">✎</button><button class="btn sm ghost" data-delload="${esc(p.id)}" aria-label="Remove">✕</button></div>
  </div>`;
}

// Indents whose invoice has come in (they're off the plan now).
function arrivedCard(all, arrived) {
  const list = all.filter((p) => arrived.has(p.id));
  if (!list.length) return '';
  return `<h2>Arrived <span class="count">off the plan</span></h2><div class="card">${list.map((p) => {
    const inv = arrived.get(p.id);
    return `<div class="load-row">
      <div class="load-mid"><div><b>${p.kind === 'transport' ? 'Transport TT' : esc(p.tt_no)}</b> → <b>${esc(inv.tt_no || '')}</b> <span class="badge ok"><i>✓</i>Invoiced</span></div>
        <div class="hint">Invoice ${esc(inv.invoice_no)} · ${esc(inv.invoice_date || '')} ${esc(inv.invoice_time || '')} — its card on the Decant tab shows the room to make.</div></div>
      <div class="load-act"><button class="btn sm ghost" data-notthis="${esc(p.id)}" data-inv="${esc(inv.invoice_no)}">Not this one</button></div>
    </div>`;
  }).join('')}</div>`;
}

// One card per product indented: per tank how much to dispense first, and how
// the chambers go in (each way a transport TT can come).
function productPlan(p, active, res, space) {
  const ts = tanks().filter((t) => t.product === p);
  const pr = res.products[p];
  const bringing = active.some((x) => (x.kind === 'transport' ? Number(x.qty?.[p]) > 0 : x.chambers.some((c) => c.product === p)));
  if (!bringing) return '';
  if (!ts.length) return `<div class="banner">No tank holds ${esc(PRODUCTS[p].name)} — what's indented can't be decanted.</div>`;
  if (!pr) return '';
  const sell = pr.sell || 0;
  const head = sell > 0
    ? `<span class="badge high"><i>↓</i>Dispense ${fmtL(sell)}</span>`
    : '<span class="badge ok"><i>✓</i>Room for all of it</span>';
  const many = res.ways.length > 1;
  const plural = active.filter((x) => x.kind === 'transport').length > 1;
  const rowsHtml = ts.map((t) => {
    const r = res.tanks[t.id];
    if (!r) return `<div class="plan-tank" style="grid-template-columns:1fr"><div><div class="pt-name">Tank ${t.no}</div><div class="pt-sub">No stock reading — add it above.</div></div></div>`;
    const range = (a, b, f) => (Math.abs(a - b) < 0.5 ? f(a) : `${f(a)}–${f(b)}`);
    const parts = many ? [] : chambersInto(t.id, res.ways[0], active);
    return `<div class="plan-tank" style="grid-template-columns:minmax(0,1fr) auto">
      <div><div class="pt-name">Tank ${t.no}</div>
        <div class="pt-sub">Now <b>${fmtL(r.now)}</b> · room <b>${fmtL(r.room)}</b></div>
        ${many ? (r.incoming[1] ? `<div class="pt-sub">Gets ${range(r.incoming[0] / 1000, r.incoming[1] / 1000, (x) => `${round2(x)}`)} KL, by ${plural ? 'the transport TTs\' layouts' : 'the transport TT\'s layout'}</div>` : '<div class="pt-sub">Nothing goes in.</div>')
    : parts.length ? `<ul class="plan-parts">${parts.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<div class="pt-sub">Nothing goes in.</div>'}
        ${r.incoming[1] ? `<div class="pt-sub">After: <b>${range(r.after[0], r.after[1], (x) => fmtL(x))}</b> (${fmtDip(dipAtLitres(state.chart, r.after[1]))}) · room left ≥ ${fmtL(r.spare)}</div>` : ''}</div>
      <div class="plan-sell${r.sell > 0 ? ' need' : ''}"><b>${r.sell > 0 ? fmtL(r.sell) : '0 L'}</b><span>to dispense</span></div>
    </div>`;
  }).join('');
  const ways = many ? `<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">How the chambers go in — each way the transport TT${plural ? 's' : ''} can come</summary>
      ${res.ways.map((w) => `<div class="hint" style="margin-top:6px"><b style="color:var(--ink)">${wayLabel(w, active)}</b><br>${ts.map((t) => `${tankName(t.id)}: ${chambersInto(t.id, w, active).join('; ') || 'nothing'}`).join(' · ')}</div>`).join('')}
    </details>` : '';
  let tankerLine = '';
  if (p === 'HSD' && sell > 0) {
    if (tankers.status === 'live') {
      const enough = space.free >= sell;
      const some = space.rows.filter((r) => r.free > 0);
      tankerLine = `<div class="banner${enough ? ' good' : ''}" style="margin:10px 0 0">${enough ? '✓' : '⚠'} Our delivery tankers can take <b>${fmtL(space.free)}</b> now${some.length ? ` (${some.slice(0, 4).map((r) => `${esc(r.plate)} ${fmtL(r.free)}`).join(' · ')}${some.length > 4 ? ' …' : ''})` : ''}
        — ${enough ? `enough for the ${fmtL(sell)} to dispense.` : `the other ${fmtL(sell - space.free)} has to go through the pumps.`}</div>`;
    } else {
      tankerLine = '<div class="hint" style="margin-top:8px">Sign in under <b>Our delivery tankers</b> to see if they can take it.</div>';
    }
  }
  const left = res.ways.some((w) => w.some((x) => x.left > 0));
  return `<div class="card${sell > 0 ? ' accent' : ''}">
    <div class="sect-title">${productChip(p)} ${fmtKL(pr.incoming)} indented ${head}</div>
    ${rowsHtml}
    ${ways}
    ${left ? '<div class="hint" style="margin-top:6px">⚠ In one of its layouts a transport TT\'s chambers can\'t carry all of its indent — the rest isn\'t counted.</div>' : ''}
    ${tankerLine}
  </div>`;
}

// "C1–3 of OD23U8210 (14 KL)" for what goes into a tank, one way.
function chambersInto(tankId, way, active) {
  return way.map((w, i) => {
    const nos = Object.entries(w.split).filter(([, id]) => id === tankId).map(([no]) => Number(no));
    if (!nos.length) return null;
    const p = active[i];
    const litres = p.kind === 'transport'
      ? nos.reduce((a, no) => a + Math.round((w.caps[no - 1] || 0) * 1000), 0)
      : p.chambers.filter((c) => nos.includes(c.no)).reduce((a, c) => a + c.litres, 0);
    return `C${compactNos(nos)} of ${p.kind === 'transport' ? `${transportName(active, i)} (${layoutText(w.caps)})` : `<b>${esc(p.tt_no)}</b>`} · ${fmtKL(litres)}`;
  }).filter(Boolean);
}

// "If the transport TT comes as 5+5+4+4+4:"
function wayLabel(way, active) {
  const t = way.map((w, i) => (active[i].kind === 'transport' && w.caps ? `${transportName(active, i)} comes as ${layoutText(w.caps)}` : null)).filter(Boolean);
  return t.length ? `If ${t.join(' and ')}:` : 'As planned:';
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
  return `<h2>Our delivery tankers <span class="count">Loading app</span></h2><div class="card">${body}</div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function bind(el) {
  el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-shotstock]')) {
      const r = await readScreenshot();
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
    if (t.closest('[data-addload]')) { indentForm(); return; }
    const ed = t.closest('[data-editload]');
    if (ed) { indentForm(allIndents().find((l) => l.id === ed.dataset.editload)); return; }
    const del = t.closest('[data-delload]');
    if (del) {
      if (!(await ask('Remove this indent?', 'It stops counting in the plan.', { ok: 'Remove', danger: true }))) return;
      await saveConfig({ plannedLoads: (state.config.plannedLoads || []).filter((l) => l.id !== del.dataset.delload) });
      return;
    }
    const not = t.closest('[data-notthis]');
    if (not) {
      await saveConfig({ plannedLoads: (state.config.plannedLoads || []).map((l) => (l.id === not.dataset.notthis ? { ...l, ignore: [...(l.ignore || []), not.dataset.inv] } : l)) });
      toast('Back on the plan.');
      return;
    }
    if (t.closest('[data-clearloads]')) {
      if (!(await ask('Clear all the indents?', 'They stop counting in the plan.', { ok: 'Clear all', danger: true }))) return;
      const arrived = matchIndents(allIndents(), state.invoices, ownPlates());
      await saveConfig({ plannedLoads: (state.config.plannedLoads || []).filter((l) => arrived.has(l.id)) });
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

// Add or change an indent: on one of our own TTs (default: the first, e.g.
// OD23U8210), a new TT of ours, or a transport TT (just the KL).
function indentForm(existing = null) {
  const own = state.settings.ownTTs || [];
  const ex = existing || {};
  let sel = ex.kind === 'transport' ? 'transport' : ex.tt_no ? (ownTT(ex.tt_no, state.settings) ? normTT(ex.tt_no) : 'new') : (own[0]?.tt || 'new');
  const qty = { MS: '', HSD: '', XG: '' };
  if (ex.kind === 'transport') for (const p of Object.keys(qty)) qty[p] = Number(ex.qty?.[p]) || '';
  else for (const c of ex.chambers || []) if (c.product) qty[c.product] = round2((Number(qty[c.product]) || 0) + c.litres / 1000);
  let prodOf = Object.fromEntries((ex.chambers || []).map((c) => [c.no, c.product || '']));
  let touched = Boolean(ex.chambers?.length);         // chamber products set by hand: keep them
  openSheet(existing ? 'Change the indent' : 'Indent placed', (body) => {
    const caps = () => {
      if (sel === 'transport') return [];
      if (sel === 'new') return (body.querySelector('#ifCh')?.value || '').split(/[,+\s]+/).map(Number).filter((x) => x > 0 && x <= 30);
      return own.find((o) => o.tt === sel)?.chambers || [];
    };
    const total = () => round2(['MS', 'HSD', 'XG'].reduce((a, p) => a + (Number(qty[p]) || 0), 0));
    // the truck strip (own TT: tap a chamber's product to change it) or the transport layouts
    const truck = () => {
      const box = body.querySelector('#ifTruck');
      const hint = body.querySelector('#ifHint');
      if (sel === 'transport') {
        const { size, layouts } = transportOptions(total(), state.settings.transportTTs);
        box.innerHTML = '';
        const q = Object.fromEntries(Object.entries(qty).map(([p, v]) => [p, Number(v) || 0]));
        hint.textContent = !total() ? 'Type the KL; the transport TT can come with any standard layout of its size.'
          : size ? `${size} KL transport TT — any of ${layouts.map((c) => layoutLoad(c, q)).join(' · ')}. The plan makes room for whichever comes.`
            : noTransport(total());
        return;
      }
      const cs = caps();
      if (!touched) prodOf = fill(cs, qty);
      const chambers = cs.map((k, i) => ({ no: i + 1, litres: Math.round(k * 1000), product: prodOf[i + 1] || null }));
      box.innerHTML = chambers.length ? `${truckStrip(chambers)}
        ${chambers.map((c) => `<div class="plan-tank" style="grid-template-columns:70px minmax(0,1fr)"><div class="pt-name">C${c.no} <span class="hint">${c.litres / 1000} KL</span></div>
          <div class="seg">${['MS', 'HSD', 'XG', ''].map((p) => `<button type="button" class="${(c.product || '') === p ? 'on' : ''}" data-cp="${c.no}" data-p="${p}">${p ? productShort(p) : 'Empty'}</button>`).join('')}</div></div>`).join('')}` : '';
      const got = {};
      for (const c of chambers) if (c.product) got[c.product] = (got[c.product] || 0) + c.litres;
      const off = ['MS', 'HSD', 'XG'].filter((p) => Number(qty[p]) > 0 && Math.round(Number(qty[p]) * 1000) !== (got[p] || 0));
      hint.textContent = !chambers.length ? 'Type the TT\'s chambers.'
        : `${Object.entries(got).map(([p, l]) => `${productShort(p)} ${fmtKL(l)}`).join(' · ') || 'Type the KL of each product.'}${off.length ? ` — the indent doesn't fill whole chambers for ${off.join(', ')}; check the chambers.` : ''}`;
    };
    const draw = () => {
      const chips = [...own.map((o) => [o.tt, `${o.tt} · ${round2(o.chambers.reduce((a, b) => a + b, 0))} KL`]), ['transport', 'Transport TT'], ['new', '＋ Our new TT']];
      body.innerHTML = `
        <div class="sect-title">Which TT?</div>
        <div class="chipset">${chips.map(([k, label]) => `<button type="button" class="chipbtn${sel === k ? ' on' : ''}" data-sel="${esc(k)}">${esc(label)}</button>`).join('')}</div>
        ${sel === 'new' ? `<div class="grid2" style="margin-top:10px">
          <label class="f">TT number<input type="text" id="ifTT" autocapitalize="characters" value="${esc(ex.tt_no && !ownTT(ex.tt_no, state.settings) ? ex.tt_no : '')}" placeholder="OD23U8210"></label>
          <label class="f">Chambers, KL from C1<input type="text" id="ifCh" inputmode="decimal" value="${esc(ex.chambers?.length && !ownTT(ex.tt_no, state.settings) ? ex.chambers.map((c) => c.litres / 1000).join(', ') : '')}" placeholder="5, 5, 4, 4, 4"></label></div>
          <div class="hint">Kept as one of our TTs for next time (Settings lists them).</div>` : ''}
        <div class="sect-title" style="margin-top:14px">Indent (KL)</div>
        <div class="grid3">${['MS', 'HSD', 'XG'].map((p) => `<label class="f">${PRODUCTS[p].name}<input type="number" inputmode="decimal" step="0.5" min="0" data-q="${p}" value="${qty[p] || ''}"></label>`).join('')}</div>
        <div id="ifTruck" style="margin-top:8px"></div>
        <div class="hint" id="ifHint"></div>
        <label class="f" style="margin-top:10px">Note (optional)<input type="text" id="ifNote" value="${esc(ex.note || '')}" placeholder="indent no."></label>
        <div class="row-actions"><button class="btn" data-x>Cancel</button><button class="cta" data-save>${existing ? 'Save' : 'Add'}</button></div>`;
      truck();
    };
    const save = async () => {
      const note = body.querySelector('#ifNote').value.trim();
      const base = { id: ex.id || newId('L'), note, created_at: ex.created_at || new Date().toISOString(), by: state.device.operator || '', ignore: ex.ignore || [] };
      let indent;
      let settings = null;
      if (sel === 'transport') {
        const q = Object.fromEntries(['MS', 'HSD', 'XG'].map((p) => [p, round2(Number(qty[p]) || 0)]).filter(([, v]) => v > 0));
        if (!Object.keys(q).length) { toast('Type the KL of each product.'); return; }
        if (!transportOptions(total(), state.settings.transportTTs).size) { toast(noTransport(total()), 4000); return; }
        indent = { ...base, kind: 'transport', qty: q };
      } else {
        let tt = sel;
        const cs = caps();
        if (sel === 'new') {
          tt = normTT(body.querySelector('#ifTT').value);
          if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(tt)) { toast('Type the TT number, e.g. OD23U8210.'); return; }
          if (!cs.length) { toast('Type its chambers, KL each from chamber 1.'); return; }
          if (!ownTT(tt, state.settings)) settings = { ...(state.config.settings || {}), ownTTs: [...own, { tt, chambers: cs }] };
        }
        const chambers = cs.map((k, i) => ({ no: i + 1, litres: Math.round(k * 1000), product: prodOf[i + 1] || null }));
        if (!chambers.some((c) => c.product)) { toast('Type the KL of each product.'); return; }
        indent = { ...base, kind: 'own', tt_no: tt, chambers };
      }
      const rest = (state.config.plannedLoads || []).filter((l) => l.id !== indent.id);
      await saveConfig({ plannedLoads: [...rest, indent], ...(settings ? { settings } : {}) });
      closeSheet();
      toast(existing ? 'Indent changed.' : 'Added to the plan.');
    };
    draw();
    body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sel]');
      if (b) { sel = b.dataset.sel; touched = false; draw(); return; }
      const cp = e.target.closest('[data-cp]');
      if (cp) { prodOf[Number(cp.dataset.cp)] = cp.dataset.p; touched = true; truck(); return; }
      if (e.target.closest('[data-x]')) { closeSheet(); return; }
      if (e.target.closest('[data-save]')) await save();
    });
    body.addEventListener('input', (e) => {
      const q = e.target.dataset.q;
      if (q) { qty[q] = e.target.value; touched = false; truck(); return; }
      if (e.target.id === 'ifCh') { touched = false; truck(); }
    });
  });
}

// Which product goes in which chamber: MS from chamber 1 up, then HSD, then
// XtraGreen, whole chambers.
function fill(caps, qty) {
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
