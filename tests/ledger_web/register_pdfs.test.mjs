// The monthly register PDFs job (GitHub → Google Drive): which month and when,
// the Drive folder and file names, and the Drive calls (with a stand-in fetch).
import assert from 'node:assert/strict';
import test from 'node:test';

import { accessToken, drive } from '../../ledger/tools/drive.mjs';
import { documentHtml, fyFolder, lastMonth, pdfNames, plan, todayIST } from '../../ledger/tools/register_pdfs.mjs';
import { monthPagesHtml } from '../../ledger/js/register-view.js';
import { demoRegister } from '../../ledger/js/register-demo.js';
import { memoryStore } from '../../ledger/js/store.js';

test('register PDFs: the month, its financial-year folder and file names', () => {
  assert.equal(todayIST(Date.UTC(2026, 10, 30, 19, 0)), '2026-12-01');      // 00:30 on the 1st in India
  assert.equal(lastMonth('2026-12-01'), '2026-11');
  assert.equal(lastMonth('2027-01-03'), '2026-12');
  assert.equal(fyFolder('2026-11'), 'FY 2026-27');
  assert.equal(fyFolder('2027-03'), 'FY 2026-27');
  assert.equal(fyFolder('2027-04'), 'FY 2027-28');
  assert.deepEqual(pdfNames('2026-11'), { dsr: 'November 2026 Real DSR.pdf', stock: 'November 2026 Stock Register.pdf' });
});

test('register PDFs: waits for the month\'s closing readings, until the 5th', () => {
  const days = (closed) => Array.from({ length: 31 }, (_, i) => ({ test: 10, receipt: null, meters: i < 30 || closed ? [100 * i] : null }));
  const all = (closed) => ({ 'dsr:2026-11': { data: { month: '2026-11', products: { MS: { open: 0, nozzles: [], days: days(closed) } } } } });
  assert.deepEqual(plan(all(false), '2026-12-02'), { month: '2026-11', go: false, why: 'waiting for November 2026\'s closing readings (the E-DSR\'s last row)' });
  assert.equal(plan(all(true), '2026-12-02').go, true);                     // the 1 Dec readings are in
  assert.equal(plan(all(false), '2026-12-05').go, true);                    // the 5th: whatever there is
  assert.equal(plan({}, '2026-12-02').go, false);                           // nothing kept for November
  assert.equal(plan(all(false), '2026-12-02', { month: '2026-11' }).go, true);   // asked for
  // the next month has come in: November is complete
  assert.equal(plan({ ...all(false), 'dsr:2026-12': { data: { month: '2026-12', products: {} } } }, '2026-12-02').go, true);
});

test('register PDFs: a page per product in one printable document', async () => {
  const all = await memoryStore({ register: demoRegister(new Date(2026, 10, 12)) }).register();
  const pages = monthPagesHtml(all, '2026-11', 'dsr');
  assert.equal(pages.length, 3);
  assert.match(pages[0], /PRODUCT : HSD/);
  assert.match(pages[1], /PRODUCT - MS/);
  assert.match(pages[2], /PRODUCT - XTRAGREEN/);
  assert.doesNotMatch(pages.join(''), /class="today"| hl"/);               // as printed: nothing highlighted
  const doc = documentHtml('.paper{}', monthPagesHtml(all, '2026-11', 'stock'));
  assert.equal((doc.match(/class="sheet"/g) || []).length, 3);
  assert.match(doc, /@page \{ size: A4 landscape/);
});

test('register PDFs: Google Drive — the folder made where missing, a file uploaded or a new version', async () => {
  const calls = [];
  const fake = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url, opts.body]);
    const json = (x) => ({ ok: true, status: 200, json: async () => x, text: async () => JSON.stringify(x) });
    if (url.includes('oauth2')) return json({ access_token: 'acc' });
    if (opts.method === 'POST' && url.endsWith('/files?supportsAllDrives=true')) return json({ id: `new-${JSON.parse(opts.body).name}` });
    if (url.includes('/files?q=') || url.includes('/files?')) {
      const q = decodeURIComponent(new URL(url).searchParams.get('q'));
      if (q.includes("name = 'Vriddhi Fuels'")) return json({ files: [{ id: 'vf' }] });
      if (q.includes("'fy' in parents")) return json({ files: [{ id: 'f1', name: 'November 2026 Real DSR.pdf' }] });
      return json({ files: [] });
    }
    return json({ id: 'up' });
  };
  await assert.rejects(accessToken('{}', fake), /GDRIVE_TOKEN must be/);
  const access = await accessToken(JSON.stringify({ client_id: 'c', client_secret: 's', refresh_token: 'r' }), fake);
  assert.equal(access, 'acc');
  const d = drive(access, fake);
  // "Vriddhi Fuels" is there; "Registers" and "FY 2026-27" get made, inside it
  const id = await d.folder('Vriddhi Fuels/Registers/FY 2026-27');
  assert.equal(id, 'new-FY 2026-27');
  const made = calls.filter(([m, u]) => m === 'POST' && u.endsWith('/files?supportsAllDrives=true')).map(([, , b]) => JSON.parse(b));
  assert.deepEqual(made, [{ name: 'Registers', mimeType: 'application/vnd.google-apps.folder', parents: ['vf'] },
    { name: 'FY 2026-27', mimeType: 'application/vnd.google-apps.folder', parents: ['new-Registers'] }]);
  assert.deepEqual(await d.files('fy'), { 'November 2026 Real DSR.pdf': 'f1' });
  // a new file into the folder; a new version of one already there
  await d.upload('fy', 'November 2026 Stock Register.pdf', Buffer.from('%PDF'));
  await d.upload('fy', 'November 2026 Real DSR.pdf', Buffer.from('%PDF'), 'f1');
  const ups = calls.filter(([, u]) => u.includes('/upload/'));
  assert.equal(ups[0][0], 'POST');
  assert.match(ups[0][2].toString(), /"parents":\["fy"\]/);
  assert.equal(ups[1][0], 'PATCH');
  assert.match(ups[1][1], /\/files\/f1\?uploadType=multipart/);
  assert.doesNotMatch(ups[1][2].toString(), /parents/);
});
