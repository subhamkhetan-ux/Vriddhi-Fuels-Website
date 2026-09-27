// The decanting app's data: kept on the phone first (so a weak signal at the
// forecourt never loses a decantation) and mirrored to Supabase — the same
// project as the payments app, whose agent fills dec_invoices from mail.
//
// Local: localStorage for the records, IndexedDB for the screenshots.
// Cloud: dec_* tables (supabase/decant-schema.sql). Every write goes to the
// phone at once and to the cloud with retries; a write that can't reach the
// cloud waits in an outbox and is sent when the connection is back.

import { DIP_CHART } from './dipchart.js';
import { istDate, settingsWith } from './core.js';
import { localFrom } from './report.js';

const CFG = window.VRIDDHI_DECANT_CONFIG || {};
const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';
const LS_KEY = 'vriddhi-decant-v1';
const DEVICE_KEY = 'vriddhi-decant-device';
const PROJECT_KEY = 'vriddhi-decant-project';      // the cloud project this phone's copy belongs to

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
  schemaNote: '',         // set when the cloud tables are from an older schema
};

// Older months for the FY reports, fetched from the cloud when a report
// reaches back past what the phone keeps. Compact rows, in memory only.
export const cloudHistory = { status: 'idle', sessions: [], invoices: [], at: 0, error: '' };

// The phone keeps this month and last (plus anything still open).
function windowStartIso() {
  return new Date(`${localFrom(istDate(Date.now()))}T00:00:00+05:30`).toISOString();
}
const OPEN = ['draft', 'decanting', 'settling'];

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
    state.outbox = (raw.outbox || []).filter((o) => o.table !== 'dec_photos');   // screenshots aren't kept any more
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

const missingCols = new Set();

function queue(table, key) {
  if (!state.outbox.some((o) => o.table === table && String(o.key) === String(key))) state.outbox.push({ table, key: String(key) });
  saveLocal();
}

async function push(table, key) {
  if (!client) { queue(table, key); return false; }
  let err;
  if (table === 'dec_sessions_delete') {
    err = await withRetry(() => client.from('dec_sessions').delete().eq('id', key));
  } else {
    const row = rowFor(table, key);
    if (!row) return true;
    if (table === 'dec_invoices') for (const c of missingCols) delete row[c];
    err = await withRetry(() => client.from(table).upsert(row, { onConflict: TABLES[table].key }));
    // A column added in a later version of decant-schema.sql that this
    // project doesn't have yet: send the row without it (and say so).
    const miss = /could not find the '(\w+)' column/i.exec(err?.message || '');
    if (miss && table === 'dec_invoices' && miss[1] in row && miss[1] !== TABLES[table].key) {
      missingCols.add(miss[1]);
      state.schemaNote = 'Run the updated supabase/decant-schema.sql once in the Supabase SQL editor — the cloud tables are from an older version.';
      emit();
      delete row[miss[1]];
      err = await withRetry(() => client.from(table).upsert(row, { onConflict: TABLES[table].key }));
    }
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
    // this month and last; older months come on demand (loadHistory)
    const since = windowStartIso();
    const jobs = [];
    if (which === 'all' || which === 'dec_invoices') {
      jobs.push(client.from('dec_invoices').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(1000)
        .then(({ data, error }) => {
          if (error) throw error;
          state.invoices = mergeRows('dec_invoices', state.invoices, data || [], (r) => r.invoice_no);
        }));
    }
    if (which === 'all' || which === 'dec_sessions') {
      jobs.push(Promise.all([
        client.from('dec_sessions').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(1000),
        // a decantation left open from before (it still needs finishing)
        client.from('dec_sessions').select('*').in('status', OPEN).lt('created_at', since).limit(100),
      ]).then(([recent, open]) => {
        if (recent.error) throw recent.error;
        if (open.error) throw open.error;
        state.sessions = mergeRows('dec_sessions', state.sessions, [...(recent.data || []), ...(open.data || [])], (r) => r.id);
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

// A phone whose copy came from somewhere else — the payments project the first
// version used, or working without a cloud — sends all of it to this project
// once, so nothing recorded is lost in the move.
function adoptProject() {
  let prev = null;
  try { prev = localStorage.getItem(PROJECT_KEY); } catch { /* ignore */ }
  if (prev === CFG.SUPABASE_URL) return;
  for (const s of state.sessions) queue('dec_sessions', s.id);
  for (const inv of state.invoices) queue('dec_invoices', inv.invoice_no);
  for (const tt of Object.keys(state.vehicles)) queue('dec_vehicles', tt);
  for (const id of Object.keys(state.tankState)) queue('dec_tank_state', id);
  if (Object.keys(state.config || {}).length) queue('dec_config', 1);
  try { localStorage.setItem(PROJECT_KEY, CFG.SUPABASE_URL); } catch { /* ignore */ }
}

export async function initStore() {
  loadLocal();
  purgeLocal();
  emit();
  if (!cloudEnabled) { setCloud('off'); return; }
  adoptProject();
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
  cloudHistory.at = 0;                          // older months are fetched again when next needed
  if (cloudHistory.status === 'error') cloudHistory.status = 'idle';
  if (client) { pull(); flushOutbox(); }
}

// ---------------------------------------------------------------------------
// Older months (for the FY reports)
// ---------------------------------------------------------------------------

async function pageAll(build) {
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Fetch the finished decantations and invoices from before the phone's window.
// Cheap to call on every render: it does nothing while a fetch is running or
// the last one is fresh.
export async function loadHistory() {
  if (!client) { cloudHistory.status = cloudEnabled ? 'offline' : 'off'; return; }
  if (cloudHistory.status === 'loading') return;
  const age = Date.now() - cloudHistory.at;
  if ((cloudHistory.status === 'done' && age < 15 * 60000) || (cloudHistory.status === 'error' && age < 60000)) return;
  cloudHistory.status = 'loading';
  emit();
  const before = windowStartIso();
  try {
    let sessions;
    try {
      sessions = await pageAll(() => client.from('dec_history').select('*').lt('created_at', before).order('created_at', { ascending: false }));
    } catch (e) {
      if (!/dec_history|does not exist|schema cache/i.test(e?.message || '')) throw e;
      // a project set up before the dec_history view: whole rows
      sessions = await pageAll(() => client.from('dec_sessions').select('*').eq('status', 'done').lt('created_at', before)
        .order('created_at', { ascending: false }));
    }
    const invoices = await pageAll(() => client.from('dec_invoices')
      .select('invoice_no,invoice_date,invoice_time,tt_no,lines,dismissed,note,source,created_at')
      .lt('created_at', before).order('created_at', { ascending: false }));
    Object.assign(cloudHistory, { status: 'done', sessions, invoices, at: Date.now(), error: '' });
  } catch (e) {
    Object.assign(cloudHistory, { status: 'error', at: Date.now(), error: e?.message || String(e) });
  }
  emit();
}

// The phone keeps this month and last, anything still open and anything not
// yet sent; older months live in the cloud.
function purgeLocal() {
  const since = Date.parse(windowStartIso());
  const open = (s) => OPEN.includes(s.status);
  state.sessions = state.sessions.filter((s) => open(s) || pending('dec_sessions', s.id)
    || Date.parse(s.created_at || 0) >= since || Date.parse(s.completed_at || s.updated_at || 0) >= since);
  state.invoices = state.invoices.filter((i) => Date.parse(i.created_at || 0) >= since || pending('dec_invoices', i.invoice_no)
    || state.sessions.some((s) => s.invoice_no === i.invoice_no && open(s)));
  saveLocal();
  // screenshots an earlier version kept on the phone
  try { indexedDB.deleteDatabase('vriddhi-decant'); } catch { /* ignore */ }
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

export async function clearDevice() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  try { indexedDB.deleteDatabase('vriddhi-decant'); } catch { /* ignore */ }
}
