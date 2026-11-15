/**
 * Purchase Orders — saves customers' PO attachments from Gmail into Google Drive.
 *
 * A Google Apps Script for subhamkhetan@gmail.com (script.google.com). Google
 * runs it every hour; no token, no app password, nothing to keep on.
 * Setup: apps_script/README.md.
 *
 *   My Drive / PO / Shyam Metalics / 2026 / PO_4500123456.pdf
 *
 * - A PO mail: from one of the CUSTOMERS below, with "PO", "P.O." or "Purchase
 *   Order" in its subject or an attachment's name. Its attachments (TYPES) are
 *   saved under PO / <customer> / <year of the mail's date>.
 * - The "PO" folder is made at the top of My Drive if it isn't there; the
 *   customer and year folders too.
 * - Never twice: a file of the same name and size already in that folder is
 *   skipped; a different file with the same name is saved as "<name> (dd-mm-yyyy)".
 * - Each checked mail gets the Gmail label "PO saved" (something of it is in
 *   Drive) or "PO skipped" (no attachment to save), and isn't looked at again.
 *   Remove the label to have it checked again.
 * - Who's a customer: run findPoSenders once — it lists everyone who has sent
 *   PO-looking mail, ready to paste into CUSTOMERS.
 */

const PO_CONFIG = {
  // Customer name (= its folder) → the addresses or domains its POs come from.
  // A domain ("shyammetalics.com") covers everyone there; a full address only
  // that one sender. Fill in from findPoSenders.
  CUSTOMERS: {
    // 'Shyam Metalics': ['shyammetalics.com'],
    // 'Ember Coal': ['purchase@embercoal.com'],
  },
  ROOT_PATH: 'PO',                       // from the top of My Drive (made if missing)
  ROOT_ID: '',                           // or an existing folder's id instead
  PO_WORDS: '(PO OR "P.O" OR "P.O." OR "purchase order")',
  TYPES: ['pdf'],                        // also e.g. 'xlsx', 'xls', 'jpg', 'png'
  START: '',                             // e.g. '2025/04/01'; empty = all mail
  LABEL: 'PO saved',
  SKIP_LABEL: 'PO skipped',
  MAX_THREADS: 50,                       // per run (a back-fill goes on next run)
  TIMEZONE: 'Asia/Kolkata',
};


/** Run by the trigger (and by hand to test). */
function savePurchaseOrders() {
  const customers = poCustomers_();
  if (!customers.length) {
    console.log('No customers yet — run findPoSenders and fill in PO_CONFIG.CUSTOMERS.');
    return { saved: 0, already: 0, skipped: 0 };
  }
  const root = poRoot_();
  const label = poLabel_(PO_CONFIG.LABEL), skipLabel = poLabel_(PO_CONFIG.SKIP_LABEL);
  const threads = GmailApp.search(poQuery_(customers), 0, PO_CONFIG.MAX_THREADS);
  let saved = 0, already = 0, skipped = 0;

  for (const thread of threads) {
    let any = false;
    for (const msg of thread.getMessages()) {
      const who = poCustomerOf_(msg.getFrom(), customers);
      if (!who) continue;                                // a reply from us, someone else
      const subjectPo = poLooksLikePo_(msg.getSubject());
      const atts = msg.getAttachments().filter((a) => poWanted_(a.getName()));
      if (!atts.length || !(subjectPo || atts.some((a) => poLooksLikePo_(a.getName())))) continue;
      const year = Utilities.formatDate(msg.getDate(), PO_CONFIG.TIMEZONE, 'yyyy');
      const folder = poChild_(poChild_(root, who), year);
      for (const att of atts) {
        const r = poSave_(folder, att, msg.getDate());
        if (r === 'saved') { saved++; console.log(`saved ${who}/${year}/${att.getName()}`); } else already++;
        any = true;
      }
    }
    thread.addLabel(any ? label : skipLabel);
    if (!any) skipped++;
  }
  console.log(`Purchase orders: ${saved} saved, ${already} already there, ${skipped} mails with nothing to save.`);
  return { saved, already, skipped };
}


/** Run once by hand: lists who has sent you PO-looking mail (last 2 years),
 *  as lines ready to paste into PO_CONFIG.CUSTOMERS. Saves nothing. */
function findPoSenders() {
  const me = Session.getActiveUser().getEmail().toLowerCase();
  const threads = GmailApp.search(`has:attachment (subject:${PO_CONFIG.PO_WORDS} OR filename:${PO_CONFIG.PO_WORDS}) newer_than:2y`, 0, 500);
  const by = {};
  for (const t of threads) {
    for (const msg of t.getMessages()) {
      const { name, email } = poParseFrom_(msg.getFrom());
      if (!email || email === me || /indianoil\.in$/.test(email)) continue;
      const atts = msg.getAttachments().filter((a) => poWanted_(a.getName()));
      if (!atts.length) continue;
      const key = poKey_(email);
      by[key] = by[key] || { names: new Set(), count: 0, subject: msg.getSubject() };
      if (name) by[key].names.add(name);
      by[key].count++;
    }
  }
  const lines = Object.entries(by).sort((a, b) => b[1].count - a[1].count).map(([key, v]) =>
    `  '${[...v.names][0] || key}': ['${key}'],   // ${v.count} mail(s), e.g. "${String(v.subject).slice(0, 60)}"`);
  console.log(lines.length ? `Senders of PO-looking mail (rename each to the customer's name):\n${lines.join('\n')}`
    : 'No PO-looking mail with attachments found in the last 2 years.');
  return lines;
}


/** Run once: makes the hourly trigger and runs it now. */
function installPurchaseOrders() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'savePurchaseOrders') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('savePurchaseOrders').timeBased().everyHours(1).create();
  return savePurchaseOrders();
}


// ---- helpers ---------------------------------------------------------------

const PO_PUBLIC = /^(gmail|googlemail|yahoo|ymail|rediffmail|hotmail|outlook|live|icloud|me|aol|proton|protonmail)\./;

/** [{name, keys: ['domain.com' | 'a@b.com']}] from PO_CONFIG.CUSTOMERS. */
function poCustomers_() {
  return Object.entries(PO_CONFIG.CUSTOMERS).map(([name, keys]) =>
    ({ name: name.trim(), keys: [].concat(keys).map((k) => String(k).trim().toLowerCase().replace(/^@/, '')).filter(Boolean) }))
    .filter((c) => c.name && c.keys.length);
}

/** Gmail search for unchecked PO mail from the customers. */
function poQuery_(customers) {
  const from = customers.flatMap((c) => c.keys).join(' OR ');
  const types = PO_CONFIG.TYPES.map((t) => `filename:${t}`).join(' OR ');
  return [`from:(${from})`, `has:attachment (${types})`,
    `(subject:${PO_CONFIG.PO_WORDS} OR filename:${PO_CONFIG.PO_WORDS})`,
    PO_CONFIG.START ? `after:${PO_CONFIG.START}` : '',
    `-label:${poSearchName_(PO_CONFIG.LABEL)} -label:${poSearchName_(PO_CONFIG.SKIP_LABEL)}`].filter(Boolean).join(' ');
}

/** "Rakesh <purchase@shyammetalics.com>" → {name, email}. */
function poParseFrom_(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
  return m ? { name: m[1].trim(), email: m[2].trim().toLowerCase() } : { name: '', email: String(from || '').trim().toLowerCase() };
}

/** The address itself for a public mailbox (gmail…), else the company's domain. */
function poKey_(email) {
  const domain = email.split('@')[1] || '';
  return PO_PUBLIC.test(domain) ? email : domain;
}

/** Which customer a "From" belongs to (its address, or its domain / a parent domain). */
function poCustomerOf_(from, customers) {
  const { email } = poParseFrom_(from);
  const domain = email.split('@')[1] || '';
  for (const c of customers) {
    for (const k of c.keys) {
      if (k.includes('@') ? email === k : (domain === k || domain.endsWith('.' + k))) return c.name;
    }
  }
  return null;
}

/** "PO", "P.O.", "Purchase Order" as words (not "PORT", "POWER", "Repo"). */
function poLooksLikePo_(s) {
  return /(^|[^a-z])p\.?\s?o\.?([^a-z]|$)|purchase\s*order/i.test(s || '');
}

function poWanted_(name) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
  return !!ext && PO_CONFIG.TYPES.includes(ext.toLowerCase());
}

/** Save an attachment into a folder: skip the same name + size; a different
 *  file of the same name gets " (dd-mm-yyyy)" (and a number if need be). */
function poSave_(folder, att, date) {
  const name = att.getName();
  const size = att.getSize();
  const same = folder.getFilesByName(name);
  let taken = false;
  while (same.hasNext()) {
    const f = same.next();
    if (f.isTrashed()) continue;
    if (f.getSize() === size) return 'already';
    taken = true;
  }
  let finalName = name;
  if (taken) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    const stamp = Utilities.formatDate(date, PO_CONFIG.TIMEZONE, 'dd-MM-yyyy');
    finalName = `${base} (${stamp})${ext}`;
    for (let n = 2; folder.getFilesByName(finalName).hasNext(); n++) finalName = `${base} (${stamp}) ${n}${ext}`;
  }
  folder.createFile(att.copyBlob().setName(finalName));
  return 'saved';
}

function poRoot_() {
  if (PO_CONFIG.ROOT_ID) return DriveApp.getFolderById(PO_CONFIG.ROOT_ID);
  let f = DriveApp.getRootFolder();
  for (const part of PO_CONFIG.ROOT_PATH.split('/').filter((p) => p.trim())) f = poChild_(f, part);
  return f;
}

function poChild_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function poLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function poSearchName_(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}
