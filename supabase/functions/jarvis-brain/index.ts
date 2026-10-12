// =====================================================================
// Edge Function: jarvis-brain
// ---------------------------------------------------------------------
// The OPTIONAL Claude brain's link to Claude, so the Anthropic API key never
// reaches a phone. Deploy it in Jarvis's own project (vriddhi-jarvis):
//
//   supabase functions deploy jarvis-brain --project-ref otazjsvffvfortrmdred
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref otazjsvffvfortrmdred
//
// Jarvis's page uses the Anthropic SDK with this function as its base URL:
// the SDK's POST /v1/messages arrives here as .../jarvis-brain/v1/messages
// with the caller's Supabase login token. Only Jarvis members get through
// (jarvis_whoami); the request is checked (model, size, no streaming) and
// sent on to Claude with the key from the function's secrets.
// =====================================================================

import Anthropic from "npm:@anthropic-ai/sdk@0.129.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const BETAS = new Set(["server-side-fallback-2026-07-01"]);
const MAX_TOKENS = 16000;
const MAX_BODY = 12_000_000;           // ~ a few photos, base64

const corsFor = (req: Request) => ({
  "Access-Control-Allow-Origin": "*",
  // the SDK sends its own headers (anthropic-version, x-stainless-…): allow what's asked
  "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") ?? "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
});

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const fail = (status: number, message: string) =>
    json({ type: "error", error: { type: status === 401 || status === 403 ? "permission_error" : "invalid_request_error", message } }, status);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/v1/messages")) return fail(404, "Only POST /v1/messages.");

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return fail(500, "The jarvis-brain function has no ANTHROPIC_API_KEY secret yet.");

  // 1. A signed-in ledger member (their own token)
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return fail(401, "Sign in to Jarvis first.");
  const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: me, error: meErr } = await caller.rpc("jarvis_whoami");
  if (meErr || !me?.member) return fail(403, "This login is not on the Jarvis members list.");

  // 2. The request, checked
  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail(413, "The message is too large (photos too big?).");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Bad JSON.");
  }
  if (!MODELS.has(String(body.model))) return fail(400, `Model not allowed: ${body.model}`);
  if (body.stream) return fail(400, "Streaming isn't supported by this proxy.");
  body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
  const betas = (req.headers.get("anthropic-beta") ?? "").split(",").map((s) => s.trim()).filter((b) => BETAS.has(b));

  // 3. On to Claude
  const client = new Anthropic({ apiKey: key });
  try {
    // deno-lint-ignore no-explicit-any
    const msg = await client.beta.messages.create({ ...(body as any), betas });
    return json(msg);
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      return json(err.error ?? { type: "error", error: { type: "api_error", message: err.message } }, err.status ?? 502);
    }
    return fail(502, `Couldn't reach Claude: ${err instanceof Error ? err.message : String(err)}`);
  }
});
