// Vriddhi Ledger — the /ledger/ web app. Plain ES modules, no build step.
// The logic lives in the other modules (daybook, master, po, store); this
// file is the screens.

import { normalizeCompany, slipBundles, slipHeaderFor, splitCompany, tankerBundles } from './bills.js';
import { daybookChanges, daybookPayload, parseDaybook, sheetRows } from './daybook.js';
import { demoSeed } from './demo.js';
import { fromQueue } from './payin.js';
import {
  barChart, bindCharts, dailyVolumeChart, legend, litres, money, monthlyChart, monthName, rspChart, SERIES, setChartWidth, shortDate, stackedBars,
} from './charts.js';
import { analyse, dateRange, daysBetween, dayRsp, FUELS, periods, PRODUCT_NAME, shortGroup } from './dash.js';
import { dmy as dmyLetter, LETTER_PAGE, LETTER_PRODUCTS, letterDocx, letterSvg, letterText, price2, priceRanges } from './price-letter.js';
import { extractMaster, readWorkbook } from './master.js';
import { poKey, poListChanges } from './po.js';
import {
  A4, A5, brandFontCss, download, inkBox, jpegFromSvg, loadJSZip, narrowFontCss, pdfFromElements, pdfFromSvgs, pdfText, slipSvg, statementFontCss, tankerBillSvg, toDataUrl,
  statementFontCss as letterFontCss, useNarrowFont, zipBlob,
} from './render.js';
import {
  comparePiLog, dmyy, indian, nextPiNo, piCheckClean, piDiscount, piEffective, piFileName, piKey, piMatches, picturePaths, readTankerBilling,
  samePiNo,
} from './quote.js';
import {
  cellInput, cnFields, cnFileName, cnLogFromModel, cnLogRowOf, cnMacro, cnProblem, cnRecord, cnStateFromLog, DEFAULT_PI_MACRO, docCalc, docFileName,
  DOCS, formValue, helperRows, inputsOf, layoutOf, nextCnNo, pageValues, piLogRowOf, piMacro, piProblem, piStateFromLog, rspCell, selfCheck,
} from './docs.js';
import { isErr, isoToSerial, makeCalc } from './formula.js';
import { buildModel, DOC_SHEETS, MODEL_PARTS } from './xl-model.js';
import { vbaModules } from './vba.js';
import { canvasMeasure, sheetSvg } from './sheet-svg.js';
import { billStatementSvgs, dailySummarySvg, DEFAULT_LAYOUT, ledgerSvg, PAGE, PAGE_PT } from './statement-svg.js';
import {
  bulkRows, cellText, COLUMN_HEAD, DEFAULT_BULK_WIDTHS, isNegative, xlDate, xlRupee,
} from './account.js';
import {
  addDays, buildStatements, ddmmyy, defaultMonth, firstWord, indAuto, ledgerRows, monthEnd, monthLabel, monthStart, rupeeAuto,
  shareBatches,
} from './statements.js';
import {
  poRowName, poSummary, PRODUCT_LABEL, RATE_HEAD_ROWS, rateChart, rateChartSheet, retailStatement, statementLines, unitLabel,
} from './ledger-view.js';
import {
  dMon, drCr, ledgerPagesSvg, monthSlice, outstandingCardSvg, outstandingListSvg, qtyText, rupees, SHARE_PAGE, SHARE_PAGE_PT,
} from './share-svg.js';
import {
  bulkAccount, cardOf, cardSets, companyCard, groupName, outstandingFor, poGroups, unitsBlock,
} from './outstanding.js';
import { modeSummary } from './modes.js';
import { fitPaperToPage } from './paper-fit.js';
import { handwritePage } from './handwrite.js';
import { actualShortage, latestDays, latestMorning, monthPdfsDue, mornings, PRODUCTS as REG_PRODUCTS, productMonth, pumpSales, readDipChart, readDsr, readStock, registerAlerts, registerKind, shortageAlert, testingAdjust } from './register.js';
import { adjustHtml, alertText, dsrTableHtml, gainClass, gainLoss, litres as regLitres, monthComplete as regMonthComplete, monthLabel as regMonth, monthPagesHtml, morningHtml, stockTableHtml } from './register-view.js';
import { loanFromTerms, loanStatus, loansSummary, ordinal, parseSchedule, vehFromText } from '../../fleet/js/loans.js';
import { memoryStore, supabaseStore } from './store.js';
import {
  analyseTally, coverage, decodeText, filterVouchers, hasMasters, KINDS, looksLikeXml, mergeTally, normName, parseDaybookSheet, parseTallyXml, spanOf,
  voucherSheet,
} from './tally-file.js';
import { financials, monthsBetween, trialSheet } from './tally-fin.js';
import { appAccounts, reconcile, reconSheet, reconStart } from './tally-recon.js';
import { finHtml, gapText, reconHtml, stockHtml, viewTabsHtml } from './tally-reports.js';
import { pivotSheet, stockSummary } from './tally-stock.js';
import {
  checksHtml, fileHeadHtml, ledgersHtml, overviewHtml, PAGE_SIZE, partiesHtml, productsHtml, ratesHtml, seriesHtml, trendHtml, typesHtml,
  vehiclesHtml, vouchersHtml,
} from './tally-view.js';
import { fmtDate, fmtLitres, fmtMoney, fyOf, normKey, suggestLedgerName } from './util.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';
const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const PRODUCT = { HSD: 'Diesel (HSD)', MS: 'Petrol (MS)', XG: 'XtraGreen', OTHER: 'Other' };

const root = document.getElementById('app');
const state = { store: null, client: null, me: null, demo: false, customersFilter: 'new', customersQuery: '', billFilter: 'all', showAllBills: false };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// small UI helpers
// ---------------------------------------------------------------------------
function toast(message, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
  el.textContent = message;
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 3500);
}

const main = () => document.getElementById('main');
const setMain = (html) => { main().innerHTML = html; };
const loadingHtml = (text = 'Loading…') => `<div class="loading"><span class="spinner"></span>${esc(text)}</div>`;
const errorHtml = (err) => `<div class="card bad-card"><b>Something went wrong.</b><p>${esc(err && err.message ? err.message : err)}</p></div>`;
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
const SHARE_ICON = '<svg class="ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err && err.message ? err.message : String(err), 'bad');
    return undefined;
  }
}

let sheetjs = null;
async function loadSheetJS() {
  if (sheetjs) return sheetjs;
  try {
    sheetjs = await import(SHEETJS);
  } catch {
    throw new Error('Couldn\'t load the Excel reader (cdn.sheetjs.com). Check the internet connection and try again.');
  }
  return sheetjs;
}

// ---------------------------------------------------------------------------
// start-up: demo, setup, login, members
// ---------------------------------------------------------------------------
async function boot() {
  const params = new URLSearchParams(location.search);
  const cfg = window.LEDGER_CONFIG || {};
  if (params.has('demo')) {
    state.demo = true;
    const { DEMO_WORKBOOK } = await import('./demo-workbook.js');
    const seed = demoSeed(new Date(), DEMO_WORKBOOK);
    state.store = memoryStore(seed);
    state.demoPayQueue = seed.payQueue;
    return enter();
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return renderSetup();
  let createClient;
  try {
    ({ createClient } = await import(SUPABASE_JS));
  } catch {
    return renderCentered('<h1>Vriddhi Ledger</h1><p>Couldn\'t load the sign-in library. Check the internet connection and reload.</p>');
  }
  state.client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'vriddhi-ledger-auth' },
  });
  state.store = supabaseStore(state.client);
  state.client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') renderLogin();
  });
  const { data } = await state.client.auth.getSession();
  if (!data || !data.session) return renderLogin();
  return enter();
}

function renderCentered(inner) {
  root.innerHTML = `<div class="center"><div class="card center-card">${inner}</div></div>`;
}

function renderSetup() {
  renderCentered(`
    <h1>Vriddhi <b>Ledger</b></h1>
    <p>This app isn't connected to its database yet. One-time setup (the steps are in <code>ledger/README.md</code>):</p>
    <ol class="steps">
      <li>Create a new Supabase project just for the ledger.</li>
      <li>Run <code>supabase/ledger-schema.sql</code> in its SQL Editor.</li>
      <li>Add your login under Authentication → Users, then run <code>select ledger_add_member('you@example.com');</code></li>
      <li>Put the project's URL and publishable (anon) key in <code>ledger/config.js</code>.</li>
    </ol>
    <p><a class="btn" href="?demo">Try the demo</a> <span class="muted">— made-up data, nothing is saved.</span></p>`);
}

function renderLogin(message = '') {
  renderCentered(`
    <h1>Vriddhi <b>Ledger</b></h1>
    <form id="login" class="stack" autocomplete="on">
      <label>Email <input name="email" type="email" required autocomplete="username"></label>
      <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn" type="submit">Sign in</button>
      <p class="form-msg bad-text" role="alert">${esc(message)}</p>
    </form>`);
  const form = document.getElementById('login');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    const { error } = await state.client.auth.signInWithPassword({
      email: form.email.value.trim(), password: form.password.value,
    });
    if (error) return renderLogin(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
    return enter();
  });
}

async function enter() {
  let me;
  try {
    me = await state.store.whoami();
  } catch (err) {
    renderCentered(`<h1>Vriddhi <b>Ledger</b></h1>${errorHtml(err)}<p><button class="btn ghost" id="out">Sign out</button></p>`);
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  state.me = me;
  if (!me.member) {
    renderCentered(`
      <h1>Vriddhi <b>Ledger</b></h1>
      <p>You're signed in as <b>${esc(me.email)}</b>, but this login isn't allowed into the ledger yet.</p>
      <p>The owner can allow it by running this once in the Supabase SQL Editor:</p>
      <pre class="code">select ledger_add_member('${esc(String(me.email).replace(/'/g, "''"))}');</pre>
      <p><button class="btn ghost" id="out">Sign out</button></p>`);
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  renderShell();
  if (!state.routing) {
    window.addEventListener('hashchange', route);
    state.routing = true;
  }
  route();
  // what the Mac sent: imported straight away, and again whenever the app comes back into view
  autoImportMac();
  if (!state.watchingMac) {
    state.watchingMac = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoImportMac(); });
  }
}

async function signOut() {
  if (state.client) await state.client.auth.signOut();
  else location.href = location.pathname;
}

// ---------------------------------------------------------------------------
// shell + routing
// ---------------------------------------------------------------------------
const TABS = [
  ['#/', 'Home'], ['#/register', 'Register'], ['#/import', 'Import'], ['#/bills', 'Bills'], ['#/quotes', 'Quotes'], ['#/statements', 'Statements'], ['#/payments', 'Payments'], ['#/pos', 'POs'],
  ['#/loans', 'Loans'], ['#/customers', 'Customers'], ['#/sales', 'Sales'], ['#/tally', 'Tally'],
];

function renderShell() {
  root.innerHTML = `
    <header class="top">
      <a class="brand" href="#/">Vriddhi <b>Ledger</b></a>
      ${state.demo ? '<span class="pill warn-pill" title="Nothing you do here is saved">Demo<span class="hide-sm"> · made-up data · nothing is saved</span></span>' : ''}
      <span class="spacer"></span>
      <span class="who">${esc(state.me.email)}</span>
      <button class="btn ghost small" id="signout">${state.demo ? 'Leave demo' : 'Sign out'}</button>
    </header>
    <nav class="tabs" aria-label="Sections">
      ${TABS.map(([href, name]) => `<a href="${href}" data-tab="${href}">${name}</a>`).join('')}
    </nav>
    <div id="auto-bar" aria-live="polite"></div>
    <main id="main"></main>`;
  document.getElementById('signout').addEventListener('click', signOut);
}

const ROUTES = [
  [/^#?\/?$/, () => viewHome()],
  [/^#\/register(?:\/(stock))?(?:\?m=(\d{4}-\d{2}))?$/, (m) => viewRegister(m[1] || '', m[2] || null)],
  [/^#\/import$/, () => viewImport()],
  [/^#\/pos$/, () => viewPos()],
  [/^#\/pos\/(.+)$/, (m) => viewPoGroup(decodeURIComponent(m[1]))],
  [/^#\/customers$/, () => viewCustomers()],
  [/^#\/sales(?:\/(\d{4}-\d{2}-\d{2}))?$/, (m) => viewSales(m[1] || null)],
  [/^#\/bills$/, () => viewBills()],
  [/^#\/quotes(?:\/(pi|log|cn|cnlog|letter))?$/, (m) => viewQuotes(m[1] || '')],
  [/^#\/statements$/, () => viewStatements()],
  [/^#\/payments$/, () => viewPayments()],
  [/^#\/payments\/modes$/, () => viewPaymentModes()],
  [/^#\/loans$/, () => viewLoans()],
  [/^#\/loans\/(.+)$/, (m) => viewLoan(decodeURIComponent(m[1]))],
  [/^#\/tally(?:\/(fin|recon|stock))?$/, (m) => viewTally(m[1] || '')],
  [/^#\/account\/([cg])\/([^?]+)(?:\?m=(\d{4}-\d{2}))?$/, (m) => viewAccount(m[1], decodeURIComponent(m[2]), m[3])],
];

async function route() {
  if (!document.getElementById('main')) return;           // signed out
  const hash = location.hash || '#/';
  document.querySelectorAll('.tabs a').forEach((a) => {
    const tab = a.dataset.tab;
    const on = tab === '#/' ? hash === '#/' || hash === '' : hash.startsWith(tab);
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    if (on && a.parentElement.scrollWidth > a.parentElement.clientWidth) {   // phones: the tab bar scrolls
      a.parentElement.scrollLeft = a.offsetLeft - (a.parentElement.clientWidth - a.offsetWidth) / 2;
    }
  });
  const hit = ROUTES.map(([re, fn]) => [hash.match(re), fn]).find(([m]) => m);
  setMain(loadingHtml());
  try {
    await (hit ? hit[1](hit[0]) : viewHome());
  } catch (err) {
    console.error(err);
    setMain(errorHtml(err));
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// PO bookkeeping shared by Home and the PO screens
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
async function viewHome() {
  const [sum, pod, loans, regAlerts] = await Promise.all([state.store.summary(), state.store.poData(), loansList(true).catch(() => []),
    registerAll().then((all) => registerAlerts(all)).catch(() => [])]);
  const groups = poGroups(pod);
  const empty = !sum.last_sale_date;
  const todo = [];
  if (sum.needs_ledger) {
    todo.push(`<a class="todo" href="#/customers"><b>${plural(sum.needs_ledger, 'customer')}</b> need a ledger name</a>`);
  }
  for (const g of groups) {
    const name = esc(groupName(g.group, g.members));
    const href = `#/pos/${encodeURIComponent(g.group.code)}`;
    if (g.toPick) todo.push(`<a class="todo warn" href="${href}"><b>${name}:</b> ${plural(g.toPick, 'bill')} to pick a PO for — more than one PO has room (Excel: “Select PO ▼”)</a>`);
    if (g.noPo) todo.push(`<a class="todo warn" href="${href}"><b>${name}:</b> ${plural(g.noPo, 'bill')} without a PO — add a new PO</a>`);
    if (g.needsUnit) todo.push(`<a class="todo warn" href="${href}"><b>${name}:</b> ${plural(g.needsUnit, 'bill')} need a unit</a>`);
  }
  // Loans & EMI: EMIs marked not paid
  for (const x of loans.length ? loansSummary(loans, localToday()).loans.filter((y) => y.overdueN) : []) {
    todo.push(`<a class="todo warn" href="#/loans/${encodeURIComponent(x.loan.lan)}"><b>${esc(plateText(x.loan.veh) || x.loan.lan)}:</b> ${plural(x.overdueN, 'EMI')} marked not paid · ${esc(rupees(x.overdueAmt))}</a>`);
  }
  // the Register: a product whose books gained this month (keep them in shortage)
  for (const a of regAlerts) {
    todo.push(`<a class="todo warn" href="#/register/stock"><b>${esc(REG_PRODUCTS.find((p) => p.key === a.key).short)}:</b> the Stock Register gained ${esc(regLitres(a.gain))} L this month (to ${a.day} ${esc(regMonth(a.month).slice(0, 3))}) — raise the testing adjustment${a.left > 0 ? ` (~${a.perDay} L more testing a day)` : ''}</a>`);
  }
  const last = sum.last_import;
  const play = !state.greeted;                                   // the feather flies once per app open
  state.greeted = true;
  setMain(`
    ${empty ? `<section class="hero card">
        <h2>Welcome</h2>
        <p>Start by uploading your <b>Master Ledger</b>: the app copies your sales, payments, customers and PO lists from it. Then import each day's Tally DayBook here instead of in Excel.</p>
        <p><a class="btn" href="#/import">Upload Master Ledger</a></p></section>` : `
    <section class="card greet">
      <h1 class="jsk${play ? ' play' : ''}"><span class="jsk-text">Jai Shree Krishna</span><img class="jsk-feather" src="assets/morpankh.png" alt=""></h1>
      <p class="greet-dates"><span>Today is <b>${esc(longDate(localToday()))}</b></span><span>Master File is updated until <b>${sum.master_until ? esc(fmtDate(sum.master_until)) : 'not uploaded yet'}</b></span></p>
    </section>`}
    <div id="mac-home"></div>
    ${empty ? '' : `<div id="dash">${loadingHtml('Working out the figures…')}</div>`}
    ${todo.length ? `<section class="card"><h3>Needs your attention</h3><div class="todos">${todo.join('')}</div></section>` : (empty ? '' : '<section class="card good-card"><b>All caught up.</b> Every bulk bill has a PO and every customer has a ledger.</section>')}
    ${groups.length ? `<section class="card"><h3>PO lists</h3><div class="grid">${groups.map(poCard).join('')}</div></section>` : ''}
    ${last ? `<p class="muted small">Last upload: ${last.kind === 'daybook' ? 'DayBook' : 'Master Ledger'} “${esc(last.file_name)}” · ${new Date(last.created_at).toLocaleString('en-IN')}${last.by_email ? ` · ${esc(last.by_email)}` : ''}</p>` : ''}`);
  // workbooks the Mac uploaded that the automatic import couldn't bring in
  macUploadsList().then((ups) => {
    const fresh = ups.filter((u) => u.fresh && state.macFailed && state.macFailed[u.name]);
    const mac = document.getElementById('mac-home');
    if (!fresh.length || !mac) return;
    mac.innerHTML = `<section class="card"><h3>New from your Mac — not imported</h3>
      <p class="muted small">${fresh.map((u) => `${esc(u.label)}: ${esc(state.macFailed[u.name])}`).join('<br>')}</p>
      <div class="todos">${fresh.map((u) => `<div class="todo warn"><b>${esc(u.label)}</b> · uploaded ${esc(upWhen(u.updated_at))}
        <span class="row-gap"><button class="btn small" data-mac-open="${esc(u.name)}">Review &amp; import</button><button class="btn ghost small" data-mac-skip="${esc(u.name)}">Skip this one</button></span></div>`).join('')}</div></section>`;
    mac.querySelectorAll('[data-mac-open]').forEach((b) => b.addEventListener('click', () => { state.pendingUpload = fresh.find((u) => u.name === b.dataset.macOpen); location.hash = '#/import'; }));
    mac.querySelectorAll('[data-mac-skip]').forEach((b) => b.addEventListener('click', () => guard(async () => {
      await markUploadSeen(fresh.find((u) => u.name === b.dataset.macSkip));
      b.closest('.todo').remove();
      if (!mac.querySelector('.todo')) mac.innerHTML = '';
    })));
  }).catch(() => {});
  const box = document.getElementById('dash');
  if (box) {
    try {
      await renderDashboard(box);
    } catch (err) {
      console.error(err);
      box.innerHTML = errorHtml(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Register — the Daily Stock Register (the paper DSR book) and the Stock
// Register, from E-DSR.xlsx, Stock Register.xlsm and DIP Chart.xlsm
// (register.js); the Mac's sync uploads them, or Import here
// ---------------------------------------------------------------------------
const REGISTER_SCHEMA = 'The database needs an update for the Register: run supabase/ledger-schema.sql again in the Supabase SQL Editor (safe to re-run).';
async function registerCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (/could not find the function|does not exist|schema cache/i.test(String((err && err.message) || err))) throw new Error(REGISTER_SCHEMA);
    throw err;
  }
}
async function registerAll(force = false) {
  if (force || !state.reg || Date.now() - state.reg.at > 5 * 60000) state.reg = { at: Date.now(), all: await registerCall(() => state.store.register()) };
  return state.reg.all;
}

// Paper pages drawn off the screen at full size, as printed (no highlights or
// marks) -> a PDF Blob, a page each. pages: HTML strings, or .paper elements to copy.
// look 'hand': the Monthly PDFs' "Handwritten on paper" option (handwrite.js)
// totals false: the TOTAL / G.TOTAL line left blank (its boxes drawn, not filled in)
async function papersPdf(pages, { look = 'print', totals = true } = {}) {
  if (look === 'hand' && document.fonts) {
    await Promise.all([document.fonts.load('400 17px Kalam'), document.fonts.load('700 17px Kalam')]).catch(() => {});
  }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-30000px;top:0;';
  for (const pg of pages) {
    let paper;
    if (typeof pg === 'string') {
      const d = document.createElement('div');
      d.innerHTML = pg;
      paper = d.querySelector('.paper');
    } else {
      paper = pg.cloneNode(true);
      paper.style.transform = '';
    }
    paper.style.setProperty('--bw', '1px');
    paper.classList.add('as-printed');
    if (!totals) paper.querySelectorAll('tr.tot td.ink').forEach((td) => { td.textContent = ''; });
    if (look === 'hand') handwritePage(paper);
    holder.append(paper);
  }
  document.body.append(holder);
  // each page shaped like the A4 sheet (landscape, less the margins), so it fills it
  for (const paper of holder.children) fitPaperToPage(paper, 0, 0, (595.28 - 32) / (841.89 - 32));
  try {
    return await pdfFromElements([...holder.children]);
  } finally {
    holder.remove();
  }
}
// "PDF ready": Print / Share… (the share sheet: Print, Save to Files, WhatsApp) or Save
function pdfReadyBar(box, blob, name) {
  const file = new File([blob], name, { type: 'application/pdf' });
  box.innerHTML = `<div class="todo reg-pdf-ready"><span><b>PDF ready</b> · ${esc(name)}</span>
    <span class="row-gap"><button class="btn small" data-pdf-share type="button">${cannotPrint() ? 'Print / Share…' : 'Share…'}</button><button class="btn ghost small" data-pdf-save type="button">Save</button></span></div>`;
  box.querySelector('[data-pdf-share]').addEventListener('click', () => guard(() => shareOrSave([file], name)));
  box.querySelector('[data-pdf-save]').addEventListener('click', () => download(file, name));
}

// Which months' PDFs have been made (this device): {month: {dsr, stock}}
const PDFS_KEY = 'vf_register_pdfs_v1';
function pdfsMade() {
  try { return JSON.parse(localStorage.getItem(PDFS_KEY) || '{}') || {}; } catch { return {}; }
}
function markPdfMade(month, kind) {
  const all = pdfsMade();
  all[month] = { ...(all[month] || {}), [kind]: true };
  try { localStorage.setItem(PDFS_KEY, JSON.stringify(all)); } catch { /* private mode: the card just keeps reminding */ }
}

// A phone or tablet: window.print() does nothing in an iPhone / iPad
// home-screen app (and printing a page is awkward on any phone)
function cannotPrint() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod|Android/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    || navigator.standalone === true || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

// The paper page's size: scaled to the width it has (never past its own size),
// or the size picked with − / +. It's laid out at full size and scaled as a
// whole (so nothing moves out of its line), inside a box of the scaled size.
// Its lines are drawn wider as it gets smaller, so they stay visible however
// small it is (a phone drops lines thinner than about ¾ of a pixel).
const lineFor = (z) => `${Math.max(1, Math.round((0.75 / z) * 100) / 100)}px`;
function paperFit() {
  const box = document.querySelector('.paper-scroll');
  const paper = box && box.querySelector('.paper');
  if (!paper) return 1;
  const natural = paper.offsetWidth;                       // laid out at full size (a transform doesn't change it)
  const avail = box.clientWidth - 12;
  return natural ? Math.min(1, Math.floor((avail / natural) * 1000) / 1000) : 1;
}
function fitRegisterPaper(reg) {
  const paper = document.querySelector('.paper-scroll .paper');
  if (!paper) return;
  let fit = paper.parentElement;
  if (!fit.classList.contains('paper-fit')) {
    fit = document.createElement('div');
    fit.className = 'paper-fit';
    paper.replaceWith(fit);
    fit.appendChild(paper);
  }
  let z = reg.zoom;
  if (!z) {
    // thicker lines widen the page a little: fit, set the lines, fit again
    paper.style.removeProperty('--bw');
    z = paperFit();
    for (let i = 0; i < 3; i++) {
      paper.style.setProperty('--bw', lineFor(z));
      const again = paperFit();
      if (Math.abs(again - z) < 0.002) break;
      z = again;
    }
  }
  paper.style.setProperty('--bw', lineFor(z));
  paper.style.transform = z === 1 ? '' : `scale(${z})`;
  fit.style.width = `${Math.ceil(paper.offsetWidth * z)}px`;
  fit.style.height = `${Math.ceil(paper.offsetHeight * z)}px`;
  const pc = document.getElementById('reg-zoom-pc');
  if (pc) pc.textContent = `${Math.round(z * 100)}%${reg.zoom ? '' : ' · fits the screen'}`;
}

// what's typed on the Register (dips, the testing adjustment): read the
// latest, change it, keep it
async function saveRegisterEntry(k, mutate) {
  const all = await registerAll(true);
  const data = JSON.parse(JSON.stringify((all[k] && all[k].data) || {}));
  mutate(data);
  await registerCall(() => state.store.registerSave(k, data));
  state.reg = null;
}
const typedNumber = (v, { min = 0, max = 1e7 } = {}) => {
  const t = String(v ?? '').trim();
  if (t === '') return null;
  const n = Number(t.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`“${t}” isn't a number between ${min} and ${max}.`);
  return Math.round(n * 100) / 100;
};

// one of the three workbooks, read here and kept -> what it brought in, in words
async function importRegisterFile(file) {
  const XLSX = await loadSheetJS();
  const wb = readWorkbook(XLSX, await file.arrayBuffer(), { all: true });
  const kind = registerKind(wb);
  if (!kind) throw new Error(`${file.name} isn't the E-DSR, the Stock Register or the DIP Chart (none of their sheets is in it).`);
  let note;
  if (kind === 'dsr') {
    const doc = readDsr(wb);
    await registerCall(() => state.store.registerImport('dsr', file.name, doc, {}));
    note = `E-DSR for ${regMonth(doc.month)} (${Object.keys(doc.products).map((k) => REG_PRODUCTS.find((p) => p.key === k).short).join(', ')})`;
  } else if (kind === 'stock') {
    const { log, ...doc } = readStock(wb);
    const res = await registerCall(() => state.store.registerImport('stock', file.name, doc, log));
    note = `Stock Register for ${regMonth(doc.month)}, ${plural(res.mornings, 'morning')} of its Macro Log`;
  } else {
    const { log, ...doc } = readDipChart(wb);
    await registerCall(() => state.store.registerImport('dipchart', file.name, doc, log));
    note = `DIP Chart${doc.reading.date ? ` (reading of ${fmtDate(doc.reading.date)})` : ''}`;
  }
  state.reg = null;
  return note;
}

// keep: drawn again after a change here (the testing adjustment card stays as
// it was); otherwise it opens folded and locked
async function viewRegister(tab, month, keep = false) {
  const all = await registerAll();
  const today = localToday();
  const months = [...new Set(Object.keys(all).filter((k) => /^(dsr|stock):/.test(k)).map((k) => k.slice(-7)))].sort().reverse();
  const importBox = `<label class="file"><input type="file" id="reg-file" accept=".xlsx,.xlsm,.xls" multiple><span class="btn ghost small">Import workbooks…</span></label>`;
  const tabs = `<nav class="chips view-chips" aria-label="Register">${[['', 'Daily Stock Register'], ['stock', 'Stock Register']].map(([k, name]) => `<a class="chip${k === tab ? ' on' : ''}" href="#/register${k ? `/${k}` : ''}${month ? `?m=${month}` : ''}"${k === tab ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav>`;
  const bindImport = () => document.getElementById('reg-file')?.addEventListener('change', (e) => guard(async () => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const notes = [];
    for (const f of files) notes.push(await importRegisterFile(f));
    toast(`Brought in: ${notes.join(' · ')}.`);
    await route();
  }));
  if (!months.length && !all.dipchart) {
    setMain(`${tabs}<section class="card hero"><h2>Register</h2>
      <p>The pump's <b>Daily Stock Register</b> (dips, opening stock, receipts, meter readings, testing and sales, as in the DSR book) and the <b>Stock Register</b> (book stock against the tank stock, and the shortage), from three workbooks:
      <b>E-DSR.xlsx</b>, <b>Stock Register.xlsm</b> and <b>DIP Chart.xlsm</b>.</p>
      <p>The Mac's Google Drive sync sends them here by itself. Or bring them in from this device:</p>
      <p>${importBox}</p></section>`);
    bindImport();
    return;
  }
  const m = month && months.includes(month) ? month : months[0] || today.slice(0, 7);
  const stockDocs = Object.keys(all).filter((k) => k.startsWith('stock:')).map((k) => all[k].data);
  const by = mornings((all.tanklog && all.tanklog.data) || {}, stockDocs);
  const chart = all.dipchart ? all.dipchart.data.chart : null;
  const pmOf = (mk, key) => productMonth({
    month: mk, key, by, chart,
    dsr: (all[`dsr:${mk}`] && all[`dsr:${mk}`].data.products[key]) || null,
    stock: (all[`stock:${mk}`] && all[`stock:${mk}`].data.products[key]) || null,
    typed: (all[`dips:${mk}`] && all[`dips:${mk}`].data[key]) || null,
  });
  const reg = state.regView || (state.regView = { product: 'HSD', editDips: false });
  if (!keep) { reg.adjOpen = false; reg.adjEdit = false; reg.zoom = null; }
  const key = REG_PRODUCTS.some((p) => p.key === reg.product) ? reg.product : 'HSD';
  const pm = pmOf(m, key);
  const { latest: latestDay, prev: prevDay } = latestDays(pm);
  const adj = all[`dsr:${m}`] ? testingAdjust(all, key).get(m) : null;
  const split = adj ? actualShortage(pm, adj) : null;
  const asc = [...months].reverse();
  const monthBefore = asc[asc.indexOf(m) - 1] || null;
  const monthAfter = asc[asc.indexOf(m) + 1] || null;
  const latest = latestMorning(by, chart, today);
  const shortages = {};
  if (months[0]) {
    for (const p of REG_PRODUCTS) {
      const x = pmOf(months[0], p.key);
      const a = all[`dsr:${months[0]}`] ? testingAdjust(all, p.key).get(months[0]) : null;
      const sp = a ? actualShortage(x, a) : null;
      shortages[p.key] = { value: x.shortageNow, actual: sp ? sp.actual : null, alert: shortageAlert(x), day: x.shortageDay ? fmtDate(`${months[0]}-${String(x.shortageDay).padStart(2, '0')}`).slice(0, 6) : '' };
    }
  }
  const fileLine = [['dsr', `dsr:${m}`, 'E-DSR'], ['stock', `stock:${m}`, 'Stock Register'], ['dip', 'dipchart', 'DIP Chart']]
    .map(([, k, name]) => (all[k] ? `${name} <span class="faint">${esc(new Date(all[k].updated_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : `${name} <span class="warn-text">not brought in</span>`)).join(' · ');
  const hasDsr = !!all[`dsr:${m}`];
  const hasStock = !!all[`stock:${m}`];
  const t = pm.totals;
  const sold = pm.rows.filter((r) => r.sale != null);
  const kpis = tab === 'stock' ? `<div class="kpis">
      <div class="kpi"><span class="lbl">Stock Register shortage${pm.shortageDay ? ` to ${pm.shortageDay} ${esc(regMonth(m).slice(0, 3))}` : ''}</span><span class="val ${gainClass(pm.shortageNow)}">${gainLoss(pm.shortageNow)}<small>&nbsp;L</small></span><span class="sub">book − tank stock · made up: testing adjustment + actual</span></div>
      ${split ? `<div class="kpi hero"><span class="lbl">Actual</span><span class="val">${gainLoss(split.actual)}<small>&nbsp;L</small></span><span class="sub">less the testing adjustment ${gainLoss(split.adjust)}</span></div>` : ''}
      <div class="kpi"><span class="lbl">Opening shortage</span><span class="val ${gainClass(pm.openShortage)}">${gainLoss(pm.openShortage)}</span><span class="sub">Stock Register's, as typed there</span></div>
      <div class="kpi"><span class="lbl">Stock Register variation</span><span class="val ${gainClass(t.variation)}">${gainLoss(t.variation)}</span><span class="sub">this month${split ? ` · actual ${gainLoss(split.actualVar)}` : ''}</span></div>
    </div>` : `<div class="kpis">
      <div class="kpi hero"><span class="lbl">Sale${sold.length ? ` to ${sold[sold.length - 1].day} ${esc(regMonth(m).slice(0, 3))}` : ''}</span><span class="val">${regLitres(t.sale)}<small>&nbsp;L</small></span><span class="sub">${plural(sold.length, 'day')}${sold.length ? ` · ${regLitres(Math.round((t.sale / sold.length) * 100) / 100)} L a day` : ''}</span></div>
      <div class="kpi"><span class="lbl">Receipts</span><span class="val">${regLitres(t.receipt)}</span><span class="sub">${plural(pm.rows.filter((r) => r.receipt).length, 'load')}</span></div>
      <div class="kpi"><span class="lbl">Testing</span><span class="val">${regLitres(t.test)}</span><span class="sub">returned to the tank</span></div>
    </div>`;
  const missing = tab === 'stock' ? (hasStock ? '' : `<p class="warn-text small">The Stock Register for ${esc(regMonth(m))} isn't here: the actual tank stock comes from the DIP Chart's readings instead (marked *).</p>`)
    : (hasDsr ? '' : `<p class="warn-text small">The E-DSR for ${esc(regMonth(m))} isn't here, so there are no meter readings or sales.</p>`);
  const flagged = pm.rows.filter((r) => (tab === 'stock' ? r.actualAlt != null : r.differs != null));
  // a month that's over and whose PDFs haven't been made yet: the card flashes
  // (only once its figures are all in: the last day's sale needs the next month's first readings)
  const monthComplete = (mk) => regMonthComplete(all, mk);
  const pdfDue = monthPdfsDue(months, today, pdfsMade(), monthComplete);
  const unknownDips = pm.product.tanks === 2 && pm.rows.some((r) => r.stock != null && r.dips[0] == null);
  setMain(`
    ${tabs}
    ${pdfDue ? `<button class="todo warn reg-due-link" type="button" id="reg-due-go"><b>${esc(regMonth(pdfDue.month))} is over</b> — download its monthly PDFs ↓</button>` : ''}
    <section class="card reg-paper-card">
      <div class="row-between"><div class="chips" role="group" aria-label="Product">${REG_PRODUCTS.map((p) => `<button class="chip${p.key === key ? ' on' : ''}" data-reg-product="${p.key}">${esc(p.short)}</button>`).join('')}</div>
        <span class="row-gap">${months.length > 1 ? `<select id="reg-month" aria-label="Month">${months.map((x) => `<option value="${x}"${x === m ? ' selected' : ''}>${esc(regMonth(x))}</option>`).join('')}</select>` : ''}
          ${tab === 'stock' ? '' : `<button class="btn ${reg.editDips ? '' : 'ghost '}small" id="reg-edit-dips" type="button">${reg.editDips ? 'Done' : 'Edit dips'}</button>`}
          <button class="btn ghost small" id="reg-print" type="button">Print</button></span></div>
      <div class="zoom-bar" role="group" aria-label="Page size"><button class="btn ghost small" data-reg-zoom="out" aria-label="Smaller">−</button><button class="btn ghost small" data-reg-zoom="fit">Fit</button><button class="btn ghost small" data-reg-zoom="in" aria-label="Bigger">+</button>
        <span class="muted small" id="reg-zoom-pc"></span></div>
      <div id="reg-pdf"></div>
      ${missing}
      ${(() => { const al = shortageAlert(pm); return al ? `<div class="todo warn reg-alert">${esc(alertText(al, pm.product.short))}</div>` : ''; })()}
      ${reg.editDips && tab !== 'stock' ? '<p class="small warn-text">Type a dip where it was misread (or missing) — it\'s kept and written over the DIP Chart\'s; clear it to go back. <b>Done</b> when finished.</p>' : ''}
      ${tab === 'stock' ? stockTableHtml(pm, { latest: latestDay, adj }) : dsrTableHtml(pm, { latest: latestDay, prev: prevDay, edit: reg.editDips })}
      ${flagged.length ? `<p class="small"><i class="reg-flag">!</i> ${tab === 'stock'
        ? `The Stock Register's tank stock differs from the DIP Chart's on ${flagged.map((r) => r.day).join(', ')} — hover or tap the mark to see both.`
        : `The Stock Register's stock differs from the DIP Chart's on ${flagged.map((r) => r.day).join(', ')}; the DIP Chart's is written here.`}</p>` : ''}
      ${unknownDips ? '<p class="small muted"><b>?</b> HSD tank dips: the DIP Chart keeps each tank\'s stock only for the day it\'s brought in, so earlier days have just the total — <b>Edit dips</b> to write them from the book.</p>' : ''}
      ${pm.rows.some((r) => r.dipOff != null) ? '<p class="small"><i class="reg-flag">!</i> Typed dips that don\'t come to the morning\'s stock on the DIP Chart — check them.</p>' : ''}
      <p class="muted small">${tab === 'stock'
        ? 'As the Stock Register works it out: book stock from the E-DSR (opening + receipts − sale); actual tank stock = the next morning\'s dip stock; shortage = book stock left − actual tank stock (made up: the testing adjustment + the stock\'s actual variation — see below); variation = the change in the shortage from the day before (the first day: from the opening shortage). The page keeps the Stock Register\'s signs (a shortage is +); everywhere else here a shortage is − and a gain +.'
        : 'Opening stock is the morning\'s dip stock (the DIP Chart\'s reading, else the Stock Register\'s) and the dips are that stock read on the DIP Chart; meter readings and testing are the E-DSR\'s; sale = the next morning\'s readings − this morning\'s − testing. Written as by hand: whole litres and meter readings, sales to the paisa.'}</p>
      ${kpis}
    </section>
    ${tab === 'stock' && adj ? `<details class="card fold" id="reg-adjust"${reg.adjOpen ? ' open' : ''}>
      <summary><b>Testing adjustment &amp; actual shortage</b> <span class="muted">· ${esc(pm.product.short)} — Stock Register <span class="${gainClass(split.shortage)}">${gainLoss(split.shortage)}</span> · actual <span class="${gainClass(split.actual)}">${gainLoss(split.actual)}</span></span><span class="fold-hint">tap to ${reg.adjOpen ? 'close' : 'open'}</span></summary>
      ${adjustHtml(adj, pm, split, { prevMonth: monthBefore, nextMonth: monthAfter, locked: !reg.adjEdit })}</details>` : ''}
    <section class="card${pdfDue ? ' flash' : ''}" id="reg-month-pdfs">
      <div class="row-between"><h2>Monthly PDFs</h2>
        <select id="reg-pdf-month" aria-label="Month">${months.map((x) => `<option value="${x}"${x === (pdfDue ? pdfDue.month : m) ? ' selected' : ''}>${esc(regMonth(x))}</option>`).join('')}</select></div>
      ${pdfDue ? `<p class="warn-text small" id="reg-pdf-due"><b>${esc(regMonth(pdfDue.month))} is over</b> — download its ${pdfDue.missing.length === 2 ? 'DSR and Stock Register' : pdfDue.missing[0] === 'dsr' ? 'DSR' : 'Stock Register'} PDF${pdfDue.missing.length === 2 ? 's' : ''} to keep.</p>` : ''}
      <p class="muted small">A month's pages for all three products in one PDF — HSD, MS and XtraGreen, a page each, as printed. Any month the app has.</p>
      <div class="chips small-chips" role="group" aria-label="Look">${[['print', 'Printed'], ['hand', 'Handwritten on paper']].map(([k, n]) => `<button class="chip${(reg.pdfLook || 'print') === k ? ' on' : ''}" type="button" data-pdf-look="${k}">${n}</button>`).join('')}</div>
      <div class="chips small-chips" role="group" aria-label="Totals">${[['on', 'Totals: Written'], ['off', 'Totals: Left blank']].map(([k, n]) => `<button class="chip${(reg.pdfTotals || 'on') === k ? ' on' : ''}" type="button" data-pdf-totals="${k}">${n}</button>`).join('')}</div>
      <div class="row-gap"><button class="btn small" type="button" data-month-pdf="dsr">DSR — all products</button><button class="btn small" type="button" data-month-pdf="stock">Stock Register — all products</button></div>
      <div id="reg-month-pdf-out"></div>
    </section>
    <section class="card">
      <div class="row-between"><h2>This morning${latest ? ` <span class="muted">· ${esc(fmtDate(latest.date))}</span>` : ''}</h2>${importBox}</div>
      ${latest ? morningHtml(latest, shortages) : '<p class="muted">No dip stock yet — bring in the Stock Register or the DIP Chart.</p>'}
      <p class="muted small">${fileLine}</p>
    </section>`);
  // Print: a computer prints the page; a phone or tablet (an iPhone's home-screen
  // app can't print at all) gets it as a PDF for the share sheet — Print, Save to Files…
  document.getElementById('reg-print')?.addEventListener('click', () => guard(async () => {
    if (!cannotPrint()) { window.print(); return; }
    const box = document.getElementById('reg-pdf');
    const paper = document.querySelector('.paper-scroll .paper');
    if (!box || !paper) return;
    box.innerHTML = loadingHtml('Making the PDF…');
    let blob;
    try {
      blob = await papersPdf([paper]);
    } catch (err) {
      box.innerHTML = '';
      throw err;
    }
    pdfReadyBar(box, blob, `${regMonth(m)} ${tab === 'stock' ? 'Stock Register' : 'Real DSR'} ${pm.product.short}.pdf`);
  }));
  // a month's DSR (or Stock Register) of every product, in one PDF
  main().querySelectorAll('[data-month-pdf]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const out = document.getElementById('reg-month-pdf-out');
    const mk = document.getElementById('reg-pdf-month').value;
    const kind = b.dataset.monthPdf;
    out.innerHTML = loadingHtml(`Making the ${kind === 'stock' ? 'Stock Register' : 'DSR'} of ${regMonth(mk)}…`);
    const pages = monthPagesHtml(all, mk, kind);
    const look = reg.pdfLook === 'hand' ? 'hand' : 'print';
    const totals = reg.pdfTotals !== 'off';
    let blob;
    try {
      blob = await papersPdf(pages, { look, totals });
    } catch (err) {
      out.innerHTML = '';
      throw err;
    }
    pdfReadyBar(out, blob, `${regMonth(mk)} ${kind === 'stock' ? 'Stock Register' : 'Real DSR'}${look === 'hand' ? ' (handwritten)' : ''}.pdf`);
    // made: the reminder for this month stops once both are
    markPdfMade(mk, kind);
    const due = monthPdfsDue(months, localToday(), pdfsMade(), monthComplete);
    if (!due || due.month !== mk) {
      document.getElementById('reg-month-pdfs')?.classList.remove('flash');
      document.getElementById('reg-pdf-due')?.remove();
      document.getElementById('reg-due-go')?.remove();
    } else {
      const note = document.getElementById('reg-pdf-due');
      if (note) note.innerHTML = `<b>${esc(regMonth(mk))} is over</b> — download its ${due.missing[0] === 'dsr' ? 'DSR' : 'Stock Register'} PDF too.`;
    }
  })));
  main().querySelectorAll('[data-pdf-totals]').forEach((b) => b.addEventListener('click', () => {
    reg.pdfTotals = b.dataset.pdfTotals;
    main().querySelectorAll('[data-pdf-totals]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  main().querySelectorAll('[data-pdf-look]').forEach((b) => b.addEventListener('click', () => {
    reg.pdfLook = b.dataset.pdfLook;
    main().querySelectorAll('[data-pdf-look]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  document.getElementById('reg-due-go')?.addEventListener('click', () => document.getElementById('reg-month-pdfs')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  const again = () => guard(() => viewRegister(tab, month, true));
  // the page fits the screen's width (a phone held upright sees all of it); − / + make it
  // smaller or bigger (then it scrolls), Fit goes back; pinching works as on any page
  fitRegisterPaper(reg);
  main().querySelectorAll('[data-reg-zoom]').forEach((b) => b.addEventListener('click', () => {
    const fit = paperFit();
    const now = reg.zoom || fit;
    const steps = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5];
    if (b.dataset.regZoom === 'fit') reg.zoom = null;
    else if (b.dataset.regZoom === 'in') reg.zoom = steps.find((x) => x > now + 0.01) || 1.5;
    else reg.zoom = [...steps].reverse().find((x) => x < now - 0.01) || 0.3;
    if (reg.zoom && Math.abs(reg.zoom - fit) < 0.01) reg.zoom = null;
    fitRegisterPaper(reg);
  }));
  if (!state.regResize) {
    state.regResize = true;
    const refit = () => { if (state.regView && document.querySelector('.paper-scroll')) fitRegisterPaper(state.regView); };
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', () => setTimeout(refit, 200));
  }
  document.getElementById('reg-adjust')?.addEventListener('toggle', (e) => {
    reg.adjOpen = e.target.open;
    if (!reg.adjOpen) reg.adjEdit = false;
    const h = e.target.querySelector('.fold-hint');
    if (h) h.textContent = `tap to ${reg.adjOpen ? 'close' : 'open'}`;
  });
  document.getElementById('adj-edit')?.addEventListener('click', () => { reg.adjEdit = !reg.adjEdit; again(); });
  document.getElementById('reg-edit-dips')?.addEventListener('click', () => { reg.editDips = !reg.editDips; again(); });
  // a typed dip: kept straight away; the page is drawn again on Done
  main().querySelectorAll('.dip-in').forEach((inp) => inp.addEventListener('change', () => guard(async () => {
    const v = typedNumber(inp.value, { min: 0, max: 400 });
    const day = inp.dataset.dipDay;
    const tank = Number(inp.dataset.dipTank);
    await saveRegisterEntry(`dips:${m}`, (data) => {
      const per = data[key] || (data[key] = {});
      const arr = Array.from({ length: pm.product.tanks }, (_, i) => (per[day] && per[day][i] != null ? per[day][i] : null));
      arr[tank] = v;
      if (arr.every((x) => x == null)) delete per[day]; else per[day] = arr;
    });
    inp.classList.add('saved');
  })));
  // the testing adjustment: the opening, a day's actual testing
  const focusNext = (sel) => { state.regFocus = sel; };
  document.getElementById('adj-open')?.addEventListener('change', (e) => guard(async () => {
    const v = typedNumber(e.target.value, { min: -1e6, max: 1e6 });
    await saveRegisterEntry(`adjust:${m}`, (data) => { const o = data.open || (data.open = {}); if (v == null) delete o[key]; else o[key] = v; });
    focusNext('.adj-in');
    await viewRegister(tab, month, true);
  }));
  main().querySelectorAll('.adj-in').forEach((inp) => inp.addEventListener('change', () => guard(async () => {
    const v = typedNumber(inp.value, { min: 0, max: 5000 });
    const day = inp.dataset.adjDay;
    await saveRegisterEntry(`adjust:${m}`, (data) => {
      const a = data.actual || (data.actual = {});
      const per = a[key] || (a[key] = {});
      if (v == null) delete per[day]; else per[day] = v;
    });
    const next = inp.closest('tr').nextElementSibling;
    focusNext(next ? `.adj-in[data-adj-day="${next.querySelector('.adj-in').dataset.adjDay}"]` : null);
    await viewRegister(tab, month, true);
  })));
  if (state.regFocus) {
    const f = main().querySelector(state.regFocus);
    state.regFocus = null;
    if (f) { f.focus({ preventScroll: false }); f.scrollIntoView({ block: 'center' }); }
  }
  bindImport();
  document.getElementById('reg-month')?.addEventListener('change', (e) => { location.hash = `#/register${tab ? `/${tab}` : ''}?m=${e.target.value}`; });
  main().querySelectorAll('[data-reg-product]').forEach((b) => b.addEventListener('click', () => { reg.product = b.dataset.regProduct; guard(() => viewRegister(tab, month, true)); }));
}

// ---------------------------------------------------------------------------
// Home dashboard — the Master Ledger's analysis (Module14, Outstanding sheet)
// ---------------------------------------------------------------------------
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// a custom range: from the data already loaded when it covers it, else fetched
async function customData(from, to) {
  const { per, data } = await dashboardData();
  if (from >= per.earliest && to <= per.month.to) return data;
  const k = `${from}|${to}`;
  if (!state.dashCustomData || state.dashCustomData.k !== k) {
    state.dashCustomData = { k, data: await state.store.dashboard(from, to) };
  }
  return state.dashCustomData.data;
}

async function dashboardData() {
  const today = localToday();
  if (!state.dash || state.dash.today !== today || Date.now() - state.dash.at > 5 * 60000) {
    const per = periods(today);
    const data = await state.store.dashboard(per.earliest, today);
    state.dash = { today, at: Date.now(), per, data };
  }
  return state.dash;
}

const TAG = { bulk: '<span class="tag bulk">Bulk</span>', retail: '<span class="tag">Retail</span>' };

function dashboardHtml(a, per, key) {
  const p = a.products;
  const k = a.kpi;
  const fuelKeys = FUELS.filter((x) => p[x].qty > 0 || p[x].amount > 0);
  const shareBar = (vals) => {
    const total = vals.reduce((s, v) => s + v.value, 0) || 1;
    return `<div class="share">${vals.filter((v) => v.value > 0).map((v) => `<span style="flex:${v.value / total};background:${v.color}" title="${esc(v.name)} ${Math.round((v.value / total) * 100)}%"></span>`).join('')}</div>`;
  };
  // volume chart: days, or months for long periods
  const byMonth = a.days > 62;
  let vol = a.daily;
  if (byMonth) {
    const m = new Map();
    for (const d of a.daily) {
      const mk = d.date.slice(0, 7);
      if (!m.has(mk)) m.set(mk, { date: `${mk}-01`, qty: { HSD: 0, MS: 0, XG: 0 }, amount: 0, earning: 0 });
      const x = m.get(mk);
      FUELS.forEach((f) => { x.qty[f] += d.qty[f]; });
      x.amount += d.amount;
      x.earning += d.earning;
    }
    vol = [...m.values()];
  }
  const volOpts = byMonth ? { labelOf: (d) => monthName(d.date.slice(0, 7)), tipLabel: (d) => monthName(d.date.slice(0, 7)) } : {};
  const earnItems = vol.map((d) => ({
    label: byMonth ? monthName(d.date.slice(0, 7)) : shortDate(d.date), value: d.earning,
    tip: `<b>${byMonth ? monthName(d.date.slice(0, 7)) : shortDate(d.date)}</b><br>Earned ${money(d.earning, { exact: true })}`,
  }));
  const rspDays = Object.fromEntries(Object.entries(a.rspSeries).map(([x, s]) => [x, s.slice(-62)]));
  return `
    <section class="card" id="dash-outstanding"></section>

    <section class="card dash">
      <div class="row-between"><h2>Overview</h2>
        <div class="chips">${['month', 'last', 'd30', 'fy'].map((x) => `<button class="chip ${x === key ? 'on' : ''}" data-period="${x}">${per[x].label}</button>`).join('')}
          <button class="chip ${key === 'custom' ? 'on' : ''}" data-period="custom">Custom</button></div></div>
      ${key === 'custom' ? `<form class="custom-range" id="dash-range">
        <label>From <input type="date" name="from" value="${a.from}" max="${per.month.to}" required></label>
        <label>To <input type="date" name="to" value="${a.to}" max="${per.month.to}" required></label>
        <button class="btn small" type="submit">Show</button></form>` : ''}
      <p class="muted small">${fmtDate(a.from)} – ${fmtDate(a.to)} · from the sales and payments in the app${Object.keys(a.pump).length ? ` · petrol &amp; XtraGreen as the pumps sold them (E-DSR, to ${esc(fmtDate(Object.values(a.pump).map((x) => x.last).sort().pop()))})` : ''} · earnings at ₹2.58/L diesel &amp; XtraGreen, ₹4/L petrol off the day's RSP</p>
      <div class="kpis">
        <div class="kpi hero"><span class="lbl">Earnings</span><span class="val">${money(k.earning)}</span><span class="sub">₹${k.perLitre.toFixed(2)} per litre</span></div>
        <div class="kpi"><span class="lbl">Sales</span><span class="val">${money(k.amount)}</span><span class="sub">${litres(k.qty)} · ${plural(k.customers, 'customer')}</span></div>
        <div class="kpi"><span class="lbl">Collections</span><span class="val">${money(k.collections)}</span><span class="sub">${k.billed ? `${Math.round((k.collections / k.billed) * 100)}% of credit sales` : '&nbsp;'}</span></div>
        <div class="kpi warn"><span class="lbl">Outstanding today</span><span class="val">${money(k.outstanding)}</span><span class="sub">${plural(a.due.length, 'customer')} owe${a.due.length === 1 ? 's' : ''}${k.advance ? ` · ${money(-k.advance)} advance` : ''}</span></div>
      </div>
      ${k.noRsp ? `<p class="warn-text small">${plural(k.noRsp, 'day-product')} had no RSP to work the margin from — left out of earnings.</p>` : ''}
    </section>

    <section class="card">
      <h3>By product</h3>
      <div class="prods">${[...fuelKeys, ...(p.OTHER.amount ? ['OTHER'] : [])].map((x) => `
        <div class="prod">
          <div class="prod-head">${x !== 'OTHER' ? `<i style="background:${SERIES[x].color}"></i>` : ''}<b>${PRODUCT_NAME[x]}</b></div>
          ${x !== 'OTHER' ? `<span class="big">${litres(p[x].qty)}</span><span class="small muted">${money(p[x].amount)} · ${plural(p[x].bills, 'bill')}</span>
          ${a.pump[x] ? `<span class="small">Credit <b>${litres(p[x].credit)}</b> · cash &amp; others <b>${litres(a.pump[x].other)}</b></span>
          <span class="small faint">pump sales from the E-DSR to ${esc(fmtDate(a.pump[x].last).slice(0, 6))}${a.pump[x].short ? ` · ${plural(a.pump[x].short, 'day')} billed more than the pumps sold` : ''}</span>` : ''}
          <span class="small">Earned <b>${money(p[x].earning)}</b> · ₹${p[x].qty ? (p[x].earning / p[x].qty).toFixed(2) : '0.00'}/L</span>`
          : `<span class="big">${money(p[x].amount)}</span><span class="small muted">${plural(p[x].bills, 'bill')} · lubes &amp; others</span>`}
        </div>`).join('')}</div>
      ${fuelKeys.length > 1 ? `<p class="small muted share-label">Share of litres</p>${shareBar(fuelKeys.map((x) => ({ name: PRODUCT_NAME[x], value: p[x].qty, color: SERIES[x].color })))}${legend(fuelKeys)}` : ''}
    </section>

    <section class="card">
      <h3>Litres ${byMonth ? 'per month' : 'per day'}</h3>
      ${legend(FUELS.filter((x) => p[x].qty > 0))}
      ${dailyVolumeChart(vol, volOpts)}
      <h3 class="sub-h">Earnings ${byMonth ? 'per month' : 'per day'}</h3>
      ${barChart(earnItems, { label: 'Earnings', h: 140 })}
    </section>

    <section class="card" id="dash-customers"></section>


    <section class="card">
      <h3>Bulk vs Retail${a.segments.pump.qty ? ' vs Cash' : ''}</h3>
      <div class="seg">${['bulk', 'retail', ...(a.segments.pump.qty ? ['pump'] : [])].map((s) => {
    const x = a.segments[s];
    return `<div class="seg-row"><b>${{ bulk: 'Bulk', retail: 'Retail', pump: 'Cash &amp; others' }[s]}</b>
          <span>${litres(x.qty)}<small>${money(x.amount)}</small></span>
          <span>${money(x.earning)}<small>₹${x.qty ? (x.earning / x.qty).toFixed(2) : '0.00'}/L earned</small></span></div>`;
  }).join('')}</div>
      <p class="small muted share-label">Share of litres — Bulk / Retail${a.segments.pump.qty ? ' / Cash &amp; others (petrol &amp; XtraGreen at the pumps, not billed on credit)' : ''}</p>
      ${shareBar([{ name: 'Bulk', value: a.segments.bulk.qty, color: 'var(--s-sales)' }, { name: 'Retail', value: a.segments.retail.qty, color: 'var(--s-paid)' }, { name: 'Cash & others', value: a.segments.pump.qty, color: 'var(--good)' }])}
      ${legend([{ name: 'Bulk', color: 'var(--s-sales)' }, { name: 'Retail', color: 'var(--s-paid)' }, ...(a.segments.pump.qty ? [{ name: 'Cash & others', color: 'var(--good)' }] : [])])}
    </section>

    <section class="card" id="dash-months"></section>

    <section class="card">
      <h3>Day's RSP${a.days > 62 ? ' · last 62 days' : ''}</h3>
      <p class="small muted">The highest price billed each day — what the margin is worked from.</p>
      ${legend(FUELS.filter((x) => rspDays[x].some((d) => d.rsp != null)))}
      ${rspChart(rspDays)}
      <form class="custom-range rate-form" id="rate-chart">
        <label>From <input type="date" name="from" value="${a.from}" max="${per.month.to}" required></label>
        <label>To <input type="date" name="to" value="${a.to}" max="${per.month.to}" required></label>
        <button class="btn small" type="submit">Download rate chart (Excel)</button></form>
      <p class="small muted">Each product's rate per day for any dates, with the change from the day before.</p>
    </section>`;
}

function customersHtml(a, sort, seg, all) {
  const val = { qty: (c) => c.qty, amount: (c) => c.amount, earning: (c) => c.earning };
  const list = a.customers.filter((c) => c.bills && (seg === 'all' || c.kind === seg)).sort((x, y) => val[sort](y) - val[sort](x));
  const shown = all ? list : list.slice(0, 10);
  const max = Math.max(1, ...list.map((c) => c.qty));
  return `
    <div class="row-between"><h3>Best customers</h3>
      <div class="chips small-chips">${[['qty', 'Litres'], ['amount', 'Sales'], ['earning', 'Earnings']].map(([x, n]) => `<button class="chip ${x === sort ? 'on' : ''}" data-csort="${x}">${n}</button>`).join('')}</div></div>
    <div class="chips small-chips">${[['all', 'All'], ['retail', 'Retail'], ['bulk', 'Bulk']].map(([x, n]) => `<button class="chip ${x === seg ? 'on' : ''}" data-cseg="${x}">${n}</button>`).join('')}</div>
    ${shown.length ? `<ol class="rank">${shown.map((c, i) => `
      <li><button class="rank-row" data-cust="${esc(c.id)}" aria-expanded="false">
        <span class="n">${i + 1}</span>
        <span class="who"><b>${esc(c.name)}</b> ${TAG[c.kind]}
          <span class="mini-track"><span class="mini" style="width:${Math.max(2, (c.qty / max) * 100)}%">${FUELS.filter((x) => c.products[x].qty > 0).map((x) => `<i style="flex:${c.products[x].qty};background:${SERIES[x].color}"></i>`).join('')}</span></span></span>
        <span class="amt"><b>${sort === 'amount' ? money(c.amount) : sort === 'earning' ? money(c.earning) : litres(c.qty)}</b>
          <small>${sort === 'qty' ? money(c.amount) : litres(c.qty)} · earned ${money(c.earning)}</small></span>
      </button>
      <div class="rank-more" hidden>
        <div class="table-wrap"><table class="compact"><tbody>${[...FUELS, 'OTHER'].filter((x) => c.products[x].amount).map((x) => `<tr><td>${PRODUCT_NAME[x]}</td><td class="r">${x === 'OTHER' ? '' : litres(c.products[x].qty)}</td><td class="r">${money(c.products[x].amount, { exact: true })}</td><td class="r">${x === 'OTHER' ? '' : `earned ${money(c.products[x].earning, { exact: true })}`}</td></tr>`).join('')}</tbody></table></div>
        <p class="small muted">${plural(c.bills, 'bill')} · last ${fmtDate(c.last)} · paid ${money(c.paid, { exact: true })} in this period${c.outstanding != null ? ` · outstanding today <b>${money(c.outstanding, { exact: true })}</b>` : ''}</p>
        ${c.kind === 'bulk' || c.ledger ? `<p class="small"><a href="${acctHref(c)}">Open ledger →</a></p>` : ''}
      </div></li>`).join('')}</ol>` : '<p class="muted">No sales in this period.</p>'}
    ${list.length > 10 ? `<p><button class="btn ghost small" data-call>${all ? 'Show top 10' : `Show all ${list.length}`}</button></p>` : ''}`;
}

const advanceList = (a, seg) => a.advance.filter((o) => seg === 'all' || o.kind === seg).sort((x, y) => x.balance - y.balance);

// '#/account/g/SMC_Bulk' or '#/account/c/<customer key>'
const acctHref = (e) => `#/account/${e.id.slice(0, 1)}/${encodeURIComponent(e.id.slice(2))}`;

function outstandingHtml(a, seg, all) {
  const list = a.due.filter((o) => seg === 'all' || o.kind === seg);
  // customers who paid ahead: listed in full, largest advance first
  const adv = advanceList(a, seg);
  const advTotal = adv.reduce((x, o) => x + o.balance, 0);
  const advMax = Math.min(-1, ...adv.map((o) => o.balance));
  const shown = all ? list : list.slice(0, 10);
  const total = list.reduce((s, o) => s + o.balance, 0);
  const max = Math.max(1, ...list.map((o) => o.balance));
  return `
    <div class="row-between"><h3>Outstanding today</h3><span class="row-end"><b class="total">${money(total, { exact: true })}</b>${list.length ? `<button class="btn ghost small" data-olist>${SHARE_ICON} Share list</button>` : ''}</span></div>
    <div class="chips small-chips">${[['all', 'All'], ['retail', 'Retail'], ['bulk', 'Bulk']].map(([x, n]) => `<button class="chip ${x === seg ? 'on' : ''}" data-oseg="${x}">${n}</button>`).join('')}</div>
    ${shown.length ? `<ol class="rank">${shown.map((o, i) => `
      <li class="with-share"><a class="rank-row" href="${acctHref(o)}" title="Open the ledger"><span class="n">${i + 1}</span>
        <span class="who"><b>${esc(o.name)}</b> ${TAG[o.kind]}<span class="mini-track"><span class="mini owe" style="width:${Math.max(2, (o.balance / max) * 100)}%"></span></span></span>
        <span class="amt"><b>${money(o.balance, { exact: true })}</b><small>${Math.round((o.balance / (total || 1)) * 100)}% of the total ›</small></span></a>
        <button class="icon share-ic" data-oshare="${i}" title="Share ${esc(o.name)}'s outstanding as a picture" aria-label="Share ${esc(o.name)}'s outstanding as a picture">${SHARE_ICON}</button></li>`).join('')}</ol>` : '<p class="muted">Nobody owes anything. ✓</p>'}
    ${list.length > 10 ? `<p><button class="btn ghost small" data-oall>${all ? 'Show top 10' : `Show all ${list.length}`}</button></p>` : ''}
    ${adv.length ? `<div class="row-between adv-head"><h3>Paid in advance</h3><b class="total good-text">${money(-advTotal, { exact: true })}</b></div>
      <ol class="rank">${adv.map((o, i) => `
      <li class="with-share"><a class="rank-row adv" href="${acctHref(o)}" title="Open the ledger"><span class="n">${i + 1}</span>
        <span class="who"><b>${esc(o.name)}</b> ${TAG[o.kind]}<span class="mini-track"><span class="mini adv" style="width:${Math.max(2, (o.balance / (advMax || -1)) * 100)}%"></span></span></span>
        <span class="amt"><b class="good-text">${money(-o.balance, { exact: true })}</b><small>advance ›</small></span></a>
        <button class="icon share-ic" data-ashare="${i}" title="Share ${esc(o.name)}'s balance as a picture" aria-label="Share ${esc(o.name)}'s balance as a picture">${SHARE_ICON}</button></li>`).join('')}</ol>` : ''}
    <p class="small muted">Ledger customers as on their sheet; bulk groups as on their *_Bulk sheet (opening + sales − paid − TDS − shortage).</p>`;
}

function monthsHtml(fy) {
  const months = fy.months.filter((m) => m.amount || m.paid);
  if (!months.length) return '<h3>This FY by month</h3><p class="muted">No sales yet this FY.</p>';
  return `<h3>This FY by month</h3>
    ${legend([{ name: 'Sales', color: 'var(--s-sales)' }, { name: 'Collections', color: 'var(--s-paid)' }])}
    ${monthlyChart(months)}
    <div class="table-wrap"><table class="compact"><thead><tr><th>Month</th><th class="r">Litres</th><th class="r">Sales</th><th class="r">Earned</th><th class="r">Collected</th></tr></thead>
      <tbody>${months.map((m) => `<tr><td>${monthName(m.month)}</td><td class="r">${litres(m.qty)}</td><td class="r">${money(m.amount)}</td><td class="r">${money(m.earning)}</td><td class="r">${money(m.paid)}</td></tr>`).join('')}</tbody></table></div>`;
}

// the E-DSR's day sales of petrol and XtraGreen (Register); null without them
async function pumpData() {
  try {
    return pumpSales(await registerAll());
  } catch {
    return null;                                   // the Register isn't set up yet: billed litres only
  }
}

async function renderDashboard(box) {
  const [{ per, data }, pump] = await Promise.all([dashboardData(), pumpData()]);
  const key = state.dashPeriod || 'month';
  let a;
  if (key === 'custom') {
    const c = state.dashCustom || { from: per.month.from, to: per.month.to };
    per.custom = { label: 'Custom', from: c.from, to: c.to };
    a = analyse(await customData(c.from, c.to), per.custom, pump);
  } else {
    a = analyse(data, per[key], pump);
  }
  setChartWidth(box.clientWidth - 38);                           // the card's inner width
  box.innerHTML = dashboardHtml(a, per, key);
  const fy = key === 'fy' ? a : analyse(data, per.fy, pump);
  const ui = state.dashUi || (state.dashUi = { sort: 'qty', seg: 'all', all: false, oseg: 'all', oall: false });
  const cust = box.querySelector('#dash-customers');
  const out = box.querySelector('#dash-outstanding');
  const paintCustomers = () => {
    cust.innerHTML = customersHtml(a, ui.sort, ui.seg, ui.all);
    cust.querySelectorAll('[data-csort]').forEach((b) => b.addEventListener('click', () => { ui.sort = b.dataset.csort; paintCustomers(); }));
    cust.querySelectorAll('[data-cseg]').forEach((b) => b.addEventListener('click', () => { ui.seg = b.dataset.cseg; paintCustomers(); }));
    cust.querySelector('[data-call]')?.addEventListener('click', () => { ui.all = !ui.all; paintCustomers(); });
    cust.querySelectorAll('[data-cust]').forEach((b) => b.addEventListener('click', () => {
      const more = b.nextElementSibling;
      more.hidden = !more.hidden;
      b.setAttribute('aria-expanded', String(!more.hidden));
    }));
  };
  const paintOutstanding = () => {
    out.innerHTML = outstandingHtml(a, ui.oseg, ui.oall);
    out.querySelectorAll('[data-oseg]').forEach((b) => b.addEventListener('click', () => { ui.oseg = b.dataset.oseg; paintOutstanding(); }));
    out.querySelector('[data-oall]')?.addEventListener('click', () => { ui.oall = !ui.oall; paintOutstanding(); });
    const list = a.due.filter((o) => ui.oseg === 'all' || o.kind === ui.oseg);
    out.querySelectorAll('[data-oshare]').forEach((b) => b.addEventListener('click', () => {
      const o = list[Number(b.dataset.oshare)];
      sharePictures(`${o.name} — outstanding`, outstandingOptionsFor(o));
    }));
    const adv = advanceList(a, ui.oseg);
    out.querySelectorAll('[data-ashare]').forEach((b) => b.addEventListener('click', () => {
      const o = adv[Number(b.dataset.ashare)];
      sharePictures(`${o.name} — balance`, outstandingOptionsFor(o));
    }));
    out.querySelector('[data-olist]')?.addEventListener('click', () => {
      const label = { all: '', retail: 'Retail', bulk: 'Bulk' }[ui.oseg];
      const draw = async () => {
        const { images, fontCss } = await shareImages();
        return outstandingListSvg({ list, total: list.reduce((x, o) => x + o.balance, 0), asOn: localToday(), label }, { images, fontCss });
      };
      const base = `Outstanding${label ? ` ${label}` : ''} ${dmyDash(localToday())}`;
      sharePictures('Outstanding today', async () => {
        const { svg, size } = await draw();
        return [new File([await jpegFromSvg(svg, size)], `${base}.jpeg`, { type: 'image/jpeg' })];
      }, { pdf: async () => { const { svg, size } = await draw(); await longPdf(svg, size, base); } });
    });
  };
  paintCustomers();
  paintOutstanding();
  box.querySelector('#dash-months').innerHTML = monthsHtml(fy);
  box.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    state.dashPeriod = b.dataset.period;
    guard(() => renderDashboard(box));
  }));
  box.querySelector('#dash-range')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const from = e.target.from.value;
    const to = e.target.to.value;
    if (!from || !to || to < from) { toast('Pick a From date on or before the To date.', 'bad'); return; }
    if (daysBetween(from, to) > 730) { toast('Pick at most two years at a time.', 'bad'); return; }
    state.dashCustom = { from, to };
    guard(() => renderDashboard(box));
  });
  box.querySelector('#rate-chart')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const from = e.target.from.value;
    const to = e.target.to.value;
    if (!from || !to || to < from) { toast('Pick a From date on or before the To date.', 'bad'); return; }
    if (daysBetween(from, to) > 730) { toast('Pick at most two years at a time.', 'bad'); return; }
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    guard(() => downloadRateChart(from, to)).finally(() => { btn.disabled = false; });
  });
  bindCharts(box);
  // redraw at the new width after a rotate / resize
  if (!state.dashResize) {
    let last = window.innerWidth;
    let t;
    state.dashResize = true;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const el = document.getElementById('dash');
        if (el && Math.abs(window.innerWidth - last) > 40) { last = window.innerWidth; guard(() => renderDashboard(el)); }
      }, 250);
    });
  }
}

// The rate chart: each product's day's rate (the RSP the dashboard uses) for
// from..to as an Excel file
async function downloadRateChart(from, to) {
  const [XLSX, data] = await Promise.all([loadSheetJS(), customData(from, to)]);
  const chart = rateChart(analyse(data, { from, to }).rspSeries);
  if (!chart.products.length) { toast('No rates billed in those dates.', 'bad'); return; }
  const aoa = rateChartSheet(chart, { from, to });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const n = chart.products.length;
  const last = 1 + 2 * n;                                      // Date, Day, rates, changes
  for (let r = RATE_HEAD_ROWS; r < aoa.length; r++) {
    const d = ws[XLSX.utils.encode_cell({ r, c: 0 })];
    if (d) d.z = 'dd-mm-yyyy';
    for (let c = 2; c <= last; c++) {
      const x = ws[XLSX.utils.encode_cell({ r, c })];
      if (x) x.z = c < 2 + n ? '0.00' : '+0.00;-0.00;0.00';
    }
  }
  ws['!cols'] = [{ wch: 12 }, { wch: 6 }, ...chart.products.map(() => ({ wch: 12 })), ...chart.products.map(() => ({ wch: 17 }))];
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: last } }, { s: { r: 1, c: 0 }, e: { r: 1, c: last } }];
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: RATE_HEAD_ROWS - 1, c: 0 }, e: { r: aoa.length - 1, c: last } }) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rate chart');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Rate Chart ${rangeName(from, to)}.xlsx`);
}

// ---------------------------------------------------------------------------
// A customer's ledger: a statement in the app's look (summary, company-wise
// outstanding for a group, every entry by month) — the same figures as their
// sheet in the Master Ledger, which is one tap away ("Excel sheet")
// ---------------------------------------------------------------------------
const colLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));
const xlPx = (w) => Math.round(Number(w) * 8);                 // Excel width units -> screen px (Times New Roman 12)
const ptPx = (pt) => Math.round(pt * 96 / 72);

// the sheet grid: column letters, row numbers, sticky header, zoom to fit
function sheetHtml(widths, rows) {
  const total = widths.reduce((a, w) => a + w, 0) + 40;
  return `<div class="xl-tools"><button class="btn ghost small" data-zoom="-">−</button><button class="btn ghost small" data-zoom="fit">Fit</button><button class="btn ghost small" data-zoom="1">100%</button><button class="btn ghost small" data-zoom="+">+</button></div>
    <div class="xl-wrap"><table class="xl" style="width:${total}px"><colgroup><col style="width:40px">${widths.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>
      <thead><tr><th class="corner"></th>${widths.map((_, i) => `<th>${colLetter(i)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr${r.h ? ` style="height:${r.h}px"` : ''}><th class="rn">${i + 1}</th>${r.cells}</tr>`).join('')}</tbody></table></div>`;
}

function bindSheet(root) {
  const wrap = root.querySelector('.xl-wrap');
  const table = root.querySelector('table.xl');
  if (!wrap || !table) return;
  const natural = parseFloat(table.style.width);
  let z = 1;
  const apply = () => { table.style.zoom = String(z); };
  const fit = () => { z = Math.max(0.5, Math.min(1, (wrap.clientWidth - 2) / natural)); apply(); };   // never below 50%: scroll sideways instead
  root.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.zoom;
    if (v === 'fit') fit();
    else { z = v === '1' ? 1 : Math.max(0.35, Math.min(2, z + (v === '+' ? 0.15 : -0.15))); apply(); }
  }));
  if (natural > wrap.clientWidth) fit();
}

const cell = (text, cls = '', attrs = '') => `<td${cls ? ` class="${cls}"` : ''}${attrs ? ` ${attrs}` : ''}>${esc(text)}</td>`;

// Statement (default) or Excel sheet — remembered on this device
const ACCT_VIEW_KEY = 'vriddhi-ledger-acct-view';
function acctView() {
  try { return localStorage.getItem(ACCT_VIEW_KEY) === 'sheet' ? 'sheet' : 'statement'; } catch { return 'statement'; }
}
function setAcctView(v) {
  try { localStorage.setItem(ACCT_VIEW_KEY, v); } catch { /* private window: just this time */ }
}

async function viewAccount(type, id, month) {
  if (type === 'g') return viewBulkAccount(id);
  return viewRetailAccount(id, month);
}

// ---- the pictures ------------------------------------------------------------
let shareAssets = null;
async function shareImages() {
  if (!shareAssets) {
    shareAssets = Promise.all([toDataUrl(LOGO).catch(() => ''), brandFontCss()])
      .then(([logo, fontCss]) => ({ images: { logo }, fontCss }));
  }
  return shareAssets;
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

async function ledgerSvgs(st, fifo = null) {
  const { images, fontCss } = await shareImages();
  return ledgerPagesSvg(st, {
    asOn: localToday() < st.to ? st.to : localToday(), images, fontCss,
    pending: fifo ? fifo.pending : null, advance: fifo ? fifo.advance : 0, pos: fifo ? poSummary(fifo.pending) : null,
  });
}
const ledgerPdf = (svgs) => pdfFromSvgs(svgs, SHARE_PAGE_PT, { scale: SHARE_PAGE.width / SHARE_PAGE_PT.width });

async function ledgerFiles(st, base, fifo = null) {
  const svgs = await ledgerSvgs(st, fifo);
  const files = [];
  for (let i = 0; i < svgs.length; i++) {
    const blob = await jpegFromSvg(svgs[i], SHARE_PAGE);
    files.push(new File([blob], `${base}${svgs.length > 1 ? ` (${i + 1} of ${svgs.length})` : ''}.jpeg`, { type: 'image/jpeg' }));
  }
  return { files, svgs };
}

async function cardFile(card, base) {
  const { images, fontCss } = await shareImages();
  const { svg, size } = outstandingCardSvg(card, { images, fontCss });
  return new File([await jpegFromSvg(svg, size)], `${base}.jpeg`, { type: 'image/jpeg' });
}
// A picture as a PDF: one page its own shape (A4 wide), drawn at twice its
// size so the text stays sharp — a long picture sent as an image gets
// squeezed by the apps it's shared through; a PDF isn't.
async function longPdf(svg, size, base) {
  const pt = { width: 595, height: Math.round((size.height * 595) / size.width) };
  const sharp = Math.min(2, 14000 / size.height);                // phones cap a canvas's size
  download(await pdfFromSvgs([svg], pt, { scale: (size.width / pt.width) * sharp }), `${base}.pdf`);
}
async function cardPdf(card, base) {
  const { images, fontCss } = await shareImages();
  const { svg, size } = outstandingCardSvg(card, { images, fontCss });
  await longPdf(svg, size, base);
}
// one card to share: its picture, and the same as a PDF
const cardSet = async (card, base, label = '') => ({ label, files: [await cardFile(card, base)], pdf: () => cardPdf(card, base) });
const oneCard = (card, base) => [{ label: '', make: async () => [await cardSet(card, base)] }];

// A sheet that makes the pictures, shows them and hands them over. Sharing
// needs the files ready before the tap (the Web Share API), so the pictures
// are made first and the Share buttons only pass them on.
//   options: [{ label, make }] — e.g. Unit-wise / Both units together; the
//            first is shown first. make() -> [{ label?, files, pdf? }]: one
//            set per recipient (each unit gets its own Share button).
//   or simply make() -> files (one set); options may also be a Promise
//   (worked out while the sheet already shows "Drawing…").
async function sharePictures(title, options, { pdf = null } = {}) {
  if (typeof options === 'function') {
    const make = options;
    options = [{ label: '', make: async () => [{ files: await make(), pdf }] }];
  }
  document.querySelector('.share-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.className = 'share-sheet';
  sheet.innerHTML = `<div class="share-box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="row-between"><h3>${esc(title)}</h3><button class="icon" data-close aria-label="Close">✕</button></div>
      <div class="share-variants"></div>
      <div class="share-body">${loadingHtml('Drawing the pictures…')}</div>
    </div>`;
  document.body.append(sheet);
  let urls = [];
  const freeUrls = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
  const close = () => { sheet.remove(); freeUrls(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) close(); });
  const body = sheet.querySelector('.share-body');
  const made = new Map();                                    // each option drawn once
  let showing = 0;
  const show = async (i) => {
    showing = i;
    sheet.querySelectorAll('[data-variant]').forEach((b) => b.classList.toggle('on', Number(b.dataset.variant) === i));
    body.innerHTML = loadingHtml('Drawing the pictures…');
    let sets;
    try {
      if (!made.has(i)) made.set(i, options[i].make());
      sets = await made.get(i);
    } catch (err) {
      console.error(err);
      made.delete(i);
      if (showing === i) body.innerHTML = errorHtml(err);
      return;
    }
    if (!sheet.isConnected || showing !== i) return;
    freeUrls();
    body.innerHTML = sets.map((set, k) => {
      const shots = set.files.map((f) => { const u = URL.createObjectURL(f); urls.push(u); return u; });
      const share = canShareFiles(set.files);
      return `<div class="share-set">
        ${set.label ? `<h4>${esc(set.label)}</h4>` : ''}
        <div class="share-shots${set.files.length === 1 ? ' one' : ''}">${shots.map((u, j) => `<img src="${u}" alt="${esc(set.files[j].name)}">`).join('')}</div>
        <p class="muted small">${set.files.length === 1 ? esc(set.files[0].name) : `${set.files.length} pictures`}</p>
        <div class="actions">${share ? `<button class="btn" data-share="${k}">Share${set.label ? ` ${esc(set.label)}` : ''}</button>` : ''}
          <button class="btn ${share ? 'ghost' : ''}" data-save="${k}">Download${set.files.length > 1 ? ' all' : ''}</button>
          ${set.pdf ? `<button class="btn ghost" data-pdf="${k}">PDF</button>` : ''}</div></div>`;
    }).join('');
    body.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', () => guard(async () => {
      try {
        await navigator.share({ files: sets[Number(b.dataset.share)].files });   // pictures only: extra text can make apps drop them
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        throw err;
      }
    })));
    body.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => guard(async () => {
      const { files } = sets[Number(b.dataset.save)];
      if (files.length === 1) download(files[0], files[0].name);
      else download(await zipBlob(files), `${files[0].name.replace(/ \(1 of \d+\)\.jpeg$/, '')}.zip`);
    })));
    body.querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', () => guard(async () => {
      b.disabled = true;
      try { await sets[Number(b.dataset.pdf)].pdf(); } finally { b.disabled = false; }
    })));
  };
  try {
    options = await options;
  } catch (err) {
    console.error(err);
    body.innerHTML = errorHtml(err);
    return;
  }
  if (!sheet.isConnected) return;
  if (options.length > 1) {
    sheet.querySelector('.share-variants').innerHTML = `<div class="chips small-chips">${options.map((o, i) => `<button class="chip" data-variant="${i}">${esc(o.label)}</button>`).join('')}</div>`;
  }
  sheet.querySelectorAll('[data-variant]').forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.variant))));
  await show(0);
}

// ---- the statement on screen -------------------------------------------------------
const PRODUCT_COLOR = { HSD: 'var(--s-hsd)', MS: 'var(--s-ms)', XG: 'var(--s-xg)', OTHER: 'var(--s-sales)', PAY: 'var(--good)' };
const balHtml = (v) => `<span class="${Math.round(v) < 0 ? 'good-text' : ''}">${esc(drCr(v))}</span>`;
const initials = (name) => String(name || '').replace(/\b(ltd|pvt|private|limited|and|&|the)\b/gi, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '•';

function acctHeroHtml(st, { asOn, label = 'Balance' }) {
  const v = Math.round(st.closing);
  const what = v > 0 ? 'Outstanding' : v < 0 ? 'Advance with us' : 'All settled';
  const t = st.totals;
  const deductions = t.tds + t.shortage;
  return `<div class="acct-hero">
      <div><span class="lbl">${what} · ${esc(label)}</span><span class="val">${esc(rupees(Math.abs(v)))}</span>
        <span class="sub">${esc(drCr(st.closing))} · as on ${esc(fmtDate(asOn))}</span></div>
      <div class="side"><span class="lbl">Last payment</span><b>${st.lastPayment ? `${esc(rupees(st.lastPayment.amount))}` : '—'}</b>
        <span class="sub">${st.lastPayment ? `${esc(fmtDate(st.lastPayment.date))}${st.lastPayment.count > 1 ? ` · ${st.lastPayment.count} payments` : ''}` : 'none in this period'}</span></div>
    </div>
    <div class="kpis acct-kpis">
      <div class="kpi"><span class="lbl">Opening</span><span class="val">${balHtml(st.opening)}</span><span class="sub">on ${esc(fmtDate(st.from))}</span></div>
      <div class="kpi"><span class="lbl">Billed</span><span class="val">${esc(rupees(t.billed))}</span><span class="sub">${t.qty ? `${esc(litres(t.qty))} · ` : ''}${plural(t.bills, 'bill')}</span></div>
      <div class="kpi"><span class="lbl">Received</span><span class="val good-text">${esc(rupees(t.received))}</span><span class="sub">${plural(t.payments, 'payment')}</span></div>
      ${deductions ? `<div class="kpi"><span class="lbl">TDS &amp; shortage</span><span class="val">${esc(rupees(deductions))}</span><span class="sub">TDS ${esc(rupees(t.tds))} · short ${esc(rupees(t.shortage))}</span></div>` : ''}
    </div>
    <div class="prod-chips">${['HSD', 'MS', 'XG', 'OTHER'].filter((p) => st.products[p].amount).map((p) => `<span class="prod-chip"><i style="background:${PRODUCT_COLOR[p]}"></i><b>${PRODUCT_LABEL[p]}</b>${p !== 'OTHER' ? ` ${esc(litres(st.products[p].qty))} ·` : ''} ${esc(rupees(st.products[p].amount))}</span>`).join('')}</div>`;
}

function companiesHtml(cw) {
  const max = Math.max(1, ...cw.list.map((c) => Math.abs(c.outstanding)));
  return `<div class="row-between"><h3>Company-wise outstanding</h3><b class="total">${balHtml(cw.total)}</b></div>
    <div class="co-grid">${cw.list.map((c, i) => `
      <div class="co-card${c.outstanding < 0 ? ' adv' : ''}">
        <div class="co-head"><span class="avatar sm">${esc(initials(c.name))}</span><b>${esc(c.name)}</b>
          <button class="icon share-ic" data-co="${i}" title="Share ${esc(c.name)}'s outstanding as a picture" aria-label="Share as picture">${SHARE_ICON}</button></div>
        <span class="co-val">${balHtml(c.outstanding)}</span>
        <span class="mini-track"><span class="mini owe" style="width:${Math.max(2, (Math.abs(c.outstanding) / max) * 100)}%"></span></span>
        <dl class="co-facts">
          ${c.opening ? `<dt>Opening</dt><dd>${esc(drCr(c.opening))}</dd>` : ''}
          <dt>Billed</dt><dd>${esc(rupees(c.billed))}${c.qty ? ` <small>${esc(litres(c.qty))}</small>` : ''}</dd>
          <dt>Received</dt><dd>${esc(rupees(c.received))}</dd>
          ${c.deductions ? `<dt>TDS &amp; shortage</dt><dd>${esc(rupees(c.deductions))}</dd>` : ''}
          <dt>Last payment</dt><dd>${c.lastPayment ? `${esc(rupees(c.lastPayment.amount))} <small>${esc(dMon(c.lastPayment.date))}${c.lastPayment.count > 1 ? ` · ${c.lastPayment.count} payments` : ''}</small>` : '—'}</dd>
        </dl>
      </div>`).join('')}</div>
    ${cw.settled ? `<p class="small muted">+ ${plural(cw.settled, 'company', 'companies')} with a nil balance, not shown.</p>` : ''}
    ${Math.round(cw.opening) ? `<p class="small muted">${cw.split ? `${esc(drCr(cw.opening))} of the sheet's opening balance isn't split by company on Customer GST` : `The sheet's opening balance of ${esc(drCr(cw.opening))} is for the group as a whole`}: that + every company = the group's balance of <b>${esc(drCr(cw.total))}</b>.</p>` : ''}`;
}

function stmtRowHtml(e) {
  return `<div class="stmt-row ${e.type}">
    <span class="s-date"><b>${esc(e.date.slice(8, 10))}</b><small>${esc(dMon(e.date).slice(3))}</small></span>
    <span class="s-part"><i style="background:${e.deduction ? 'var(--warn)' : PRODUCT_COLOR[e.product] || PRODUCT_COLOR.OTHER}"></i><b>${esc(e.title)}</b>${e.detail ? `<small>${esc(e.detail)}</small>` : ''}</span>
    <span class="s-qty r">${e.qty ? esc(qtyText(e.qty)) : ''}${e.rate ? `<small>@ ₹${e.rate.toFixed(2)}</small>` : ''}</span>
    <span class="s-dr r">${e.debit ? esc(rupees(e.debit)) : ''}</span>
    <span class="s-cr r">${e.credit ? `<span class="${e.credit < 0 ? 'bad-text' : 'good-text'}">${esc(rupees(e.credit))}</span>` : ''}</span>
    <span class="s-bal r">${balHtml(e.balance)}</span>
  </div>`;
}

function statementHtml(st, { filter = 'all', newest = true } = {}) {
  const months = newest ? [...st.months].reverse() : st.months;
  const keep = (e) => filter === 'all' || (filter === 'pay' ? e.type === 'pay' : e.type !== 'pay');
  const head = '<div class="stmt-row head"><span>Date</span><span>Particulars</span><span class="r">Litres</span><span class="r">Debit</span><span class="r">Credit</span><span class="r">Balance</span></div>';
  const blocks = months.map((m) => {
    // TDS and shortage: lines of their own (statementLines)
    const lines = statementLines(m.entries);
    const list = (newest ? lines.reverse() : lines).filter(keep);
    if (!list.length) return '';
    return `<div class="stmt-month">
      <div class="stmt-mhead"><b>${esc(m.title)}</b><span>billed ${esc(rupees(m.billed))} · received ${esc(rupees(m.received))}${m.deductions ? ` · TDS/short ${esc(rupees(m.deductions))}` : ''} · closing ${balHtml(m.closing)}</span></div>
      ${head}${list.map(stmtRowHtml).join('')}</div>`;
  }).join('');
  const open = `<div class="stmt-open"><span>Opening balance on ${esc(fmtDate(st.from))}</span>${balHtml(st.opening)}</div>`;
  return blocks ? (newest ? `${blocks}${open}` : `${open}${blocks}`) : `<p class="muted">Nothing here for this period.</p>${open}`;
}

function bindStatement(box, st) {
  const ui = state.stmtUi || (state.stmtUi = { filter: 'all', newest: true });
  const list = box.querySelector('.stmt');
  const paint = () => {
    list.innerHTML = statementHtml(st, ui);
    box.querySelectorAll('[data-sfilter]').forEach((b) => b.classList.toggle('on', b.dataset.sfilter === ui.filter));
    box.querySelector('[data-sorder]').textContent = ui.newest ? 'Newest first' : 'Oldest first';
  };
  box.querySelectorAll('[data-sfilter]').forEach((b) => b.addEventListener('click', () => { ui.filter = b.dataset.sfilter; paint(); }));
  box.querySelector('[data-sorder]').addEventListener('click', () => { ui.newest = !ui.newest; paint(); });
  paint();
}

const statementCard = (st) => `<section class="card" id="stmt-card">
    <div class="row-between"><h3>Statement</h3>
      <div class="chips small-chips">${[['all', 'All'], ['bill', 'Bills'], ['pay', 'Payments']].map(([x, n]) => `<button class="chip" data-sfilter="${x}">${n}</button>`).join('')}
        <button class="chip" data-sorder>Newest first</button></div></div>
    <div class="stmt">${statementHtml(st)}</div>
  </section>`;

const viewToggle = (view) => `<div class="chips small-chips view-toggle" role="tablist">
    <button class="chip ${view === 'statement' ? 'on' : ''}" data-view="statement" role="tab" aria-selected="${view === 'statement'}">Statement</button>
    <button class="chip ${view === 'sheet' ? 'on' : ''}" data-view="sheet" role="tab" aria-selected="${view === 'sheet'}">Excel sheet</button></div>`;

function bindViewToggle(rerender) {
  main().querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    setAcctView(b.dataset.view);
    rerender();
  }));
}

// the companies of a group with a statement for the picture's range (the
// whole ledger, or those with an entry in the month)
const companiesFor = (acct, ym) => (acct.companies || []).filter((c) => !ym || c.st.months.some((m) => m.month === ym));

// Every company's statement of account as its own PDF, in one .zip (as Tally
// exports them party by party); the whole ledger (with its pending bills) or one month.
async function companyPdfs(acct, name, asOn, ym, progress = () => {}) {
  const list = companiesFor(acct, ym);
  if (!list.length) throw new Error('No company has an entry in this month.');
  const when = ym ? monthLabel(`${ym}-01`) : dmyDash(asOn);
  const files = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    progress(i, list.length);
    const svgs = await ledgerSvgs(ym ? monthSlice(c.st, ym) : c.st, ym ? null : c.fifo);
    files.push({ name: `${safeName(`${c.name} Statement ${when}`)}.pdf`, blob: await ledgerPdf(svgs) });
  }
  const folder = safeName(`${name} Company Statements ${when}`);
  download(await zipBlob(files, folder), `${folder}.zip`);
}

// Share options for a bulk account's outstanding card (outstanding.js picks
// the cards: unit-wise first on an SMC-style sheet, then together).
const cardMakers = (options) => options.map((o) => ({
  label: o.label,
  make: async () => {
    const out = [];                                           // one at a time: pictures drawn together can lose their font
    for (const s of o.sets) out.push(await cardSet(s.card, s.base, s.label));
    return out;
  },
}));
const cardOptions = (acct, name, asOn) => cardMakers(cardSets(acct, name, asOn));

// Share options for a bulk account's ledger pictures (the whole ledger or one
// month): unit-wise first on an SMC-style sheet, then together; on a group the
// whole group, then company-wise (the company picked on screen before both).
function ledgerOptions(acct, name, asOn, ym, picked = null) {
  const set = async (st, fifo, base, label = '') => {
    const part = ym ? monthSlice(st, ym) : st;
    const fileBase = safeName(ym ? `${base} ${monthLabel(`${ym}-01`)}` : `${base} ${dmyDash(asOn)}`);
    const made = await ledgerFiles(part, fileBase, ym ? null : fifo);   // pending bills with the whole ledger
    return {
      label, files: made.files,
      pdf: async () => download(await ledgerPdf(made.svgs), `${fileBase}.pdf`),
    };
  };
  const together = { label: acct.units ? 'Both units together' : acct.companies ? 'Whole group' : '', make: async () => [await set(acct.st, acct.fifo, `${name} Ledger`)] };
  if (acct.companies) {
    // a group: the whole group, or each company's own statement of account
    // (one set each, with its own Share) — the company picked on screen first
    const one = (c) => ({ label: c.name, make: async () => [await set(c.st, c.fifo, `${c.name} Statement`)] });
    const companyWise = {
      label: 'Company-wise',
      make: async () => {
        const out = [];                                       // one at a time: pictures drawn together can lose their font
        for (const c of companiesFor(acct, ym)) out.push(await set(c.st, c.fifo, `${c.name} Statement`, c.name));
        if (!out.length) throw new Error('No company has an entry in this month.');
        return out;
      },
    };
    return picked && companiesFor(acct, ym).includes(picked) ? [one(picked), together, companyWise] : [together, companyWise];
  }
  if (!acct.units) return [together];
  const unitWise = {
    label: 'Unit-wise',
    make: async () => {
      const out = [];
      for (const u of acct.units) out.push(await set(u.st, u.fifo, `${name} ${unitLabel(u.unit)} Ledger`, unitLabel(u.unit)));
      return out;
    },
  };
  return [unitWise, together];
}

// the FIFO pending bills on screen (grouped by unit on an SMC-style sheet)
function pendingHtml(acct, { group = false } = {}) {
  const parts = acct.units ? acct.units.map((u) => ({ label: unitLabel(u.unit), ...u.fifo })) : [{ label: '', ...acct.fifo }];
  const all = acct.fifo.pending;
  if (!all.length) return `<h3>Pending bills</h3><p class="muted">No bill is pending${acct.fifo.advance > 0.5 ? ` — ${esc(rupees(acct.fifo.advance))} paid in advance` : ''}. ✓</p>`;
  const total = all.reduce((a, d) => a + d.pending, 0);
  const pos = poSummary(all);
  return `${pos ? `<div class="row-between"><h3>PO-wise outstanding</h3><b class="total">${esc(rupees(pos.total))}</b></div>
    <div class="pend-list po-list">
      <div class="pend-row head"><span>PO</span><span>Bills</span><span class="r">Billed</span><span class="r">Pending</span><span class="r">Oldest</span></div>
      ${pos.rows.map((r) => `<div class="pend-row">
        <span><b>${esc(r.kind === 'po' ? r.po : poRowName(r))}</b>${r.unitLabel ? `<small>${esc(r.unitLabel)}</small>` : ''}</span>
        <span>${r.bills ? `${plural(r.bills, 'bill')}<small>${esc(r.from === r.to ? dMon(r.from) : `${dMon(r.from)} – ${dMon(r.to)}`)}</small>` : ''}</span>
        <span class="r">${esc(rupees(r.billed))}</span>
        <span class="r"><b>${esc(rupees(r.pending))}</b></span>
        <span class="r">${r.bills ? `<span class="age ${r.oldestDays > 30 ? 'old' : r.oldestDays > 15 ? 'mid' : ''}">${r.oldestDays} d</span>` : ''}</span></div>`).join('')}
    </div>
    <p class="small muted">What's still owed against each PO, from the pending bills below.</p>` : ''}
    <div class="row-between${pos ? ' pend-gap' : ''}"><h3>Pending bills <span class="muted">· payments matched to bills</span></h3><b class="total">${esc(rupees(total))}</b></div>
    <p class="small muted">Each payment (with its TDS and shortage) clears the bills it adds up to — one bill, or whole runs of one or two products' bills (all the diesel bills, say), or all but one held-back bill; a remark naming a product tries that product first. Otherwise the opening, then the main product's bills (usually diesel) oldest first; small bills of other products wait${acct.units ? '. A payment with a Unit on the sheet pays only that unit\'s bills; one without a unit, either unit\'s' : ''}${group ? '. On a group, each company\'s payment pays only that company\'s bills (then the opening); a payment with no company, any company\'s' : ''}. What's left is the balance.</p>
    ${parts.filter((p) => p.pending.length || p.advance > 0.5).map((p) => `
      ${p.label ? `<div class="pend-unit"><b>${esc(p.label)}</b><span>${plural(p.pending.length, 'bill')} · ${esc(rupees(p.pending.reduce((a, d) => a + d.pending, 0)))}</span></div>` : ''}
      <div class="pend-list">
        <div class="pend-row head"><span>Date</span><span>Invoice</span><span class="r">Bill</span><span class="r">Pending</span><span class="r">Age</span></div>
        ${p.pending.map((d) => `<div class="pend-row">
          <span>${esc(fmtDate(d.date))}</span>
          <span><b>${d.opening ? 'Opening balance' : esc(d.bill ? `Inv. ${d.bill}` : d.title)}</b>${group && d.company ? `<small>${esc(d.company)}</small>` : (d.bill ? `<small>${esc([d.title.split(' · ')[0], d.po ? `PO ${d.po}` : ''].filter(Boolean).join(' · '))}</small>` : '')}</span>
          <span class="r">${esc(rupees(d.amount))}</span>
          <span class="r"><b>${esc(rupees(d.pending))}</b></span>
          <span class="r"><span class="age ${d.days > 30 ? 'old' : d.days > 15 ? 'mid' : ''}">${d.days} d</span></span></div>`).join('')}
        ${p.advance > 0.5 ? `<div class="pend-row adv"><span></span><span>Less: advance not yet set against a bill</span><span></span><span class="r good-text"><b>${esc(rupees(-p.advance))}</b></span><span></span></div>` : ''}
      </div>`).join('')}`;
}

// SMC-style sheets: a card per unit (like the company cards of a group)
function unitsHtml(acct) {
  const ub = unitsBlock(acct.units, acct.st.closing);
  const max = Math.max(1, ...ub.list.map((c) => Math.abs(c.outstanding)));
  return `<div class="row-between"><h3>Unit-wise outstanding</h3><b class="total">${balHtml(acct.st.closing)}</b></div>
    <div class="co-grid">${ub.list.map((c, i) => `
      <div class="co-card${c.outstanding < 0 ? ' adv' : ''}">
        <div class="co-head"><span class="avatar sm">${esc(c.name.replace(/\D/g, '') || '•')}</span><b>${esc(c.name)}</b>
          <button class="icon share-ic" data-unit="${i}" title="Share ${esc(c.name)}'s outstanding as a picture" aria-label="Share as picture">${SHARE_ICON}</button></div>
        <span class="co-val">${balHtml(c.outstanding)}</span>
        <span class="mini-track"><span class="mini owe" style="width:${Math.max(2, (Math.abs(c.outstanding) / max) * 100)}%"></span></span>
        <dl class="co-facts">
          ${c.opening ? `<dt>Opening</dt><dd>${esc(drCr(c.opening))}</dd>` : ''}
          <dt>Billed</dt><dd>${esc(rupees(c.billed))}${c.qty ? ` <small>${esc(litres(c.qty))}</small>` : ''}</dd>
          <dt>Received</dt><dd>${esc(rupees(c.received))}</dd>
          ${c.deductions ? `<dt>TDS &amp; shortage</dt><dd>${esc(rupees(c.deductions))}</dd>` : ''}
          <dt>Pending bills</dt><dd>${acct.units[i].fifo.pending.length}</dd>
        </dl>
      </div>`).join('')}</div>`;
}

async function viewBulkAccount(code) {
  const [data, pod] = await Promise.all([state.store.account(null, code, null, null), state.store.poData()]);
  const poById = new Map();
  const pg = poGroups(pod).find((x) => x.group.code === code);
  if (pg) pg.rows.forEach((r) => poById.set(r.id, r.po));
  const res = bulkRows(data, (sid) => poById.get(sid) || '');
  const g = data.group;
  const name = shortGroup(g.code, g.title);
  const today = localToday();
  const last = res.rows.length ? res.rows[res.rows.length - 1].date : today;
  const asOn = last > today ? last : today;
  const acct = bulkAccount(data, res, name, (pod.groups.find((x) => x.code === code) || {}).opening_by_unit, asOn);
  const { st } = acct;
  const render = () => {
    const view = acctView();
    const months = [...st.months].reverse();
    // the statement of the whole account, or of one unit
    const unitSt = acct.units && state.acctUnit && state.acctUnit.code === code ? acct.units.find((u) => u.unit === state.acctUnit.unit) : null;
    // a group: the whole group's statement, or one company's
    const coSt = acct.companies && state.acctCompany && state.acctCompany.code === code ? acct.companies.find((c) => c.name === state.acctCompany.name) : null;
    const shown = unitSt ? unitSt.st : coSt ? coSt.st : st;
    setMain(`
    <section class="card acct-card">
      <p class="muted small"><a href="#/">← Home</a></p>
      <div class="acct-top">
        <div class="acct-id"><span class="avatar">${esc(initials(name))}</span>
          <div><h2>${esc(name)} <span class="tag bulk">Bulk</span></h2>
            <p class="muted small">The <b>${esc(g.code)}</b> sheet · since ${esc(fmtDate(st.from))} · ${data.members.length > 1 ? `${data.members.length} companies` : esc(data.members[0]?.name || '—')}${acct.units ? ` · ${acct.units.filter((u) => u.unit).length} units` : ''}</p></div></div>
        ${viewToggle(view)}
      </div>
      ${view === 'statement' ? `${acctHeroHtml(st, { asOn, label: 'today' })}
      <div class="share-row">
        <label class="inline-label small">Picture of <select id="share-range">
          <option value="">The whole ledger (since ${esc(fmtDate(st.from))})</option>
          ${months.map((m) => `<option value="${m.month}">${esc(m.title)}</option>`).join('')}</select></label>
        <button class="btn small" data-acct="share">${SHARE_ICON} Share ledger</button>
        <button class="btn ghost small" data-acct="card">${SHARE_ICON} Share outstanding</button>
        ${acct.companies ? '<button class="btn ghost small" data-acct="copdf">Company statements (PDFs)</button>' : ''}
      </div>
      ${acct.units ? '<p class="small muted">Shares one set of pictures per unit — or switch to <b>Both units together</b> in the share sheet.</p>' : ''}
      ${acct.companies ? `<p class="small muted">A statement of account for each of the ${acct.companies.length} companies — its own bills, payments, running balance and pending bills: <b>Company-wise</b> in the share sheet, or <b>Company statements</b> for one PDF per company in a .zip.</p>` : ''}` : ''}
    </section>
    ${view === 'statement' ? `${acct.units ? `<section class="card">${unitsHtml(acct)}</section>` : ''}
      ${st.companies ? `<section class="card">${companiesHtml(st.companies)}</section>` : ''}
      <section class="card" id="pending-card">${pendingHtml(acct, { group: res.kind === 'group' })}</section>
      ${acct.units ? `<div class="chips small-chips unit-pick">${[{ unit: null, label: 'Whole account' }, ...acct.units.map((u) => ({ unit: u.unit, label: unitLabel(u.unit) }))].map((u) => `<button class="chip ${(unitSt ? unitSt.unit : null) === u.unit ? 'on' : ''}" data-ustmt="${u.unit ?? '*'}">${esc(u.label)}</button>`).join('')}</div>` : ''}
      ${acct.companies ? `<div class="share-row co-pick"><label class="inline-label small">Statement of <select id="co-pick">
        <option value="">The whole group</option>
        ${acct.companies.map((c) => `<option value="${esc(c.name)}"${coSt === c ? ' selected' : ''}>${esc(c.name)} · ${esc(drCr(c.st.closing))}</option>`).join('')}</select></label></div>
        ${coSt ? `<section class="card"><h3>${esc(coSt.name)} <span class="muted">· part of ${esc(name)}</span></h3>${acctHeroHtml(coSt.st, { asOn, label: 'today' })}</section>
          <section class="card">${pendingHtml({ fifo: coSt.fifo, units: null })}</section>` : ''}` : ''}
      ${statementCard(shown)}`
    : `<section class="card">${bulkSheet(res, data, name)}</section>`}`);
    bindViewToggle(render);
    if (view === 'sheet') { bindSheet(main()); return; }
    bindStatement(main().querySelector('#stmt-card'), shown);
    main().querySelectorAll('[data-ustmt]').forEach((b) => b.addEventListener('click', () => {
      state.acctUnit = b.dataset.ustmt === '*' ? null : { code, unit: b.dataset.ustmt };
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    }));
    main().querySelector('#co-pick')?.addEventListener('change', (ev) => {
      state.acctCompany = ev.target.value ? { code, name: ev.target.value } : null;
      const y = window.scrollY;
      render();
      window.scrollTo(0, y);
    });
    main().querySelector('[data-acct="share"]').addEventListener('click', () => {
      sharePictures(`${coSt ? coSt.name : name} — ledger`, ledgerOptions(acct, name, asOn, main().querySelector('#share-range').value, coSt));
    });
    const coPdf = main().querySelector('[data-acct="copdf"]');
    coPdf?.addEventListener('click', () => guard(async () => {
      const old = coPdf.textContent;
      coPdf.disabled = true;
      try {
        await companyPdfs(acct, name, asOn, main().querySelector('#share-range').value, (i, n) => { coPdf.textContent = `Making PDF ${i + 1} of ${n}…`; });
      } finally { coPdf.disabled = false; coPdf.textContent = old; }
    }));
    main().querySelector('[data-acct="card"]').addEventListener('click', () => {
      sharePictures(`${name} — outstanding`, cardOptions(acct, name, asOn));
    });
    main().querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => {
      const u = acct.units[Number(b.dataset.unit)];
      sharePictures(`${name} ${unitLabel(u.unit)} — outstanding`, oneCard(cardOf(u.st, { asOn, note: `Part of the ${name} account`, fifo: u.fifo }), safeName(`${name} ${unitLabel(u.unit)} Outstanding ${dmyDash(asOn)}`)));
    }));
    main().querySelectorAll('[data-co]').forEach((b) => b.addEventListener('click', () => {
      const c = st.companies.list[Number(b.dataset.co)];
      sharePictures(`${c.name} — outstanding`, oneCard(companyCard(c, st, asOn), safeName(`${c.name} Outstanding ${dmyDash(asOn)}`)));
    }));
  };
  render();
}

// the *_Bulk sheet as in Excel (column letters, widths, number formats)
function bulkSheet(res, data, name) {
  const g = data.group;
  const n = res.columns.length;
  const widths = (res.widths || DEFAULT_BULK_WIDTHS[res.kind]).slice(0, n).map(xlPx);
  const spacer = res.widths && res.widths[n] ? xlPx(res.widths[n]) : 60;
  const all = [...widths, spacer, xlPx(18), xlPx(18)];
  const who = g.kind === 'group' ? 'Group:' : 'Customer:';
  const whoValue = g.kind === 'group' ? name : (data.members[0] ? data.members[0].name : name);
  const info = (label, value) => `<td></td>${cell(label, 'b')}${cell(value, 'b')}`;
  const blankRow = (k = n) => '<td></td>'.repeat(k);
  const rows = [
    { cells: `<td colspan="${n}" class="xl-title">${esc(g.title || name)}</td>${blankRow(3)}` },
    { cells: blankRow(n + 3) },
    { cells: `${blankRow()}${info(who, whoValue)}` },
    { cells: `${blankRow()}${info('Opening Balance:', xlRupee(res.opening))}` },
    { cells: `${res.columns.map((c) => cell(COLUMN_HEAD[c], 'xl-head')).join('')}${info('Period From:', xlDate(g.period_from))}` },
    ...res.rows.map((r) => ({
      cells: `${res.columns.map((c) => {
        const numeric = ['qty', 'rate', 'amount', 'paid', 'tds', 'shortage', 'balance'].includes(c);
        return cell(cellText(c, r), `${numeric ? 'num' : ''}${isNegative(c, r) ? ' neg' : ''}${c === 'date' ? ' c' : ''}`);
      }).join('')}${blankRow(3)}`,
    })),
  ];
  return `<p class="muted small">The <b>${esc(g.code)}</b> sheet as in the Master Ledger: ${plural(res.rows.filter((r) => !r.payment).length, 'bill')} and ${plural(res.rows.filter((r) => r.payment).length, 'payment')} since ${fmtDate(g.period_from || res.rows[0]?.date || '')} · members: ${data.members.map((m) => esc(m.name)).join(', ') || '—'}${res.widths ? '' : ' · <span class="warn-text">column widths come with the next Master Ledger upload</span>'}</p>
    ${sheetHtml(all, rows)}`;
}

function monthShift(ym, n) {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

async function viewRetailAccount(key, month) {
  const today = localToday();
  const ym = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  const from = `${ym}-01`;
  const to = monthEnd(from);
  const data = await state.store.account(key, null, from, to);
  const c = data.customer;
  const led = ledgerRows({ opening: c.opening, from, sales: data.sales, payments: data.payments });
  const current = ym === today.slice(0, 7);
  const asOn = current ? today : to;
  const st = retailStatement(led, { name: c.name, from, to: asOn });
  const first = data.first ? data.first.slice(0, 7) : ym;
  const prev = monthShift(ym, -1);
  const next = monthShift(ym, 1);
  const period = `for The Month of  ${monthLabel(from)}`;
  const title = String(c.title || '').trim() || c.name;
  const L = c.layout && Array.isArray(c.layout.cols) && c.layout.cols.length === 7 ? c.layout : DEFAULT_LAYOUT;
  const render = () => {
    const view = acctView();
    setMain(`
    <section class="card acct-card">
      <p class="muted small"><a href="#/">← Home</a></p>
      <div class="acct-top">
        <div class="acct-id"><span class="avatar">${esc(initials(c.name))}</span>
          <div><h2>${esc(c.name)} <span class="tag">Retail</span></h2>
            <p class="muted small">The <b>${esc(c.ledger || c.name)}</b> sheet${view === 'sheet' && L === DEFAULT_LAYOUT ? ' · <span class="warn-text">column widths come with the next Master Ledger upload</span>' : ''}</p></div></div>
        ${viewToggle(view)}
      </div>
      <div class="month-nav">
        ${prev >= first ? `<a class="btn ghost small" href="#/account/c/${encodeURIComponent(key)}?m=${prev}">‹ ${monthLabel(`${prev}-01`)}</a>` : '<span></span>'}
        <b>${monthLabel(from)}</b>
        ${next <= today.slice(0, 7) ? `<a class="btn ghost small" href="#/account/c/${encodeURIComponent(key)}?m=${next}">${monthLabel(`${next}-01`)} ›</a>` : '<span></span>'}
      </div>
      ${view === 'statement' ? `${acctHeroHtml(st, { asOn, label: current ? 'today' : `end of ${monthLabel(from)}` })}
      <div class="share-row">
        <button class="btn small" data-acct="share">${SHARE_ICON} Share ledger</button>
        <button class="btn ghost small" data-acct="card">${SHARE_ICON} Share outstanding</button>
      </div>` : `<div class="xl-retail">${retailSheet(led, c, { from, period, title, L })}</div>
      <p class="actions"><button class="btn small" data-xl="share">Share as picture</button><button class="btn ghost small" data-xl="pdf">PDF</button></p>`}
    </section>
    ${view === 'statement' ? statementCard(st) : ''}`);
    bindViewToggle(render);
    const base = safeName(`${c.name} Ledger ${monthLabel(from)}`);
    if (view === 'statement') {
      bindStatement(main().querySelector('#stmt-card'), st);
      main().querySelector('[data-acct="share"]').addEventListener('click', () => {
        let made = null;
        sharePictures(`${c.name} — ledger`, async () => { made = await ledgerFiles(st, base); return made.files; }, {
          pdf: async () => download(await pdfFromSvgs(made.svgs, SHARE_PAGE_PT, { scale: SHARE_PAGE.width / SHARE_PAGE_PT.width }), `${base}.pdf`),
        });
      });
      main().querySelector('[data-acct="card"]').addEventListener('click', () => {
        sharePictures(`${c.name} — outstanding`, oneCard(cardOf(st, { asOn }), safeName(`${c.name} Outstanding ${dmyDash(asOn)}`)));
      });
      return;
    }
    // the Excel-style picture / PDF (the same page as the Statements tab)
    bindSheet(main());
    const svgOf = async () => ledgerSvg({
      title, subtitle: 'Ledger Account for Diesel', period, ...led, total: false, layout: c.layout,
    }, await statementImages());
    const xlBase = `${firstWord(c.name)} Ledger ${monthLabel(from)}`;
    main().querySelector('[data-xl="share"]').addEventListener('click', (e) => guard(async () => {
      e.target.disabled = true;
      try {
        const blob = await jpegFromSvg(await svgOf(), PAGE);
        await shareOrSave([new File([blob], `${xlBase}.jpeg`, { type: 'image/jpeg' })], `${xlBase}.zip`);
      } finally { e.target.disabled = false; }
    }));
    main().querySelector('[data-xl="pdf"]').addEventListener('click', (e) => guard(async () => {
      e.target.disabled = true;
      try { download(await pdfFromSvgs([await svgOf()], PAGE_PT, { scale: 2.5 }), `${xlBase}.pdf`); } finally { e.target.disabled = false; }
    }));
  };
  render();
}

// the ledger sheet (A:G) for the month, as in Excel
function retailSheet(led, c, { from, period, title, L }) {
  const widths = L.cols.map(xlPx);
  const rowH = ptPx(Number(L.row) > 5 ? Number(L.row) : DEFAULT_LAYOUT.row);
  const headH = ptPx(Number(L.head) > 5 ? Number(L.head) : DEFAULT_LAYOUT.head);
  // every column but the date is right-aligned on the sheet
  const r = (vals) => vals.map((v, i) => cell(v.t ?? v, `${i ? 'num' : ''} ${v.c || ''}`.trim())).join('');
  const rows = [
    { h: ptPx(30), cells: `<td colspan="7" class="xl-t1"><img src="assets/logo.png" alt="" class="xl-logo">${esc(title)}</td>` },
    { h: ptPx(19), cells: '<td colspan="7" class="xl-t2">Ledger Account for Diesel</td>' },
    { h: ptPx(22), cells: `<td colspan="7" class="xl-t2 pre">${esc(period)}</td>` },
    { h: headH, cells: ['Date', 'Volume', 'Price', 'Amount', 'Paid', 'Product', 'Balance'].map((x) => cell(x, 'xl-h2')).join('') },
    { h: rowH, cells: r([ddmmyy(from), '', '', '', '', '', rupeeAuto(led.opening)]) },
    ...led.rows.map((x) => ({
      h: rowH,
      cells: r([
        { t: x.showDate ? ddmmyy(x.date) : '', c: 'l' },
        { t: x.hasSale ? indAuto(x.qty) : '', c: x.petrol ? 'or' : '' },
        { t: x.hasSale && x.rate != null ? x.rate.toFixed(2) : '', c: x.petrol ? 'or' : '' },
        { t: x.hasSale ? indAuto(x.amount) : '', c: x.petrol ? 'or' : '' },
        { t: x.paid ? indAuto(x.paid) : '', c: 'b' },
        { t: x.label, c: x.petrol ? 'or' : '' },
        { t: rupeeAuto(x.balance), c: x.balance < 0 ? 'neg' : '' },
      ]),
    })),
  ];
  return sheetHtml(widths, rows);
}

// the outstanding card of anyone on Home's list (o: analyse().due row)
// -> share options (unit-wise / together for an SMC-style sheet)
async function outstandingOptionsFor(o) {
  return cardMakers((await outstandingFor(state.store, o, localToday())).options);
}

function poCard(g) {
  const name = esc(groupName(g.group, g.members));
  const lists = g.registers.map((r) => {
    const pending = r.pos.filter((p) => p.status === 'Pending');
    const left = pending.reduce((a, p) => a + p.balance, 0);
    return `<div class="reg-line">${r.unit ? `<span class="unit">${esc(r.unit)}</span>` : ''}
      ${pending.length ? `${plural(pending.length, 'open PO')} · <b>${fmtLitres(left)} L</b> left` : '<span class="bad-text">No PO with litres left</span>'}</div>`;
  }).join('');
  return `<a class="po-card" href="#/pos/${encodeURIComponent(g.group.code)}">
    <b>${name}</b>${lists}
    ${g.toPick ? `<div class="warn-text">${plural(g.toPick, 'bill')} to pick a PO for</div>` : ''}
    ${g.noPo ? `<div class="warn-text">${plural(g.noPo, 'bill')} without a PO</div>` : ''}
    ${g.needsUnit ? `<div class="warn-text">${plural(g.needsUnit, 'bill')} need a unit</div>` : ''}
  </a>`;
}

// ---------------------------------------------------------------------------
// Import: Tally DayBook and Master Ledger
// ---------------------------------------------------------------------------
// "Sales in the app up to" — on the Import tab
function salesCard(sum) {
  if (!sum.last_sale_date) return '';
  const sales = sum.sales || {};
  return `<section class="hero card">
    <p class="eyebrow">Sales in the app up to</p>
    <h2>${fmtDate(sum.last_sale_date)}</h2>
    <div class="stats">
      ${['HSD', 'MS', 'XG', 'OTHER'].filter((p) => sales[p]).map((p) => `
        <div><span class="num">${sales[p].bills.toLocaleString('en-IN')}</span><span class="lbl">${PRODUCT[p]} bills</span></div>`).join('')}
      <div><span class="num">${(sum.payments || 0).toLocaleString('en-IN')}</span><span class="lbl">payments</span></div>
    </div>
    <p class="actions"><button class="btn" type="button" data-pick-daybook>Import sales (DayBook)</button> <a class="btn ghost" href="#/sales">See the latest day</a></p>
  </section>`;
}

// 2026-09-26 -> Saturday, 26 September 2026
function longDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()];
  return `${day}, ${d.getDate()} ${month} ${d.getFullYear()}`;
}

async function viewImport() {
  const [imports, sum] = await Promise.all([state.store.imports(10), state.store.summary()]);
  setMain(`
    ${salesCard(sum)}
    <div id="mac-import"></div>
    <section class="card" id="daybook-card">
      <h2>Import sales — Tally DayBook</h2>
      <p class="muted">HSD, MS and XG credit vouchers are added, and <b>Tally is the source of truth</b>: a bill already in the app takes the DayBook's date, customer, vehicle, litres, rate and amount — so importing a corrected DayBook again corrects the app. What you typed against a bill here (unit, PO, TDS, shortage, remarks) stays.</p>
      <label class="file"><input type="file" id="daybook-file" accept=".xls,.xlsx,.xlsm,.csv"><span class="btn">Choose DayBook file</span></label>
      <div id="daybook-out"></div>
    </section>
    <section class="card" id="master">
      <h2>Upload Master Ledger</h2>
      <p class="muted">Copies sales, payments, customers, opening balances, the Bulk sheets' PO lists and what you typed against each bulk bill. The file is read on this device and isn't changed.</p>
      <label class="file"><input type="file" id="master-file" accept=".xlsm,.xlsx"><span class="btn ghost">Choose Master Ledger.xlsm</span></label>
      <div id="master-out"></div>
    </section>
    <section class="card" id="tanker-billing">
      <h2>Import Tanker Billing workbook</h2>
      <p class="muted">For <a href="#/quotes">Quotes</a>: the customers (they become the Tanker Master too), price tiers, IOCL RSP, XtraPower figures, the Quotation Maker's inputs, both sheets' wording, letterheads and stamps, and the PI Log. The file is read on this device and isn't changed.</p>
      <label class="file"><input type="file" id="tb-file-import" accept=".xlsm,.xlsx"><span class="btn ghost">Choose Tanker Billing.xlsm</span></label>
      <div id="tb-out-import"></div>
    </section>
    <section class="card">
      <h3>Recent uploads</h3>
      ${imports.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>What</th><th>File</th><th>Result</th></tr></thead>
        <tbody>${imports.map(importRow).join('')}</tbody></table></div>` : '<p class="muted">Nothing uploaded yet.</p>'}
    </section>`);
  document.getElementById('daybook-file').addEventListener('change', (e) => e.target.files[0] && daybookChosen(e.target.files[0], e.target));
  main().querySelector('[data-pick-daybook]')?.addEventListener('click', () => document.getElementById('daybook-file').click());
  document.getElementById('master-file').addEventListener('change', (e) => e.target.files[0] && masterChosen(e.target.files[0], e.target));
  bindTankerImport('tb-file-import', 'tb-out-import');
  // the workbooks the Mac uploaded: listed here; one picked on Home is opened straight away
  const ups = await macUploadsList();
  const box = document.getElementById('mac-import');
  if (ups.length && box) {
    box.innerHTML = `<section class="card"><h3>From your Mac</h3>
      <p class="muted small">Uploaded by the Google Drive sync on your Mac (<code>vriddhi_gdrive.sh</code>) and imported by itself as soon as the app is open. <b>Import again</b> shows the usual preview first.</p>
      <div class="todos">${ups.map((u) => `<div class="todo${u.fresh ? ' warn' : ''}"><b>${esc(u.label)}</b> · uploaded ${esc(upWhen(u.updated_at))}${u.size ? ` · ${(u.size / 1048576).toFixed(1)} MB` : ''}
        ${u.fresh ? '<span class="tag warn">new</span>' : '<span class="muted small">imported</span>'}
        <button class="btn small" data-mac-import="${esc(u.name)}">${u.fresh ? 'Review &amp; import' : 'Import again'}</button></div>`).join('')}</div></section>`;
    box.querySelectorAll('[data-mac-import]').forEach((b) => b.addEventListener('click', () => guard(() => openMacUpload(ups.find((u) => u.name === b.dataset.macImport)))));
  }
  if (state.pendingUpload) {
    const u = state.pendingUpload;
    state.pendingUpload = null;
    await openMacUpload(u);
  }
}

// ---- the Mac's uploads (vriddhi_gdrive.sh → Storage bucket ledger-uploads) ----
const MAC_FILES = {
  'master-ledger.xlsm': { kind: 'master', label: 'Master Ledger.xlsm' }, 'tanker-billing.xlsm': { kind: 'tanker', label: 'Tanker Billing.xlsm' },
  'e-dsr.xlsx': { kind: 'register', label: 'E-DSR.xlsx' }, 'stock-register.xlsm': { kind: 'register', label: 'Stock Register.xlsm' },
  'dip-chart.xlsm': { kind: 'register', label: 'DIP Chart.xlsm' },
};
const upWhen = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
// [{name, label, kind, updated_at, size, fresh}] — fresh: not imported yet (or uploaded again since)
async function macUploadsList() {
  if (!state.store.macUploads) return [];
  const [list, seen] = await Promise.all([state.store.macUploads().catch(() => []), state.store.setting('mac_uploads').catch(() => null)]);
  return list.filter((o) => MAC_FILES[o.name]).map((o) => ({
    ...o, ...MAC_FILES[o.name], fresh: !(seen && seen[o.name] && seen[o.name] >= o.updated_at),
  })).sort((a, b) => a.label.localeCompare(b.label));
}
async function markUploadSeen(u) {
  const seen = (await state.store.setting('mac_uploads').catch(() => null)) || {};
  await state.store.setSetting('mac_uploads', { ...seen, [u.name]: u.updated_at }).catch(() => null);
}
// The Mac's uploads, imported as soon as the app is open — no preview and no
// tap (the workbooks are the source of truth). Another device may be doing
// the same: each upload is checked again just before it's imported.
async function autoImportMac() {
  if (state.demo || !state.store || !state.store.macUploads || state.macImporting) return;
  state.macImporting = true;
  const bar = (html, kind = '') => { const el = document.getElementById('auto-bar'); if (el) el.innerHTML = html ? `<div class="auto-bar ${kind}">${html}</div>` : ''; };
  let done = 0;
  try {
    const fresh = (await macUploadsList()).filter((u) => u.fresh);
    for (const u of fresh) {
      const seen = (await state.store.setting('mac_uploads').catch(() => null)) || {};
      if (seen[u.name] && seen[u.name] >= u.updated_at) continue;          // another device just did it
      bar(`<span class="spinner"></span> Bringing in <b>${esc(u.label)}</b> from your Mac (uploaded ${esc(upWhen(u.updated_at))})…`);
      try {
        const file = new File([await state.store.macUploadFile(u.name)], u.label, { type: 'application/vnd.ms-excel.sheet.macroEnabled.12' });
        let note;
        if (u.kind === 'master') {
          const XLSX = await loadSheetJS();
          const { payload } = extractMaster(readWorkbook(XLSX, await file.arrayBuffer()));
          const res = await state.store.importMaster(u.label, payload);
          note = `${plural(res.sales_new, 'new bill')}, ${plural(res.payments, 'payment')}${res.pos_new || res.pos_updated || res.pos_removed ? `, PO lists updated` : ''}`;
        } else if (u.kind === 'register') {
          note = await importRegisterFile(file);
        } else {
          const r = await readTankerFile(file);
          const res = await quotesCall(() => state.store.tankerImport(u.label, { customers: r.parsed.customers, data: r.data, pi_log: r.parsed.pi_log, cn_log: r.cnLog, images: r.images }));
          state.quotes = null;
          state.docForms = null;
          note = `${plural(res.customers, 'customer')}, ${plural(res.pi_new, 'new PI')}${piCheckClean(r.piCheck) ? '' : ' — its PI Log differs from the app\'s (Quotes → PI Log)'}`;
        }
        await markUploadSeen(u);
        if (state.macFailed) delete state.macFailed[u.name];
        toast(`${u.label} from your Mac is in: ${note}.`);
        done++;
      } catch (err) {
        console.error(err);
        (state.macFailed || (state.macFailed = {}))[u.name] = (err && err.message) || String(err);
        bar(`Couldn't bring in <b>${esc(u.label)}</b> from your Mac: ${esc((err && err.message) || err)} <a href="#/import">Import it by hand →</a>`, 'bad');
        return;
      }
    }
    bar('');
    if (done && !/^#\/import/.test(location.hash)) route();                  // the screen shows the new figures
  } finally {
    state.macImporting = false;
  }
}

// fetch an upload and open the import preview with it, as if chosen on this device
async function openMacUpload(u) {
  if (!u) return;
  const out = document.getElementById(u.kind === 'master' ? 'master-out' : 'tb-out-import');
  if (!out) { state.pendingUpload = u; location.hash = '#/import'; return; }
  out.innerHTML = loadingHtml(`Fetching ${u.label} from the upload…`);
  out.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const blob = await state.store.macUploadFile(u.name);
  const file = new File([blob], u.label, { type: 'application/vnd.ms-excel.sheet.macroEnabled.12' });
  file.upload = u;
  if (u.kind === 'master') await masterChosen(file, { value: '' });
  else if (u.kind === 'register') {
    const note = await importRegisterFile(file);
    await markUploadSeen(u);
    out.innerHTML = `<p class="good-text">${esc(note)} — on <a href="#/register">Register</a>.</p>`;
  } else await tankerChosen(file, { value: '' }, 'tb-out-import');
}

function importRow(i) {
  const c = i.counts || {};
  const byProduct = (o) => Object.entries(o || {}).map(([p, n]) => `${n} ${p}`).join(', ');
  const result = i.kind === 'daybook'
    ? `${byProduct(c.inserted) || 'no new bills'}${byProduct(c.updated) ? ` · ${byProduct(c.updated)} updated` : ''}${c.unchanged ? ` · ${c.unchanged} unchanged` : ''}${c.removed ? ` · ${c.removed} removed` : ''}${c.duplicates ? ` · ${c.duplicates} already there` : ''}`
    : i.kind === 'payments_app' ? `${c.payments ?? 0} payments added`
      : i.kind === 'tanker_billing' ? `${c.customers ?? 0} customers · ${c.pi_new ?? 0} new PIs${c.pi_updated ? ` · ${c.pi_updated} refreshed` : ''}${c.pi_differ || c.pi_not_in_excel ? ` · PI Log doesn't match Excel (${[c.pi_differ ? `${c.pi_differ} differ` : '', c.pi_not_in_excel ? `${c.pi_not_in_excel} not in Excel` : ''].filter(Boolean).join(', ')})` : ''}`
      : `${c.sales_new ?? 0} new bills · ${c.sales_updated ?? 0} refreshed · ${c.payments ?? 0} payments · ${c.pos_new ?? 0} new POs${c.pos_updated ? ` · ${c.pos_updated} POs changed` : ''}${c.pos_removed ? ` · ${c.pos_removed} POs removed` : ''}`;
  const what = { daybook: 'DayBook', payments_app: 'Payments app', master_ledger: 'Master Ledger', tanker_billing: 'Tanker Billing' }[i.kind] || i.kind;
  return `<tr><td>${esc(new Date(i.created_at).toLocaleString('en-IN'))}</td><td>${what}</td><td>${esc(i.file_name)}</td><td>${esc(result)}</td></tr>`;
}

async function daybookChosen(file, input) {
  const out = document.getElementById('daybook-out');
  out.innerHTML = loadingHtml(`Reading ${file.name}…`);
  await paint();
  try {
    const XLSX = await loadSheetJS();
    const wb = readWorkbook(XLSX, await file.arrayBuffer(), { all: true });
    const date1904 = Boolean(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
    const parsed = parseDaybook(sheetRows(wb.Sheets[wb.SheetNames[0]]), { date1904 });
    const rows = daybookPayload(parsed);
    if (!rows.length) {
      out.innerHTML = `<div class="card bad-card">No HSD / MS / XG credit vouchers were found in the first sheet of “${esc(file.name)}”.
        ${parsed.otherTypes.length ? `<p>It has: ${parsed.otherTypes.map((t) => `${esc(t.type)} (${t.count})`).join(', ')}.</p>` : ''}</div>`;
      return;
    }
    const keys = rows.map(({ product, bill_no, sale_date }) => ({ product, bill_no, sale_date }));
    // the app's bills in the DayBook's dates, to show the ones it no longer has
    const span = parsed.from && parsed.to && daysBetween(parsed.from, parsed.to) <= 400;
    let current;
    let inApp;
    try {
      [current, inApp] = await Promise.all([state.store.daybookBills(keys), span ? state.store.salesRange(parsed.from, parsed.to) : []]);
    } catch (err) {
      if (/ledger_daybook_bills|schema cache|does not exist/i.test(err.message || '')) {
        throw new Error('The database needs an update to replace bills from a DayBook: run supabase/ledger-schema.sql again in the Supabase SQL Editor (safe to re-run), then choose the file again.');
      }
      throw err;
    }
    const ch = daybookChanges(rows, current, inApp);
    const { fresh, changed, same, missing } = ch;
    const known = new Set((await state.store.customers()).map((c) => c.key));
    const newNames = [...new Map([...fresh, ...changed.map((c) => c.row)].filter((r) => !known.has(normKey(r.customer))).map((r) => [normKey(r.customer), r.customer])).values()];
    const count = (list, p) => list.filter((r) => r.product === p).length;
    const label = { date: 'Date', customer: 'Customer', vehicle: 'Vehicle', qty: 'Litres', rate: 'Rate', amount: 'Amount' };
    const show = (f, v) => (v == null || v === '' ? '—' : f === 'date' ? fmtDate(v) : f === 'qty' ? fmtLitres(v) : f === 'amount' ? fmtMoney(v) : String(v));
    const changeLine = (c) => `<li><b>${esc(c.row.product)} ${esc(c.row.bill_no)}</b> · ${fmtDate(c.row.sale_date)} · ${esc(c.row.customer)}: ${c.changes.map(([f, a, b]) => `${label[f]} ${esc(show(f, a))} → <b>${esc(show(f, b))}</b>`).join('; ')}</li>`;
    out.innerHTML = `
      <div class="preview">
        <p><b>${esc(file.name)}</b> · ${parsed.from === parsed.to ? fmtDate(parsed.from) : `${fmtDate(parsed.from)} – ${fmtDate(parsed.to)}`}</p>
        <div class="table-wrap"><table class="compact">
          <thead><tr><th></th><th class="r">New</th><th class="r">Corrected</th><th class="r">Same as in the app</th></tr></thead>
          <tbody>${['HSD', 'MS', 'XG'].map((p) => `<tr><td>${PRODUCT[p]}</td><td class="r"><b>${count(fresh, p)}</b></td><td class="r"><b>${count(changed.map((c) => c.row), p)}</b></td><td class="r">${count(same, p)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${changed.length ? `<details open><summary><b>${plural(changed.length, 'bill')} will be corrected</b> to the DayBook's figures</summary><ul class="small">${changed.slice(0, 200).map(changeLine).join('')}</ul>${changed.length > 200 ? `<p class="muted">…and ${changed.length - 200} more.</p>` : ''}</details>` : ''}
        ${missing.length ? `<div class="warn-box">
          <label class="radio"><input type="checkbox" id="daybook-remove"> Also remove ${plural(missing.length, 'bill')} that ${missing.length > 1 ? 'are' : 'is'} in the app for these dates but not in this DayBook (deleted or renumbered in Tally)</label>
          <details><summary class="small">See ${missing.length > 1 ? 'them' : 'it'}</summary>${salesTable(missing.slice(0, 300))}</details></div>` : ''}
        ${!span && parsed.from ? '<p class="muted small">This DayBook covers more than 400 days, so bills it no longer has can\'t be listed for removal — import a shorter period to do that.</p>' : ''}
        ${newNames.length ? `<p class="warn-text">New customer${newNames.length > 1 ? 's' : ''}: ${newNames.map(esc).join(', ')} — you'll be asked for ledger names after the import.</p>` : ''}
        ${parsed.problems.length ? `<details open><summary class="warn-text">${plural(parsed.problems.length, 'row')} to check</summary><ul>${parsed.problems.map((p) => `<li>Row ${p.row}, bill ${esc(p.bill_no)}: ${esc(p.problem)}</li>`).join('')}</ul></details>` : ''}
        ${parsed.otherTypes.length ? `<p class="muted small">Skipped other vouchers: ${parsed.otherTypes.map((t) => `${esc(t.type)} (${t.count})`).join(', ')}.</p>` : ''}
        ${fresh.length ? `<details><summary>See the ${plural(fresh.length, 'new bill')}</summary>${salesTable(fresh.slice(0, 300))}${fresh.length > 300 ? `<p class="muted">…and ${fresh.length - 300} more.</p>` : ''}</details>` : ''}
        <p class="actions">
          <button class="btn" id="daybook-go"></button>
          <button class="btn ghost" id="daybook-cancel">Cancel</button>
        </p>
      </div>`;
    document.getElementById('daybook-cancel').addEventListener('click', () => { out.innerHTML = ''; input.value = ''; });
    const go = document.getElementById('daybook-go');
    const remove = document.getElementById('daybook-remove');
    const setLabel = () => {
      const parts = [];
      if (fresh.length) parts.push(`add ${plural(fresh.length, 'new bill')}`);
      if (changed.length) parts.push(`correct ${changed.length}`);
      if (remove && remove.checked) parts.push(`remove ${missing.length}`);
      go.disabled = !parts.length;
      go.textContent = parts.length ? `Import: ${parts.join(', ')}` : 'Nothing to change — the app already matches this DayBook';
    };
    setLabel();
    remove?.addEventListener('change', setLabel);
    go.addEventListener('click', () => guard(async () => {
      const removeMissing = Boolean(remove && remove.checked);
      if (removeMissing && !window.confirm(`Remove ${plural(missing.length, 'bill')} that ${missing.length > 1 ? 'are' : 'is'} not in this DayBook? Anything typed against ${missing.length > 1 ? 'them' : 'it'} in the app (PO, TDS, remarks) goes too.`)) return;
      go.disabled = true;
      go.textContent = 'Importing…';
      const res = await state.store.importDaybook(file.name, rows, removeMissing);
      if (res.updated === undefined) {
        throw new Error('The database still skips bills that are already there: run supabase/ledger-schema.sql again in the Supabase SQL Editor, then import the DayBook again.');
      }
      const byProduct = (o) => Object.entries(o || {}).map(([p, n]) => `${n} ${PRODUCT[p]}`).join(', ');
      const done = [byProduct(res.inserted) && `added ${byProduct(res.inserted)}`, byProduct(res.updated) && `corrected ${byProduct(res.updated)}`,
        res.removed && `removed ${plural(res.removed, 'bill')}`].filter(Boolean).join(' · ') || 'nothing changed';
      input.value = '';
      out.innerHTML = `<div class="card good-card"><b>Imported:</b> ${esc(done)}.${res.unchanged ? ` ${plural(res.unchanged, 'bill')} already matched.` : ''}
        ${res.new_customers && res.new_customers.length ? `<p>New customer${res.new_customers.length > 1 ? 's' : ''}: ${res.new_customers.map(esc).join(', ')}. <a href="#/customers">Give ${res.new_customers.length > 1 ? 'them' : 'it'} a ledger name →</a></p>` : ''}
        <p><a href="#/sales/${esc(parsed.to)}">See ${fmtDate(parsed.to)} →</a> · <a href="#/pos">PO lists →</a></p></div>`;
      toast('Sales imported.');
    }).finally(() => { if (document.body.contains(go)) setLabel(); }));
  } catch (err) {
    out.innerHTML = errorHtml(err);
  }
}

function salesTable(rows, { showProduct = true } = {}) {
  return `<div class="table-wrap"><table class="compact">
    <thead><tr>${showProduct ? '<th>Fuel</th>' : ''}<th>Bill</th><th>Date</th><th>Customer</th><th>Vehicle</th><th class="r">Litres</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>${showProduct ? `<td>${esc(r.product)}</td>` : ''}<td>${esc(r.bill_no)}</td><td>${fmtDate(r.sale_date || r.date)}</td><td>${esc(r.customer)}${r.item ? ` <span class="muted">(${esc(r.item)})</span>` : ''}</td><td>${esc(r.vehicle)}</td><td class="r">${fmtLitres(r.qty)}</td><td class="r">${r.rate != null ? esc(r.rate) : ''}</td><td class="r">${fmtMoney(r.amount)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

// The upload preview's PO part: list by list, what the workbook adds,
// changes and removes (POs added in the app are named, as they go)
function poChangesHtml(changes) {
  if (!changes.length) return '<p class="good-text small">✓ PO lists: the same as in the app.</p>';
  const name = (l) => `${esc(l.group_code)}${l.unit ? ` · ${esc(l.unit)}` : ''}`;
  const pos = (list) => list.map((x) => `<b>${esc(x.po_no)}</b>`).join(', ');
  const appMade = changes.flatMap((l) => l.removed.filter((x) => x.source === 'app'));
  return `<div class="pi-check ${appMade.length ? 'warn' : ''}"><b>PO lists — the workbook's replace the app's</b>
    ${appMade.length ? `<p class="small warn-text">${plural(appMade.length, 'PO')} added in the app ${appMade.length === 1 ? 'is' : 'are'} not on the *_Bulk sheet and will be removed: ${pos(appMade)}. Add ${appMade.length === 1 ? 'it' : 'them'} to the sheet first to keep ${appMade.length === 1 ? 'it' : 'them'}.</p>` : ''}
    <div class="table-wrap"><table class="compact"><thead><tr><th>PO list</th><th>Added</th><th>Litres changed</th><th>Removed</th></tr></thead><tbody>
    ${changes.map((l) => `<tr><td>${name(l)}${l.moved ? ` <span class="muted small">(${plural(l.moved, 'PO')} moved in the order)</span>` : ''}</td>
      <td>${l.added.map((x) => `${esc(x.po_no)} <span class="muted">${fmtLitres(x.allotted)} L</span>`).join('<br>') || '—'}</td>
      <td>${l.changed.map((x) => `${esc(x.po_no)} <span class="muted">${fmtLitres(x.from)} → ${fmtLitres(x.to)} L</span>`).join('<br>') || '—'}</td>
      <td>${l.removed.map((x) => `${esc(x.po_no)}${x.source === 'app' ? ' <span class="tag warn">added in app</span>' : ''}`).join('<br>') || '—'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

async function masterChosen(file, input) {
  const out = document.getElementById('master-out');
  out.innerHTML = loadingHtml(`Reading ${file.name} — a big workbook can take a few seconds…`);
  await paint();
  try {
    const XLSX = await loadSheetJS();
    const wb = readWorkbook(XLSX, await file.arrayBuffer());
    const { payload, preview, warnings } = extractMaster(wb);
    // the PO lists follow the workbook: what this upload adds, changes and removes
    const poNow = await state.store.poData().then((x) => x.pos || []).catch(() => []);
    const poChanges = poListChanges(poNow, payload.pos, (payload.groups || []).map((g) => g.code));
    const s = preview.sales;
    const span = (x) => (x.count ? `${x.count.toLocaleString('en-IN')} <span class="muted">(${fmtDate(x.from)} – ${fmtDate(x.to)})</span>` : '0');
    const ruleLine = (r) => `<br><span class="muted small">${r === 'pick' ? 'Rule: the one PO with room, else “Select PO ▼”' : 'Rule: the first PO with room'}</span>`;
    const checkLine = (c) => {
      if (!c) return '';
      if (!c.compared) return `<span class="muted">no bill shows the formula's own PO — the POs are picked / typed on the sheet, and come in as they are</span>${ruleLine(c.rule)}`;
      if (!c.mismatches.length) return `<span class="good-text">✓ same POs as Excel on all ${c.compared} bills</span>${ruleLine(c.rule)}`;
      return `<span class="warn-text">${c.mismatches.length} of ${c.compared} bills differ from Excel</span>${ruleLine(c.rule)}
        <ul class="small">${c.mismatches.slice(0, 10).map((m) => `<li>${fmtDate(m.date)} bill ${esc(m.bill_no)}: Excel “${esc(m.excel) || '—'}”, app “${esc(m.app) || '—'}”</li>`).join('')}</ul>`;
    };
    out.innerHTML = `
      <div class="preview">
        <div class="table-wrap"><table class="compact">
          <tbody>
            <tr><td>Diesel (HSD) bills</td><td>${span(s.HSD)}</td></tr>
            <tr><td>Petrol (MS) bills</td><td>${span(s.MS)}</td></tr>
            <tr><td>XtraGreen bills</td><td>${span(s.XG)}</td></tr>
            <tr><td>Other Sale bills</td><td>${span(s.OTHER)}</td></tr>
            <tr><td>Payments (Master Paid)</td><td>${span(preview.payments)} · ${fmtMoney(preview.payments.total)}</td></tr>
            <tr><td>Customers</td><td>${preview.customers} <span class="muted">(${preview.ledgerNames} with a ledger name)</span></td></tr>
            <tr><td>Ledger sheets (for statements)</td><td>${preview.ledgerSheets} <span class="muted">(${preview.ledgerAddresses} with a Bill To address)</span></td></tr>
            <tr><td>Tanker Master companies</td><td>${preview.tanker}</td></tr>
            <tr><td>Opening balances</td><td>${preview.opening.count} <span class="muted">(${preview.opening.months.map((m) => fmtDate(m).slice(3)).join(', ')})</span></td></tr>
          </tbody></table></div>
        <h3>Bulk ledgers</h3>
        <div class="table-wrap"><table class="compact">
          <thead><tr><th>Sheet</th><th>Customer</th><th class="r">POs</th><th class="r">Diesel bills</th><th>PO check</th></tr></thead>
          <tbody>${preview.groups.map((g) => `<tr><td>${esc(g.code)}${g.units.length ? ` <span class="muted">(${g.units.map(esc).join(' / ')})</span>` : ''}</td><td>${g.members.map(esc).join(', ')}</td><td class="r">${g.kind === 'group' ? '—' : g.pos}</td><td class="r">${g.bills}</td><td>${g.kind === 'group' ? '<span class="muted">group ledger, no POs</span>' : checkLine(g.check)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${warnings.length ? `<details open><summary class="warn-text">${plural(warnings.length, 'note')}</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
        ${poChangesHtml(poChanges)}
        <details><summary>What an upload changes</summary>
          <ul class="small">
            <li>Sales, payments, opening balances and TDS / shortage / remarks are brought in line with the workbook.</li>
            <li><b>PO lists follow the workbook</b>: each bulk ledger gets exactly the PO lists of its *_Bulk sheet — its POs, litres and order. A PO added in the app and not on the sheet is removed.</li>
            <li>Ledger names, and a bill's Unit or PO, belong to the app after the first upload — later uploads only fill in blanks.</li>
            <li>Nothing is deleted except payments copied from Master Paid, which are replaced by the workbook's list.</li>
          </ul></details>
        <p class="actions"><button class="btn" id="master-go">Copy into the app</button> <button class="btn ghost" id="master-cancel">Cancel</button></p>
      </div>`;
    document.getElementById('master-cancel').addEventListener('click', () => { out.innerHTML = ''; input.value = ''; });
    const go = document.getElementById('master-go');
    go.addEventListener('click', () => guard(async () => {
      go.disabled = true;
      go.textContent = 'Copying…';
      const res = await state.store.importMaster(file.name, payload);
      input.value = '';
      if (file.upload) await markUploadSeen(file.upload);
      out.innerHTML = `<div class="card good-card"><b>Done.</b> ${plural(res.sales_new, 'new bill')}, ${res.sales_updated} refreshed, ${plural(res.payments, 'payment')}, ${plural(res.customers_new, 'new customer')}, ${plural(res.pos_new, 'new PO')}${res.pos_updated ? `, ${res.pos_updated} PO${res.pos_updated === 1 ? '' : 's'} changed` : ''}${res.pos_removed ? `, ${plural(res.pos_removed, 'PO')} removed` : ''}, ${plural(res.opening, 'opening balance')}, ${plural(res.groups, 'bulk ledger')}.
        ${res.app_payments_in_excel || res.app_payments_open ? `<p>Payments app: ${plural(res.app_payments_in_excel || 0, 'payment')} now in Master Paid (the app's copy was dropped)${res.app_payments_open ? `, ${res.app_payments_open} still waiting for Excel` : ''}.</p>` : ''}
        <p><a href="#/">Home →</a> · <a href="#/pos">PO lists →</a></p></div>`;
      toast('Master Ledger copied.');
    }).finally(() => { go.disabled = false; }));
  } catch (err) {
    out.innerHTML = errorHtml(err);
  }
}

// ---------------------------------------------------------------------------
// PO lists
// ---------------------------------------------------------------------------
async function viewPos() {
  const groups = poGroups(await state.store.poData());
  if (!groups.length) {
    setMain('<section class="card"><h2>PO lists</h2><p>No bulk ledgers with POs yet. <a href="#/import">Upload the Master Ledger</a> to bring in your *_Bulk sheets.</p></section>');
    return;
  }
  setMain(`<section class="card"><h2>PO lists</h2>
    <p class="muted">Each diesel bill takes the first PO in its list that still has enough litres left — the same rule as your Bulk sheets.</p>
    <div class="grid">${groups.map(poCard).join('')}</div></section>`);
}

async function viewPoGroup(code) {
  const groups = poGroups(await state.store.poData(code));
  const g = groups[0];
  if (!g) {
    setMain(`<section class="card"><p>No PO list called “${esc(code)}”. <a href="#/pos">Back to PO lists</a></p></section>`);
    return;
  }
  const units = g.group.kind === 'po_units' ? g.group.units : [];
  const filters = [['all', 'All'], ...(g.rows.some((r) => r.how === 'choose') ? [['choose', 'Pick a PO']] : []), ['no-po', 'No PO'], ...(units.length ? [['needs-unit', 'Needs unit']] : []), ['fixed', 'Typed PO'],
    ...(g.rows.some((r) => r.how === 'not-diesel') ? [['not-diesel', 'Petrol / XG without PO']] : [])];
  const f = filters.some(([k]) => k === state.billFilter) ? state.billFilter : 'all';
  let rows = [...g.rows].reverse();
  if (f !== 'all') rows = rows.filter((r) => r.how === f);
  const shown = state.showAllBills ? rows : rows.slice(0, 60);

  setMain(`
    <p><a href="#/pos">← PO lists</a></p>
    <section class="card">
      <h2>${esc(groupName(g.group, g.members))}</h2>
      <p class="muted">${esc(g.group.code)}${g.members.length > 1 ? ` · ${g.members.map((m) => esc(m.name)).join(', ')}` : ''}${g.group.period_from ? ` · bills from ${fmtDate(g.group.period_from)}` : ''}</p>
      <p class="muted small">${g.group.po_rule === 'pick'
    ? 'As the sheet\'s PO No. formula: a diesel bill gets a PO by itself when only one PO has enough litres left; when more than one has, you pick one (Excel shows “Select PO ▼”); a PO picked or typed on the sheet comes in with the upload.'
    : 'As the sheet\'s PO No. formula: a diesel bill gets the first PO in the list with enough litres left.'}</p>
      ${g.toPick ? `<p class="warn-text">${plural(g.toPick, 'bill')} to pick a PO for — more than one PO has enough litres left. Pick one on each bill below (or in Excel's “Select PO ▼” and upload).</p>` : ''}
      ${g.noPo ? `<p class="warn-text">${plural(g.noPo, 'bill')} got no PO because no PO has enough litres left. Add a new PO below and they're assigned straight away.</p>` : ''}
      ${g.needsUnit ? `<p class="warn-text">${plural(g.needsUnit, 'bill')} need a unit before they can get a PO.</p>` : ''}
    </section>
    ${g.registers.map((r) => registerCard(g, r)).join('')}
    <section class="card">
      <h3>Add a PO</h3>
      <p class="muted small">The Master Ledger is the source of truth for PO lists: the next <b>Upload Master Ledger</b> replaces this list with the *_Bulk sheet's — so add a PO to the sheet too, or it goes at the next upload.</p>
      <form id="po-add" class="row-form">
        <label>PO number <input name="po_no" required autocomplete="off"></label>
        <label>Allotted litres <input name="allotted" type="number" min="0" step="any" required inputmode="decimal"></label>
        ${units.length ? `<label>Unit <select name="unit">${units.map((u) => `<option>${esc(u)}</option>`).join('')}</select></label>` : ''}
        <button class="btn" type="submit">Add PO</button>
      </form>
      <p class="muted small">New POs go to the end of the list.${g.group.po_rule === 'pick' ? '' : ' Bills use POs in list order, so move a PO up to have it used first.'}</p>
    </section>
    <section class="card">
      <h3>Bills <span class="muted">(newest first)</span></h3>
      <p class="muted small">Diesel bills get a PO as the sheet's formula gives it. Petrol and XtraGreen bills keep the PO typed on the Bulk sheet, or the one you pick with <b>Change</b> — and those litres count against that PO.</p>
      <div class="chips">${filters.map(([k, name]) => `<button class="chip ${k === f ? 'on' : ''}" data-filter="${k}">${name}${k === 'all' ? '' : ` · ${g.rows.filter((x) => x.how === k).length}`}</button>`).join('')}</div>
      ${shown.length ? `<div class="bills ${units.length ? 'units' : ''}" role="table" aria-label="Diesel bills">
        <div class="bill head" role="row"><span role="columnheader">Date · Bill</span><span role="columnheader">Vehicle</span><span class="r" role="columnheader">Litres</span>${units.length ? '<span role="columnheader">Unit</span>' : ''}<span role="columnheader">PO</span><span role="columnheader"><span class="sr">Change</span></span></div>
        ${shown.map((b) => billRow(b, g, units)).join('')}</div>` : '<p class="muted">No bills here.</p>'}
      ${rows.length > shown.length ? `<p><button class="btn ghost small" id="all-bills">Show all ${rows.length}</button></p>` : ''}
    </section>`);

  const reload = () => viewPoGroup(code);
  document.getElementById('po-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    guard(async () => {
      await state.store.savePo({ group_code: code, unit: form.unit ? form.unit.value : '', po_no: form.po_no.value, allotted: form.allotted.value });
      toast(`PO ${form.po_no.value.trim()} added.`);
      await reload();
    });
  });
  main().querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    state.billFilter = b.dataset.filter;
    state.showAllBills = false;
    reload();
  }));
  const all = document.getElementById('all-bills');
  if (all) all.addEventListener('click', () => { state.showAllBills = true; reload(); });
  main().querySelectorAll('[data-po-action]').forEach((btn) => btn.addEventListener('click', () => poAction(btn, g, reload)));
  main().querySelectorAll('[data-po-sort]').forEach((btn) => btn.addEventListener('click', () => {
    state.poSort = btn.dataset.poSort;
    try { localStorage.setItem('ledger-po-sort', state.poSort); } catch { /* private mode: just this visit */ }
    guard(reload);
  }));
  main().querySelectorAll('select[data-unit]').forEach((sel) => sel.addEventListener('change', () => guard(async () => {
    await state.store.updateBill(Number(sel.dataset.unit), { unit: sel.value });
    await reload();
  })));
  main().querySelectorAll('[data-bill-po]').forEach((btn) => btn.addEventListener('click', () => editBillPo(btn, g, units, reload)));
  // "Select PO ▼": one tap on the PO to use
  main().querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => guard(async () => {
    await state.store.updateBill(Number(btn.dataset.pick), { po_mode: 'fixed', po_fixed: btn.dataset.po });
    toast(`PO ${btn.dataset.po} picked.`);
    await reload();
  })));
}

// How PO lists are shown: 'no' — by PO number, Z→A (PO-10 above PO-9);
// 'left' — most litres left first, then Z→A. # is still the order the bills
// use them in (the first PO with litres left), which ↑ / ↓ change.
const poNoDesc = (a, b) => String(b.po_no).localeCompare(String(a.po_no), 'en', { numeric: true, sensitivity: 'base' });
function poSort() {
  if (!state.poSort) {
    try { state.poSort = localStorage.getItem('ledger-po-sort') === 'left' ? 'left' : 'no'; } catch { state.poSort = 'no'; }
  }
  return state.poSort;
}
const sortedPos = (pos, how = poSort()) => pos.map((p, i) => ({ p, i }))
  .sort((a, b) => (how === 'left' ? (Number(b.p.balance) || 0) - (Number(a.p.balance) || 0) : 0) || poNoDesc(a.p, b.p));

function registerCard(g, r) {
  const pending = r.pos.filter((p) => p.status === 'Pending');
  return `<section class="card">
    <div class="row-between"><h3>${r.unit ? `${esc(r.unit)} — ` : ''}PO list <span class="muted">· ${pending.length ? `${plural(pending.length, 'open PO')}, ${fmtLitres(pending.reduce((a, p) => a + p.balance, 0))} L left` : 'nothing left'}</span></h3>
      ${r.pos.length > 1 ? `<div class="chips small-chips" role="group" aria-label="Sort POs">${[['no', 'PO no. Z→A'], ['left', 'Litres left']].map(([k, n]) => `<button class="chip ${poSort() === k ? 'on' : ''}" data-po-sort="${k}" aria-pressed="${poSort() === k}">${n}</button>`).join('')}</div>` : ''}</div>
    ${r.pos.length ? `<div class="plist" role="table" aria-label="${r.unit ? `${esc(r.unit)} ` : ''}PO list">
      <div class="prow head" role="row"><span role="columnheader">#</span><span role="columnheader">PO number</span><span class="r" role="columnheader">Allotted</span><span class="r" role="columnheader">Used</span><span class="r" role="columnheader">Left</span><span role="columnheader">Status</span><span role="columnheader"><span class="sr">Actions</span></span></div>
      ${sortedPos(r.pos).map(({ p, i }) => `<div class="prow" role="row" data-po-row="${p.id}">
        <span class="p-n" role="cell" title="Bills use the POs in this order">${i + 1}</span>
        <span class="p-no" role="cell"><b>${esc(p.po_no)}</b></span>
        <span class="p-al r" role="cell"><span class="lbl-sm">Allotted </span>${fmtLitres(p.allotted)}</span>
        <span class="p-us r" role="cell"><span class="lbl-sm">Used </span>${fmtLitres(p.used)}</span>
        <span class="p-le r" role="cell"><span class="lbl-sm">Left </span><b>${fmtLitres(p.balance)}</b></span>
        <span class="p-st" role="cell"><span class="pill ${p.status === 'Pending' ? 'good-pill' : 'muted-pill'}">${p.status === 'Pending' ? 'Open' : 'Used up'}</span></span>
        <span class="p-act nowrap" role="cell">
          <button class="icon" title="Use earlier (order #${i})" aria-label="Use ${esc(p.po_no)} earlier" data-po-action="up" data-id="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon" title="Use later (order #${i + 2})" aria-label="Use ${esc(p.po_no)} later" data-po-action="down" data-id="${p.id}" ${i === r.pos.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon" title="Edit" aria-label="Edit ${esc(p.po_no)}" data-po-action="edit" data-id="${p.id}">✎</button>
          <button class="icon" title="Delete" aria-label="Delete ${esc(p.po_no)}" data-po-action="delete" data-id="${p.id}">✕</button>
        </span></div>`).join('')}</div>` : '<p class="muted">No POs in this list yet.</p>'}
  </section>`;
}

async function poAction(btn, g, reload) {
  const id = Number(btn.dataset.id);
  const po = g.pos.find((p) => p.id === id);
  const act = btn.dataset.poAction;
  if (act === 'up' || act === 'down') {
    await guard(() => state.store.movePo(id, act === 'up' ? -1 : 1));
    return reload();
  }
  if (act === 'delete') {
    const used = g.rows.filter((r) => poKey(r.po) === poKey(po.po_no)).length;
    const ok = window.confirm(`Delete PO ${po.po_no}?${used ? `\n\n${plural(used, 'bill')} use it now; they'll move to the next PO with enough litres (or show "no PO").` : ''}`);
    if (!ok) return undefined;
    await guard(() => state.store.deletePo(id));
    toast(`PO ${po.po_no} deleted.`);
    return reload();
  }
  // edit in place
  const row = main().querySelector(`[data-po-row="${id}"]`);
  row.className = 'prow editing';
  row.innerHTML = `<form class="row-form" data-edit-po>
    <label>PO number <input name="po_no" value="${esc(po.po_no)}" required></label>
    <label>Allotted litres <input name="allotted" type="number" min="0" step="any" value="${esc(po.allotted)}" required></label>
    <button class="btn small" type="submit">Save</button> <button class="btn ghost small" type="button" data-cancel>Cancel</button></form>`;
  row.querySelector('[data-cancel]').addEventListener('click', reload);
  row.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => {
      await state.store.savePo({ id, po_no: e.target.po_no.value, allotted: e.target.allotted.value });
      toast('PO saved.');
      await reload();
    });
  });
  return undefined;
}

const HOW = {
  auto: ['auto', 'good-pill', 'Given automatically: first PO with enough litres left'],
  fixed: ['typed', 'info-pill', 'Typed in (kept as it is)'],
  choose: ['pick a PO', 'warn-pill', 'More than one PO has enough litres left — pick one (Excel shows “Select PO ▼”)'],
  'no-po': ['no PO', 'bad-pill', 'No PO has enough litres left'],
  'needs-unit': ['needs unit', 'warn-pill', 'Pick a unit first'],
  'not-diesel': ['no PO', 'muted-pill', 'Petrol / XtraGreen bills only get a PO you pick with Change'],
};
const FUEL_TAG = { MS: 'Petrol', XG: 'XtraGreen' };

function billRow(b, g, units) {
  const [tag, cls, title] = b.how === 'auto' && g.group.po_rule === 'pick'
    ? ['auto', 'good-pill', 'Given automatically: the only PO with enough litres left'] : HOW[b.how];
  const pick = b.how === 'choose' && b.choices
    ? `<span class="b-pick">${b.choices.map((po) => `<button class="btn ghost small" data-pick="${b.id}" data-po="${esc(po)}" title="Use PO ${esc(po)} for bill ${esc(b.bill_no)}">${esc(po)}</button>`).join('')}</span>` : '';
  return `<div class="bill" role="row">
    <span class="b-when" role="cell">${fmtDate(b.date)} · <b>${esc(b.bill_no)}</b>${FUEL_TAG[b.product] ? ` <span class="pill fuel-pill">${FUEL_TAG[b.product]}</span>` : ''}</span>
    <span class="b-veh" role="cell">${esc(b.vehicle)}</span>
    <span class="b-qty r" role="cell">${fmtLitres(b.qty)} L</span>
    ${units.length ? `<span class="b-unit" role="cell"><select data-unit="${b.id}" aria-label="Unit for bill ${esc(b.bill_no)}"><option value="">Unit —</option>${units.map((u) => `<option value="${esc(u)}" ${poKey(b.unit) === poKey(u) ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></span>` : ''}
    <span class="b-po" role="cell"><b>${esc(b.po) || '—'}</b> <span class="pill ${cls}" title="${esc(title)}">${tag}</span>${pick}</span>
    <span class="b-act" role="cell"><button class="btn ghost small" data-bill-po="${b.id}" aria-label="Change the PO of bill ${esc(b.bill_no)}">Change</button></span>
  </div>`;
}

function editBillPo(btn, g, units, reload) {
  const b = g.rows.find((r) => r.id === Number(btn.dataset.billPo));
  const row = btn.closest('.bill');
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('bill-editor')) return;
  // the POs that fit this bill first, then the other POs with litres left (Excel's drop-down), then the rest
  const pending = g.registers.flatMap((r) => r.pos.filter((p) => p.balance > 0).map((p) => p.po_no));
  const names = [...new Set([...(b.choices || []), ...pending, ...g.pos.map((p) => p.po_no)])];
  const current = b.po_mode === 'fixed' ? b.po_fixed : '';
  row.insertAdjacentHTML('afterend', `<div class="bill-editor">
    <form class="stack" data-bill-form>
      <b>PO for bill ${esc(b.bill_no)} (${fmtLitres(b.qty)} L)</b>
      <label class="radio"><input type="radio" name="mode" value="auto" ${b.po_mode !== 'fixed' ? 'checked' : ''}> ${b.product && b.product !== 'HSD' ? 'Automatic — petrol / XtraGreen bills get no PO automatically' : g.group.po_rule === 'pick' ? 'As the sheet — the PO when only one has enough litres left, else you pick' : 'Automatic — first PO with enough litres left'}</label>
      <label class="radio"><input type="radio" name="mode" value="fixed" ${b.po_mode === 'fixed' && current ? 'checked' : ''}> This PO:
        <input name="po" list="po-names-${b.id}" value="${esc(current)}" autocomplete="off" aria-label="PO number for bill ${esc(b.bill_no)}"></label>
      <datalist id="po-names-${b.id}">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label class="radio"><input type="radio" name="mode" value="none" ${b.po_mode === 'fixed' && !current ? 'checked' : ''}> No PO on this bill</label>
      <p><button class="btn small" type="submit">Save</button> <button class="btn ghost small" type="button" data-cancel>Cancel</button></p>
    </form></div>`);
  const editor = row.nextElementSibling;
  editor.querySelector('input[name=po]').addEventListener('focus', () => { editor.querySelector('input[value=fixed]').checked = true; });
  editor.querySelector('[data-cancel]').addEventListener('click', () => editor.remove());
  editor.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = e.target.mode.value;
    const po = e.target.po.value.trim();
    if (mode === 'fixed' && !po) {
      toast('Type or pick the PO number.', 'bad');
      return;
    }
    const patch = mode === 'auto' ? { po_mode: 'auto' } : { po_mode: 'fixed', po_fixed: mode === 'none' ? '' : po };
    guard(async () => {
      await state.store.updateBill(b.id, patch);
      toast(`Bill ${b.bill_no} updated.`);
      await reload();
    });
  });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
async function viewCustomers() {
  const list = await state.store.customers();
  const isNew = (c) => !c.archived && !c.ledger && !c.bulk_group && !c.no_ledger;
  const tabs = [
    ['new', 'Need a ledger name', list.filter(isNew).length],
    ['all', 'All', list.filter((c) => !c.archived).length],
    ['bulk', 'Bulk', list.filter((c) => !c.archived && c.bulk_group).length],
    ['archived', 'Archived', list.filter((c) => c.archived).length],
  ];
  let tab = state.customersFilter;
  if (tab === 'new' && !tabs[0][2]) tab = 'all';
  const q = normKey(state.customersQuery);
  const shown = list.filter((c) => {
    if (tab === 'new' && !isNew(c)) return false;
    if (tab === 'all' && c.archived) return false;
    if (tab === 'bulk' && (c.archived || !c.bulk_group)) return false;
    if (tab === 'archived' && !c.archived) return false;
    return !q || normKey(`${c.name} ${c.ledger || ''} ${c.gstin} ${c.bulk_group || ''}`).includes(q);
  });
  setMain(`
    <section class="card">
      <h2>Customers</h2>
      <p class="muted">Replaces the Yesterday New Ledger / Bulk Add / Bulk Delete buttons: every customer's ledger is kept automatically; new names from a DayBook just need a short ledger name.</p>
      <div class="chips">${tabs.map(([k, name, n]) => `<button class="chip ${k === tab ? 'on' : ''}" data-tab-filter="${k}">${name} · ${n}</button>`).join('')}</div>
      <input type="search" id="cust-q" placeholder="Search name, ledger or GSTIN" value="${esc(state.customersQuery)}" aria-label="Search customers">
    </section>
    <section class="card">
      ${shown.length ? `<div class="cust-list">${shown.map((c) => customerRow(c, isNew(c))).join('')}</div>` : '<p class="muted">No customers here.</p>'}
    </section>`);
  main().querySelectorAll('[data-tab-filter]').forEach((b) => b.addEventListener('click', () => {
    state.customersFilter = b.dataset.tabFilter;
    viewCustomers();
  }));
  const search = document.getElementById('cust-q');
  search.addEventListener('input', debounce(() => {
    state.customersQuery = search.value;
    viewCustomers().then(() => {
      const s = document.getElementById('cust-q');
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    });
  }, 250));
  main().querySelectorAll('form[data-ledger]').forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = Number(form.dataset.ledger);
    const value = form.ledger.value.trim();
    if (!value) {
      toast('Type a ledger name.', 'bad');
      return;
    }
    guard(async () => {
      await state.store.updateCustomer(id, { ledger: value, no_ledger: false });
      toast(`Ledger name saved: ${value}`);
      await viewCustomers();
    });
  }));
  main().querySelectorAll('[data-cust-action]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const id = Number(b.dataset.id);
    const act = b.dataset.custAction;
    if (act === 'no-ledger') await state.store.updateCustomer(id, { no_ledger: true });
    if (act === 'archive') await state.store.updateCustomer(id, { archived: true });
    if (act === 'unarchive') await state.store.updateCustomer(id, { archived: false });
    if (act === 'needs-ledger') await state.store.updateCustomer(id, { no_ledger: false });
    await viewCustomers();
  })));
}

function customerRow(c, isNew) {
  const tag = c.bulk_group
    ? `<span class="pill info-pill">bulk · ${esc(c.bulk_group)}</span>`
    : c.ledger ? `<span class="pill good-pill">ledger · ${esc(c.ledger)}</span>`
      : c.no_ledger ? '<span class="pill muted-pill">no ledger</span>' : '<span class="pill warn-pill">needs a ledger name</span>';
  return `<div class="cust ${isNew ? 'new' : ''}">
    <div class="cust-head"><b>${esc(c.name)}</b> ${tag}${c.archived ? ' <span class="pill muted-pill">archived</span>' : ''}</div>
    <div class="muted small">${c.bills ? `${plural(c.bills, 'bill')} · ${fmtDate(c.first_sale)} – ${fmtDate(c.last_sale)}` : 'no bills'}${c.gstin ? ` · GSTIN ${esc(c.gstin)}` : ''}</div>
    ${isNew ? `<form class="row-form" data-ledger="${c.id}">
        <label>Ledger name <input name="ledger" value="${esc(suggestLedgerName(c.name))}" maxlength="60"></label>
        <button class="btn small" type="submit">Save</button>
        <button class="btn ghost small" type="button" data-cust-action="no-ledger" data-id="${c.id}">No ledger needed</button>
      </form>` : `<div class="cust-actions">
        ${!c.bulk_group && !c.archived ? `<form class="row-form inline" data-ledger="${c.id}"><label class="sr">Ledger name</label><input name="ledger" value="${esc(c.ledger || '')}" placeholder="Ledger name" aria-label="Ledger name for ${esc(c.name)}" maxlength="60"><button class="btn ghost small" type="submit">Rename</button></form>` : ''}
        ${c.no_ledger ? `<button class="btn ghost small" data-cust-action="needs-ledger" data-id="${c.id}">Give it a ledger</button>` : ''}
        ${c.archived ? `<button class="btn ghost small" data-cust-action="unarchive" data-id="${c.id}">Bring back</button>` : `<button class="btn ghost small" data-cust-action="archive" data-id="${c.id}" title="Hide the ledger; sales and payments are kept">Archive</button>`}
      </div>`}
  </div>`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// Sales (one day)
// ---------------------------------------------------------------------------
async function viewSales(date) {
  const day = await state.store.salesDay(date);
  if (!day.date) {
    setMain('<section class="card"><h2>Sales</h2><p>No sales yet. <a href="#/import">Import a DayBook or upload the Master Ledger.</a></p></section>');
    return;
  }
  const byP = {};
  for (const b of day.bills) {
    const x = byP[b.product] || (byP[b.product] = { bills: 0, qty: 0, amount: 0 });
    x.bills += 1;
    x.qty += Number(b.qty) || 0;
    x.amount += Number(b.amount) || 0;
  }
  const dates = day.dates.includes(day.date) ? day.dates : [day.date, ...day.dates];
  setMain(`
    <section class="card">
      <div class="row-between"><h2>Sales · ${fmtDate(day.date)}</h2>
        <label class="inline-label">Day <select id="sales-day">${dates.map((d) => `<option value="${d}" ${d === day.date ? 'selected' : ''}>${fmtDate(d)}</option>`).join('')}</select></label></div>
      <div class="stats">${Object.entries(byP).map(([p, x]) => `<div><span class="num">${x.bills}</span><span class="lbl">${PRODUCT[p]} · ${p === 'OTHER' ? '' : `${fmtLitres(x.qty)} L · `}${fmtMoney(x.amount)}</span></div>`).join('')}</div>
    </section>
    <section class="card">${salesTable(day.bills.map((b) => ({ ...b, sale_date: day.date })))}</section>`);
  document.getElementById('sales-day').addEventListener('change', (e) => { location.hash = `#/sales/${e.target.value}`; });
}

// ---------------------------------------------------------------------------
// Bills: Daily Tanker Bill (Module8) and Print Bills (Module7)
// ---------------------------------------------------------------------------
const IMAGES = { letterhead: 'assets/letterhead.png', stamp: 'assets/stamp.png' };
const DEFAULT_SLIP_HEADER = { title: 'CREDIT MEMO', mobile: '', lines: ['VRIDDHI FUELS'] };

function yesterday() {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const rangeName = (from, to) => (from === to ? dmyDash(from) : `${dmyDash(from)} to ${dmyDash(to)}`);
const dmyDash = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

async function viewBills() {
  const [tanker, customers, stamp, header, company] = await Promise.all([state.store.tankerList(), state.store.customers(),
    state.store.setting('slip_stamp'), state.store.setting('slip_header'), state.store.setting('slip_company')]);
  const y = state.billDates || { from: yesterday(), to: yesterday() };
  const dates = (id) => `<label>From <input type="date" name="from" value="${y.from}" required></label>
    <label>To <input type="date" name="to" value="${y.to}" required></label>`;
  setMain(`
    <section class="card">
      <h2>Daily Tanker Bill</h2>
      <p class="muted">Same as the <b>Daily Tanker Bill</b> button: one bill per HSD sale to a Tanker Master customer, with its PO from the Bulk sheets. One PDF per group per day — ESM, SMC Unit 1 / 2, OMPL, SMEL — and one per customer per day for everyone else.</p>
      ${tanker.length ? '' : '<p class="warn-text">No Tanker Master yet — upload the Master Ledger (Import) to bring it in.</p>'}
      <form class="row-form" id="tanker-form">${dates('t')}
        <label>Customer contains <input name="filter" placeholder="blank = all" autocomplete="off"></label>
        <button class="btn" type="submit" ${tanker.length ? '' : 'disabled'}>Prepare bills</button></form>
      <div id="tanker-out"></div>
    </section>
    <section class="card">
      <h2>Print Bills — fuel slips</h2>
      <p class="muted">Same as the <b>Print Bills</b> button on the HSD Bill sheet: every HSD, MS and XG bill in the range as an A5 credit memo, one PDF per customer (“&lt;Customer&gt; Slips &lt;date&gt;”).</p>
      <form class="row-form" id="slip-form">${dates('s')}
        <label>Customer <input name="filter" list="slip-customers" placeholder="blank = all" autocomplete="off"></label>
        <datalist id="slip-customers">${customers.filter((c) => !c.archived).map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
        <button class="btn" type="submit">Prepare slips</button></form>
      ${stampRow(stamp, 'stamp-file', 'stamp-remove', 'slips')}
      ${companyForm(header, company)}
      <div id="slip-out"></div>
    </section>
    <section class="card">
      <details><summary>Tanker Master · ${plural(tanker.length, 'company', 'companies')} (from the last Master Ledger upload)</summary>
        <div class="table-wrap"><table class="compact"><thead><tr><th>Company</th><th>Address</th><th class="r">HSD rate</th><th>Price tier</th></tr></thead>
        <tbody>${tanker.map((t) => `<tr><td>${esc(t.company)}</td><td class="small muted">${(t.address || []).filter(Boolean).map(esc).join(' · ')}</td><td class="r">${t.hsd_rate != null ? Number(t.hsd_rate).toFixed(2) : ''}</td><td>${esc(t.price_tier)}</td></tr>`).join('')}</tbody></table></div>
      </details>
    </section>`);
  const read = (form) => {
    const from = form.from.value;
    const to = form.to.value;
    if (!from || !to || to < from) throw new Error('Pick a From date on or before the To date.');
    state.billDates = { from, to };
    return { from, to, filter: form.filter.value.trim() };
  };
  document.getElementById('tanker-form').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => prepareTanker(read(e.target), tanker));
  });
  document.getElementById('slip-form').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => prepareSlips(read(e.target)));
  });
  bindStamp('slip_stamp', 'stamp-file', 'stamp-remove', viewBills);
  bindCompany(viewBills);
}

// The company name on the fuel slips. The HSD Bill sheet's heading starts
// with the Tally company name, financial year and all ("VRIDDHI FUELS
// (2026-27)"); a name saved here replaces it on every slip — kept across
// Master Ledger uploads — with each bill's own financial year after it when
// the box is ticked.
function companyForm(header, company) {
  const sheet = String((header && header.lines && header.lines[0]) || '').trim();
  const now = company && company.name ? company : splitCompany(sheet || DEFAULT_SLIP_HEADER.lines[0]);
  return `<form class="row-form company-form" id="company-form">
      <label>Company name on the slips <input name="name" value="${esc(now.name)}" required autocomplete="off"></label>
      <label class="radio"><input type="checkbox" name="fy" ${now.fy ? 'checked' : ''}> Add the bill's financial year</label>
      <button class="btn ghost small" type="submit">Save name</button>
      ${company ? '<button class="btn ghost small" type="button" id="company-reset">Use the Master Ledger\'s heading</button>' : ''}
    </form>
    <p class="muted small" id="company-preview">${companyPreview(now)}</p>
    <p class="muted small">${company
    ? 'Saved in the app — Master Ledger uploads don\'t change it.'
    : `Now from the HSD Bill sheet${sheet ? ` (“${esc(sheet)}”)` : ''}. Save a name here to change it without re-uploading; it stays across uploads.`}</p>`;
}

function companyPreview({ name, fy }) {
  name = String(name || '').trim();
  if (!name) return 'Type the company name.';
  if (!fy) return `Every slip prints “${esc(name)}”.`;
  const today = todayIso();
  const thisFy = fyOf(today);
  const nextFy = fyOf(`${Number(thisFy.slice(0, 4)) + 1}-04-01`);
  return `Slips print “${esc(name)} (${thisFy})” for this year's bills and “${esc(name)} (${nextFy})” from 1 April ${Number(thisFy.slice(0, 4)) + 1} — each bill's own financial year.`;
}

function bindCompany(reload) {
  const form = document.getElementById('company-form');
  const value = () => {
    const fy = form.fy.checked;
    // with the year added automatically, a year typed at the end is dropped
    const name = fy ? splitCompany(form.name.value).name : form.name.value.trim();
    return { name, fy };
  };
  form.addEventListener('input', () => { document.getElementById('company-preview').innerHTML = companyPreview(value()); });
  const save = (v, msg) => guard(async () => {
    try {
      await state.store.setSetting('slip_company', v);
    } catch (err) {
      if (/unknown setting/i.test(err.message || '')) {
        throw new Error('The database needs an update for this: run supabase/ledger-schema.sql again in the Supabase SQL Editor (safe to re-run).');
      }
      throw err;
    }
    toast(msg);
    await reload();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = value();
    if (!v.name) { toast('Type the company name.', 'bad'); return; }
    save(v, 'Company name saved — every slip uses it now.');
  });
  document.getElementById('company-reset')?.addEventListener('click', () => save(null, 'Slips use the Master Ledger\'s heading again.'));
}

// Stamp pictures (slip_stamp, statement_stamp) are kept in the database.
function bindStamp(key, inputId, removeId, reload) {
  document.getElementById(inputId).addEventListener('change', (e) => guard(async () => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 500000) throw new Error('That picture is too big — keep it under 500 KB.');
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('Couldn\'t read that file.'));
      fr.readAsDataURL(file);
    });
    await state.store.setSetting(key, { data_url: dataUrl, name: file.name });
    toast('Stamp saved.');
    await reload();
  }));
  document.getElementById(removeId)?.addEventListener('click', () => guard(async () => {
    await state.store.setSetting(key, null);
    toast('Stamp removed.');
    await reload();
  }));
}

function stampRow(stamp, inputId, removeId, what) {
  return `<div class="stamp-row">
    ${stamp ? `<img src="${esc(stamp.data_url)}" alt="Stamp printed on the ${what}" class="stamp-thumb">` : `<span class="muted small">No stamp yet — ${what} are made without one.</span>`}
    <label class="file"><input type="file" id="${inputId}" accept="image/png,image/jpeg"><span class="btn ghost small">${stamp ? 'Change stamp' : 'Upload stamp'}</span></label>
    ${stamp ? `<button class="btn ghost small" id="${removeId}">Remove</button>` : ''}
    <span class="muted small">Kept in your private database, not on the website.</span>
  </div>`;
}

async function prepareTanker({ from, to, filter }, tanker) {
  const out = document.getElementById('tanker-out');
  out.innerHTML = loadingHtml('Finding bills…');
  const [sales, pod] = await Promise.all([state.store.salesRange(from, to), state.store.poData()]);
  const poById = new Map();
  poGroups(pod).forEach((g) => g.rows.forEach((r) => poById.set(r.id, r.po)));
  const lakhanpur = new Set(pod.members.filter((m) => /lakhanpur/i.test(m.group || '')).map((m) => normalizeCompany(m.name)));
  const res = tankerBundles({ sales, tanker, poOf: (s) => poById.get(s.id) || '', lakhanpur, from, to, filter });
  const range = `${rangeName(from, to)}${filter ? ` · customer like “${esc(filter)}”` : ''}`;
  if (!res.inRange) {
    out.innerHTML = `<p class="warn-text">No HSD bills for ${range}.</p>`;
    return;
  }
  const skipped = res.skipped.length
    ? `<details><summary class="warn-text">${plural(res.skipped.reduce((a, x) => a + x.count, 0), 'bill')} skipped — customer not in Tanker Master</summary><ul class="small">${res.skipped.map((x) => `<li>${esc(x.customer)} (${x.count})</li>`).join('')}</ul></details>` : '';
  if (!res.bundles.length) {
    out.innerHTML = `<p class="warn-text">${plural(res.inRange, 'bill')} found for ${range}, but none of their customers are in Tanker Master.</p>${skipped}`;
    return;
  }
  const pages = (b) => b.bills.map((x) => tankerBillSvg(x, x.company, IMAGES));
  renderBundles(out, {
    summary: `<b>${plural(res.bills, 'bill')}</b> in <b>${plural(res.bundles.length, 'PDF')}</b> · ${range}`,
    extra: skipped,
    bundles: res.bundles,
    size: A4,
    zipName: `Tanker Bills ${rangeName(from, to)}.zip`,
    folder: '',
    line: (b) => b.bills.map((x) => `${esc(x.bill_no)} · ${fmtLitres(x.qty)} L${x.po ? ` · PO ${esc(x.po)}` : ''}`).join('<br>'),
    pages,
    pdfPages: async (b) => {
      const imgs = { letterhead: await toDataUrl(IMAGES.letterhead), stamp: await toDataUrl(IMAGES.stamp) };
      return b.bills.map((x) => tankerBillSvg(x, x.company, imgs));
    },
  });
}

async function prepareSlips({ from, to, filter }) {
  const out = document.getElementById('slip-out');
  out.innerHTML = loadingHtml('Finding bills…');
  const [sales, header, stamp, company] = await Promise.all([state.store.salesRange(from, to), state.store.setting('slip_header'),
    state.store.setting('slip_stamp'), state.store.setting('slip_company')]);
  const res = slipBundles({ sales, from, to, filter });
  const range = `${rangeName(from, to)}${filter ? ` · ${esc(filter)}` : ''}`;
  if (!res.bills) {
    out.innerHTML = `<p class="warn-text">No sales bills for ${range}.${filter ? ' Check the spelling of the customer name.' : ''}</p>`;
    return;
  }
  const h = header || DEFAULT_SLIP_HEADER;
  const pages = (b) => b.bills.map((x) => slipSvg(x, slipHeaderFor(h, company, x.sale_date), stamp ? stamp.data_url : ''));
  renderBundles(out, {
    summary: `<b>${plural(res.bills, 'bill')}</b> in <b>${plural(res.bundles.length, 'PDF')}</b> · ${range}`,
    extra: header || company ? '' : '<p class="muted small">The slip heading comes from the HSD Bill sheet — upload the Master Ledger to bring in yours.</p>',
    bundles: res.bundles,
    size: A5,
    zipName: `${res.folder}.zip`,
    folder: res.folder,
    line: (b) => `${plural(b.bills.length, 'bill')}: ${b.bills.slice(0, 6).map((x) => esc(x.bill_no)).join(', ')}${b.bills.length > 6 ? ' …' : ''}`,
    pages,
    pdfPages: async (b) => pages(b),
  });
}

function renderBundles(out, o) {
  out.innerHTML = `
    <div class="preview">
      <p>${o.summary}</p>${o.extra || ''}
      <p class="actions"><button class="btn" data-all="zip">Download all PDFs (.zip)</button>
        <button class="btn ghost" data-all="print">Print all</button></p>
      <div class="bundles">${o.bundles.map((b, i) => `
        <div class="bundle">
          <div class="bundle-head"><b>${esc(b.fileName)}</b><span class="muted small">${plural(b.bills.length, 'page')}</span></div>
          <div class="muted small">${o.line(b)}</div>
          <div class="bundle-actions">
            <button class="btn small" data-pdf="${i}">PDF</button>
            <button class="btn ghost small" data-print="${i}">Print</button>
            <button class="btn ghost small" data-look="${i}">Preview</button>
          </div>
          <div class="pages" data-pages="${i}" hidden></div>
        </div>`).join('')}</div>
    </div>`;
  const busy = async (btn, text, fn) => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };
  const pdfOf = async (b) => pdfFromSvgs(await o.pdfPages(b), o.size, { scale: o.scale || 2 });
  out.querySelectorAll('[data-look]').forEach((btn) => btn.addEventListener('click', () => {
    const box = out.querySelector(`[data-pages="${btn.dataset.look}"]`);
    if (!box.innerHTML) box.innerHTML = o.pages(o.bundles[Number(btn.dataset.look)]).map((svg) => `<div class="page">${svg}</div>`).join('');
    box.hidden = !box.hidden;
    btn.textContent = box.hidden ? 'Preview' : 'Hide';
  }));
  out.querySelectorAll('[data-pdf]').forEach((btn) => btn.addEventListener('click', () => guard(() => busy(btn, 'Making…', async () => {
    const b = o.bundles[Number(btn.dataset.pdf)];
    download(await pdfOf(b), b.fileName);
  }))));
  out.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => printPages(o.pages(o.bundles[Number(btn.dataset.print)]), o.size)));
  out.querySelector('[data-all="print"]').addEventListener('click', () => printPages(o.bundles.flatMap(o.pages), o.size));
  const zipBtn = out.querySelector('[data-all="zip"]');
  zipBtn.addEventListener('click', () => guard(() => busy(zipBtn, 'Making PDFs…', async () => {
    const files = [];
    for (let i = 0; i < o.bundles.length; i++) {
      zipBtn.textContent = `Making PDF ${i + 1} of ${o.bundles.length}…`;
      files.push({ name: o.bundles[i].fileName, blob: await pdfOf(o.bundles[i]) });
    }
    download(await zipBlob(files, o.folder), o.zipName);
    toast(`${plural(files.length, 'PDF')} downloaded.`);
  })));
}

// ---------------------------------------------------------------------------
// Statements (Daily Screenshots / Monthly Export / Custom Date Report)
// ---------------------------------------------------------------------------
const LOGO = 'assets/logo.png';

async function statementImages() {
  const stamp = await state.store.setting('statement_stamp');
  const [logo, letterhead, fontCss, stampInk] = await Promise.all([
    toDataUrl(LOGO), toDataUrl(IMAGES.letterhead), statementFontCss(),
    stamp ? inkBox(stamp.data_url).catch(() => null) : null,
  ]);
  return { logo, letterhead, fontCss, stamp: stamp ? stamp.data_url : '', stampInk };
}

// Statements look like Excel's only with what the Master Ledger upload brings
// for each ledger sheet: say when it's missing.
function missingSheetInfo(customers) {
  const noAddress = customers.filter((c) => !String(c.customer.bill_address || '').trim()).map((c) => c.customer.name);
  const noLayout = customers.filter((c) => !c.customer.layout).length;
  if (!noAddress.length && !noLayout) return '';
  const parts = [];
  if (noAddress.length) parts.push(`no Bill To address for ${noAddress.length > 4 ? plural(noAddress.length, 'customer') : noAddress.map(esc).join(', ')}`);
  if (noLayout) parts.push(`${plural(noLayout, 'ledger')} without the sheet's column widths`);
  return `<p class="warn-text small">${parts.join('; ')} — upload the Master Ledger again (Import) to bring them in.</p>`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function viewStatements() {
  const stamp = await state.store.setting('statement_stamp');
  const s = state.statements || {
    date: yesterday(), month: defaultMonth(todayIso()).slice(0, 7), from: monthStart(yesterday()), to: yesterday(),
  };
  setMain(`
    <section class="card">
      <h2>Daily statements — pictures for WhatsApp</h2>
      <p class="muted">Same as <b>Daily Screenshots</b>: for every ledger customer who bought anything yesterday, a picture of their ledger (month so far) and of that day's bills, plus the HSD and MS daily summaries. Share them all in one go, or one customer at a time.</p>
      <form class="row-form" id="daily-form">
        <p class="day-fixed">For <b>yesterday, ${esc(fmtDate(yesterday()))}</b> <span class="muted small">— like the Excel macro, daily statements are always for yesterday.</span></p>
        <button class="btn" type="submit">Make pictures</button></form>
      <div id="daily-out"></div>
    </section>
    <section class="card">
      <h2>Monthly statements — PDFs</h2>
      <p class="muted">Same as <b>Monthly Export</b>: a ledger PDF (with a TOTAL row) and a bill statement PDF for every ledger customer with diesel, petrol or XtraGreen sales in the month.</p>
      <form class="row-form" id="monthly-form">
        <label>Month <input type="month" name="month" value="${s.month}" required></label>
        <button class="btn" type="submit">Make PDFs</button></form>
      <div id="monthly-out"></div>
    </section>
    <section class="card">
      <h2>Custom date statements — PDFs</h2>
      <p class="muted">Same as <b>Custom Date Report</b>, for any range. The ledger starts from the customer's real balance on the From date.</p>
      <form class="row-form" id="custom-form">
        <label>From <input type="date" name="from" value="${s.from}" required></label>
        <label>To <input type="date" name="to" value="${s.to}" required></label>
        <label>Customer contains <input name="filter" placeholder="blank = all" autocomplete="off"></label>
        <button class="btn" type="submit">Make PDFs</button></form>
      <div id="custom-out"></div>
    </section>
    <section class="card">
      <h2>Stamp on the statements</h2>
      ${stampRow(stamp, 'st-stamp-file', 'st-stamp-remove', 'statements')}
    </section>`);
  const remember = (patch) => { state.statements = { ...s, ...(state.statements || {}), ...patch }; };
  document.getElementById('daily-form').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(() => prepareDaily(yesterday()));                     // the macro's rule: always yesterday
  });
  document.getElementById('monthly-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const month = e.target.month.value;
    if (!month) return;
    remember({ month });
    const from = `${month}-01`;
    guard(() => preparePeriod('monthly', { from, to: monthEnd(from) }, 'monthly-out'));
  });
  document.getElementById('custom-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const { from, to } = { from: e.target.from.value, to: e.target.to.value };
    if (!from || !to || to < from) { toast('Pick a From date on or before the To date.', 'bad'); return; }
    remember({ from, to });
    guard(() => preparePeriod('custom', { from, to, filter: e.target.filter.value.trim() }, 'custom-out'));
  });
  bindStamp('statement_stamp', 'st-stamp-file', 'st-stamp-remove', viewStatements);
}

// The Web Share API needs the files ready before the click, so the pictures
// are made first and the buttons only hand them over. Returns 'shared',
// 'cancelled' or 'downloaded'.
const canShareFiles = (files) => {
  try { return !!(navigator.canShare && navigator.canShare({ files })); } catch { return false; }
};
async function shareOrSave(files, zipName) {
  if (canShareFiles(files)) {
    try {
      await navigator.share({ files });              // pictures only: extra text can make apps drop them
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';     // closed the share sheet
      if (!(err && err.name === 'NotAllowedError')) throw err;
    }
  }
  download(files.length === 1 ? files[0] : await zipBlob(files), files.length === 1 ? files[0].name : zipName);
  toast('This browser can\'t hand pictures to WhatsApp, so they were downloaded instead.');
  return 'downloaded';
}

async function prepareDaily(date) {
  const out = document.getElementById('daily-out');
  out.innerHTML = loadingHtml('Finding sales…');
  const [data, images] = await Promise.all([state.store.statementData(monthStart(date), date), statementImages()]);
  const res = buildStatements({ kind: 'daily', date, data });
  if (!res.customers.length && !res.summaries.length) {
    out.innerHTML = `<p class="warn-text">No sales on ${dmyDash(date)}.</p>`;
    return;
  }
  const items = [
    ...res.customers.map((c) => ({
      title: c.customer.name,
      pages: [{ name: `${c.ledgerFile}.jpeg`, svg: ledgerSvg(c.ledger, images) },
        { name: `${c.billFile}.jpeg`, svg: billStatementSvgs(c.bills, images)[0] }],
      line: `${plural(c.bills.rows.length, 'bill')} · balance ${fmtMoney(c.ledger.closing)}`,
    })),
    ...res.summaries.map((x) => ({
      title: `${x.product === 'HSD' ? 'Diesel' : 'Petrol'} daily summary`,
      pages: [{ name: `${x.file}.jpeg`, svg: dailySummarySvg(x, images) }],
      line: `${plural(x.rows.length, 'customer')} · ${fmtLitres(x.qty)} L · ${fmtMoney(x.amount)}`,
    })),
  ];
  const total = items.reduce((a, it) => a + it.pages.length, 0);
  let done = 0;
  for (const it of items) {
    for (const p of it.pages) {
      out.innerHTML = loadingHtml(`Making picture ${++done} of ${total}…`);
      await paint();
      const blob = await jpegFromSvg(p.svg, PAGE);
      p.file = new File([blob], p.name, { type: 'image/jpeg' });
      p.url = URL.createObjectURL(blob);
    }
  }
  const all = items.flatMap((it) => it.pages.map((p) => p.file));
  const zipName = `${res.folder}.zip`;
  out.innerHTML = `
    <div class="preview">
      <p><b>${plural(total, 'picture')}</b> · ${plural(res.customers.length, 'customer')} · ${dmyDash(date)}${images.stamp ? '' : ' · <span class="warn-text">no stamp yet (upload it below)</span>'}</p>
      ${missingSheetInfo(res.customers)}
      <p class="muted small" data-share-note></p>
      <p class="actions"><button class="btn" data-share-all>Share all on WhatsApp</button>
        <button class="btn ghost" data-zip>Download all (.zip)</button></p>
      <div class="bundles">${items.map((it, i) => `
        <div class="bundle">
          <div class="bundle-head"><b>${esc(it.title)}</b><span class="muted small">${plural(it.pages.length, 'picture')}</span></div>
          <div class="muted small">${esc(it.line)}</div>
          <div class="pages shots">${it.pages.map((p) => `<a class="page" href="${p.url}" target="_blank" rel="noopener" title="${esc(p.name)}"><img src="${p.url}" alt="${esc(p.name)}" loading="lazy"></a>`).join('')}</div>
          <div class="bundle-actions">
            <button class="btn small" data-share="${i}">Share</button>
            <button class="btn ghost small" data-save="${i}">Download</button>
          </div>
        </div>`).join('')}</div>
    </div>`;
  // Android shares up to 10 pictures at a time: "Share all" goes in parts,
  // one tap each, each customer's pictures kept together.
  // ask the phone how many pictures it takes at once (iPhone: all; Android: 10)
  let most = canShareFiles(all) ? all.length : 0;
  for (let n = Math.min(10, all.length - 1); !most && n > 0; n--) if (canShareFiles(all.slice(0, n))) most = n;
  const parts = shareBatches(items.map((it) => it.pages.map((p) => p.file)), { max: most || all.length });
  const shareAll = out.querySelector('[data-share-all]');
  const note = out.querySelector('[data-share-note]');
  let part = 0;
  const label = () => {
    if (parts.length === 1) shareAll.textContent = part ? 'Share again' : 'Share all on WhatsApp';
    else if (part < parts.length) shareAll.textContent = `Share part ${part + 1} of ${parts.length} on WhatsApp`;
    else shareAll.textContent = 'All shared ✓ — share again';
    note.textContent = parts.length > 1
      ? `This phone shares up to ${most} pictures at a time, so they go in ${parts.length} parts (${parts.map((x) => x.length).join(' + ')}). Tap once for each part.`
      : '';
  };
  label();
  shareAll.addEventListener('click', () => guard(async () => {
    if (part >= parts.length) part = 0;
    if (!most) {                                              // no file sharing here at all
      await shareOrSave(all, zipName);
      return;
    }
    const res = await shareOrSave(parts[part], zipName);
    if (res === 'shared') part += 1;
    label();
  }));
  out.querySelector('[data-zip]').addEventListener('click', () => guard(async () => download(await zipBlob(all, res.folder), zipName)));
  out.querySelectorAll('[data-share]').forEach((btn) => btn.addEventListener('click', () => guard(() => {
    const it = items[Number(btn.dataset.share)];
    return shareOrSave(it.pages.map((p) => p.file), `${it.title} ${dmyDash(date)}.zip`);
  })));
  out.querySelectorAll('[data-save]').forEach((btn) => btn.addEventListener('click', () => {
    for (const p of items[Number(btn.dataset.save)].pages) download(p.file, p.name);
  }));
}

async function preparePeriod(kind, { from, to, filter = '' }, outId) {
  const out = document.getElementById(outId);
  out.innerHTML = loadingHtml('Finding sales…');
  const [data, images] = await Promise.all([state.store.statementData(from, to), statementImages()]);
  const res = buildStatements({ kind, from, to, data, filter });
  const what = kind === 'monthly' ? monthLabel(from) : rangeName(from, to);
  if (!res.customers.length) {
    out.innerHTML = `<p class="warn-text">No ledger customer bought diesel, petrol or XtraGreen in ${esc(what)}${filter ? ` matching “${esc(filter)}”` : ''}.</p>`;
    return;
  }
  const bundles = res.customers.flatMap((c) => {
    const bill = billStatementSvgs(c.bills, images);
    return [
      { fileName: `${c.ledgerFile}.pdf`, bills: [1], svgs: [ledgerSvg(c.ledger, images)], line: `Ledger · closing balance ${fmtMoney(c.ledger.closing)}` },
      { fileName: `${c.billFile}.pdf`, bills: bill, svgs: bill, line: `${plural(c.bills.rows.length, 'bill')} · ${fmtMoney(c.bills.totals.amount)}` },
    ];
  });
  const nextMonth = addDays(to, 1);
  const saveBtn = kind === 'monthly'
    ? `<div class="stamp-row"><button class="btn ghost small" data-save-opening>Save closing balances as ${esc(monthLabel(nextMonth))} opening</button>
       <span class="muted small">Like <b>Update Monthly Outstanding</b>: fixes every ledger customer's balance at the end of ${esc(what)} (optional — balances carry forward on their own).</span></div>`
    : '';
  renderBundles(out, {
    summary: `<b>${plural(bundles.length, 'PDF')}</b> for ${plural(res.customers.length, 'customer')} · ${esc(what)}${filter ? ` · “${esc(filter)}”` : ''}${images.stamp ? '' : ' · <span class="warn-text">no stamp yet</span>'}`,
    extra: missingSheetInfo(res.customers) + saveBtn,
    bundles,
    size: PAGE_PT,
    scale: 2.5,
    zipName: `${res.folder}.zip`,
    folder: res.folder,
    line: (b) => esc(b.line),
    pages: (b) => b.svgs,
    pdfPages: async (b) => b.svgs,
  });
  out.querySelector('[data-save-opening]')?.addEventListener('click', (e) => guard(async () => {
    if (!window.confirm(`Save every ledger customer's balance at the end of ${what} as the ${monthLabel(nextMonth)} opening balance?`)) return;
    e.target.disabled = true;
    const r = await state.store.saveOpening(nextMonth);
    toast(`Saved ${plural(r.customers, 'opening balance')} for ${monthLabel(nextMonth)}.`);
  }));
}

// ---------------------------------------------------------------------------
// Payments tab: the /payments app's list, read-only (its own Supabase project)
// ---------------------------------------------------------------------------
const APP_STATE = { ready: 'Ready', queued: 'Queued for Excel', excel: 'In Excel' };
const PAYMENTS_CONFIG = '../payments/config.js';

// A read-only client for the payments app's project, using the same public
// key the payments app itself uses (payments/config.js). Demo: made-up rows.
async function paymentsQueue() {
  if (state.demo) return state.demoPayQueue || [];
  if (!state.payClient) {
    if (!window.VRIDDHI_PAYMENTS_CONFIG) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PAYMENTS_CONFIG;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Couldn\'t load the payments app\'s settings.'));
        document.head.append(s);
      });
    }
    const cfg = window.VRIDDHI_PAYMENTS_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) throw new Error('The payments app isn\'t set up (payments/config.js).');
    const { createClient } = await import(SUPABASE_JS);
    state.payClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'vriddhi-payments-readonly' },
    });
  }
  const { data, error } = await state.payClient.from('pay_credit_queue').select('*')
    .order('date_serial', { ascending: false }).limit(2000);
  if (error) throw new Error(`Couldn't read the payments app: ${error.message}`);
  return data || [];
}

const LEDGER_STATE = {
  new: '<span class="warn-text">Not in ledger</span>',
  logged: '<span class="good-text">In ledger ✓</span>',
  in_excel: '<span class="good-text">In Excel copy ✓</span>',
  discarded: '<span class="faint">Discarded</span>',
};

async function viewPayments() {
  const [queue, appPays] = await Promise.all([paymentsQueue(), state.store.appPaymentsList()]);
  const { payments, review } = fromQueue(queue);
  const checks = payments.length
    ? await state.store.appPaymentsCheck(payments.map(({ ref, pay_date, customer, amount }) => ({ ref, pay_date, customer, amount })))
    : [];
  const byRef = new Map(checks.map((c) => [c.ref, c]));
  const rows = payments.map((r) => ({ ...r, check: byRef.get(r.ref) || { state: 'new', known: true } }));
  const todo = rows.filter((r) => r.check.state === 'new');
  const unknown = [...new Set(todo.filter((r) => !r.check.known).map((r) => r.customer))];
  const discarded = rows.filter((r) => r.check.state === 'discarded');
  const filter = state.payFilter || 'todo';
  const shown = filter === 'todo' ? todo : filter === 'discarded' ? discarded : rows.filter((r) => r.check.state !== 'discarded');
  setMain(`
    ${payTabsHtml('')}
    <section class="card">
      <div class="row-between"><h2>Payments</h2><button class="btn ghost small" id="pay-refresh">↻ Refresh</button></div>
      <p class="muted">The payments app's matched entries, read straight from it — nothing there changes; keep logging to Excel from the payments app as usual. <b>Log payments</b> adds them here so balances and statements are up to date. Excel stays the source of truth: when a Master Ledger upload shows a payment in Master Paid, the ledger's copy is dropped, so nothing counts twice.</p>
      <div class="chips">
        <button class="chip ${filter === 'todo' ? 'on' : ''}" data-pay-filter="todo">Not in ledger · ${todo.length}</button>
        <button class="chip ${filter === 'all' ? 'on' : ''}" data-pay-filter="all">All · ${rows.length - discarded.length}</button>
        ${discarded.length || filter === 'discarded' ? `<button class="chip ${filter === 'discarded' ? 'on' : ''}" data-pay-filter="discarded">Discarded · ${discarded.length}</button>` : ''}
      </div>
      ${review ? `<p class="muted small">${plural(review, 'payment')} still under <b>Needs review</b> in the payments app — they show here once a customer is picked there.</p>` : ''}
      ${unknown.length ? `<p class="warn-text small">Not a customer in the ledger app yet: ${unknown.map(esc).join(', ')} — logged anyway; they show in balances once the customer is in the app.</p>` : ''}
      ${shown.length ? `<form id="pay-form">
        <div class="table-wrap"><table class="compact">
          <thead><tr><th>${filter === 'todo' ? '<input type="checkbox" id="pay-all" checked aria-label="All">' : ''}</th><th>Date</th><th>Customer</th><th class="r">Amount</th><th>Mode</th><th>Payments app</th><th>Ledger</th><th></th></tr></thead>
          <tbody>${shown.map((r) => `<tr>
            <td>${r.check.state === 'new' ? `<input type="checkbox" name="pick" value="${esc(r.ref)}" ${filter === 'todo' ? 'checked' : ''} aria-label="Log ${esc(r.customer)} ${esc(fmtMoney(r.amount))}">` : ''}</td>
            <td>${esc(fmtDate(r.pay_date))}</td><td>${esc(r.customer)}</td><td class="r">${esc(fmtMoney(r.amount))}</td>
            <td>${esc(r.mode)}</td><td>${APP_STATE[r.state]}</td><td>${LEDGER_STATE[r.check.state] || ''}</td>
            <td>${r.check.state === 'discarded' ? `<button type="button" class="btn ghost small" data-restore="${esc(r.ref)}">Restore</button>`
    : r.check.state === 'in_excel' ? '' : `<button type="button" class="btn ghost small" data-discard="${esc(r.ref)}" title="Don't count this one in the ledger (e.g. a test entry). The payments app isn't touched.">Discard</button>`}</td></tr>`).join('')}</tbody>
        </table></div>
        ${filter === 'discarded' ? '' : '<p class="actions"><button class="btn" type="submit">Log payments</button></p>'}
      </form>` : `<p class="muted">${filter === 'todo' ? 'Every matched payment is in the ledger (or discarded). ✓' : filter === 'discarded' ? 'Nothing discarded.' : 'No matched payments in the payments app.'}</p>`}
    </section>
    ${appPaymentsCard(appPays)}`);
  document.getElementById('pay-refresh').addEventListener('click', () => guard(viewPayments));
  document.querySelectorAll('[data-pay-filter]').forEach((b) => b.addEventListener('click', () => {
    state.payFilter = b.dataset.payFilter;
    guard(viewPayments);
  }));
  bindAppPayments(viewPayments);
  document.querySelectorAll('[data-discard]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const r = rows.find((x) => x.ref === b.dataset.discard);
    if (!r) return;
    const note = r.check.state === 'logged' ? ' It is in the ledger now and will be taken out.' : '';
    if (!window.confirm(`Discard ${r.customer} ${fmtMoney(r.amount)} (${fmtDate(r.pay_date)})? The ledger won't count it.${note} The payments app isn't touched, and you can restore it under "Discarded".`)) return;
    await state.store.appPaymentsDiscard({ ref: r.ref, pay_date: r.pay_date, customer: r.customer, amount: r.amount });
    toast('Discarded.');
    await viewPayments();
  })));
  document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    await state.store.appPaymentsRestore(b.dataset.restore);
    toast('Restored — it can be logged again.');
    await viewPayments();
  })));
  const form = document.getElementById('pay-form');
  const btn = form && form.querySelector('button[type=submit]');
  if (!btn) return;                                              // e.g. the Discarded list: nothing to log
  const byKey = new Map(rows.map((r) => [r.ref, r]));
  const picked = () => [...form.querySelectorAll('input[name=pick]:checked')].map((x) => byKey.get(x.value));
  const update = () => {
    const list = picked();
    btn.textContent = list.length ? `Log ${plural(list.length, 'payment')} · ${fmtMoney(list.reduce((a, r) => a + r.amount, 0))}` : 'Log payments';
    btn.disabled = !list.length;
  };
  document.getElementById('pay-all')?.addEventListener('change', (e) => {
    form.querySelectorAll('input[name=pick]').forEach((x) => { x.checked = e.target.checked; });
  });
  form.addEventListener('change', update);
  update();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => {
      const list = picked();
      if (!list.length) return;
      btn.disabled = true;
      btn.textContent = 'Logging…';
      const res = await state.store.appPaymentsLog(list.map(({ ref, pay_date, customer, amount, mode }) => ({ ref, pay_date, customer, amount, mode })));
      toast(`${plural(res.added, 'payment')} logged to the ledger.`);
      await viewPayments();                        // statuses update
    }).finally(() => { if (document.body.contains(btn)) update(); });
  });
}

// Payments: the payments app's entries, and every payment by mode
const PAY_TABS = [['', '#/payments', 'From payments app'], ['modes', '#/payments/modes', 'By mode']];
const payTabsHtml = (tab) => `<nav class="chips view-chips" aria-label="Payments">${PAY_TABS.map(([k, href, name]) => `<a class="chip${k === tab ? ' on' : ''}" href="${href}"${k === tab ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav>`;

// ---------------------------------------------------------------------------
// Payments → By mode: how money came in over a period (Master Paid's Payment
// Mode — HDFC 1010, ICICI Bank Ltd, XtraPower, Cash, …; modes.js). Only the
// modes used in the period: Cash first, XtraPower next, the rest by amount.
// ---------------------------------------------------------------------------
// Cash green, XtraPower orange; the rest none of those
const MODE_COLORS = ['var(--s-hsd)', 'var(--s-sales)', 'var(--s-paid)', '#e86fb4', 'var(--info)', 'var(--bad)', '#b8c96a', '#4fc3d9'];
const modeColor = (m, i) => (m.cash ? 'var(--good)' : m.xtrapower ? 'var(--accent)' : m.key === '' ? 'var(--faint)' : MODE_COLORS[i % MODE_COLORS.length]);

async function viewPaymentModes() {
  const today = localToday();
  const per = periods(today);
  const pm = state.payModes || (state.payModes = { period: 'month', mode: null, all: false });
  const range = pm.period === 'custom' && pm.from && pm.to ? { from: pm.from, to: pm.to } : per[pm.period] || per.month;
  const k = `${range.from}|${range.to}`;
  if (!pm.data || pm.data.k !== k || Date.now() - pm.data.at > 5 * 60000) {
    let rows;
    try {
      rows = await state.store.paymentsRange(range.from, range.to);
    } catch (err) {
      if (/could not find the function|does not exist|schema cache/i.test(String((err && err.message) || err))) {
        throw new Error('The database needs an update for Payments → By mode: run supabase/ledger-schema.sql again in the Supabase SQL Editor (safe to re-run).');
      }
      throw err;
    }
    pm.data = { k, at: Date.now(), rows };
  }
  const sum = modeSummary(pm.data.rows);
  const rest = sum.modes.filter((m) => !m.cash && !m.xtrapower && m.key !== '');
  const colorOf = new Map(sum.modes.map((m) => [m.key, modeColor(m, rest.indexOf(m))]));
  const labelOf = new Map(sum.modes.map((m) => [m.key, m.label]));
  // a mode picked earlier that isn't used in this period: back to all
  const sel = sum.modes.find((m) => m.key === pm.mode) || null;
  const cash = sum.modes.filter((m) => m.cash).reduce((a, m) => a + m.amount, 0);
  const xp = sum.modes.filter((m) => m.xtrapower).reduce((a, m) => a + m.amount, 0);
  const months = monthsIn(range.from, range.to);
  const pct = (v) => `${v >= 0.995 ? Math.round(v * 100) : (v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
  const span = (m) => (m.first === m.last ? fmtDate(m.first) : `${fmtDate(m.first)} – ${fmtDate(m.last)}`);

  const modeRow = (m) => `<li><button class="rank-row${sel && sel.key === m.key ? ' on' : ''}" data-mode="${esc(m.key)}" aria-pressed="${sel && sel.key === m.key}">
      <span class="n"><i class="dot" style="background:${colorOf.get(m.key)}"></i></span>
      <span class="who"><b>${esc(m.label)}</b>
        <small class="muted">${plural(m.count, 'payment')} · ${plural(m.customers, 'customer')} · ${esc(span(m))}${m.split ? ` · ${m.split} part${m.split === 1 ? '' : 's'} of split payments` : ''}${m.refunds ? ` · ${plural(m.refunds, 'refund')}` : ''}</small>
        <span class="mini-track"><span class="mini" style="width:${Math.max(2, m.share * 100)}%"><i style="flex:1;background:${colorOf.get(m.key)}"></i></span></span></span>
      <span class="amt"><b>${money(m.amount, { exact: true })}</b><small>${pct(m.share)} of all</small></span>
    </button></li>`;

  const list = sel ? sel.payments : sum.modes.flatMap((m) => m.payments).sort((a, b) => b.pay_date.localeCompare(a.pay_date) || b.part - a.part);
  const shown = pm.all ? list : list.slice(0, 100);
  const detail = sel ? `
    <div class="kpis">
      <div class="kpi hero"><span class="lbl">${esc(sel.label)}</span><span class="val">${money(sel.amount)}</span><span class="sub">${pct(sel.share)} of ${money(sum.total)}</span></div>
      <div class="kpi"><span class="lbl">Payments</span><span class="val">${sel.count}</span><span class="sub">avg ${money(sel.count ? sel.amount / sel.count : 0)}</span></div>
      <div class="kpi"><span class="lbl">Customers</span><span class="val">${sel.customers}</span><span class="sub">${esc(span(sel))}</span></div>
    </div>
    ${months.length > 1 ? `<h3 class="sub-h">Month by month</h3>${barChart(months.map((mk) => {
      const v = (sel.months.find((x) => x.month === mk) || { amount: 0 }).amount;
      return { label: monthName(mk), value: v, tip: `<b>${esc(monthName(mk))}</b><br>${esc(sel.label)} ${money(v, { exact: true })}` };
    }), { label: `${sel.label} per month`, h: 140, color: colorOf.get(sel.key) })}` : ''}
    <h3 class="sub-h">By customer</h3>
    <div class="table-wrap"><table class="compact">
      <thead><tr><th>Customer</th><th class="r">Payments</th><th class="r">Amount</th><th class="r">Share</th><th>Last</th></tr></thead>
      <tbody>${sel.byCustomer.map((c) => `<tr><td>${esc(c.name)}</td><td class="r">${c.count}</td><td class="r nowrap">${esc(fmtMoney(c.amount))}</td>
        <td class="r">${sel.amount ? pct(c.amount / sel.amount) : ''}</td><td class="nowrap">${esc(fmtDate(c.last))}</td></tr>`).join('')}</tbody>
    </table></div>` : '';

  setMain(`
    ${payTabsHtml('modes')}
    <section class="card">
      <div class="row-between"><h2>Payments by mode</h2>
        <div class="chips">${['month', 'last', 'd30', 'fy'].map((x) => `<button class="chip ${x === pm.period ? 'on' : ''}" data-mperiod="${x}">${per[x].label}</button>`).join('')}
          <button class="chip ${pm.period === 'custom' ? 'on' : ''}" data-mperiod="custom">Custom</button></div></div>
      ${pm.period === 'custom' ? `<form class="custom-range" id="mode-range">
        <label>From <input type="date" name="from" value="${range.from}" max="${today}" required></label>
        <label>To <input type="date" name="to" value="${range.to}" max="${today}" required></label>
        <button class="btn small" type="submit">Show</button></form>` : ''}
      <p class="muted small">${esc(fmtDate(range.from))} – ${esc(fmtDate(range.to))} · every payment in the app (Master Paid and payments logged here), by its Payment Mode · only the modes used in these dates</p>
      ${sum.count ? `<div class="kpis">
        <div class="kpi hero"><span class="lbl">Received</span><span class="val">${money(sum.total)}</span><span class="sub">${plural(sum.count, 'payment')} · ${plural(sum.modes.length, 'mode')}</span></div>
        <div class="kpi"><span class="lbl">Cash</span><span class="val">${money(cash)}</span><span class="sub">${sum.total ? pct(cash / sum.total) : '0%'} of all</span></div>
        <div class="kpi"><span class="lbl">XtraPower</span><span class="val">${money(xp)}</span><span class="sub">${sum.total ? pct(xp / sum.total) : '0%'} of all</span></div>
      </div>` : '<p class="muted">No payments in these dates.</p>'}
    </section>
    ${sum.count ? `<section class="card">
      <div class="row-between"><h3>Mode-wise summary</h3>
        <button class="btn ghost small" id="mode-xlsx">Download Excel</button></div>
      <div class="share">${sum.modes.filter((m) => m.amount > 0).map((m) => `<span style="flex:${m.amount};background:${colorOf.get(m.key)}" title="${esc(m.label)} ${pct(m.share)}"></span>`).join('')}</div>
      <ol class="rank">${sum.modes.map(modeRow).join('')}</ol>
      <p class="muted small">Tap a mode to see its customers and payments. A payment typed as two modes (“15000 HDFC + 35000 Cash”) counts in each with its part.</p>
    </section>
    <section class="card" id="mode-detail">
      <div class="chips" role="group" aria-label="Show payments of">
        <button class="chip ${sel ? '' : 'on'}" data-mode="*">All · ${sum.count}</button>
        ${sum.modes.map((m) => `<button class="chip ${sel && sel.key === m.key ? 'on' : ''}" data-mode="${esc(m.key)}">${esc(m.label)} · ${m.count + m.refunds}</button>`).join('')}
      </div>
      ${detail}
      <h3 class="sub-h">Payments <span class="muted">(newest first)</span></h3>
      <div class="table-wrap"><table class="compact">
        <thead><tr><th>Date</th><th>Customer</th><th class="r">Amount</th>${sel ? '' : '<th>Mode</th>'}<th>As written</th><th>Remarks</th></tr></thead>
        <tbody>${shown.map((p) => `<tr><td class="nowrap">${esc(fmtDate(p.pay_date))}</td><td>${esc(p.customer)}</td>
          <td class="r nowrap">${esc(fmtMoney(p.part))}${p.split ? `<br><small class="muted">of ${esc(fmtMoney(p.whole))}</small>` : ''}</td>
          ${sel ? '' : `<td><i class="dot" style="background:${colorOf.get(p.modeKey)}"></i> ${esc(labelOf.get(p.modeKey))}</td>`}
          <td class="small">${p.written && (p.split || p.written !== labelOf.get(p.modeKey)) ? esc(p.written) : ''}</td><td class="small">${esc(p.remarks || '')}</td></tr>`).join('')}</tbody>
      </table></div>
      ${list.length > shown.length ? `<p><button class="btn ghost small" id="mode-all">Show all ${list.length}</button></p>` : ''}
    </section>` : ''}`);
  bindCharts(main());
  main().querySelectorAll('[data-mperiod]').forEach((b) => b.addEventListener('click', () => {
    pm.period = b.dataset.mperiod;
    if (pm.period === 'custom' && !pm.from) { pm.from = range.from; pm.to = range.to; }
    pm.all = false;
    guard(viewPaymentModes);
  }));
  document.getElementById('mode-range')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.to.value < f.from.value) { toast('Pick a From date on or before the To date.'); return; }
    pm.from = f.from.value; pm.to = f.to.value; pm.all = false;
    guard(viewPaymentModes);
  });
  main().querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.mode;
    pm.mode = key === '*' || (sel && sel.key === key && b.classList.contains('rank-row')) ? null : key;
    pm.all = false;
    guard(viewPaymentModes).then(() => document.getElementById('mode-detail')?.scrollIntoView({ block: 'start' }));
  }));
  document.getElementById('mode-all')?.addEventListener('click', () => { pm.all = true; guard(viewPaymentModes); });
  document.getElementById('mode-xlsx')?.addEventListener('click', () => guard(() => downloadSheets([
    { name: 'By mode', cols: [26, 10, 16, 8, 11, 12, 12],
      rows: [['Mode', 'Payments', 'Amount', 'Share', 'Customers', 'First', 'Last'],
        ...sum.modes.map((m) => [m.label, m.count, m.amount, Math.round(m.share * 1000) / 1000, m.customers, xlDate(m.first), xlDate(m.last)]),
        ['Total', sum.count, sum.total, 1, '', '', '']] },
    ...sum.modes.map((m) => ({
      name: m.label.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'No mode', cols: [11, 34, 14, 14, 30, 30], filter: true,
      rows: [['Date', 'Customer', 'Amount', 'Payment', 'As written', 'Remarks'],
        ...m.payments.map((p) => [xlDate(p.pay_date), p.customer, p.part, p.whole, p.written, p.remarks || ''])],
    })),
  ], `Payments by mode ${range.from} to ${range.to}.xlsx`)));
}
// the months a period touches: ['2026-10', '2026-11']
function monthsIn(from, to) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7);) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

function appPaymentsCard(list) {
  const total = list.reduce((a, p) => a + Number(p.amount || 0), 0);
  return `<section class="card" id="app-payments">
    <h3>Logged here, not in your Excel copy yet</h3>
    <p class="muted"> ${list.length
    ? 'These count in balances now and stay until a Master Ledger upload shows them in Master Paid.'
    : 'None waiting for Excel.'}</p>
    ${list.length ? `<details><summary>${plural(list.length, 'payment')} · ${esc(fmtMoney(total))}</summary>
      <div class="table-wrap"><table class="compact">
        <thead><tr><th>Date</th><th>Customer</th><th class="r">Amount</th><th>Mode</th><th></th></tr></thead>
        <tbody>${list.map((p) => `<tr><td>${esc(fmtDate(p.pay_date))}</td><td>${esc(p.customer)}</td><td class="r">${esc(fmtMoney(p.amount))}</td><td>${esc(p.mode)}</td>
          <td><button class="btn ghost small" data-app-pay-del="${p.id}" title="Take it out of the ledger app (the payments app isn't touched)">Remove</button></td></tr>`).join('')}</tbody>
      </table></div></details>` : ''}
  </section>`;
}

function bindAppPayments(reload) {
  document.querySelectorAll('[data-app-pay-del]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    if (!window.confirm('Take this payment out of the ledger app? (The payments app and Excel are not touched.)')) return;
    await state.store.appPaymentsDelete(Number(b.dataset.appPayDel));
    toast('Removed.');
    await reload();
  })));
}

// ---------------------------------------------------------------------------
// Loans & EMI — the vehicles' loans (our own tanker trucks, cars in the
// firm's name) from the banks' repayment schedules, as in the fleet app
// (fleet/js/loans.js reads them). Every EMI due till today counts as paid
// unless marked not paid. Kept in ledger_loans (one row per loan).
// ---------------------------------------------------------------------------
const LOANS_SCHEMA = 'The database needs an update for Loans & EMI: run supabase/ledger-schema.sql again in the Supabase SQL Editor (safe to re-run).';
const LOAN_KINDS = [['truck', 'Own tanker truck', 'Tanker', 'Tanker trucks'], ['car', 'Car (firm\'s name)', 'Car', 'Cars'], ['other', 'Other vehicle', 'Vehicle', 'Other vehicles']];
const kindGroup = (k) => (LOAN_KINDS.find((x) => x[0] === k) || LOAN_KINDS[2])[3];
const kindTag = (k) => (LOAN_KINDS.find((x) => x[0] === k) || LOAN_KINDS[2])[2];
const kindName = (k) => (LOAN_KINDS.find((x) => x[0] === k) || LOAN_KINDS[2])[1];
const kindSelect = (attrs, v) => `<select ${attrs}>${LOAN_KINDS.map(([k, n]) => `<option value="${k}"${k === (v || 'other') ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
const vehNo = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// OD23U8210 -> "OD 23 U 8210" (as on the number plate)
const plateText = (v) => {
  const m = vehNo(v).match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ') : vehNo(v);
};
const plateHtml = (v) => (v ? `<span class="hsrp">${esc(plateText(v))}</span>` : '<b>No vehicle no.</b>');
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const rateText = (l) => (l.rate ? `${Number(l.rate).toFixed(2)}%${l.rateFrom === 'derived' ? ' (worked out from the schedule)' : l.rateFrom === 'terms' ? ' (typed in — worked out)' : ''}${l.apr ? ` · APR ${Number(l.apr).toFixed(2)}%` : ''}` : '—');
const PF_KEYS = [
  { key: 'pp', name: 'Principal paid', color: 'var(--good)' }, { key: 'ip', name: 'Interest paid', color: 'var(--s-ms)' },
  { key: 'pl', name: 'Principal to go', color: 'color-mix(in srgb, var(--good) 30%, transparent)' }, { key: 'il', name: 'Interest to go', color: 'color-mix(in srgb, var(--s-ms) 30%, transparent)' },
];
// the schedule's kind of loan: a commercial vehicle (our tanker) or a car
const kindFromText = (text) => (/commercial\s+vehicle|\bCV\b|truck|tanker|goods\s+carrier|tipper/i.test(text) ? 'truck'
  : /\bcar\b|passenger|innova|hycross|fortuner|scorpio|xuv|creta|city|dzire/i.test(text) ? 'car' : '');

async function loansList(fresh = false) {
  if (!fresh && state.loans) return state.loans;
  try {
    state.loans = await state.store.loans();
  } catch (err) {
    if (/could not find the function|does not exist|schema cache/i.test(String((err && err.message) || err))) throw new Error(LOANS_SCHEMA);
    throw err;
  }
  return state.loans;
}
// a loan as saved: the schedule without what's only for the review
const loanToSave = (l) => {
  const out = { ...l };
  ['warnings', 'first', 'last', 'replaces', 'suggested', 'unpaid', 'updated_at', 'updated_by', 'text'].forEach((k) => delete out[k]);
  out.veh = vehNo(out.veh);
  return out;
};

// paid and to go, of all the loan(s) will cost: principal + interest. x: loanStatus() or loansSummary().total
function payoffHtml(x) {
  const P = [['pp', 'Principal paid', x.principalPaid], ['ip', 'Interest paid', x.interestPaid], ['pl', 'Principal to go', x.principalLeft], ['il', 'Interest to go', x.interestLeft]];
  const all = P.reduce((a, p) => a + p[2], 0) || 1;
  const paid = x.principalPaid + x.interestPaid;
  const left = x.principalLeft + x.interestLeft;
  const R = 52;
  const C = 2 * Math.PI * R;
  let off = 0;
  const ring = P.filter((p) => p[2] > 0).map(([k, , v]) => {
    const len = (v / all) * C;
    const seg = `<circle class="pf-${k}" r="${R}" cx="64" cy="64" fill="none" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 64 64)"/>`;
    off += len;
    return seg;
  }).join('');
  const togo = x.tenure - x.paidN - (x.overdueN || 0);
  return `<div class="pf">
    <svg class="pf-ring" viewBox="0 0 128 128" role="img" aria-label="${esc(`${pctOf(paid, all)}% of ${rupees(all)} paid`)}"><circle class="pf-track" r="${R}" cx="64" cy="64" fill="none" stroke-width="16"/>${ring}
      <text x="64" y="62" text-anchor="middle" class="pf-c">${pctOf(paid, all)}%</text><text x="64" y="80" text-anchor="middle" class="pf-s">paid</text></svg>
    <div class="pf-body">
      <div class="pf-head"><span><small>Paid so far</small><b class="good-text">${money(paid)}</b></span><span class="r"><small>Still to go</small><b>${money(left)}</b></span></div>
      <div class="pf-bar">${P.map(([k, n, v]) => (v > 0 ? `<i class="pf-${k}" style="width:${((v / all) * 100).toFixed(2)}%" title="${esc(`${n} ${rupees(v)}`)}"></i>` : '')).join('')}</div>
      <div class="pf-key">${P.map(([k, n, v]) => `<span><i class="pf-${k}"></i>${esc(n)} <b>${money(v)}</b></span>`).join('')}</div>
      <p class="pf-time">of <b>${money(all)}</b> in all (${money(x.amount)} borrowed + ${money(x.totalInterest)} interest) · <b>${x.paidN}</b> of ${x.tenure} EMIs paid · <b>${togo}</b> to go${x.ends ? ` · last ${esc(monthLabel(x.ends))}` : ''}</p>
    </div>
  </div>`;
}

const TERM_FIELDS = [['veh', 'Vehicle no.'], ['kind', 'Vehicle'], ['note', 'Note (model)'], ['bank', 'Bank / lender'], ['lan', 'Loan / agreement no.'],
  ['amount', 'Amount financed (₹)'], ['emi', 'EMI (₹)'], ['tenure', 'Number of EMIs'], ['first', 'First EMI date'], ['lastEmi', 'Last EMI (₹)'],
  ['firstInterest', 'First EMI\'s interest (₹)'], ['rate', 'Interest rate (% a year)']];
function loanFormHtml(F) {
  return `<section class="card" id="loan-form">
    <h3>Type in a loan</h3>
    <p class="muted small">For a schedule the app can't read (a scanned or photographed copy): from its first page fill in the amount, EMI, number of EMIs and first EMI date, and from its last page the <b>last EMI</b> — that matches the bank's schedule to the rupee. When the first EMI's interest is for part of a month (paid out mid-month), type it in too. The app works out every EMI the way the bank does: interest on what's still owed, the rest principal.${F.file ? ` <b>${esc(F.file)}</b> had no text to read.` : ''}</p>
    <form class="row-form loan-terms" id="loan-terms">${TERM_FIELDS.map(([k, n]) => `<label>${esc(n)} ${k === 'kind' ? kindSelect('name="kind"', F.kind) : `<input name="${k}"${k === 'first' ? ' type="date"' : ['veh', 'note', 'bank', 'lan'].includes(k) ? '' : ' inputmode="decimal"'} value="${esc(F[k] || '')}"${k === 'veh' ? ' placeholder="OD23T1010" autocapitalize="characters"' : ''}>`}</label>`).join('')}</form>
    <div id="loan-preview">${loanPreviewHtml(F)}</div>
    <div class="actions"><button class="btn" id="terms-save" type="button">Save loan</button><button class="btn ghost" id="terms-cancel" type="button">Cancel</button></div>
  </section>`;
}
function loanPreviewHtml(F) {
  if (!F.amount && !F.emi) return '';
  const l = loanFromTerms(F);
  if (l.error) return `<p class="muted small">${esc(l.error)}</p>`;
  const x = loanStatus(l, localToday());
  const last = l.rows[l.rows.length - 1];
  return `<div class="todo">Works out to <b>${l.rate}%</b> a year (from the ${esc(l.rateBy)}) · ${l.rows.length} EMIs, ${esc(fmtDate(l.rows[0].date))} – ${esc(fmtDate(last.date))}, last one ${rupees(last.emi)} · interest ${rupees(x.totalInterest)} in all · as of today ${x.paidN} paid, ${money(x.principalLeft)} principal owed
    ${l.warnings.map((w) => `<small class="block warn-text">⚠ ${esc(w)}</small>`).join('')}</div>`;
}

// read the PDFs, then a table to check them and give each its vehicle
async function addSchedules(files) {
  const read = [];
  const errors = [];
  let scan = null;
  for (const f of files) {
    try {
      const text = await pdfText(f);
      if (!text.trim()) {
        errors.push(`${f.name} is a scanned copy — there's no text in it to read. Type it in below: the amount, EMI, number of EMIs, first EMI date and the last EMI from it.`);
        scan = scan || f.name;
        continue;
      }
      const loan = parseSchedule(text, { fileName: f.name });
      if (loan.error) { errors.push(loan.error); continue; }
      loan.kind = kindFromText(text) || 'other';
      loan.veh = vehFromText(f.name) || vehFromText(text);
      read.push(loan);
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }
  const have = await loansList();
  for (const l of read) {
    const old = have.find((x) => x.lan === l.lan);
    if (old) { l.veh = old.veh || l.veh; l.kind = old.kind || l.kind; l.note = old.note || ''; l.replaces = true; }
  }
  state.loanReview = { read, errors };
  if (scan && !state.loanForm) state.loanForm = { file: scan, veh: vehFromText(scan), kind: kindFromText(scan) || '' };
  await viewLoans();
}
function loanReviewHtml(R) {
  return `<section class="card" id="loan-review">
    <h3>Check the schedules</h3>
    ${R.errors.length ? `<div class="todos">${R.errors.map((e) => `<div class="todo warn">${esc(e)}</div>`).join('')}</div>` : ''}
    ${R.read.length ? `<p class="muted small">Check each loan's vehicle no. and what it is — taken from the file name and the schedule where they say.</p>
    <div class="table-wrap"><table class="compact ln-review"><thead><tr><th>Loan</th><th class="r">Amount</th><th class="r">EMI</th><th>Runs</th><th>Vehicle</th></tr></thead><tbody>
      ${R.read.map((l, i) => `<tr><td><b>${esc(l.bank || 'Bank?')}</b> ${esc(l.lan)}<small class="block muted">${esc(l.file)} · ${esc(rateText(l))}${l.replaces ? ' · <b>replaces the one saved</b>' : ''}</small>${l.warnings.map((w) => `<small class="block warn-text">⚠ ${esc(w)}</small>`).join('')}</td>
        <td class="r nowrap">${rupees(l.amount)}</td><td class="r nowrap">${rupees(l.emi)}<small class="block muted">× ${l.tenure}</small></td><td class="nowrap">${esc(fmtDate(l.first))} –<br>${esc(fmtDate(l.last))}<small class="block muted">on the ${ordinal(l.dueDay)}</small></td>
        <td><input data-rv="${i}" data-k="veh" value="${esc(plateText(l.veh || ''))}" placeholder="Vehicle no." autocapitalize="characters" aria-label="Vehicle no.">
          ${kindSelect(`data-rv="${i}" data-k="kind" aria-label="What it is"`, l.kind)}
          <input data-rv="${i}" data-k="note" value="${esc(l.note || '')}" placeholder="Note (model)" aria-label="Note"></td></tr>`).join('')}
    </tbody></table></div>
    <div class="actions"><button class="btn" id="review-save" type="button">Save ${plural(R.read.length, 'loan')}</button><button class="btn ghost" id="review-cancel" type="button">Cancel</button></div>` : '<div class="actions"><button class="btn ghost" id="review-cancel" type="button">Close</button></div>'}
  </section>`;
}

async function viewLoans() {
  const loans = await loansList();
  const R = state.loanReview;
  const add = `<span class="row-gap"><label class="file"><input type="file" id="loan-files" accept="application/pdf,.pdf" multiple><span class="btn small">Add EMI schedules (PDF)</span></label><button class="btn ghost small" id="loan-type" type="button">Type in a loan</button></span>`;
  const form = state.loanForm ? loanFormHtml(state.loanForm) : '';
  if (!loans.length) {
    setMain(`<section class="card"><div class="row-between"><h2>Loans &amp; EMI</h2>${add}</div>
      <p class="muted">Add each vehicle's EMI schedule — the PDF the bank gives (HDFC's repayment schedule, ICICI's amortisation schedule, Toyota Financial's, …); several at once. The app reads every EMI and shows what's paid and what's left — principal and interest — for each vehicle and all of them. Our own tanker trucks and cars in the firm's name alike. Every EMI due till today counts as paid; you can mark one not paid. A schedule that's a scan or a photo (no text) is typed in instead.</p></section>
      ${R ? loanReviewHtml(R) : ''}${form}`);
    bindLoans();
    return;
  }
  const t = localToday();
  const L = loansSummary(loans, t);
  const T = L.total;
  const tm = L.thisMonth;
  const kinds = [...new Set(L.loans.map((x) => x.loan.kind || 'other'))];
  const byKind = LOAN_KINDS.map(([k]) => k).filter((k) => kinds.includes(k)).map((k) => {
    const S = L.loans.filter((x) => (x.loan.kind || 'other') === k);
    const sum = (f) => S.reduce((a, x) => a + f(x), 0);
    return { k, n: S.length, emi: sum((x) => (x.done ? 0 : x.loan.emi)), principalLeft: sum((x) => x.principalLeft), interestLeft: sum((x) => x.interestLeft), amount: sum((x) => x.amount), interestPaid: sum((x) => x.interestPaid), ends: S.map((x) => x.ends).sort().pop() };
  });
  const order = [...L.loans].sort((a, b) => LOAN_KINDS.findIndex((k) => k[0] === (a.loan.kind || 'other')) - LOAN_KINDS.findIndex((k) => k[0] === (b.loan.kind || 'other'))
    || String(a.loan.veh || '~').localeCompare(String(b.loan.veh || '~')) || String(a.loan.lan).localeCompare(String(b.loan.lan)));
  const coming = L.loans.filter((x) => x.next).map((x) => ({ x, r: x.next })).sort((a, b) => a.r.date.localeCompare(b.r.date));
  setChartWidth(Math.min(main().clientWidth, 1100) - 38);
  setMain(`<section class="card">
    <div class="row-between"><h2>Loans &amp; EMI</h2>${add}</div>
    <p class="muted small">${plural(T.loans, 'loan')} from the banks' schedules. Every EMI due till today counts as paid — if one wasn't, open its vehicle and mark it not paid.</p>
    <div class="kpis">
      <div class="kpi hero"><span class="lbl">Principal still owed</span><span class="val">${money(T.principalLeft)}</span><span class="sub">of ${money(T.amount)} borrowed · ${pctOf(T.principalPaid, T.amount)}% repaid</span></div>
      <div class="kpi"><span class="lbl">EMIs a month</span><span class="val">${money(T.emi)}</span><span class="sub">${tm ? `this month ${money(tm.emi)}` : 'none this month'}</span></div>
      <div class="kpi"><span class="lbl">Interest paid</span><span class="val">${money(T.interestPaid)}</span><span class="sub">of ${money(T.totalInterest)} in all</span></div>
      <div class="kpi"><span class="lbl">Interest still to pay</span><span class="val">${money(T.interestLeft)}</span><span class="sub">till ${esc(T.ends ? monthLabel(T.ends) : '—')}</span></div>
      <div class="kpi ${T.overdueN ? 'warn' : ''}"><span class="lbl">Not paid</span><span class="val ${T.overdueN ? 'bad-text' : 'good-text'}">${T.overdueN ? money(T.overdueAmt) : '✓ none'}</span><span class="sub">${T.overdueN ? `${plural(T.overdueN, 'EMI')} marked not paid` : 'every EMI due is paid'}</span></div>
    </div>
    ${payoffHtml(T)}
  </section>
  ${R ? loanReviewHtml(R) : ''}${form}
  ${coming.length ? `<section class="card"><h3>Coming up</h3><div class="ln-next">${coming.map(({ x, r }) => `<a class="ln-due" href="#/loans/${encodeURIComponent(x.loan.lan)}">
      <span class="ln-d"><b>${esc(r.date.slice(8, 10))}</b><small>${esc(monthName(r.date.slice(0, 7)))}</small></span>
      <span class="ln-who">${plateHtml(x.loan.veh)}<small>${esc(kindTag(x.loan.kind))} · ${esc(x.loan.bank || 'Bank')} · EMI ${r.n} of ${x.tenure}</small></span>
      <b class="nowrap">${rupees(r.emi)}</b></a>`).join('')}</div></section>` : ''}
  ${byKind.length > 1 ? `<section class="card"><h3>Tankers and cars</h3><div class="table-wrap"><table class="compact"><thead><tr><th></th><th class="r">EMIs a month</th><th class="r">Principal owed</th><th class="r hide-sm">Interest to pay</th><th class="r hide-sm">Last EMI</th></tr></thead><tbody>
    ${byKind.map((b) => `<tr><td><b>${esc(kindGroup(b.k))}</b><small class="block muted">${plural(b.n, 'loan')}</small></td><td class="r">${rupees(b.emi)}</td><td class="r">${rupees(b.principalLeft)}<small class="block muted">of ${money(b.amount)}</small></td><td class="r hide-sm">${rupees(b.interestLeft)}<small class="block muted">${money(b.interestPaid)} paid</small></td><td class="r hide-sm">${esc(b.ends ? fmtDate(b.ends) : '—')}</td></tr>`).join('')}
    <tr class="sum"><td><b>All</b></td><td class="r"><b>${rupees(T.emi)}</b></td><td class="r"><b>${rupees(T.principalLeft)}</b></td><td class="r hide-sm"><b>${rupees(T.interestLeft)}</b></td><td class="hide-sm"></td></tr>
  </tbody></table></div></section>` : ''}
  <section class="card"><h3>Each vehicle <span class="muted small">tap one for its EMIs</span></h3>
    <div class="ln-list">${order.map((x) => `<a class="ln-row${x.overdueN ? ' bad' : ''}" href="#/loans/${encodeURIComponent(x.loan.lan)}">
      <span class="ln-top">${plateHtml(x.loan.veh)}<span class="ln-who">${esc(kindTag(x.loan.kind))}${x.loan.note ? ` · ${esc(x.loan.note)}` : ''}<small>${esc(x.loan.bank || 'Bank')} · ${esc(x.loan.lan)}</small></span>${x.overdueN ? `<span class="pill bad-pill">${plural(x.overdueN, 'EMI')} not paid</span>` : x.done ? '<span class="pill good-pill">Paid off</span>' : ''}</span>
      <span class="ln-emi">EMI <b>${rupees(x.loan.emi)}</b> on the ${ordinal(x.loan.dueDay)} · ${x.paidN} of ${x.tenure} paid${x.next ? ` · next ${esc(fmtDate(x.next.date))}` : ''}</span>
      <span class="pf-bar sm">${[['pp', x.principalPaid], ['ip', x.interestPaid], ['pl', x.principalLeft], ['il', x.interestLeft]].map(([k, v]) => (v > 0 ? `<i class="pf-${k}" style="width:${((v / (x.totalPayable || 1)) * 100).toFixed(2)}%"></i>` : '')).join('')}</span>
      <span class="ln-nums"><span>Paid <b class="good-text">${money(x.principalPaid + x.interestPaid)}</b></span><span>To go <b>${money(x.principalLeft + x.interestLeft)}</b></span><span>Principal owed <b>${money(x.principalLeft)}</b></span></span>
    </a>`).join('')}</div>
  </section>
  <section class="card"><h3>Month by month <span class="muted small">every EMI — paid months solid, months to go faded</span></h3>
    ${legend(PF_KEYS)}
    ${stackedBars(L.months.map((m) => ({
    label: monthName(m.month), parts: m.past ? { pp: m.principal, ip: m.interest } : { pl: m.principal, il: m.interest },
    tip: `<b>${esc(monthLabel(`${m.month}-01`))}</b>${m.past ? (m.unpaid ? ` · ${plural(m.unpaid, 'EMI')} not paid` : ' · paid') : ' · to pay'}<br>EMIs ${money(m.emi, { exact: true })}<br><i style="background:var(--good)"></i>Principal ${money(m.principal, { exact: true })}<br><i style="background:var(--s-ms)"></i>Interest ${money(m.interest, { exact: true })}`,
  })), PF_KEYS, { label: 'EMIs per month, principal and interest' })}
    <p class="muted small">Interest is most of an EMI early on and shrinks every month as the principal is paid down.${tm ? ` This month: ${money(tm.principal)} principal + ${money(tm.interest)} interest.` : ''}</p>
  </section>`);
  bindLoans();
  bindCharts(main());
}

function bindLoans() {
  const m = main();
  m.querySelector('#loan-files')?.addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    toast(`Reading ${plural(files.length, 'schedule')}…`);
    guard(() => addSchedules(files));
  });
  m.querySelectorAll('[data-rv]').forEach((el) => el.addEventListener('change', () => {
    const l = state.loanReview.read[Number(el.dataset.rv)];
    const k = el.dataset.k;
    l[k] = k === 'veh' ? vehNo(el.value) : el.value.trim();
    if (k === 'veh') el.value = plateText(l.veh);
  }));
  m.querySelector('#loan-type')?.addEventListener('click', () => {
    state.loanForm = state.loanForm || {};
    guard(viewLoans).then(() => document.getElementById('loan-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  });
  const form = m.querySelector('#loan-terms');
  const readForm = () => { const F = state.loanForm; for (const [k] of TERM_FIELDS) F[k] = form[k].value; return F; };
  form?.addEventListener('input', () => { m.querySelector('#loan-preview').innerHTML = loanPreviewHtml(readForm()); });
  m.querySelector('#terms-cancel')?.addEventListener('click', () => { state.loanForm = null; guard(viewLoans); });
  m.querySelector('#terms-save')?.addEventListener('click', (e) => guard(async () => {
    const F = readForm();
    if (!vehNo(F.veh)) { toast('Fill in the vehicle no.', 'bad'); return; }
    if (!String(F.lan || '').trim()) { toast('Fill in the loan / agreement no.', 'bad'); return; }
    const l = loanFromTerms(F);
    if (l.error) { toast(l.error, 'bad'); return; }
    const have = await loansList();
    if (have.some((x) => x.lan === l.lan) && !window.confirm(`Loan ${l.lan} is already saved. Replace it with this one?`)) return;
    e.target.disabled = true;
    await state.store.saveLoan({ ...loanToSave(l), kind: F.kind || 'other', note: String(F.note || '').trim(), file: F.file || '' });
    state.loanForm = null;
    await loansList(true);
    toast(`Saved loan ${l.lan} (${plateText(l.veh)}).`);
    await viewLoans();
  }));
  m.querySelector('#review-cancel')?.addEventListener('click', () => { state.loanReview = null; guard(viewLoans); });
  m.querySelector('#review-save')?.addEventListener('click', (e) => guard(async () => {
    const R = state.loanReview;
    if (R.read.some((l) => !vehNo(l.veh)) && !window.confirm('A loan has no vehicle no. Save anyway? (You can add it on the loan later.)')) return;
    const vehs = R.read.map((l) => vehNo(l.veh)).filter(Boolean);
    if (new Set(vehs).size < vehs.length && !window.confirm('Two of these loans have the same vehicle. Save anyway?')) return;
    e.target.disabled = true;
    for (const l of R.read) await state.store.saveLoan(loanToSave(l));
    state.loanReview = null;
    await loansList(true);
    toast(`Saved ${plural(R.read.length, 'loan')}.`);
    await viewLoans();
  }));
}

async function viewLoan(lan) {
  const loans = await loansList();
  const loan = loans.find((l) => l.lan === lan);
  if (!loan) { setMain('<section class="card"><p>No such loan.</p><a class="btn ghost" href="#/loans">All loans</a></section>'); return; }
  const t = localToday();
  const x = loanStatus(loan, t);
  const ui = state.loanRows || (state.loanRows = {});
  const lastDue = x.rows.filter((r) => r.status !== 'upcoming').length;
  const shown = ui[lan] ? x.rows : x.rows.slice(Math.max(0, lastDue - 3), Math.max(lastDue + 3, 6));
  const cut = shown.length < x.rows.length;
  setMain(`<section class="card">
    <p class="crumbs"><a href="#/loans">Loans &amp; EMI</a> ›</p>
    <div class="row-between"><h2>${plateHtml(loan.veh)} <span class="muted small">${esc(kindName(loan.kind))}${loan.note ? ` · ${esc(loan.note)}` : ''}</span></h2></div>
    <p class="muted small">${esc(loan.bank || 'Bank')} · loan ${esc(loan.lan)} · ${rupees(x.amount)} at ${esc(rateText(loan))} · ${rupees(loan.emi)} × ${x.tenure} on the ${ordinal(loan.dueDay)} · ${esc(fmtDate(x.rows[0].date))} – ${esc(fmtDate(x.ends))}${loan.typed ? ' · typed in from the schedule' : loan.file ? ` · from ${esc(loan.file)}` : ''}</p>
    <div class="kpis">
      <div class="kpi hero"><span class="lbl">Principal still owed</span><span class="val">${money(x.principalLeft)}</span><span class="sub">of ${money(x.amount)} · ${pctOf(x.principalPaid, x.amount)}% repaid</span></div>
      <div class="kpi"><span class="lbl">EMIs paid</span><span class="val">${x.paidN} <small>of ${x.tenure}</small></span><span class="sub">${x.upcomingN} to go${x.next ? ` · next ${esc(fmtDate(x.next.date))}` : ''}</span></div>
      <div class="kpi"><span class="lbl">Interest paid</span><span class="val">${money(x.interestPaid)}</span><span class="sub">of ${money(x.totalInterest)} in all</span></div>
      <div class="kpi"><span class="lbl">Interest still to pay</span><span class="val">${money(x.interestLeft)}</span><span class="sub">total payable ${money(x.totalPayable)}</span></div>
      <div class="kpi ${x.overdueN ? 'warn' : ''}"><span class="lbl">Not paid</span><span class="val ${x.overdueN ? 'bad-text' : 'good-text'}">${x.overdueN ? money(x.overdueAmt) : '✓ none'}</span><span class="sub">${x.overdueN ? x.overdue.map((r) => `#${r.n} ${fmtDate(r.date)}`).join(', ') : 'every EMI due is paid'}</span></div>
    </div>
    ${payoffHtml(x)}
  </section>
  <section class="card"><h3>EMIs <span class="muted small">every EMI due till today counts as paid — tap one to mark it not paid (or paid again)</span></h3>
    <div class="table-wrap"><table class="compact ln-table"><thead><tr><th>#</th><th>Due</th><th class="r">EMI</th><th class="r hide-sm">Principal</th><th class="r">Interest</th><th class="r hide-sm">Owed after</th><th>Paid?</th></tr></thead><tbody>
      ${shown.map((r) => `<tr class="ln-${r.status}${r.date.slice(0, 7) === t.slice(0, 7) ? ' ln-now' : ''}"><td>${r.n}</td><td class="nowrap">${esc(fmtDate(r.date).replace(/ \d\d(\d\d)$/, ' $1'))}</td><td class="r">${rupees(r.emi)}</td><td class="r hide-sm">${rupees(r.principal)}</td><td class="r">${rupees(r.interest)}</td><td class="r hide-sm">${rupees(r.closing)}</td>
        <td>${r.status === 'upcoming' ? '<span class="muted small">to pay</span>' : `<button class="ln-st ${r.status}" type="button" data-n="${r.n}" aria-pressed="${r.status === 'unpaid'}">${r.status === 'paid' ? '✓ Paid' : '✗ Not paid'}</button>`}</td></tr>`).join('')}
    </tbody><tfoot><tr><td colspan="2">All ${x.tenure}</td><td class="r">${rupees(x.totalPayable)}</td><td class="r hide-sm">${rupees(x.amount)}</td><td class="r">${rupees(x.totalInterest)}</td><td class="hide-sm"></td><td></td></tr></tfoot></table></div>
    ${cut ? `<button class="btn ghost small" id="loan-all" type="button">Show all ${x.tenure} EMIs</button>` : ''}
  </section>
  <section class="card"><h3>This loan's vehicle</h3>
    <form class="row-form" id="loan-edit">
      <label>Vehicle no. <input name="veh" value="${esc(plateText(loan.veh || ''))}" autocapitalize="characters"></label>
      <label>Vehicle ${kindSelect('name="kind"', loan.kind)}</label>
      <label>Note (model) <input name="note" value="${esc(loan.note || '')}"></label>
      <label>Bank / lender <input name="bank" value="${esc(loan.bank || '')}"></label>
      <button class="btn small" type="submit">Save</button>
    </form>
    <p class="muted small">To change the EMIs themselves, add the bank's schedule again (or type the loan in again) — it replaces this one and keeps the EMIs marked not paid.${loan.updated_by ? ` Last changed by ${esc(loan.updated_by)}.` : ''}</p>
    <p><button class="btn ghost small" id="loan-remove" type="button">Remove this loan</button></p>
  </section>`);
  const m = main();
  m.querySelector('#loan-all')?.addEventListener('click', () => { ui[lan] = true; guard(() => viewLoan(lan)); });
  m.querySelector('#loan-edit').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    guard(async () => {
      const v = vehNo(f.veh.value);
      const other = loans.find((l) => l !== loan && v && l.veh === v);
      if (other && !window.confirm(`${plateText(v)} already has loan ${other.lan}. Give it this one too?`)) return;
      await state.store.saveLoan(loanToSave({ ...loan, veh: v, kind: f.kind.value, note: f.note.value.trim(), bank: f.bank.value.trim() }));
      await loansList(true);
      toast('Saved.');
      await viewLoan(lan);
    });
  });
  m.querySelectorAll('.ln-st').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const n = Number(b.dataset.n);
    const was = (loan.unpaid || []).includes(n);
    b.disabled = true;
    await state.store.markLoan(lan, n, !was);
    await loansList(true);
    const r = x.rows.find((y) => y.n === n);
    toast(`EMI #${n} (${fmtDate(r.date)}) marked ${was ? 'paid' : 'not paid'}.`);
    await viewLoan(lan);
  })));
  m.querySelector('#loan-remove').addEventListener('click', () => guard(async () => {
    if (!window.confirm(`Remove loan ${lan}${loan.veh ? ` (${plateText(loan.veh)})` : ''} and its EMIs from the app? (The bank's loan isn't touched — you can add the schedule again.)`)) return;
    await state.store.deleteLoan(lan);
    await loansList(true);
    toast(`Loan ${lan} removed.`);
    location.hash = '#/loans';
  }));
}

// ---------------------------------------------------------------------------
// Tally viewer — a Tally file (the DayBook in Excel, or Tally's XML export,
// several files together) read on this device; nothing is saved or uploaded.
//   Insights:          sales, receipts, products, customers, vehicles, rates,
//                      bill numbers, checks, every voucher
//   Financials:        P&L, balance sheet, month by month, expenses, cash & bank
//   Ledger vs Tally:   each customer's balance here against Tally, and the
//                      bills / payments / days behind any difference
//   Purchases & stock: lubricants (and fuel) bought or sold, item by month
// ---------------------------------------------------------------------------
async function viewTally(view = '') {
  if (!state.tally) {
    setMain(`
      <section class="card hero">
        <h2>Tally viewer</h2>
        <p class="muted">Open your Tally data to see the company's financials, compare every customer's balance here with Tally (and find the bill or day a difference comes from), and see the lubricants bought month by month — plus sales, receipts, rates, vehicles and bill-number checks. The files are read on this device — nothing is saved or uploaded, and the app's data is not changed.</p>
        <label class="file"><input type="file" id="tally-file" multiple accept=".xml,.txt,.xls,.xlsx,.xlsm,.csv"><span class="btn">Choose Tally files</span></label>
        ${state.demo ? '<button class="btn ghost" data-tally-sample>Try a sample Tally file</button>' : ''}
        <ul class="small muted steps">
          <li><b>Everything (best):</b> in Tally Prime, Gateway of Tally → <b>Export → Masters</b> (All Masters, XML) and <b>Export → Transactions</b> (Day Book for the whole year, XML). Choose both files together. The masters give the groups and opening balances the financials and the balance comparison need.</li>
          <li><b>Tally XML Day Book</b> alone: Display → Day Book (F2: the period) → Export → XML — vouchers with their ledgers and stock items.</li>
          <li><b>DayBook in Excel</b> (the file you import): sales, receipts and the insights; no financials or stock items.</li>
        </ul>
        <div id="tally-out"></div>
      </section>`);
    document.getElementById('tally-file').addEventListener('change', (e) => e.target.files.length && tallyFiles([...e.target.files], e.target));
    main().querySelector('[data-tally-sample]')?.addEventListener('click', () => guard(async () => {
      const out = document.getElementById('tally-out');
      out.innerHTML = loadingHtml('Making a sample from the demo data…');
      await paint();
      const { sampleTally } = await import('./tally-sample.js');
      const { xml } = await sampleTally(state.store, localToday());
      openTally([{ name: 'Sample Tally export.xml', ...parseTallyXml(xml) }]);
      renderTally(view);
    }));
    return;
  }
  renderTally(view);
}

async function readTallyFile(file) {
  const buf = await file.arrayBuffer();
  if (looksLikeXml(buf)) return { name: file.name, ...parseTallyXml(decodeText(buf)) };
  const XLSX = await loadSheetJS();
  const wb = readWorkbook(XLSX, buf, { all: true });
  const date1904 = Boolean(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
  return { name: file.name, ...parseDaybookSheet(sheetRows(wb.Sheets[wb.SheetNames[0]]), { date1904 }) };
}

function openTally(files) {
  state.tallyFiles = files;
  state.tally = mergeTally(files);
  state.tallyRecon = null;
  state.tallyAppUntil = undefined;
  state.tallyUi = {
    period: { key: 'all' }, sort: 'sales', q: '', pall: false, vall: false, v: { kind: 'all', product: 'all', q: '' }, shown: PAGE_SIZE,
    closingStock: '', allExp: false,
    recon: { asOn: null, filter: 'all', q: '', map: {} },
    stock: { kind: 'purchase', category: 'lubes', metric: 'volume', q: '' },
  };
}

// files chosen: read them; `add` keeps the files already open
async function tallyFiles(files, input, { add = false } = {}) {
  const out = document.getElementById('tally-out');               // null while a file is open
  const names = files.map((f) => f.name).join(', ');
  if (out) out.innerHTML = loadingHtml(`Reading ${names}…`);
  else toast(`Reading ${names}…`);
  await paint();
  const fail = (msg) => { if (out) out.innerHTML = `<div class="card bad-card">${msg}</div>`; else toast(msg.replace(/<[^>]+>/g, ''), 'bad'); };
  try {
    const read = [];
    for (const f of files) read.push(await readTallyFile(f));
    const all = [...(add ? state.tallyFiles || [] : []), ...read];
    if (!all.some((f) => f.vouchers.length)) {
      const masters = read.some((f) => f.masters && f.masters.ledgers.size);
      fail(masters
        ? `“${esc(names)}” has the masters but no vouchers. Choose the Day Book (or Transactions) export too — both files together.`
        : `No vouchers were found in “${esc(names)}”. Choose Tally's XML export (Day Book / Transactions, and the masters), or the DayBook exported to Excel.`);
      return;
    }
    const view = (location.hash.match(/^#\/tally\/(\w+)/) || [])[1] || '';
    if (add && state.tallyUi) {
      const ui = state.tallyUi;
      openTally(all);
      state.tallyUi = { ...state.tallyUi, period: ui.period, recon: { ...ui.recon }, stock: ui.stock };
      toast(`Added ${names}.`);
    } else openTally(all);
    renderTally(view);
  } catch (err) {
    console.error(err);
    fail(esc(err && err.message ? err.message : err));
  } finally {
    if (input) input.value = '';
  }
}

// the dates the period picker gives: {span, from, to}
function tallyRange() {
  const t = state.tally;
  const ui = state.tallyUi;
  const span = spanOf(t.vouchers);
  let range = { from: span.from, to: span.to };
  if (/^\d{4}-\d{2}$/.test(ui.period.key)) {
    range = { from: `${ui.period.key}-01` < span.from ? span.from : `${ui.period.key}-01`, to: monthEnd(ui.period.key) > span.to ? span.to : monthEnd(ui.period.key) };
  } else if (ui.period.key === 'custom' && ui.period.from) range = { from: ui.period.from, to: ui.period.to };
  return { span, ...range };
}

function renderTally(view = '') {
  const t = state.tally;
  const ui = state.tallyUi;
  const r = tallyRange();
  setMain(`<section class="card" id="tally-head"></section><div id="tally-body"></div>`);
  const head = document.getElementById('tally-head');
  const body = document.getElementById('tally-body');
  // gaps in the files: they matter for balances (with the masters), and a
  // break in the middle matters everywhere
  const cov = coverage(t.vouchers);
  const gaps = cov ? cov.gaps.filter((g) => !g.start || hasMasters(t.masters)) : [];
  const warn = gaps.length ? `Gaps in your files: ${esc(gapText(gaps))}. If an export is left out, <b>Add a file</b>; if nothing was entered in Tally those days, ignore this.` : '';
  const paintHead = (note = '') => {
    head.innerHTML = fileHeadHtml(t, r, ui.period, { view, note, warn, tabs: viewTabsHtml(view) });
    head.querySelectorAll('[data-tperiod]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.tperiod;
      ui.period = key === 'custom' ? { key, from: r.from, to: r.to } : { key };
      ui.shown = PAGE_SIZE;
      ui.closingStock = '';
      renderTally(view);
    }));
    head.querySelector('#tally-range')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const from = e.target.from.value;
      const to = e.target.to.value;
      if (!from || !to || to < from) { toast('Pick a From date on or before the To date.', 'bad'); return; }
      ui.period = { key: 'custom', from, to };
      ui.closingStock = '';
      renderTally(view);
    });
    head.querySelector('#tally-file-2').addEventListener('change', (e) => e.target.files.length && tallyFiles([...e.target.files], e.target));
    head.querySelector('#tally-add').addEventListener('change', (e) => e.target.files.length && tallyFiles([...e.target.files], e.target, { add: true }));
    head.querySelector('[data-tally-clear]').addEventListener('click', () => {
      state.tally = null;
      state.tallyFiles = null;
      state.tallyRecon = null;
      location.hash = '#/tally';
      viewTally();
    });
  };
  setChartWidth(body.clientWidth - 38);
  if (view === 'fin') { paintHead(); renderTallyFin(body, r); } else if (view === 'recon') { paintHead(); guard(() => renderTallyRecon(body, r)); } else if (view === 'stock') { paintHead(); renderTallyStock(body, r); } else {
    const a = analyseTally(t.vouchers, r);
    paintHead(`${plural(a.days, 'day')}, vouchers on ${a.activeDays}`);
    renderTallyInsights(body, a);
  }
}

function renderTallyInsights(body, a) {
  const t = state.tally;
  const ui = state.tallyUi;
  const kinds = KINDS.filter((k) => a.byKind[k].count);
  body.innerHTML = `
      <section class="card dash">${overviewHtml(a)}</section>
      <section class="card">${productsHtml(a)}</section>
      <section class="card">${trendHtml(a)}</section>
      <section class="card" id="t-parties"></section>
      <section class="card">${typesHtml(a)}</section>
      <section class="card" id="t-vehicles"></section>
      <section class="card">${ratesHtml(a)}</section>
      <section class="card">${seriesHtml(a)}</section>
      <section class="card">${checksHtml(a)}</section>
      ${t.source === 'xml' ? `<section class="card">${ledgersHtml(a, a.parties) || '<h3>Ledgers</h3><p class="muted">No ledger lines.</p>'}</section>` : ''}
      <section class="card" id="t-vouchers"></section>`;

  // customers & parties: sort, search, show all, their vouchers
  const parties = document.getElementById('t-parties');
  const paintParties = (focus = false) => {
    parties.innerHTML = partiesHtml(a, ui);
    parties.querySelectorAll('[data-psort]').forEach((b) => b.addEventListener('click', () => { ui.sort = b.dataset.psort; paintParties(); }));
    parties.querySelector('[data-pall]')?.addEventListener('click', () => { ui.pall = !ui.pall; paintParties(); });
    const q = parties.querySelector('#party-q');
    q.addEventListener('input', debounce(() => { ui.q = q.value; paintParties(true); }, 200));
    if (focus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    bindExpand(parties, '[data-party]');
    parties.querySelectorAll('[data-party-vouchers]').forEach((b) => b.addEventListener('click', () => {
      ui.v = { kind: 'all', product: 'all', q: b.dataset.partyVouchers };
      ui.shown = PAGE_SIZE;
      paintVouchers();
      document.getElementById('t-vouchers').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  };
  const vehicles = document.getElementById('t-vehicles');
  const paintVehicles = () => {
    vehicles.innerHTML = vehiclesHtml(a, { all: ui.vall });
    vehicles.querySelector('[data-vall]')?.addEventListener('click', () => { ui.vall = !ui.vall; paintVehicles(); });
  };

  // every voucher: kind, product, search, more, Excel
  const vbox = document.getElementById('t-vouchers');
  const paintVouchers = (focus = false) => {
    const list = filterVouchers(t.vouchers, { from: a.from, to: a.to, ...ui.v });
    vbox.innerHTML = vouchersHtml(list, ui.v, kinds, { shown: ui.shown });
    vbox.querySelectorAll('[data-vkind]').forEach((b) => b.addEventListener('click', () => { ui.v.kind = b.dataset.vkind; ui.shown = PAGE_SIZE; paintVouchers(); }));
    const q = vbox.querySelector('#v-q');
    q.addEventListener('input', debounce(() => { ui.v.q = q.value; ui.shown = PAGE_SIZE; paintVouchers(true); }, 200));
    if (focus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    vbox.querySelector('#v-product').addEventListener('change', (e) => { ui.v.product = e.target.value; ui.shown = PAGE_SIZE; paintVouchers(); });
    vbox.querySelector('[data-vmore]')?.addEventListener('click', () => { ui.shown += PAGE_SIZE; paintVouchers(); });
    vbox.querySelector('[data-vdownload]')?.addEventListener('click', () => guard(() => downloadSheets([{
      name: 'Vouchers', rows: voucherSheet(list), cols: [12, 16, 12, 10, 34, 13, 9, 11, 9, 13, 13, 13, 9, 40], filter: true,
    }], `Tally Vouchers ${rangeName(a.from, a.to)}.xlsx`)));
  };
  paintParties();
  paintVehicles();
  paintVouchers();
  bindCharts(body);
}

// a row button that opens the panel after it
function bindExpand(box, selector) {
  box.querySelectorAll(selector).forEach((b) => b.addEventListener('click', () => {
    const more = b.nextElementSibling;
    more.hidden = !more.hidden;
    b.setAttribute('aria-expanded', String(!more.hidden));
  }));
}

function renderTallyFin(body, r) {
  const t = state.tally;
  const ui = state.tallyUi;
  if (t.source !== 'xml') {
    body.innerHTML = `<section class="card"><h2>Financials</h2><p class="muted">The DayBook in Excel has only each voucher's party and amount — not the sales, purchase, expense, bank and tax ledgers the financials are made of. Open Tally's XML export (Export → Masters and Export → Transactions, both files together), or <b>Add a file</b> above.</p></section>`;
    return;
  }
  const stock = ui.closingStock !== '' && Number.isFinite(Number(ui.closingStock)) ? Number(ui.closingStock) : null;
  const f = financials(t.vouchers, t.masters, { from: r.from, to: r.to, closingStock: stock });
  body.innerHTML = finHtml(f, { closingStock: ui.closingStock, allExpenses: ui.allExp });
  body.querySelector('#fin-stock').addEventListener('submit', (e) => {
    e.preventDefault();
    ui.closingStock = e.target.stock.value.trim();
    renderTallyFin(body, r);
  });
  body.querySelector('[data-fin-nostock]')?.addEventListener('click', () => { ui.closingStock = ''; renderTallyFin(body, r); });
  body.querySelector('[data-fin-allexp]')?.addEventListener('click', () => { ui.allExp = !ui.allExp; renderTallyFin(body, r); });
  body.querySelector('[data-fin-trial]').addEventListener('click', () => guard(() => downloadSheets([
    { name: 'Trial balance', rows: trialSheet(f), cols: [20, 24, 36, 16, 16, 16, 16], filter: true },
    { name: 'Months', rows: [['Month', 'Sales', 'Purchases', 'Expenses', 'Other income', 'Result before stock', 'Money in', 'Money out', 'Cash & bank'],
      ...f.pl.monthly.map((m) => [m.month, m.sales, m.purchases, m.expenses, m.income, m.result, m.cashIn, m.cashOut, m.liquid])], cols: [10, 14, 14, 14, 14, 18, 14, 14, 14] },
  ], `Tally Financials ${rangeName(r.from, r.to)}.xlsx`)));
  bindCharts(body);
}

// the app's side of the comparison, fetched once per date
async function reconData(start, asOn) {
  const key = `${start}|${asOn}`;
  if (!state.tallyRecon || state.tallyRecon.key !== key) {
    const dash = await state.store.dashboard(asOn, asOn);
    const [statement, bulk] = await Promise.all([
      state.store.statementData(start, asOn),
      Promise.all(dash.groups.map(async ([code, title]) => ({ code, title: shortGroup(code, title), data: await state.store.account(null, code, null, null) }))),
    ]);
    state.tallyRecon = { key, accounts: appAccounts(statement, bulk, { from: start }), customers: dash.customers };
  }
  return state.tallyRecon;
}

async function renderTallyRecon(body, r) {
  const t = state.tally;
  const ui = state.tallyUi.recon;
  const live = t.vouchers.filter((v) => !v.cancelled);
  if (!live.length) { body.innerHTML = '<section class="card"><p class="muted">Every voucher in the file is cancelled — nothing to compare.</p></section>'; return; }
  // the app's sales run up to its last DayBook import: compare on that day
  // (or before), or Tally's later bills would read as missing from the app
  if (state.tallyAppUntil === undefined) {
    body.innerHTML = loadingHtml('Reading the app\'s ledgers…');
    state.tallyAppUntil = (await state.store.summary()).last_sale_date || null;
  }
  const appUntil = state.tallyAppUntil;
  const fallback = appUntil && appUntil >= r.span.from && appUntil < r.span.to ? appUntil : r.span.to;
  const asOn = ui.asOn && ui.asOn <= r.span.to ? ui.asOn : fallback;
  const { start } = reconStart(t.vouchers, t.masters, asOn);
  if (!state.tallyRecon || state.tallyRecon.key !== `${start}|${asOn}`) body.innerHTML = loadingHtml('Reading the app\'s ledgers…');
  const data = await reconData(start, asOn);
  const res = reconcile(data.accounts, t.vouchers, t.masters, { asOn, appCustomers: data.customers, map: ui.map });
  body.innerHTML = reconHtml(res, { filter: ui.filter, asOnMax: r.span.to, q: ui.q, appUntil });
  body.querySelector('#recon-date').addEventListener('submit', (e) => {
    e.preventDefault();
    ui.asOn = e.target.asOn.value;
    guard(() => renderTallyRecon(body, r));
  });
  body.querySelectorAll('[data-rfilter]').forEach((b) => b.addEventListener('click', () => { ui.filter = b.dataset.rfilter; guard(() => renderTallyRecon(body, r)); }));
  const q = body.querySelector('#recon-q');
  q.addEventListener('input', debounce(() => {
    ui.q = q.value;
    guard(async () => {
      await renderTallyRecon(body, r);
      const nq = body.querySelector('#recon-q');
      nq.focus();
      nq.setSelectionRange(nq.value.length, nq.value.length);
    });
  }, 250));
  bindExpand(body, '[data-recon]');
  body.querySelectorAll('[data-map-from]').forEach((b) => b.addEventListener('click', () => {
    ui.map[normName(b.dataset.mapFrom)] = b.dataset.mapTo;
    toast(`Comparing “${b.dataset.mapFrom}” with Tally's “${b.dataset.mapTo}” (until you close the file).`);
    guard(() => renderTallyRecon(body, r));
  }));
  body.querySelector('[data-recon-xlsx]').addEventListener('click', () => guard(() => downloadSheets([
    { name: 'Ledger vs Tally', rows: reconSheet(res), cols: [30, 14, 14, 14, 11, 18, 22, 14, 14, 14], filter: true },
  ], `Ledger vs Tally ${dmyDash(res.asOn)}.xlsx`)));
}

// the items left out of the stock totals (bought / sold), remembered on this device
const STOCK_OFF_KEY = (kind) => `vriddhi-ledger.tally-stock-off.${kind}`;
function stockOff(kind) {
  const ui = state.tallyUi.stock;
  ui.off = ui.off || {};
  if (!ui.off[kind]) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(STOCK_OFF_KEY(kind)) || '[]'); } catch { saved = []; }
    ui.off[kind] = new Set(Array.isArray(saved) ? saved : []);
  }
  return ui.off[kind];
}
function saveStockOff(kind) {
  try { localStorage.setItem(STOCK_OFF_KEY(kind), JSON.stringify([...stockOff(kind)])); } catch { /* private window: this visit only */ }
}

function renderTallyStock(body, r) {
  const t = state.tally;
  const ui = state.tallyUi.stock;
  const off = stockOff(ui.kind);
  const sum = stockSummary(t.vouchers, t.masters, { from: r.from, to: r.to, kind: ui.kind, category: ui.category, exclude: off });
  const months = monthsBetween(r.from, r.to);
  // ticking an item works the figures out again; the table keeps its scroll
  const recount = (key = null) => {
    const wrap = body.querySelector('.pivot-wrap');
    const at = wrap ? [wrap.scrollLeft, wrap.scrollTop] : null;
    saveStockOff(ui.kind);
    renderTallyStock(body, r);
    const again = body.querySelector('.pivot-wrap');
    if (again && at) [again.scrollLeft, again.scrollTop] = at;
    if (key) body.querySelector(`[data-sitem="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  };
  const paint = (focus = false) => {
    body.innerHTML = stockHtml(sum, months, ui);
    body.querySelectorAll('[data-sitem]').forEach((c) => c.addEventListener('change', () => {
      if (c.checked) off.delete(c.dataset.sitem); else off.add(c.dataset.sitem);
      recount(c.dataset.sitem);
    }));
    const shown = () => [...body.querySelectorAll('[data-sitem]')].map((c) => c.dataset.sitem);
    body.querySelector('[data-sall]')?.addEventListener('click', () => { shown().forEach((k) => off.delete(k)); recount(); });
    body.querySelector('[data-snone]')?.addEventListener('click', () => { shown().forEach((k) => off.add(k)); recount(); });
    body.querySelectorAll('[data-skind]').forEach((b) => b.addEventListener('click', () => { ui.kind = b.dataset.skind; renderTallyStock(body, r); }));
    body.querySelectorAll('[data-scat]').forEach((b) => b.addEventListener('click', () => { ui.category = b.dataset.scat; renderTallyStock(body, r); }));
    body.querySelectorAll('[data-smetric]').forEach((b) => b.addEventListener('click', () => { ui.metric = b.dataset.smetric; paint(); }));
    const q = body.querySelector('#stock-q');
    if (q) {
      q.addEventListener('input', debounce(() => { ui.q = q.value; paint(true); }, 200));
      if (focus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    body.querySelector('[data-stock-xlsx]')?.addEventListener('click', () => guard(() => {
      const cols = [36, 18, 10, ...months.map(() => 12), 14];
      return downloadSheets([
        { name: 'Litres & kg', rows: pivotSheet(sum, months, 'volume'), cols },
        { name: 'Packs', rows: pivotSheet(sum, months, 'packs'), cols },
        { name: 'Amount', rows: pivotSheet(sum, months, 'amount'), cols },
        { name: ui.kind === 'purchase' ? 'Suppliers' : 'Customers', rows: [['Name', 'Vouchers', 'Items (before GST)', 'Bills (with GST)'], ...sum.parties.map((p) => [p.name, p.vouchers, p.amount, p.total])], cols: [36, 10, 18, 18] },
      ], `${ui.kind === 'purchase' ? 'Purchases' : 'Sales'} ${ui.category === 'fuel' ? 'Fuel' : 'Lubricants'} ${rangeName(r.from, r.to)}.xlsx`);
    }));
    bindCharts(body);
  };
  paint();
}

// sheets: [{name, rows, cols: [widths], filter}] -> an .xlsx download
async function downloadSheets(sheets, fileName) {
  const XLSX = await loadSheetJS();
  const wb = XLSX.utils.book_new();
  for (const sh of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    if (sh.cols) ws['!cols'] = sh.cols.map((wch) => ({ wch }));
    if (sh.filter && sh.rows.length > 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sh.rows.length - 1, c: sh.rows[0].length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, sh.name.slice(0, 31));
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);
}

// Print only these pages (the browser's "Save as PDF" works too).
// ---------------------------------------------------------------------------
// Quotes: the Tanker Billing workbook's Quotation Maker, Proforma Invoice and
// PI Log (with its PrintAndLogPI / ReprintPIs macros)
// ---------------------------------------------------------------------------
const QUOTE_ASSETS = { pi: 'assets/letterhead.png', quote: 'assets/quote-letterhead.png', cn: 'assets/letterhead.png' };
const QUOTES_SCHEMA = 'The database needs an update for Quotes: run supabase/ledger-schema.sql again in the Supabase SQL Editor (safe to re-run).';
const QUOTE_TABS = [['', '#/quotes', 'Quotation'], ['pi', '#/quotes/pi', 'Proforma Invoice'], ['log', '#/quotes/log', 'PI Log'],
  ['cn', '#/quotes/cn', 'Credit Note'], ['cnlog', '#/quotes/cnlog', 'CN Log'], ['letter', '#/quotes/letter', 'Price Letter']];
const rs2 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(2));

async function quotesCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (/could not find the function|does not exist|schema cache|unknown setting/i.test(String((err && err.message) || err))) throw new Error(QUOTES_SCHEMA);
    throw err;
  }
}

// What the Quotes screens need, kept between screens (the pictures are big);
// an import or a stamp change drops it.
// the credit notes' log; null until supabase/ledger-schema.sql is re-run
const cnLogList = () => state.store.cnList().catch((err) => {
  if (/could not find the function|does not exist|schema cache/i.test(String((err && err.message) || err))) return null;
  throw err;
});
async function quotesData(fresh = false) {
  if (!fresh && state.quotes) {
    [state.quotes.log, state.quotes.cnLog] = await Promise.all([quotesCall(() => state.store.piList()), cnLogList()]);
    return state.quotes;
  }
  const [tb, tanker, log, piStamp, quoteStamp, piLetterhead, quoteLetterhead] = await quotesCall(() => Promise.all([
    state.store.setting('tanker_billing'), state.store.tankerList(), state.store.piList(), state.store.setting('pi_stamp'),
    state.store.setting('quote_stamp'), state.store.setting('pi_letterhead'), state.store.setting('quote_letterhead')]));
  // pictures added later: missing until the schema is re-run (a setting it doesn't know yet)
  const extra = (k) => state.store.setting(k).catch(() => null);
  const [cnLog, cnStamp, cnLetterhead, letterStamp] = await Promise.all([cnLogList(), extra('cn_stamp'), extra('cn_letterhead'), extra('letter_stamp')]);
  state.quotes = {
    tb, log, cnLog,
    tanker: [...tanker].sort((a, b) => a.company.localeCompare(b.company, 'en', { sensitivity: 'base' })),
    stamps: { pi: piStamp, quote: quoteStamp, cn: cnStamp, letter: letterStamp },
    letterheads: { pi: piLetterhead, quote: quoteLetterhead, cn: cnLetterhead },
  };
  return state.quotes;
}

// Pictures for a page: blob: URLs on screen (cheap to redraw), data: URLs
// for a PDF (a picture made from an SVG can't fetch anything).
const blobUrls = new Map();
function blobUrlOf(dataUrl) {
  if (!blobUrls.has(dataUrl)) {
    const [head, b64] = dataUrl.split(',');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    blobUrls.set(dataUrl, URL.createObjectURL(new Blob([bytes], { type: head.slice(5).split(';')[0] })));
  }
  return blobUrls.get(dataUrl);
}
function docImages(d, kind) {
  const lh = d.letterheads[kind];
  const st = d.stamps[kind];
  return { letterhead: lh ? blobUrlOf(lh.data_url) : QUOTE_ASSETS[kind], stamp: st ? blobUrlOf(st.data_url) : '' };
}
async function docImagesForPdf(d, kind) {
  const lh = d.letterheads[kind];
  const st = d.stamps[kind];
  return { letterhead: lh ? lh.data_url : await toDataUrl(QUOTE_ASSETS[kind]), stamp: st ? st.data_url : '' };
}

async function viewQuotes(tab) {
  const d = await quotesData();
  await useNarrowFont();
  const XLSX = await loadSheetJS();
  d.format = (f, v) => XLSX.SSF.format(f, v);
  d.model = d.tb && d.tb.model && d.tb.model.version >= 2 ? d.tb.model : null;
  d.macro = d.model ? piMacro(d.model) : DEFAULT_PI_MACRO;
  d.cnMac = d.model ? cnMacro(d.model) : null;
  if (tab === 'log') return viewPiLog(d);
  if (tab === 'cnlog') return viewCnLog(d);
  if (tab === 'letter') return viewPriceLetter(d);
  return viewDoc(d, tab === 'pi' ? 'proforma' : tab === 'cn' ? 'creditnote' : 'quotation');
}

function quotesHead(d, tab) {
  const tb = d.tb;
  let rsp = '';
  if (d.model) {
    const c = rspCell(d.model, d.macro);
    const v = c ? makeCalc(d.model, { format: d.format }).value(c.sheet, c.addr) : null;
    if (typeof v === 'number') rsp = ` · IOCL RSP ₹${rs2(v)}`;
  }
  const info = tb
    ? `From <b>${esc(tb.file_name || 'the Tanker Billing workbook')}</b>, imported ${esc(new Date(tb.imported_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))} · ${plural(d.tanker.length, 'customer')}${rsp}`
    : 'Import the <b>Tanker Billing</b> workbook: the app reads its Quotation Maker and Proforma Invoice sheets — layout, wording and formulas — its customers and tables, and its PI Log.';
  return `<section class="card">
    <div class="quote-head"><h2>Quotes</h2>
      <label class="file"><input type="file" id="tb-file" accept=".xlsm,.xlsx"><span class="btn ${tb ? 'ghost small' : ''}">${tb ? 'Import again' : 'Import Tanker Billing.xlsm'}</span></label></div>
    <p class="muted small">${info}</p>
    <nav class="chips">${QUOTE_TABS.map(([k, href, name]) => `<a class="chip${k === tab ? ' on' : ''}" href="${href}">${name}</a>`).join('')}</nav>
    <div id="tb-out"></div>
  </section>`;
}

function bindTankerImport(inputId = 'tb-file', outId = 'tb-out') {
  document.getElementById(inputId)?.addEventListener('change', (e) => e.target.files[0] && tankerChosen(e.target.files[0], e.target, outId));
}

// what the import's self-check found that touches one sheet
function checkNote(d, sheet) {
  const ck = d.tb && d.tb.model_check;
  if (!ck) return '';
  const bad = (ck.bad || []).filter((b) => b.sheet === sheet || b.sheet === 'Customers');
  const unknown = (ck.unknown || []);
  if (!bad.length && !unknown.length) return '';
  return `<div class="pi-check warn"><b>⚠ The app works out ${plural(bad.length, 'cell')} of this workbook differently from Excel</b>
    <p class="small">Check these before sending — tell Claude about them if they're wrong:</p>
    <ul class="small">${bad.slice(0, 8).map((b) => `<li>${esc(b.sheet)}!${esc(b.addr)} <code>=${esc(String(b.f).slice(0, 80))}</code>: Excel <b>${esc(String(b.excel ?? ''))}</b>, app <b>${esc(String(b.app ?? ''))}</b></li>`).join('')}
      ${unknown.slice(0, 5).map((u) => `<li>Not known to the app: ${esc(u)}</li>`).join('')}</ul></div>`;
}

// ---- a document: the Quotation Maker or the Proforma Invoice ----
// The form asks for the sheet's input cells (blue text, drop-downs; for the
// PI also what Print & Log PI restores on a reprint); the page and the
// Calculated panel are the sheet's own formulas, worked out live.
const DOC_TITLE = { quotation: 'Quotation', proforma: 'Proforma Invoice', creditnote: 'Credit Note' };
function viewDoc(d, docKey) {
  const tab = { proforma: 'pi', creditnote: 'cn' }[docKey] || '';
  const kind = { proforma: 'pi', creditnote: 'cn' }[docKey] || 'quote';
  const isCn = docKey === 'creditnote';
  if (isCn && d.model && (!d.model.sheets[DOCS.creditnote.sheet] || !d.model.sheets[DOCS.creditnote.sheet].layout || d.cnLog === null)) {
    setMain(`${quotesHead(d, tab)}<section class="card"><p class="warn-text"><b>${d.cnLog === null
      ? 'The database needs an update for credit notes: run supabase/ledger-schema.sql again in the Supabase SQL Editor (safe to re-run).'
      : `Import the latest Tanker Billing workbook — this one has no “${esc(DOCS.creditnote.sheet)}” sheet.`}</b></p></section>`);
    bindTankerImport();
    return;
  }
  if (!d.model) {
    setMain(`${quotesHead(d, tab)}${d.tb ? `<section class="card"><p class="warn-text"><b>Import the Tanker Billing workbook again.</b> The app now takes the ${esc(DOCS[docKey].sheet)} sheet straight from the workbook — its layout, wording and formulas — so changes you make in Excel need no change to the app.</p></section>` : ''}`);
    bindTankerImport();
    return;
  }
  const { model, format } = d;
  const macro = docKey === 'proforma' ? d.macro : null;
  const sheet = DOCS[docKey].sheet;
  const base = makeCalc(model, { format });
  const inputs = inputsOf(model, docKey, base, macro);
  const helpers = helperRows(model, docKey, inputs);
  const rspAt = rspCell(model, d.macro);
  const rspSaved = rspAt ? base.value(rspAt.sheet, rspAt.addr) : null;
  const custInput = inputs.find((x) => x.kind === 'select' && x.options && d.tanker.some((t) => x.options.includes(t.company)))
    || inputs.find((x) => x.kind === 'select');
  const dateInput = docKey === 'proforma' ? inputs.find((x) => x.addr === (macro.pdf.date || macro.write.pi_date)) : inputs.find((x) => x.kind === 'date');
  const piNoAddr = docKey === 'proforma' ? macro.write.pi_no : null;
  const cnMac = isCn ? d.cnMac : null;
  const cnNoAddr = isCn ? cnMac.no : null;
  const cnNext = () => nextCnNo(d.cnLog || [], cnMac, model, base);
  const sameCn = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const forms = state.docForms || (state.docForms = {});
  const today = todayIso();
  if (!forms[docKey]) {
    const values = {};
    for (const x of inputs) {
      if (x.formula) continue;                                   // worked out until typed over
      const c = model.sheets[sheet].cells[x.addr] || {};
      values[x.addr] = formValue(x.kind, c.v);
    }
    if (dateInput && !dateInput.formula) values[dateInput.addr] = today;
    if (piNoAddr) values[piNoAddr] = nextPiNo(d.log, today);
    for (const x of inputs) if (x.kind === 'month' && !x.formula) values[x.addr] = today.slice(0, 7);
    if (cnNoAddr) { values[cnNoAddr] = cnNext(); for (const a of cnMac.clear) if (inputs.some((x) => x.addr === a)) values[a] = ''; }
    forms[docKey] = { values, overrides: {}, rsp: '' };
  }
  const f = forms[docKey];
  if (cnNoAddr && (!f.values[cnNoAddr] || (d.cnLog || []).some((r) => sameCn(r.cn_no, f.values[cnNoAddr])))) f.values[cnNoAddr] = cnNext();
  if (piNoAddr && (!f.values[piNoAddr] || d.log.some((r) => samePiNo(r.pi_no, f.values[piNoAddr])))) f.values[piNoAddr] = nextPiNo(d.log, f.values[dateInput ? dateInput.addr : ''] || today);

  const control = (x) => {
    const v = f.values[x.addr] ?? '';
    const ph = x.formula ? ` placeholder="${esc(formValue(x.kind, base.value(sheet, x.addr)))} (worked out)"` : '';
    const attrs = `name="${esc(x.addr)}" data-kind="${x.kind}"`;
    if (x.kind === 'select') {
      const opts = x.options.includes(v) || !v ? x.options : [v, ...x.options];
      return `<select ${attrs}>${opts.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    if (x.kind === 'textarea') return `<textarea ${attrs} rows="3"${ph}>${esc(v)}</textarea>`;
    if (x.kind === 'date') return `<input type="date" ${attrs} value="${esc(v)}">`;
    if (x.kind === 'month') return `<input type="month" ${attrs} value="${esc(v)}">`;
    if (x.kind === 'number') return `<input type="number" step="any" ${attrs} value="${esc(v)}"${ph}>`;
    return `<input ${attrs} value="${esc(v)}"${ph}>`;
  };
  // "QUOTATION TO" -> "Quotation to"
  const nice = (t) => (/[a-z]/.test(t) ? t : t.charAt(0) + t.slice(1).toLowerCase());
  const hint = (x) => (x.formula && x.kind === 'date' ? `<span class="muted small field-hint">Blank = ${esc(base.text(sheet, x.addr))}, as the sheet works it out</span>` : '');
  const field = (x) => `<label class="${x.kind === 'textarea' ? 'wide' : ''}">${esc(nice(x.label))} <span class="muted small cell-ref">${esc(x.addr)}</span>${control(x)}${hint(x)}</label>`;
  const pageInputs = inputs.filter((x) => !x.outside);
  const sideInputs = inputs.filter((x) => x.outside);
  const lastNo = [...d.log].sort((a, b) => b.id - a.id)[0];
  const lastCn = isCn ? [...(d.cnLog || [])].sort((a, b) => b.id - a.id)[0] : null;
  const buttons = isCn
    ? `<p class="actions"><button class="btn" id="doc-pdf">Save PDF &amp; log</button><button class="btn ghost" id="doc-share">Share &amp; log</button><button class="btn ghost" id="doc-print">Print &amp; log</button></p>
       <p class="muted small">Like the sheet's <b>Save/Print &amp; Log</b> button: the credit note is added to the <a href="#/quotes/cnlog">CN Log</a> as it goes out${cnMac.from === 'macro' ? ' — what it logs is read from the workbook\'s own macro' : ''}. A number already in the log isn't logged again: reprint it from the log as a duplicate copy, or change the number.${lastCn ? ` Last logged: <b>${esc(lastCn.cn_no)}</b> (${esc(lastCn.customer)}, ${fmtDate(lastCn.cn_date)}).` : ''}</p>
       ${cnMac.note ? `<p class="warn-text small">${esc(cnMac.note)}</p>` : ''}`
    : docKey === 'proforma'
    ? `<p class="actions"><button class="btn" id="doc-pdf">Save PDF &amp; log</button><button class="btn ghost" id="doc-share">Share &amp; log</button><button class="btn ghost" id="doc-print">Print &amp; log</button></p>
       <p class="muted small">Like the <b>Print &amp; Log PI</b> button: the PI is written to the PI Log as it goes out${macro.from === 'macro' ? ' — the cells it logs are read from the workbook\'s own macro' : ''}. A PI No. already in the log asks before replacing that entry.${lastNo ? ` Last logged: <b>${esc(lastNo.pi_no)}</b> (${esc(lastNo.customer)}, ${fmtDate(lastNo.pi_date)}).` : ''}</p>
       ${macro.note ? `<p class="warn-text small">${esc(macro.note)}</p>` : ''}`
    : '<p class="actions"><button class="btn" id="doc-pdf">Download PDF</button><button class="btn ghost" id="doc-share">Share</button><button class="btn ghost" id="doc-print">Print</button></p>';
  setMain(`${quotesHead(d, tab)}
    <div class="doc-wrap">
      <section class="card doc-form">
        <h3>${esc(DOC_TITLE[docKey])}</h3>
        ${checkNote(d, sheet)}
        <form id="doc-form" autocomplete="off">
          <div class="two">${pageInputs.map(field).join('')}</div>
          ${piNoAddr || cnNoAddr ? '<p class="muted small" id="doc-no-note"></p>' : ''}
          ${sideInputs.length ? `<h4>Inputs beside the page</h4><div class="two">${sideInputs.map(field).join('')}</div>` : ''}
          ${rspAt ? `<div class="two"><label>IOCL RSP at our RO (₹/Ltr) <span class="muted small cell-ref">${esc(rspAt.sheet)}!${esc(rspAt.addr)}</span><input name="__rsp" type="number" step="0.01" min="0" value="${esc(f.rsp)}" placeholder="${esc(rs2(rspSaved))} (the workbook's)"></label><span></span></div>` : ''}
        </form>
        ${helpers.length ? '<h4>Calculated <span class="muted small">— tap ✎ to change one for this document</span></h4><div class="table-wrap"><table class="compact kv calc" id="doc-calc"></table></div>' : ''}
        ${buttons}
        ${stampRow(d.stamps[kind], 'doc-stamp', 'doc-stamp-remove', { proforma: 'proforma invoices', creditnote: 'credit notes' }[docKey] || 'quotations')}
      </section>
      <section class="doc-preview"><div class="doc-page" id="doc-page"></div></section>
    </div>`);
  bindTankerImport();
  bindStamp(`${kind}_stamp`, 'doc-stamp', 'doc-stamp-remove', async () => { state.quotes = null; await route(); });

  const form = document.getElementById('doc-form');
  const measure = canvasMeasure();
  const layout = layoutOf(model, docKey);
  const images = docImages(d, kind);
  const byAddr = new Map(inputs.map((x) => [x.addr, x]));
  const docState = () => {
    const ins = {};
    for (const x of inputs) {
      const raw = f.values[x.addr];
      if (x.formula && (raw == null || raw === '')) continue;
      ins[x.addr] = cellInput(x.kind, raw);
    }
    // the sheet's "Next Credit Note No." counts Excel's log: here, the app's
    return { inputs: ins, overrides: cnMac && cnMac.next ? { ...f.overrides, [cnMac.next]: cnNext() } : f.overrides, rsp: f.rsp };
  };
  const calcNow = () => docCalc(model, docKey, docState(), { format, macro: d.macro });
  const page = (calc, imgs = images, fontCss = '') => sheetSvg(layout, { values: pageValues(model, docKey, calc, format), images: imgs, measure, fontCss });
  const render = () => {
    const calc = calcNow();
    if (piNoAddr) {
      const no = String(f.values[piNoAddr] || '').trim();
      const dup = d.log.find((r) => samePiNo(r.pi_no, no));
      const vt = macro.write.valid_to ? calc.text(sheet, macro.write.valid_to) : '';
      document.getElementById('doc-no-note').innerHTML = dup
        ? `<span class="warn-text">${esc(no)} is already in the PI Log (Log ID ${dup.id}: ${esc(dup.customer)}, ${fmtDate(dup.pi_date)}) — it will ask before replacing it.</span>`
        : `The next number after the PI Log's highest (still yours to change).${vt ? ` Valid up to <b>${esc(vt)}</b>.` : ''}`;
    }
    if (cnNoAddr) {
      const no = String(f.values[cnNoAddr] || '').trim();
      const dup = (d.cnLog || []).find((r) => sameCn(r.cn_no, no));
      document.getElementById('doc-no-note').innerHTML = dup
        ? `<span class="warn-text">${esc(no)} is already in the CN Log (${esc(dup.customer)}, ${fmtDate(dup.cn_date)}) — it can't be logged again; change the number, or reprint it from the CN Log.</span>`
        : 'The next number after the CN Log\'s highest (still yours to change).';
    }
    const tbl = document.getElementById('doc-calc');
    if (tbl) {
      tbl.innerHTML = helpers.map((h) => {
        if (h.kind === 'head') return `<tr class="calc-head"><td colspan="2">${esc(h.text)}</td></tr>`;
        if (h.kind === 'note') return `<tr><td colspan="2" class="muted small">${esc(h.text)}</td></tr>`;
        const changed = Object.prototype.hasOwnProperty.call(f.overrides, h.addr);
        return `<tr><td>${esc(h.label)}</td><td class="r"><span class="${changed ? 'changed' : ''}">${esc(calc.text(sheet, h.addr))}</span>
          <button type="button" class="btn ghost small" data-edit="${esc(h.addr)}" title="Change it for this document">✎</button>${changed ? `<button type="button" class="btn ghost small" data-reset="${esc(h.addr)}" title="Back to the workbook's formula">↺</button>` : ''}</td></tr>`;
      }).join('');
    }
    document.getElementById('doc-page').innerHTML = page(calc);
  };
  const later = debounce(render, 120);
  form.addEventListener('input', (e) => {
    const el = e.target;
    if (el.name === '__rsp') f.rsp = el.value;
    else if (byAddr.has(el.name)) f.values[el.name] = el.value;
    later();
  });
  form.addEventListener('change', (e) => {
    const el = e.target;
    if (custInput && el.name === custInput.addr) {
      // a new customer: what was typed over the worked-out cells goes back to the formulas
      for (const x of inputs) if (x.formula) { f.values[x.addr] = ''; const i = form.querySelector(`[name="${x.addr}"]`); if (i) i.value = ''; }
      f.overrides = {};
    }
    if (piNoAddr && dateInput && el.name === dateInput.addr) {
      const no = f.values[piNoAddr];
      if (!no || /^PI\//i.test(no)) { f.values[piNoAddr] = nextPiNo(d.log, el.value || today); form.querySelector(`[name="${piNoAddr}"]`).value = f.values[piNoAddr]; }
    }
    render();
  });
  document.getElementById('doc-calc')?.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    const rs = e.target.closest('[data-reset]');
    if (rs) { delete f.overrides[rs.dataset.reset]; render(); return; }
    if (!ed) return;
    const a = ed.dataset.edit;
    const now = calcNow().value(sheet, a);
    const typed = window.prompt(`${helpers.find((h) => h.addr === a)?.label || a} — for this document only (blank = the workbook's formula):`, formValue(typeof now === 'number' ? 'number' : 'text', now));
    if (typed == null) return;
    if (typed.trim() === '') delete f.overrides[a];
    else f.overrides[a] = typeof now === 'number' && Number.isFinite(Number(typed)) ? Number(typed) : typeof now === 'boolean' ? /^(true|yes|1)$/i.test(typed.trim()) : typed;
    render();
  });
  render();

  const nameNow = (calc) => (isCn ? cnFileName(calc, cnMac) : docKey === 'proforma'
    ? docFileName(docKey, calc, { customerAddr: macro.pdf.customer, dateAddr: macro.pdf.date, word: macro.pdf.word })
    : docFileName(docKey, calc, { customerAddr: custInput && custInput.addr, dateAddr: dateInput && dateInput.addr }));
  const pdfOf = async (calc) => pdfFromSvgs([page(calc, await docImagesForPdf(d, kind), await narrowFontCss())], A4, { scale: 3 });
  const run = (id, fn) => {
    const btn = document.getElementById(id);
    btn.addEventListener('click', () => guard(async () => {
      const old = btn.textContent;
      btn.disabled = true;
      try { await fn(btn); } finally { btn.disabled = false; btn.textContent = old; }
    }));
  };
  if (docKey === 'quotation') {
    run('doc-pdf', async (btn) => { btn.textContent = 'Making…'; const c = calcNow(); const n = nameNow(c); download(await pdfOf(c), n); toast(`Saved ${n}`); });
    run('doc-share', async (btn) => { btn.textContent = 'Making…'; const c = calcNow(); const n = nameNow(c); await shareOrSave([new File([await pdfOf(c)], n, { type: 'application/pdf' })], n); });
    run('doc-print', async () => printPages([page(calcNow())], A4));
    return;
  }
  if (isCn) {
    // PrintAndLogXPCreditNote: the checks, a number already logged refused, the question, the PDF, the log
    const outCn = async (how, btn) => {
      const calc = calcNow();
      const problem = cnProblem(calc, cnMac);
      if (problem) throw new Error(`Please fix: ${problem}.`);
      const no = String(calc.value(sheet, cnNoAddr) ?? '').trim();
      const dup = (d.cnLog || []).find((r) => sameCn(r.cn_no, no));
      if (dup) throw new Error(`Credit Note ${no} is already in the log. Reprint it from the CN Log, or change the Credit Note No.`);
      const F = cnFields(cnMac);
      const row = cnLogRowOf(calc, cnMac, model);
      if (!window.confirm(`Create and log Credit Note ${no}\n${row[F.customer] || ''}\nCredit: Rs. ${indian(row[F.credit])}`)) return;
      const name = nameNow(calc);
      let blob = null;
      if (how !== 'print') { btn.textContent = 'Making PDF…'; blob = await pdfOf(calc); }
      if (F.printed_at) row[F.printed_at] = new Date().toISOString();
      if (F.printed_by) row[F.printed_by] = state.me.email;
      if (F.reprints) row[F.reprints] = 0;
      if (F.file) row[F.file] = how === 'print' ? 'Printed' : name;
      const snap = {};
      for (const x of inputs) { const v = calc.value(sheet, x.addr); snap[x.addr] = isErr(v) ? null : v; }
      const rec = { ...cnRecord(row, cnMac), printed_by: state.me.email, doc: { inputs: snap, overrides: f.overrides } };
      const res = await quotesCall(() => state.store.cnSave(rec));
      if (res.status === 'exists') throw new Error(`Credit Note ${no} is already in the log. Reprint it from the CN Log, or change the Credit Note No.`);
      if (how === 'print') printPages([page(calc)], A4);
      else if (how === 'share') await shareOrSave([new File([blob], name, { type: 'application/pdf' })], name);
      else download(blob, name);
      toast(`Credit Note ${no} logged${how === 'pdf' ? ` — saved ${name}` : ''}.`);
      d.cnLog = await cnLogList();
      // ready for the next note: the next number, the amount cleared
      f.values[cnNoAddr] = cnNext();
      for (const a of cnMac.clear) if (byAddr.has(a)) f.values[a] = '';
      for (const a of [cnNoAddr, ...cnMac.clear]) { const el = form.querySelector(`[name="${a}"]`); if (el) el.value = f.values[a] ?? ''; }
      render();
    };
    run('doc-pdf', (btn) => outCn('pdf', btn));
    run('doc-share', (btn) => outCn('share', btn));
    run('doc-print', (btn) => outCn('print', btn));
    return;
  }
  // PrintAndLogPI: the macro's checks, the PDF, the duplicate question, the log
  const out = async (how, btn) => {
    const calc = calcNow();
    const problem = piProblem(calc, macro);
    if (problem) throw new Error(problem);
    const name = nameNow(calc);
    let blob = null;
    if (how !== 'print') { btn.textContent = 'Making PDF…'; blob = await pdfOf(calc); }
    const snap = {};
    for (const x of inputs) { const v = calc.value(sheet, x.addr); snap[x.addr] = isErr(v) ? null : v; }
    for (const [a, v] of Object.entries(f.overrides)) snap[a] = v;
    const row = { ...piLogRowOf(calc, macro, model, { inputs: snap }), printed_by: state.me.email };
    let res = await quotesCall(() => state.store.piSave(row, false));
    if (res.status === 'exists') {
      const e = res.existing;
      const ok = window.confirm(`Proforma Invoice No. ${row.pi_no} is ALREADY LOGGED.\n\nExisting entry (Log ID ${e.id}):\n   Customer : ${e.customer}\n   PI Date  : ${dmyy(e.pi_date)}\n   Quantity : ${indian(e.qty)} Ltr\n   Rate     : ${rs2(e.rate)} /Ltr\n   Total    : ${indian(e.grand_total)}\n   Logged   : ${e.printed_at ? new Date(e.printed_at).toLocaleString('en-IN') : ''}\n\nReplace that log entry with the current invoice?\n\n   OK = replace the log entry and ${how === 'print' ? 'print' : 'save'} the PI\n   Cancel = do nothing`);
      if (!ok) return;
      res = await quotesCall(() => state.store.piSave(row, true));
    }
    if (how === 'print') printPages([page(calc)], A4);
    else if (how === 'share') await shareOrSave([new File([blob], name, { type: 'application/pdf' })], name);
    else download(blob, name);
    toast(`${res.status === 'replaced' ? 'Log entry REPLACED for' : 'Logged'} ${row.pi_no}${how === 'pdf' ? ` — saved ${name}` : ''}.`);
    d.log = await quotesCall(() => state.store.piList());
    f.values[piNoAddr] = nextPiNo(d.log, f.values[dateInput ? dateInput.addr : ''] || today);
    form.querySelector(`[name="${piNoAddr}"]`).value = f.values[piNoAddr];
    render();
  };
  run('doc-pdf', (btn) => out('pdf', btn));
  run('doc-share', (btn) => out('share', btn));
  run('doc-print', (btn) => out('print', btn));
}

// ---- PI Log and reprints (ReprintPIs) ----
// The whole log is shown: the Excel file's PI Log sheet (brought in by the
// import) plus every PI made here. Each import checks the two against each
// other; what doesn't match is reported here until the next import.
const PI_LOG_HEAD = ['Log ID', 'PI No.', 'PI Date', 'Valid Up To', 'Customer', 'Buyer GSTIN', 'Place of Supply', 'P.O. No.', 'P.O. Date', 'Description',
  'HSN Code', 'Quantity (Ltr)', 'Rate (₹/Ltr)', 'IOCL RSP (₹/Ltr)', 'Discount (₹/Ltr)', 'Sub Total (₹)', 'Round Off (₹)', 'Grand Total (₹)',
  'XtraPower Points', 'Effective Rate (₹/Ltr)', 'Amount in Words', 'Contact Person', 'Printed On', 'Printed By'];
const num = (v) => (v == null || v === '' ? '' : Number(v));
// real Excel dates, in the PI Log sheet's formats, so pasted rows are dates there too
const xlDay = (iso) => (iso ? { t: 'n', v: isoToSerial(iso), z: 'dd/mm/yyyy' } : '');
const xlStamp = (ts) => {
  if (!ts) return '';
  const ist = new Date(new Date(ts).getTime() + 330 * 60000);          // the sheet's clock is India time
  return { t: 'n', v: isoToSerial(ist.toISOString().slice(0, 10)) + (ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds()) / 86400, z: 'dd/mm/yyyy hh:mm' };
};
// the PI Log sheet's columns, in its order (to paste into Excel)
const piLogSheet = (rows) => ({
  name: 'PI Log', filter: true, cols: [8, 16, 11, 11, 34, 24, 14, 14, 13, 24, 10, 12, 11, 12, 12, 14, 11, 14, 14, 12, 50, 22, 18, 20],
  rows: [PI_LOG_HEAD, ...[...rows].sort((a, b) => a.id - b.id).map((r) => [r.id, r.pi_no, xlDay(r.pi_date), xlDay(r.valid_to), r.customer, r.gstin,
    r.place, r.po_no, xlDay(r.po_date), r.description, r.hsn, num(r.qty), num(r.rate), num(r.rsp), piDiscount(r), num(r.sub_total), num(r.round_off),
    num(r.grand_total), num(r.points), piEffective(r), r.words, r.contact, xlStamp(r.printed_at), r.printed_by])],
});

const checkValue = (c, v) => {
  if (v == null || v === '') return '—';
  if (c.kind === 'date') return fmtDate(v);
  if (c.kind === 'num') return ['rate', 'rsp'].includes(c.field) ? rs2(v) : indian(v);
  return String(v);
};
const piRef = (r) => `<b>${esc(r.pi_no)}</b> <span class="muted">${esc(r.customer)}${r.pi_date ? `, ${fmtDate(r.pi_date)}` : ''}</span>`;

// The PI Log check: Excel's PI Log sheet against the app's log.
// before: in the import preview (what the import will do); otherwise on the
// PI Log screen (what it did), with the app's PIs that Excel still lacks
// worked out from today's log.
function piCheckHtml(check, { before = false, log = [], fileName = '', when = '' } = {}) {
  const excel = new Set((check.excel_nos || []).map(piKey));
  const inLog = new Set(log.map((r) => piKey(r.pi_no)));
  const missing = before ? check.missing_in_excel : log.filter((r) => !excel.has(piKey(r.pi_no)));
  const differ = before ? check.differ : check.differ.filter((d) => inLog.has(piKey(d.pi_no)));
  const clean = !differ.length && !missing.length && !check.twice_in_excel.length;
  const head = before ? 'PI Log check — the Excel file against the app' : `PI Log check — against ${esc(fileName || 'the Excel file')}${when ? `, imported ${esc(when)}` : ''}`;
  if (clean) {
    return `<div class="pi-check good"><b>✓ ${head}</b><p>Excel's PI Log and the app's match: ${plural(check.same + (before ? check.new_from_excel.length : 0), 'PI')} alike${before && check.new_from_excel.length ? `, ${check.new_from_excel.length} of them new to the app` : ''}.</p></div>`;
  }
  const parts = [];
  if (differ.length) {
    parts.push(`<h4>${plural(differ.length, 'PI')} with different figures</h4>
      <div class="table-wrap"><table class="compact"><thead><tr><th>PI</th><th>What differs (Excel → app)</th><th>Result</th></tr></thead><tbody>${differ.map((d) => `<tr>
        <td>${piRef(d)}</td>
        <td>${d.changes.map((c) => `${esc(c.label)}: <b>${esc(checkValue(c, c.excel))}</b> in Excel, <b>${esc(checkValue(c, c.app))}</b> in the app`).join('<br>')}</td>
        <td class="small">${d.kept === 'app'
    ? `Made in the app — the app's figures ${before ? 'will be' : 'were'} kept. Correct Excel, or make the PI again here.`
    : `From an earlier import — ${before ? 'Excel\'s figures will be taken' : 'Excel\'s figures were taken'}.`}</td></tr>`).join('')}</tbody></table></div>`);
  }
  if (missing.length) {
    parts.push(`<h4>${plural(missing.length, 'PI')} in the app but not in Excel's PI Log</h4>
      <ul class="small">${missing.map((r) => `<li>${piRef(r)} — ${r.source === 'app' ? 'made in the app' : 'from an earlier import, since removed from Excel'}</li>`).join('')}</ul>
      ${before ? '' : '<p><button class="btn ghost small" id="pi-missing-xlsx">Download them for Excel</button> <span class="muted small">— the PI Log sheet\'s columns, to paste under its last row.</span></p>'}`);
  }
  if (check.twice_in_excel.length) {
    parts.push(`<h4>Listed twice in Excel's PI Log</h4><ul class="small">${check.twice_in_excel.map((r) => `<li>${piRef(r)} — only the first row is used</li>`).join('')}</ul>`);
  }
  const alike = check.same + (before ? 0 : check.new_from_excel.length);
  return `<div class="pi-check warn"><b>⚠ ${head}: they don't match</b>
    <p class="small">${plural(alike, 'PI')} alike${before && check.new_from_excel.length ? ` · ${check.new_from_excel.length} new from Excel (will be added)` : ''}.</p>
    ${parts.join('')}</div>`;
}

// ---- the Price Letter ("TO WHOMSOEVER IT MAY CONCERN": the RSP on a day or over a period) ----
// Made in the format of the Word file (assets/price-letter.docx). Each day's
// price is the app's price history — the day's RSP, the highest price billed
// that day (Home's Day's RSP) — and can be typed over. A period with more
// than one price lists them in a table.
const LETTER_TEMPLATE = 'assets/price-letter.docx';
async function letterPrices(from, to) {
  const k = `${from}|${to}`;
  if (!state.letterRsp || state.letterRsp.k !== k) state.letterRsp = { k, rsp: dayRsp((await state.store.dashboard(from, to)).rsp) };
  return state.letterRsp.rsp;
}
// the stamp: the letter's own, else the Proforma's / credit note's from the workbook, else the app's
const letterStampOf = (d) => d.stamps.letter || d.stamps.pi || d.stamps.cn || null;

async function viewPriceLetter(d) {
  const today = todayIso();
  const L = state.letter || (state.letter = { mode: 'day', date: today, from: `${today.slice(0, 7)}-01`, to: today, product: 'HSD', typed: {} });
  const from = L.mode === 'day' ? L.date : L.from;
  const to = L.mode === 'day' ? L.date : L.to;
  let problem = '';
  if (!from || !to || to < from) problem = 'Pick a From date on or before the To date.';
  else if (to > today) problem = 'The letter can only be for dates up to today.';
  else if (daysBetween(from, to) > 365) problem = 'Pick at most a year at a time.';
  const rsp = problem ? null : await letterPrices(from, to);
  const dates = problem ? [] : dateRange(from, to);
  // each day's price from the history; the last days with no bill yet (today, say) carry the
  // last price known in the week before — marked, to check
  const carried = new Map();
  const histPrice = (x) => {
    const v = rsp.at(L.product, x);
    if (v != null) return v;
    for (let i = 1; i <= 7; i++) {
      const back = addDays(x, -i);
      const w = rsp.at(L.product, back);
      if (w == null) continue;
      for (let j = 1; j <= 7 && addDays(x, j) <= today; j++) if (rsp.at(L.product, addDays(x, j)) != null) return null;   // a later price is known: don't guess
      carried.set(x, back);
      return w;
    }
    return null;
  };
  // the history's runs of one price (a carried price kept apart); a price typed for a run is used for all its days
  const hist = [];
  for (const x of dates) {
    const price = histPrice(x);
    const c = carried.has(x);
    const last = hist[hist.length - 1];
    if (last && last.price === price && last.carried === c) last.to = x;
    else hist.push({ from: x, to: x, price, carried: c });
  }
  const typedOf = (r) => L.typed[`${L.product}|${r.from}|${r.to}`];
  const priceOf = (r) => { const t = typedOf(r); return t != null && t !== '' && Number(t) > 0 ? Number(t) : r.price; };
  const days = hist.flatMap((r) => dateRange(r.from, r.to).map((x) => ({ date: x, price: priceOf(r) })));
  const missing = hist.filter((r) => priceOf(r) == null);
  const ranges = priceRanges(days);
  const text = !problem && !missing.length && dates.length ? letterText({ product: L.product, from, to, ranges }) : null;
  const P = LETTER_PRODUCTS[L.product];
  setMain(`${quotesHead(d, 'letter')}
    <div class="doc-wrap">
      <section class="card doc-form">
        <h3>Price Letter</h3>
        <p class="muted small">“To whomsoever it may concern” — the RSP of a product at our outlet on a day or over a period, in the format of your Word letter. The price comes from the app's <b>price history</b> (the day's RSP: the highest price billed that day, as on Home); type over it if it's wrong or missing.</p>
        <form id="letter-form" autocomplete="off">
          <div class="two">
            <label>Product <select name="product">${Object.entries(LETTER_PRODUCTS).map(([k, x]) => `<option value="${k}"${k === L.product ? ' selected' : ''}>${esc(x.name)} (${k})</option>`).join('')}</select></label>
            <label>For <select name="mode"><option value="day"${L.mode === 'day' ? ' selected' : ''}>One day</option><option value="period"${L.mode === 'period' ? ' selected' : ''}>A period</option></select></label>
            ${L.mode === 'day' ? `<label>Date <input type="date" name="date" value="${esc(L.date)}" max="${today}"></label><span></span>`
    : `<label>From <input type="date" name="from" value="${esc(L.from)}" max="${today}"></label><label>To <input type="date" name="to" value="${esc(L.to)}" max="${today}"></label>`}
          </div>
          ${problem ? `<p class="warn-text">${esc(problem)}</p>` : `<h4>${L.mode === 'day' ? 'Price' : 'Prices'} <span class="muted small">₹ per litre</span></h4>
          <div class="letter-prices">${hist.map((r) => {
    const t = typedOf(r);
    return `<div class="letter-row"><span class="nw">${r.from === r.to ? esc(dmyLetter(r.from)) : `${esc(dmyLetter(r.from))} – ${esc(dmyLetter(r.to))}`}</span>
              <input type="number" step="0.01" min="0" inputmode="decimal" data-range="${esc(`${L.product}|${r.from}|${r.to}`)}" value="${esc(t ?? '')}" placeholder="${r.price != null ? esc(price2(r.price)) : 'type it'}" aria-label="Price, ₹ per litre">
              <small>${t != null && t !== '' ? '<span class="tag warn">typed</span>' : r.price != null && r.carried ? `<span class="warn-text">no bill yet — the price of ${esc(dmyLetter(carried.get(r.from)))}; check it</span>` : r.price != null ? '<span class="muted">from the price history</span>' : '<span class="warn-text">no price recorded — type it</span>'}</small></div>`;
  }).join('')}</div>
          ${L.mode === 'period' && ranges.length > 1 ? `<p class="muted small">The price changed during the period: the letter lists each price with its dates.</p>` : ''}`}
        </form>
        <p class="actions"><button class="btn" id="letter-docx"${text ? '' : ' disabled'}>Download Word</button><button class="btn ghost" id="letter-pdf"${text ? '' : ' disabled'}>PDF</button><button class="btn ghost" id="letter-share"${text ? '' : ' disabled'}>Share</button><button class="btn ghost" id="letter-print"${text ? '' : ' disabled'}>Print</button></p>
        ${missing.length ? `<p class="warn-text small">Type the price for ${missing.map((r) => (r.from === r.to ? dmyLetter(r.from) : `${dmyLetter(r.from)} – ${dmyLetter(r.to)}`)).join(', ')} — the app has no ${esc(P.short)} bill on ${missing.length === 1 && missing[0].from === missing[0].to ? 'that day' : 'those days'} (or near ${missing.length === 1 && missing[0].from === missing[0].to ? 'it' : 'them'}) to take it from.</p>` : ''}
        <div class="stamp-row">
          ${d.stamps.letter ? `<img src="${esc(d.stamps.letter.data_url)}" alt="Stamp printed on the price letters" class="stamp-thumb">` : `<span class="muted small">Stamp: ${letterStampOf(d) ? 'the Proforma stamp from the Tanker Billing workbook' : 'the app\'s stamp'} — upload one to use another.</span>`}
          <label class="file"><input type="file" id="letter-stamp" accept="image/png,image/jpeg"><span class="btn ghost small">${d.stamps.letter ? 'Change stamp' : 'Upload stamp'}</span></label>
          ${d.stamps.letter ? '<button class="btn ghost small" id="letter-stamp-remove">Remove</button>' : ''}
        </div>
      </section>
      <section class="doc-preview"><div class="doc-page" id="letter-page">${text ? '' : '<p class="muted">Pick the dates (and type any missing price) to see the letter.</p>'}</div></section>
    </div>`);
  bindTankerImport();
  bindStamp('letter_stamp', 'letter-stamp', 'letter-stamp-remove', async () => { state.quotes = null; await route(); });
  const form = document.getElementById('letter-form');
  form.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.range) { L.typed[el.dataset.range] = el.value; } else if (el.name) L[el.name] = el.value;
    guard(() => viewPriceLetter(d));
  });
  if (!text) return;
  // the page: on screen with blob URLs, in the PDF with data URLs
  const ctx = document.createElement('canvas').getContext('2d');
  const measure = (t, st) => { ctx.font = `${st.b ? 'bold ' : ''}${st.s}px 'Times New Roman', Tinos, Times, serif`; return ctx.measureText(String(t)).width; };
  const stamp = letterStampOf(d);
  const lh = d.letterheads.cn || d.letterheads.pi;
  const fontCss = await letterFontCss().catch(() => '');
  document.getElementById('letter-page').innerHTML = letterSvg(text, { images: { letterhead: lh ? blobUrlOf(lh.data_url) : QUOTE_ASSETS.pi, stamp: stamp ? blobUrlOf(stamp.data_url) : IMAGES.stamp }, measure, fontCss });
  const name = `${P.short} Price Letter ${from === to ? dmyDash(from) : `${dmyDash(from)} to ${dmyDash(to)}`}`;
  const pdfBlob = async () => {
    const images = { letterhead: lh ? lh.data_url : await toDataUrl(QUOTE_ASSETS.pi), stamp: stamp ? stamp.data_url : await toDataUrl(IMAGES.stamp) };
    return pdfFromSvgs([letterSvg(text, { images, measure, fontCss })], LETTER_PAGE, { scale: 3 });
  };
  const run = (id, fn) => { const b = document.getElementById(id); b.addEventListener('click', () => guard(async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } })); };
  run('letter-docx', async () => {
    const JSZip = await loadJSZip();
    const tpl = await (await fetch(LETTER_TEMPLATE)).arrayBuffer();
    // the stamp as PNG (the template's picture is a PNG)
    const url = stamp ? stamp.data_url : await toDataUrl(IMAGES.stamp);
    const png = await pngBytes(url);
    download(await letterDocx(JSZip, tpl, text, png), `${name}.docx`);
    toast(`Saved ${name}.docx`);
  });
  run('letter-pdf', async () => { download(await pdfBlob(), `${name}.pdf`); toast(`Saved ${name}.pdf`); });
  run('letter-share', async () => shareOrSave([new File([await pdfBlob()], `${name}.pdf`, { type: 'application/pdf' })], `${name}.pdf`));
  run('letter-print', async () => printPages([document.getElementById('letter-page').innerHTML], A4));
}
// a picture (data: URL) as PNG bytes
async function pngBytes(dataUrl) {
  if (dataUrl.startsWith('data:image/png')) return Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---- the CN Log (XP Cr Note Log + ReprintXPCreditNote) ----
// Excel's log (from the import) and every credit note made here, newest
// first. A reprint puts the logged values back on the sheet with the
// DUPLICATE COPY label, as the Reprint macro does, and counts it.
function viewCnLog(d) {
  if (!d.model || !d.cnMac || d.cnLog === null) return viewDoc(d, 'creditnote');
  const mac = d.cnMac;
  const F = cnFields(mac);
  const f = state.cnLogFilter || { customer: '', from: '', to: '' };
  const log = d.cnLog || [];
  const rows = log.filter((r) => (!f.customer || String(r.customer).toLowerCase().includes(f.customer.trim().toLowerCase()))
    && (!f.from || (r.cn_date || '') >= f.from) && (!f.to || (r.cn_date || '') <= f.to)).sort((a, b) => b.id - a.id);
  const total = rows.reduce((a, r) => a + (Number(r.credit) || 0), 0);
  const paid = rows.reduce((a, r) => a + (Number(r.row && r.row[mac.cols.find((c) => /amount paid/i.test(c))]) || 0), 0);
  const period = (r) => { const v = F.date && r.row ? r.row[mac.cols.find((c) => /period/i.test(c))] : null; return typeof v === 'string' && /^\d{4}-\d{2}/.test(v) ? monthLabel(`${v.slice(0, 7)}-01`) : ''; };
  const fromExcel = log.filter((r) => r.source === 'workbook').length;
  const today = todayIso();
  const dates = log.map((r) => r.cn_date).filter(Boolean).sort();
  const span = { from: f.from || dates[0] || today, to: f.to || dates[dates.length - 1] || today };
  setMain(`${quotesHead(d, 'cnlog')}
    <section class="card">
      <h3>CN Log <span class="muted small">— ${esc(mac.logTable)}</span></h3>
      <p class="muted">The workbook's <b>XP Cr Note Log</b> (from the import) and every credit note made here — ${plural(fromExcel, 'note')} from Excel, ${log.length - fromExcel} made in the app. The next Credit Note No. follows the highest in it. <b>Duplicate</b> makes the note again exactly as it was logged, marked <i>${esc(mac.copy.text)}</i>, and counts the reprint.</p>
      <form class="row-form" id="cnlog-form">
        <label>Customer contains <input name="customer" value="${esc(f.customer)}" placeholder="blank = all" autocomplete="off"></label>
        <label>Note dated from <input type="date" name="from" value="${esc(f.from)}"></label>
        <label>to <input type="date" name="to" value="${esc(f.to)}"></label>
        <button class="btn ghost" type="submit">Show</button>
        <button class="btn ghost" type="button" id="cnlog-all">All</button>
      </form>
      ${rows.length ? `<p><b>${plural(rows.length, 'credit note')}</b>${f.customer || f.from || f.to ? ` of ${log.length}` : ''} · paid ${fmtMoney(paid)} · credit ${fmtMoney(total)}</p>
      <p class="actions"><button class="btn ghost" id="cnlog-xlsx">Download log (Excel)</button></p>
      <div class="table-wrap"><table class="compact pi-log">
        <thead><tr><th class="r">ID</th><th>Credit Note No.</th><th>Date</th><th>Period</th><th>Customer</th><th class="r">Amount paid</th><th class="r">Credit</th><th>Logged</th><th class="r">Reprints</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="r">${r.id}</td><td class="nw"><b>${esc(r.cn_no)}</b>${r.source === 'workbook' ? ' <span class="tag">Excel</span>' : ''}</td><td class="nw">${fmtDate(r.cn_date)}</td><td class="nw">${esc(period(r))}</td>
          <td>${esc(r.customer)}</td><td class="r nw">${esc(fmtMoney(Number(r.row && r.row[mac.cols.find((c) => /amount paid/i.test(c))]) || 0))}</td><td class="r nw"><b>${esc(fmtMoney(Number(r.credit) || 0))}</b></td>
          <td class="small">${r.printed_at ? esc(new Date(r.printed_at).toLocaleDateString('en-IN')) : ''}${r.printed_by ? `<br><span class="muted">${esc(r.printed_by)}</span>` : ''}</td>
          <td class="r">${r.reprints || 0}${r.last_reprint ? `<br><small class="muted">${esc(new Date(r.last_reprint).toLocaleDateString('en-IN'))}</small>` : ''}</td>
          <td class="row-end"><button class="btn small" data-cn-dup="${r.id}">Duplicate</button><button class="btn ghost small" data-cn-print="${r.id}">Print</button><button class="btn ghost small" data-cn-del="${r.id}" title="Remove from the CN Log">✕</button></td></tr>`).join('')}</tbody>
      </table></div>` : `<p class="muted">${log.length ? 'No credit note matches.' : 'No credit notes yet — make one under <a href="#/quotes/cn">Credit Note</a>, or import the Tanker Billing workbook to bring in its XP Cr Note Log.'}</p>`}
    </section>`);
  bindTankerImport();
  const form = document.getElementById('cnlog-form');
  form.addEventListener('submit', (e) => { e.preventDefault(); state.cnLogFilter = { customer: form.customer.value, from: form.from.value, to: form.to.value }; viewCnLog(d); });
  document.getElementById('cnlog-all').addEventListener('click', () => { state.cnLogFilter = null; viewCnLog(d); });
  const measure = canvasMeasure();
  const layout = layoutOf(d.model, 'creditnote');
  // the logged note on the sheet again, marked as a duplicate copy
  const calcOf = (r) => docCalc(d.model, 'creditnote', cnStateFromLog(r.row || {}, mac, d.model), { format: d.format });
  const pageOf = (calc, images, fontCss = '') => sheetSvg(layout, { values: pageValues(d.model, 'creditnote', calc, d.format), images, measure, fontCss });
  const reprinted = async (r) => { await quotesCall(() => state.store.cnReprinted(r.id)); d.cnLog = await cnLogList(); };
  main().querySelectorAll('[data-cn-dup]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const r = log.find((x) => x.id === Number(b.dataset.cnDup));
    if (!window.confirm(`Reprint Credit Note ${r.cn_no} (${r.customer}) as ${mac.copy.text}?`)) return;
    b.disabled = true;
    b.textContent = 'Making…';
    try {
      const calc = calcOf(r);
      const name = cnFileName(calc, mac, { duplicate: true });
      const blob = await pdfFromSvgs([pageOf(calc, await docImagesForPdf(d, 'cn'), await narrowFontCss())], A4, { scale: 3 });
      download(blob, name);
      await reprinted(r);
      toast(`Duplicate copy of ${r.cn_no} made — ${name}`);
    } finally { b.disabled = false; b.textContent = 'Duplicate'; }
    viewCnLog(d);
  })));
  main().querySelectorAll('[data-cn-print]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const r = log.find((x) => x.id === Number(b.dataset.cnPrint));
    printPages([pageOf(calcOf(r), docImages(d, 'cn'))], A4);
    await reprinted(r);
    viewCnLog(d);
  })));
  main().querySelectorAll('[data-cn-del]').forEach((b) => b.addEventListener('click', () => guard(async () => {
    const r = log.find((x) => x.id === Number(b.dataset.cnDel));
    if (!window.confirm(`Remove Credit Note ${r.cn_no} (${r.customer}) from the CN Log? Its number can then be used again.`)) return;
    await quotesCall(() => state.store.cnDelete(r.id));
    d.cnLog = await cnLogList();
    toast(`${r.cn_no} removed from the CN Log.`);
    viewCnLog(d);
  })));
  // the log sheet's own columns, in its order — ready to paste into XP Cr Note Log
  document.getElementById('cnlog-xlsx')?.addEventListener('click', () => guard(() => {
    const cell = (r, c) => {
      if (c === F.reprints) return r.reprints || 0;
      if (c === F.last_reprint) return r.last_reprint ? new Date(r.last_reprint) : '';
      if (c === F.id) return r.id;
      const v = r.row ? r.row[c] : null;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return new Date(v.length === 10 ? `${v}T00:00:00` : v);
      return v ?? '';
    };
    return downloadSheets([{ name: 'XP Cr Note Log', cols: mac.cols.map((c) => Math.max(10, Math.min(40, c.length + 4))), filter: true,
      rows: [mac.cols, ...[...rows].sort((a, b) => a.id - b.id).map((r) => mac.cols.map((c) => cell(r, c)))] }], `CN Log ${rangeName(span.from, span.to)}.xlsx`);
  }));
}

function viewPiLog(d) {
  const today = todayIso();
  const f = state.piLogFilter || { customer: '', from: '', to: '' };
  const rows = d.log.filter((r) => piMatches(r, f)).sort((a, b) => b.id - a.id);
  const total = rows.reduce((a, r) => a + (Number(r.grand_total) || 0), 0);
  const litres = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const fromExcel = d.log.filter((r) => r.source === 'workbook').length;
  const check = d.tb && d.tb.pi_check;
  const excel = new Set(((check && check.excel_nos) || []).map(piKey));
  const kept = new Set(((check && check.differ) || []).filter((x) => x.kept === 'app').map((x) => piKey(x.pi_no)));
  const tags = (r) => {
    if (!check) return '';
    if (!excel.has(piKey(r.pi_no))) return ' <span class="tag warn">Not in Excel</span>';
    if (kept.has(piKey(r.pi_no))) return ' <span class="tag warn">Differs from Excel</span>';
    return '';
  };
  const dates = d.log.map((r) => r.pi_date).filter(Boolean).sort();
  const span = { from: f.from || dates[0] || today, to: f.to || dates[dates.length - 1] || today };
  setMain(`${quotesHead(d, 'log')}
    ${check ? `<section class="card">${piCheckHtml(check, { log: d.log, fileName: check.file_name, when: check.checked_at ? new Date(check.checked_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '' })}</section>`
    : (d.log.length ? '' : '<section class="card"><p class="muted">The PI Log is empty. Import the Tanker Billing workbook to bring in its PI Log sheet.</p></section>')}
    <section class="card">
      <h3>PI Log</h3>
      <p class="muted">The Excel file's <b>PI Log</b> sheet (from the import) and every Proforma Invoice made here — ${plural(fromExcel, 'PI')} from Excel, ${d.log.length - fromExcel} made in the app. A new PI made here is added to it, and the next PI No. follows the highest in it. To reprint, narrow it down by customer (part of the name is enough) and dates: each PI comes out with its own rate, RSP and P.O. No.</p>
      <form class="row-form" id="log-form">
        <label>Customer contains <input name="customer" value="${esc(f.customer)}" placeholder="blank = all" autocomplete="off"></label>
        <label>PI dated from <input type="date" name="from" value="${esc(f.from)}"></label>
        <label>to <input type="date" name="to" value="${esc(f.to)}"></label>
        <button class="btn ghost" type="submit">Show</button>
        <button class="btn ghost" type="button" id="log-30">Last 30 days</button>
        <button class="btn ghost" type="button" id="log-all">All</button>
      </form>
      ${rows.length ? `<p><b>${plural(rows.length, 'PI')}</b>${f.customer || f.from || f.to ? ` of ${d.log.length}` : ''} · ${fmtLitres(litres)} L · ${fmtMoney(total)}</p>
      <p class="actions"><button class="btn" id="log-zip">Reprint ${rows.length === 1 ? '' : 'all '}(.zip)</button><button class="btn ghost" id="log-print">Print all</button>
        <button class="btn ghost" id="log-xlsx">Download log (Excel)</button></p>
      <div class="table-wrap"><table class="compact pi-log">
        <thead><tr><th class="r">ID</th><th>PI No.</th><th>PI date</th><th>Valid up to</th><th>Customer</th><th>P.O. No.</th><th class="r">Qty (L)</th>
          <th class="r">Rate</th><th class="r">RSP</th><th class="r">Disc.</th><th class="r">Grand total</th><th class="r">XP points</th><th class="r">Eff. rate</th><th>Logged</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="r">${r.id}</td><td class="nw"><b>${esc(r.pi_no)}</b>${tags(r)}</td><td class="nw">${fmtDate(r.pi_date)}</td><td class="nw">${fmtDate(r.valid_to)}</td>
          <td>${esc(r.customer)}</td><td>${esc(r.po_no)}${r.po_date ? `<br><small class="muted">${fmtDate(r.po_date)}</small>` : ''}</td>
          <td class="r">${indian(r.qty)}</td><td class="r">${rs2(r.rate)}</td><td class="r">${rs2(r.rsp)}</td><td class="r">${rs2(piDiscount(r))}</td>
          <td class="r">${indian(r.grand_total)}</td><td class="r">${r.points ? indian(r.points) : '0'}</td><td class="r">${rs2(piEffective(r))}</td>
          <td class="small">${r.printed_at ? esc(new Date(r.printed_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })) : ''}<br><span class="muted">${esc(r.printed_by)}${r.source === 'workbook' ? ' · Excel' : ' · app'}</span></td>
          <td class="row-end"><button class="btn small" data-pdf="${r.id}">PDF</button><button class="btn ghost small" data-print="${r.id}">Print</button><button class="btn ghost small" data-del="${r.id}" title="Remove from the PI Log">✕</button></td>
        </tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">No PIs found for that customer / date range.${d.log.length ? ` The log has ${plural(d.log.length, 'PI')} in all.` : ''}</p>`}
    </section>`);
  bindTankerImport();
  document.getElementById('pi-missing-xlsx')?.addEventListener('click', () => guard(() => {
    const missing = d.log.filter((r) => !excel.has(piKey(r.pi_no)));
    return downloadSheets([piLogSheet(missing)], `PI Log rows for Excel ${dmyDash(today)}.xlsx`);
  }));
  const form = document.getElementById('log-form');
  const apply = (next) => { state.piLogFilter = next; viewPiLog(d); };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (form.from.value && form.to.value && form.to.value < form.from.value) { toast('\'To\' date is before \'From\' date.', 'bad'); return; }
    apply({ customer: form.customer.value.trim(), from: form.from.value, to: form.to.value });
  });
  document.getElementById('log-30').addEventListener('click', () => apply({ customer: form.customer.value.trim(), from: addDays(today, -30), to: today }));
  document.getElementById('log-all').addEventListener('click', () => apply({ customer: '', from: '', to: '' }));
  if (!rows.length) return;
  const measure = canvasMeasure();
  const byId = new Map(rows.map((r) => [r.id, r]));
  // ReprintPIs: the logged PI back on the sheet (LoadLogRowToSheet), worked out
  const svgOf = (r, imgs, fontCss = '') => {
    if (!d.model) throw new Error('Import the Tanker Billing workbook again to reprint — the app now takes the Proforma Invoice from it.');
    const st = piStateFromLog(r, d.macro, d.model);
    const calc = docCalc(d.model, 'proforma', st, { format: d.format, macro: d.macro });
    return sheetSvg(layoutOf(d.model, 'proforma'), { values: pageValues(d.model, 'proforma', calc, d.format), images: imgs, measure, fontCss });
  };
  const pdfOf = async (r) => pdfFromSvgs([svgOf(r, await docImagesForPdf(d, 'pi'), await narrowFontCss())], A4, { scale: 3 });
  const nameOf = (r) => piFileName(r.customer, r.pi_date, d.macro.pdf.word);
  const busy = (btn, fn) => guard(async () => {
    const old = btn.textContent;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  });
  main().querySelectorAll('[data-pdf]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
    b.textContent = '…';
    const r = byId.get(Number(b.dataset.pdf));
    download(await pdfOf(r), nameOf(r));
  })));
  main().querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => printPages([svgOf(byId.get(Number(b.dataset.print)), docImages(d, 'pi'))], A4)));
  main().querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    const r = byId.get(Number(b.dataset.del));
    if (!window.confirm(`Remove ${r.pi_no} (${r.customer}, ${fmtDate(r.pi_date)}) from the PI Log?`)) return;
    guard(async () => {
      await quotesCall(() => state.store.piDelete(r.id));
      toast(`${r.pi_no} removed from the PI Log.`);
      d.log = await quotesCall(() => state.store.piList());
      viewPiLog(d);
    });
  }));
  document.getElementById('log-print').addEventListener('click', () => printPages(rows.map((r) => svgOf(r, docImages(d, 'pi'))), A4));
  const zipBtn = document.getElementById('log-zip');
  zipBtn.addEventListener('click', () => busy(zipBtn, async () => {
    const files = [];
    const used = new Map();
    for (let i = 0; i < rows.length; i++) {
      zipBtn.textContent = `Making PDF ${i + 1} of ${rows.length}…`;
      let name = nameOf(rows[i]);
      const n = (used.get(name) || 0) + 1;            // two PIs to one customer on one day
      used.set(name, n);
      if (n > 1) name = name.replace(/\.pdf$/, ` (${n}).pdf`);
      files.push({ name, blob: await pdfOf(rows[i]) });
    }
    download(await zipBlob(files), `PIs ${rangeName(span.from, span.to)}.zip`);
    toast(`${plural(files.length, 'PI')} produced.`);
  }));
  document.getElementById('log-xlsx').addEventListener('click', () => guard(() => downloadSheets([piLogSheet(rows)], `PI Log ${rangeName(span.from, span.to)}.xlsx`)));
}

// ---- importing the Tanker Billing workbook ----
// The parts of the file the model needs, the macros' source and the pictures
async function workbookParts(buf) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buf);
  const files = {};
  for (const name of Object.keys(zip.files)) if (MODEL_PARTS.test(name)) files[name] = await zip.file(name).async('string');
  let vba = {};
  const bin = zip.file('xl/vbaProject.bin');
  if (bin) { try { vba = vbaModules(await bin.async('uint8array')); } catch { vba = {}; } }
  const images = {};
  for (const [sheet, pics] of Object.entries(picturePaths(files))) {
    for (const [which, path] of Object.entries(pics)) {
      const f = zip.file(path);
      if (!f) continue;
      const b64 = await f.async('base64');
      const type = b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('/9j/') ? 'image/jpeg' : null;    // Excel names some PNGs .tmp
      if (!type || b64.length > 1900000) continue;
      images[`${{ quotation: 'quote', proforma: 'pi', creditnote: 'cn' }[sheet] || sheet}_${which}`] = `data:${type};base64,${b64}`;
    }
  }
  return { files, vba, images };
}

// The Tanker Billing workbook, read: what the import saves (customers, the
// model and its self-check, the PI Log and its check, the credit notes' log,
// the pictures) — for the import screen and the Mac's uploads alike
async function readTankerFile(file) {
  const XLSX = await loadSheetJS();
  const format = (f, v) => XLSX.SSF.format(f, v);
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellFormula: true, cellDates: false, cellNF: true });
  const parsed = readTankerBilling(wb);
  const { files, vba, images } = await workbookParts(buf);
  const model = buildModel(wb, files, { vba });
  const check = selfCheck(model, format);
  const missingDocs = DOC_SHEETS.filter((s) => s !== DOCS.creditnote.sheet && (!model.sheets[s] || !model.sheets[s].layout));
  // the credit notes' log, as the workbook has it (XP Cr Note Log)
  const cnMac = cnMacro(model);
  const cnLog = model.sheets[cnMac.sheet] ? cnLogFromModel(model, cnMac).map((r) => cnRecord(r, cnMac)).filter((r) => r.cn_no) : [];
  // the app's log as it is now, to check Excel's PI Log sheet against
  const log = await quotesCall(() => state.store.piList()).catch(() => []);
  const piCheck = comparePiLog(parsed.pi_log, log);
  const data = {
    model,
    model_check: { count: check.count, bad: check.bad.slice(0, 50), unknown: check.unknown.slice(0, 20), linked: check.linked, unsaved: check.unsaved, checked_at: new Date().toISOString() },
    pi_check: { ...piCheck, file_name: file.name, checked_at: new Date().toISOString() },
  };
  return { XLSX, format, parsed, images, model, check, missingDocs, cnMac, cnLog, log, piCheck, data };
}

async function tankerChosen(file, input, outId) {
  const out = document.getElementById(outId);
  out.innerHTML = loadingHtml(`Reading ${file.name}…`);
  await paint();
  try {
    const { format, parsed, images, model, check, missingDocs, cnMac, cnLog, log, piCheck, data } = await readTankerFile(file);
    const calc = makeCalc(model, { format });
    const macro = piMacro(model);
    const rsp = rspCell(model, macro);
    const rspNow = rsp ? calc.value(rsp.sheet, rsp.addr) : null;
    const formOf = (k) => (model.sheets[DOCS[k].sheet] ? inputsOf(model, k, calc, k === 'proforma' ? macro : null).map((x) => esc(x.label)).join(' · ') : '<span class="warn-text">sheet not found</span>');
    const tableRows = Object.entries(model.tables).map(([n, t]) => `${esc(n)} <span class="muted">(${t.r1 - t.r0} rows)</span>`).join(' · ');
    const pics = { pi_letterhead: 'Proforma letterhead', pi_stamp: 'Proforma stamp', quote_letterhead: 'Quotation letterhead', quote_stamp: 'Quotation stamp', cn_letterhead: 'Credit note letterhead', cn_stamp: 'Credit note stamp' };
    const ok = !check.bad.length && !check.unknown.length && check.count > 0;
    out.innerHTML = `
      <div class="preview">
        <div class="pi-check ${ok ? 'good' : 'warn'}"><b>${ok ? '✓' : '⚠'} Formulas: ${check.count ? `the app works out ${ok ? `all ${check.count}` : `${check.count - check.bad.length} of ${check.count}`} formulas of the ${esc(Object.keys(model.sheets).join(', '))} sheets as Excel saved them` : 'nothing to check them against — this copy has no results saved with its formulas'}</b>
          ${ok ? `<p class="small">So quotations and proforma invoices made here come out as Excel would make them${check.linked ? ` (${plural(check.linked, 'cell')} linked to another workbook keep what Excel saved)` : ''}.</p>`
    : `<ul class="small">${check.bad.slice(0, 10).map((b) => `<li>${esc(b.sheet)}!${esc(b.addr)} <code>=${esc(String(b.f).slice(0, 90))}</code>: Excel <b>${esc(String(b.excel ?? ''))}</b>, the app <b>${esc(String(b.app ?? ''))}</b></li>`).join('')}
            ${check.unknown.slice(0, 8).map((u) => `<li>Not known to the app yet: ${esc(u)}</li>`).join('')}</ul>
            <p class="small">You can still import; these cells are flagged on the Quotes screens. Ask Claude to teach the app what's missing.</p>`}</div>
        ${check.unsaved ? `<p class="warn-text small">${plural(check.unsaved, 'formula')} came with no result saved, so ${check.unsaved === 1 ? 'it' : 'they'} couldn't be checked against Excel — open the workbook in Excel, save it, and import again to check ${check.unsaved === 1 ? 'it' : 'them'} too.</p>` : ''}
        ${missingDocs.length ? `<p class="warn-text">No ${missingDocs.map((s) => `“${esc(s)}”`).join(' or ')} sheet in this file — that document can't be made until it is.</p>` : ''}
        <div class="table-wrap"><table class="compact"><tbody>
          <tr><td>Customers</td><td>${parsed.customers.length} <span class="muted">— they become the Tanker Master too</span></td></tr>
          <tr><td>IOCL HSD RSP</td><td>${typeof rspNow === 'number' ? `₹${rs2(rspNow)}` : '—'}${rsp ? ` <span class="muted">(${esc(rsp.sheet)}!${esc(rsp.addr)})</span>` : ''}</td></tr>
          <tr><td>Tables</td><td>${tableRows || '—'}</td></tr>
          <tr><td>Quotation asks for</td><td>${formOf('quotation')}</td></tr>
          <tr><td>Proforma Invoice asks for</td><td>${formOf('proforma')}</td></tr>
          ${model.sheets[DOCS.creditnote.sheet] ? `<tr><td>Credit Note asks for</td><td>${formOf('creditnote')}</td></tr>
          <tr><td>Credit note log</td><td>${cnMac.from === 'macro' ? 'filled as the Save/Print &amp; Log macro does' : esc(cnMac.note || '')} · ${plural(cnLog.length, 'note')} in the workbook's ${esc(cnMac.logTable)}</td></tr>` : ''}
          <tr><td>PI Log</td><td>${macro.from === 'macro' ? 'filled as the Print &amp; Log PI macro (Module1) does' : esc(macro.note || '')} · ${plural(parsed.pi_log.length, 'PI')} in the sheet</td></tr>
          <tr><td>Pictures</td><td>${Object.keys(images).map((k) => pics[k] || k).join(', ') || '<span class="muted">none found — the app\'s own letterhead is used</span>'}</td></tr>
        </tbody></table></div>
        ${parsed.warnings.length ? `<details open><summary class="warn-text">${plural(parsed.warnings.length, 'note')}</summary><ul>${parsed.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
        ${log.length || parsed.pi_log.length ? piCheckHtml(piCheck, { before: true }) : ''}
        <p class="actions"><button class="btn" id="tb-go">Import</button> <button class="btn ghost" id="tb-cancel">Cancel</button></p>
      </div>`;
    document.getElementById('tb-cancel').addEventListener('click', () => { out.innerHTML = ''; input.value = ''; });
    const go = document.getElementById('tb-go');
    go.addEventListener('click', () => guard(async () => {
      go.disabled = true;
      go.textContent = 'Importing…';
      const res = await quotesCall(() => state.store.tankerImport(file.name, { customers: parsed.customers, data, pi_log: parsed.pi_log, cn_log: cnLog, images }));
      input.value = '';
      if (file.upload) await markUploadSeen(file.upload);
      state.quotes = null;
      state.docForms = null;                    // start from the workbook's new cells
      toast(`Tanker Billing imported: ${plural(res.customers, 'customer')}, ${plural(res.pi_new, 'new PI')}${res.pi_updated ? `, ${res.pi_updated} refreshed` : ''}.`);
      if (!piCheckClean(piCheck)) {
        toast('Excel\'s PI Log doesn\'t match the app\'s — see Quotes → PI Log.', 'bad');
        state.piLogFilter = null;
        if (location.hash !== '#/quotes/log') { location.hash = '#/quotes/log'; return; }
      }
      await route();
    }).finally(() => { go.disabled = false; }));
  } catch (err) {
    out.innerHTML = errorHtml(err);
  }
}

function printPages(svgs, size) {
  document.getElementById('print-area')?.remove();
  document.getElementById('print-style')?.remove();
  const area = document.createElement('div');
  area.id = 'print-area';
  area.innerHTML = svgs.map((svg) => `<div class="print-page">${svg}</div>`).join('');
  const style = document.createElement('style');
  style.id = 'print-style';
  style.textContent = `@page { size: ${size === A5 ? 'A5' : 'A4'} portrait; margin: 0; }`;
  document.head.append(style);
  document.body.append(area);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    area.remove();
    style.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

boot().catch((err) => {
  console.error(err);
  renderCentered(`<h1>Vriddhi <b>Ledger</b></h1>${errorHtml(err)}`);
});
