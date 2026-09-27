// The Tanker Decanting app: home screen, stock screenshots, invoices and
// settings. The decanting wizard is in wizard.js, the log and reports in
// views.js; the rules they all share are in core.js.

import {
  PRODUCTS, chamberLayout, chartFromRows, chartIssues, chartMaxCm, dipAtLitres, invoiceStatus, istDate,
  litresAtDip, productKey, round2, usedChambers,
} from './core.js';
import { DIP_CHART } from './dipchart.js';
import {
  cloudEnabled, clearDevice, initStore, onChange, refreshNow, saveConfig, saveDevice, saveInvoice, savePhoto,
  saveTankReading, saveVehicle, state,
} from './store.js';
import {
  ago, ask, bandBadge, closeSheet, confBadge, esc, fmtDip, fmtKL, fmtL, fmtNum, fmtSigned, fmtTime, fmtWhen,
  openSheet, productChip, productShort, tankGauge, toast, truckStrip,
} from './ui.js';
import { openWizard, renderWizard, startSession, wizardActive } from './wizard.js';
import { renderLog, renderReports } from './views.js';

export const APP = { tab: 'home', showOlder: false };

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

export const tanks = () => state.settings.tanks;
export const tankById = (id) => tanks().find((t) => t.id === id);
export const tankName = (id) => { const t = tankById(id); return t ? `Tank ${t.no}` : id; };

export function layoutFor(inv) {
  return chamberLayout(inv, state.vehicles[inv.tt_no]);
}

// Tanks that are being decanted into right now (another truck can't use them).
export function busyTanks(exceptId = null) {
  const busy = new Map();
  for (const s of state.sessions) {
    if (s.id === exceptId || !['decanting', 'settling'].includes(s.status)) continue;
    for (const t of s.data?.tanks || []) busy.set(t.tank, s);
  }
  return busy;
}

export function isStale(reading) {
  if (!reading?.readingAt) return true;
  return (Date.now() - Date.parse(reading.readingAt)) / 60000 > state.settings.staleMinutes;
}

// A stored reading from what the screenshot showed (or what was typed).
export function makeReading(tankId, r, source, extra = {}) {
  const t = tankById(tankId);
  const capacity = r.capacity || t?.capacity || 20000;
  const volume = round2(r.volume);
  const dip = Number.isFinite(r.height) ? round2(r.height / 10) : (Number.isFinite(r.dip) ? r.dip : dipAtLitres(state.chart, volume));
  return {
    volume,
    ullage: Number.isFinite(r.ullage) ? round2(r.ullage) : round2(capacity - volume),
    capacity,
    height: Number.isFinite(r.height) ? r.height : null,
    dip: Number.isFinite(dip) ? round2(dip) : null,
    water: Number.isFinite(r.water) ? r.water : null,
    density: r.density ?? null,
    densityTc: r.densityTc ?? null,
    temp: r.temp ?? null,
    status: r.status || null,
    readingAt: r.readingAt || new Date().toISOString(),
    timeRead: Boolean(r.readingAt),
    source,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Reading an automation screenshot (used by the stock button and the wizard)
// ---------------------------------------------------------------------------

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => { resolve(input.files?.[0] || null); input.remove(); };
    document.body.append(input);
    input.click();
    // a cancelled picker fires no event; the promise just stays pending
  });
}

// Pick a screenshot, read it and let the user check what was found.
// Resolves {photoId, readings: {tankId: reading}} or null.
export async function readScreenshot({ kind = 'stock', sessionId = null, want = null } = {}) {
  const file = await pickFile('image/*');
  if (!file) return null;
  return new Promise((resolve) => {
    let result = null;
    openSheet('Reading the screenshot', (body) => {
      body.innerHTML = `<div class="hint" id="rsState">Loading the text reader…</div><div class="progress"><i id="rsBar"></i></div>
        <img class="full" id="rsImg" alt="" style="margin-top:12px;max-height:200px;object-fit:contain">`;
      const url = URL.createObjectURL(file);
      body.querySelector('#rsImg').src = url;
      (async () => {
        try {
          const { readAutomationPhoto, compressImage } = await import('./ocr.js');
          const parsed = await readAutomationPhoto(file, {
            tanks: tanks(), chart: state.chart, dateOrder: state.settings.dateOrder, now: Date.now(),
            onProgress: (f, label) => {
              const bar = body.querySelector('#rsBar');
              if (bar) bar.style.width = `${Math.round(f * 100)}%`;
              const st = body.querySelector('#rsState');
              if (st) st.textContent = label;
            },
          });
          const dataUrl = await compressImage(file);
          showFound(body, parsed, dataUrl, url);
        } catch (e) {
          body.innerHTML = `<div class="banner bad">Couldn't read this picture: ${esc(e.message || e)}</div>
            <div class="hint">You can still type the stock in litres or as a dip.</div>
            <div class="row-actions"><button class="btn" data-close2>Close</button></div>`;
          body.querySelector('[data-close2]').onclick = () => closeSheet();
        }
      })();

      function showFound(el, parsed, dataUrl, imgUrl) {
        const found = parsed.tanks;
        const rows = found.map((t, i) => {
          const tank = t.tankId ? tankById(t.tankId) : null;
          const r = t.reading;
          const wanted = !want || (t.tankId && want.includes(t.tankId));
          const stale = r.readingAt && (Date.now() - Date.parse(r.readingAt)) / 60000 > state.settings.staleMinutes;
          const tankSel = t.tankId ? '' : `<label class="f" style="margin-top:8px">Which tank is this?
              <select data-pick="${i}"><option value="">— choose —</option>${tanks().map((x) => `<option value="${x.id}">Tank ${x.no} · ${productShort(x.product)}</option>`).join('')}</select></label>`;
          return `<div class="reading" data-i="${i}">
            <div class="rd-head">
              <span class="nm">${t.no ? `Tank ${t.no}` : 'Tank ?'}</span>
              ${tank ? productChip(tank.product) : (t.product ? productChip(t.product) : '')}
              ${confBadge(t.confidence, t.checks)}
              ${wanted ? '' : '<span class="badge info">not needed now</span>'}
            </div>
            <div class="kv">
              <div><div class="k">Stock</div><div class="v big">${fmtL(r.volume, 2)}</div></div>
              <div><div class="k">Room (ullage)</div><div class="v">${fmtL(r.ullage, 2)}</div></div>
              <div><div class="k">Dip</div><div class="v">${fmtDip(Number.isFinite(r.height) ? r.height / 10 : dipAtLitres(state.chart, r.volume))}</div></div>
              <div><div class="k">Water</div><div class="v">${Number.isFinite(r.water) ? fmtL(r.water, 2) : '—'}</div></div>
              <div><div class="k">Density / (tc)</div><div class="v">${r.density ?? '—'} / ${r.densityTc ?? '—'}</div></div>
              <div><div class="k">Temp</div><div class="v">${r.temp ?? '—'}${r.temp != null ? ' °C' : ''}</div></div>
            </div>
            <div class="rd-src">${r.readingAt ? `Automation time ${fmtWhen(r.readingAt)}${stale ? ' — <b style="color:var(--warn)">old</b>' : ''}` : 'Time not readable — the upload time is used'}
              ${t.checks?.chart?.ok === false ? ' · <span style="color:var(--warn)">doesn\'t match the dip chart</span>' : ''}</div>
            ${tankSel}
            <label class="f" style="margin-top:8px">Correct the stock if it's wrong (L)
              <input type="number" inputmode="decimal" step="0.01" data-vol="${i}" value="${r.volume}"></label>
          </div>`;
        }).join('');
        el.innerHTML = `${parsed.warnings.map((w) => `<div class="banner">${esc(w)}</div>`).join('')}
          ${rows || '<div class="empty">No tank card found.</div>'}
          <div class="row-actions">
            <button class="btn" data-cancel>Cancel</button>
            ${found.length ? '<button class="cta" data-use>Use these readings</button>' : ''}
          </div>
          <details style="margin-top:12px"><summary class="hint">Screenshot</summary><img class="full" src="${imgUrl}" alt="Automation screenshot"></details>`;
        el.querySelector('[data-cancel]').onclick = () => closeSheet();
        el.querySelector('[data-use]')?.addEventListener('click', async () => {
          const photoId = await savePhoto({ session_id: sessionId, kind, data_url: dataUrl, meta: { tanks: found.map((t) => ({ no: t.no, volume: t.reading.volume, readingAt: t.reading.readingAt, confidence: t.confidence })) } });
          const readings = {};
          found.forEach((t, i) => {
            const id = t.tankId || el.querySelector(`[data-pick="${i}"]`)?.value;
            if (!id) return;
            const typed = Number(el.querySelector(`[data-vol="${i}"]`)?.value);
            const r = { ...t.reading };
            let src = 'photo';
            if (Number.isFinite(typed) && Math.abs(typed - r.volume) > 0.004) {
              r.volume = typed;
              r.ullage = round2((tankById(id)?.capacity || r.capacity || 20000) - typed);
              r.height = null;
              src = 'photo-edited';
            }
            readings[id] = makeReading(id, r, src, { photoId, confidence: t.confidence, checks: t.checks });
          });
          for (const [id, r] of Object.entries(readings)) saveTankReading(id, r);
          result = { photoId, readings };
          closeSheet();
        });
      }
      return () => { URL.revokeObjectURL(url); resolve(result); };
    });
  });
}

// A reading typed in: litres, or a dip in cm (converted with the dip chart).
export function typedReading(tankId, { litres, dipCm }) {
  const t = tankById(tankId);
  if (Number.isFinite(dipCm)) {
    const l = litresAtDip(state.chart, dipCm);
    if (!Number.isFinite(l)) throw new Error(`The dip chart runs from ${state.chart.startCm} to ${round2(chartMaxCm(state.chart))} cm.`);
    return makeReading(tankId, { volume: l, dip: dipCm, capacity: t.capacity }, 'dip');
  }
  if (!(litres >= 0) || litres > t.capacity * 1.15) throw new Error('Type the stock in litres.');
  return makeReading(tankId, { volume: litres, capacity: t.capacity }, 'litres');
}

// ---------------------------------------------------------------------------
// Header, banner, tabs
// ---------------------------------------------------------------------------

function renderStatus() {
  const pill = document.getElementById('statusPill');
  const text = document.getElementById('statusText');
  const waiting = state.outbox.length;
  pill.className = `pill ${state.cloud}`;
  text.textContent = {
    off: 'this phone', connecting: 'connecting…', live: waiting ? `sending ${waiting}` : 'synced', offline: waiting ? `offline · ${waiting} to send` : 'offline',
  }[state.cloud] || state.cloud;
}

function renderBanner() {
  const el = document.getElementById('banner');
  if (!cloudEnabled) {
    el.innerHTML = `<div class="banner"><b>Working on this phone only.</b> Add the Supabase URL + key to <code>decant/config.js</code> and run
      <code>supabase/decant-schema.sql</code> to get invoices from the payments agent and sync across phones.</div>`;
  } else if (state.cloud === 'offline' && state.cloudError) {
    el.innerHTML = `<div class="banner${/missing/.test(state.cloudError) ? ' bad' : ''}">${/missing/.test(state.cloudError) ? '' : 'Offline — changes are kept on this phone and sent when the connection is back. '}${esc(state.cloudError)}</div>`;
  } else {
    el.innerHTML = '';
  }
}

function setTab(tab) {
  APP.tab = tab;
  try { localStorage.setItem('vriddhi-decant-tab', tab); } catch { /* ignore */ }
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

function viewHasFocus(id) {
  const a = document.activeElement;
  return a && document.getElementById(id)?.contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
}

export function render() {
  renderStatus();
  renderBanner();
  const active = state.sessions.filter((s) => ['decanting', 'settling'].includes(s.status)).length;
  const badge = document.getElementById('homeBadge');
  badge.hidden = !active;
  badge.textContent = active;
  const inWizard = wizardActive();
  document.getElementById('tabbar').hidden = inWizard;
  document.getElementById('view-wizard').hidden = !inWizard;
  document.getElementById('view-home').hidden = inWizard || APP.tab !== 'home';
  document.getElementById('view-log').hidden = inWizard || APP.tab !== 'log';
  document.getElementById('view-reports').hidden = inWizard || APP.tab !== 'reports';
  if (inWizard) { if (!viewHasFocus('view-wizard')) renderWizard(document.getElementById('view-wizard')); return; }
  if (APP.tab === 'home' && !viewHasFocus('view-home')) renderHome(document.getElementById('view-home'));
  if (APP.tab === 'log' && !viewHasFocus('view-log')) renderLog(document.getElementById('view-log'));
  if (APP.tab === 'reports' && !viewHasFocus('view-reports')) renderReports(document.getElementById('view-reports'));
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function tankTile(t, busy) {
  const r = state.tankState[t.id];
  const b = busy.get(t.id);
  const stale = r && isStale(r);
  return `<button class="tank${b ? ' busy' : ''}" data-tank="${t.id}" aria-label="Tank ${t.no} ${productShort(t.product)}">
    ${b ? '<span class="badge watch t-busy"><i>●</i>Decanting</span>' : ''}
    <div class="t-head"><span class="t-name">Tank ${t.no}</span>${productChip(t.product)}</div>
    ${tankGauge({ product: t.product, volume: r?.volume, capacity: t.capacity, label: `Tank ${t.no}` })}
    <div class="t-vol">${r ? fmtL(r.volume) : '—'}</div>
    <div class="t-sub">Room <b>${r ? fmtL(r.ullage) : '—'}</b> · Dip <b>${r ? fmtDip(r.dip) : '—'}</b></div>
    <div class="t-age${stale ? ' stale' : ''}">${r ? `${fmtWhen(r.readingAt)} · ${ago(r.readingAt)}` : 'No reading yet'}</div>
  </button>`;
}

function invoiceCard(inv, st) {
  const layout = layoutFor(inv);
  const used = usedChambers(state.sessions, inv.invoice_no);
  const prods = layout.lines.map((l) => productChip(l.key, `${fmtKL(l.litres)}${l.chambers.length ? ` · C${compactNos(l.chambers)}` : ''}`)).join('');
  const dens = layout.lines.filter((l) => l.density15).map((l) => `${productShort(l.key)} ${l.density15}`).join(' · ');
  const noTank = layout.lines.filter((l) => !tanks().some((t) => t.product === l.key));
  const stBadge = { new: '<span class="badge info">New</span>', partial: '<span class="badge watch"><i>◐</i>Part decanted</span>', active: '<span class="badge watch"><i>●</i>Decanting</span>' }[st] || '';
  return `<div class="card inv" data-inv="${esc(inv.invoice_no)}">
    <div class="inv-top">
      <div><div class="inv-tt">${esc(inv.tt_no || 'Unknown truck')}</div>
        <div class="inv-meta">${esc(inv.invoice_no)} · ${esc(inv.invoice_date || '')} ${esc(inv.invoice_time || '')}${inv.source && inv.source !== 'agent' ? ` · ${inv.source === 'pdf' ? 'from PDF' : 'typed in'}` : ''}</div></div>
      ${stBadge}
    </div>
    <div class="inv-prods">${prods}</div>
    ${truckStrip(layout.chambers, { done: used })}
    <div class="hint" style="margin-top:6px">${dens ? `Density@15: ${esc(dens)}` : ''}${inv.seals ? `${dens ? ' · ' : ''}Seals: ${esc(inv.seals)}` : ''}</div>
    ${[...layout.problems, ...noTank.map((l) => `No tank here holds ${l.key} — it can't be decanted.`)].map((p) => `<div class="banner" style="margin:8px 0 0">${esc(p)}</div>`).join('')}
    <div class="inv-actions">
      ${st === 'active' ? '<button class="cta" data-resume>Continue decanting ▶</button>' : `<button class="cta" data-start>${st === 'partial' ? 'Decant the rest ▶' : 'Start decanting ▶'}</button>`}
      <button class="btn" data-menu aria-label="More">⋯</button>
    </div>
  </div>`;
}

export function compactNos(nos) {
  const s = [...nos].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j += 1;
    out.push(j > i + 1 ? `${s[i]}–${s[j]}` : j === i + 1 ? `${s[i]},${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(',');
}

function sessionCard(s) {
  const d = s.data || {};
  const step = { draft: 'Getting ready', decanting: 'Decanting now', settling: 'Waiting for the after-stock' }[s.status];
  const tanksTxt = (d.tanks || []).map((t) => `C${compactNos(t.chambers)} → ${tankName(t.tank)}`).join(' · ') || 'No chambers picked yet';
  return `<div class="card accent" data-session="${esc(s.id)}">
    <div class="inv-top"><div><div class="inv-tt">${esc(s.tt_no || '')}</div><div class="inv-meta">${esc(s.invoice_no || '')}</div></div>
      <span class="badge watch"><i>●</i>${step}</span></div>
    <div class="hint" style="margin:8px 0">${esc(tanksTxt)}${d.startedAt ? ` · started ${fmtTime(d.startedAt)}` : ''}${d.decantedAt ? ` · done ${fmtTime(d.decantedAt)}` : ''}</div>
    <div class="inv-actions"><button class="cta" data-open>Continue ▶</button>${s.status === 'draft' ? '<button class="btn" data-discard>Discard</button>' : ''}</div>
  </div>`;
}

function renderHome(el) {
  const busy = busyTanks();
  const open = state.sessions.filter((s) => ['draft', 'decanting', 'settling'].includes(s.status))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const withStatus = state.invoices.map((inv) => ({ inv, st: invoiceStatus(inv, state.sessions, layoutFor(inv)) }))
    .filter((x) => x.st !== 'done' && x.st !== 'dismissed' && !open.some((s) => s.invoice_no === x.inv.invoice_no && s.status === 'draft'))
    .sort((a, b) => invKey(b.inv) - invKey(a.inv));
  const cutoff = Date.now() - state.settings.pendingDays * 86400000;
  const recent = withStatus.filter((x) => x.st !== 'new' || invKey(x.inv) >= cutoff);
  const older = withStatus.filter((x) => !recent.includes(x));
  const today = istDate(Date.now());
  const startToday = Date.parse(`${today}T00:00:00+05:30`);
  // First days with the app: the agent back-fills recent invoices, some of
  // them decanted before the app was in use.
  const firstDay = state.sessions.length ? [] : recent.filter((x) => x.st === 'new' && invKey(x.inv) < startToday);
  const doneToday = state.sessions.filter((s) => s.status === 'done' && istDate(s.data?.decantedAt || s.created_at) === today);

  el.innerHTML = `
    <h2>Tank stock <span class="sp"></span><button class="btn sm" data-stock>📷 Update</button><button class="btn sm ghost" data-dipcalc title="Dip ↔ litres">📏</button></h2>
    <div class="tanks">${tanks().map((t) => tankTile(t, busy)).join('')}</div>
    ${open.length ? `<h2>In progress <span class="count">${open.length}</span></h2>${open.map(sessionCard).join('')}` : ''}
    <h2>To decant <span class="count">${recent.length}</span><span class="sp"></span>
      <button class="btn sm" data-addpdf title="Add an invoice from its PDF">⬆ PDF</button><button class="btn sm" data-addinv title="Type an invoice in">＋ Add</button></h2>
    ${firstDay.length ? `<div class="banner">${firstDay.length} of these invoice${firstDay.length === 1 ? ' is' : 's are'} from before today. If those tankers were already decanted before you started using the app,
      <button class="btn sm" data-hidebefore>hide ${firstDay.length === 1 ? 'it' : `all ${firstDay.length}`}</button></div>` : ''}
    ${recent.length ? recent.map((x) => invoiceCard(x.inv, x.st)).join('') : `<div class="empty">No tanker waiting. New IndianOil invoices appear here on their own (the payments agent reads them from mail every ~20 min) — or add one from its PDF.</div>`}
    ${older.length ? `<h2 style="cursor:pointer" data-older>${APP.showOlder ? '▾' : '▸'} Older, not decanted in the app <span class="count">${older.length}</span><span class="sp"></span>
        ${APP.showOlder ? '<button class="btn sm ghost" data-dismissold>Dismiss all</button>' : ''}</h2>
      ${APP.showOlder ? older.map((x) => invoiceCard(x.inv, x.st)).join('') : ''}` : ''}
    ${doneToday.length ? `<h2>Finished today <span class="count">${doneToday.length}</span></h2>${doneToday.map(doneRow).join('')}` : ''}
  `;
}

function invKey(inv) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(inv.invoice_date || '');
  if (m) return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${inv.invoice_time || '00:00'}:00+05:30`);
  return Date.parse(inv.created_at || 0) || 0;
}

function doneRow(s) {
  const worst = (s.data?.tanks || []).reduce((w, t) => (!w || Math.abs(t.result?.variation || 0) > Math.abs(w.result?.variation || 0) ? t : w), null);
  const total = (s.data?.tanks || []).reduce((a, t) => a + (t.result?.variation || 0), 0);
  return `<button class="lrow" data-session-done="${esc(s.id)}">
    <span class="tm">${fmtTime(s.data?.decantedAt)}</span>
    <span class="mid"><b>${esc(s.tt_no || '')}</b><div>${(s.data?.tanks || []).map((t) => `${tankName(t.tank)} ${fmtKL(t.litres)}`).join(' · ')}</div></span>
    <span class="rt"><b>${fmtSigned(total, ' L')}</b>${worst?.result ? `<span class="rt-badge">${bandBadge(worst.result.band, worst.result.direction)}</span>` : ''}</span>
  </button>`;
}

function onHomeClick(e) {
  const t = e.target;
  const tile = t.closest('[data-tank]');
  if (tile) { tankSheet(tile.dataset.tank); return; }
  if (t.closest('[data-stock]')) { stockFlow(); return; }
  if (t.closest('[data-dipcalc]')) { dipCalculator(); return; }
  if (t.closest('[data-addinv]')) { invoiceForm(); return; }
  if (t.closest('[data-addpdf]')) { invoiceFromPdf(); return; }
  if (t.closest('[data-older]') && !t.closest('[data-dismissold]')) { APP.showOlder = !APP.showOlder; render(); return; }
  if (t.closest('[data-dismissold]')) { dismissOlder(); return; }
  if (t.closest('[data-hidebefore]')) { hideBeforeToday(); return; }
  const doneBtn = t.closest('[data-session-done]');
  if (doneBtn) { openWizard(doneBtn.dataset.sessionDone); return; }
  const card = t.closest('[data-inv]');
  if (card) {
    const inv = state.invoices.find((x) => x.invoice_no === card.dataset.inv);
    if (!inv) return;
    if (t.closest('[data-start]')) { startSession(inv); return; }
    if (t.closest('[data-resume]')) {
      const s = state.sessions.find((x) => x.invoice_no === inv.invoice_no && ['decanting', 'settling'].includes(x.status));
      if (s) openWizard(s.id);
      return;
    }
    if (t.closest('[data-menu]')) { invoiceMenu(inv); return; }
  }
  const sc = t.closest('[data-session]');
  if (sc) {
    const s = state.sessions.find((x) => x.id === sc.dataset.session);
    if (!s) return;
    if (t.closest('[data-discard]')) {
      ask('Discard this draft?', 'Nothing was decanted yet; the invoice goes back to the list.', { ok: 'Discard', danger: true })
        .then(async (yes) => { if (yes) { s.status = 'cancelled'; s.completed_at = new Date().toISOString(); const { saveSession } = await import('./store.js'); saveSession(s); } });
      return;
    }
    openWizard(s.id);
  }
}

async function dismissOlder() {
  const cutoff = Date.now() - state.settings.pendingDays * 86400000;
  const list = state.invoices.filter((inv) => invoiceStatus(inv, state.sessions, layoutFor(inv)) === 'new' && invKey(inv) < cutoff);
  const yes = await ask(`Dismiss ${list.length} older invoice${list.length === 1 ? '' : 's'}?`,
    'Use this once when you start with the app: those tankers were decanted before. They stay out of the list (and out of the reports).', { ok: 'Dismiss all' });
  if (!yes) return;
  for (const inv of list) saveInvoice({ ...inv, dismissed: true, note: inv.note || 'Decanted before the app' });
  toast(`Dismissed ${list.length}.`);
}

async function hideBeforeToday() {
  const start = Date.parse(`${istDate(Date.now())}T00:00:00+05:30`);
  const list = state.invoices.filter((inv) => invoiceStatus(inv, state.sessions, layoutFor(inv)) === 'new' && invKey(inv) < start);
  for (const inv of list) saveInvoice({ ...inv, dismissed: true, note: inv.note || 'Decanted before the app' });
  toast(`Hid ${list.length}. They're not in the reports either.`);
}

function invoiceMenu(inv) {
  openSheet(`${inv.tt_no} · ${inv.invoice_no}`, (body) => {
    body.innerHTML = `<div class="hint">Invoice ${esc(inv.invoice_no)} of ${esc(inv.invoice_date || '')} ${esc(inv.invoice_time || '')}.</div>
      <div class="row-actions" style="justify-content:flex-start">
        <button class="btn" data-edit>✎ Edit chambers & products</button>
        <button class="btn" data-done>Already decanted (outside the app) — hide it</button>
        <button class="btn" data-dismiss>Not for our tanks — hide it</button>
        ${inv.source !== 'agent' ? '<button class="btn danger" data-del>Delete</button>' : ''}
      </div>`;
    body.querySelector('[data-edit]').onclick = () => { closeSheet(); invoiceForm(inv); };
    body.querySelector('[data-dismiss]').onclick = async () => {
      closeSheet();
      await saveInvoice({ ...inv, dismissed: true, note: 'Not for our tanks' });
      toast('Hidden. (It won\'t show in the list or the reports.)');
    };
    body.querySelector('[data-done]').onclick = async () => {
      closeSheet();
      await saveInvoice({ ...inv, dismissed: true, note: 'Decanted outside the app' });
      toast('Hidden.');
    };
    body.querySelector('[data-del]')?.addEventListener('click', async () => {
      closeSheet();
      if (await ask('Delete this invoice?', 'Only invoices typed in or added from a PDF can be deleted.', { ok: 'Delete', danger: true })) {
        await saveInvoice({ ...inv, dismissed: true, note: 'deleted' });
        toast('Deleted.');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Stock: screenshot, tank details, dip calculator
// ---------------------------------------------------------------------------

async function stockFlow() {
  const res = await readScreenshot({ kind: 'stock' });
  if (res && Object.keys(res.readings).length) toast(`Stock updated: ${Object.keys(res.readings).map(tankName).join(', ')}.`);
}

function tankSheet(id) {
  const t = tankById(id);
  const r = state.tankState[id];
  openSheet(`Tank ${t.no} · ${PRODUCTS[t.product].name}`, (body) => {
    body.innerHTML = `
      ${tankGauge({ product: t.product, volume: r?.volume, capacity: t.capacity, label: `Tank ${t.no}` })}
      ${r ? `<div class="kv">
        <div><div class="k">Stock</div><div class="v big">${fmtL(r.volume, 2)}</div></div>
        <div><div class="k">Room</div><div class="v">${fmtL(r.ullage, 2)}</div></div>
        <div><div class="k">Dip</div><div class="v">${fmtDip(r.dip)}</div></div>
        <div><div class="k">Water</div><div class="v">${r.water != null ? fmtL(r.water, 2) : '—'}</div></div>
        <div><div class="k">Density / (tc)</div><div class="v">${r.density ?? '—'} / ${r.densityTc ?? '—'}</div></div>
        <div><div class="k">Temp</div><div class="v">${r.temp ?? '—'}</div></div></div>
        <div class="rd-src" style="margin-top:8px">${{ photo: 'From a screenshot', 'photo-edited': 'From a screenshot (corrected)', litres: 'Typed in', dip: 'From a dip' }[r.source] || ''} · ${fmtWhen(r.readingAt)} (${ago(r.readingAt)})</div>` : '<div class="empty">No reading yet.</div>'}
      <div class="hr"></div>
      <div class="sect-title">Type the stock</div>
      <div class="manual">
        <label class="f">Litres<input type="number" inputmode="decimal" step="0.01" id="tsL" placeholder="e.g. 12019"></label>
        <label class="f">or dip (cm)<input type="number" inputmode="decimal" step="0.1" id="tsD" placeholder="e.g. 114.2"></label>
        <button class="btn" id="tsSave">Save</button>
      </div>
      <div class="hint" id="tsHint" style="margin-top:6px"></div>
      <div class="row-actions"><button class="btn" id="tsPhoto">📷 From a screenshot</button></div>`;
    const L = body.querySelector('#tsL');
    const D = body.querySelector('#tsD');
    const hint = body.querySelector('#tsHint');
    const upd = () => {
      const l = Number(L.value);
      const d = Number(D.value);
      if (D.value && Number.isFinite(d)) hint.textContent = `${d} cm = ${fmtL(litresAtDip(state.chart, d), 2)} by the dip chart`;
      else if (L.value && Number.isFinite(l)) hint.textContent = `${fmtL(l, 2)} = ${fmtDip(dipAtLitres(state.chart, l))} dip`;
      else hint.textContent = '';
    };
    L.oninput = () => { D.value = ''; upd(); };
    D.oninput = () => { L.value = ''; upd(); };
    body.querySelector('#tsSave').onclick = () => {
      try {
        const rd = typedReading(id, { litres: L.value ? Number(L.value) : NaN, dipCm: D.value ? Number(D.value) : NaN });
        saveTankReading(id, rd);
        closeSheet();
        toast(`Tank ${t.no}: ${fmtL(rd.volume)} saved.`);
      } catch (e) { hint.textContent = e.message; }
    };
    body.querySelector('#tsPhoto').onclick = () => { closeSheet(); stockFlow(); };
  });
}

export function dipCalculator() {
  openSheet('Dip ↔ litres', (body) => {
    const c = state.chart;
    body.innerHTML = `<div class="hint">${esc(c.name || 'Dip chart')} · ${c.startCm}–${round2(chartMaxCm(c))} cm every ${c.stepCm} cm.</div>
      <div class="grid2" style="margin-top:10px">
        <label class="f">Dip (cm)<input type="number" inputmode="decimal" step="0.1" id="dcD"></label>
        <label class="f">Litres<input type="number" inputmode="decimal" step="1" id="dcL"></label>
      </div>
      <div class="kv" id="dcOut" style="margin-top:12px"></div>`;
    const D = body.querySelector('#dcD');
    const L = body.querySelector('#dcL');
    const out = body.querySelector('#dcOut');
    const show = (dip, litres) => {
      out.innerHTML = Number.isFinite(dip) && Number.isFinite(litres)
        ? `<div><div class="k">Dip</div><div class="v big">${fmtDip(dip)}</div></div><div><div class="k">Stock</div><div class="v big">${fmtL(litres, 2)}</div></div>
           ${tanks().length ? `<div><div class="k">Room (${fmtNum(tanks()[0].capacity)} L tank)</div><div class="v">${fmtL(tanks()[0].capacity - litres, 2)}</div></div>` : ''}`
        : '<div class="hint">Out of the chart\'s range.</div>';
    };
    D.oninput = () => { const d = Number(D.value); L.value = ''; show(d, litresAtDip(c, d)); };
    L.oninput = () => { const l = Number(L.value); D.value = ''; show(dipAtLitres(c, l), l); };
  });
}

// ---------------------------------------------------------------------------
// Invoices typed in / from a PDF
// ---------------------------------------------------------------------------

async function invoiceFromPdf() {
  const file = await pickFile('application/pdf,.pdf');
  if (!file) return;
  openSheet('Invoice from PDF', (body) => {
    body.innerHTML = '<div class="hint">Reading the invoice…</div>';
    (async () => {
      try {
        const { readInvoicePdf } = await import('./invoice.js');
        const inv = await readInvoicePdf(file);
        const existing = state.invoices.find((x) => x.invoice_no === inv.invoice_no);
        const layout = chamberLayout(inv, state.vehicles[inv.tt_no]);
        body.innerHTML = `${existing ? `<div class="banner">This invoice is already in the list${existing.dismissed ? ' (hidden)' : ''}.</div>` : ''}
          <div class="inv-tt">${esc(inv.tt_no)}</div><div class="inv-meta">${esc(inv.invoice_no)} · ${esc(inv.invoice_date || '')} ${esc(inv.invoice_time || '')}</div>
          <div class="inv-prods">${layout.lines.map((l) => productChip(l.key, fmtKL(l.litres))).join('')}</div>
          ${truckStrip(layout.chambers)}
          ${layout.problems.map((p) => `<div class="banner" style="margin-top:8px">${esc(p)}</div>`).join('')}
          <div class="row-actions"><button class="btn" data-x>Cancel</button><button class="cta" data-save>${existing ? 'Show it again' : 'Add to the list'}</button></div>`;
        body.querySelector('[data-x]').onclick = () => closeSheet();
        body.querySelector('[data-save]').onclick = async () => {
          const row = existing ? { ...existing, dismissed: false } : {
            invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, invoice_time: inv.invoice_time, tt_no: inv.tt_no,
            lines: inv.lines, chambers: inv.chambers, density15: inv.density15, seals: inv.seals, origin: null,
            amount: inv.amount, gmail_msg_id: null, source: 'pdf', dismissed: false, note: null,
          };
          await saveInvoice(row);
          closeSheet();
          toast('Invoice added.');
        };
      } catch (e) {
        body.innerHTML = `<div class="banner bad">${esc(e.message || e)}</div><div class="row-actions"><button class="btn" data-x>Close</button></div>`;
        body.querySelector('[data-x]').onclick = () => closeSheet();
      }
    })();
  });
}

// Type an invoice in (or correct one's chambers / products).
export function invoiceForm(existing = null) {
  const inv = existing ? JSON.parse(JSON.stringify(existing)) : null;
  openSheet(inv ? `Edit ${inv.tt_no} · ${inv.invoice_no}` : 'Add an invoice', (body) => {
    const today = new Date(Date.now() + 330 * 60000).toISOString();
    const vehicles = Object.keys(state.vehicles).sort();
    const known = inv ? layoutFor(inv) : null;
    body.innerHTML = `
      <div class="grid2">
        <label class="f">Truck (TT) number<input type="text" id="ivTT" list="ivTTs" autocomplete="off" placeholder="OD23U8210" value="${esc(inv?.tt_no || '')}" ${inv ? 'readonly' : ''}></label>
        <label class="f">Invoice no. (optional)<input type="text" id="ivNo" value="${esc(inv?.invoice_no || '')}" ${inv ? 'readonly' : ''} placeholder="70…"></label>
      </div>
      <datalist id="ivTTs">${vehicles.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>
      <div class="grid2" style="margin-top:10px">
        <label class="f">Date<input type="date" id="ivDate" value="${inv?.invoice_date ? inv.invoice_date.split('/').reverse().join('-') : today.slice(0, 10)}"></label>
        <label class="f">Time<input type="time" id="ivTime" value="${esc(inv?.invoice_time || today.slice(11, 16))}"></label>
      </div>
      <label class="f" style="margin-top:10px">Chambers, KL each, from chamber 1 (e.g. 5, 5, 4, 4, 4)
        <input type="text" id="ivCh" inputmode="decimal" value="${esc((known?.chambers || []).map((c) => c.litres / 1000).join(', '))}"></label>
      <div class="hint" id="ivChHint"></div>
      <div class="sect-title" style="margin-top:14px">What's in each chamber</div>
      <div id="ivProd"></div>
      <div class="hint" id="ivSum" style="margin-top:6px"></div>
      <div class="row-actions"><button class="btn" data-x>Cancel</button><button class="cta" data-save>${inv ? 'Save changes' : 'Add to the list'}</button></div>`;
    const tt = body.querySelector('#ivTT');
    const ch = body.querySelector('#ivCh');
    const prodEl = body.querySelector('#ivProd');
    let prodOf = {};
    if (known) for (const c of known.chambers) prodOf[c.no] = c.product || '';
    const parseCh = () => ch.value.split(/[,\s]+/).map(Number).filter((x) => x > 0 && x <= 30);
    const draw = () => {
      const caps = parseCh();
      prodEl.innerHTML = caps.map((kl, i) => {
        const no = i + 1;
        const cur = prodOf[no] ?? (i === 0 && !Object.keys(prodOf).length ? 'HSD' : prodOf[no - 1] || 'HSD');
        prodOf[no] = cur;
        return `<div class="plan-tank" style="grid-template-columns:70px minmax(0,1fr)"><div class="pt-name">C${no} <span class="hint">${kl} KL</span></div>
          <div class="seg">${['MS', 'HSD', 'XG', ''].map((p) => `<button type="button" class="${cur === p ? 'on' : ''}" data-ch="${no}" data-p="${p}">${p ? productShort(p) : 'Empty'}</button>`).join('')}</div></div>`;
      }).join('') || '<div class="hint">Type the chambers above.</div>';
      const tot = {};
      caps.forEach((kl, i) => { const p = prodOf[i + 1]; if (p) tot[p] = (tot[p] || 0) + kl; });
      body.querySelector('#ivSum').textContent = Object.entries(tot).map(([p, kl]) => `${productShort(p)} ${kl} KL`).join(' · ');
    };
    tt.oninput = () => {
      const v = state.vehicles[tt.value.trim().toUpperCase()];
      if (v && !ch.value) {
        ch.value = v.chambers.map((c) => c.qty_kl).join(', ');
        body.querySelector('#ivChHint').textContent = 'Chambers from this truck\'s last invoice.';
        draw();
      }
    };
    ch.oninput = draw;
    prodEl.onclick = (e) => {
      const b = e.target.closest('[data-ch]');
      if (!b) return;
      prodOf[Number(b.dataset.ch)] = b.dataset.p;
      draw();
    };
    draw();
    body.querySelector('[data-x]').onclick = () => closeSheet();
    body.querySelector('[data-save]').onclick = async () => {
      const ttNo = tt.value.trim().toUpperCase().replace(/\s+/g, '');
      const caps = parseCh();
      if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(ttNo)) { toast('Type the truck number, e.g. OD23U8210.'); return; }
      if (!caps.length) { toast('Type the chambers (KL each).'); return; }
      const chambers = caps.map((kl, i) => {
        const old = inv?.chambers?.find((c) => c.no === i + 1);
        return { no: i + 1, qty_kl: kl, dip_cm: old?.dip_cm ?? null, pl_cm: old?.pl_cm ?? null };
      });
      const byP = {};
      caps.forEach((kl, i) => { const p = prodOf[i + 1]; if (p) (byP[p] ||= []).push(i + 1); });
      if (!Object.keys(byP).length) { toast('Pick the product in at least one chamber.'); return; }
      const oldLines = inv?.lines || [];
      const lines = Object.entries(byP).map(([p, nos]) => {
        const old = oldLines.find((l) => productKey(l.column_key || l.product) === p);
        return {
          product: old?.product || PRODUCTS[p].name, column_key: old?.column_key || { MS: 'MS | EBMS', HSD: 'HSD', XG: 'XtraGreen HSD' }[p],
          qty_kl: round2(nos.reduce((a, n) => a + caps[n - 1], 0)), compartments: nos, density15: old?.density15 ?? null,
          terminal_tank: old?.terminal_tank ?? null, value: old?.value ?? null,
        };
      });
      const dateIso = body.querySelector('#ivDate').value;
      const row = inv ? { ...inv, lines, chambers } : {
        invoice_no: body.querySelector('#ivNo').value.trim() || `M-${dateIso.replace(/-/g, '')}-${body.querySelector('#ivTime').value.replace(':', '')}-${ttNo.slice(-4)}`,
        invoice_date: dateIso ? dateIso.split('-').reverse().join('/') : null,
        invoice_time: body.querySelector('#ivTime').value || null,
        tt_no: ttNo, lines, chambers, density15: null, seals: null, origin: null, amount: null, gmail_msg_id: null,
        source: 'manual', dismissed: false, note: null,
      };
      if (!inv && state.invoices.some((x) => x.invoice_no === row.invoice_no)) { toast('That invoice number is already in the list.'); return; }
      await saveInvoice(row);
      saveVehicle(ttNo, chambers, true);
      closeSheet();
      toast(inv ? 'Invoice updated.' : 'Invoice added.');
    };
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsSheet() {
  openSheet('Settings', (body) => {
    const s = state.settings;
    const c = state.chart;
    const issues = chartIssues(c);
    body.innerHTML = `
      <label class="f">Your name on this phone (saved with each decantation)<input type="text" id="stOp" value="${esc(state.device.operator || '')}" placeholder="optional"></label>
      <div class="sect-title" style="margin-top:16px">Tanks</div>
      ${s.tanks.map((t, i) => `<div class="grid3" style="margin-bottom:8px;align-items:end">
        <div class="pt-name" style="padding-bottom:10px">Tank ${t.no}</div>
        <label class="f">Product<select data-tp="${i}">${Object.values(PRODUCTS).map((p) => `<option value="${p.key}" ${t.product === p.key ? 'selected' : ''}>${p.name}</option>`).join('')}</select></label>
        <label class="f">Capacity (L)<input type="number" data-tc="${i}" value="${t.capacity}" inputmode="numeric"></label></div>`).join('')}
      <div class="sect-title" style="margin-top:16px">Checks</div>
      <div class="grid2">
        <label class="f">Variation is OK within (%)<input type="number" id="stTol" step="0.05" value="${s.tolerancePct}"></label>
        <label class="f">… or within (L), whichever is more<input type="number" id="stTolL" step="1" value="${s.toleranceMinL}"></label>
        <label class="f">Warn when a tank would have less room than (L)<input type="number" id="stWarn" step="10" value="${s.warnRoomL}"></label>
        <label class="f">A stock reading is old after (minutes)<input type="number" id="stStale" step="5" value="${s.staleMinutes}"></label>
        <label class="f">Wait after decanting before the after-stock (min)<input type="number" id="stSettle" step="1" value="${s.settleMinutes}"></label>
        <label class="f">Truck density vs invoice, OK within (± kg/m³)<input type="number" id="stDens" step="0.5" value="${s.densityLimit}"></label>
        <label class="f">Keep the log for (days)<input type="number" id="stKeep" step="1" min="7" max="120" value="${s.retentionDays}"></label>
        <label class="f">Show undecanted invoices from the last (days)<input type="number" id="stPend" step="1" min="1" value="${s.pendingDays}"></label>
      </div>
      <label class="f" style="margin-top:10px">The automation writes dates as
        <select id="stDate"><option value="MDY" ${s.dateOrder === 'MDY' ? 'selected' : ''}>MM/DD/YYYY (09/26/2026)</option><option value="DMY" ${s.dateOrder === 'DMY' ? 'selected' : ''}>DD/MM/YYYY (26/09/2026)</option></select></label>
      <div class="row-actions"><button class="cta" id="stSave">Save settings</button></div>
      <div class="hr"></div>
      <div class="sect-title">Dip chart</div>
      <div class="hint">${esc(c.name || '')}: ${c.litres.length.toLocaleString('en-IN')} readings, ${c.startCm}–${round2(chartMaxCm(c))} cm every ${c.stepCm} cm, up to ${fmtL(c.litres[c.litres.length - 1])}.
        ${c === DIP_CHART ? 'The chart\'s 143.2–143.9 cm rows (all 15,687.45 L in the sheet) were put back on the line between 143.1 and 144.0 cm.' : ''}
        ${issues.length ? `${issues.length} small step${issues.length === 1 ? '' : 's'} where the litres don't rise (${issues.map((i) => `${i.cm} cm`).join(', ')}).` : ''}</div>
      <div class="row-actions" style="justify-content:flex-start">
        <button class="btn" id="stCalc">📏 Dip ↔ litres</button>
        <button class="btn" id="stChart">⬆ Upload a chart (.xlsx / .csv)</button>
        ${c !== DIP_CHART ? '<button class="btn" id="stChartReset">Use the built-in chart</button>' : ''}
      </div>
      <div class="hr"></div>
      <div class="sect-title">This phone</div>
      <div class="hint">${cloudEnabled ? `Cloud: ${esc(state.cloud)}${state.outbox.length ? ` · ${state.outbox.length} change(s) waiting to be sent` : ''}.` : 'Cloud not set up — everything stays on this phone.'}</div>
      <div class="row-actions" style="justify-content:flex-start">
        <button class="btn" id="stRefresh">↻ Refresh from the cloud</button>
        <button class="btn danger" id="stClear">Clear this phone's copy</button>
      </div>`;
    body.querySelector('#stSave').onclick = async () => {
      const num = (id, lo, hi, dflt) => { const v = Number(body.querySelector(id).value); return Number.isFinite(v) && v >= lo && v <= hi ? v : dflt; };
      const tanksNew = s.tanks.map((t, i) => ({ ...t, product: body.querySelector(`[data-tp="${i}"]`).value, capacity: num(`[data-tc="${i}"]`, 1000, 100000, t.capacity) }));
      saveDevice({ operator: body.querySelector('#stOp').value.trim() });
      await saveConfig({
        settings: {
          ...(state.config.settings || {}), tanks: tanksNew,
          tolerancePct: num('#stTol', 0, 5, s.tolerancePct), toleranceMinL: num('#stTolL', 0, 1000, s.toleranceMinL),
          warnRoomL: num('#stWarn', 0, 5000, s.warnRoomL), staleMinutes: num('#stStale', 1, 1440, s.staleMinutes),
          settleMinutes: num('#stSettle', 0, 120, s.settleMinutes), densityLimit: num('#stDens', 0, 20, s.densityLimit),
          retentionDays: num('#stKeep', 7, 120, s.retentionDays), pendingDays: num('#stPend', 1, 60, s.pendingDays),
          dateOrder: body.querySelector('#stDate').value,
        },
      });
      closeSheet();
      toast('Settings saved.');
    };
    body.querySelector('#stCalc').onclick = () => dipCalculator();
    body.querySelector('#stChart').onclick = () => uploadChart();
    body.querySelector('#stChartReset')?.addEventListener('click', async () => { await saveConfig({ chart: null }); closeSheet(); toast('Using the built-in dip chart.'); });
    body.querySelector('#stRefresh').onclick = () => { refreshNow(); toast('Refreshing…'); };
    body.querySelector('#stClear').onclick = async () => {
      if (!(await ask('Clear this phone\'s copy?', `Everything synced to the cloud stays there and comes back on refresh.${state.outbox.length ? ` <b>${state.outbox.length} change(s) not yet sent will be lost.</b>` : ''}`, { ok: 'Clear', danger: true }))) return;
      await clearDevice();
      location.reload();
    };
  });
}

async function uploadChart() {
  const file = await pickFile('.xlsx,.xlsm,.xls,.csv,text/csv');
  if (!file) return;
  try {
    let rows;
    if (/\.csv$/i.test(file.name)) {
      rows = (await file.text()).split(/\r?\n/).map((l) => l.split(/[,;\t]/));
    } else {
      const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames.find((n) => /dip|stock/i.test(n)) || wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    }
    const chart = chartFromRows(rows, file.name);
    if (!(await ask('Use this dip chart?', `${esc(file.name)}: ${chart.litres.length} readings from ${chart.startCm} cm (${fmtL(chart.litres[0], 2)}) to ${round2(chartMaxCm(chart))} cm (${fmtL(chart.litres.at(-1), 2)}), every ${chart.stepCm} cm.
      ${chartIssues(chart).length ? `<br><br>${chartIssues(chart).length} row(s) where the litres don't rise — check the sheet.` : ''}`, { ok: 'Use it' }))) return;
    await saveConfig({ chart });
    toast('Dip chart updated on every phone.');
  } catch (e) {
    toast(`Couldn't read the chart: ${e.message || e}`, 5000);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  document.getElementById('view-home').addEventListener('click', onHomeClick);
  document.getElementById('btnStock').onclick = () => stockFlow();
  document.getElementById('btnRefresh').onclick = () => { refreshNow(); render(); toast('Refreshing…'); };
  document.getElementById('btnSettings').onclick = () => settingsSheet();
  try {
    const t = localStorage.getItem('vriddhi-decant-tab');
    if (['home', 'log', 'reports'].includes(t)) APP.tab = t;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === APP.tab));
  } catch { /* ignore */ }
  onChange(render);
  initStore().then(render);
  render();
  document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) render(); }, 0));
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(render, 200); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
