// The Monitor tab: the tank stock server's controls (tank_stock/phone.py), as
// on its own page over Tailscale (tank_stock/static/), in this order:
//   - Live monitoring: the picked tanks' volume as FuelTrans' live data brings
//     it (no interval to set) until Stop or 3 h;
//   - Pump monitor: the Pumps tab's monitoring of the ticked nozzles (live on
//     that tab, interlocks on Telegram) until Stop or 3 h; the nozzles to
//     tick are FuelTrans' own (config.pumpList, put there by the server);
//   - Capture now: Send for decantation (read the picked tanks, save each
//     one's stock and its card's picture for the result pictures), or
//     Capture only (show the picture and figures; "Upload these to decant"
//     then saves them).
// The requests wait in the shared settings (config.stockRequest for a read,
// config.stockMonitor and config.pumpMonitor for monitoring, apart so a read
// never stops them); the server looks every half minute and answers there,
// so every phone sees them.
// While decanting, "Let the tank stock server finish it" does this and more.

import { istDate } from './core.js';
import { cloudEnabled, newId, saveConfig, state } from './store.js';
import { cloudPicture } from './shots.js';
import { ago, confBadge, download, esc, fmtDip, fmtL, fmtTime, productChip, toast } from './ui.js';
import { tankName, tanks } from './app.js';

const LS = 'vriddhi-decant-monitor';      // this phone's picks: {capture: [ids], live: [ids], pumps: [nos]}
const STALE_MIN = 5;                       // no answer this long: is the server on?
const pics = new Map();                    // picture path -> object URL (this visit)
let bound = null;
let ticker = 0;

function picks() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { p = {}; }
  const ids = tanks().map((t) => t.id);
  const keep = (list) => (Array.isArray(list) ? list.filter((id) => ids.includes(id)) : ids);
  const nos = pumpList().map((n) => n.pump);
  const pumps = Array.isArray(p.pumps) ? p.pumps.filter((n) => nos.includes(n)) : [];
  return { capture: keep(p.capture), live: keep(p.live), pumps };
}
function savePicks(patch) {
  try { localStorage.setItem(LS, JSON.stringify({ ...picks(), ...patch })); } catch { /* private tab: this visit only */ }
}

const by = () => state.device?.operator || 'a phone';
const pumpList = () => (Array.isArray(state.config.pumpList) ? state.config.pumpList : []);
const pumpName = (n) => `Pump ${n.pump} · ${esc(n.product || '?')}${n.du != null ? ` · DU ${esc(n.du)}` : ''}`;
const today = (t) => t && istDate(t) === istDate(Date.now());

function chips(which, chosen, disabled) {
  return `<div class="chipset" role="group" aria-label="Tanks">${tanks().map((t) => `<button type="button" class="chipbtn${chosen.includes(t.id) ? ' on' : ''}"
      data-mpick="${which}" data-id="${t.id}" aria-pressed="${chosen.includes(t.id)}" ${disabled ? 'disabled' : ''}>Tank ${t.no} ${esc(t.product)}</button>`).join('')}</div>`;
}

// A request still waiting for the server: when it was asked, or that nothing answers.
function waiting(req, cancel) {
  const mins = (Date.now() - Date.parse(req.at || '')) / 60000;
  const what = { check: 'read and save', capture: 'capture', upload: 'upload', monitor: 'monitor', pumps: 'monitor', stop: 'stop' }[req.kind] || 'read';
  const names = req.kind === 'pumps' ? (req.pumps || []).map((n) => `Pump ${n}`) : req.kind === 'stop' ? ['the monitoring']
    : (req.tanks || []).map(tankName);
  return `${mins > STALE_MIN
    ? `<div class="banner" style="margin:8px 0 0">No answer from the tank stock server for ${Math.round(mins)} min — is the server on and the IOCL PC online?</div>`
    : `<div class="hint" style="margin-top:8px">Asked at ${fmtTime(req.at)} to ${what} ${names.join(', ')} — it looks every half minute, then ${req.kind === 'stop' ? 'stops it' : req.kind === 'monitor' || req.kind === 'pumps' ? 'connects in a few seconds' : 'takes about a minute for the pictures'}.</div>`}
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

// The server's live status (dec_live, store.js): monitoring on there however
// it was started, and the watched nozzles. While anything is on it writes at
// least every 30 s, so no word for STALE_S means the server isn't answering.
const STALE_S = 90;
const BY = { page: 'started on the Tank stock page', phone: 'started from the decant app', decantation: 'for the automatic decantation' };
function serverNow() {
  const s = state.serverLive;
  return s ? { ...s, age: (Date.now() - (Date.parse(s.at || '') || 0)) / 1000 } : null;
}
function staleNote(srv) {
  return srv && srv.age > STALE_S
    ? `<div class="banner" style="margin:8px 0 0">No word from the tank stock server for ${Math.round(srv.age / 60) || 1} min — what's shown may be old (is the server on and the IOCL PC online?).</div>` : '';
}
const idsOf = (nos) => (nos || []).map((no) => tanks().find((t) => t.no === no)?.id).filter(Boolean);
const tankRows = (ids) => ids.map((id) => { const r = state.tankState[id]; return `<div class="lrow" style="cursor:default"><span class="mid"><b>${esc(tankName(id))}</b></span><span class="rt"><b>${r ? fmtL(r.volume) : '—'}</b><span class="hint">${r ? ago(r.readingAt) : ''}</span></span></div>`; }).join('');
const clockOf = (secs) => { const m = Math.floor(secs / 60), x = Math.floor(secs % 60); return `${m}:${String(x).padStart(2, '0')}`; };
const rupees = (v) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function liveCard(p) {
  const mon = state.config.stockMonitor;
  const stopping = mon?.kind === 'stop' && !mon.state;
  const mine = mon?.kind === 'monitor' && (!mon.state || mon.state === 'monitoring');
  const srv = serverNow();
  const there = !mine && !stopping && srv?.tanks?.on ? srv.tanks : null;   // on at the server, started elsewhere
  const watched = mine ? mon.tanks || [] : there ? idsOf(there.watched) : [];
  const on = mine || Boolean(there);
  let status = '';
  if (mon && !mon.state) status = waiting(mon, 'stopLive');
  else if (mine) {
    status = `<div class="hint" style="margin-top:8px"><span class="badge watch live"><i>●</i>Monitoring</span> ${watched.map(tankName).join(', ')} ${mon.every ? `every ${mon.every} s` : 'live'}${mon.until ? `, until ${fmtTime(mon.until)}` : ''}.</div>${tankRows(watched)}`;
  } else if (there) {
    const sending = idsOf(there.sending);
    status = `<div class="hint" style="margin-top:8px"><span class="badge watch live"><i>●</i>Monitoring</span> ${watched.map(tankName).join(', ')} live, ${BY[there.by] || 'on the server'}${there.state === 'connecting' ? ' (connecting)' : ''}.${sending.length ? '' : ' It isn\'t sending to the app, so the tiles keep their last stock.'}</div>${tankRows(sending)}`;
  } else if (mon?.state === 'error') {
    status = `<div class="banner bad" style="margin:8px 0 0">${mon.kind === 'stop' ? 'It couldn\'t be stopped' : 'Monitoring couldn\'t start'}: ${esc(mon.message || 'no reason given')}.</div>`;
  } else if (mon?.state === 'ended') {
    status = `<div class="banner" style="margin:8px 0 0">Monitoring ended: ${esc(mon.message || 'no reason given')}.</div>`;
  }
  if (on) status += staleNote(srv);
  const stop = mine ? '<button class="btn sm" data-m="stopLive">■ Stop</button>'
    : there?.decantation ? '<div class="hint">An automatic decantation runs on it: it stops when that is done.</div>'
      : '<button class="btn sm" data-m="stopAnyLive">■ Stop</button>';
  return `<h2>Live monitoring</h2><div class="card">
      <div class="hint">The tank stock server follows FuelTrans' live data and sends these tanks' volume to the app as it changes, until you stop it or 3 hours pass. The tank tiles on the Decant tab follow it.</div>
      <div class="hint" style="margin:10px 0 6px">Tanks to watch</div>
      ${chips('live', on ? watched : p.live, on || stopping)}
      <div class="row-actions" style="justify-content:flex-start">
        ${on ? stop : `<button class="cta sm" data-m="startLive" ${p.live.length && !stopping ? '' : 'disabled'}>▶ Start live monitoring</button>`}</div>
      ${status}
    </div>`;
}

// One watched nozzle, as the server last wrote it (the fuelling time counts here).
function nozzleTile(n) {
  const fuel = n.status === 'FUELING';
  const secs = fuel && n.since ? Math.max(0, (Date.now() - Date.parse(n.since)) / 1000) : null;
  const locks = n.locks || [];
  const preset = n.target_litres ? `Preset ${n.preset?.kind === 'amount' ? rupees(n.preset.value) : fmtL(n.preset?.value ?? n.target_litres, 2)}`
    + `${n.progress != null ? ` · ${Math.round(n.progress * 100)}%` : ''}${n.left_s != null ? ` · ${clockOf(n.left_s)} left` : ''}` : '';
  return `<div class="card" style="margin:8px 0 0;padding:10px 12px">
      <div class="rd-head"><span class="nm">${pumpName(n)}</span>
        <span class="badge ${locks.length ? 'high' : fuel ? 'watch live' : ''}"><i>${locks.length ? '!' : fuel ? '●' : '·'}</i>${esc(n.status || '—')}</span></div>
      <div class="kv">
        <div><div class="k">${fuel ? 'Litres' : 'Last sale'}</div><div class="v big">${n.litres != null ? fmtL(n.litres, 2) : '—'}</div></div>
        <div><div class="k">Amount</div><div class="v">${n.amount != null ? rupees(n.amount) : '—'}</div></div>
        <div><div class="k">Flow</div><div class="v">${n.lpm != null ? `${n.lpm} L/min` : n.usual_lpm ? `usually ${n.usual_lpm} L/min` : '—'}</div></div>
        <div><div class="k">Fuelling for</div><div class="v">${secs != null ? clockOf(secs) : '—'}</div></div></div>
      ${preset ? `<div class="hint" style="margin-top:6px">${preset}</div>` : ''}
      ${locks.length ? `<div class="banner bad" style="margin:6px 0 0">🔒 ${locks.map(esc).join(', ')}</div>` : ''}
    </div>`;
}

function pumpCard(p) {
  const mon = state.config.pumpMonitor;
  const stopping = mon?.kind === 'stop' && !mon.state;
  const mine = mon?.kind === 'pumps' && (!mon.state || mon.state === 'monitoring');
  const srv = serverNow();
  const live = !stopping && srv?.pumps?.on ? srv.pumps : null;             // on at the server, however started
  const on = mine || Boolean(live);
  const list = pumpList();
  const chosen = mine ? (mon.pumps || []) : live ? (live.watch || []) : p.pumps;
  let status = '';
  if (mon && !mon.state) status = waiting(mon, 'stopPumps');
  else if (live) {
    status = `<div class="hint" style="margin-top:8px"><span class="badge watch live"><i>●</i>Monitoring</span> ${(live.watch || []).map((n) => `Pump ${n}`).join(', ')} live, ${mine ? `${BY.phone}${mon.until ? `, until ${fmtTime(mon.until)}` : ''}` : BY[live.by] || 'on the server'}. An interlock coming on or clearing also comes on Telegram.</div>
      ${live.stale ? `<div class="banner" style="margin:8px 0 0">FuelTrans' live data has gone quiet${live.error ? ` (${esc(live.error)})` : ''}: the figures may be old.</div>` : ''}
      ${(live.nozzles || []).map(nozzleTile).join('')}`;
  } else if (mine) {
    status = `<div class="hint" style="margin-top:8px"><span class="badge watch live"><i>●</i>Monitoring</span> ${(mon.pumps || []).map((n) => `Pump ${n}`).join(', ')}${mon.until ? `, until ${fmtTime(mon.until)}` : ''}. The nozzles' figures show here as the server sends them.</div>`;
  } else if (mon?.state === 'error') {
    status = `<div class="banner bad" style="margin:8px 0 0">${mon.kind === 'stop' ? 'It couldn\'t be stopped' : 'The pump monitor couldn\'t start'}: ${esc(mon.message || 'no reason given')}.</div>`;
  } else if (mon?.state === 'ended') {
    status = `<div class="banner" style="margin:8px 0 0">Pump monitor ended: ${esc(mon.message || 'no reason given')}.</div>`;
  }
  if (on) status += staleNote(srv);
  return `<h2>Pump monitor</h2><div class="card">
      <div class="hint">The tank stock server follows the ticked nozzles live from FuelTrans, as the Pumps tab of the Vriddhi Fuels app does, until you stop it or 3 hours pass.</div>
      <div class="hint" style="margin:10px 0 6px">Nozzles to watch</div>
      ${list.length ? `<div class="chipset" role="group" aria-label="Pumps">${list.map((n) => `<button type="button" class="chipbtn${chosen.includes(n.pump) ? ' on' : ''}"
          data-mpump="${n.pump}" aria-pressed="${chosen.includes(n.pump)}" ${on || stopping ? 'disabled' : ''}>${pumpName(n)}</button>`).join('')}</div>`
        : '<div class="hint">The pumps come from FuelTrans through the tank stock server: they show here within half a minute of it being on.</div>'}
      <div class="row-actions" style="justify-content:flex-start">
        ${on ? `<button class="btn sm" data-m="${mine ? 'stopPumps' : 'stopAnyPumps'}">■ Stop</button>`
          : `<button class="cta sm" data-m="startPumps" ${p.pumps.length && !stopping ? '' : 'disabled'}>▶ Start pump monitor</button>`}</div>
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
  el.innerHTML = `${liveCard(p)}${pumpCard(p)}${captureCard(p)}${lastCard()}
    <div class="hint" style="margin:14px 4px">For a whole decantation run by the tank stock server: "🤖 Start automatic decantation" on its Plan step, or "Let the tank stock server finish it" on its decanting screen.</div>`;
  for (const img of el.querySelectorAll('[data-mimg]')) showPicture(img, img.dataset.mimg);
  // while monitoring is on: a nozzle's fuelling time counts, and a silent server shows
  clearTimeout(ticker);
  const srv = state.serverLive;
  if (srv?.tanks?.on || srv?.pumps?.on) {
    const fueling = (srv.pumps?.nozzles || []).some((n) => n.since);
    ticker = setTimeout(() => { if (el.isConnected && !el.hidden) renderMonitor(el); }, fueling ? 1000 : 15000);
  }
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
    const pump = t.closest('[data-mpump]');
    if (pump) {
      const no = Number(pump.dataset.mpump);
      const cur = picks().pumps;
      savePicks({ pumps: cur.includes(no) ? cur.filter((x) => x !== no) : [...cur, no] });
      renderMonitor(el);
      return;
    }
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
      await ask('stockMonitor', { kind: 'monitor', tanks: p.live });
      return;
    }
    if (act === 'stopLive') { await ask('stockMonitor', null); return; }
    if (act === 'stopAnyLive') { await ask('stockMonitor', { kind: 'stop' }); return; }     // (started elsewhere)
    if (act === 'stopAnyPumps') { await ask('pumpMonitor', { kind: 'stop' }); return; }
    if (act === 'startPumps') { await ask('pumpMonitor', { kind: 'pumps', pumps: p.pumps }); return; }
    if (act === 'stopPumps') await ask('pumpMonitor', null);
  });
}
