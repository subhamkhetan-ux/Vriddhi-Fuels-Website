// The Monitor tab: the tank stock server's controls (tank_stock/phone.py), as
// on its own page over Tailscale (tank_stock/static/) — pick the tanks, then
//   - Send for decantation: read them, save each one's stock and its card's
//     picture (for the result pictures);
//   - Capture only: read them and show the picture and figures, nothing saved;
//     "Upload these to decant" then saves them;
//   - Live monitoring: their volume every N seconds (5-3600) until Stop or 3 h.
// The requests wait in the shared settings (config.stockRequest for a read,
// config.stockMonitor for monitoring, apart so a read never stops it); the
// server looks every half minute and answers there, so every phone sees them.
// While decanting, "Let the tank stock server finish it" does this and more.

import { istDate } from './core.js';
import { cloudEnabled, newId, saveConfig, state } from './store.js';
import { cloudPicture } from './shots.js';
import { ago, confBadge, download, esc, fmtDip, fmtL, fmtTime, productChip, toast } from './ui.js';
import { tankName, tanks } from './app.js';

const LS = 'vriddhi-decant-monitor';      // this phone's picks: {capture: [ids], live: [ids], every}
const STALE_MIN = 5;                       // no answer this long: is the server on?
const EVERY = [5, 3600];
const pics = new Map();                    // picture path -> object URL (this visit)
let bound = null;

function picks() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { p = {}; }
  const ids = tanks().map((t) => t.id);
  const keep = (list) => (Array.isArray(list) ? list.filter((id) => ids.includes(id)) : ids);
  return { capture: keep(p.capture), live: keep(p.live), every: Number(p.every) || 10 };
}
function savePicks(patch) {
  try { localStorage.setItem(LS, JSON.stringify({ ...picks(), ...patch })); } catch { /* private tab: this visit only */ }
}

const by = () => state.device?.operator || 'a phone';
const today = (t) => t && istDate(t) === istDate(Date.now());

function chips(which, chosen, disabled) {
  return `<div class="chipset" role="group" aria-label="Tanks">${tanks().map((t) => `<button type="button" class="chipbtn${chosen.includes(t.id) ? ' on' : ''}"
      data-mpick="${which}" data-id="${t.id}" aria-pressed="${chosen.includes(t.id)}" ${disabled ? 'disabled' : ''}>Tank ${t.no} ${esc(t.product)}</button>`).join('')}</div>`;
}

// A request still waiting for the server: when it was asked, or that nothing answers.
function waiting(req, cancel) {
  const mins = (Date.now() - Date.parse(req.at || '')) / 60000;
  const what = { check: 'read and save', capture: 'capture', upload: 'upload', monitor: 'monitor' }[req.kind] || 'read';
  return `${mins > STALE_MIN
    ? `<div class="banner" style="margin:8px 0 0">No answer from the tank stock server for ${Math.round(mins)} min — is the Mac on and online?</div>`
    : `<div class="hint" style="margin-top:8px">Asked at ${fmtTime(req.at)} to ${what} ${(req.tanks || []).map(tankName).join(', ')} — it looks every half minute, then takes about a minute to connect.</div>`}
    <div class="row-actions" style="justify-content:flex-start"><button class="btn sm ghost" data-m="${cancel}">Cancel</button></div>`;
}

function captureCard(p) {
  const req = state.config.stockRequest;
  const busy = req && !req.state;
  return `<h2>Capture now</h2><div class="card">
      ${chips('capture', p.capture, busy)}
      <div class="row-actions" style="justify-content:flex-start">
        <button class="cta sm" data-m="check" ${busy || !p.capture.length ? 'disabled' : ''}>📡 Send for decantation</button>
        <button class="btn sm" data-m="capture" ${busy || !p.capture.length ? 'disabled' : ''}>📷 Capture only</button></div>
      <div class="hint">Send for decantation reads these tanks and saves each one's stock, with its card's picture for the result pictures. Capture only shows them first; nothing is saved until you upload.</div>
      ${busy ? waiting(req, 'cancelRead') : ''}
      ${req?.state === 'error' ? `<div class="banner bad" style="margin:8px 0 0">The tank stock server couldn't ${req.kind === 'upload' ? 'upload' : 'read'} the tanks: ${esc(req.message || 'no reason given')}.</div>` : ''}
    </div>`;
}

function figureRow(id, f, saved) {
  const t = tanks().find((x) => x.id === id);
  const prob = (f.problems || []).filter(Boolean);
  return `<div class="card" style="margin:8px 0 0;padding:10px 12px">
      <div class="rd-head"><span class="nm">${esc(tankName(id))}</span>${t ? productChip(t.product) : ''}${f.confidence ? confBadge(f.confidence) : ''}
        ${saved ? `<span class="badge ${saved.ok ? 'ok' : 'high'}"><i>${saved.ok ? '✓' : '!'}</i>${saved.ok ? 'Saved' : 'Not saved'}</span>` : ''}</div>
      ${f.volume != null ? `<div class="kv">
        <div><div class="k">Stock</div><div class="v big">${fmtL(f.volume, 2)}</div></div>
        <div><div class="k">Dip</div><div class="v">${f.dip != null ? fmtDip(f.dip) : '—'}</div></div>
        <div><div class="k">Ullage</div><div class="v">${f.ullage != null ? fmtL(f.ullage, 2) : '—'}</div></div>
        <div><div class="k">Water</div><div class="v">${f.water != null ? fmtL(f.water, 2) : '—'}</div></div>
        <div><div class="k">Temp</div><div class="v">${f.temp ?? '—'}${f.temp != null ? ' °C' : ''}</div></div>
        <div><div class="k">Density (tc)</div><div class="v">${f.densityTc ?? '—'}</div></div></div>
        ${f.readingAt ? `<div class="rd-src">automation time ${fmtTime(f.readingAt)}</div>` : ''}` : ''}
      ${saved && !saved.ok ? `<div class="hint" style="margin-top:6px">${esc(saved.message)}</div>` : prob.length ? `<div class="hint" style="margin-top:6px">⚠ ${prob.map(esc).join(' · ')}</div>` : ''}
    </div>`;
}

function lastCard() {
  const req = state.config.stockRequest;
  if (!req || req.state !== 'done' || !today(req.answeredAt) || !(req.figures || req.image)) return '';
  const saved = req.kind === 'check' || req.kind === 'upload';
  const ids = Object.keys(req.figures || {});
  return `<h2>Last capture <span class="count">${fmtTime(req.capturedAt || req.answeredAt)}</span></h2><div class="card">
      <div class="hint">${saved ? `Saved to the app${req.picture === true ? ', with the pictures for the result' : ''}.` : 'Not saved yet.'} Captured ${ago(req.capturedAt || req.answeredAt)}.</div>
      ${req.pictureError ? `<div class="banner" style="margin:8px 0 0">The readings are saved, but the pictures weren't: ${esc(req.pictureError)}.</div>` : ''}
      ${req.image ? `<img class="mshot" data-mimg="${esc(req.image)}" alt="The tanks' cards on the automation screen" style="width:100%;border-radius:10px;margin-top:8px;background:var(--glass-2);min-height:80px">`
        : req.imageError ? `<div class="hint" style="margin-top:8px">No picture: ${esc(req.imageError)}.</div>` : ''}
      ${ids.map((id) => figureRow(id, req.figures[id], saved ? (req.results || {})[id] : null)).join('')}
      <div class="row-actions" style="justify-content:flex-start">
        ${req.kind === 'capture' && ids.length ? '<button class="cta sm" data-m="upload">⬆ Upload these to decant</button>' : ''}
        ${req.image ? '<button class="btn sm" data-m="saveImage">⤓ Save image</button>' : ''}</div>
    </div>`;
}

function liveCard(p) {
  const mon = state.config.stockMonitor;
  const on = mon && (!mon.state || mon.state === 'monitoring');
  const watched = on ? mon.tanks || [] : [];
  let status = '';
  if (mon && !mon.state) status = waiting(mon, 'stopLive');
  else if (mon?.state === 'monitoring') {
    status = `<div class="hint" style="margin-top:8px"><span class="badge watch live"><i>●</i>Monitoring</span> ${watched.map(tankName).join(', ')} every ${mon.every || 10} s${mon.until ? `, until ${fmtTime(mon.until)}` : ''}.</div>
      ${watched.map((id) => { const r = state.tankState[id]; return `<div class="lrow" style="cursor:default"><span class="mid"><b>${esc(tankName(id))}</b></span><span class="rt"><b>${r ? fmtL(r.volume) : '—'}</b><span class="hint">${r ? ago(r.readingAt) : ''}</span></span></div>`; }).join('')}`;
  } else if (mon?.state === 'ended' || mon?.state === 'error') {
    status = `<div class="banner ${mon.state === 'error' ? 'bad' : ''}" style="margin:8px 0 0">${mon.state === 'error' ? 'Monitoring couldn\'t start' : 'Monitoring ended'}: ${esc(mon.message || 'no reason given')}.</div>`;
  }
  return `<h2>Live monitoring</h2><div class="card">
      <div class="hint">Keeps one AnyDesk session open and sends these tanks' volume to the app every few seconds, until you stop it or 3 hours pass. The tank tiles on the Decant tab follow it.</div>
      <label class="f" style="margin-top:10px">Read every (seconds)<input type="number" inputmode="numeric" min="${EVERY[0]}" max="${EVERY[1]}" step="1" data-mevery value="${on ? mon.every || p.every : p.every}" ${on ? 'disabled' : ''}></label>
      <div class="hint" style="margin:10px 0 6px">Tanks to watch</div>
      ${chips('live', on ? watched : p.live, on)}
      <div class="row-actions" style="justify-content:flex-start">
        ${on ? '<button class="btn sm" data-m="stopLive">■ Stop</button>' : `<button class="cta sm" data-m="startLive" ${p.live.length ? '' : 'disabled'}>▶ Start live monitoring</button>`}</div>
      ${status}
    </div>`;
}

export function renderMonitor(el) {
  if (bound !== el) { bind(el); bound = el; }
  if (!cloudEnabled) {
    el.innerHTML = '<div class="empty">The tank stock server reaches this app through the cloud: set decant/config.js up first.</div>';
    return;
  }
  const p = picks();
  el.innerHTML = `${captureCard(p)}${lastCard()}${liveCard(p)}
    <div class="hint" style="margin:14px 4px">While a tanker is decanting, "Let the tank stock server finish it" on its decanting screen follows the tanks itself.</div>`;
  for (const img of el.querySelectorAll('[data-mimg]')) showPicture(img, img.dataset.mimg);
}

async function blobOf(path) {
  const blob = await cloudPicture(path);
  if (blob && !pics.has(path)) pics.set(path, URL.createObjectURL(blob));
  return blob;
}
async function showPicture(img, path) {
  if (!pics.has(path)) await blobOf(path);
  if (pics.has(path)) img.src = pics.get(path);
  else img.replaceWith(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'The picture couldn\'t be loaded (it is kept for today only).' }));
}

const ask = (slot, req) => saveConfig({ [slot]: req ? { id: newId('R'), at: new Date().toISOString(), by: by(), ...req } : null });

function bind(el) {
  el.addEventListener('click', async (e) => {
    const t = e.target;
    const chip = t.closest('[data-mpick]');
    if (chip) {
      const which = chip.dataset.mpick;
      const cur = picks()[which];
      const id = chip.dataset.id;
      savePicks({ [which]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
      renderMonitor(el);
      return;
    }
    const act = t.closest('[data-m]')?.dataset.m;
    if (!act) return;
    const p = picks();
    const req = state.config.stockRequest;
    if (act === 'check' || act === 'capture') { await ask('stockRequest', { kind: act, tanks: p.capture }); return; }
    if (act === 'upload') {
      // the capture's figures and picture stay shown while it uploads
      await ask('stockRequest', { kind: 'upload', of: req.capturedAt, tanks: Object.keys(req.figures || {}),
        capturedAt: req.capturedAt, figures: req.figures, image: req.image });
      return;
    }
    if (act === 'cancelRead') { await ask('stockRequest', null); return; }
    if (act === 'saveImage') {
      const blob = await blobOf(req.image);
      if (blob) download(blob, `tank-stock-${istDate(req.capturedAt || Date.now())}-${fmtTime(req.capturedAt).replace(':', '')}.jpg`);
      else toast('The picture couldn\'t be loaded.');
      return;
    }
    if (act === 'startLive') {
      const every = Math.round(Number(el.querySelector('[data-mevery]')?.value) || 10);
      if (every < EVERY[0] || every > EVERY[1]) { toast(`Read every ${EVERY[0]}–${EVERY[1]} seconds.`); return; }
      savePicks({ every });
      await ask('stockMonitor', { kind: 'monitor', tanks: p.live, every });
      return;
    }
    if (act === 'stopLive') await ask('stockMonitor', null);
  });
}
