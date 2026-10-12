// Everything Jarvis can do, from every connector, in one list — what the brain
// offers Claude and what quick commands call directly.
//
// A tool: {name, app, label(input), description, input_schema, run(input, ctx)}
// run() resolves {summary (for Claude), say (a plain answer for quick mode),
// images?: [{file, title}], links?: [{href, label}], app?}.
// ctx: {demo, today, attachments: Map(id -> {file, name}), confirm(card) ->
// Promise<boolean>, progress(text)}.

import { tools as cross, useRegistry } from './conn/cross.js';
import { tools as decant } from './conn/decant.js';
import { tools as fleet } from './conn/fleet.js';
import { tools as indents } from './conn/indents.js';
import { tools as ledgerOps } from './conn/ledger-ops.js';
import { tools as ledger } from './conn/ledger.js';
import { tools as loading } from './conn/loading.js';
import { tools as mac } from './conn/mac.js';
import { tools as money } from './conn/money.js';
import { tools as more } from './conn/more.js';

export const TOOLS = [...ledger, ...ledgerOps, ...decant, ...mac, ...fleet, ...loading, ...indents, ...money, ...more, ...cross];
export const byName = new Map(TOOLS.map((t) => [t.name, t]));
useRegistry(byName);

// the definitions sent to Claude (same order every time, so they cache)
export const apiTools = () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

// what the input must have (the schema's required fields, of the right kind)
export function checkInput(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'The input must be an object.';
  const props = tool.input_schema.properties || {};
  for (const k of tool.input_schema.required || []) {
    if (input[k] === undefined || input[k] === null || input[k] === '') return `"${k}" is required.`;
  }
  for (const [k, v] of Object.entries(input)) {
    const p = props[k];
    if (!p || v === undefined || v === null) continue;
    const ok = { string: typeof v === 'string', boolean: typeof v === 'boolean', number: typeof v === 'number', integer: Number.isInteger(v) }[p.type];
    if (ok === false) return `"${k}" must be a ${p.type}.`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}.`;
  }
  return null;
}

export async function runTool(name, input, ctx) {
  const tool = byName.get(name);
  if (!tool) return { ok: false, error: `No tool "${name}".` };
  const bad = checkInput(tool, input);
  if (bad) return { ok: false, error: bad };
  try {
    return { ok: true, result: await tool.run(input, ctx) };
  } catch (err) {
    console.error(name, err);
    return { ok: false, error: err?.message || String(err), needsLogin: err?.needsLogin, offline: err?.offline };
  }
}
