// The Plan tab: how much to dispense from each tank so the loads you've
// placed an indent for fit.
//   1. Stock now — each tank's latest reading (after the last decanting or
//      screenshot); type a new figure to update it.
//   2. Indents placed — the tanker and the KL of each product.
//   3. Dispense — per tank, the least to dispense so every chamber goes in
//      (keeping the room margin), and which chambers go where.
//   4. Our tankers — how much diesel our own tankers can take (Loading app).

import { PRODUCTS, dipAtLitres, planDispense, round2, tankerSpace } from './core.js';
import { newId, saveConfig, saveTankReading, state } from './store.js';
import { initTankers, onTankers, refreshTankers, retryTankers, tankers, tankersSignIn, tankersSignOut } from './tankers.js';
import {
  ago, ask, closeSheet, esc, fmtDip, fmtKL, fmtL, openSheet, productChip, productShort, toast, truckStrip,
} from './ui.js';
import { compactNos, readScreenshot, render, tankName, tanks, typedReading } from './app.js';

let bound = null;
const typed = {};                                  // tank id -> {kind: 'l' | 'd', value} not saved yet
let stockEdit = false;                             // the stock card shows its typing boxes

const indents = () => (state.config.plannedLoads || []).map((l) => ({ ...l, chambers: (l.chambers || []).filter((c) => c.product && c.litres > 0) }));

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
  const loads = indents();
  const res = planDispense({ loads, tanks: tanks(), stock: state.tankState, margin: state.settings.warnRoomL });
  const space = tankerSpace(tankers.vehicles, state.settings.excludeTankers || []);
  el.innerHTML = `
    ${stockCard()}
    <h2>Indents placed <span class="count">${loads.length}</span><span class="sp"></span>${loads.length ? '<button class="btn sm ghost" data-clearloads>Clear all</button>' : ''}</h2>
    <div class="card">
      ${loads.length ? loads.map(loadRow).join('') : '<div class="empty" style="margin-bottom:10px">Add each tanker you\'ve placed an indent for, with the KL of each product.</div>'}
      <div class="row-actions" style="justify-content:flex-start"><button class="cta sm" data-addload>＋ Add an indent</button></div>
    </div>
    ${loads.length ? `<h2>Dispense first</h2>
      ${Object.keys(PRODUCTS).map((p) => productPlan(p, loads, res, space)).join('')}
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

function loadRow(l) {
  const byP = {};
  for (const c of l.chambers) (byP[c.product] ||= []).push(c);
  const prods = Object.entries(byP).map(([p, cs]) => productChip(p, `${fmtKL(cs.reduce((a, c) => a + c.litres, 0))} · C${compactNos(cs.map((c) => c.no))}`)).join(' ');
  return `<div class="load-row">
    <div class="load-mid"><div><b>${esc(l.tt_no)}</b>${l.note ? ` <span class="hint">${esc(l.note)}</span>` : ''}</div>
      <div class="inv-prods" style="margin:6px 0 0">${prods}</div></div>
    <div class="load-act"><button class="btn sm" data-editload="${esc(l.id)}" aria-label="Edit">✎</button><button class="btn sm ghost" data-delload="${esc(l.id)}" aria-label="Remove">✕</button></div>
  </div>`;
}

// One card per product indented: per tank what goes in and what to dispense.
function productPlan(p, loads, res, space) {
  const ts = tanks().filter((t) => t.product === p);
  const pr = res.products[p];
  const incoming = loads.reduce((a, l) => a + l.chambers.filter((c) => c.product === p).reduce((x, c) => x + c.litres, 0), 0);
  if (!incoming) return '';
  if (!ts.length) return `<div class="banner">No tank holds ${esc(PRODUCTS[p].name)} — ${fmtKL(incoming)} indented can't be decanted.</div>`;
  const sell = pr?.sell || 0;
  const head = sell > 0
    ? `<span class="badge high"><i>↓</i>Dispense ${fmtL(sell)}</span>`
    : '<span class="badge ok"><i>✓</i>Room for all of it</span>';
  const rows = ts.map((t) => {
    const row = res.tanks[t.id];
    if (!row) return `<div class="plan-tank" style="grid-template-columns:1fr"><div><div class="pt-name">Tank ${t.no}</div><div class="pt-sub">No stock reading — add it above.</div></div></div>`;
    const parts = [];
    res.loads.forEach((lr, i) => {
      const nos = Object.entries(lr.split).filter(([, id]) => id === t.id).map(([no]) => Number(no));
      if (!nos.length) return;
      const litres = loads[i].chambers.filter((c) => nos.includes(c.no)).reduce((a, c) => a + c.litres, 0);
      parts.push(`<li>C${compactNos(nos)} of <b>${esc(loads[i].tt_no)}</b> · ${fmtKL(litres)}</li>`);
    });
    return `<div class="plan-tank" style="grid-template-columns:minmax(0,1fr) auto">
      <div><div class="pt-name">Tank ${t.no}</div>
        <div class="pt-sub">Now <b>${fmtL(row.now)}</b> · room <b>${fmtL(row.room)}</b></div>
        ${parts.length ? `<ul class="plan-parts">${parts.join('')}</ul>
          <div class="pt-sub">After: <b>${fmtL(row.after)}</b> (${fmtDip(dipAtLitres(state.chart, row.after))}) · room left ${fmtL(row.spare)}</div>` : '<div class="pt-sub">Nothing goes in.</div>'}</div>
      <div class="plan-sell${row.sell > 0 ? ' need' : ''}"><b>${row.sell > 0 ? fmtL(row.sell) : '0 L'}</b><span>to dispense</span></div>
    </div>`;
  }).join('');
  let tankerLine = '';
  if (p === 'HSD' && sell > 0) {
    if (tankers.status === 'live') {
      const enough = space.free >= sell;
      const some = space.rows.filter((r) => r.free > 0);
      tankerLine = `<div class="banner${enough ? ' good' : ''}" style="margin:10px 0 0">${enough ? '✓' : '⚠'} Our tankers can take <b>${fmtL(space.free)}</b> now${some.length ? ` (${some.slice(0, 4).map((r) => `${esc(r.plate)} ${fmtL(r.free)}`).join(' · ')}${some.length > 4 ? ' …' : ''})` : ''}
        — ${enough ? `enough for the ${fmtL(sell)} to dispense.` : `the other ${fmtL(sell - space.free)} has to go through the pumps.`}</div>`;
    } else {
      tankerLine = '<div class="hint" style="margin-top:8px">Sign in under <b>Our tankers</b> to see if our own tankers can take it.</div>';
    }
  }
  return `<div class="card${sell > 0 ? ' accent' : ''}">
    <div class="sect-title">${productChip(p)} ${fmtKL(incoming)} indented ${head}</div>
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
    if (t.closest('[data-addload]')) { loadForm(); return; }
    const ed = t.closest('[data-editload]');
    if (ed) { loadForm((state.config.plannedLoads || []).find((l) => l.id === ed.dataset.editload)); return; }
    const del = t.closest('[data-delload]');
    if (del) {
      if (!(await ask('Remove this indent?', 'It stops counting in the plan.', { ok: 'Remove', danger: true }))) return;
      await saveConfig({ plannedLoads: (state.config.plannedLoads || []).filter((l) => l.id !== del.dataset.delload) });
      return;
    }
    if (t.closest('[data-clearloads]')) {
      if (!(await ask('Clear all the indents?', 'Do this once they have been decanted.', { ok: 'Clear all', danger: true }))) return;
      await saveConfig({ plannedLoads: [] });
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
  openSheet(existing ? `Edit the indent on ${existing.tt_no}` : 'Indent placed', (body) => {
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
      <div class="sect-title" style="margin-top:14px">Indent (KL)</div>
      <div class="grid3">${['MS', 'HSD', 'XG'].map((p) => `<label class="f">${PRODUCTS[p].name}<input type="number" inputmode="decimal" step="0.5" min="0" data-q="${p}" value="${qty[p] || ''}"></label>`).join('')}</div>
      <label class="f" style="margin-top:10px">The tanker's chambers, KL each from chamber 1<input type="text" id="lfCh" inputmode="decimal" value="${esc(caps.join(', '))}" placeholder="5, 5, 4, 4, 4"></label>
      <div class="hint" id="lfHint"></div>
      <div id="lfTruck"></div>
      <div id="lfProd"></div>
      <div class="row-actions"><button class="btn" data-x>Cancel</button><button class="cta" data-save>${existing ? 'Save' : 'Add'}</button></div>`;
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
      const v = state.vehicles[tt.value.trim().toUpperCase().replace(/\s+/g, '')];
      if (v && !ch.value) { ch.value = v.chambers.map((c) => c.qty_kl).join(', '); fromQty(); }
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
        created_at: ex.created_at || new Date().toISOString(), by: state.device.operator || '',
      };
      const rest = (state.config.plannedLoads || []).filter((l) => l.id !== load.id);
      await saveConfig({ plannedLoads: [...rest, load] });
      closeSheet();
      toast(existing ? 'Indent updated.' : 'Added to the plan.');
    };
  });
}
