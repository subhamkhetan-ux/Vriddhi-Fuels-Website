// A tiny in-memory PostgREST stand-in with network latency and failure hooks.
export const db = { dec_sessions: new Map(), dec_invoices: new Map(), dec_tank_state: new Map(), dec_config: new Map() };
export const ctl = { latency: 50, log: [], fail: null };   // fail(table, op, row) -> error | null
// a login (dec_whoami's "owner" for the owner's): no one signed in to start with
export const auth = { session: null, owners: new Set(['owner@example.com']), password: 'pw' };
const KEY = { dec_sessions: 'id', dec_invoices: 'invoice_no', dec_tank_state: 'tank_id', dec_config: 'id' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eqv = (col, a, b) => (/_at$/.test(col) && a && b ? Date.parse(a) === Date.parse(b) : String(a) === String(b));
class Q {
  constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.single = false; this.ret = false; }
  select() { if (this.op !== 'select') this.ret = true; return this; }
  eq(c, v) { this.f.push((r) => eqv(c, r[c], v)); return this; }
  gte(c, v) { this.f.push((r) => Date.parse(r[c]) >= Date.parse(v)); return this; }
  lt(c, v) { this.f.push((r) => Date.parse(r[c]) < Date.parse(v)); return this; }
  in(c, vs) { this.f.push((r) => vs.map(String).includes(String(r[c]))); return this; }
  order() { return this; } limit() { return this; } range() { return this; }
  maybeSingle() { this.single = true; return this; }
  update(row) { this.op = 'update'; this.row = structuredClone(row); return this; }
  upsert(row) { this.op = 'upsert'; this.row = structuredClone(row); return this; }
  delete() { this.op = 'delete'; return this; }
  async run() {
    await sleep(typeof ctl.latency === 'function' ? ctl.latency(this) : ctl.latency);
    const err = ctl.fail && ctl.fail(this.t, this.op, this.row);
    if (err) return { data: null, error: err };
    const m = db[this.t]; const k = KEY[this.t];
    const rows = [...m.values()].filter((r) => this.f.every((f) => f(r)));
    ctl.log.push(`${this.t} ${this.op} ${this.row ? (this.row.updated_at || '') : ''} -> ${this.op === 'update' ? rows.length : ''}`);
    if (this.op === 'select') { const d = rows.map((r) => structuredClone(r)); return { data: this.single ? (d[0] || null) : d, error: null }; }
    if (this.op === 'update') { for (const r of rows) m.set(String(r[k]), structuredClone({ ...r, ...this.row })); return { data: rows.map((r) => ({ id: r[k] })), error: null }; }
    if (this.op === 'upsert') { for (const r of [].concat(this.row)) m.set(String(r[k]), structuredClone({ ...(m.get(String(r[k])) || {}), ...r })); return { data: null, error: null }; }
    if (this.op === 'delete') { for (const r of rows) m.delete(String(r[k])); return { data: null, error: null }; }
  }
  then(a, b) { return this.run().then(a, b); }
}
export function createClient() {
  const listeners = [];
  return {
    from: (t) => new Q(t),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    rpc: async (fn) => (fn === 'dec_whoami'
      ? { data: { email: auth.session?.user.email || '', owner: Boolean(auth.session && auth.owners.has(auth.session.user.email)) }, error: null }
      : { data: null, error: { code: 'PGRST202', message: `no ${fn}` } }),
    auth: {
      getSession: async () => ({ data: { session: auth.session } }),
      signInWithPassword: async ({ email, password }) => {
        if (password !== auth.password) return { error: { message: 'Invalid login credentials' } };
        auth.session = { user: { email } };
        return { data: { session: auth.session }, error: null };
      },
      signOut: async () => { auth.session = null; listeners.forEach((f) => f('SIGNED_OUT', null)); return {}; },
      onAuthStateChange: (f) => { listeners.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
}
