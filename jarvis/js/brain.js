// The brain: Claude with Jarvis's tools. The owner's words (and pictures) go
// in; Claude picks the tools, Jarvis runs them here in the browser (where the
// logins and the apps' code are), and the results go back until Claude has
// the answer.
//
// The key: either the jarvis-brain Edge Function in the ledger project (the
// API key stays in Supabase; only ledger members get through) or the owner's
// own API key kept on this device.

import { apiTools, byName, runTool } from './tools.js';

const SDK = 'https://esm.sh/@anthropic-ai/sdk@0.129.0';
export const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 10;

let sdk = null;
const loadSdk = () => (sdk || (sdk = import(SDK).then((m) => m.default)));

// cloud: {url, token, anonKey} (the Edge Function) | key: the owner's API key
export async function makeClient({ cloud = null, key = null }) {
  const Anthropic = await loadSdk();
  if (cloud) {
    return new Anthropic({
      baseURL: cloud.url, apiKey: null, authToken: cloud.token,
      defaultHeaders: { apikey: cloud.anonKey }, dangerouslyAllowBrowser: true, maxRetries: 1,
    });
  }
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 });
}

export function systemPrompt(today, { demo = false } = {}) {
  return `You are Jarvis, the personal assistant of the owner of Vriddhi Fuels — an IndianOil fuel station (diesel/HSD, petrol/MS, XtraGreen) that also supplies bulk diesel to companies by tanker — and of Shree Shyam Fleet (bulkers on contract with SSFC). The owner talks to you by chat or voice, in English, Hindi or Hinglish, often from the forecourt.

You run the business's apps through your tools: Ledger (sales, outstanding, statements), Decant (underground tank stock, decanting tank trucks), the XtraPower CCMS monitor and other scripts on the owner's Mac, Fleet, Loading (our delivery tankers), Payments (bank credits), and links to every app.

How to work:
- Every figure must come from a tool. Never guess or remember numbers; if a tool fails, say what failed and what the owner can do.
- Pictures a tool makes (outstanding cards, ledger pages) are shown to the owner with Share and Download buttons — don't describe them, just give the key figure.
- When the owner attaches a picture of tank stock / the automation screen, call decant_update_stock_from_photo with its attachment id. The app asks the owner to confirm before saving; if the reading you get back disagrees with what you see in the picture, say which tank.
- Write actions (saving stock, running a Mac script) are confirmed by the owner in the app. If a result says declined_by_owner, accept it and don't retry.
- If a name matches several customers or accounts, ask which one (list them briefly). If a tool says the owner isn't signed in or the Mac is offline, pass on its instructions.
- "Monitor <account>" means start watching that XtraPower account (xtrapower_watch).
- Several independent questions: call the tools together in one step.

How to answer:
- Short and spoken-style: one to three sentences, the figure first. No tables or headings; at most a short list. Your reply may be read aloud.
- Money in rupees with Indian grouping (₹12,34,567); litres with "L". A positive ledger balance means the customer owes us; negative means they paid in advance.
- Reply in the owner's language (Hinglish if they use it).

Today is ${today} (India).${demo ? ' This is the DEMO: all data is made up; nothing real is changed.' : ''}`;
}

// A conversation with Claude. History is append-only (Claude's thinking stays
// valid only if earlier turns are never changed): every response is kept
// whole, and a failed turn is dropped from the end as a unit.
export class Brain {
  constructor({ getClient, effort = 'medium' }) {
    this.getClient = getClient;
    this.effort = effort;
    this.history = [];
  }

  reset() { this.history = []; }

  // content: the user's message blocks. on: {text(t), step(tool, input, status, result), } -> final text
  async turn(content, ctx, on = {}) {
    const start = this.history.length;
    this.history.push({ role: 'user', content });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const client = await this.getClient();
        const res = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 16000,
          system: systemPrompt(ctx.today, { demo: ctx.demo }),
          tools: apiTools(),
          messages: this.history,
          output_config: { effort: this.effort },
          cache_control: { type: 'ephemeral' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
        if (res.stop_reason === 'refusal') {
          if (res.content.length) this.history.push({ role: 'assistant', content: res.content });
          else this.history.length = start;
          return 'Sorry — I can\'t help with that one.';
        }
        this.history.push({ role: 'assistant', content: res.content });
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (res.stop_reason === 'pause_turn') continue;
        if (res.stop_reason !== 'tool_use') return text || (res.stop_reason === 'max_tokens' ? '(The answer was cut short.)' : '');
        if (text && on.text) on.text(text);
        const calls = res.content.filter((b) => b.type === 'tool_use');
        // independent calls run together; every result goes back in one message
        const results = await Promise.all(calls.map(async (c) => {
          on.step?.(c.name, c.input, 'running');
          const out = await runTool(c.name, c.input, ctx);
          on.step?.(c.name, c.input, out.ok ? 'done' : 'failed', out);
          const body = out.ok ? out.result.summary ?? out.result.say ?? 'Done.' : { error: out.error };
          return { type: 'tool_result', tool_use_id: c.id, content: clip(typeof body === 'string' ? body : JSON.stringify(body)), ...(out.ok ? {} : { is_error: true }) };
        }));
        this.history.push({ role: 'user', content: results });
      }
      return 'That took too many steps — please ask again more simply.';
    } catch (err) {
      this.history.length = start;                 // the turn never happened
      throw friendly(err);
    }
  }
}

const clip = (s, max = 12000) => (s.length > max ? `${s.slice(0, max)}… (cut)` : s);

function friendly(err) {
  const status = err?.status;
  const msg = err?.error?.error?.message || err?.message || String(err);
  let text = msg;
  if (status === 401) text = 'The AI key was refused. Check it in ⚙ Settings → Brain.';
  else if (status === 403) text = msg.includes('members') ? msg : 'Not allowed to use the brain with this login.';
  else if (status === 404) text = 'The jarvis-brain function isn\'t deployed yet (see jarvis/README.md), or the brain URL is wrong.';
  else if (status === 429) text = 'The AI is busy (rate limit). Try again in a minute.';
  else if (status >= 500) text = msg.includes('ANTHROPIC_API_KEY') ? msg : 'The AI service had a problem. Try again shortly.';
  else if (/fetch|network|Failed to/i.test(msg)) text = 'Couldn\'t reach the AI — check the internet connection.';
  const e = new Error(text);
  e.status = status;
  return e;
}

export const toolLabel = (name, input) => {
  const t = byName.get(name);
  try { return t ? t.label(input || {}) : name; } catch { return name; }
};
