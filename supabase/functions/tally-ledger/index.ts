// =====================================================================
// Edge Function: tally-ledger   (Tally Voucher app)
// ---------------------------------------------------------------------
// A tanker bill's P.O. No. and customer details come from the LEDGER app's
// open POs and Tanker Master (tally/ledger-po.js). Without this function every Tally device signs in to
// the ledger with its own ledger login, again whenever the device forgets
// it. With it, ONE ledger login is kept here, as secrets of the TALLY
// project, and every signed-in Tally user gets the POs with their Tally
// login alone: nothing to type on a device, ever.
//
// Only the ledger's read functions the app needs can be called through it
// (READ below), and only with a live Tally login (checked with the caller's
// own token). Nothing in the ledger is ever changed from here.
//
// Set once, in the TALLY project (dashboard → Edge Functions → Secrets, or
// `supabase secrets set ...`):
//   LEDGER_EMAIL     a ledger login on the ledger's members list
//                    (in the LEDGER project: select ledger_add_member('…');)
//                    — the same one as loading-ledger's is fine
//   LEDGER_PASSWORD  its password
// Optional: LEDGER_SUPABASE_URL / LEDGER_SUPABASE_ANON_KEY (default: the
// ledger in tally/config.js). Then deploy:
//   supabase functions deploy tally-ledger
//
// Body (JSON): { fn, args }   fn: one of READ; args: its arguments
// =====================================================================

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const READ = new Set(["ledger_whoami", "ledger_po_data", "ledger_tanker_list"]);
// the ledger's public URL and publishable key (as in tally/config.js and ledger/config.js)
const LEDGER_URL = Deno.env.get("LEDGER_SUPABASE_URL") ?? "https://behousmsujnlspwdxyas.supabase.co";
const LEDGER_KEY = Deno.env.get("LEDGER_SUPABASE_ANON_KEY") ?? "sb_publishable_BeflN_phUuD6BT_ZmAdDsw_tou7vxUa";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// The ledger login, signed in once per warm instance and again before its
// token runs out (or when the ledger refuses it).
let ledger: SupabaseClient | null = null;
let expiresAt = 0;
async function ledgerClient(fresh = false): Promise<SupabaseClient> {
  if (ledger && !fresh && Date.now() < expiresAt - 60_000) return ledger;
  const email = Deno.env.get("LEDGER_EMAIL") ?? "", password = Deno.env.get("LEDGER_PASSWORD") ?? "";
  if (!email || !password) throw new Error("NOT_SET");
  const c = createClient(LEDGER_URL, LEDGER_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error("The ledger login kept on the server didn't sign in: " + (error?.message ?? "no session"));
  ledger = c;
  expiresAt = (data.session.expires_at ?? 0) * 1000 || Date.now() + 30 * 60_000;
  return c;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Missing token" }, 401);
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
    ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
    ?? req.headers.get("apikey") ?? "";

  // 1. A live Tally login? (its own token, checked by this project's auth)
  const asUser = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: me, error: meErr } = await asUser.auth.getUser(auth.slice(7));
  if (meErr || !me?.user) return json({ error: "Sign in to the Tally app first" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const fn = String(body.fn ?? "");
  if (!READ.has(fn)) return json({ error: "Only the ledger's read functions can be called" }, 400);
  const args = (body.args && typeof body.args === "object") ? body.args as Record<string, unknown> : {};

  // 2. The ledger, as the login kept here
  try {
    let r = await (await ledgerClient()).rpc(fn, args);
    if (r.error && /JWT|expired|invalid claim/i.test(r.error.message ?? "")) r = await (await ledgerClient(true)).rpc(fn, args);
    if (r.error) return json({ error: r.error.message, code: r.error.code ?? "" }, 400);
    return json({ ok: true, data: r.data });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m === "NOT_SET") return json({ error: "No ledger login is set on the server (LEDGER_EMAIL / LEDGER_PASSWORD)", not_set: true }, 503);
    return json({ error: m }, 502);
  }
});
