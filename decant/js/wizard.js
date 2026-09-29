// The decantation itself, step by step:
//   1 Truck   — chambers and products (from the invoice), optional density check
//   2 Before  — stock of the tanks that can take the product (screenshot / litres / dip)
//   3 Plan    — KL per tank; the app picks the chambers (tap one to change it)
//   4 Decant  — per tank: ▶ start, ✓ done, then its stock after. All tanks at
//               once, or tank by tank (Tank 2 now, Tank 3 later): a tank sells
//               until its decanting starts, so each gets its own stock before,
//               taken just before it starts. Nothing sells while it decants.
//               Chambers still in the truck go into a tank whenever you like —
//               no tank waits for another to finish.
//   5 Result  — variation per tank; shared as a picture

import {
  PRODUCTS, chambersLeft, checkPlan, densityCheck, dipAtLitres, drainAt, drainTimeline, fillLimit, litresAtDip, loadChambers, roomOf, round2, routingHint, solvePlan,
  stockProof, suggestPlan, tankResult, tankStage, transportOptions, unprovenReadings, usedChambers,
} from './core.js';
import { deleteSession, newId, saveInvoice, saveSession, saveTankReading, state } from './store.js';
import { decantScene, tickScenes } from './scene.js';
import {
  PRODUCT_COLOR, ago, ask, bandBadge, bandView, closeSheet, confBadge, download, elapsed, esc, fmtDate, fmtDip, fmtKL, fmtL, fmtMoney,
  fmtPct, fmtSigned, fmtTime, fmtWhen, openSheet, productChip, productShort, tankGauge, toast, truckStrip,
} from './ui.js';
import {
  busyTanks, compactNos, enter, invoiceForm, isStale, layoutFor, proofLine, readScreenshot, render, tankById, tankName, tanks, typedReading,
} from './app.js';

let currentId = null;
let shown = '';            // session:step last drawn (a new step's cards rise in)
let typing = null;         // {tank, phase} while the "type the stock" row is open
let moving = { id: null, pick: {} };   // the tank picked for each chamber still in the truck
let timer = null;
let bound = null;

const STEPS = [['truck', 'Truck'], ['before', 'Before'], ['plan', 'Plan'], ['decant', 'Decant'], ['result', 'Result']];

export function wizardActive() {
  return Boolean(currentId && state.sessions.some((s) => s.id === currentId));
}

export function openWizard(id) {
  currentId = id;
  typing = null;
  window.scrollTo(0, 0);
  render();
}

function closeWizard() {
  currentId = null;
  typing = null;
  clearInterval(timer);
  timer = null;
  render();
}

const session = () => state.sessions.find((s) => s.id === currentId);

function stepOf(s) {
  if (s.status === 'decanting' || s.status === 'settling') return 'decant';
  if (s.status === 'done' || s.status === 'cancelled') return 'result';
  return s.data.step || 'truck';
}

// ---- tanks of a decantation: waiting → decanting → settling → read ----------

const stageOf = (s, t) => tankStage(s, t);
const startOf = (s, t) => t.startedAt || (stageOf(s, t) === 'waiting' ? null : s.data.startedAt || null);
const doneOf = (s, t) => t.doneAt || (['settling', 'read'].includes(stageOf(s, t)) ? s.data.decantedAt || null : null);
const anyDone = (s) => (s.data.tanks || []).some((t) => doneOf(s, t));
// a reading's dip — from the dip chart if it wasn't read or typed
const dipOf = (r) => (r ? (Number.isFinite(r.dip) ? r.dip : dipAtLitres(state.chart, r.volume)) : null);

// The session's status and times follow its tanks.
function syncStatus(s) {
  const d = s.data;
  const pinned = d.tanks.map((t) => ({ stage: stageOf(s, t), startedAt: startOf(s, t), doneAt: doneOf(s, t) }));
  d.tanks.forEach((t, i) => Object.assign(t, pinned[i]));
  const running = d.tanks.some((t) => t.stage === 'decanting');
  const waiting = d.tanks.some((t) => t.stage === 'waiting');
  const started = d.tanks.some((t) => t.startedAt);
  if (!d.tanks.length || (waiting && !started)) s.status = 'draft';
  else if (running || waiting) s.status = 'decanting';
  else s.status = 'settling';
  const starts = d.tanks.map((t) => t.startedAt).filter(Boolean).sort();
  const dones = d.tanks.map((t) => t.doneAt).filter(Boolean).sort();
  d.startedAt = starts[0] || null;
  d.decantedAt = running || waiting ? null : dones[dones.length - 1] || null;
}

// A new decantation for an invoice (or the open draft for it).
export async function startSession(inv) {
  const draft = state.sessions.find((s) => s.invoice_no === inv.invoice_no && s.status === 'draft');
  if (draft) { openWizard(draft.id); return; }
  const layout = layoutFor(inv);
  const used = usedChambers(state.sessions, inv.invoice_no);
  const s = {
    id: newId('S'),
    invoice_no: inv.invoice_no,
    tt_no: inv.tt_no,
    status: 'draft',
    data: {
      step: 'truck',
      invoice: {
        invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, invoice_time: inv.invoice_time, tt_no: inv.tt_no,
        lines: inv.lines, chambers: inv.chambers, density15: inv.density15, seals: inv.seals, source: inv.source,
      },
      chambers: layout.chambers.map((c) => ({ no: c.no, litres: c.litres, product: c.product, dipCm: c.dipCm, how: c.how })),
      done: [...used],
      prices: Object.fromEntries(layout.lines.filter((l) => l.pricePerL).map((l) => [l.key, round2(l.pricePerL)])),
      densities: Object.fromEntries(layout.lines.filter((l) => l.density15).map((l) => [l.key, l.density15])),
      checks: { density: {} },
      before: {},
      plan: [],
      tanks: [],
      operator: state.device.operator || '',
    },
  };
  await saveSession(s);
  openWizard(s.id);
}

function persist(s) {
  return saveSession(s);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderWizard(el) {
  const s = session();
  if (!s) { closeWizard(); return; }
  if (bound !== el) {
    el.addEventListener('click', (e) => onClick(e));
    el.addEventListener('change', (e) => onChange(e));
    el.addEventListener('input', (e) => onInput(e));
    bound = el;
  }
  const step = stepOf(s);
  const inv = s.data.invoice || {};
  const idx = STEPS.findIndex(([k]) => k === step);
  el.innerHTML = `
    <div class="wz-top">
      <button class="btn sm" data-wz="close">← Back</button>
      <div class="t"><b>${esc(s.tt_no || '')}</b><span>${esc(s.invoice_no || '')} · ${esc(inv.invoice_date || '')} ${esc(inv.invoice_time || '')}</span></div>
      ${['draft', 'decanting'].includes(s.status) && !anyDone(s) ? '<button class="btn sm ghost danger" data-wz="cancel">Cancel</button>' : ''}
    </div>
    <div class="steps">${STEPS.map(([k, label], i) => `<div class="step${i === idx ? ' on' : i < idx ? ' done' : ''}"${i === idx ? ' aria-current="step"' : ''}>${label}</div>`).join('')}</div>
    <div id="wzBody">${{ truck: stepTruck, before: stepBefore, plan: stepPlan, decant: stepDecant, result: stepResult }[step](s)}</div>`;
  if (shown !== `${s.id}:${step}`) { shown = `${s.id}:${step}`; enter(el.querySelector('#wzBody')); }
  clearInterval(timer);
  if (step === 'decant') timer = setInterval(tick, 1000);
  tick();
  tickScenes(el);                                        // the picture as it is now (mid pipe move too)
}

function tick() {
  const s = session();
  if (!s) return;
  const now = Date.now();
  const row = (id) => (s.data.tanks || []).find((x) => x.tank === id);
  document.querySelectorAll('[data-ttimer]').forEach((el) => {
    const t = row(el.dataset.ttimer);
    const at = t && startOf(s, t);
    if (at) el.textContent = elapsed(now - Date.parse(at));
  });
  document.querySelectorAll('[data-tdrain]').forEach((el) => {
    const t = row(el.dataset.tdrain);
    if (t) el.textContent = drainText(s, t, now);
  });
  document.querySelectorAll('[data-tsettle]').forEach((el) => {
    const t = row(el.dataset.tsettle);
    const at = t && doneOf(s, t);
    if (!at) return;
    const left = Date.parse(at) + state.settings.settleMinutes * 60000 - now;
    el.textContent = left > 0 ? `Let it settle — stock after in ${elapsed(left)}.` : 'Settled — take its stock after.';
  });
}

// ---- 1. Truck ----------------------------------------------------------------

function stepTruck(s) {
  const d = s.data;
  if (!d.chambers.length) {
    // no chamber table on the invoice and a truck we haven't seen: pick up the
    // chambers once they've been typed in
    const inv = state.invoices.find((x) => x.invoice_no === s.invoice_no);
    const lay = inv ? layoutFor(inv) : null;
    if (lay?.chambers.length) {
      d.chambers = lay.chambers.map((c) => ({ no: c.no, litres: c.litres, product: c.product, dipCm: c.dipCm, how: c.how }));
      d.invoice = { ...d.invoice, lines: inv.lines, chambers: inv.chambers };
    } else {
      // a transport TT: it has one of the standard layouts for its size — the
      // ones that carry the invoice's products in whole chambers (MS from C1)
      const qty = {};
      for (const l of inv?.lines || d.invoice.lines || []) qty[productKeyOf(l)] = round2((qty[productKeyOf(l)] || 0) + (Number(l.qty_kl ?? l.qty) || 0));
      const kl = round2(Object.values(qty).reduce((a, b) => a + b, 0));
      const { size, layouts } = transportOptions(kl, state.settings.transportTTs);
      const fits = layouts.filter((caps) => {
        const r = loadChambers(caps, qty);
        return !r.left && Object.entries(qty).every(([p, v]) => r.chambers.filter((c) => c.product === p).reduce((a, c) => a + c.litres, 0) === Math.round(v * 1000));
      });
      const offer = fits.length ? fits : layouts;
      return `<div class="card warn"><div class="sect-title">No chamber details</div>
        <div class="hint">The invoice has no chamber table.${size ? ` A ${size} KL transport TT comes as ${offer.length > 1 ? 'one of these — tap the one it is' : 'this — tap it if that\'s the TT'}:` : ' Enter its chambers (KL each) and what\'s in them.'}</div>
        ${size ? `<div class="chipset" style="margin-top:8px">${offer.map((l) => `<button type="button" class="chipbtn" data-layout="${l.join(',')}">${l.join(' + ')}</button>`).join('')}</div>` : ''}
        ${size && fits.length && fits.length < layouts.length ? `<div class="hint" style="margin-top:6px">The other ${size} KL layout${layouts.length - fits.length > 1 ? 's' : ''} can't carry this invoice's split in whole chambers.</div>` : ''}
        <div class="row-actions" style="justify-content:flex-start"><button class="btn sm" data-wz="editInvoice">✎ Enter the chambers</button></div></div>`;
    }
  }
  const done = new Set(d.done);
  const how = new Set(d.chambers.map((c) => c.how));
  const products = [...new Set(d.chambers.filter((c) => c.product && !done.has(c.no)).map((c) => c.product))];
  const noTank = products.filter((p) => !tanks().some((t) => t.product === p));
  const lines = (d.invoice.lines || []);
  const sum = {};
  for (const c of d.chambers) if (c.product) sum[c.product] = (sum[c.product] || 0) + c.litres;
  const mismatch = lines.map((l) => {
    const key = PRODUCTS[productKeyOf(l)] ? productKeyOf(l) : null;
    const want = Math.round(Number(l.qty_kl) * 1000);
    return key && sum[key] !== want && d.chambers.length ? `The invoice has ${fmtKL(want)} of ${key}; the chambers marked ${key} hold ${fmtKL(sum[key] || 0)}.` : null;
  }).filter(Boolean);
  // every chamber comes full (no part loads): one the invoice doesn't reach needs its product
  const unset = d.chambers.filter((c) => !c.product && c.litres > 0 && !done.has(c.no)).map((c) => c.no);
  if (unset.length) mismatch.push(`The invoice doesn't say what's in chamber${unset.length > 1 ? 's' : ''} ${compactNos(unset)} — every chamber comes full, so tap its product.`);
  return `
    <div class="card">
      <div class="sect-title">Chambers</div>
      ${truckStrip(d.chambers, { done })}
      <div class="hint" style="margin:6px 0 10px">${how.has('invoice') ? 'Products per chamber are from the invoice ("Comp No(s)").' : how.has('ms-rule') ? 'The invoice doesn\'t list chambers: MS is taken from chamber 1 upward, the rest after it.' : 'One product in every chamber.'}
        Tap a product to change it.${done.size ? ` Chambers ${compactNos([...done])} were decanted before.` : ''}</div>
      ${d.chambers.map((c) => `<div class="plan-tank" style="grid-template-columns:86px minmax(0,1fr)">
        <div class="pt-name">C${c.no} <span class="hint">${fmtKL(c.litres)}</span></div>
        ${done.has(c.no) ? '<div class="hint">decanted</div>' : `<div class="seg">${['MS', 'HSD', 'XG'].map((p) => `<button type="button" class="${c.product === p ? 'on' : ''}" data-setp="${c.no}" data-p="${p}">${productShort(p)}</button>`).join('')}</div>`}
      </div>`).join('')}
      ${[...mismatch, ...noTank.map((p) => `No tank here holds ${p}; those chambers can't be decanted.`)].map((m) => `<div class="banner" style="margin:10px 0 0">${esc(m)}</div>`).join('')}
    </div>
    <div class="card">
      <div class="sect-title">Density check <span class="hint">optional</span></div>
      <div class="hint" style="margin:-4px 0 6px">The hydrometer reading and temperature of the truck's sample; the app works out the density at 15 °C and compares it with the invoice.</div>
      ${products.map((p) => densityRow(s, p)).join('') || '<div class="hint">Nothing left to decant.</div>'}
    </div>
    <button class="cta block" data-wz="toBefore" ${products.some((p) => tanks().some((t) => t.product === p)) ? '' : 'disabled'}>Next: stock before ▶</button>`;
}

function productKeyOf(line) {
  const u = String(line.column_key || line.product || '').toUpperCase();
  if (/XTRA/.test(u)) return 'XG';
  if (/EBMS|(^|[^A-Z])MS([^A-Z]|$)|PETROL/.test(u)) return 'MS';
  if (/LSHF/.test(u)) return 'LSHF';
  return 'HSD';
}

function densityRow(s, p) {
  const d = s.data;
  const inv15 = d.densities?.[p];
  const cur = d.checks.density?.[p] || {};
  const res = densityCheck({ reading: cur.reading, tempC: cur.temp, invoice15: inv15, limitKg: state.settings.densityLimit });
  return `<div class="dens">
    <div>${productChip(p)}<div class="hint" style="margin-top:4px">Invoice @15 °C: <b>${inv15 ?? '—'}</b></div></div>
    <label class="f">Reading (kg/m³)<input type="number" inputmode="decimal" step="0.1" data-dens="${p}" data-k="reading" value="${cur.reading ?? ''}"></label>
    <label class="f">Temp (°C)<input type="number" inputmode="decimal" step="0.1" data-dens="${p}" data-k="temp" value="${cur.temp ?? ''}"></label>
  </div>
  <div class="hint" data-densout="${p}" style="margin:4px 0 8px">${densityText(res)}</div>`;
}

function densityText(res) {
  if (!res) return '';
  return `@15 °C: <b>${res.d15}</b> — ${fmtSigned(res.diff, '', 1)} vs invoice ${res.ok ? bandBadge('ok') : `<span class="badge high"><i>✕</i>outside ±${state.settings.densityLimit}</span> — check with IndianOil before decanting`}`;
}

// ---- 2. Stock before ------------------------------------------------------

function remainingProducts(s) {
  const done = new Set(s.data.done);
  return [...new Set(s.data.chambers.filter((c) => c.product && c.litres > 0 && !done.has(c.no)).map((c) => c.product))];
}

function relevantTanks(s) {
  const prods = remainingProducts(s);
  return tanks().filter((t) => prods.includes(t.product));
}

function stepBefore(s) {
  const busy = busyTanks(s.id);
  const list = relevantTanks(s);
  for (const t of list) {
    if (!s.data.before[t.id] && state.tankState[t.id]) s.data.before[t.id] = { ...state.tankState[t.id] };
  }
  return `
    <div class="card accent">
      <div class="sect-title">Stock before decanting</div>
      <div class="hint">One screenshot of the automation's tank page reads every tank on it. Or type the stock in litres, or as a dip — you'll see both before you start.</div>
      <div class="rd-actions"><button class="cta sm" data-wz="shotBefore">📷 Read a screenshot</button></div>
    </div>
    ${list.map((t) => readingCard(s, t, s.data.before[t.id], 'before', busy.get(t.id))).join('')}
    <button class="cta block" data-wz="toPlan">Next: plan ▶</button>
    <div class="row-actions" style="justify-content:flex-start"><button class="btn sm ghost" data-wz="toTruck">◀ Truck</button></div>`;
}

function readingCard(s, t, r, phase, busyWith = null) {
  const stale = phase === 'before' && r && isStale(r);
  return `<div class="card" data-rtank="${t.id}">
    <div class="rd-head"><span class="nm">Tank ${t.no}</span>${productChip(t.product)}
      ${r ? confBadge(r.confidence, r.checks) : ''}
      ${stale ? '<span class="badge watch"><i>!</i>Old reading</span>' : ''}
      ${busyWith ? `<span class="badge high"><i>●</i>Being decanted from ${esc(busyWith.tt_no)}</span>` : ''}</div>
    ${readingInner(t, r, phase)}
  </div>`;
}

// A reading's figures, and the buttons to take a new one.
function readingInner(t, r, phase) {
  const open = typing && typing.tank === t.id && typing.phase === phase;
  return `${r ? `<div class="kv">
        <div><div class="k">Stock</div><div class="v big">${fmtL(r.volume, 2)}</div></div>
        <div><div class="k">Dip</div><div class="v big">${fmtDip(r.dip)}</div></div>
        <div><div class="k">Room</div><div class="v">${fmtL(roomOf(r, t), 2)}</div></div>
        <div><div class="k">Water</div><div class="v">${r.water != null ? fmtL(r.water, 2) : '—'}</div></div>
        <div><div class="k">Temp</div><div class="v">${r.temp ?? '—'}${r.temp != null ? ' °C' : ''}</div></div>
        <div><div class="k">Density (tc)</div><div class="v">${r.densityTc ?? '—'}</div></div>
      </div>
      <div class="rd-src">${{ photo: 'Screenshot', 'photo-edited': 'Screenshot, corrected', litres: 'Typed in', dip: 'From the dip' }[r.source] || ''} · ${['litres', 'dip'].includes(r.source) ? fmtWhen(r.readingAt) : r.timeRead === false ? `taken ${fmtWhen(r.readingAt)} (time not on the picture)` : `automation time ${fmtWhen(r.readingAt)}`} · ${ago(r.readingAt)}</div>
      ${proofLine(r)}`
    : '<div class="hint" style="margin-top:6px">No reading yet.</div>'}
    <div class="rd-actions">
      <button class="btn sm" data-shot="${phase}">📷 Screenshot</button>
      <button class="btn sm" data-type="${t.id}" data-phase="${phase}">✎ Type litres / dip</button>
    </div>
    ${open ? `<div class="manual">
        <label class="f">Litres<input type="number" inputmode="decimal" step="0.01" data-typel="${t.id}"></label>
        <label class="f">or dip (cm)<input type="number" inputmode="decimal" step="0.1" data-typed="${t.id}"></label>
        <button class="btn" data-typesave="${t.id}" data-phase="${phase}">Use</button>
      </div><div class="hint" data-typehint="${t.id}" style="margin-top:4px"></div>` : ''}`;
}

// ---- 3. Plan ---------------------------------------------------------------

function planContext(s) {
  const busy = busyTanks(s.id);
  const done = new Set(s.data.done);
  const layout = { chambers: s.data.chambers };
  return { busy, done, layout };
}

function ensurePlan(s) {
  const { busy, done, layout } = planContext(s);
  const valid = s.data.plan.length && s.data.plan.every((p) => !done.has(p.no));
  if (!valid) {
    s.data.plan = suggestPlan({ layout, tanks: tanks(), readings: s.data.before, exclude: done, busy: new Set(busy.keys()), settings: state.settings });
  }
  return s.data.plan;
}

function stepPlan(s) {
  const plan = ensurePlan(s);
  const { busy } = planContext(s);
  const chk = checkPlan({ plan, tanks: tanks(), readings: s.data.before, busy: new Set(busy.keys()), settings: state.settings, chart: state.chart });
  const products = [...new Set(plan.map((p) => p.product))];
  const total = plan.filter((p) => p.tank).reduce((a, p) => a + p.litres, 0);
  const sections = products.map((prod) => {
    const rows = plan.filter((p) => p.product === prod);
    const ts = tanks().filter((t) => t.product === prod);
    const chambers = s.data.chambers.filter((c) => rows.some((r) => r.no === c.no));
    const held = rows.filter((r) => !r.tank);
    return `<div class="card">
      <div class="sect-title">${productChip(prod)} ${fmtKL(rows.reduce((a, r) => a + r.litres, 0))} in C${compactNos(rows.map((r) => r.no))}</div>
      ${truckStrip(chambers, { target: (no) => { const r = rows.find((x) => x.no === no); return r?.tank ? tankName(r.tank).replace('Tank ', 'T') : 'hold'; }, onTap: true, active: new Set(rows.filter((r) => r.tank).map((r) => r.no)) })}
      <div class="hint" style="margin:2px 0 8px">Type how much goes in each tank — the chambers are picked to match. Or tap a chamber to move it.</div>
      ${ts.map((t) => planTankRow(s, t, rows, chk, busy)).join('')}
      ${held.length ? `<div class="hint" style="margin-top:8px">Stays in the truck for now: <b>C${compactNos(held.map((h) => h.no))}</b> (${fmtKL(held.reduce((a, h) => a + h.litres, 0))}) — start it into a tank whenever you like on the decanting screen, even while the others decant.</div>` : ''}
    </div>`;
  }).join('');
  return `${sections}
    ${chk.blocking.length || chk.warnings.length ? `<ul class="msgs">${chk.blocking.map((m) => `<li class="block">⛔ ${esc(m)}</li>`).join('')}${chk.warnings.map((m) => `<li class="warn">⚠ ${esc(m)}</li>`).join('')}</ul>` : ''}
    <div style="height:12px"></div>
    <button class="cta block" data-wz="start" ${chk.blocking.length ? 'disabled' : ''}>▶ Start decanting${chk.perTank.length > 1 ? ' into all' : ''}${total ? ` · ${fmtKL(total)}` : ''}</button>
    ${chk.perTank.length > 1 ? `<button class="btn block" data-wz="stepwise" ${chk.blocking.length ? 'disabled' : ''}>Tank by tank ▸ start each tank when you're ready</button>
      <div class="hint" style="margin-top:6px">Tank by tank: e.g. ${tankName(chk.perTank[0].tank)} now and ${tankName(chk.perTank[1].tank)} later — each tank gets its own stock before (just before it starts) and after.</div>` : ''}
    <div class="row-actions" style="justify-content:flex-start"><button class="btn sm ghost" data-wz="toBefore">◀ Stock before</button><button class="btn sm ghost" data-wz="replan">↺ Suggest again</button></div>`;
}

function planTankRow(s, t, rows, chk, busy) {
  const r = s.data.before[t.id];
  const mine = rows.filter((x) => x.tank === t.id);
  const litres = mine.reduce((a, x) => a + x.litres, 0);
  const info = chk.perTank.find((x) => x.tank === t.id);
  const room = r ? roomOf(r, t) : null;
  const lvl = info?.level || '';
  const disabled = busy.has(t.id) || !r;
  return `<div class="plan-tank lvl-${lvl}">
    <div>
      <div class="pt-name">Tank ${t.no} ${mine.length ? `<span class="hint">← C${compactNos(mine.map((x) => x.no))}</span>` : ''}</div>
      <div class="pt-sub">${busy.has(t.id) ? 'Being decanted from another truck' : !r ? 'No stock reading — add it in step 2' : `Room <b>${fmtL(room)}</b> · now <b>${fmtL(r.volume)}</b> (${fmtDip(r.dip)})`}
        ${info?.after ? `<br>After: <b>${fmtL(info.after)}</b> (${fmtDip(info.afterDip)}) · room left <b>${fmtL(info.leftRoom)}</b>` : ''}</div>
      ${r ? tankGauge({ product: t.product, volume: r.volume, capacity: t.capacity, limit: fillLimit(t), incoming: litres, label: `Tank ${t.no} plan` }) : ''}
    </div>
    <div class="pt-in"><input type="number" inputmode="decimal" step="0.5" min="0" data-req="${t.id}" data-prod="${t.product}" value="${litres ? litres / 1000 : ''}" placeholder="0" ${disabled ? 'disabled' : ''} aria-label="KL into Tank ${t.no}"><span>KL</span></div>
  </div>`;
}

// ---- 4. Decanting, tank by tank ------------------------------------------------

const STAGE = {
  waiting: '<span class="badge info"><i>◷</i>Not started</span>',
  decanting: '<span class="badge watch"><i>●</i>Decanting</span>',
  settling: '<span class="badge watch"><i>◐</i>Settling</span>',
  read: '<span class="badge ok"><i>✓</i>Stock after read</span>',
};

function stepDecant(s) {
  const d = s.data;
  const st = d.tanks.map((t) => stageOf(s, t));
  const count = (x) => st.filter((y) => y === x).length;
  const allRead = d.tanks.length > 0 && st.every((x) => x === 'read');
  const started = d.tanks.some((t) => startOf(s, t));
  const total = d.tanks.reduce((a, t) => a + t.litres, 0);
  return `<div class="card accent">
      <div class="sect-title">${fmtKL(total)} into ${d.tanks.map((t) => tankName(t.tank)).join(' & ')}</div>
      ${decantScene(s, { tanks: tanks(), stock: state.tankState, settings: state.settings })}
      <div class="hint">${d.tanks.length > 1 ? 'Start each tank when you\'re ready — together or one after the other. ' : ''}A tank sells until its decanting starts, so read its stock just before; nothing sells from it while it decants.</div>
      <div class="rd-actions"><button class="cta sm" data-wz="shotAfter">📷 Screenshot</button>
        <span class="hint" style="align-self:center">reads each tank's stock before or after, as needed</span></div>
    </div>
    ${d.tanks.map((t) => stageCard(s, t)).join('')}
    ${count('waiting') > 1 ? '<button class="btn block" data-wz="startAll">▶ Start all the tanks not started, together</button>' : ''}
    ${count('decanting') > 1 ? '<button class="cta block" data-wz="decanted">✓ Decanting done — all of them</button>' : ''}
    ${truckCards(s)}
    ${routingCards(s)}
    ${st.includes('read') ? '<div class="row-actions" style="justify-content:flex-start;margin-top:0"><button class="btn sm ghost" data-wz="route">✎ Which chamber went where?</button></div>' : ''}
    <button class="cta block" data-wz="finish" ${allRead ? '' : 'disabled'}>Finish & save the result</button>
    ${allRead && leftInTruck(s).length ? `<div class="hint" style="margin-top:6px">C${compactNos(leftInTruck(s).map((c) => c.no))} ${leftInTruck(s).length > 1 ? 'stay' : 'stays'} in the truck — once this is saved, "Decant the rest" on the list decants ${leftInTruck(s).length > 1 ? 'them' : 'it'}.</div>` : ''}
    ${started ? '' : '<div class="row-actions" style="justify-content:flex-start"><button class="btn sm ghost" data-wz="backToPlan">◀ Plan</button></div>'}`;
}

// ---- chambers still in the truck ------------------------------------------------
// Held back in the plan, kept for later ("Not now") or not emptied: they go
// into a tank whenever you like — it starts on its own, whatever the other
// tanks are doing. The app suggests a tank per chamber; tap to change it.

// This truck's chambers still in it that a tank here can take (and no other
// phone's decantation of the invoice has taken meanwhile).
function leftInTruck(s) {
  const taken = usedChambers(state.sessions, s.invoice_no, s.id);
  return chambersLeft(s).filter((c) => !taken.has(c.no) && tanks().some((t) => t.product === c.product));
}

// The newer of two stock readings.
const newer = (a, b) => (!a ? b : !b ? a : Date.parse(b.readingAt || 0) > Date.parse(a.readingAt || 0) ? b : a);

// Tanks that can take chambers of product `p` now, with the room each has left:
// any not being decanted from another truck — of this truck's own, only one
// still waiting or decanting (one settling or read has its stock after due).
function takers(s, p) {
  const busy = busyTanks(s.id);
  const out = [];
  for (const t of tanks()) {
    if (t.product !== p || busy.has(t.id)) continue;
    const row = s.data.tanks.find((x) => x.tank === t.id);
    const st = row ? stageOf(s, row) : null;
    if (st === 'settling' || st === 'read') continue;
    const before = st === 'decanting' ? row.before : newer(row?.before || s.data.before[t.id], state.tankState[t.id]);
    out.push({ id: t.id, stage: st, room: before ? round2(roomOf(before, t) - (row?.litres || 0)) : NaN });
  }
  return out;
}

// The tank picked for each chamber left ('' = later): your taps, else the
// app's suggestion — as much as fits, in as few tanks as possible.
function picksFor(s, left) {
  if (moving.id !== s.id) moving = { id: s.id, pick: {} };
  const out = {};
  for (const p of new Set(left.map((c) => c.product))) {
    const cs = left.filter((c) => c.product === p);
    const ts = takers(s, p);
    if (cs.some((c) => !(c.no in moving.pick))) {
      const { assign } = solvePlan({ chambers: cs, tanks: ts.filter((t) => Number.isFinite(t.room)), warnRoomL: state.settings.warnRoomL });
      for (const c of cs) if (!(c.no in moving.pick)) moving.pick[c.no] = assign[c.no] || '';
    }
    for (const c of cs) out[c.no] = ts.some((t) => t.id === moving.pick[c.no]) ? moving.pick[c.no] : '';
  }
  return out;
}

// What the picks of product `p` put into each tank: [{id, chambers, litres, over, taker}].
function picksInto(s, p, left, pick) {
  const ts = takers(s, p);
  const into = {};
  for (const c of left) if (c.product === p && pick[c.no]) (into[pick[c.no]] ||= []).push(c);
  return Object.entries(into).map(([id, cs]) => {
    const taker = ts.find((t) => t.id === id);
    const litres = cs.reduce((a, c) => a + c.litres, 0);
    return { id, chambers: cs.map((c) => c.no), litres, over: Number.isFinite(taker.room) && litres > taker.room + 1e-6, taker };
  });
}

function truckCards(s) {
  const left = leftInTruck(s);
  if (!left.length) return '';
  const pick = picksFor(s, left);
  const busy = busyTanks(s.id);
  return [...new Set(left.map((c) => c.product))].map((p) => {
    const cs = left.filter((c) => c.product === p);
    const ts = takers(s, p);
    const head = `<div class="rd-head"><span class="nm">Still in the truck</span>${productChip(p, `${fmtKL(cs.reduce((a, c) => a + c.litres, 0))} · C${compactNos(cs.map((c) => c.no))}`)}</div>`;
    if (!ts.length) {
      const them = cs.length > 1 ? 'them' : 'it';
      const mine = tanks().filter((t) => t.product === p);
      const why = mine.map((t) => (busy.has(t.id) ? `${tankName(t.id)} is being decanted from ${busy.get(t.id).tt_no || 'another truck'}` : `${tankName(t.id)} was already filled from this truck`));
      const other = mine.some((t) => busy.has(t.id));
      return `<div class="card" data-intruck="${p}">${head}
        <div class="hint" style="margin-top:6px">No ${esc(productShort(p))} tank can take ${them} just now: ${esc(why.join('; '))}. ${other ? `Start ${them} here once that tank is free — or save` : 'Save'} this decanting and decant ${them} later with "Decant the rest" on the list.</div></div>`;
    }
    const into = picksInto(s, p, left, pick);
    const stage = { waiting: ' (not started)', decanting: ' (decanting now)' };
    return `<div class="card" data-intruck="${p}">${head}
      <div class="hint" style="margin:4px 0 8px">Start ${cs.length > 1 ? 'them' : 'it'} into a tank now — whatever the other tanks are doing — or leave ${cs.length > 1 ? 'them' : 'it'} for later.</div>
      ${cs.map((c) => `<div class="plan-tank pick-row"><div class="pt-name">C${c.no} <span class="hint">${fmtKL(c.litres)}</span></div>
        <div class="seg">${ts.map((t) => `<button type="button" class="${pick[c.no] === t.id ? 'on' : ''}" data-pick="${c.no}" data-to="${t.id}">${tankName(t.id)}</button>`).join('')}<button type="button" class="${pick[c.no] ? '' : 'on'}" data-pick="${c.no}" data-to="">Later</button></div></div>`).join('')}
      ${into.map((x) => `<div class="hint${x.over ? ' bad' : ''}" style="margin-top:6px">${tankName(x.id)}${stage[x.taker.stage] || ''}: ${fmtKL(x.litres)} into ${Number.isFinite(x.taker.room) ? `room for ${fmtL(x.taker.room)}${x.over ? ' — too much, pick fewer chambers for it' : ''}` : 'no stock reading yet'}</div>`).join('')}
      <div class="row-actions"><button class="cta sm" data-fromtruck="${p}" ${into.length && !into.some((x) => x.over) ? '' : 'disabled'}>▶ Start ${into.length ? into.map((x) => `C${compactNos(x.chambers)} into ${tankName(x.id)}`).join(', ') : 'into a tank'}</button></div>
    </div>`;
  }).join('');
}

// ▶ Start: the picked chambers go into their tanks now. A tank this truck isn't
// filling yet joins and starts — its stock before is checked as for any tank,
// and it waits on this screen if a fresh one is needed; a tank already
// decanting takes them as well.
async function startFromTruck(s, p) {
  const d = s.data;
  const left = leftInTruck(s).filter((c) => c.product === p);
  const into = picksInto(s, p, left, picksFor(s, left));
  if (!into.length) return;
  const over = into.find((x) => x.over);
  if (over) { toast(`${tankName(over.id)} has room for only ${fmtL(over.taker.room)} — pick fewer chambers for it.`, 5000); return; }
  const byNo = new Map(left.map((c) => [c.no, c]));
  for (const x of into) {
    const row = d.tanks.find((t) => t.tank === x.id);
    if (row) {
      // the pipe takes them after the chambers it has (its order is the list's)
      if (stageOf(s, row) === 'decanting') {
        const at = new Date().toISOString();
        row.joinedAt = { ...(row.joinedAt || {}), ...Object.fromEntries(x.chambers.map((no) => [no, at])) };
      }
      row.chambers = [...row.chambers, ...x.chambers];
      row.litres += x.litres;
    } else {
      const before = newer(d.before[x.id], state.tankState[x.id]);
      d.tanks.push({
        tank: x.id, tankNo: tankById(x.id)?.no, product: p, litres: x.litres, chambers: x.chambers, before: before ? { ...before } : null, after: null,
        pricePerL: d.prices?.[p] ?? null, stage: 'waiting', startedAt: null, doneAt: null,
      });
    }
    for (const no of x.chambers) {
      const row2 = d.plan.find((q) => q.no === no);
      if (row2) row2.tank = x.id;
      else d.plan.push({ no, product: p, litres: byNo.get(no).litres, tank: x.id });
      delete moving.pick[no];
    }
  }
  d.plan.sort((a, b) => a.no - b.no);
  d.tanks.sort((a, b) => (a.tankNo || 0) - (b.tankNo || 0));
  d.step = 'decant';
  syncStatus(s);
  const toStart = into.filter((x) => stageOf(s, d.tanks.find((t) => t.tank === x.id)) === 'waiting').map((x) => x.id);
  const joined = into.filter((x) => !toStart.includes(x.id));
  if (toStart.length && await startTanks(s, toStart)) return;
  await persist(s);                        // e.g. "take a new reading first": the tank waits here, ready to start
  if (joined.length && !toStart.length) toast(`${joined.map((x) => `C${compactNos(x.chambers)} into ${tankName(x.id)}`).join(', ')} too — decanting.`);
}

function stageCard(s, t) {
  const st = stageOf(s, t);
  const tk = tankById(t.tank);
  const head = `<div class="rd-head"><span class="nm">${tankName(t.tank)}</span>${productChip(t.product, `${fmtKL(t.litres)} · C${compactNos(t.chambers)}`)}
    <span class="sp" style="flex:1"></span>${STAGE[st]}</div>`;
  if (st === 'waiting') {
    return `<div class="card">${head}
      <div class="sect-title" style="margin:10px 0 0;font-size:13px">Stock before</div>
      ${readingInner(tk, t.before, 'before')}
      <div class="row-actions"><button class="btn sm ghost" data-drop="${t.tank}">Not now — keep in the truck</button>
        <button class="cta sm" data-starttank="${t.tank}">▶ Start ${tankName(t.tank)}</button></div>
    </div>`;
  }
  if (st === 'decanting') {
    return `<div class="card accent">${head}
      <div class="bigtimer sm" data-ttimer="${t.tank}">0:00</div>
      <div class="hint" style="text-align:center">since ${fmtTime(startOf(s, t))} · stock before ${fmtL(t.before?.volume, 2)} (${fmtDip(dipOf(t.before))})</div>
      <div class="hint" style="text-align:center;margin-top:4px;color:var(--muted);white-space:pre-line" data-tdrain="${t.tank}">${esc(drainText(s, t, Date.now()))}</div>
      <div class="row-actions"><button class="cta" data-donetank="${t.tank}">✓ ${tankName(t.tank)} done</button></div>
    </div>`;
  }
  const res = t.after ? tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings) : null;
  const expect = round2(t.before.volume + t.litres - (Number(t.salesL) || 0));
  const warn = afterWarnings(s, t);
  return `<div class="card">${head}
      <div class="hint" style="margin-top:4px">${fmtTime(startOf(s, t))}–${fmtTime(doneOf(s, t))}${st === 'settling' ? ' · <b data-tsettle="' + t.tank + '"></b>' : ''}</div>
      <div class="sect-title" style="margin:10px 0 0;font-size:13px">Stock after</div>
      ${readingInner(tk, t.after, 'after')}
      <table class="cmp"><tbody>
        <tr><td>Before (${fmtTime(t.before.readingAt)})</td><td>${fmtL(t.before.volume, 2)}</td><td>${fmtDip(dipOf(t.before))}</td></tr>
        <tr><td>+ Chambers ${compactNos(t.chambers)}</td><td>${fmtL(t.litres)}</td><td></td></tr>
        <tr class="tot"><td>Should read</td><td>${fmtL(expect, 2)}</td><td>${fmtDip(dipAtLitres(state.chart, expect))}</td></tr>
        ${res ? `<tr class="tot"><td>Variation</td><td${res.variation > 0 ? ' class="pos"' : ''}>${fmtSigned(res.variation, ' L', 2)}</td><td>${bandBadge(res.band, res.direction)}</td></tr>` : ''}
      </tbody></table>
      ${warn.length ? `<ul class="msgs">${warn.map((w) => `<li class="warn">⚠ ${esc(w)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

// The pipe's round by the chambers' times (Settings): the chamber it's on,
// what's next and about how long is left — or that all should be empty now —
// then the litres: left in that chamber, and in the tank (≈, till it's read).
function drainText(s, t, now) {
  const at = drainAt(drainTimeline(t, s.data.chambers, state.settings), now);
  if (!at) return '';
  const next = t.chambers.slice(t.chambers.indexOf(at.on) + 1);
  const before = Number(t.before?.volume) || 0;
  const inTank = `${tankName(t.tank)} ≈${fmtL(before + at.litres)} (+${fmtL(at.litres)})`;
  if (at.done) return `By the chamber times, C${compactNos(t.chambers)} should be empty now — tap ✓ once ${t.chambers.length > 1 ? 'they are' : 'it is'}.\n${inTank}`;
  if (at.moving) {
    // C4 empty: its valve closed, the hose carried to C5, coupled, C5's valve opened
    const after = t.chambers.slice(t.chambers.indexOf(at.moving.to) + 1);
    return `Moving the pipe from C${at.moving.from} to C${at.moving.to}${after.length ? `, then C${after.join(', C')}` : ''} · ${elapsed(at.moving.until - now)} · about ${elapsed(at.left)} to go\n${inTank}`;
  }
  const left = (s.data.chambers.find((c) => c.no === at.on)?.litres || 0) * (1 - at.drained[at.on]);
  return `Pipe on C${at.on}${next.length ? `, then C${next.join(', C')}` : ''} · about ${elapsed(at.left)} to go\nC${at.on} ≈${fmtL(left)} left · ${inTank}`;
}

function afterWarnings(s, t) {
  const out = [];
  const a = t.after;
  const b = t.before;
  const done = doneOf(s, t);
  if (!a || !b) return out;
  if (a.timeRead !== false && a.readingAt && done && Date.parse(a.readingAt) < Date.parse(done) - 60000) {
    out.push(`This reading is from ${fmtTime(a.readingAt)}, before decanting finished (${fmtTime(done)}) — take a new screenshot.`);
  }
  if (a.volume === b.volume && a.readingAt === b.readingAt) out.push('This is the same reading as before decanting.');
  else if (a.volume <= b.volume) out.push('The stock didn\'t go up — wrong tank or an old screenshot?');
  if (a.water > 0 && !(b.water > 0)) out.push(`Water shows now: ${fmtL(a.water, 2)}.`);
  return out;
}

// When the after-stock says the chambers went differently from the plan.
function routingCards(s) {
  const d = s.data;
  const byNo = Object.fromEntries(d.chambers.map((c) => [c.no, c.litres]));
  return [...new Set(d.tanks.map((t) => t.product))].map((p) => {
    const rows = d.tanks.filter((t) => t.product === p);
    const h = routingHint(rows, byNo, state.settings);
    if (!h) return '';
    const now = rows.map((r) => `${tankName(r.tank)} ${fmtSigned(r.after.volume - r.before.volume + (Number(r.salesL) || 0) - r.litres, ' L')}`).join(', ');
    const then = rows.map((r) => {
      const nos = Object.keys(h.assign).filter((no) => h.assign[no] === r.tank).map(Number);
      return `${nos.length ? `C${compactNos(nos)}` : 'nothing'} → ${tankName(r.tank)}`;
    }).join(' and ');
    return `<div class="card warn">
      <div class="sect-title">⚠ Did the chambers go somewhere else?</div>
      <div class="hint">As planned, the ${productShort(p)} tanks are off by ${esc(now)}. If <b>${esc(then)}</b>, they'd be off by only ${fmtL(h.missThen)} in all.</div>
      <div class="row-actions" style="justify-content:flex-start"><button class="cta sm" data-useroute="${p}">Yes — ${esc(then)}</button><button class="btn sm" data-wz="route">Change it myself</button></div>
    </div>`;
  }).join('');
}

// ---- 6. Result -----------------------------------------------------------------

function stepResult(s) {
  const d = s.data;
  if (s.status === 'cancelled') {
    return `<div class="card warn"><div class="sect-title">Cancelled</div><div class="hint">${esc(d.cancelReason || 'Nothing was decanted.')}</div></div>
      <button class="cta block" data-wz="close">Done</button>`;
  }
  const res = d.tanks.map((t) => ({ t, r: tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings) }));
  const totL = d.tanks.reduce((a, t) => a + t.litres, 0);
  const totV = round2(res.reduce((a, x) => a + (x.r?.variation || 0), 0));
  const money = res.reduce((a, x) => a + (x.r && d.prices?.[x.t.product] ? x.r.variation * d.prices[x.t.product] : 0), 0);
  return `<div class="card accent">
      <div class="result"><div><div class="hint">Decanted ${fmtKL(totL)} from ${esc(s.tt_no)} · ${fmtTime(d.startedAt)}–${fmtTime(d.decantedAt)}</div>
        <div class="var ${totV < 0 ? 'short' : totV > 0 ? 'excess' : 'exact'}">${fmtSigned(totV, ' L', 2)}</div>
        <div class="hint">${totV < 0 ? 'short' : totV > 0 ? 'excess' : 'exact'} overall · ${fmtPct(totL ? (totV / totL) * 100 : 0)}${money ? ` · ≈ ${fmtMoney(money)} at invoice price` : ''}</div></div></div>
      ${auditLine(d.tanks) ? `<div class="audit ${auditLine(d.tanks).ok ? 'ok' : 'no'}">${esc(auditLine(d.tanks).text)}</div>` : ''}
    </div>
    ${res.map(({ t, r }) => `<div class="card">
      <div class="rd-head"><span class="nm">${tankName(t.tank)}</span>${productChip(t.product)}${r ? bandBadge(r.band, r.direction) : ''}</div>
      <div class="hint">C${compactNos(t.chambers)} · ${fmtKL(t.litres)} · decanted ${fmtTime(startOf(s, t))}–${fmtTime(doneOf(s, t))}</div>
      ${r ? `<div class="result" style="margin-top:6px"><div class="var ${r.direction}">${fmtSigned(r.variation, ' L', 2)}</div><div class="hint" style="text-align:right">${fmtPct(r.pct)}<br>OK within ±${fmtL(r.tol)}</div></div>` : ''}
      <table class="cmp"><thead><tr><th></th><th>Litres</th><th>Dip</th></tr></thead><tbody>
        <tr><td>Stock before · ${fmtTime(t.before.readingAt)}${fromOf(t.before)}</td><td>${fmtL(t.before.volume, 2)}</td><td>${fmtDip(dipOf(t.before))}</td></tr>
        <tr><td>Stock after · ${fmtTime(t.after?.readingAt)}${fromOf(t.after)}</td><td>${fmtL(t.after?.volume, 2)}</td><td>${fmtDip(dipOf(t.after))}</td></tr>
        <tr><td>Tank gained</td><td>${r ? fmtL(r.gain, 2) : '—'}</td><td></td></tr>
        <tr><td>Chambers ${compactNos(t.chambers)} (invoice)</td><td>${fmtL(t.litres)}</td><td></td></tr>
        ${t.salesL ? `<tr><td>Sold while decanting (older record)</td><td>${fmtL(t.salesL)}</td><td></td></tr>` : ''}
        <tr class="tot"><td>Variation</td><td${r?.variation > 0 ? ' class="pos"' : ''}>${r ? fmtSigned(r.variation, ' L', 2) : '—'}</td><td${r?.variation > 0 ? ' class="pos"' : ''}>${r && d.prices?.[t.product] ? fmtMoney(r.variation * d.prices[t.product]) : ''}</td></tr>
      </tbody></table>
    </div>`).join('')}
    ${routingCards(s)}
    <div class="card">
      <label class="f">Notes<textarea rows="2" data-notes placeholder="e.g. chamber 3 foamed, re-dipped after 15 min">${esc(d.notes || '')}</textarea></label>
      <div class="hint" style="margin-top:8px">${esc(resultFooter(s))}</div>
    </div>
    <div class="row-actions">
      <button class="btn danger" data-wz="delete">Delete</button>
      <button class="btn" data-wz="share">📤 Share as picture</button>
      <button class="btn" data-wz="reopen">✎ Change the after-stock</button>
      <button class="cta" data-wz="close">Done</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function onClick(e) {
  const s = session();
  if (!s) return;
  const t = e.target;
  const act = t.closest('[data-wz]')?.dataset.wz;
  const d = s.data;
  if (act === 'close') { closeWizard(); return; }
  if (act === 'cancel') { cancelSession(s); return; }
  if (act === 'toTruck') { d.step = 'truck'; await persist(s); return; }
  if (act === 'editInvoice') {
    const inv = state.invoices.find((x) => x.invoice_no === s.invoice_no);
    if (inv) invoiceForm(inv);
    return;
  }
  if (act === 'toBefore') { d.step = 'before'; await persist(s); return; }
  if (act === 'toPlan') { d.step = 'plan'; await persist(s); return; }
  if (act === 'replan') { d.plan = []; await persist(s); return; }
  if (act === 'shotBefore' || act === 'shotAfter' || t.closest('[data-shot]')) { await shot(s, stepOf(s) === 'decant' ? 'decant' : 'before'); return; }
  if (act === 'start') { await start(s); return; }
  if (act === 'stepwise') { await stepwise(s); return; }
  if (act === 'backToPlan') { d.tanks = []; d.step = 'plan'; syncStatus(s); await persist(s); return; }
  if (act === 'startAll') { await startTanks(s, d.tanks.filter((x) => stageOf(s, x) === 'waiting').map((x) => x.tank)); return; }
  if (act === 'decanted') { await doneTanks(s, d.tanks.filter((x) => stageOf(s, x) === 'decanting').map((x) => x.tank)); return; }
  if (act === 'finish') { await finish(s); return; }
  const startBtn = t.closest('[data-starttank]');
  if (startBtn) { await startTanks(s, [startBtn.dataset.starttank]); return; }
  const doneBtn = t.closest('[data-donetank]');
  if (doneBtn) { await doneTanks(s, [doneBtn.dataset.donetank]); return; }
  const dropBtn = t.closest('[data-drop]');
  if (dropBtn) { await dropTank(s, dropBtn.dataset.drop); return; }
  const pickBtn = t.closest('[data-pick]');
  if (pickBtn) {
    if (moving.id !== s.id) moving = { id: s.id, pick: {} };
    moving.pick[Number(pickBtn.dataset.pick)] = pickBtn.dataset.to;
    render();
    return;
  }
  const fromTruck = t.closest('[data-fromtruck]');
  if (fromTruck) { await startFromTruck(s, fromTruck.dataset.fromtruck); return; }
  if (act === 'share') { share(s); return; }
  if (act === 'route') { routeEditor(s); return; }
  const useRoute = t.closest('[data-useroute]');
  if (useRoute) {
    const p = useRoute.dataset.useroute;
    const byNo = Object.fromEntries(d.chambers.map((c) => [c.no, c.litres]));
    const h = routingHint(d.tanks.filter((x) => x.product === p), byNo, state.settings);
    if (h) await applyRouting(s, h.assign, p);
    return;
  }
  if (act === 'delete') {
    if (!(await ask('Delete this decantation?', 'It goes from the log and the reports on every phone, with its screenshots. The chambers go back to the list as not decanted.', { ok: 'Delete', danger: true }))) return;
    const id = s.id;
    closeWizard();
    await deleteSession(id);
    toast('Deleted.');
    return;
  }
  if (act === 'reopen') {
    if (!(await ask('Change the after-stock?', 'The result is worked out again when you finish.', { ok: 'Change it' }))) return;
    s.status = 'settling';
    s.completed_at = null;
    await persist(s);
    return;
  }
  const lay = t.closest('[data-layout]');
  if (lay) {
    // the transport TT's standard layout: onto the invoice (it lists the chambers from now on)
    const inv = state.invoices.find((x) => x.invoice_no === s.invoice_no);
    if (!inv) return;
    const chambers = lay.dataset.layout.split(',').map((kl, i) => ({ no: i + 1, qty_kl: Number(kl), dip_cm: null, pl_cm: null }));
    await saveInvoice({ ...inv, chambers });
    return;
  }
  const setp = t.closest('[data-setp]');
  if (setp) {
    const c = d.chambers.find((x) => x.no === Number(setp.dataset.setp));
    c.product = setp.dataset.p || null;
    c.how = 'edited';
    d.plan = [];
    await persist(s);
    syncInvoiceChambers(s);
    return;
  }
  const typeBtn = t.closest('[data-type]');
  if (typeBtn) {
    typing = typing && typing.tank === typeBtn.dataset.type ? null : { tank: typeBtn.dataset.type, phase: typeBtn.dataset.phase };
    render();
    setTimeout(() => document.querySelector(`[data-typel="${typeBtn.dataset.type}"]`)?.focus(), 30);
    return;
  }
  const save = t.closest('[data-typesave]');
  if (save) {
    const id = save.dataset.typesave;
    const l = document.querySelector(`[data-typel="${id}"]`)?.value;
    const dip = document.querySelector(`[data-typed="${id}"]`)?.value;
    try {
      const r = typedReading(id, { litres: l ? Number(l) : NaN, dipCm: dip ? Number(dip) : NaN });
      setReading(s, id, r, save.dataset.phase);
      typing = null;
      saveTankReading(id, r);
      await persist(s);
    } catch (err) {
      const h = document.querySelector(`[data-typehint="${id}"]`);
      if (h) h.textContent = err.message;
    }
    return;
  }
  const ch = t.closest('[data-ch]');
  if (ch && stepOf(s) === 'plan') { cycleChamber(s, Number(ch.dataset.ch)); }
}

function onChange(e) {
  const s = session();
  if (!s) return;
  const t = e.target;
  const d = s.data;
  if (t.matches('[data-req]')) {
    const prod = t.dataset.prod;
    const req = {};
    document.querySelectorAll(`[data-req][data-prod="${prod}"]`).forEach((inp) => { req[inp.dataset.req] = Math.round(Number(inp.value || 0) * 1000); });
    replanProduct(s, prod, req, t.dataset.req);
    t.blur();
    persist(s);
    return;
  }
  if (t.matches('[data-notes]')) { d.notes = t.value; persist(s); }
  if (t.matches('[data-dens]')) {
    const p = t.dataset.dens;
    d.checks.density[p] = { ...(d.checks.density[p] || {}), [t.dataset.k]: t.value === '' ? null : Number(t.value) };
    persist(s);
  }
}

function onInput(e) {
  const s = session();
  if (!s) return;
  const t = e.target;
  if (t.matches('[data-dens]')) {
    const p = t.dataset.dens;
    const row = { ...(s.data.checks.density[p] || {}), [t.dataset.k]: t.value === '' ? null : Number(t.value) };
    s.data.checks.density[p] = row;
    const out = document.querySelector(`[data-densout="${p}"]`);
    if (out) out.innerHTML = densityText(densityCheck({ reading: row.reading, tempC: row.temp, invoice15: s.data.densities?.[p], limitKg: state.settings.densityLimit }));
    return;
  }
  const id = t.dataset.typel || t.dataset.typed;
  if (id) {
    const h = document.querySelector(`[data-typehint="${id}"]`);
    const other = document.querySelector(t.dataset.typel ? `[data-typed="${id}"]` : `[data-typel="${id}"]`);
    if (other && t.value) other.value = '';
    if (!h) return;
    const v = Number(t.value);
    if (!t.value || !Number.isFinite(v)) { h.textContent = ''; return; }
    if (t.dataset.typed) {
      const l = litresAtDip(state.chart, v);
      h.textContent = Number.isFinite(l) ? `${v} cm = ${fmtL(l, 2)}` : 'Outside the dip chart';
    } else {
      h.textContent = `${fmtL(v, 2)} = ${fmtDip(dipAtLitres(state.chart, v))} dip`;
    }
  }
}

function setReading(s, tankId, r, phase) {
  const d = s.data;
  const row = (d.tanks || []).find((x) => x.tank === tankId);
  if (phase === 'after') {
    if (!row) return;
    row.after = r;
    if (stageOf(s, row) === 'settling') row.stage = 'read';
  } else if (row && stepOf(s) === 'decant') {
    row.before = r;                        // a tank not started yet: its stock just before
    d.before[tankId] = r;
  } else {
    d.before[tankId] = r;
    d.plan = [];                           // room changed: suggest again
  }
}

// Read a screenshot. On the decanting screen each tank takes what it needs:
// its stock before if it hasn't started, its stock after once it's done.
async function shot(s, phase) {
  const onDecant = phase === 'decant';
  const want = onDecant ? s.data.tanks.filter((t) => stageOf(s, t) !== 'decanting').map((t) => t.tank) : relevantTanks(s).map((t) => t.id);
  const res = await readScreenshot({ want });
  if (!res) return;
  const fresh = session();
  if (!fresh) return;
  let used = 0;
  for (const [id, r] of Object.entries(res.readings)) {
    if (!want.includes(id)) continue;
    if (onDecant) {
      const row = fresh.data.tanks.find((t) => t.tank === id);
      const st = row ? stageOf(fresh, row) : null;
      if (st === 'waiting') setReading(fresh, id, r, 'before');
      else if (st === 'settling' || st === 'read') setReading(fresh, id, r, 'after');
      else continue;
    } else {
      setReading(fresh, id, r, phase);
    }
    used += 1;
  }
  await persist(fresh);
  if (!used) toast(onDecant ? 'None of the tanks waiting or done were on that screenshot.' : 'None of this truck\'s tanks were on that screenshot.', 4000);
}

function cycleChamber(s, no) {
  const row = s.data.plan.find((p) => p.no === no);
  if (!row) return;
  const busy = busyTanks(s.id);
  const options = tanks().filter((t) => t.product === row.product && !busy.has(t.id) && s.data.before[t.id]).map((t) => t.id);
  const seq = [...options, null];
  const i = seq.indexOf(row.tank ?? null);
  row.tank = seq[(i + 1) % seq.length];
  persist(s);
}

function replanProduct(s, prod, requests, prefer) {
  const busy = busyTanks(s.id);
  const done = new Set(s.data.done);
  const chambers = s.data.chambers.filter((c) => c.product === prod && c.litres > 0 && !done.has(c.no));
  const ts = tanks().filter((t) => t.product === prod && !busy.has(t.id) && s.data.before[t.id])
    .map((t) => ({ id: t.id, room: roomOf(s.data.before[t.id], t) }));
  const { assign, perTank } = solvePlan({ chambers, tanks: ts, requests, prefer, warnRoomL: state.settings.warnRoomL });
  for (const p of s.data.plan) if (p.product === prod) p.tank = assign[p.no] ?? null;
  const t = ts.find((x) => x.id === prefer);
  if (t && Math.abs((perTank[t.id] || 0) - (requests[t.id] || 0)) > 0.5) {
    toast(`${tankName(t.id)}: ${requests[t.id] > t.room ? `room for only ${fmtL(t.room)} — ` : 'no whole chambers make that — '}closest is ${fmtKL(perTank[t.id] || 0)}`, 5000);
  }
}

// Keep the invoice in step with chambers corrected here, so the list shows them.
function syncInvoiceChambers(s) {
  const inv = state.invoices.find((x) => x.invoice_no === s.invoice_no);
  if (!inv) return;
  const byP = {};
  for (const c of s.data.chambers) if (c.product) (byP[c.product] ||= []).push(c.no);
  const lines = Object.entries(byP).map(([p, nos]) => {
    const old = (inv.lines || []).find((l) => productKeyOf(l) === p);
    const kl = round2(nos.reduce((a, n) => a + s.data.chambers.find((c) => c.no === n).litres, 0) / 1000);
    return { ...(old || { product: PRODUCTS[p]?.name || p, column_key: { MS: 'MS | EBMS', HSD: 'HSD', XG: 'XtraGreen HSD' }[p] }), qty_kl: old?.qty_kl ?? kl, compartments: nos };
  });
  saveInvoice({ ...inv, lines });
}

// The plan becomes this decantation's tanks, none started yet.
async function prepare(s) {
  const d = s.data;
  // another phone may have started on this truck meanwhile
  const taken = usedChambers(state.sessions, s.invoice_no, s.id);
  const clash = d.plan.filter((p) => p.tank && taken.has(p.no));
  if (clash.length) {
    d.done = [...new Set([...d.done, ...taken])];
    d.plan = [];
    await persist(s);
    toast(`Chamber ${compactNos(clash.map((p) => p.no))} is already being decanted (another phone). The plan was redone without it.`, 5000);
    return false;
  }
  const busy = busyTanks(s.id);
  const chk = checkPlan({ plan: d.plan, tanks: tanks(), readings: d.before, busy: new Set(busy.keys()), settings: state.settings });
  if (chk.blocking.length) { toast(chk.blocking[0], 4000); return false; }
  d.tanks = chk.perTank.map((r) => ({
    tank: r.tank, tankNo: r.no, product: r.product, litres: r.litres, chambers: r.chambers,
    before: d.before[r.tank], after: null, pricePerL: d.prices?.[r.product] ?? null,
    stage: 'waiting', startedAt: null, doneAt: null,
  }));
  return true;
}

// ▶ Start decanting: every tank at once.
async function start(s) {
  if (!(await prepare(s))) return;
  if (!(await startTanks(s, s.data.tanks.map((t) => t.tank)))) {
    s.data.step = 'decant';                // e.g. "take a new reading first": wait on the decanting screen
    await persist(s);
  }
}

// Tank by tank: each tank is started on its own, when it's ready.
async function stepwise(s) {
  if (!(await prepare(s))) return;
  s.data.step = 'decant';
  await persist(s);
}

// Start decanting into these tanks. A tank sells until its decanting starts,
// so its stock before has to be from just now.
async function startTanks(s, ids) {
  const d = s.data;
  const rows = d.tanks.filter((t) => ids.includes(t.tank) && stageOf(s, t) === 'waiting');
  if (!rows.length) return false;
  for (const t of rows) {                  // the latest stock, if one came in since (e.g. another phone)
    const latest = state.tankState[t.tank];
    if (latest && (!t.before || Date.parse(latest.readingAt || 0) > Date.parse(t.before.readingAt || 0))) t.before = { ...latest };
  }
  const missing = rows.filter((t) => !t.before);
  if (missing.length) { toast(`Add the stock of ${missing.map((t) => tankName(t.tank)).join(' & ')} first.`, 4000); return false; }
  const first = d.tanks.map((t) => t.startedAt).filter(Boolean).sort()[0];
  const old = rows.filter((t) => isStale(t.before) || (first && Date.parse(t.before.readingAt || 0) < Date.parse(first)));
  if (old.length && !(await ask('Take the stock first?', `${old.map((t) => `${tankName(t.tank)}: read at ${fmtTime(t.before.readingAt)} (${ago(t.before.readingAt)})`).join('<br>')}
      <br><br>A tank keeps selling until its decanting starts, so its stock before should be from just now. Start anyway?`,
  { ok: 'Start anyway', cancel: 'Take a new reading' }))) return false;
  const over = rows.find((t) => t.litres > roomOf(t.before, tankById(t.tank)));
  if (over) { toast(`${tankName(over.tank)} has room for only ${fmtL(roomOf(over.before, tankById(over.tank)))} now — change the plan.`, 5000); return false; }
  const now = new Date().toISOString();
  for (const t of rows) {
    t.stage = 'decanting';
    t.startedAt = now;
    d.before[t.tank] = t.before;
  }
  syncStatus(s);
  await persist(s);
  toast(rows.length > 1 ? 'Decanting started.' : `${tankName(rows[0].tank)}: decanting started.`);
  return true;
}

// These tanks are done: which of their chambers were emptied? An unticked
// chamber stays in the truck (decant it later from the list).
async function doneTanks(s, ids) {
  const d = s.data;
  const rows = d.tanks.filter((t) => ids.includes(t.tank) && stageOf(s, t) === 'decanting');
  if (!rows.length) return;
  const all = rows.flatMap((t) => t.chambers.map((no) => ({ no, tank: t.tank })));
  const chosen = await new Promise((resolve) => {
    let out = null;
    openSheet(rows.length === 1 ? `${tankName(rows[0].tank)}: which chambers were emptied?` : 'Which chambers were emptied?', (body) => {
      body.innerHTML = `<div class="checklist">${all.map((x) => `<label class="on"><input type="checkbox" value="${x.no}" checked>
        <span>Chamber ${x.no} → ${tankName(x.tank)}</span></label>`).join('')}</div>
        <div class="hint" style="margin-top:8px">Untick a chamber that wasn't decanted — it stays with the truck and can be decanted later.</div>
        <div class="row-actions"><button class="btn" data-no>Back</button><button class="cta" data-yes>Decanting done</button></div>`;
      body.onchange = (e) => e.target.closest('label')?.classList.toggle('on', e.target.checked);
      body.querySelector('[data-no]').onclick = () => closeSheet();
      body.querySelector('[data-yes]').onclick = () => { out = [...body.querySelectorAll('input:checked')].map((i) => Number(i.value)); closeSheet(); };
      return () => resolve(out);
    });
  });
  if (!chosen) return;
  if (!chosen.length) { toast('No chamber ticked — use Cancel if nothing was decanted.', 4000); return; }
  const keep = new Set(chosen);
  const mine = new Set(all.map((x) => x.no));
  for (const p of d.plan) if (p.tank && mine.has(p.no) && !keep.has(p.no)) p.tank = null;
  const now = new Date().toISOString();
  d.tanks = d.tanks.map((t) => {
    if (!rows.includes(t)) return t;
    const chambers = t.chambers.filter((no) => keep.has(no));
    const litres = chambers.reduce((a, no) => a + (d.chambers.find((c) => c.no === no)?.litres || 0), 0);
    return { ...t, chambers, litres, stage: 'settling', doneAt: now };
  }).filter((t) => t.chambers.length);
  syncStatus(s);
  await persist(s);
}

// A tank not started is left out: its chambers stay in the truck.
async function dropTank(s, id) {
  const d = s.data;
  const row = d.tanks.find((t) => t.tank === id);
  if (!row || stageOf(s, row) !== 'waiting') return;
  if (!(await ask(`Not now for ${tankName(id)}?`, `C${compactNos(row.chambers)} (${fmtKL(row.litres)}) stay in the truck — start them into a tank from this screen whenever you like.`, { ok: 'Keep in the truck' }))) return;
  for (const p of d.plan) if (p.tank === id) p.tank = null;
  if (moving.id !== s.id) moving = { id: s.id, pick: {} };
  for (const no of row.chambers) moving.pick[no] = '';      // kept back on purpose: not suggested again
  d.tanks = d.tanks.filter((t) => t.tank !== id);
  if (!d.tanks.length) d.step = 'plan';
  syncStatus(s);
  await persist(s);
}

// Put chambers into the tanks they really went into (or back in the truck).
//   assign: {chamberNo: tankId | null}; only chambers of `product` (or all).
async function applyRouting(s, assign, product = null) {
  const d = s.data;
  const rows = new Map(d.tanks.map((t) => [t.tank, t]));
  for (const p of d.plan) {
    if (product && p.product !== product) continue;
    if (Object.prototype.hasOwnProperty.call(assign, p.no)) p.tank = assign[p.no] || null;
  }
  const tanksNow = [];
  const byTank = {};
  for (const p of d.plan) if (p.tank) (byTank[p.tank] ||= []).push(p);
  for (const [tank, ps] of Object.entries(byTank)) {
    const old = rows.get(tank);
    const tk = tankById(tank);
    tanksNow.push({
      ...(old || { tank, tankNo: tk?.no, product: ps[0].product, before: d.before[tank], after: null, pricePerL: d.prices?.[ps[0].product] ?? null,
        stage: 'settling', startedAt: d.startedAt || null, doneAt: d.decantedAt || null }),
      chambers: ps.map((x) => x.no).sort((a, b) => a - b),
      litres: ps.reduce((a, x) => a + x.litres, 0),
      result: null,
    });
  }
  d.tanks = tanksNow.sort((a, b) => (a.tankNo || 0) - (b.tankNo || 0));
  if (s.status === 'done') {
    if (d.tanks.every((t) => t.after)) {
      for (const t of d.tanks) t.result = tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings);
    } else {
      s.status = 'settling';                                  // a new tank needs its after-stock
      s.completed_at = null;
    }
  } else {
    syncStatus(s);
  }
  await persist(s);
  toast('Chambers updated.');
}

function routeEditor(s) {
  const d = s.data;
  const rows = d.plan.filter((p) => d.tanks.some((t) => t.product === p.product));
  const choice = Object.fromEntries(rows.map((p) => [p.no, p.tank || '']));
  openSheet('Which chamber went where?', (body) => {
    const draw = () => {
      body.innerHTML = `<div class="hint">Tap where each chamber really went. "Stayed" puts it back on the list as not decanted.</div>
        ${rows.map((p) => {
          const opts = tanks().filter((t) => t.product === p.product && d.before[t.id]);
          return `<div class="plan-tank" style="grid-template-columns:92px minmax(0,1fr)"><div class="pt-name">C${p.no} <span class="hint">${fmtKL(p.litres)}</span></div>
            <div class="seg">${opts.map((t) => `<button type="button" class="${choice[p.no] === t.id ? 'on' : ''}" data-rc="${p.no}" data-rt="${t.id}">Tank ${t.no}</button>`).join('')}
            <button type="button" class="${!choice[p.no] ? 'on' : ''}" data-rc="${p.no}" data-rt="">Stayed</button></div></div>`;
        }).join('')}
        <div class="row-actions"><button class="btn" data-x>Cancel</button><button class="cta" data-ok>Save</button></div>`;
    };
    draw();
    body.onclick = async (e) => {
      const b = e.target.closest('[data-rc]');
      if (b) { choice[b.dataset.rc] = b.dataset.rt; draw(); return; }
      if (e.target.closest('[data-x]')) { closeSheet(); return; }
      if (e.target.closest('[data-ok]')) {
        if (!Object.values(choice).some(Boolean)) { toast('At least one chamber must have gone into a tank.'); return; }
        closeSheet();
        await applyRouting(s, Object.fromEntries(Object.entries(choice).map(([no, t]) => [no, t || null])));
      }
    };
  });
}

async function finish(s) {
  const d = s.data;
  if (!d.tanks.length || !d.tanks.every((t) => t.after && ['settling', 'read'].includes(stageOf(s, t)))) {
    toast('Every tank needs to be done, with its stock after.');
    return;
  }
  const problems = d.tanks.flatMap((t) => afterWarnings(s, t).map((w) => `${tankName(t.tank)}: ${w}`));
  if (problems.length && !(await ask('Check the after-stock', `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>Save the result anyway?`, { ok: 'Save anyway', cancel: 'Fix it' }))) return;
  for (const t of d.tanks) {
    t.result = tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings);
    saveTankReading(t.tank, t.after);
  }
  syncStatus(s);
  for (const t of d.tanks) t.stage = 'read';
  d.completedAt = new Date().toISOString();
  s.completed_at = d.completedAt;
  s.status = 'done';
  await persist(s);
}

async function cancelSession(s) {
  const moved = s.status === 'decanting' && s.data.tanks.some((t) => startOf(s, t));
  const yes = await ask('Cancel this decantation?', moved
    ? 'Only if <b>nothing was decanted</b> (e.g. the truck was sent back). The chambers go back to the list.'
    : 'Nothing is decanted yet; the invoice goes back to the list.', { ok: 'Cancel it', cancel: 'Keep going', danger: true });
  if (!yes) return;
  s.status = 'cancelled';
  s.completed_at = new Date().toISOString();
  s.data.cancelReason = moved ? 'Stopped — nothing decanted.' : 'Cancelled before decanting.';
  for (const p of s.data.plan) p.tank = null;
  await persist(s);
  closeWizard();
}

// "By … · HSD density 831.2 (+0.2)" under the result.
// For the internal audit: where a stock came from (" · screenshot"), and one
// line for a decantation — every stock from a screenshot or a dip, or which
// were typed in (no solid proof).
function fromOf(r) {
  const p = stockProof(r);
  return p ? ` · <span class="${p.proof ? 'pf-ok' : 'pf-no'}">${esc(p.short)}</span>` : '';
}

function auditLine(tanks) {
  const rows = (tanks || []).filter((t) => t.before && t.after);
  if (!rows.some((t) => stockProof(t.before) || stockProof(t.after))) return null;
  const none = unprovenReadings(rows);
  if (!none.length) return { ok: true, text: '✓ Audit: every stock here is from a screenshot or a dip — proof held.' };
  return { ok: false, text: `⚠ Audit: ${none.map((x) => `${tankName(x.tank)} stock ${x.which}`).join(', ')} typed in litres — no solid proof.` };
}

function resultFooter(s) {
  const d = s.data;
  const dens = Object.entries(d.checks?.density || {}).map(([p, v]) => {
    const c = densityCheck({ reading: v.reading, tempC: v.temp, invoice15: d.densities?.[p], limitKg: state.settings.densityLimit });
    return c ? `${p} density ${c.d15} (${fmtSigned(c.diff, '', 1)} vs invoice)` : '';
  }).filter(Boolean);
  return [d.operator ? `By ${d.operator}` : '', ...dens].filter(Boolean).join(' · ');
}

// The Result screen's figures, formatted, for the picture.
function resultModel(s) {
  const d = s.data;
  const inv = d.invoice || {};
  const res = d.tanks.map((t) => ({ t, r: t.result || tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings) }));
  const totL = d.tanks.reduce((a, t) => a + t.litres, 0);
  const totV = round2(res.reduce((a, x) => a + (x.r?.variation || 0), 0));
  const money = res.reduce((a, x) => a + (x.r && d.prices?.[x.t.product] ? x.r.variation * d.prices[x.t.product] : 0), 0);
  const dir = totV < 0 ? 'short' : totV > 0 ? 'excess' : 'exact';
  const day = d.decantedAt || d.startedAt || s.created_at;
  return {
    title: s.tt_no || '',
    sub: `Invoice ${s.invoice_no || '—'}${inv.invoice_date ? ` · ${inv.invoice_date} ${inv.invoice_time || ''}` : ''}`,
    total: fmtKL(totL),
    when: `${fmtDate(day, true)} · ${fmtTime(d.startedAt)}–${fmtTime(d.decantedAt)}`,
    variation: fmtSigned(totV, ' L', 2),
    direction: dir,
    summary: `${dir === 'exact' ? 'exact' : `${dir} overall`} · ${fmtPct(totL ? (totV / totL) * 100 : 0)}${money ? ` · ≈ ${fmtMoney(money)} at invoice price` : ''}`,
    tanks: res.map(({ t, r }) => ({
      name: tankName(t.tank),
      product: productShort(t.product),
      color: PRODUCT_COLOR[t.product] || '#898781',
      band: r ? bandView(r.band, r.direction).cls : null,
      bandLabel: r ? `${bandView(r.band, r.direction).icon} ${bandView(r.band, r.direction).label}` : '',
      direction: r?.direction || 'exact',
      variation: r ? fmtSigned(r.variation, ' L', 2) : '—',
      pctLine: r ? `${fmtPct(r.pct)} · OK within ±${fmtL(r.tol)}` : '',
      meta: `C${compactNos(t.chambers)} · ${fmtKL(t.litres)} · decanted ${fmtTime(startOf(s, t))}–${fmtTime(doneOf(s, t))}`,
      rows: [
        [`Stock before · ${fmtTime(t.before?.readingAt)}${stockProof(t.before) ? ` · ${stockProof(t.before).short}` : ''}`, fmtL(t.before?.volume, 2), fmtDip(dipOf(t.before))],
        [`Stock after · ${fmtTime(t.after?.readingAt)}${stockProof(t.after) ? ` · ${stockProof(t.after).short}` : ''}`, fmtL(t.after?.volume, 2), fmtDip(dipOf(t.after))],
        ['Tank gained', r ? fmtL(r.gain, 2) : '—', ''],
        [`Chambers ${compactNos(t.chambers)} (invoice)`, fmtL(t.litres), ''],
        ...(t.salesL ? [['Sold while decanting', fmtL(t.salesL), '']] : []),
        ['Variation', r ? fmtSigned(r.variation, ' L', 2) : '—', r && d.prices?.[t.product] ? fmtMoney(r.variation * d.prices[t.product]) : '', true, r?.direction],
      ],
    })),
    notes: d.notes || '',
    footer: resultFooter(s),
    audit: auditLine(d.tanks),
    made: `Vriddhi Fuels decanting app · ${fmtDate(Date.now(), true)} ${fmtTime(Date.now())}`,
  };
}

// Share the result as a picture: shown first, then shared (or saved).
function share(s) {
  const name = `Decanting ${s.tt_no || ''} ${(s.data.decantedAt || s.created_at || '').slice(0, 10)}.png`.replace(/\s+/g, ' ');
  let url = null;
  openSheet('Share the result', (body) => {
    body.innerHTML = '<div class="hint">Making the picture…</div>';
    (async () => {
      try {
        const { resultImage } = await import('./shareimg.js');
        const canvas = await resultImage(resultModel(s));
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const file = new File([blob], name, { type: 'image/png' });
        url = URL.createObjectURL(blob);
        const canShare = Boolean(navigator.canShare?.({ files: [file] }));
        body.innerHTML = `<img class="full" src="${url}" alt="The decanting result as a picture" style="background:#0f0c0b">
          <div class="row-actions"><button class="btn" data-save>⬇ Save picture</button>
            ${canShare ? '<button class="cta" data-send>📤 Share picture</button>' : ''}</div>
          ${canShare ? '' : '<div class="hint">This browser can\'t share pictures directly — save it, then send it from the gallery.</div>'}`;
        body.querySelector('[data-save]').onclick = () => download(blob, name);
        body.querySelector('[data-send]')?.addEventListener('click', () => {
          navigator.share({ files: [file], title: `Decanting ${s.tt_no}` }).catch(() => {});
        });
      } catch (e) {
        body.innerHTML = `<div class="banner bad">Couldn't make the picture: ${esc(e.message || e)}</div>`;
      }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, { wide: true });
}
