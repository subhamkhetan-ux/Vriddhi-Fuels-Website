// Logins. Jarvis lives on the same website as the other apps, so it uses the
// very same saved sessions: signed in to the Ledger (or Fleet) app on this
// phone means signed in here, and the other way round. Each app keeps its
// own Supabase project; the public settings come from the apps' own
// config.js files (loaded by index.html).

export const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';

const PROJECTS = {
  // Jarvis's own login = the ledger login (also the Mac bridge and the brain)
  ledger: { cfg: () => window.LEDGER_CONFIG, storageKey: 'vriddhi-ledger-auth' },
  fleet: { cfg: () => window.FLEET_CONFIG, storageKey: 'shree-shyam-fleet-auth' },
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
      auth: { persistSession: true, autoRefreshToken: true, storageKey: p.storageKey },
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
  const { data, error } = await c.auth.signInWithPassword({ email: String(email || '').trim(), password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
  return data.session;
}

export async function signOut(name) {
  if (clients[name]) await clients[name].auth.signOut();
}

// a signed-in client or a clear "sign in first" error (shown to the owner)
export async function signedIn(name, label) {
  const s = await session(name);
  if (!s) {
    const err = new Error(`Not signed in to ${label}. Open ⚙ Settings → Logins and sign in (same login as the ${label} app).`);
    err.needsLogin = name;
    throw err;
  }
  return client(name);
}
