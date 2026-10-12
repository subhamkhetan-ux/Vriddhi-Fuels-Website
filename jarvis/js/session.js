// Logins. Jarvis lives on the same website as the other apps, so it uses the
// very same saved sessions: signed in to the Ledger (or Fleet) app on this
// phone means signed in here, and the other way round. Each app keeps its
// own Supabase project; the public settings come from the apps' own
// config.js files (loaded by index.html).

export const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';

// storageKey: the app's own (undefined = supabase-js's default, which the
// Loading, Indents and Tally apps use) — so a login is shared with that app
export const PROJECTS = {
  // Jarvis's own project: its login, and the settings / conversation that sync across devices
  jarvis: { cfg: () => window.JARVIS_CONFIG, storageKey: 'vriddhi-jarvis-auth', label: 'Jarvis', user: 'email' },
  ledger: { cfg: () => window.LEDGER_CONFIG, storageKey: 'vriddhi-ledger-auth', label: 'Ledger', user: 'email' },
  fleet: { cfg: () => window.FLEET_CONFIG, storageKey: 'shree-shyam-fleet-auth', label: 'Fleet', user: 'email' },
  loading: { cfg: () => window.VRIDDHI_LOADING_CONFIG, label: 'Loading', user: 'username' },
  indents: { cfg: () => window.VRIDDHI_CONFIG, label: 'Indents', user: 'username' },
  tally: { cfg: () => window.VRIDDHI_TALLY_CONFIG, label: 'Tally', user: 'username' },
  pay: { cfg: () => window.VRIDDHI_PAY_CONFIG, label: 'Payment entry', anon: true },
};

const clients = {};
let lib = null;
async function supabaseLib() {
  if (!lib) lib = import(SUPABASE_JS);
  return lib;
}

export function configured(name) {
  const c = PROJECTS[name]?.cfg() || {};
  return Boolean(c.SUPABASE_URL && c.SUPABASE_ANON_KEY && !/PASTE_/.test(c.SUPABASE_URL + c.SUPABASE_ANON_KEY));
}

export async function client(name) {
  if (!clients[name]) {
    const p = PROJECTS[name];
    if (!configured(name)) throw new Error(`The ${name} app isn't connected to its database (${name}/config.js).`);
    const { createClient } = await supabaseLib();
    const c = p.cfg();
    clients[name] = createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
      auth: p.anon ? { persistSession: false, autoRefreshToken: false, storageKey: `jarvis-${name}-anon` }
        : { persistSession: true, autoRefreshToken: true, ...(p.storageKey ? { storageKey: p.storageKey } : {}) },
    });
  }
  return clients[name];
}

export async function session(name) {
  if (!configured(name)) return null;
  const { data } = await (await client(name)).auth.getSession();
  return data?.session || null;
}

export async function signIn(name, email, password) {
  const c = await client(name);
  const u = String(email || '').trim().toLowerCase();
  // the staff apps log in with a username (stored as <username>@vriddhi.local)
  const login = u.includes('@') ? u : `${u.replace(/[^a-z0-9._-]/g, '')}@vriddhi.local`;
  const { data, error } = await c.auth.signInWithPassword({ email: login, password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
  return data.session;
}

// a new login (Jarvis's own project only). Returns the session, or null when
// the project wants the email confirmed first.
export async function signUp(name, email, password) {
  const c = await client(name);
  const { data, error } = await c.auth.signUp({ email: String(email || '').trim().toLowerCase(), password });
  if (error) throw new Error(error.message);
  return data.session || null;
}

export async function signOut(name) {
  if (clients[name]) await clients[name].auth.signOut();
}

// a signed-in client or a clear "sign in first" error (shown to the owner)
export async function signedIn(name, label = PROJECTS[name]?.label || name) {
  if (PROJECTS[name]?.anon) return client(name);
  const s = await session(name);
  if (!s) {
    const err = new Error(`Not signed in to ${label}. Open ⚙ Settings → Logins and sign in (the same login as the ${label} app).`);
    err.needsLogin = name;
    throw err;
  }
  return client(name);
}
