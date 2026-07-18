// =====================================================================
// Edge Function: admin-create-user
// ---------------------------------------------------------------------
// Lets an ADMIN create a phone+PIN account (customer / employee / admin)
// without SMS. The caller must send their own Supabase access token in the
// Authorization header; we verify they are an active admin before using the
// service-role key to create the auth user + app_users profile row.
//
// Deploy:  supabase functions deploy admin-create-user
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
//          injected automatically by Supabase for deployed functions.
//
// Body (JSON): { phone, name, role, pin, action?, target_id? }
//   action defaults to "create". action "reset_pin" updates an existing
//   user's PIN (pass target_id + pin).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// phone -> synthetic email used as the Supabase Auth identity.
const phoneToEmail = (phone: string) =>
  `${phone.replace(/[^\d]/g, "")}@vriddhi.local`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing token" }, 401);

  // 1. Verify the caller is an active admin (their own token, RLS applies).
  const callerClient = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: caller } = await callerClient.rpc("me");
  const profile = Array.isArray(caller) ? caller[0] : caller;
  if (!profile || profile.role !== "admin" || profile.is_active === false) {
    return json({ error: "Admin only" }, 403);
  }

  // 2. Parse + validate input.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const action = (body.action as string) ?? "create";
  const pin = String(body.pin ?? "");
  if (pin && !/^\d{6,}$/.test(pin)) {
    return json({ error: "PIN must be at least 6 digits" }, 400);
  }

  const admin = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- reset PIN -----------------------------------------------------
  if (action === "reset_pin") {
    const targetId = String(body.target_id ?? "");
    if (!targetId || !pin) return json({ error: "target_id and pin required" }, 400);
    const { error } = await admin.auth.admin.updateUserById(targetId, {
      password: pin,
    });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, id: targetId });
  }

  // ---- create --------------------------------------------------------
  const phone = String(body.phone ?? "").trim();
  const name = String(body.name ?? "").trim();
  const role = String(body.role ?? "customer");
  if (!phone || !name || !pin) return json({ error: "phone, name, pin required" }, 400);
  if (!["customer", "employee", "admin"].includes(role)) {
    return json({ error: "Invalid role" }, 400);
  }

  const email = phoneToEmail(phone);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
    user_metadata: { phone, name, role },
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? "Could not create user" }, 400);
  }

  // Insert the profile row (service role bypasses RLS).
  const { error: profErr } = await admin.from("app_users").insert({
    id: created.user.id,
    phone,
    name,
    role,
  });
  if (profErr) {
    // Roll back the orphan auth user so a retry can succeed.
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profErr.message }, 400);
  }

  return json({ ok: true, id: created.user.id, phone, name, role });
});
