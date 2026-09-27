// The decanting app's data: kept on the phone first (so a weak signal at the
// forecourt never loses a decantation) and mirrored to Supabase — the same
// project as the payments app, whose agent fills dec_invoices from mail.
//
// Local: localStorage for the records, IndexedDB for the screenshots.
// Cloud: dec_* tables (supabase/decant-schema.sql). Every write goes to the
// phone at once and to the cloud with retries; a write that can't reach the
// cloud waits in an outbox and is sent when the connection is back.

import { DIP_CHART } from './dipchart.js';
import { settingsWith } from './core.js';

const CFG = window.VRIDDHI_DECANT_CONFIG || {};
const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';
const LS_KEY = 'vriddhi-decant-v1';
const DEVICE_KEY = 'vriddhi-decant-device';
const DAY = 86400000;

export const state = {
  cloud: 'off',           // off | connecting | live | offline
  cloudError: '',
  invoices: [],           // dec_invoices rows
  sessions: [],           // dec_sessions rows ({id, invoice_no, tt_no, status, data, …})
  vehicles: {},           // tt_no -> {tt_no, chambers, note}
  tankState: {},          // tank id -> latest reading
  config: {},             // dec_config.data (settings + optional uploaded chart)
  settings: settingsWith(null),
  chart: DIP_CHART,
  outbox: [],             // [{table, key}] writes still to reach the cloud
  device: { operator: '' },
};

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let emitTimer = null;
function emit() {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => { for (const fn of listeners) fn(); }, 30);
}

export const cloudEnabled = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY
  && !/PASTE_/.test(CFG.SUPABASE_URL) && !/PASTE_/.test(CFG.SUPABASE_ANON_KEY));

// ---------------------------------------------------------------------------
// Local copy
// ---------------------------------------------------------------------------

function applyConfig() {
  state.settings = settingsWith(state.config?.settings);
  const c = state.config?.chart;
  state.chart = c?.litres?.length ? c : DIP_CHART;
}

function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    state.invoices = raw.invoices || [];
    state.sessions = raw.sessions || [];
    state.vehicles = raw.vehicles || {};
    state.tankState = raw.tankState || {};
    state.config = raw.config || {};
    state.outbox = raw.outbox || [];
  } catch { /* a fresh start */ }
  try { state.device = { operator: '', ...JSON.parse(localStorage.getItem(DEVICE_KEY) || '{}') }; } catch { /* ignore */ }
  applyConfig();
}

let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        invoices: state.invoices, sessions: state.sessions, vehicles: state.vehicles,
        tankState: state.tankState, config: state.config, outbox: state.outbox,
      }));
    } catch { /* storage full or blocked — the cloud still has it */ }
  }, 50);
}

export function saveDevice(patch) {
  state.device = { ...state.device, ...patch };
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(state.device)); } catch { /* ignore */ }
  emit();
}

// Screenshots live in IndexedDB (too big for localStorage).
let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('vriddhi-decant', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', mode);
    const req = fn(tx.objectStore('photos'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

let client = null;

function setCloud(s, err = '') {
  state.cloud = s;
  state.cloudError = err;
  emit();
}

const TABLES = {
  dec_invoices: { key: 'invoice_no', list: () => state.invoices },
  dec_sessions: { key: 'id', list: () => state.sessions },
  dec_vehicles: { key: 'tt_no', list: () => Object.values(state.vehicles) },
  dec_tank_state: { key: 'tank_id', list: () => Object.entries(state.tankState).map(([tank_id, reading]) => ({ tank_id, reading, updated_at: reading?.savedAt })) },
  dec_config: { key: 'id', list: () => [{ id: 1, data: state.config, updated_at: state.config?.updatedAt }] },
};

function rowFor(table, key) {
  const t = TABLES[table];
  const row = t.list().find((r) => String(r[t.key]) === String(key));
  if (!row) return null;
  if (table === 'dec_sessions') {
    const { id, invoice_no, tt_no, status, data, created_at, updated_at, completed_at } = row;
    return { id, invoice_no, tt_no, status, data, created_at, updated_at, completed_at: completed_at || null };
  }
  if (table === 'dec_invoices') {
    const rest = { ...row };
    delete rest._local;                    // this phone's "not sent yet" marker
    return rest;
  }
  return row;
}

async function withRetry(run) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { error } = await run();
      if (!error) return null;
      last = error;
    } catch (e) { last = e; }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 700));
  }
  return last;
}

function queue(table, key) {
  if (!state.outbox.some((o) => o.table === table && String(o.key) === String(key))) state.outbox.push({ table, key: String(key) });
  saveLocal();
}

async function push(table, key) {
  if (!client) { queue(table, key); return false; }
  let err;
  if (table === 'dec_photos') {
    const p = await idbDo('readonly', (s) => s.get(key)).catch(() => null);
    if (!p) return true;
    err = await withRetry(() => client.from('dec_photos').upsert({
      id: p.id, session_id: p.session_id || null, kind: p.kind, data_url: p.data_url, meta: p.meta || {}, created_at: p.created_at,
    }, { onConflict: 'id' }));
  } else if (table === 'dec_sessions_delete') {
    err = await withRetry(() => client.from('dec_sessions').delete().eq('id', key));
    if (!err) await withRetry(() => client.from('dec_photos').delete().eq('session_id', key));
  } else {
    const row = rowFor(table, key);
    if (!row) return true;
    err = await withRetry(() => client.from(table).upsert(row, { onConflict: TABLES[table].key }));
  }
  if (err) {
    queue(table, key);
    setCloud('offline', err.message || String(err));
    return false;
  }
  state.outbox = state.outbox.filter((o) => !(o.table === table && String(o.key) === String(key)));
  saveLocal();
  return true;
}

let flushing = false;
export async function flushOutbox() {
  if (!client || flushing || !state.outbox.length) return;
  flushing = true;
  try {
    for (const o of [...state.outbox]) {
      const ok = await push(o.table, o.key);
      if (!ok) break;
    }
    if (!state.outbox.length && state.cloud === 'offline') setCloud('live');
  } finally {
    flushing = false;
  }
}

function pending(table, key) {
  return state.outbox.some((o) => o.table === table && String(o.key) === String(key));
}

// Cloud rows win, except ones this phone changed and hasn't sent yet (or has
// changed more recently).
function mergeRows(table, local, remote, keyOf) {
  const byKey = new Map(remote.map((r) => [String(keyOf(r)), r]));
  for (const l of local) {
    const k = String(keyOf(l));
    const r = byKey.get(k);
    if (pending(table, k) || (r && l.updated_at && r.updated_at && Date.parse(l.updated_at) > Date.parse(r.updated_at))) {
      byKey.set(k, l);
    } else if (!r && l._local) {
      byKey.set(k, l);                                     // made offline, never sent
    }
  }
  return [...byKey.values()];
}

async function pull(which = 'all') {
  if (!client) return;
  try {
    const since = new Date(Date.now() - 60 * DAY).toISOString();
    const jobs = [];
    if (which === 'all' || which === 'dec_invoices') {
      jobs.push(client.from('dec_invoices').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(600)
        .then(({ data, error }) => {
          if (error) throw error;
          state.invoices = mergeRows('dec_invoices', state.invoices, data || [], (r) => r.invoice_no);
        }));
    }
    if (which === 'all' || which === 'dec_sessions') {
      jobs.push(client.from('dec_sessions').select('*').order('created_at', { ascending: false }).limit(2000)
        .then(({ data, error }) => {
          if (error) throw error;
          state.sessions = mergeRows('dec_sessions', state.sessions, data || [], (r) => r.id);
        }));
    }
    if (which === 'all' || which === 'dec_vehicles') {
      jobs.push(client.from('dec_vehicles').select('*').then(({ data, error }) => {
        if (error) throw error;
        const merged = mergeRows('dec_vehicles', Object.values(state.vehicles), data || [], (r) => r.tt_no);
        state.vehicles = Object.fromEntries(merged.map((v) => [v.tt_no, v]));
      }));
    }
    if (which === 'all' || which === 'dec_tank_state') {
      jobs.push(client.from('dec_tank_state').select('*').then(({ data, error }) => {
        if (error) throw error;
        for (const r of data || []) {
          const cur = state.tankState[r.tank_id];
          if (!pending('dec_tank_state', r.tank_id) && (!cur || newer(r.reading, cur))) state.tankState[r.tank_id] = r.reading;
        }
      }));
    }
    if (which === 'all' || which === 'dec_config') {
      jobs.push(client.from('dec_config').select('data,updated_at').eq('id', 1).maybeSingle().then(({ data, error }) => {
        if (error) throw error;
        if (data?.data && !pending('dec_config', 1)) {
          state.config = data.data;
          applyConfig();
        }
      }));
    }
    await Promise.all(jobs);
    setCloud('live');
    saveLocal();
    learnVehicles();
  } catch (e) {
    const msg = e?.message || String(e);
    setCloud('offline', /dec_\w+|relation|schema cache|does not exist/i.test(msg)
      ? 'The decanting tables are missing — run supabase/decant-schema.sql in the Supabase SQL editor.'
      : msg);
  }
}

function newer(a, b) {
  const ta = Date.parse(a?.readingAt || a?.savedAt || 0) || 0;
  const tb = Date.parse(b?.readingAt || b?.savedAt || 0) || 0;
  return ta > tb || (ta === tb && (Date.parse(a?.savedAt || 0) || 0) > (Date.parse(b?.savedAt || 0) || 0));
}

function subscribe() {
  if (!client?.channel) return;
  const timers = {};
  const poke = (t) => { clearTimeout(timers[t]); timers[t] = setTimeout(() => pull(t), 400); };
  let ch = client.channel('decant-live');
  for (const t of ['dec_invoices', 'dec_sessions', 'dec_vehicles', 'dec_tank_state', 'dec_config']) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => poke(t));
  }
  ch.subscribe();
}

export async function initStore() {
  loadLocal();
  purgeLocal();
  emit();
  if (!cloudEnabled) { setCloud('off'); return; }
  setCloud('connecting');
  try {
    const { createClient } = await import(SUPABASE_JS);
    client = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'vriddhi-decant' } });
    Promise.resolve(client.rpc('dec_purge_old')).catch(() => {});
    await pull();
    subscribe();
    await flushOutbox();
  } catch (e) {
    setCloud('offline', e?.message || String(e));
  }
  window.addEventListener('online', () => { pull(); flushOutbox(); });
  setInterval(() => { if (state.outbox.length) flushOutbox(); }, 30000);
  let last = 0;
  const refresh = () => {
    if (Date.now() - last < 2000) return;
    last = Date.now();
    pull();
    flushOutbox();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('focus', refresh);
}

export function refreshNow() {
  if (client) { pull(); flushOutbox(); }
}

// Finished decantations and old photos drop off after the log's retention.
function purgeLocal() {
  const keep = (state.settings.retentionDays || 31) * DAY;
  const cutoff = Date.now() - keep;
  state.sessions = state.sessions.filter((s) => !['done', 'cancelled'].includes(s.status)
    || Date.parse(s.completed_at || s.updated_at || s.created_at) >= cutoff);
  state.invoices = state.invoices.filter((i) => Date.parse(i.created_at || 0) >= cutoff - 14 * DAY
    || state.sessions.some((s) => s.invoice_no === i.invoice_no && !['done', 'cancelled'].includes(s.status)));
  saveLocal();
  idbDo('readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (Date.parse(c.value.created_at || 0) < cutoff && !state.sessions.some((x) => x.id === c.value.session_id)) c.delete();
      c.continue();
    };
    return req;
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

export function newId(prefix) {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

export async function saveSession(s) {
  s.updated_at = nowIso();
  s.created_at = s.created_at || s.updated_at;
  const i = state.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) state.sessions[i] = s; else state.sessions.unshift(s);
  saveLocal();
  emit();
  return push('dec_sessions', s.id);
}

export async function deleteSession(id) {
  state.sessions = state.sessions.filter((x) => x.id !== id);
  state.outbox = state.outbox.filter((o) => !(o.table === 'dec_sessions' && o.key === id));
  saveLocal();
  emit();
  idbDo('readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (c.value.session_id === id) c.delete();
      c.continue();
    };
    return req;
  }).catch(() => {});
  return push('dec_sessions_delete', id);
}

export async function saveInvoice(inv) {
  inv.updated_at = nowIso();
  inv.created_at = inv.created_at || inv.updated_at;
  if (!client) inv._local = true;
  const i = state.invoices.findIndex((x) => x.invoice_no === inv.invoice_no);
  if (i >= 0) state.invoices[i] = inv; else state.invoices.unshift(inv);
  saveLocal();
  emit();
  if (inv.chambers?.length && inv.tt_no) saveVehicle(inv.tt_no, inv.chambers, true);
  return push('dec_invoices', inv.invoice_no);
}

export async function saveVehicle(tt, chambers, onlyIfChanged = false) {
  const cur = state.vehicles[tt];
  const clean = chambers.map((c) => ({ no: Number(c.no), qty_kl: Number(c.qty_kl), dip_cm: c.dip_cm ?? null, pl_cm: c.pl_cm ?? null }));
  if (onlyIfChanged && cur && JSON.stringify(cur.chambers) === JSON.stringify(clean)) return true;
  state.vehicles[tt] = { ...(cur || {}), tt_no: tt, chambers: clean, updated_at: nowIso() };
  saveLocal();
  emit();
  return push('dec_vehicles', tt);
}

// Trucks' chamber layouts, learned from every invoice that carried a table.
function learnVehicles() {
  const latest = {};
  for (const inv of state.invoices) {
    if (!inv.tt_no || !inv.chambers?.length) continue;
    if (!latest[inv.tt_no] || (inv.created_at || '') > (latest[inv.tt_no].created_at || '')) latest[inv.tt_no] = inv;
  }
  for (const [tt, inv] of Object.entries(latest)) {
    if (!state.vehicles[tt]) saveVehicle(tt, inv.chambers, true);
  }
}

export async function saveTankReading(tankId, reading) {
  const r = { ...reading, savedAt: nowIso() };
  const cur = state.tankState[tankId];
  if (cur && !newer(r, cur)) return true;                   // keep the newer stock
  state.tankState[tankId] = r;
  saveLocal();
  emit();
  return push('dec_tank_state', tankId);
}

export async function saveConfig(patch) {
  state.config = { ...state.config, ...patch, updatedAt: nowIso() };
  applyConfig();
  saveLocal();
  emit();
  return push('dec_config', 1);
}

export async function savePhoto({ id, session_id = null, kind, data_url, meta = {} }) {
  const p = { id: id || newId('P'), session_id, kind, data_url, meta, created_at: nowIso() };
  await idbDo('readwrite', (s) => s.put(p)).catch(() => {});
  push('dec_photos', p.id);
  return p.id;
}

export async function linkPhoto(id, sessionId) {
  const p = await idbDo('readonly', (s) => s.get(id)).catch(() => null);
  if (!p || p.session_id === sessionId) return;
  p.session_id = sessionId;
  await idbDo('readwrite', (s) => s.put(p)).catch(() => {});
  push('dec_photos', id);
}

export async function getPhoto(id) {
  const local = await idbDo('readonly', (s) => s.get(id)).catch(() => null);
  if (local?.data_url) return local.data_url;
  if (!client) return null;
  const { data } = await client.from('dec_photos').select('data_url').eq('id', id).maybeSingle();
  return data?.data_url || null;
}

export async function clearDevice() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  try { indexedDB.deleteDatabase('vriddhi-decant'); } catch { /* ignore */ }
}
