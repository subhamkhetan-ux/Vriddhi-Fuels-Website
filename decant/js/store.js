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
import { localFrom, withOlder } from './report.js';
import { logMonths, monthBounds, monthCounts } from './archive.js';

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

// Records per month in the cloud, for the monthly log files (archive.js):
// {month: {sessions, open, invoices, updated}}. Checked once a day.
export const cloudMonths = { status: 'idle', counts: {}, at: 0, error: '' };

// What this phone has downloaded from the cloud this month (bytes of the rows,
// before compression) — Supabase's free plan counts every byte sent out.
const METER_KEY = 'vriddhi-decant-meter';
export function meterNow() {
  try {
    const m = JSON.parse(localStorage.getItem(METER_KEY) || '{}');
    return m.month === istDate(Date.now()).slice(0, 7) ? m : { month: istDate(Date.now()).slice(0, 7), bytes: 0 };
  } catch { return { month: istDate(Date.now()).slice(0, 7), bytes: 0 }; }
}
function meter(data) {
  if (!data) return;
  try {
    const m = meterNow();
    m.bytes += JSON.stringify(data).length;
    localStorage.setItem(METER_KEY, JSON.stringify(m));
  } catch { /* ignore */ }
}

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
    state.tankState = raw.tankState || {};
    state.config = raw.config || {};
    // screenshots and trucks' chamber layouts aren't kept any more (our own TTs are in Settings)
    state.outbox = (raw.outbox || []).filter((o) => o.table !== 'dec_photos' && o.table !== 'dec_vehicles');
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
        invoices: state.invoices, sessions: state.sessions,
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
let adopted = false;               // this phone's copy has been moved into this project (adoptProject)
const later = (a, b) => (Date.parse(a || 0) || 0) > (Date.parse(b || 0) || 0);

function setCloud(s, err = '') {
  state.cloud = s;
  state.cloudError = err;
  emit();
}

const TABLES = {
  dec_invoices: { key: 'invoice_no', list: () => state.invoices },
  dec_sessions: { key: 'id', list: () => state.sessions },
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

// Everything this phone keeps, from the cloud. light: for the two big tables
// first only each row's key and edit time, then just the rows that are new or
// changed — a phone opening the app again downloads next to nothing.
async function pull(which = 'all', { light = false } = {}) {
  if (!client) return;
  try {
    if (!adopted) await adoptProject();
    // this month and last; older months come on demand (loadHistory)
    const since = windowStartIso();
    const jobs = [];
    if (which === 'all' || which === 'dec_invoices') {
      jobs.push((light && state.invoices.length ? pullLight('dec_invoices') : client.from('dec_invoices').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(1000)
        .then(({ data, error }) => {
          if (error) throw error;
          meter(data);
          state.invoices = mergeRows('dec_invoices', state.invoices, data || [], (r) => r.invoice_no);
        })));
    }
    if (which === 'all' || which === 'dec_sessions') {
      jobs.push(light && state.sessions.length ? pullLight('dec_sessions') : Promise.all([
        client.from('dec_sessions').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(1000),
        // a decantation left open from before (it still needs finishing)
        client.from('dec_sessions').select('*').in('status', OPEN).lt('created_at', since).limit(100),
      ]).then(([recent, open]) => {
        if (recent.error) throw recent.error;
        if (open.error) throw open.error;
        meter(recent.data);
        meter(open.data);
        state.sessions = mergeRows('dec_sessions', state.sessions, [...(recent.data || []), ...(open.data || [])], (r) => r.id);
      }));
    }
    if (which === 'all' || which === 'dec_tank_state') {
      jobs.push(client.from('dec_tank_state').select('*').then(({ data, error }) => {
        if (error) throw error;
        meter(data);
        for (const r of data || []) {
          const cur = state.tankState[r.tank_id];
          if (!pending('dec_tank_state', r.tank_id) && (!cur || newer(r.reading, cur))) state.tankState[r.tank_id] = r.reading;
        }
      }));
    }
    if (which === 'all' || which === 'dec_config') {
      jobs.push(client.from('dec_config').select('data,updated_at').eq('id', 1).maybeSingle().then(({ data, error }) => {
        if (error) throw error;
        meter(data);
        if (data?.data && !pending('dec_config', 1)) {
          state.config = data.data;
          applyConfig();
        }
      }));
    }
    await Promise.all(jobs);
    setCloud('live');
    saveLocal();
    if (state.outbox.length) flushOutbox();          // e.g. rows the move just queued
  } catch (e) {
    const msg = e?.message || String(e);
    setCloud('offline', /dec_\w+|relation|schema cache|does not exist/i.test(msg)
      ? 'The decanting tables are missing — run supabase/decant-schema.sql in the Supabase SQL editor.'
      : msg);
  }
}

const listOf = (table) => (table === 'dec_sessions' ? state.sessions : state.invoices);
function setList(table, list) {
  if (table === 'dec_sessions') state.sessions = list; else state.invoices = list;
}

async function pullLight(table) {
  const { key } = TABLES[table];
  const since = windowStartIso();
  const asks = [client.from(table).select(`${key},updated_at`).gte('created_at', since).order('created_at', { ascending: false }).limit(1000)];
  if (table === 'dec_sessions') asks.push(client.from(table).select(`${key},updated_at`).in('status', OPEN).lt('created_at', since).limit(100));
  const got = await Promise.all(asks);
  for (const g of got) if (g.error) throw g.error;
  const heads = got.flatMap((g) => g.data || []);
  meter(heads);
  const mine = new Map(listOf(table).map((r) => [String(r[key]), r]));
  const need = heads.filter((h) => {
    const l = mine.get(String(h[key]));
    return !l || (Date.parse(h.updated_at || 0) || 0) > (Date.parse(l.updated_at || 0) || 0);
  }).map((h) => h[key]);
  const fresh = new Map();
  for (let i = 0; i < need.length; i += 100) {
    const { data, error } = await client.from(table).select('*').in(key, need.slice(i, i + 100));
    if (error) throw error;
    meter(data);
    for (const r of data || []) fresh.set(String(r[key]), r);
  }
  // the cloud's list, as the full pull would have it
  const remote = heads.map((h) => fresh.get(String(h[key])) || mine.get(String(h[key]))).filter(Boolean);
  setList(table, mergeRows(table, listOf(table), remote, (r) => r[key]));
}

// Rows another phone (or this one) just changed: fetched one by one instead of
// the whole two months again. A row gone from the cloud is dropped here too.
async function pullRows(table, keys) {
  if (!client || !keys.length) return;
  const { key } = TABLES[table];
  try {
    const { data, error } = await client.from(table).select('*').in(key, keys);
    if (error) throw error;
    meter(data);
    const since = Date.parse(windowStartIso());
    const list = [...listOf(table)];
    for (const r of data || []) {
      const k = String(r[key]);
      const i = list.findIndex((x) => String(x[key]) === k);
      const l = i >= 0 ? list[i] : null;
      if (l && (pending(table, k) || (l.updated_at && r.updated_at && Date.parse(l.updated_at) > Date.parse(r.updated_at)))) continue;
      if (i >= 0) list[i] = r;
      else if (Date.parse(r.created_at || 0) >= since || (table === 'dec_sessions' && OPEN.includes(r.status))) list.unshift(r);
    }
    const back = new Set((data || []).map((r) => String(r[key])));
    setList(table, list.filter((r) => back.has(String(r[key])) || !keys.map(String).includes(String(r[key])) || pending(table, r[key]) || r._local));
    setCloud('live');
    saveLocal();
  } catch (e) {
    setCloud('offline', e?.message || String(e));
  }
}

function dropRow(table, k) {
  const { key } = TABLES[table];
  if (pending(table, k)) return;
  setList(table, listOf(table).filter((r) => String(r[key]) !== String(k) || r._local));
  saveLocal();
  emit();
}

function newer(a, b) {
  const ta = Date.parse(a?.readingAt || a?.savedAt || 0) || 0;
  const tb = Date.parse(b?.readingAt || b?.savedAt || 0) || 0;
  return ta > tb || (ta === tb && (Date.parse(a?.savedAt || 0) || 0) > (Date.parse(b?.savedAt || 0) || 0));
}

// A change in the cloud. The two big tables fetch just the changed rows (the
// event names them); the small ones are fetched whole.
function subscribe() {
  if (!client?.channel) return;
  const timers = {};
  const poke = (t) => { clearTimeout(timers[t]); timers[t] = setTimeout(() => pull(t), 400); };
  const waiting = { dec_sessions: new Set(), dec_invoices: new Set() };
  const pokeRow = (t, k) => {
    waiting[t].add(String(k));
    clearTimeout(timers[`row ${t}`]);
    timers[`row ${t}`] = setTimeout(() => { const keys = [...waiting[t]]; waiting[t].clear(); pullRows(t, keys); }, 400);
  };
  let ch = client.channel('decant-live');
  for (const t of ['dec_invoices', 'dec_sessions', 'dec_tank_state', 'dec_config']) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, (change) => {
      const { key } = TABLES[t];
      const k = change?.new?.[key] ?? change?.old?.[key];
      if (!waiting[t] || k === undefined || k === null) { poke(t); return; }
      if (change.eventType === 'DELETE') dropRow(t, k); else pokeRow(t, k);
    });
  }
  ch.subscribe();
}

// A phone whose copy came from somewhere else — the payments project the first
// version used, or working without a cloud — moves it into this project once.
// A row goes across only if the project doesn't have it yet or has an older
// version, so a phone that was closed for a while never overwrites newer work
// done on another phone. pull() waits for the move, so until it has gone
// through nothing on the phone is replaced by the cloud's copy.
async function adoptProject() {
  let prev = null;
  try { prev = localStorage.getItem(PROJECT_KEY); } catch { /* ignore */ }
  if (prev !== CFG.SUPABASE_URL) {
    const tables = [
      ['dec_sessions', 'id', state.sessions],
      ['dec_invoices', 'invoice_no', state.invoices],
    ];
    for (const [table, key, rows] of tables) {
      for (let i = 0; i < rows.length; i += 100) {
        const part = rows.slice(i, i + 100);
        const { data, error } = await client.from(table).select(`${key},updated_at`).in(key, part.map((r) => r[key]));
        if (error) throw error;
        const have = new Map((data || []).map((r) => [String(r[key]), r.updated_at]));
        for (const r of part) {
          const k = String(r[key]);
          if (!have.has(k) || later(r.updated_at, have.get(k))) queue(table, k);
        }
      }
    }
    if (Object.keys(state.tankState).length) {
      const { data, error } = await client.from('dec_tank_state').select('tank_id,reading');
      if (error) throw error;
      const have = Object.fromEntries((data || []).map((r) => [r.tank_id, r.reading]));
      for (const [id, r] of Object.entries(state.tankState)) if (!have[id] || newer(r, have[id])) queue('dec_tank_state', id);
    }
    if (Object.keys(state.config || {}).length) {
      const { data, error } = await client.from('dec_config').select('data').eq('id', 1).maybeSingle();
      if (error) throw error;
      if (!data?.data?.updatedAt || later(state.config.updatedAt, data.data.updatedAt)) queue('dec_config', 1);
    }
    try { localStorage.setItem(PROJECT_KEY, CFG.SUPABASE_URL); } catch { /* ignore */ }
  }
  adopted = true;
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
    // (old months are no longer deleted unseen: see tidyMonths)
    await pull('all', { light: true });
    subscribe();
    await flushOutbox();
    tidyMonths().catch(() => {});
  } catch (e) {
    setCloud('offline', e?.message || String(e));
  }
  window.addEventListener('online', () => { pull('all', { light: true }); flushOutbox(); });
  setInterval(() => { if (state.outbox.length) flushOutbox(); }, 30000);
  let last = 0;
  const refresh = () => {
    if (Date.now() - last < 2000) return;
    last = Date.now();
    pull('all', { light: true });
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
    meter(sessions);
    meter(invoices);
    Object.assign(cloudHistory, { status: 'done', sessions, invoices, at: Date.now(), error: '' });
  } catch (e) {
    Object.assign(cloudHistory, { status: 'error', at: Date.now(), error: e?.message || String(e) });
  }
  emit();
}

// ---------------------------------------------------------------------------
// Monthly log files (archive.js)
// ---------------------------------------------------------------------------

const MONTHS_KEY = 'vriddhi-decant-months';

// Records per month in the cloud: from the dec_months view (a few rows), or —
// a project set up before it — from every row's dates. Once a day.
export async function loadMonths(force = false) {
  if (cloudMonths.status === 'loading') return;
  if (!client) {
    Object.assign(cloudMonths, { status: 'done', counts: monthCounts(state.sessions, state.invoices), at: Date.now() });
    return;
  }
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(MONTHS_KEY) || 'null');
      if (c && c.project === CFG.SUPABASE_URL && Date.now() - c.at < 20 * 3600000 && istDate(c.at) === istDate(Date.now())) {
        Object.assign(cloudMonths, { status: 'done', counts: c.counts, at: c.at, error: '' });
        return;
      }
    } catch { /* ask the cloud */ }
  }
  cloudMonths.status = 'loading';
  try {
    let counts;
    const view = await client.from('dec_months').select('*');
    if (!view.error) {
      meter(view.data);
      counts = {};
      for (const r of view.data || []) {
        const x = (counts[r.month] ||= { sessions: 0, open: 0, invoices: 0, updated: '' });
        if (r.kind === 'sessions') { x.sessions += Number(r.n) || 0; x.open += Number(r.open) || 0; } else x.invoices += Number(r.n) || 0;
        if ((Date.parse(r.updated || 0) || 0) > (Date.parse(x.updated || 0) || 0)) x.updated = r.updated;
      }
    } else if (/dec_months|does not exist|schema cache/i.test(view.error.message || '')) {
      const [s, i] = await Promise.all([
        pageAll(() => client.from('dec_sessions').select('created_at,updated_at,status').order('created_at', { ascending: true })),
        pageAll(() => client.from('dec_invoices').select('created_at,updated_at').order('created_at', { ascending: true })),
      ]);
      meter(s);
      meter(i);
      counts = monthCounts(s, i);
    } else throw view.error;
    Object.assign(cloudMonths, { status: 'done', counts, at: Date.now(), error: '' });
    try { localStorage.setItem(MONTHS_KEY, JSON.stringify({ project: CFG.SUPABASE_URL, at: cloudMonths.at, counts })); } catch { /* ignore */ }
  } catch (e) {
    Object.assign(cloudMonths, { status: 'error', at: Date.now(), error: e?.message || String(e) });
  }
  emit();
}

// The monthly files as the Log shows them (archive.js logMonths).
export function monthFiles() {
  return logMonths({ counts: cloudMonths.counts, archive: state.config.archive || {}, today: istDate(Date.now()), keep: state.settings.keep });
}

const inMonth = (m) => {
  const [a, b] = monthBounds(m).map(Date.parse);
  return (r) => { const t = Date.parse(r.created_at || 0); return t >= a && t < b; };
};

// A month's records, whole: from the cloud (with this phone's newer copies).
export async function fetchMonth(m) {
  const pick = inMonth(m);
  let sessions = state.sessions.filter(pick);
  let invoices = state.invoices.filter(pick);
  if (client) {
    const [a, b] = monthBounds(m);
    const [s, i] = await Promise.all([
      pageAll(() => client.from('dec_sessions').select('*').gte('created_at', a).lt('created_at', b).order('created_at', { ascending: true })),
      pageAll(() => client.from('dec_invoices').select('*').gte('created_at', a).lt('created_at', b).order('created_at', { ascending: true })),
    ]);
    meter(s);
    meter(i);
    sessions = withOlder(sessions, s, 'id');
    invoices = withOlder(invoices, i, 'invoice_no');
  }
  return { sessions, invoices };
}

// Clear a month from the cloud (its file has been downloaded): its finished
// and cancelled decantations and its invoices — not a decantation still open,
// nor the invoice it is decanting.
export async function clearMonth(m) {
  if (!client) return false;
  const [a, b] = monthBounds(m);
  const busy = new Set(state.sessions.filter((s) => OPEN.includes(s.status)).map((s) => s.invoice_no).filter(Boolean));
  const del = await client.from('dec_sessions').delete().in('status', ['done', 'cancelled']).gte('created_at', a).lt('created_at', b);
  if (del.error) throw del.error;
  const { data, error } = await client.from('dec_invoices').select('invoice_no').gte('created_at', a).lt('created_at', b);
  if (error) throw error;
  const gone = (data || []).map((r) => r.invoice_no).filter((n) => !busy.has(n));
  for (let i = 0; i < gone.length; i += 100) {
    const r = await client.from('dec_invoices').delete().in('invoice_no', gone.slice(i, i + 100));
    if (r.error) throw r.error;
  }
  const pick = inMonth(m);
  state.sessions = state.sessions.filter((s) => !(pick(s) && ['done', 'cancelled'].includes(s.status)));
  state.invoices = state.invoices.filter((i) => !(pick(i) && gone.includes(i.invoice_no)));
  Object.assign(cloudHistory, { status: 'idle', at: 0 });
  saveLocal();
  emit();
  return true;
}

// On start: clear every month whose file is downloaded, unchanged since, and
// older than what the cloud keeps (Settings). Nothing is cleared unseen.
export async function tidyMonths() {
  if (!client) return;
  await loadMonths();
  let cleared = 0;
  for (const f of monthFiles().filter((x) => x.clear)) {
    try {
      await clearMonth(f.month);
      await saveConfig({ archive: { ...(state.config.archive || {}), [f.month]: { ...f.file, cleared: new Date().toISOString() } } });
      cleared += 1;
    } catch (e) {
      setCloud('offline', e?.message || String(e));
      break;
    }
  }
  if (cleared) await loadMonths(true);
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
  return push('dec_invoices', inv.invoice_no);
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
