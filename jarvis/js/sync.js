// What follows the owner from device to device, kept in Jarvis's own project
// (jarvis_state_get / jarvis_state_save, supabase/jarvis-schema.sql):
//   settings  voice, language, brain choice (never an API key)
//   history   the recent conversation (text only, last 40 lines)
//   memory    the built-in brain's thread ("his statement" works on the next device)

import { client } from './session.js';

const MAX_LINES = 40;
let timer = null;
let queued = {};
export const synced = { at: null, error: '' };

export async function whoami() {
  const c = await client('jarvis');
  const { data, error } = await c.rpc('jarvis_whoami');
  if (error) throw new Error(error.message);
  return data;
}

// the first login becomes the owner; later ones must be added by the owner
export async function claimOwner() {
  const c = await client('jarvis');
  const { data, error } = await c.rpc('jarvis_claim_owner');
  if (error) throw new Error(error.message);
  return data;
}

export async function loadState() {
  const c = await client('jarvis');
  const { data, error } = await c.rpc('jarvis_state_get');
  if (error) throw new Error(error.message);
  synced.at = data?.updated_at || null;
  return data;
}

// save soon (several changes in a row go as one)
export function saveState(patch) {
  queued = { ...queued, ...patch };
  clearTimeout(timer);
  timer = setTimeout(flush, 1200);
}

export async function flush() {
  clearTimeout(timer);
  const patch = queued;
  queued = {};
  if (!Object.keys(patch).length) return;
  try {
    const c = await client('jarvis');
    const { data, error } = await c.rpc('jarvis_state_save', { p_patch: patch });
    if (error) throw new Error(error.message);
    synced.at = data;
    synced.error = '';
  } catch (e) {
    synced.error = e.message;
    queued = { ...patch, ...queued };                     // try again with the next change
  }
}

export const trimHistory = (lines) => lines.slice(-MAX_LINES).map((l) => ({ role: l.role, text: String(l.text || '').slice(0, 2000), at: l.at }));

// settings that travel (the API key stays on the device)
export const portable = (s) => {
  const { key: _k, ...rest } = s;
  return rest;
};
