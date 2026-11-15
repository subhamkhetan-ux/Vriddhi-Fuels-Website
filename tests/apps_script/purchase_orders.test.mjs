// apps_script/purchase_orders.gs run in Node against stand-ins for Gmail, Drive
// and Utilities — the same calls Google provides.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../../apps_script/purchase_orders.gs', import.meta.url), 'utf8');

class Folder {
  constructor(name) { this.name = name; this.folders = []; this.files = []; }
  getFoldersByName(n) { return iter(this.folders.filter((f) => f.name === n)); }
  getFilesByName(n) { return iter(this.files.filter((f) => f.name === n)); }
  createFolder(n) { const f = new Folder(n); this.folders.push(f); return f; }
  createFile(blob) {
    const f = { name: blob.name, size: blob.size, trashed: false, getSize() { return this.size; }, isTrashed() { return this.trashed; } };
    this.files.push(f); return f;
  }
  at(path) { return path.split('/').reduce((f, p) => f && f.folders.find((x) => x.name === p), this); }
  list(prefix = '') { return [...this.files.map((f) => prefix + f.name), ...this.folders.flatMap((s) => s.list(prefix + s.name + '/'))]; }
}
const iter = (a) => { let i = 0; return { hasNext: () => i < a.length, next: () => a[i++] }; };

const att = (name, size = 100) => ({ getName: () => name, getSize: () => size, copyBlob: () => ({ name, size, setName(x) { this.name = x; return this; } }) });
const mail = (from, subject, when, ...atts) => ({ getFrom: () => from, getSubject: () => subject, getDate: () => new Date(when), getAttachments: () => atts });
const thread = (...msgs) => ({ labels: new Set(), getMessages: () => msgs, addLabel(l) { this.labels.add(l.name); } });

function world({ threads = [], customers = {}, drive = new Folder('My Drive') } = {}) {
  const searches = [];
  const ctx = {
    console: { log() {} },
    Session: { getActiveUser: () => ({ getEmail: () => 'subhamkhetan@gmail.com' }) },
    GmailApp: {
      getUserLabelByName: () => null,
      createLabel: (n) => ({ name: n }),
      search: (q, start, max) => { searches.push(q); return threads.filter((t) => !t.labels.size).slice(start, start + max); },
    },
    DriveApp: { getRootFolder: () => drive, getFolderById: () => drive },
    Utilities: {
      formatDate: (d, tz, f) => {
        const ist = new Date(d.getTime() + 330 * 60000), p = (n) => String(n).padStart(2, '0');
        return f === 'yyyy' ? String(ist.getUTCFullYear()) : `${p(ist.getUTCDate())}-${p(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}`;
      },
    },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create() {} }) }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.__customers = customers;
  vm.runInContext('PO_CONFIG.CUSTOMERS = __customers', ctx);
  return { ctx, drive, searches, run: () => ({ ...vm.runInContext('savePurchaseOrders()', ctx) }) };
}

const CUSTOMERS = {
  'Shyam Metalics': ['shyammetalics.com'],
  'Ember Coal': ['purchase@embercoal.in'],
  'Ankita Air': ['ankitaair@gmail.com'],
};

test('saves each customer\'s PO attachments under PO / customer / year of the mail', () => {
  const t1 = thread(mail('Rakesh <rakesh@shyammetalics.com>', 'Purchase Order for HSD', '2026-11-10T05:00:00Z', att('PO_4500123456.pdf')));
  const t2 = thread(mail('Ember Purchase <purchase@embercoal.in>', 'PO No. 77 dt 28.12.2025', '2025-12-28T20:00:00Z', att('77.pdf'), att('terms.docx')));
  const t3 = thread(mail('Ankita <ankitaair@gmail.com>', 'diesel order', '2026-03-03T05:00:00Z', att('P.O. March.pdf')));   // PO in the file name
  const w = world({ threads: [t1, t2, t3], customers: CUSTOMERS });
  assert.deepEqual(w.run(), { saved: 3, already: 0, skipped: 0 });
  assert.deepEqual(w.drive.list().sort(), [
    'PO/Ankita Air/2026/P.O. March.pdf',
    'PO/Ember Coal/2025/77.pdf',                       // the mail's date, in IST (28 Dec, not 29)
    'PO/Shyam Metalics/2026/PO_4500123456.pdf',
  ]);
  for (const t of [t1, t2, t3]) assert.deepEqual([...t.labels], ['PO saved']);
  assert.match(w.searches[0], /^from:\(shyammetalics\.com OR purchase@embercoal\.in OR ankitaair@gmail\.com\) has:attachment \(filename:pdf\) \(subject:.*purchase order.*\) -label:po-saved -label:po-skipped$/);
});

test('a sub-domain counts; another sender or our own reply does not', () => {
  const t = thread(
    mail('X <x@jsg.shyammetalics.com>', 'PO 9', '2026-11-11T05:00:00Z', att('PO9.pdf')),
    mail('Subham <subhamkhetan@gmail.com>', 'Re: PO 9', '2026-11-11T06:00:00Z', att('PO9-ack.pdf')),
    mail('Spam <a@notshyammetalics.com>', 'PO 9', '2026-11-11T07:00:00Z', att('PO9-x.pdf')));
  const w = world({ threads: [t], customers: CUSTOMERS });
  w.run();
  assert.deepEqual(w.drive.list(), ['PO/Shyam Metalics/2026/PO9.pdf']);
});

test('not a PO by subject or file name — or no wanted attachment — is skipped and labelled so', () => {
  const t1 = thread(mail('rakesh@shyammetalics.com', 'Payment advice', '2026-11-10T05:00:00Z', att('advice.pdf')));
  const t2 = thread(mail('rakesh@shyammetalics.com', 'Revised POWER tariff', '2026-11-10T05:00:00Z', att('tariff.pdf')));   // "POWER" is not "PO"
  const t3 = thread(mail('rakesh@shyammetalics.com', 'PO 12', '2026-11-10T05:00:00Z', att('PO12.xlsx')));                    // not a PDF
  const w = world({ threads: [t1, t2, t3], customers: CUSTOMERS });
  assert.deepEqual(w.run(), { saved: 0, already: 0, skipped: 3 });
  for (const t of [t1, t2, t3]) assert.deepEqual([...t.labels], ['PO skipped']);
  assert.deepEqual(w.drive.list(), []);
});

test('the same file is not saved twice; a different one of the same name is kept with its date', () => {
  const drive = new Folder('My Drive');
  const w1 = world({ drive, customers: CUSTOMERS, threads: [thread(mail('a@shyammetalics.com', 'PO', '2026-11-10T05:00:00Z', att('PO.pdf', 100)))] });
  w1.run();
  const w2 = world({ drive, customers: CUSTOMERS, threads: [
    thread(mail('a@shyammetalics.com', 'Fwd: PO', '2026-11-12T05:00:00Z', att('PO.pdf', 100))),     // the same PO again
    thread(mail('a@shyammetalics.com', 'PO', '2026-11-14T05:00:00Z', att('PO.pdf', 250))),          // a new PO, same file name
  ] });
  assert.deepEqual(w2.run(), { saved: 1, already: 1, skipped: 0 });
  assert.deepEqual(drive.at('PO/Shyam Metalics/2026').list().sort(), ['PO (14-11-2026).pdf', 'PO.pdf']);
});

test('existing PO / customer / year folders are used, not duplicated', () => {
  const drive = new Folder('My Drive');
  drive.createFolder('PO').createFolder('Shyam Metalics').createFolder('2026');
  const w = world({ drive, customers: CUSTOMERS, threads: [thread(mail('a@shyammetalics.com', 'PO 1', '2026-11-10T05:00:00Z', att('1.pdf')))] });
  w.run();
  assert.equal(drive.folders.length, 1);
  assert.equal(drive.at('PO').folders.length, 1);
  assert.deepEqual(drive.list(), ['PO/Shyam Metalics/2026/1.pdf']);
});

test('no customers yet: nothing is searched or saved', () => {
  const w = world({ threads: [thread(mail('a@shyammetalics.com', 'PO', '2026-11-10T05:00:00Z', att('PO.pdf')))] });
  assert.deepEqual(w.run(), { saved: 0, already: 0, skipped: 0 });
  assert.equal(w.searches.length, 0);
});

test('findPoSenders lists PO senders grouped by company domain (or the address, for gmail)', () => {
  const threads = [
    thread(mail('Rakesh <rakesh@shyammetalics.com>', 'Purchase Order 1', '2026-11-10T05:00:00Z', att('1.pdf'))),
    thread(mail('Sunita <stores@shyammetalics.com>', 'PO 2', '2026-11-11T05:00:00Z', att('2.pdf'))),
    thread(mail('Ankita Air <ankitaair@gmail.com>', 'PO', '2026-11-11T05:00:00Z', att('3.pdf'))),
    thread(mail('Subham <subhamkhetan@gmail.com>', 'Re: PO', '2026-11-11T05:00:00Z', att('4.pdf'))),     // ourselves
    thread(mail('B2BPRD <b2bprd@indianoil.in>', 'PO', '2026-11-11T05:00:00Z', att('5.pdf'))),           // IOCL
  ];
  const w = world({ threads });
  const lines = vm.runInContext('findPoSenders()', w.ctx);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ {2}'Rakesh': \['shyammetalics\.com'\], {3}\/\/ 2 mail\(s\)/);
  assert.match(lines[1], /^ {2}'Ankita Air': \['ankitaair@gmail\.com'\]/);
  assert.equal(w.drive.list().length, 0);                                          // saves nothing
});

test('installPurchaseOrders makes the trigger and runs once', () => {
  const w = world({ customers: CUSTOMERS, threads: [thread(mail('a@shyammetalics.com', 'PO', '2026-11-10T05:00:00Z', att('x.pdf')))] });
  assert.equal(vm.runInContext('installPurchaseOrders()', w.ctx).saved, 1);
});
