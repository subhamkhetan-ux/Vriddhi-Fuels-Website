/**
 * IOCL Challan — saves every IndianOil invoice PDF from Gmail into Google Drive.
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
 * - The invoice date is the one the payment agent read off the PDF (the decant
 *   app's invoice list). If the agent hasn't got to the mail yet, the mail waits
 *   for a later run; after WAIT_HOURS it's filed by the mail's own date.
 * - A saved mail gets the Gmail label "IOCL Challan saved", and is not looked at
 *   again. Remove the label to have it checked again.
 * - If a run fails, Google emails you (the trigger's failure notice).
 */

const CONFIG = {
  // Where "IOCL Challan" is, from the top of My Drive. Or put the folder's id in
  // FOLDER_ID (the last part of its link, .../folders/<id>) — needed if this
  // script runs in a different Google account than the one that owns the folder
  // (share the folder with that account as Editor).
  FOLDER_PATH: 'Vriddhi Fuels/OLD Data/IOCL Challan',
  FOLDER_ID: '',
  // The IOCL invoice mails, and from when (the folder already has everything
  // before this).
  QUERY: 'from:B2BPRD@indianoil.in has:attachment filename:pdf',
  START: '2026/11/01',
  LABEL: 'IOCL Challan saved',
  // The invoice date: the decant app's list of invoices (filled by the payment
  // agent from each PDF). Its public key, as in decant/config.js.
  INVOICES_URL: 'https://rqxzbenyztapjrswveqv.supabase.co',
  INVOICES_KEY: 'sb_publishable_XLmSYRNkn6BPHVMy3Zwt5Q_Osu6nHsU',
  WAIT_HOURS: 6,
  MAX_THREADS: 50,       // per run (a back-fill goes on next run)
  TIMEZONE: 'Asia/Kolkata',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const INVOICE_NO = /(?<!\d)(70\d{8})(?!\d)/;


/** Run by the trigger (and by hand from the editor to test). */
function saveIoclChallans() {
  const root = challanFolder_();
  const have = invoicesIn_(root);
  const label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  // (Gmail search writes a label's spaces as dashes: label:iocl-challan-saved)
  const query = `${CONFIG.QUERY} after:${CONFIG.START} -label:${CONFIG.LABEL.toLowerCase().replace(/\s+/g, '-')}`;
  const threads = GmailApp.search(query, 0, CONFIG.MAX_THREADS);
  const folders = {};
  let saved = 0, skipped = 0, waiting = 0;

  for (const thread of threads) {
    let done = true;
    for (const msg of thread.getMessages()) {
      for (const att of msg.getAttachments()) {
        const name = att.getName() || '';
        if (!/\.pdf$/i.test(name) && att.getContentType() !== 'application/pdf') continue;
        const m = INVOICE_NO.exec(name);
        if (!m) continue;                                   // not an IOCL tax invoice
        const no = m[1];
        if (have.has(no)) { skipped++; continue; }          // already in IOCL Challan
        let date = invoiceDate_(no);
        if (!date) {
          const ageHours = (Date.now() - msg.getDate().getTime()) / 3600000;
          if (ageHours < CONFIG.WAIT_HOURS) { done = false; waiting++; continue; }   // next run
          date = Utilities.formatDate(msg.getDate(), CONFIG.TIMEZONE, 'dd/MM/yyyy');
        }
        const [, mm, yyyy] = date.split('/');
        const month = `${MONTHS[Number(mm) - 1]} ${yyyy}`;
        const key = `${yyyy}/${month}`;
        folders[key] = folders[key] || childFolder_(childFolder_(root, yyyy), month);
        folders[key].createFile(att.copyBlob().setName(`${no}.pdf`));
        have.add(no);
        saved++;
        console.log(`saved ${yyyy}/${month}/${no}.pdf`);
      }
    }
    if (done) thread.addLabel(label);
  }
  console.log(`IOCL Challan: ${saved} saved, ${skipped} already there, ${waiting} waiting for the invoice date.`);
  return { saved, skipped, waiting };
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
 *  PDF (null if it isn't there yet, or the lookup fails). */
function invoiceDate_(no) {
  try {
    const res = UrlFetchApp.fetch(
      `${CONFIG.INVOICES_URL}/rest/v1/dec_invoices?invoice_no=eq.${no}&select=invoice_date`,
      { headers: { apikey: CONFIG.INVOICES_KEY }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const rows = JSON.parse(res.getContentText());
    const d = rows.length ? rows[0].invoice_date : null;
    return /^\d{2}\/\d{2}\/\d{4}$/.test(d || '') ? d : null;
  } catch (e) {
    return null;
  }
}
