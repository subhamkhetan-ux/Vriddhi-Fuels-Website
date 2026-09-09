// =====================================================================
// Edge Function: loading-notify   (Tanker Loading app)
// ---------------------------------------------------------------------
// Sends a Web Push to every OTHER signed-in employee when a tanker's
// loading state changes:
//   "start"    -> first diesel went into an empty tanker
//   "resume"   -> loading picked up again after a gap of 3h or more
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
// Pinned: an unpinned "@2" re-resolves to whatever is latest at deploy time,
// so identical code could behave differently between two deploys.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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

  // Who is calling? Their own device is excluded from the send.
  //
  // This must be done with a client carrying the CALLER's token, not the
  // service-role client: a service key is not a user token, and asking that
  // client to resolve one fails outright — which surfaced as "Not signed in"
  // for a perfectly valid session. The gateway has already verified the token's
  // signature before we run, so this is a lookup, not a trust decision.
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
    ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
    ?? req.headers.get("apikey") ?? "";
  let actorId = "";
  let actor = "someone";
  const asUser = createClient(url, anonKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoErr } = await asUser.auth.getUser();
  if (who?.user) {
    actorId = who.user.id;
    actor = (who.user.email ?? "").split("@")[0] || "someone";
  } else {
    // Older path, kept as a fallback in case the anon key isn't in the env.
    const alt = await admin.auth.getUser(auth.slice(7));
    if (alt.data?.user) {
      actorId = alt.data.user.id;
      actor = (alt.data.user.email ?? "").split("@")[0] || "someone";
    } else {
      const why = whoErr?.message || alt.error?.message || "token not accepted";
      console.error("could not identify caller:", why);
      return json({ error: "Could not identify you: " + why }, 401);
    }
  }
  console.log(`caller=${actor} (${actorId})`);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const event = String(body.event ?? "");
  const plate = String(body.vehicle ?? "").trim();
  const remark = String(body.remark ?? "").trim().slice(0, 80);
  // The calling phone's own push endpoint, so we can leave that one device out.
  // Absent field and empty string mean different things: absent is a client
  // from before this was added, empty is a phone telling us it has no
  // subscription at all (notifications switched off there).
  const hasEndpointField = Object.prototype.hasOwnProperty.call(body, "endpoint");
  const selfEndpoint = String(body.endpoint ?? "");
  if (!["start", "resume", "complete", "sold", "test"].includes(event)) {
    return json({ error: "Unknown event" }, 400);
  }
  if (!plate && event !== "test") return json({ error: "vehicle required" }, 400);

  // Authoritative litres straight from the tanker row. A test needs no tanker.
  let cap = 0, now = 0, left = 0;
  if (event !== "test") {
    const { data: veh } = await admin.from("loading_vehicles")
      .select("plate, caps, fill").eq("plate", plate).maybeSingle();
    if (!veh) return json({ error: "Unknown tanker" }, 404);
    const caps: number[] = (Array.isArray(veh.caps) ? veh.caps : []).map(Number);
    const fill: Record<string, number> = veh.fill ?? {};
    cap = caps.reduce((s, c) => s + (Number(c) || 0), 0);
    now = caps.reduce((s, _c, i) => s + (Number(fill["C" + (i + 1)]) || 0), 0);
    left = Math.max(cap - now, 0);
  }

  // For a resumed loading, work out how long it stood idle from the two most
  // recent loadings on the database's own clock — [0] is the one that just
  // landed, [1] the one before it — rather than trusting a figure from a phone.
  let idle = "";
  if (event === "resume") {
    const { data: recent } = await admin.from("loading_events")
      .select("created_at").eq("vehicle", plate).eq("kind", "load")
      .order("created_at", { ascending: false }).limit(2);
    if (recent && recent.length === 2) {
      const h = (Date.parse(recent[0].created_at) - Date.parse(recent[1].created_at)) / 3600000;
      if (h >= 1) idle = h >= 24 ? ` after ${Math.round(h / 24)}d idle` : ` after ${Math.round(h)}h idle`;
    }
  }

  let title: string, text: string;
  if (event === "test") {
    title = "🔔 Notifications are working";
    text = `Test sent from ${actor}'s phone. Loading alerts will arrive like this.`;
  } else if (event === "start") {
    title = `🛢️ ${plate} — loading started`;
    text = `${L(now)} L in · ${L(left)} L to fill · by ${actor}`;
  } else if (event === "resume") {
    title = `🔄 ${plate} — loading resumed${idle}`;
    text = `${L(now)} L in · ${L(left)} L to fill · by ${actor}`;
  } else if (event === "complete") {
    title = `✅ ${plate} — tanker full`;
    text = `${L(cap)} L loaded. Ready to send for sale · by ${actor}`;
  } else {
    title = `🚚 ${plate} — sent for sale`;
    text = (remark ? `Sold to ${remark} · ` : "") + `tanker emptied · by ${actor}`;
  }
  const payload = JSON.stringify({
    title, body: text, url: "./",
    // A fresh tag per test, so tapping it twice shows two notifications rather
    // than the second silently replacing the first.
    tag: event === "test" ? `loading-test-${Date.now()}` : `loading-${plate}-${event}`,
  });

  // Pick the recipients.
  //   test  -> only the phone that asked, so one person can prove it works.
  //   else  -> every phone EXCEPT the device that raised this.
  //
  // Exclusion is by device, never by account: staff commonly share a single
  // login, so excluding the whole user would silence every phone at once.
  //
  // A phone with notifications switched off sends endpoint:"" — it has no
  // subscription, so there is nothing to exclude and everyone else must still
  // be told. Falling back to the account-level filter here was what made a
  // transaction from a notifications-off phone notify nobody at all.
  let q = admin.from("loading_push_subs").select("endpoint, p256dh, auth, user_id");
  let subs: { endpoint: string; p256dh: string; auth: string; user_id: string }[] | null = [];
  let subsErr: { message: string } | null = null;

  if (event === "test" && !selfEndpoint) {
    // Nothing to test against: this phone holds no subscription. Say so rather
    // than pushing to other people's phones and calling it a success.
    console.log("test requested by a phone with no subscription of its own");
  } else {
    if (event === "test") q = q.eq("endpoint", selfEndpoint);
    else if (selfEndpoint) q = q.neq("endpoint", selfEndpoint);
    else if (!hasEndpointField) q = q.neq("user_id", actorId);   // pre-endpoint client
    // else: sender has no subscription — exclude nothing, notify everyone.
    const r = await q;
    subs = r.data;
    subsErr = r.error;
  }
  if (subsErr) {
    console.error("could not read subscriptions:", subsErr.message);
    return json({ error: "Could not read subscriptions: " + subsErr.message }, 500);
  }
  console.log(`event=${event} vehicle=${plate} by=${actor} recipients=${subs?.length ?? 0}`);

  let sent = 0;
  const stale: string[] = [];
  const errors: string[] = [];
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
    } catch (e) {
      const err = e as { statusCode?: number; body?: string; message?: string };
      const code = err.statusCode;
      // 404/410 = the browser threw this subscription away; stop trying it.
      if (code === 404 || code === 410) { stale.push(s.endpoint); continue; }
      // Anything else is a real failure. It used to be swallowed here, which
      // made a totally dead push setup look like a clean run — log it and hand
      // it back so the app can say what went wrong.
      const msg = `${code ?? "no status"}: ${err.body || err.message || String(e)}`;
      errors.push(msg);
      console.error("push failed for one device:", msg);
    }
  }
  if (stale.length) await admin.from("loading_push_subs").delete().in("endpoint", stale);
  console.log(`sent=${sent} dropped_stale=${stale.length} failed=${errors.length}`);

  return json({ ok: true, sent, recipients: subs?.length ?? 0, stale: stale.length, errors });
});
