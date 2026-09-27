// Our own delivery tankers, read from the Tanker Loading app (/loading/). That
// app has its own Supabase project and only signed-in staff can read it, so
// this phone signs in once with a Loading-app username + password (the same
// login the staff use there). Read-only: we only look at how full each
// tanker is, to know how much diesel they can still take.

const LOADING_CONFIG = '../loading/config.js';
const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';

export const tankers = {
  status: 'off',     // off | connecting | signin | live | unavailable | error
  vehicles: [],      // [{plate, caps, fill}]
  user: '',
  error: '',
  at: null,          // when the list was read
};

const listeners = new Set();
export function onTankers(fn) { listeners.add(fn); }
function emit() { for (const fn of listeners) fn(); }

let client = null;
let started = null;

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

async function readVehicles() {
  const { data, error } = await client.from('loading_vehicles').select('plate,caps,fill').order('plate', { ascending: true });
  if (error) {
    tankers.status = /jwt|auth|permission|denied/i.test(error.message || '') ? 'signin' : 'error';
    tankers.error = error.message || String(error);
  } else {
    tankers.vehicles = (data || []).map((v) => ({ plate: v.plate, caps: (v.caps || []).map(Number), fill: v.fill || {} }));
    tankers.status = 'live';
    tankers.error = '';
    tankers.at = new Date().toISOString();
  }
  emit();
}

let watching = false;
function watch() {
  if (watching || !client?.channel) return;
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
