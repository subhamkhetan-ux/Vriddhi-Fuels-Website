// =====================================================================
// Edge Function: notify
// ---------------------------------------------------------------------
// Sends Web Push notifications for app events:
//   - event "created"   -> notify all active staff (employee/admin); if the
//                          indent is Awaiting (staff logged on behalf), also
//                          notify the customer to approve.
//   - event "delivered" -> notify the customer to acknowledge receipt.
//
// The caller sends their own access token; recipients + payloads are decided
// here and pushes are sent with the service-role key + VAPID keys.
//
// Deploy:  supabase functions deploy notify
// Secrets (set once):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
// =====================================================================

import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const qtyText = (order_type: string, value: number) =>
  order_type === "Litres" ? `${value} L` : `₹${Number(value).toLocaleString("en-IN")}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Missing token" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@vriddhi.local";
  if (!pub || !priv) return json({ error: "VAPID keys not set" }, 500);
  webpush.setVapidDetails(subject, pub, priv);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const event = String(body.event ?? "");
  const indentId = String(body.indent_id ?? "");
  if (!indentId) return json({ error: "indent_id required" }, 400);

  const admin = createClient(url, service, { auth: { persistSession: false } });

  const { data: indent } = await admin.from("indents").select("*").eq("id", indentId).maybeSingle();
  if (!indent) return json({ error: "Indent not found" }, 404);

  const { data: cust } = await admin.from("app_users").select("name").eq("id", indent.customer_id).maybeSingle();
  const custName = cust?.name ?? "Customer";

  // Build the list of { userIds, payload } messages for this event.
  const messages: { ids: string[]; payload: { title: string; body: string; url: string; tag?: string } }[] = [];

  if (event === "created") {
    const { data: staff } = await admin.from("app_users").select("id")
      .in("role", ["employee", "admin"]).eq("is_active", true);
    const staffIds = (staff ?? []).map((s) => s.id);
    messages.push({
      ids: staffIds,
      payload: {
        title: `New indent ${indent.code}`,
        body: `${custName} · ${indent.product} · ${qtyText(indent.order_type, indent.value)}`,
        url: "./", tag: `indent-${indent.code}`,
      },
    });
    if (indent.status === "Awaiting") {
      messages.push({
        ids: [indent.customer_id],
        payload: {
          title: `Approve indent ${indent.code}`,
          body: `Please approve: ${indent.product} · ${qtyText(indent.order_type, indent.value)}`,
          url: "./", tag: `approve-${indent.code}`,
        },
      });
    }
  } else if (event === "delivered") {
    const q = qtyText(indent.order_type, indent.delivered_value ?? indent.value);
    messages.push({
      ids: [indent.customer_id],
      payload: {
        title: `Fuel delivered — ${indent.code}`,
        body: `${q} of ${indent.product} delivered. Please acknowledge receipt.`,
        url: "./", tag: `delivered-${indent.code}`,
      },
    });
  } else {
    return json({ error: "Unknown event" }, 400);
  }

  // Fetch subscriptions for all target users and send.
  const allIds = [...new Set(messages.flatMap((m) => m.ids))];
  if (!allIds.length) return json({ ok: true, sent: 0 });
  const { data: subs } = await admin.from("push_subscriptions").select("*").in("user_id", allIds);
  const byUser: Record<string, typeof subs> = {};
  for (const s of subs ?? []) (byUser[s.user_id] ||= []).push(s);

  let sent = 0;
  const stale: string[] = [];
  for (const m of messages) {
    const payload = JSON.stringify(m.payload);
    for (const uid of m.ids) {
      for (const s of byUser[uid] ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) stale.push(s.endpoint);
        }
      }
    }
  }
  if (stale.length) await admin.from("push_subscriptions").delete().in("endpoint", stale);

  return json({ ok: true, sent });
});
