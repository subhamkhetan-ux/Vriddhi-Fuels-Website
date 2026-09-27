// The decantation itself, step by step:
//   1 Truck   — chambers and products (from the invoice), seals, density check
//   2 Before  — stock of the tanks that can take the product (screenshot / litres / dip)
//   3 Plan    — KL per tank; the app picks the chambers (tap one to change it)
//   4 Decant  — ▶ Start, then ✓ Decanting done
//   5 After   — stock after (screenshot / litres / dip)
//   6 Result  — variation per tank, kept in the log for a month

import {
  PRODUCTS, checkPlan, densityCheck, dipAtLitres, litresAtDip, round2, routingHint, solvePlan, suggestPlan, tankResult,
  usedChambers,
} from './core.js';
import { deleteSession, getPhoto, linkPhoto, newId, saveInvoice, saveSession, saveTankReading, state } from './store.js';
import {
  ask, bandBadge, closeSheet, confBadge, elapsed, esc, fmtDip, fmtKL, fmtL, fmtMoney, fmtPct, fmtSigned, fmtTime,
  fmtWhen, openSheet, productChip, productShort, tankGauge, toast, truckStrip,
} from './ui.js';
import {
  busyTanks, compactNos, invoiceForm, isStale, layoutFor, readScreenshot, render, tankById, tankName, tanks, typedReading,
} from './app.js';

let currentId = null;
let typing = null;         // {tank, phase} while the "type the stock" row is open
let timer = null;
let bound = null;

const STEPS = [['truck', 'Truck'], ['before', 'Before'], ['plan', 'Plan'], ['decant', 'Decant'], ['after', 'After'], ['result', 'Result']];

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
  if (s.status === 'decanting') return 'decant';
  if (s.status === 'settling') return 'after';
  if (s.status === 'done' || s.status === 'cancelled') return 'result';
  return s.data.step || 'truck';
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
      checks: { sealsOk: false, density: {} },
      before: {},
      plan: [],
      tanks: [],
      photos: [],
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
      ${['draft', 'decanting'].includes(s.status) ? '<button class="btn sm ghost danger" data-wz="cancel">Cancel</button>' : ''}
    </div>
    <div class="steps">${STEPS.map(([k, label], i) => `<div class="step${i === idx ? ' on' : i < idx ? ' done' : ''}"${i === idx ? ' aria-current="step"' : ''}>${label}</div>`).join('')}</div>
    <div id="wzBody">${{ truck: stepTruck, before: stepBefore, plan: stepPlan, decant: stepDecant, after: stepAfter, result: stepResult }[step](s)}</div>`;
  clearInterval(timer);
  if (step === 'decant' || step === 'after') timer = setInterval(tick, 1000);
  tick();
  if (step === 'result') loadThumbs(s, el);
}

function tick() {
  const s = session();
  if (!s) return;
  const t = document.getElementById('wzTimer');
  if (t && s.data.startedAt) t.textContent = elapsed(Date.now() - Date.parse(s.data.startedAt));
  const w = document.getElementById('wzSettle');
  if (w && s.data.decantedAt) {
    const left = Date.parse(s.data.decantedAt) + state.settings.settleMinutes * 60000 - Date.now();
    w.textContent = left > 0 ? `Let the level settle — take the after screenshot in ${elapsed(left)}.` : 'The level should have settled — take the after screenshot now.';
  }
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
      return `<div class="card warn"><div class="sect-title">No chamber details</div>
        <div class="hint">The invoice has no chamber table and this truck hasn't been seen before. Enter its chambers (KL each) and what's in them.</div>
        <div class="row-actions" style="justify-content:flex-start"><button class="cta sm" data-wz="editInvoice">✎ Enter the chambers</button></div></div>`;
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
  return `
    <div class="card">
      <div class="sect-title">Chambers</div>
      ${truckStrip(d.chambers, { done })}
      <div class="hint" style="margin:6px 0 10px">${how.has('invoice') ? 'Products per chamber are from the invoice ("Comp No(s)").' : how.has('ms-rule') ? 'The invoice doesn\'t list chambers: MS is taken from chamber 1 upward, the rest after it.' : 'One product in every chamber.'}
        Tap a product to change it.${done.size ? ` Chambers ${compactNos([...done])} were decanted before.` : ''}</div>
      ${d.chambers.map((c) => `<div class="plan-tank" style="grid-template-columns:86px minmax(0,1fr)">
        <div class="pt-name">C${c.no} <span class="hint">${fmtKL(c.litres)}</span></div>
        ${done.has(c.no) ? '<div class="hint">decanted</div>' : `<div class="seg">${['MS', 'HSD', 'XG', ''].map((p) => `<button type="button" class="${(c.product || '') === p ? 'on' : ''}" data-setp="${c.no}" data-p="${p}">${p ? productShort(p) : 'Empty'}</button>`).join('')}</div>`}
      </div>`).join('')}
      ${[...mismatch, ...noTank.map((p) => `No tank here holds ${p}; those chambers can't be decanted.`)].map((m) => `<div class="banner" style="margin:10px 0 0">${esc(m)}</div>`).join('')}
    </div>
    <div class="card">
      <div class="sect-title">Before you open the valves</div>
      <div class="checklist">
        <label class="${d.checks.sealsOk ? 'on' : ''}"><input type="checkbox" data-check="seals" ${d.checks.sealsOk ? 'checked' : ''}>
          <span>Seals / locks intact${d.invoice.seals ? ` — <b>${esc(d.invoice.seals)}</b>` : ''}</span></label>
      </div>
      <div class="sect-title" style="margin-top:14px">Density check</div>
      <div class="hint" style="margin:-4px 0 6px">Optional — the hydrometer reading and temperature of the truck's sample; the app works out the density at 15 °C and compares it with the invoice.</div>
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
  const open = typing && typing.tank === t.id && typing.phase === phase;
  const stale = phase === 'before' && r && isStale(r);
  return `<div class="card" data-rtank="${t.id}">
    <div class="rd-head"><span class="nm">Tank ${t.no}</span>${productChip(t.product)}
      ${r ? confBadge(r.confidence, r.checks) : ''}
      ${stale ? '<span class="badge watch"><i>!</i>Old reading</span>' : ''}
      ${busyWith ? `<span class="badge high"><i>●</i>Being decanted from ${esc(busyWith.tt_no)}</span>` : ''}</div>
    ${r ? `<div class="kv">
        <div><div class="k">Stock</div><div class="v big">${fmtL(r.volume, 2)}</div></div>
        <div><div class="k">Dip</div><div class="v big">${fmtDip(r.dip)}</div></div>
        <div><div class="k">Room</div><div class="v">${fmtL(r.ullage, 2)}</div></div>
        <div><div class="k">Water</div><div class="v">${r.water != null ? fmtL(r.water, 2) : '—'}</div></div>
        <div><div class="k">Temp</div><div class="v">${r.temp ?? '—'}${r.temp != null ? ' °C' : ''}</div></div>
        <div><div class="k">Density (tc)</div><div class="v">${r.densityTc ?? '—'}</div></div>
      </div>
      <div class="rd-src">${{ photo: 'Screenshot', 'photo-edited': 'Screenshot, corrected', litres: 'Typed in', dip: 'From the dip' }[r.source] || ''} · ${r.timeRead === false ? `taken ${fmtWhen(r.readingAt)} (time not on the picture)` : `automation time ${fmtWhen(r.readingAt)}`}</div>`
    : '<div class="hint" style="margin-top:6px">No reading yet.</div>'}
    <div class="rd-actions">
      <button class="btn sm" data-shot="${phase}">📷 Screenshot</button>
      <button class="btn sm" data-type="${t.id}" data-phase="${phase}">✎ Type litres / dip</button>
    </div>
    ${open ? `<div class="manual">
        <label class="f">Litres<input type="number" inputmode="decimal" step="0.01" data-typel="${t.id}"></label>
        <label class="f">or dip (cm)<input type="number" inputmode="decimal" step="0.1" data-typed="${t.id}"></label>
        <button class="btn" data-typesave="${t.id}" data-phase="${phase}">Use</button>
      </div><div class="hint" data-typehint="${t.id}" style="margin-top:4px"></div>` : ''}
  </div>`;
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
      ${held.length ? `<div class="hint" style="margin-top:8px">Stays in the truck for now: <b>C${compactNos(held.map((h) => h.no))}</b> (${fmtKL(held.reduce((a, h) => a + h.litres, 0))}) — decant it later from the list.</div>` : ''}
    </div>`;
  }).join('');
  return `${sections}
    ${chk.blocking.length || chk.warnings.length ? `<ul class="msgs">${chk.blocking.map((m) => `<li class="block">⛔ ${esc(m)}</li>`).join('')}${chk.warnings.map((m) => `<li class="warn">⚠ ${esc(m)}</li>`).join('')}</ul>` : ''}
    <div style="height:12px"></div>
    <button class="cta block" data-wz="start" ${chk.blocking.length ? 'disabled' : ''}>▶ Start decanting${total ? ` · ${fmtKL(total)}` : ''}</button>
    <div class="row-actions" style="justify-content:flex-start"><button class="btn sm ghost" data-wz="toBefore">◀ Stock before</button><button class="btn sm ghost" data-wz="replan">↺ Suggest again</button></div>`;
}

function planTankRow(s, t, rows, chk, busy) {
  const r = s.data.before[t.id];
  const mine = rows.filter((x) => x.tank === t.id);
  const litres = mine.reduce((a, x) => a + x.litres, 0);
  const info = chk.perTank.find((x) => x.tank === t.id);
  const room = r ? (Number.isFinite(r.ullage) ? r.ullage : t.capacity - r.volume) : null;
  const lvl = info?.level || '';
  const disabled = busy.has(t.id) || !r;
  return `<div class="plan-tank lvl-${lvl}">
    <div>
      <div class="pt-name">Tank ${t.no} ${mine.length ? `<span class="hint">← C${compactNos(mine.map((x) => x.no))}</span>` : ''}</div>
      <div class="pt-sub">${busy.has(t.id) ? 'Being decanted from another truck' : !r ? 'No stock reading — add it in step 2' : `Room <b>${fmtL(room)}</b> · now <b>${fmtL(r.volume)}</b> (${fmtDip(r.dip)})`}
        ${info?.after ? `<br>After: <b>${fmtL(info.after)}</b> (${fmtDip(info.afterDip)}) · room left <b>${fmtL(info.leftRoom)}</b>` : ''}</div>
      ${r ? tankGauge({ product: t.product, volume: r.volume, capacity: t.capacity, incoming: litres, label: `Tank ${t.no} plan` }) : ''}
    </div>
    <div class="pt-in"><input type="number" inputmode="decimal" step="0.5" min="0" data-req="${t.id}" data-prod="${t.product}" value="${litres ? litres / 1000 : ''}" placeholder="0" ${disabled ? 'disabled' : ''} aria-label="KL into Tank ${t.no}"><span>KL</span></div>
  </div>`;
}

// ---- 4. Decanting ------------------------------------------------------------

function stepDecant(s) {
  const d = s.data;
  const emptied = new Set(d.emptied || []);
  return `<div class="card accent">
      <div class="hint" style="text-align:center">Decanting since ${fmtTime(d.startedAt)}</div>
      <div class="bigtimer" id="wzTimer">0:00</div>
      ${d.tanks.map((t) => `<div class="hint" style="text-align:center">${productChip(t.product)} C${compactNos(t.chambers)} → <b>${tankName(t.tank)}</b> · ${fmtKL(t.litres)}</div>`).join('')}
      <div class="checklist">${d.tanks.flatMap((t) => t.chambers.map((no) => `<label class="${emptied.has(no) ? 'on' : ''}"><input type="checkbox" data-emptied="${no}" ${emptied.has(no) ? 'checked' : ''}>
        <span>Chamber ${no} emptied into ${tankName(t.tank)}</span></label>`)).join('')}</div>
      <div class="hint" style="margin-top:10px">Stop sales from ${d.tanks.map((t) => tankName(t.tank)).join(' & ')} while decanting if you can — otherwise note the litres sold in the next step.</div>
    </div>
    <button class="cta block" data-wz="decanted">✓ Decanting done</button>`;
}

// ---- 5. Stock after ---------------------------------------------------------

function afterWarnings(s, t) {
  const out = [];
  const a = t.after;
  const b = t.before;
  if (!a || !b) return out;
  if (a.timeRead !== false && a.readingAt && s.data.decantedAt && Date.parse(a.readingAt) < Date.parse(s.data.decantedAt) - 60000) {
    out.push(`This reading is from ${fmtTime(a.readingAt)}, before decanting finished (${fmtTime(s.data.decantedAt)}) — take a new screenshot.`);
  }
  if (a.volume === b.volume && a.readingAt === b.readingAt) out.push('This is the same reading as before decanting.');
  else if (a.volume <= b.volume) out.push('The stock didn\'t go up — wrong tank or an old screenshot?');
  if (a.water > 0 && !(b.water > 0)) out.push(`Water shows now: ${fmtL(a.water, 2)}.`);
  return out;
}

function stepAfter(s) {
  const d = s.data;
  return `<div class="card accent">
      <div class="sect-title">Stock after decanting</div>
      <div class="hint">Decanting finished at <b>${fmtTime(d.decantedAt)}</b>. <span id="wzSettle"></span></div>
      <div class="rd-actions"><button class="cta sm" data-wz="shotAfter">📷 Read the after screenshot</button></div>
    </div>
    ${d.tanks.map((t) => {
      const tk = tankById(t.tank);
      const warn = afterWarnings(s, t);
      const res = t.after ? tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings) : null;
      const expect = round2(t.before.volume + t.litres - (Number(t.salesL) || 0));
      return `${readingCard(s, tk, t.after, 'after')}
        <div class="card" style="margin-top:-8px">
          <table class="cmp"><tbody>
            <tr><td>Before (${fmtTime(t.before.readingAt)})</td><td>${fmtL(t.before.volume, 2)}</td><td>${fmtDip(t.before.dip)}</td></tr>
            <tr><td>+ Chambers ${compactNos(t.chambers)}</td><td>${fmtL(t.litres)}</td><td></td></tr>
            <tr><td>− Sold while decanting</td><td><input type="number" inputmode="decimal" step="1" min="0" data-sales="${t.tank}" value="${t.salesL || ''}" placeholder="0" aria-label="Litres sold from ${tankName(t.tank)} while decanting"></td><td></td></tr>
            <tr class="tot"><td>Should read</td><td>${fmtL(expect, 2)}</td><td>${fmtDip(dipAtLitres(state.chart, expect))}</td></tr>
            ${res ? `<tr class="tot"><td>Variation</td><td>${fmtSigned(res.variation, ' L', 2)}</td><td>${bandBadge(res.band, res.direction)}</td></tr>` : ''}
          </tbody></table>
          ${warn.length ? `<ul class="msgs">${warn.map((w) => `<li class="warn">⚠ ${esc(w)}</li>`).join('')}</ul>` : ''}
        </div>`;
    }).join('')}
    ${routingCards(s)}
    <div class="row-actions" style="justify-content:flex-start;margin-top:0"><button class="btn sm ghost" data-wz="route">✎ Which chamber went where?</button></div>
    <button class="cta block" data-wz="finish" ${d.tanks.every((t) => t.after) ? '' : 'disabled'}>Finish & save the result</button>`;
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
    const then = rows.map((r) => `C${compactNos(Object.keys(h.assign).filter((no) => h.assign[no] === r.tank).map(Number))} → ${tankName(r.tank)}`).join(' and ');
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
    </div>
    ${res.map(({ t, r }) => `<div class="card">
      <div class="rd-head"><span class="nm">${tankName(t.tank)}</span>${productChip(t.product)}${r ? bandBadge(r.band, r.direction) : ''}</div>
      ${r ? `<div class="result" style="margin-top:6px"><div class="var ${r.direction}">${fmtSigned(r.variation, ' L', 2)}</div><div class="hint" style="text-align:right">${fmtPct(r.pct)}<br>OK within ±${fmtL(r.tol)}</div></div>` : ''}
      <table class="cmp"><thead><tr><th></th><th>Litres</th><th>Dip</th></tr></thead><tbody>
        <tr><td>Stock before · ${fmtTime(t.before.readingAt)}</td><td>${fmtL(t.before.volume, 2)}</td><td>${fmtDip(t.before.dip)}</td></tr>
        <tr><td>Stock after · ${fmtTime(t.after?.readingAt)}</td><td>${fmtL(t.after?.volume, 2)}</td><td>${fmtDip(t.after?.dip)}</td></tr>
        <tr><td>Tank gained</td><td>${r ? fmtL(r.gain, 2) : '—'}</td><td></td></tr>
        <tr><td>Chambers ${compactNos(t.chambers)} (invoice)</td><td>${fmtL(t.litres)}</td><td></td></tr>
        ${t.salesL ? `<tr><td>Sold while decanting</td><td>${fmtL(t.salesL)}</td><td></td></tr>` : ''}
        <tr class="tot"><td>Variation</td><td>${r ? fmtSigned(r.variation, ' L', 2) : '—'}</td><td>${r && d.prices?.[t.product] ? fmtMoney(r.variation * d.prices[t.product]) : ''}</td></tr>
      </tbody></table>
    </div>`).join('')}
    ${routingCards(s)}
    <div class="card">
      <label class="f">Notes<textarea rows="2" data-notes placeholder="e.g. chamber 3 foamed, re-dipped after 15 min">${esc(d.notes || '')}</textarea></label>
      <div class="photo-thumbs" id="wzThumbs"></div>
      <div class="hint" style="margin-top:8px">${d.operator ? `By ${esc(d.operator)} · ` : ''}Seals ${d.checks?.sealsOk ? 'checked ✓' : 'not ticked'}${Object.entries(d.checks?.density || {}).map(([p, v]) => { const c = densityCheck({ reading: v.reading, tempC: v.temp, invoice15: d.densities?.[p], limitKg: state.settings.densityLimit }); return c ? ` · ${p} density ${c.d15} (${fmtSigned(c.diff, '', 1)})` : ''; }).join('')}</div>
    </div>
    <div class="row-actions">
      <button class="btn danger" data-wz="delete">Delete</button>
      <button class="btn" data-wz="share">Share</button>
      <button class="btn" data-wz="reopen">✎ Change the after-stock</button>
      <button class="cta" data-wz="close">Done</button>
    </div>`;
}

async function loadThumbs(s, el) {
  const box = el.querySelector('#wzThumbs');
  if (!box) return;
  for (const p of s.data.photos || []) {
    const url = await getPhoto(p.id).catch(() => null);
    if (!url || !el.contains(box)) continue;
    const img = document.createElement('img');
    img.src = url;
    img.alt = `${p.kind} screenshot`;
    img.title = `${p.kind === 'before' ? 'Before' : 'After'} · ${fmtWhen(p.at)}`;
    img.onclick = () => openSheet(img.title, (b) => { b.innerHTML = `<img class="full" src="${url}" alt="">`; }, { wide: true });
    box.append(img);
  }
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
  if (act === 'toBefore') {
    if (d.checks && !d.checks.sealsOk && d.invoice.seals && s.data.step === 'truck'
      && !(await ask('Seals not ticked', 'Carry on without ticking that the seals are intact?', { ok: 'Carry on' }))) return;
    d.step = 'before';
    await persist(s);
    return;
  }
  if (act === 'toPlan') { d.step = 'plan'; await persist(s); return; }
  if (act === 'replan') { d.plan = []; await persist(s); return; }
  if (act === 'shotBefore' || t.closest('[data-shot="before"]')) { await shot(s, 'before'); return; }
  if (act === 'shotAfter' || t.closest('[data-shot="after"]')) { await shot(s, 'after'); return; }
  if (act === 'start') { await start(s); return; }
  if (act === 'decanted') { await decanted(s); return; }
  if (act === 'finish') { await finish(s); return; }
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
  if (t.matches('[data-check="seals"]')) { d.checks.sealsOk = t.checked; t.closest('label').classList.toggle('on', t.checked); persist(s); return; }
  if (t.matches('[data-emptied]')) {
    const no = Number(t.dataset.emptied);
    const set = new Set(d.emptied || []);
    if (t.checked) set.add(no); else set.delete(no);
    d.emptied = [...set];
    t.closest('label').classList.toggle('on', t.checked);
    persist(s);
    return;
  }
  if (t.matches('[data-req]')) {
    const prod = t.dataset.prod;
    const req = {};
    document.querySelectorAll(`[data-req][data-prod="${prod}"]`).forEach((inp) => { req[inp.dataset.req] = Math.round(Number(inp.value || 0) * 1000); });
    replanProduct(s, prod, req, t.dataset.req);
    t.blur();
    persist(s);
    return;
  }
  if (t.matches('[data-sales]')) {
    const row = d.tanks.find((x) => x.tank === t.dataset.sales);
    row.salesL = Math.max(0, Number(t.value) || 0);
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
  if (phase === 'after') {
    const row = s.data.tanks.find((x) => x.tank === tankId);
    if (row) row.after = r;
  } else {
    s.data.before[tankId] = r;
    s.data.plan = [];                      // room changed: suggest again
  }
}

async function shot(s, phase) {
  const want = phase === 'after' ? s.data.tanks.map((t) => t.tank) : relevantTanks(s).map((t) => t.id);
  const res = await readScreenshot({ kind: phase, sessionId: s.id, want });
  if (!res) return;
  const fresh = session();
  if (!fresh) return;
  let used = 0;
  for (const [id, r] of Object.entries(res.readings)) {
    if (!want.includes(id)) continue;
    setReading(fresh, id, r, phase);
    used += 1;
  }
  fresh.data.photos = [...(fresh.data.photos || []), { id: res.photoId, kind: phase, at: new Date().toISOString() }];
  linkPhoto(res.photoId, fresh.id);
  await persist(fresh);
  if (!used) toast('None of this truck\'s tanks were on that screenshot.', 4000);
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
    .map((t) => ({ id: t.id, room: Number.isFinite(s.data.before[t.id].ullage) ? s.data.before[t.id].ullage : t.capacity - s.data.before[t.id].volume }));
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

async function start(s) {
  const d = s.data;
  // another phone may have started on this truck meanwhile
  const taken = usedChambers(state.sessions, s.invoice_no, s.id);
  const clash = d.plan.filter((p) => p.tank && taken.has(p.no));
  if (clash.length) {
    d.done = [...new Set([...d.done, ...taken])];
    d.plan = [];
    await persist(s);
    toast(`Chamber ${compactNos(clash.map((p) => p.no))} is already being decanted (another phone). The plan was redone without it.`, 5000);
    return;
  }
  const busy = busyTanks(s.id);
  const chk = checkPlan({ plan: d.plan, tanks: tanks(), readings: d.before, busy: new Set(busy.keys()), settings: state.settings });
  if (chk.blocking.length) { toast(chk.blocking[0], 4000); return; }
  const stale = chk.perTank.filter((r) => isStale(d.before[r.tank]));
  if (stale.length && !(await ask('Old stock reading', `${stale.map((r) => tankName(r.tank)).join(' & ')}: the reading is more than ${state.settings.staleMinutes} min old. If fuel was sold since, the variation will be off.<br><br>Start anyway?`, { ok: 'Start anyway', cancel: 'Take a new one' }))) return;
  d.tanks = chk.perTank.map((r) => ({
    tank: r.tank, tankNo: r.no, product: r.product, litres: r.litres, chambers: r.chambers,
    before: d.before[r.tank], after: null, salesL: 0, pricePerL: d.prices?.[r.product] ?? null,
  }));
  d.startedAt = new Date().toISOString();
  d.emptied = [];
  s.status = 'decanting';
  await persist(s);
  toast('Decanting started.');
}

async function decanted(s) {
  const d = s.data;
  const all = d.tanks.flatMap((t) => t.chambers.map((no) => ({ no, tank: t.tank })));
  const pre = new Set(d.emptied?.length ? d.emptied : all.map((x) => x.no));
  const chosen = await new Promise((resolve) => {
    let out = null;
    openSheet('Which chambers were emptied?', (body) => {
      body.innerHTML = `<div class="checklist">${all.map((x) => `<label class="${pre.has(x.no) ? 'on' : ''}"><input type="checkbox" value="${x.no}" ${pre.has(x.no) ? 'checked' : ''}>
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
  for (const p of d.plan) if (p.tank && !keep.has(p.no)) p.tank = null;
  d.tanks = d.tanks.map((t) => {
    const chambers = t.chambers.filter((no) => keep.has(no));
    const litres = chambers.reduce((a, no) => a + (d.chambers.find((c) => c.no === no)?.litres || 0), 0);
    return { ...t, chambers, litres };
  }).filter((t) => t.chambers.length);
  d.decantedAt = new Date().toISOString();
  s.status = 'settling';
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
      ...(old || { tank, tankNo: tk?.no, product: ps[0].product, before: d.before[tank], after: null, salesL: 0, pricePerL: d.prices?.[ps[0].product] ?? null }),
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
  if (!d.tanks.every((t) => t.after)) { toast('Add the stock after decanting for every tank.'); return; }
  const problems = d.tanks.flatMap((t) => afterWarnings(s, t).map((w) => `${tankName(t.tank)}: ${w}`));
  if (problems.length && !(await ask('Check the after-stock', `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>Save the result anyway?`, { ok: 'Save anyway', cancel: 'Fix it' }))) return;
  for (const t of d.tanks) {
    t.result = tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings);
    saveTankReading(t.tank, t.after);
  }
  d.completedAt = new Date().toISOString();
  s.completed_at = d.completedAt;
  s.status = 'done';
  await persist(s);
}

async function cancelSession(s) {
  const moved = s.status === 'decanting';
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

function share(s) {
  const d = s.data;
  const lines = [`Decanting — ${s.tt_no} · invoice ${s.invoice_no}`, `${fmtWhen(d.startedAt)} to ${fmtTime(d.decantedAt)}`];
  for (const t of d.tanks) {
    const r = t.result || tankResult({ litres: t.litres, before: t.before, after: t.after, salesL: t.salesL }, state.settings);
    lines.push(`${tankName(t.tank)} (${productShort(t.product)}) C${compactNos(t.chambers)} ${fmtL(t.litres)}: ${fmtL(t.before.volume, 2)} → ${fmtL(t.after?.volume, 2)} · gain ${r ? fmtL(r.gain, 2) : '—'} · variation ${r ? `${fmtSigned(r.variation, ' L', 2)} (${fmtPct(r.pct)}) ${r.band.toUpperCase()}` : '—'}`);
  }
  const text = lines.join('\n');
  if (navigator.share) navigator.share({ title: `Decanting ${s.tt_no}`, text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast('Copied.'), () => toast('Couldn\'t copy.'));
}
