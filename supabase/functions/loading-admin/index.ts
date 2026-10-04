// =====================================================================
// Edge Function: loading-admin   (Tanker Loading app)
// ---------------------------------------------------------------------
// Lets an ADMIN of the loading app manage the staff logins from inside the
// app (⚙ → Staff logins): list them, change a password, add a login and set
// who is admin. Changing passwords needs the service-role key, which must
// never reach a phone — so it happens here, after checking that the caller is
// an admin (loading_whoami(), evaluated with the caller's own token).
//
// Deploy (Supabase dashboard -> Edge Functions -> Deploy, or CLI):
//   supabase functions deploy loading-admin
// No secrets to set: SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are injected automatically.
//
// Body (JSON): { action, ... }
//   { action:"list" }
//   { action:"set_password", user_id, password, logout? }   logout=true also
//        logs every staff phone out (loading_auth_state.staff_epoch = now)
//   { action:"create", username, password, role:"staff"|"admin" }
//   { action:"set_role", email, role:"staff"|"admin" }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// username -> the synthetic email the app signs in with
const normUsername = (u: string) => u.toLowerCase().trim().replace(/[^a-z0-9._-]/g, "");
const usernameToEmail = (u: string) => `${normUsername(u)}@vriddhi.local`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Missing token" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
    ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
    ?? req.headers.get("apikey") ?? "";

  // 1. Is the caller an admin with a live session? Asked with THEIR token, so
  //    the database's own rules decide (same check as every admin RPC).
  const asUser = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: me, error: meErr } = await asUser.rpc("loading_whoami");
  if (meErr) return json({ error: "Could not check your login: " + meErr.message }, 401);
  if (!me || me.role !== "admin" || me.ok !== true) return json({ error: "Admin only" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body.action ?? "");
  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- list the logins (with their app role) ----
  if (action === "list") {
    const users: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return json({ error: error.message }, 400);
      users.push(...(data.users as unknown as Array<Record<string, unknown>>));
      if (data.users.length < 200) break;
    }
    const { data: roles } = await admin.from("loading_roles").select("email,role");
    const roleOf = new Map((roles ?? []).map((r: { email: string; role: string }) => [r.email.toLowerCase(), r.role]));
    return json({
      ok: true,
      users: users.map((u) => {
        const email = String(u.email ?? "").toLowerCase();
        return {
          id: u.id, email,
          username: email.endsWith("@vriddhi.local") ? email.split("@")[0] : email,
          role: roleOf.get(email) ?? "staff",
          last_sign_in_at: u.last_sign_in_at ?? null,
          created_at: u.created_at ?? null,
        };
      }).sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === "admin" ? -1 : 1)),
    });
  }

  // ---- change a password ----
  if (action === "set_password") {
    const userId = String(body.user_id ?? "");
    const password = String(body.password ?? "");
    if (!userId) return json({ error: "user_id required" }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) return json({ error: error.message }, 400);
    if (body.logout === true) {
      const { error: e2 } = await admin.from("loading_auth_state").update({ staff_epoch: new Date().toISOString() }).eq("id", 1);
      if (e2) return json({ ok: true, warning: "Password changed, but staff could not be logged out: " + e2.message });
    }
    return json({ ok: true });
  }

  // ---- add a login ----
  if (action === "create") {
    const username = normUsername(String(body.username ?? ""));
    const password = String(body.password ?? "");
    const role = String(body.role ?? "staff");
    if (username.length < 3) return json({ error: "Username must be at least 3 letters (a–z, 0–9, . _ -)" }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
    if (!["staff", "admin"].includes(role)) return json({ error: "Invalid role" }, 400);
    const email = usernameToEmail(username);
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data?.user) return json({ error: error?.message ?? "Could not create the login" }, 400);
    if (role === "admin") {
      const { error: e2 } = await admin.from("loading_roles").upsert({ email, role: "admin", updated_at: new Date().toISOString() });
      if (e2) return json({ ok: true, id: data.user.id, warning: "Created as staff — could not make admin: " + e2.message });
    }
    return json({ ok: true, id: data.user.id, username, email, role });
  }

  // ---- make someone admin / staff ----
  if (action === "set_role") {
    const email = String(body.email ?? "").toLowerCase().trim();
    const role = String(body.role ?? "");
    if (!email || !["staff", "admin"].includes(role)) return json({ error: "email and role required" }, 400);
    if (email === String(me.email ?? "").toLowerCase() && role !== "admin") {
      return json({ error: "You can't remove your own admin access" }, 400);
    }
    const { error } = role === "admin"
      ? await admin.from("loading_roles").upsert({ email, role: "admin", updated_at: new Date().toISOString() })
      : await admin.from("loading_roles").delete().eq("email", email);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
