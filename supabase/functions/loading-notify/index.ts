// =====================================================================
// Edge Function: loading-notify   (Tanker Loading app)
// ---------------------------------------------------------------------
// Sends a Web Push to every OTHER signed-in employee when a tanker's
// loading state changes:
//   "start"    -> first diesel went into an empty tanker
//   "complete" -> the tanker just became full
//   "sold"     -> the tanker was sent for sale and emptied
//
// The caller sends their own access token; we resolve who they are from it
// and skip their own phones, so nobody is notified about their own tap.
// The litres in the message are read from the database here, not taken from
// the request body, so the text can't be spoofed by a client.
//
// Deploy (Supabase dashboard -> Edge Functions -> Deploy, or CLI):
//   supabase functions deploy loading-notify
// Secrets (set once):
//   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
//                        VAPID_SUBJECT=mailto:you@example.com
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
// =====================================================================

import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const L = (n: number) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

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

  const admin = createClient(url, service, { auth: { persistSession: false } });

  // Who is calling? Their own phones are excluded from the send.
  const { data: who, error: whoErr } = await admin.auth.getUser(auth.slice(7));
  if (whoErr || !who?.user) return json({ error: "Not signed in" }, 401);
  const actorId = who.user.id;
  const actor = (who.user.email ?? "").split("@")[0] || "someone";

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const event = String(body.event ?? "");
  const plate = String(body.vehicle ?? "").trim();
  const remark = String(body.remark ?? "").trim().slice(0, 80);
  if (!plate) return json({ error: "vehicle required" }, 400);
  if (!["start", "complete", "sold"].includes(event)) return json({ error: "Unknown event" }, 400);

  // Authoritative litres straight from the tanker row.
  const { data: veh } = await admin.from("loading_vehicles")
    .select("plate, caps, fill").eq("plate", plate).maybeSingle();
  if (!veh) return json({ error: "Unknown tanker" }, 404);

  const caps: number[] = (Array.isArray(veh.caps) ? veh.caps : []).map(Number);
  const fill: Record<string, number> = veh.fill ?? {};
  const cap = caps.reduce((s, c) => s + (Number(c) || 0), 0);
  const now = caps.reduce((s, _c, i) => s + (Number(fill["C" + (i + 1)]) || 0), 0);
  const left = Math.max(cap - now, 0);

  let title: string, text: string;
  if (event === "start") {
    title = `🛢️ ${plate} — loading started`;
    text = `${L(now)} L in · ${L(left)} L to fill · by ${actor}`;
  } else if (event === "complete") {
    title = `✅ ${plate} — tanker full`;
    text = `${L(cap)} L loaded. Ready to send for sale · by ${actor}`;
  } else {
    title = `🚚 ${plate} — sent for sale`;
    text = (remark ? `Sold to ${remark} · ` : "") + `tanker emptied · by ${actor}`;
  }
  const payload = JSON.stringify({
    title, body: text, url: "./", tag: `loading-${plate}-${event}`,
  });

  // Everyone's phones except the person who pressed the button.
  const { data: subs } = await admin.from("loading_push_subs")
    .select("endpoint, p256dh, auth, user_id").neq("user_id", actorId);

  let sent = 0;
  const stale: string[] = [];
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410 = the browser threw this subscription away; stop trying it.
      if (code === 404 || code === 410) stale.push(s.endpoint);
    }
  }
  if (stale.length) await admin.from("loading_push_subs").delete().in("endpoint", stale);

  return json({ ok: true, sent });
});
