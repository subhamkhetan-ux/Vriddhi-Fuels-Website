/**
 * IOCL Challan — saves every IndianOil fuel invoice PDF from Gmail into Google Drive.
 *
 * A Google Apps Script: it lives in your Google account (script.google.com) and
 * Google runs it every 30 minutes. No token, no app password, no computer has
 * to be on — so nothing expires. Setup: apps_script/README.md.
 *
 * Each IOCL invoice mail (from B2BPRD@indianoil.in, all trucks) gets its PDF
 * saved, named by the invoice number, filed by the INVOICE date:
 *
 *   My Drive / Vriddhi Fuels / OLD Data / IOCL Challan / 2026 / November 2026 / 7013019147.pdf
 *
 * - "IOCL Challan" is found by its path (or id); it is never created. The year
 *   and month folders inside it are made when needed.
 * - Never twice: an invoice already anywhere inside "IOCL Challan" (saved by
 *   this script, or a late challan you downloaded and put in yourself, named by
 *   its invoice number) is skipped.
 * - Only fuel tax invoices: the ones the payment agent read off the PDF — a
 *   tax invoice with a truck (T.T.No.) and products with quantities — and put
 *   on the decant app's invoice list, with their date. Other IOCL PDFs from the
 *   same sender (credit notes for dealer margin, statements…) are never on it
 *   and are left out. A mail the agent hasn't got to yet waits for a later run;
 *   still not on the list after WAIT_HOURS, it's taken as not a fuel invoice.
 *   (If the list can't be reached, the mail just waits — it's never skipped
 *   for that.)
 * - Each mail, once checked, gets a Gmail label and is not looked at again:
 *   "IOCL Challan saved" when its fuel invoice is in Drive (saved now, or there
 *   already), "IOCL Challan skipped" when it has none (a payment acknowledgement,
 *   a credit note, a statement…). Remove the label to have it checked again.
 *   (Run fixOldLabels once to move mails labelled "saved" by an earlier version
 *   that have no invoice in Drive onto "skipped".)
 * - If a run fails, Google emails you (the trigger's failure notice).
 */

const CONFIG = {
  // The "IOCL Challan" folder. The script runs in sunilkhetan1976@gmail.com (the
  // account that gets the IOCL invoice mails); the folder is in
  // subhamkhetan@gmail.com's Drive (My Drive / Vriddhi Fuels / OLD Data /
  // IOCL Challan), shared with it as Editor — so it's found by its id (the last
  // part of its link, .../folders/<id>). With FOLDER_ID empty, FOLDER_PATH (from
  // the top of the script account's My Drive) is used instead.
  FOLDER_ID: '1wcWIymyJ11TkA3Hl6Cegn-ktKmNPQKZs',
  FOLDER_PATH: 'Vriddhi Fuels/OLD Data/IOCL Challan',
  // The IOCL invoice mails, and from when (the folder already has everything
  // before this).
  QUERY: 'from:B2BPRD@indianoil.in has:attachment filename:pdf',
  START: '2026/11/01',
  LABEL: 'IOCL Challan saved',          // its fuel invoice is in Drive
  SKIP_LABEL: 'IOCL Challan skipped',   // checked: no fuel invoice in it
  // The invoice date: the decant app's list of invoices (filled by the payment
  // agent from each PDF). Its public key, as in decant/config.js.
  INVOICES_URL: 'https://rqxzbenyztapjrswveqv.supabase.co',
  INVOICES_KEY: 'sb_publishable_XLmSYRNkn6BPHVMy3Zwt5Q_Osu6nHsU',
  WAIT_HOURS: 24,        // the agent runs every ~20 min; a day is plenty
  MAX_THREADS: 50,       // per run (a back-fill goes on next run)
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const INVOICE_NO = /(?<!\d)(70\d{8})(?!\d)/;


/** Run by the trigger (and by hand from the editor to test). */
function saveIoclChallans() {
  const root = challanFolder_();
  const have = invoicesIn_(root);
  const label = label_(CONFIG.LABEL), skipLabel = label_(CONFIG.SKIP_LABEL);
  const query = `${CONFIG.QUERY} after:${CONFIG.START} -label:${searchName_(CONFIG.LABEL)} -label:${searchName_(CONFIG.SKIP_LABEL)}`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  const folders = {};
  let saved = 0, skipped = 0, waiting = 0, notFuel = 0;

  for (const thread of threads) {
    let done = true, inDrive = false;      // inDrive: a fuel invoice of this mail is in IOCL Challan
    for (const msg of thread.getMessages()) {
      for (const att of msg.getAttachments()) {
        const name = att.getName() || '';
        if (!/\.pdf$/i.test(name) && att.getContentType() !== 'application/pdf') continue;
        const m = INVOICE_NO.exec(name);
        if (!m) continue;                                   // not an IOCL document number
        const no = m[1];
        if (have.has(no)) { skipped++; inDrive = true; continue; }   // already in IOCL Challan
        const date = invoiceDate_(no);
        if (date === undefined) { done = false; waiting++; continue; }   // list unreachable: next run
        if (date === null) {                                // not on the list (yet)
          const ageHours = (Date.now() - msg.getDate().getTime()) / 3600000;
          if (ageHours < CONFIG.WAIT_HOURS) { done = false; waiting++; continue; }   // next run
          notFuel++;
          console.log(`left out ${no}.pdf — not a fuel tax invoice (credit note, statement…)`);
          continue;
        }
        const [, mm, yyyy] = date.split('/');
        const month = `${MONTHS[Number(mm) - 1]} ${yyyy}`;
        const key = `${yyyy}/${month}`;
        folders[key] = folders[key] || childFolder_(childFolder_(root, yyyy), month);
        folders[key].createFile(att.copyBlob().setName(`${no}.pdf`));
        have.add(no);
        saved++;
        inDrive = true;
        console.log(`saved ${yyyy}/${month}/${no}.pdf`);
      }
    }
    if (done) thread.addLabel(inDrive ? label : skipLabel);
  }
  console.log(`IOCL Challan: ${saved} saved, ${skipped} already there, ${waiting} waiting for the invoice date, ${notFuel} not fuel invoices (left out).`);
  return { saved, skipped, waiting, notFuel };
}


/** Run once by hand (choose it in the toolbar, then Run): mails an earlier
 *  version labelled "IOCL Challan saved" although no invoice of theirs is in
 *  Drive (payment acknowledgements, credit notes) are moved to "IOCL Challan
 *  skipped". Mails whose invoice is in Drive keep "saved". */
function fixOldLabels() {
  const have = invoicesIn_(challanFolder_());
  const label = label_(CONFIG.LABEL), skipLabel = label_(CONFIG.SKIP_LABEL);
  // all of them first: relabelling while paging through the search would shift it
  const threads = [];
  for (let start = 0; ; start += 100) {
    const page = GmailApp.search(`label:${searchName_(CONFIG.LABEL)}`, start, 100);
    threads.push(...page);
    if (page.length < 100) break;
  }
  let moved = 0, kept = 0;
  for (const thread of threads) {
    const nos = [];
    for (const msg of thread.getMessages()) {
      for (const att of msg.getAttachments()) {
        const m = INVOICE_NO.exec(att.getName() || '');
        if (m) nos.push(m[1]);
      }
    }
    if (nos.some((no) => have.has(no))) { kept++; continue; }
    thread.removeLabel(label);
    thread.addLabel(skipLabel);
    moved++;
  }
  console.log(`Labels: ${moved} moved to "${CONFIG.SKIP_LABEL}", ${kept} kept "${CONFIG.LABEL}".`);
  return { moved, kept };
}


/** Run once from the editor: makes the every-30-minutes trigger and runs it now. */
function install() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'saveIoclChallans') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('saveIoclChallans').timeBased().everyMinutes(30).create();
  return saveIoclChallans();
}


// ---- helpers ---------------------------------------------------------------

/** The "IOCL Challan" folder — by id, or by its path from My Drive. Never made. */
function challanFolder_() {
  if (CONFIG.FOLDER_ID) return DriveApp.getFolderById(CONFIG.FOLDER_ID);
  let f = DriveApp.getRootFolder();
  for (const part of CONFIG.FOLDER_PATH.split('/').filter((p) => p.trim())) {
    const it = f.getFoldersByName(part);
    if (!it.hasNext()) throw new Error(`Folder "${part}" not found in Google Drive (looking for "${CONFIG.FOLDER_PATH}"). Moved or renamed? Set FOLDER_PATH or FOLDER_ID.`);
    f = it.next();
  }
  return f;
}

/** A Gmail label by name, made if it isn't there. */
function label_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/** A label as Gmail search writes it: spaces as dashes (label:iocl-challan-saved). */
function searchName_(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

/** A sub-folder by name, made if it isn't there. */
function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Every invoice number already in the folder, any depth (names like
 *  "7013019147.pdf", "7013019147 (1).pdf"), files in the bin left out. */
function invoicesIn_(folder, out) {
  out = out || new Set();
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const m = INVOICE_NO.exec(f.getName());
    if (m && !f.isTrashed()) out.add(m[1]);
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const s = subs.next();
    if (!s.isTrashed()) invoicesIn_(s, out);
  }
  return out;
}

/** The invoice's own date "dd/mm/yyyy", as the payment agent read it off the
 *  PDF; null when it isn't on the list (not a fuel invoice, or not yet);
 *  undefined when the list can't be reached (try again later). */
function invoiceDate_(no) {
  try {
    const res = UrlFetchApp.fetch(
      `${CONFIG.INVOICES_URL}/rest/v1/dec_invoices?invoice_no=eq.${no}&select=invoice_date`,
      { headers: { apikey: CONFIG.INVOICES_KEY }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return undefined;
    const rows = JSON.parse(res.getContentText());
    if (!Array.isArray(rows)) return undefined;
    const d = rows.length ? rows[0].invoice_date : null;
    return /^\d{2}\/\d{2}\/\d{4}$/.test(d || '') ? d : null;
  } catch (e) {
    return undefined;
  }
}
