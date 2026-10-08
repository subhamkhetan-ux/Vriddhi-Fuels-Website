// The automation screenshots read on this phone, kept on this phone only
// (IndexedDB — never synced or uploaded) until the end of the day they were
// read (IST), so the result pictures made here that day can show the stock
// proof under the figures. A screenshot from an earlier day is cleared the
// next time the app looks.

import { istDate } from './core.js';

const DB = 'vriddhi-decant-shots';     // not 'vriddhi-decant': store.js clears that old one
const STORE = 'shots';
const KEEP = 40;                       // a day's most; the oldest go first
const mem = [];                        // without IndexedDB (a private tab): this visit only
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

// Today's screenshots, oldest first; earlier days' are deleted on the way.
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

// Keep a screenshot with the readings it gave ({tankId: reading}).
export async function keepShot(blob, readings) {
  const marks = Object.fromEntries(Object.entries(readings).map(([id, r]) => [id, { readingAt: r.readingAt, volume: r.volume }]));
  if (!blob || !Object.keys(marks).length) return;
  const shot = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, day: istDate(Date.now()), at: Date.now(), readings: marks, blob };
  const db = await openDb();
  let saved = false;
  if (db) {
    try { await run(db, 'readwrite', (s) => s.put(shot)); saved = true; } catch { /* storage full or blocked */ }
  }
  if (!saved) mem.push(shot);
  const all = await todays();
  const extra = all.slice(0, Math.max(0, all.length - KEEP));
  if (!extra.length) return;
  for (const x of extra) { const i = mem.indexOf(x); if (i >= 0) mem.splice(i, 1); }
  if (db) run(db, 'readwrite', (s) => { extra.forEach((x) => s.delete(x.id)); }).catch(() => {});
}

// Today's screenshots behind these tank rows' before / after readings:
// [{shot, uses: [{tank, which, readingAt}]}], in the rows' order, each tank's
// before ahead of its after (so a two-wide picture pairs them on one line).
// One screenshot per tank's before and one per its after: the last one read
// that gave the reading kept (the same screen read twice shows once); one
// screenshot that holds several tanks' readings shows once for all of them.
export async function shotsFor(rows) {
  const shots = await todays();                      // oldest first
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
  return [...picked.values()].sort((a, b) => a.key - b.key || a.shot.at - b.shot.at);
}

// On opening the app: clear earlier days' screenshots.
export function tidyShots() {
  todays().catch(() => {});
}

// Settings → clear this phone's copy.
export async function clearShots() {
  mem.length = 0;
  const db = dbp ? await dbp : null;
  db?.close();
  dbp = null;
  try { indexedDB.deleteDatabase(DB); } catch { /* ignore */ }
}
