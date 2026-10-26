// Our own delivery tankers, read from the Tanker Loading app (/loading/). That
// app has its own Supabase project. Its loading_tanker_fill() function
// (supabase/loading-schema.sql) gives each tanker's plate, chambers and fill
// to the publishable key alone, so no login is needed and none can expire.
// Until that SQL has been run there, this phone signs in once with a
// Loading-app username + password (the same login the staff use there).
// Read-only: we only look at how full each tanker is, to know how much
// diesel they can still take, and when it was last sent for sale (it is out
// on that trip for 6 hours: see tankerSpace in core.js).

import { saleOffUntil } from './core.js';

const LOADING_CONFIG = '../loading/config.js';
const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';

export const tankers = {
  status: 'off',     // off | connecting | signin | live | unavailable | error
  vehicles: [],      // [{plate, caps, fill, soldAt}]
  user: '',          // the Loading-app login ('' without one: shared)
  shared: false,     // read without a login (loading_tanker_fill)
  error: '',
  at: null,          // when the list was read
};

const listeners = new Set();
export function onTankers(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(); }

let client = null;
let started = null;
const SHARED_EVERY_MS = 60000;      // no live updates without a login: read again this often
const SALES_BACK_MS = 24 * 3600 * 1000;   // signed in: how far back to look for each tanker's latest sale

function loadConfig() {
  if (window.VRIDDHI_LOADING_CONFIG) return Promise.resolve(window.VRIDDHI_LOADING_CONFIG);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LOADING_CONFIG;
    s.onload = () => resolve(window.VRIDDHI_LOADING_CONFIG || null);
    s.onerror = () => reject(new Error('Couldn\'t load the Loading app\'s settings.'));
    document.head.append(s);
  });
}

const nameOf = (session) => String(session?.user?.email || '').split('@')[0];

export function initTankers() {
  if (!started) {
    started = (async () => {
      tankers.status = 'connecting';
      emit();
      try {
        const cfg = await loadConfig();
        if (!cfg?.SUPABASE_URL || !cfg?.SUPABASE_ANON_KEY || /PASTE_/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY)) {
          tankers.status = 'unavailable';
          tankers.error = 'The Loading app isn\'t connected to the cloud (loading/config.js).';
          emit();
          return;
        }
        const { createClient } = await import(SUPABASE_JS);
        client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: 'vriddhi-decant-loading' },
        });
        if (await readShared()) return;
        const { data } = await client.auth.getSession();
        if (data?.session) {
          tankers.user = nameOf(data.session);
          await readVehicles();
          watch();
        } else {
          tankers.status = 'signin';
          emit();
        }
      } catch (e) {
        tankers.status = 'error';
        tankers.error = e?.message || String(e);
        emit();
      }
    })();
  }
  return started;
}

export async function tankersSignIn(username, password) {
  await initTankers();
  if (!client) throw new Error(tankers.error || 'The Loading app isn\'t reachable.');
  const u = String(username || '').trim().toLowerCase();    // as the Loading app does
  const email = u.includes('@') ? u : `${u}@vriddhi.local`;
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Wrong username or password.');
  tankers.user = nameOf(data?.session) || u;
  await readVehicles();
  watch();
}

export async function tankersSignOut() {
  if (client) await client.auth.signOut().catch(() => {});
  tankers.status = 'signin';
  tankers.vehicles = [];
  tankers.user = '';
  emit();
}

// No login: the Loading app's loading_tanker_fill(). False if that project
// doesn't have it yet (the sign-in is used then); another error is shown.
async function readShared() {
  const got = await client.rpc('loading_tanker_fill');
  const e = got.error;
  if (e && (e.code === 'PGRST202' || /could not find the function|does not exist/i.test(e.message || ''))) return false;
  tankers.shared = true;
  tankers.user = '';
  shown(got);
  setInterval(() => { if (!document.hidden) readVehicles(); }, SHARED_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) readVehicles(); });
  return true;
}

async function readVehicles() {
  if (tankers.shared) { shown(await client.rpc('loading_tanker_fill')); return; }
  const got = await client.from('loading_vehicles').select('plate,caps,fill').order('plate', { ascending: true });
  if (!got.error) {
    // signed in: each tanker's latest sale in the last day (the sales the Loading app shows)
    const sales = await client.from('loading_events').select('vehicle,created_at').eq('kind', 'dispatch')
      .gte('created_at', new Date(Date.now() - SALES_BACK_MS).toISOString()).order('created_at', { ascending: false });
    const last = {};
    for (const e of sales.data || []) if (!last[e.vehicle]) last[e.vehicle] = e.created_at;
    for (const v of got.data || []) v.sold_at = last[v.plate] || null;
  }
  shown(got);
}

function shown({ data, error }) {
  if (error) {
    tankers.status = !tankers.shared && /jwt|auth|permission|denied/i.test(error.message || '') ? 'signin' : 'error';
    tankers.error = error.message || String(error);
  } else {
    tankers.vehicles = (data || []).map((v) => ({ plate: v.plate, caps: (v.caps || []).map(Number), fill: v.fill || {}, soldAt: v.sold_at || null }));
    tankers.status = 'live';
    tankers.error = '';
    tankers.at = new Date().toISOString();
  }
  emit();
  wakeAtSaleEnd();
}

// A tanker's 6 hours after a sale can end between reads (or with no read at
// all, signed in): show it available again right then.
let saleTimer = null;
function wakeAtSaleEnd() {
  clearTimeout(saleTimer);
  const ends = tankers.vehicles.map((v) => saleOffUntil(v.soldAt)).filter(Boolean);
  if (ends.length) saleTimer = setTimeout(() => { emit(); wakeAtSaleEnd(); }, Math.min(...ends) - Date.now() + 1000);
}

let watching = false;
function watch() {
  if (watching || tankers.shared || !client?.channel) return;
  watching = true;
  let t;
  client.channel('decant-tankers')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loading_vehicles' }, () => {
      clearTimeout(t);
      t = setTimeout(() => readVehicles(), 500);
    })
    .subscribe();
}

export function refreshTankers() {
  if (client && tankers.status === 'live') readVehicles();
}

// After an error (no signal, the Loading app's settings didn't load): start over.
export function retryTankers() {
  if (tankers.status === 'connecting') return started;
  started = null;
  if (!client) tankers.error = '';
  return client ? readVehicles().then(() => { if (tankers.status === 'live') watch(); }) : initTankers();
}
