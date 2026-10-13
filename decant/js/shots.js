// The day's automation screenshots, for the stock proof under a result
// picture — on any phone. Each one read here is kept on this phone
// (IndexedDB) and also put in the cloud: the picture, shrunk, in the private
// storage bucket `dec-shots`, and a `dec_shots` row with the readings it gave.
// The tank-stock agent (tank_stock/ on the India server) adds its own the
// same way. A result made on any phone that day finds them; a day's are
// deleted the next day, here and in the cloud, by the first phone that looks.

import { istDate } from './core.js';
import { cloudClient } from './store.js';

const DB = 'vriddhi-decant-shots';     // not 'vriddhi-decant': store.js clears that old one
const STORE = 'shots';
const KEEP = 40;                       // a day's most; the oldest go first
const BUCKET = 'dec-shots';
const MAX_SIDE = 1600;                 // px: the figures stay readable, the file small
const mem = [];                        // without IndexedDB (a private tab): this visit only
const fetched = new Map();             // cloud shot id -> Blob, this visit
let dbp = null;

function openDb() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbp;
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Today's screenshots on this phone, oldest first; earlier days' are deleted on the way.
async function todays() {
  const today = istDate(Date.now());
  for (let i = mem.length - 1; i >= 0; i -= 1) if (mem[i].day !== today) mem.splice(i, 1);
  const db = await openDb();
  let rows = [];
  if (db) {
    try { rows = (await run(db, 'readonly', (s) => s.getAll())) || []; } catch { rows = []; }
    const old = rows.filter((r) => r.day !== today);
    if (old.length) run(db, 'readwrite', (s) => { old.forEach((r) => s.delete(r.id)); }).catch(() => {});
  }
  return [...rows.filter((r) => r.day === today), ...mem].sort((a, b) => a.at - b.at);
}

// A JPEG no bigger than MAX_SIDE (the original if it can't be redrawn here).
async function shrink(blob) {
  try {
    const img = await createImageBitmap(blob);
    const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * k);
    canvas.height = Math.round(img.height * k);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close?.();
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return out && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  }
}

// Put one of this phone's screenshots in the cloud. True once it's there.
async function upload(shot) {
  const client = cloudClient();
  if (!client) return false;
  const body = await shrink(shot.blob);
  const ext = body.type === 'image/png' ? 'png' : body.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${shot.day}/${shot.id}.${ext}`;
  const put = await client.storage.from(BUCKET).upload(path, body, { contentType: body.type || 'image/jpeg', upsert: true });
  if (put.error) return false;
  const row = await client.from('dec_shots').upsert({
    id: shot.id, day: shot.day, at: new Date(shot.at).toISOString(), readings: shot.readings, path, source: 'phone',
  }, { onConflict: 'id' });
  return !row.error;
}

async function markUploaded(shot) {
  shot.uploaded = true;
  const db = await openDb();
  if (db && !mem.includes(shot)) run(db, 'readwrite', (s) => s.put(shot)).catch(() => {});
}

async function share(shot) {
  try {
    if (await upload(shot)) await markUploaded(shot);
  } catch { /* offline: tried again when the app next opens */ }
}

// Keep a screenshot with the readings it gave ({tankId: reading}).
export async function keepShot(blob, readings) {
  const marks = Object.fromEntries(Object.entries(readings).map(([id, r]) => [id, { readingAt: r.readingAt, volume: r.volume }]));
  if (!blob || !Object.keys(marks).length) return;
  const shot = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, day: istDate(Date.now()), at: Date.now(), readings: marks, blob, uploaded: false };
  const db = await openDb();
  let saved = false;
  if (db) {
    try { await run(db, 'readwrite', (s) => s.put(shot)); saved = true; } catch { /* storage full or blocked */ }
  }
  if (!saved) mem.push(shot);
  share(shot);                                      // in the background
  const all = await todays();
  const extra = all.slice(0, Math.max(0, all.length - KEEP));
  if (!extra.length) return;
  for (const x of extra) { const i = mem.indexOf(x); if (i >= 0) mem.splice(i, 1); }
  if (db) run(db, 'readwrite', (s) => { extra.forEach((x) => s.delete(x.id)); }).catch(() => {});
}

// Today's screenshots from the cloud (other phones', the agent's), without
// their pictures: [{id, day, at, readings, path, cloud: true}].
async function cloudTodays() {
  const client = cloudClient();
  if (!client) return [];
  try {
    const { data, error } = await client.from('dec_shots').select('id,day,at,readings,path')
      .eq('day', istDate(Date.now())).order('at').limit(200);
    if (error) return [];
    return (data || []).map((r) => ({ ...r, at: Date.parse(r.at), readings: r.readings || {}, cloud: true }));
  } catch {
    return [];
  }
}

async function pictureOf(shot) {
  if (shot.blob) return shot.blob;
  if (fetched.has(shot.id)) return fetched.get(shot.id);
  const client = cloudClient();
  if (!client) return null;
  try {
    const { data, error } = await client.storage.from(BUCKET).download(shot.path);
    if (error || !data) return null;
    fetched.set(shot.id, data);
    return data;
  } catch {
    return null;
  }
}

// Today's screenshots behind these tank rows' before / after readings:
// [{shot, uses: [{tank, which, readingAt}]}], in the rows' order, each tank's
// before ahead of its after (so a two-wide picture pairs them on one line).
// One screenshot per tank's before and one per its after: the last one read
// that gave the reading kept (the same screen read twice shows once); one
// screenshot that holds several tanks' readings shows once for all of them.
// This phone's and the cloud's (any phone's, the agent's) count alike; each
// picked one comes with its picture (shot.blob).
export async function shotsFor(rows) {
  const local = await todays();
  const ids = new Set(local.map((s) => s.id));
  const shots = [...local, ...(await cloudTodays()).filter((s) => !ids.has(s.id))]
    .sort((a, b) => a.at - b.at);                    // oldest first
  const picked = new Map();                          // shot -> {shot, uses, key}
  for (const [ti, t] of (rows || []).entries()) {
    for (const which of ['before', 'after']) {
      const r = t[which];
      if (!r || !/^photo/.test(r.source || '')) continue;
      let last = null;
      for (const shot of shots) {
        const m = shot.readings[t.tank];
        if (m && r.readingAt === m.readingAt && Math.abs((r.volume ?? NaN) - m.volume) < 0.005) last = shot;
      }
      if (!last) continue;
      const e = picked.get(last) || { shot: last, uses: [], key: Infinity };
      e.uses.push({ tank: t.tank, which, readingAt: r.readingAt });
      e.key = Math.min(e.key, ti * 2 + (which === 'after' ? 1 : 0));
      picked.set(last, e);
    }
  }
  const out = [];
  for (const e of [...picked.values()].sort((a, b) => a.key - b.key || a.shot.at - b.shot.at)) {
    const blob = await pictureOf(e.shot);
    if (blob) out.push({ ...e, shot: { ...e.shot, blob } });
  }
  return out;
}

// Earlier days' screenshots out of the cloud: rows and files (and files
// whose row never made it).
async function tidyCloud() {
  const client = cloudClient();
  if (!client) return;
  const today = istDate(Date.now());
  const store = client.storage.from(BUCKET);
  const { data: old } = await client.from('dec_shots').select('id,path').lt('day', today).limit(500);
  const paths = new Set((old || []).map((r) => r.path));
  const { data: folders } = await store.list('', { limit: 100 });
  for (const f of folders || []) {
    if (!/^\d{4}-\d\d-\d\d$/.test(f.name) || f.name >= today) continue;
    const { data: files } = await store.list(f.name, { limit: 1000 });
    for (const x of files || []) paths.add(`${f.name}/${x.name}`);
  }
  if (paths.size) await store.remove([...paths]);
  if (old?.length) await client.from('dec_shots').delete().lt('day', today);
}

// On opening the app: clear earlier days' screenshots (here and in the
// cloud) and put any of today's that didn't reach the cloud there.
export function tidyShots() {
  todays().catch(() => {});
  let tries = 0;
  const once = async () => {
    if (!cloudClient()) {                            // the cloud connects a moment later
      if ((tries += 1) < 30) setTimeout(once, 2000);
      return;
    }
    try {
      for (const shot of await todays()) if (!shot.uploaded) await share(shot);
      await tidyCloud();
    } catch { /* offline: next time */ }
  };
  once();
}

// Settings → clear this phone's copy (the cloud's goes the next day anyway).
export async function clearShots() {
  mem.length = 0;
  fetched.clear();
  const db = dbp ? await dbp : null;
  db?.close();
  dbp = null;
  try { indexedDB.deleteDatabase(DB); } catch { /* ignore */ }
}
