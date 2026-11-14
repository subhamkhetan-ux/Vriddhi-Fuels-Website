// apps_script/iocl_challan.gs run in Node against stand-ins for Gmail, Drive,
// the invoice-date lookup and Utilities — the same calls Google provides.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../../apps_script/iocl_challan.gs', import.meta.url), 'utf8');
const HOUR = 3600000;

class Folder {
  constructor(name, parent = null) { this.name = name; this.parent = parent; this.folders = []; this.files = []; this.trashed = false; }
  getFoldersByName(n) { return iter(this.folders.filter((f) => f.name === n && !f.trashed)); }
  getFolders() { return iter(this.folders); }
  getFiles() { return iter(this.files); }
  createFolder(n) { const f = new Folder(n, this); this.folders.push(f); return f; }
  createFile(blob) { const f = { name: blob.name, data: blob.data, trashed: false, getName() { return this.name; }, isTrashed() { return this.trashed; } }; this.files.push(f); return f; }
  isTrashed() { return this.trashed; }
  at(path) { return path.split('/').reduce((f, p) => f.folders.find((x) => x.name === p), this); }
  put(path, name) { let f = this; for (const p of path.split('/')) f = f.getFoldersByName(p).hasNext() ? f.getFoldersByName(p).next() : f.createFolder(p); return f.createFile({ name }); }
  list(prefix = '') { return [...this.files.map((f) => prefix + f.name), ...this.folders.flatMap((s) => s.list(prefix + s.name + '/'))]; }
}
const iter = (a) => { let i = 0; return { hasNext: () => i < a.length, next: () => a[i++] }; };

function world({ dates = {}, threads = [], now = Date.parse('2026-11-14T10:00:00Z') } = {}) {
  const drive = new Folder('My Drive');
  drive.put('Vriddhi Fuels/OLD Data/IOCL Challan/2026/October 2026', '7012019212.pdf');
  drive.put('Vriddhi Fuels/OLD Data/Shyam Metalics', 'bill.pdf');
  const labels = {};
  const searches = [];
  const ctx = {
    console: { log() {} },
    Date: class extends Date { static now() { return now; } },
    GmailApp: {
      getUserLabelByName: (n) => labels[n] || null,
      createLabel: (n) => (labels[n] = { name: n }),
      search: (q, start, max) => { searches.push(q); return threads.filter((t) => !t.labelled).slice(0, max); },
    },
    DriveApp: { getRootFolder: () => drive, getFolderById: (id) => drive.at(id) },
    UrlFetchApp: {
      fetch: (url) => {
        const no = /invoice_no=eq\.(\d+)/.exec(url)[1];
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(dates[no] ? [{ invoice_date: dates[no] }] : []) };
      },
    },
    Utilities: {
      formatDate: (d, tz, f) => {   // IST, dd/MM/yyyy
        const ist = new Date(d.getTime() + 330 * 60000);
        return `${String(ist.getUTCDate()).padStart(2, '0')}/${String(ist.getUTCMonth() + 1).padStart(2, '0')}/${ist.getUTCFullYear()}`;
      },
    },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, drive, searches, run: () => ({ ...vm.runInContext('saveIoclChallans()', ctx) }) };   // copied out of the sandbox's realm
}

const mail = (sent, ...names) => ({
  getDate: () => new Date(sent),
  getAttachments: () => names.map((n) => ({ getName: () => n, getContentType: () => 'application/pdf', copyBlob: () => ({ name: n, data: 'pdf', setName(x) { this.name = x; return this; } }) })),
});
const thread = (...msgs) => ({ labelled: false, getMessages: () => msgs, addLabel() { this.labelled = true; } });
const CH = 'Vriddhi Fuels/OLD Data/IOCL Challan';

test('files each invoice by its invoice date, named by its number; labels the mail', () => {
  const t1 = thread(mail('2026-11-13T10:00:00Z', '7013019147.pdf'));              // our TT
  const t2 = thread(mail('2026-11-14T02:00:00Z', '7012920176.pdf', 'statement.pdf'));  // transport TT, a late mail
  const w = world({ threads: [t1, t2], dates: { 7013019147: '12/11/2026', 7012920176: '31/10/2026' } });
  assert.deepEqual(w.run(), { saved: 2, skipped: 0, waiting: 0 });
  const files = w.drive.at(CH).list();
  assert.ok(files.includes('2026/November 2026/7013019147.pdf'));
  assert.ok(files.includes('2026/October 2026/7012920176.pdf'));                // by the invoice date, not the mail's
  assert.ok(!files.some((f) => /statement/.test(f)));
  assert.ok(t1.labelled && t2.labelled);
  assert.match(w.searches[0], /from:B2BPRD@indianoil\.in has:attachment filename:pdf after:2026\/11\/01 -label:iocl-challan-saved/);
});

test('an invoice already in IOCL Challan (any folder, a hand-put copy) is skipped', () => {
  const t = thread(mail('2026-11-13T10:00:00Z', '7012019212.pdf', '7013019147.pdf'));
  const w = world({ threads: [t], dates: { 7012019212: '05/10/2026', 7013019147: '12/11/2026' } });
  w.drive.put(`${CH}/2026/November 2026`, '7013019147 (1).pdf');                // downloaded by hand
  assert.deepEqual(w.run(), { saved: 0, skipped: 2, waiting: 0 });
  assert.equal(w.drive.at(CH).list().filter((f) => f.includes('7013019147')).length, 1);
  assert.ok(t.labelled);
});

test('the same number outside IOCL Challan, or a longer number, does not count', () => {
  const t = thread(mail('2026-11-13T10:00:00Z', '7013019147.pdf'));
  const w = world({ threads: [t], dates: { 7013019147: '12/11/2026' } });
  w.drive.put('Vriddhi Fuels/OLD Data/Shyam Metalics', '7013019147.pdf');
  w.drive.put(CH, '70130191470.pdf');
  assert.equal(w.run().saved, 1);
});

test('new year and month folders are made inside IOCL Challan, existing ones reused', () => {
  const t = thread(mail('2027-01-02T05:00:00Z', '7014000001.pdf'), mail('2026-10-06T05:00:00Z', '7012019999.pdf'));
  const w = world({ threads: [t], dates: { 7014000001: '01/01/2027', 7012019999: '06/10/2026' } });
  w.run();
  const ch = w.drive.at(CH);
  assert.deepEqual(ch.folders.map((f) => f.name), ['2026', '2027']);
  assert.deepEqual(ch.at('2026').folders.map((f) => f.name), ['October 2026']);
  assert.ok(ch.list().includes('2027/January 2027/7014000001.pdf'));
});

test('waits for the invoice date while the mail is fresh, then files by the mail date', () => {
  const t = thread(mail('2026-11-14T08:00:00Z', '7013099999.pdf'));               // 2 h old, agent not there yet
  const w = world({ threads: [t] });
  assert.deepEqual(w.run(), { saved: 0, skipped: 0, waiting: 1 });
  assert.ok(!t.labelled);                                                         // looked at again next run
  const later = world({ threads: [t], now: Date.parse('2026-11-14T20:00:00Z') }); // 12 h later, still unknown
  later.run();
  assert.ok(later.drive.at(CH).list().includes('2026/November 2026/7013099999.pdf') && t.labelled);
});

test('a missing IOCL Challan folder stops the run (Google emails the failure); nothing is made', () => {
  const w = world({ threads: [thread(mail('2026-11-13T10:00:00Z', '7013019147.pdf'))] });
  w.drive.at('Vriddhi Fuels/OLD Data').folders = w.drive.at('Vriddhi Fuels/OLD Data').folders.filter((f) => f.name !== 'IOCL Challan');
  assert.throws(() => w.run(), /Folder "IOCL Challan" not found/);
  assert.ok(!w.drive.list().some((f) => f.includes('7013019147')));
});

test('install makes the trigger and runs once', () => {
  const w = world({ threads: [thread(mail('2026-11-13T10:00:00Z', '7013019147.pdf'))], dates: { 7013019147: '12/11/2026' } });
  assert.equal(vm.runInContext('install()', w.ctx).saved, 1);
});
