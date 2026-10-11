// Shree Shyam Fleet — the /fleet/ web app. Plain ES modules, no build step.
// parse.js reads the Trip Register, analyse.js works out the figures, this
// file draws the screens (in the ledger app's look).

import {
  attention, byRoute, byVehicle, costBreakdown, dateIssues, dieselAmount, dieselLitres, dieselRecon, fleetStatus, fuel,
  inPeriod, monthly, ownExpenses, periods, routeOf, sourceOf, SOURCES, ssfcAccount, ssfcDeductions, totals, tripDays, urea, vehiclesOf,
} from './analyse.js';
import { bindCharts, groupedBars, legend, lineChart, setChartWidth, signedBars, stackedBars } from './charts.js';
import { monthlyTrend, PARTS, rateChanges, rateEras, routes as trendRoutes, summary as trendSummary } from './trends.js';
import {
  CHARGE_RULES, defaultSettings, driverCheck, monthlyCharges, routeFor, routePairs, tripKms, vehicleFlags, withDefaults,
} from './rules.js';
import { demoData } from './demo.js';
import { bookFromSheetJS, extractFleet } from './parse.js';
import { memoryStore, supabaseStore } from './store.js';
import { bulkerSvg, lanesLegend, lanesSvg, RTO_GROSS, TAGLINE } from './bulker.js';
import { byDriver, liveBehind, performance, SLOW_DAYS, STAGES } from './perf.js';
import { liveTrips } from './live.js';
import { sameDriver } from './drivers.js';
import { dataChecks } from './checks.js';
import { GRADES as LOAD_GRADES, loadBench, loadSummary } from './load.js';
import { driverBrief, ownerBrief } from './brief.js';
import { fleetDiesel, tripDiesel } from './tripdiesel.js';
import { dayBook, entries as dayEntries, KINDS as DAY_KINDS, ranges as dayRanges, shiftRange } from './daybook.js';
import { blocking, compareUploads } from './changes.js';
import { plateText } from './bulker.js';
import {
  daybookPagesSvg, driverBriefSvg, driverPagesSvg, ownerBriefSvg, fleetPagesSvg, PAGE, PAGE_PT, reconPagesSvg, roadCardSvg, ssfcPagesSvg, tripCardSvg, vehiclePagesSvg,
} from './share-svg.js';
import { brandFontCss, bulkerCss, canShareFiles, hindiFontCss, download, jpegFromSvg, pdfFromSvgs, toDataUrl, zipBlob } from './render.js';
import {
  addMonths, dateYear, daysBetween, esc, fmtDate, indian, litres, localToday, longDate, money, monthLong, monthName, monthOf,
  plural, rupees, shortDate, shortVeh, tonnes,
} from './util.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';
const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const BRAND = '<img class="brand-mark" src="assets/logo-mark.png" alt=""><span>Shree Shyam <b>Fleet</b></span>';

const root = document.getElementById('app');
const state = {
  store: null, client: null, me: null, demo: false, data: null, meta: null, localOnly: false,
  period: 'fy', custom: null, ui: {},
  settings: withDefaults(null), settingsMeta: null, settingsMissing: false, rev: 0,
};

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
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err && err.message ? err.message : String(err), 'bad');
    return undefined;
  }
}
// ---- light / dark: Auto follows the system; the choice is kept on this device ----
const THEMES = ['auto', 'light', 'dark'];
const sysLight = () => !!(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
function themeMode() {
  try { return localStorage.getItem('fleet-theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme(mode = themeMode()) {
  const light = mode === 'light' || (mode === 'auto' && sysLight());
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme-mode', mode);
  document.querySelectorAll('[data-theme-btn]').forEach((b) => { b.outerHTML = themeButton(b.classList.contains('theme-float')); });
  bindTheme();
}
const THEME_ICON = {
  auto: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="currentColor"/></svg>',
};
const THEME_NAME = { auto: 'Auto', light: 'Light', dark: 'Dark' };
function themeButton(float = false) {
  const m = themeMode();
  const next = THEMES[(THEMES.indexOf(m) + 1) % THEMES.length];
  const tip = m === 'auto' ? `Theme: Auto (following the system — ${sysLight() ? 'light' : 'dark'} now). Tap for ${THEME_NAME[next]}.` : `Theme: ${THEME_NAME[m]}. Tap for ${THEME_NAME[next]}.`;
  return `<button type="button" class="theme-btn${float ? ' theme-float' : ''}" data-theme-btn title="${esc(tip)}" aria-label="${esc(tip)}">${THEME_ICON[m]}<span class="t-lbl">${THEME_NAME[m]}</span></button>`;
}
function bindTheme() {
  document.querySelectorAll('[data-theme-btn]').forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', () => {
      const m = themeMode();
      const next = THEMES[(THEMES.indexOf(m) + 1) % THEMES.length];
      try { localStorage.setItem('fleet-theme', next); } catch { /* private mode: this visit only */ }
      applyTheme(next);
      if (main()) rerender();                                    // charts pick up the new colours
    });
  });
}
if (window.matchMedia) {
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (themeMode() === 'auto') { applyTheme('auto'); if (main()) rerender(); }
  });
}

// ---- the company logo ----
const logoMark = () => '<div class="logo-stage"><span class="logo-halo"></span><img src="assets/logo-mark.png" alt=""><span class="logo-shine" aria-hidden="true"></span></div>';
const logoLoader = (text = 'Loading…') => `<div class="logo-loader" role="status">${logoMark()}<span>${esc(text)}</span></div>`;
const logoHead = (sub = 'Fleet') => `<div class="logo-head">${logoMark()}<span class="logo-word" role="img" aria-label="Shree Shyam Logistics"></span>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;

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
const signed = (n) => (n < 0 ? 'bad-text' : '');
const exact = (n) => `title="${esc(rupees(n))}"`;
const today = () => localToday();

// ---------------------------------------------------------------------------
// start-up: demo, login, members, data
// ---------------------------------------------------------------------------
async function boot() {
  const params = new URLSearchParams(location.search);
  const cfg = window.FLEET_CONFIG || {};
  if (params.has('demo')) {
    state.demo = true;
    state.store = memoryStore(demoData(today()), { settings: demoSettings() });
    return enter();
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return renderSetup();
  let createClient;
  try {
    ({ createClient } = await import(SUPABASE_JS));
  } catch {
    return renderCentered(`${logoHead()}<p>Couldn't load the sign-in library. Check the internet connection and reload.</p>`);
  }
  state.client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'shree-shyam-fleet-auth' },
  });
  state.store = supabaseStore(state.client);
  state.client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') renderLogin(); });
  const { data } = await state.client.auth.getSession();
  if (!data || !data.session) return renderLogin();
  return enter();
}

function renderCentered(inner) {
  root.innerHTML = `${themeButton(true)}<div class="center"><div class="card center-card">${inner}</div></div>`;
  bindTheme();
}

function renderSetup() {
  renderCentered(`
    ${logoHead()}
    <p>This app isn't connected to its database yet. One-time setup (the steps are in <code>fleet/README.md</code>):</p>
    <ol class="steps">
      <li>Create a Supabase project for the fleet app.</li>
      <li>Run <code>supabase/fleet-schema.sql</code> in its SQL Editor.</li>
      <li>Add your login under Authentication → Users, then run <code>select fleet_add_member('you@example.com');</code></li>
      <li>Put the project's URL and publishable key in <code>fleet/config.js</code>.</li>
    </ol>
    <p><a class="btn" href="?demo">Try the demo</a> <span class="muted">— made-up data, nothing is saved.</span></p>
    ${localPickerHtml()}`);
  bindLocalPicker();
}

function renderLogin(message = '') {
  renderCentered(`
    ${logoHead()}
    <p class="muted small">Sign in with your fleet login.</p>
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
    const { error } = await state.client.auth.signInWithPassword({ email: form.email.value.trim(), password: form.password.value });
    if (error) return renderLogin(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
    return enter();
  });
}

// "open a file just on this device" — works before the database is set up
function localPickerHtml() {
  return `<details class="local-pick"><summary>Or open a Trip Register just on this device</summary>
    <p class="small muted">The file is read in this browser and shown here; nothing is saved anywhere.</p>
    <label class="file"><input type="file" id="local-file" accept=".xlsm,.xlsx,.xls"><span class="btn ghost">Choose Trip Register…</span></label>
    <p class="form-msg small" id="local-msg"></p></details>`;
}
function bindLocalPicker() {
  const input = document.getElementById('local-file');
  if (!input) return;
  input.addEventListener('change', () => guard(async () => {
    const file = input.files[0];
    if (!file) return;
    document.getElementById('local-msg').textContent = 'Reading the workbook…';
    const data = await readFile(file);
    state.data = data;
    state.meta = { file_name: file.name, created_at: new Date().toISOString(), by_email: '' };
    state.localOnly = true;
    state.me = state.me || { email: 'this device' };
    if (state.store && state.store.settings) await loadSettings();
    startApp();
  }));
}

async function enter() {
  let me;
  try {
    me = await state.store.whoami();
  } catch (err) {
    if (err.code === 'NO_SCHEMA') {
      renderCentered(`${logoHead()}
        <p>You're signed in, but the fleet tables aren't in the database yet. One-time setup: open the fleet's Supabase project → <b>SQL Editor</b>, paste all of <code>supabase/fleet-schema.sql</code> and press <b>Run</b>. Then reload this page.</p>
        ${localPickerHtml()}
        <p><button class="btn ghost" id="out">Sign out</button></p>`);
      bindLocalPicker();
    } else {
      renderCentered(`${logoHead()}${errorHtml(err)}<p><button class="btn ghost" id="out">Sign out</button></p>`);
    }
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  state.me = me;
  if (!me.member) {
    renderCentered(`${logoHead()}
      <p>You're signed in as <b>${esc(me.email)}</b>, but this login isn't on the fleet members list.</p>
      <p>The owner can allow it by running this once in the Supabase SQL Editor:</p>
      <pre class="code">select fleet_add_member('${esc(String(me.email).replace(/'/g, "''"))}');</pre>
      <p><button class="btn ghost" id="out">Sign out</button></p>`);
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  root.innerHTML = `${themeButton(true)}<div class="center">${logoLoader('Loading the Trip Register…')}</div>`;
  bindTheme();
  try {
    const [latest] = await Promise.all([state.store.latest(), loadSettings()]);
    if (latest) { state.data = latest.payload; state.meta = latest.meta; }
  } catch (err) {
    renderCentered(`${logoHead()}${errorHtml(err)}<p><button class="btn ghost" id="out">Sign out</button></p>`);
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  startApp();
}

// Setup (routes, vehicles, options): from the database; defaults if the
// fleet_settings table isn't there yet (fleet-schema.sql not re-run)
async function loadSettings() {
  try {
    const got = await state.store.settings();
    state.settings = withDefaults(got && got.value);
    state.settingsMeta = got && got.updated_at ? got : null;
    state.settingsMissing = false;
  } catch (err) {
    console.warn(err);
    state.settings = withDefaults(state.demo ? demoSettings() : null);
    state.settingsMissing = !state.demo;
  }
  state.rev += 1;
}
function demoSettings() {
  return { routes: [
    { port: 'Kakinada', dest: 'BALCO', km: 820, salary: 11000, diesel: 630 },
    { port: 'Gangavaram', dest: 'BALCO', km: 780, salary: 10000, diesel: 530 },
    { port: 'Gopalpur', dest: 'Vedanta', km: 450, salary: 7000, diesel: 310 },
    { port: 'Kakinada', dest: 'Vedanta', km: 700, salary: 10000, diesel: 580 },
    { port: 'Gangavaram', dest: 'Vedanta', km: 640, salary: 9500, diesel: 460 },
    { port: 'Gopalpur', dest: 'BALCO', km: 610 },
  ] };
}

function startApp() {
  watchUploads();
  renderShell();
  if (!state.routing) {
    window.addEventListener('hashchange', route);
    state.routing = true;
  }
  route();
}

async function signOut() {
  if (state.client) await state.client.auth.signOut();
  location.href = location.pathname;
}

// ---------------------------------------------------------------------------
// shell + routing
// ---------------------------------------------------------------------------
const TABS = [['#/', 'Home'], ['#/daybook', 'Day book', 'Days'], ['#/trips', 'Trips'], ['#/vehicles', 'Vehicles', 'Trucks'], ['#/drivers', 'Drivers'], ['#/costs', 'Tyre & Fastag', 'Tyres'], ['#/ssfc', 'SSFC'], ['#/diesel', 'Diesel'], ['#/setup', 'Setup']];

function renderShell() {
  root.innerHTML = `
    <header class="top">
      <a class="brand" href="#/">${BRAND}</a>
      ${state.demo ? '<span class="pill warn-pill" title="Nothing you do here is saved">Demo<span class="hide-sm"> · made-up data</span></span>' : ''}
      ${state.localOnly ? '<span class="pill info-pill" title="Read from a file on this device; not saved">This device only</span>' : ''}
      ${state.preview ? '<span class="pill info-pill" title="This file was opened but not saved">Preview · not saved</span>' : ''}
      <span class="spacer"></span>
      <a class="btn ghost small hide-sm" href="../ledger/">Ledger ↗</a>
      ${themeButton()}
      <span class="who">${esc(state.me ? state.me.email : '')}</span>
      <button class="btn ghost small" id="signout">${state.demo ? 'Leave demo' : state.client ? 'Sign out' : 'Close'}</button>
    </header>
    <nav class="tabs" aria-label="Sections">
      ${TABS.map(([href, name, short]) => `<a href="${href}" data-tab="${href}">${short ? `<span class="hide-sm">${name}</span><span class="show-sm">${short}</span>` : name}</a>`).join('')}
    </nav>
    <div id="newer"></div>
    <main id="main"></main>`;
  document.getElementById('signout').addEventListener('click', signOut);
  paintNewer();
  bindTheme();
}

// Another device saved a newer upload: load it when this tab comes back into
// view (unless an upload or Setup is open here); while the tab stays open,
// say so rather than redraw the page under the reader.
function watchUploads() {
  if (state.watching) return;
  state.watching = true;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNewer(true); });
  setInterval(() => checkNewer(false), 5 * 60 * 1000);
}
async function checkNewer(load) {
  if (!state.store || state.demo || state.localOnly || state.preview || !state.meta || state.meta.id == null || document.hidden) return;
  let top;
  try {
    [top] = await state.store.uploads(1);
  } catch {
    return;
  }
  if (!top || top.id === state.meta.id) return;
  state.newer = top;
  const busy = /^#\/(upload|setup)/.test(location.hash);
  if (load && !busy) await loadNewer();
  else paintNewer();
}
function paintNewer() {
  const el = document.getElementById('newer');
  if (!el) return;
  const n = state.newer;
  el.innerHTML = n ? `<div class="newer-bar" role="status">Newer data was saved — ${esc(n.file_name)}, ${new Date(n.created_at).toLocaleString('en-IN')}${n.by_email ? ` by ${esc(n.by_email)}` : ''}. <button class="btn small" id="load-newer">Load it</button></div>` : '';
  document.getElementById('load-newer')?.addEventListener('click', () => guard(loadNewer));
}
async function loadNewer() {
  const latest = await state.store.latest();
  if (!latest) return;
  const m = location.hash.match(/^#\/trip\/(\d+)$/);
  const was = m && state.data ? state.data.trips.find((t) => t.row === Number(m[1])) : null;
  state.data = latest.payload;
  state.meta = latest.meta;
  state.newer = null;
  renderShell();
  // a trip page follows its trip (rows move when rows are added or deleted in Excel)
  const now = was ? state.data.trips.find((t) => t.veh === was.veh && t.trip === was.trip) : null;
  if (now && now.row !== was.row) location.hash = `#/trip/${now.row}`;
  else route();
  toast(`Updated to the latest upload — ${latest.meta.file_name}, ${new Date(latest.meta.created_at).toLocaleString('en-IN')}.`);
}

const ROUTES = [
  [/^#?\/?$/, () => viewHome()],
  [/^#\/trips(?:\?(.*))?$/, (m) => viewTrips(new URLSearchParams(m[1] || ''))],
  [/^#\/daybook$/, () => viewDaybook()],
  [/^#\/trip\/(\d+)$/, (m) => viewTrip(Number(m[1]))],
  [/^#\/vehicles$/, () => viewVehicles()],
  [/^#\/performance(?:\?r=(.*))?$/, (m) => viewPerformance(m[1] ? decodeURIComponent(m[1]) : '')],
  [/^#\/vehicle\/([^/?]+)$/, (m) => viewVehicle(decodeURIComponent(m[1]))],
  [/^#\/ssfc$/, () => viewSsfc()],
  [/^#\/trends(?:\?r=(.*))?$/, (m) => viewTrends(m[1] ? decodeURIComponent(m[1]) : '')],
  [/^#\/diesel$/, () => viewDiesel()],
  [/^#\/diesel\/([^/?]+)$/, (m) => viewDieselVehicle(decodeURIComponent(m[1]))],
  [/^#\/drivers$/, () => viewDrivers()],
  [/^#\/drivers\/([^/?]+)$/, (m) => viewDriverVehicle(decodeURIComponent(m[1]))],
  [/^#\/costs(?:\/(fastag|tyre))?$/, (m) => viewCharges(m[1] || null)],
  [/^#\/setup$/, () => viewSetup()],
  [/^#\/upload$/, () => viewSetup()],
];

async function route() {
  if (!main()) return;
  const hash = location.hash || '#/';
  const tabOf = (h) => {
    if (h.startsWith('#/trip')) return '#/trips';
    if (h.startsWith('#/vehicle') || h.startsWith('#/performance')) return '#/vehicles';
    if (h.startsWith('#/diesel')) return '#/diesel';
    if (h.startsWith('#/drivers')) return '#/drivers';
    if (h.startsWith('#/costs')) return '#/costs';
    if (h.startsWith('#/upload')) return '#/setup';
    if (h.startsWith('#/trends')) return '#/';
    return h.split('?')[0];
  };
  const cur = tabOf(hash);
  document.querySelectorAll('.tabs a').forEach((a) => {
    const on = a.dataset.tab === '#/' ? cur === '#/' || cur === '' : cur === a.dataset.tab;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    // a phone's tab bar scrolls when the tabs don't fit: keep this one in view
    const bar = a.parentElement;
    if (on && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2);
  });
  const hit = ROUTES.map(([re, fn]) => [hash.match(re), fn]).find(([m]) => m);
  setMain(loadingHtml());
  try {
    if (!state.data && !hash.startsWith('#/upload') && !hash.startsWith('#/setup')) viewWelcome();
    else await (hit ? hit[1](hit[0]) : viewHome());
  } catch (err) {
    console.error(err);
    setMain(errorHtml(err));
  }
  if (!state.keepScroll) window.scrollTo(0, 0);
  state.keepScroll = false;
}
const rerender = () => { state.keepScroll = true; route(); };

function viewWelcome() {
  setMain(`<section class="hero card">
    <h2>Welcome</h2>
    <p>Upload your <b>Trip Register</b> (the .xlsm you keep in Excel): the app reads every trip, the SSFC ledger, HSD and urea fills and the diesel recon from it, and shows them here on any phone.</p>
    <p><a class="btn" href="#/setup">Upload Trip Register</a></p></section>`);
}

// ---------------------------------------------------------------------------
// shared bits: period picker, figures that need the whole data
// ---------------------------------------------------------------------------
const PERIOD_KEYS = ['month', 'last', 'q', 'fy', 'lastfy', 'all', 'custom'];
function currentPeriod() {
  const per = periods(today(), monthOf(state.data.latest));
  if (state.period === 'custom' && state.custom) return { key: 'custom', label: `${monthName(state.custom.from)} – ${monthName(state.custom.to)}`, ...state.custom };
  return per[state.period] || per.fy;
}
function periodHtml() {
  const per = periods(today(), monthOf(state.data.latest));
  const p = currentPeriod();
  const c = state.custom || { from: per.fy.from, to: monthOf(today()) };
  return `<div class="chips period" role="group" aria-label="Period">
    ${PERIOD_KEYS.map((k) => `<button class="chip${p.key === k ? ' on' : ''}" data-period="${k}" aria-pressed="${p.key === k}">${k === 'custom' ? 'Custom' : per[k].label}</button>`).join('')}
  </div>
  ${p.key === 'custom' ? `<form class="custom-range" id="period-range">
    <label>From <input type="month" name="from" value="${c.from}"></label>
    <label>To <input type="month" name="to" value="${c.to}"></label>
    <button class="btn small" type="submit">Show</button></form>` : ''}`;
}
function bindPeriod(box) {
  box.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    state.period = b.dataset.period;
    if (state.period === 'custom' && !state.custom) {
      const per = periods(today(), monthOf(state.data.latest));
      state.custom = { from: per.fy.from, to: monthOf(today()) };
    }
    rerender();
  }));
  box.querySelector('#period-range')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const from = e.target.from.value;
    const to = e.target.to.value;
    if (!from || !to || to < from) { toast('Pick a From month on or before the To month.', 'bad'); return; }
    state.custom = { from, to };
    rerender();
  });
}
const periodRange = (p) => (p.key === 'all' ? 'all trips' : p.from === p.to ? monthLong(p.from) : `${monthName(p.from)} – ${monthName(p.to)}`);

let cache = null;
function derived() {
  const d = state.data;
  if (!cache || cache.data !== d || cache.rev !== state.rev) {
    const set = state.settings;
    const kms = tripKms(d, set);
    const x = {
      recon: dieselRecon(d, set), account: ssfcAccount(d.ssfc, today()), status: fleetStatus(d, today()), vehicles: vehiclesOf(d),
      issues: dateIssues(d, today()), kms, drivers: driverCheck(d, set, today()), loads: loadBench(d),
      get tripDiesel() { return this._td || (this._td = tripDiesel(d, this.recon, set)); },
      maxGross: Math.max(0, ...d.trips.map((t) => t.gross || 0)),
      perfRecent: performance(d, today(), { from: addMonths(monthOf(today()), -2), to: monthOf(today()) }),
      perfAll: performance(d, today()),
      liveTrips: liveTrips(d, set, today()),
      charges: { fastag: monthlyCharges(d, set, 'fastag', kms), tyre: monthlyCharges(d, set, 'tyre', kms) },
    };
    cache = { data: d, rev: state.rev, x };
  }
  if (!cache.x.live) cache.x.live = liveBehind(d, today(), cache.x.perfAll);
  return cache.x;
}
// the bulker for a trip: loaded with what it carried, or empty
function bulkerFor(t, { compact = false, animate = false, empty = false, veh = null, routeTrip = null } = {}) {
  const { maxGross } = derived();
  const v = veh || (t && t.veh);
  const rt = routeTrip || t;
  const extra = rt ? { route: `${rt.port} → ${rt.dest}`, trip: rt.trip } : {};
  if (!t || empty || !t.loadWt) return bulkerSvg({ state: 'empty', compact, plate: v, title: `${v} · empty`, ...extra });
  return bulkerSvg({ state: 'loaded', load: t.loadWt, tare: t.tare, gross: t.gross, max: maxGross, compact, animate, plate: v, ...extra,
    title: `${v} · ${t.trip} · ${t.loadWt.toFixed(2)} T alumina · gross ${t.gross ? t.gross.toFixed(2) : '—'} T (RTO ${RTO_GROSS} T)` });
}
// how full the trip went: over the RTO 56 T is good (its fee is paid), and
// against the best load on the route around the same time
const weightLine = (t) => {
  if (!t || !t.gross) return '';
  const b = derived().loads.get(t.row);
  const d = t.gross - RTO_GROSS;
  const rto = d > 0.05 ? `<span class="pill good-pill">+${d.toFixed(2)} T overload · RTO paid ✓</span>` : `<span class="pill bad-pill">${(-d).toFixed(2)} T under the RTO ${RTO_GROSS} T</span>`;
  if (!b) return rto;
  const vs = b.grade === 'top' ? `<span class="pill good-pill">★ Full load — best on the route then ${b.near.toFixed(2)} T</span>`
    : `<span class="pill ${b.grade === 'poor' ? 'bad-pill' : b.grade === 'low' ? 'warn-pill' : 'info-pill'}">${b.gapNear.toFixed(2)} T below the best then (${b.near.toFixed(2)} T) · ${money(b.lostRs)} freight</span>`;
  return `${rto} ${vs}`;
};
// how a vehicle has been doing lately against the others on the same route
function perfBadge(veh, perf = derived().perfRecent) {
  const v = perf.vehicles.find((x) => x.veh === veh);
  if (!v || v.trips < 3) return '';
  if (v.under) return `<span class="pill bad-pill" title="${esc(`${v.slowerPerTrip.toFixed(1)} days a trip slower than the others on the same route`)}">⚠ Slow</span>`;
  if (v.slowerPerTrip >= 0.5) return `<span class="pill warn-pill" title="${esc(`${v.slowerPerTrip.toFixed(1)} days a trip slower`)}">Slipping</span>`;
  if (v.top) return `<span class="pill good-pill" title="${esc(`${(-v.slowerPerTrip).toFixed(1)} days a trip faster`)}">★ Top</span>`;
  return '';
}
const subNav = (on) => `<div class="chips small-chips sub-nav" role="group" aria-label="Vehicles"><a class="chip${on === 'cards' ? ' on' : ''}" href="#/vehicles">Vehicles</a><a class="chip${on === 'perf' ? ' on' : ''}" href="#/performance">Performance</a></div>`;
// km of a set of trips (only trips whose distance is known)
function kmOf(trips) {
  const { kms } = derived();
  const known = trips.filter((t) => kms.get(t.row) && kms.get(t.row).complete && kms.get(t.row).km);
  return { km: known.reduce((a, t) => a + kms.get(t.row).km, 0), trips: known.length, litres: known.reduce((a, t) => a + dieselLitres(t), 0) };
}
const OVERPAID = 500;
const STAGE_NAME = { toLoad: 'getting loaded', loaded: 'the loaded run', idle: 'idle after unloading' };
function liveText(x) {
  const who = driverNow(x.veh);
  const what = x.stage === 'loaded' ? `loaded ${x.sofar} days ago at ${x.t.port}, not unloaded at ${x.t.dest} yet` : `started ${x.sofar} days ago, not loaded at ${x.t.port} yet`;
  const bench = x.bench != null ? ` — the best on this route lately ${x.stage === 'loaded' ? 'unload' : 'load'} in ${x.bench} day${x.bench === 1 ? '' : 's'}` : '';
  const ahead = x.ahead.length ? `; ${x.ahead.map((t) => shortVeh(t.veh)).join(', ')} started with it and ${x.stage === 'loaded' ? 'have unloaded' : 'are loaded'}` : '';
  return `${shortVeh(x.veh)}${who ? ` (${who})` : ''}: ${what}${bench}${ahead}`;
}
function driverNow(veh) {
  const dc = derived().drivers;
  const now = dc.now.get(veh);
  if (now) return now.name;
  const sp = [...dc.spells].reverse().find((x) => x.veh === veh);
  return sp && sp.name ? sp.name : '';
}                                            // a driver is flagged above this
// months to chart for a period: the period itself, or the last 12 months when it's short
function chartMonths(p) {
  const months = state.data.trips.map((t) => t.month).filter(Boolean).sort();
  if (!months.length) return null;
  const first = months[0];
  const last = months[months.length - 1];
  let from = p.from < first ? first : p.from;
  let to = p.to > last ? last : p.to;
  let note = '';
  const span = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;
  if (to < from || span(from, to) < 3) {
    to = p.to > last ? last : p.to;
    from = addMonths(to, -11) < first ? first : addMonths(to, -11);
    note = ' · last 12 months';
  }
  if (span(from, to) > 24) from = addMonths(to, -23);
  return { from, to, note };
}

const statusPill = (t) => (t.status === 'done' ? '<span class="pill good-pill">Unloaded</span>'
  : t.status === 'loaded' ? '<span class="pill fuel-pill">Loaded · on the way</span>' : '<span class="pill info-pill">Empty · going to load</span>');
const vehLink = (v) => `<a class="veh-no" href="#/vehicle/${encodeURIComponent(v)}"><b>${esc(shortVeh(v))}</b><small>${esc(v)}</small></a>`;
const S1 = 'var(--s-1)'; const S2 = 'var(--s-2)'; const S3 = 'var(--s-3)'; const S4 = 'var(--s-4)'; const S5 = 'var(--s-5)';

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
async function viewHome() {
  const d = state.data;
  const { recon, account, status } = derived();
  const play = !state.greeted;
  state.greeted = true;
  const todo = attention(d, today(), { recon, account });
  const { drivers, charges, kms, live, perfRecent } = derived();
  for (const x of live.slice().sort((a, b) => b.sofar - a.sofar).slice(0, 4)) {
    todo.unshift({ kind: 'warn', href: `#/vehicle/${encodeURIComponent(x.veh)}`, text: liveText(x) });
  }
  const slow = perfRecent.vehicles.filter((v) => v.under);
  if (slow.length) todo.push({ kind: 'warn', href: '#/performance', text: `Underperforming lately: ${slow.map((v) => `${shortVeh(v.veh)} (${v.slowerPerTrip.toFixed(1)} days a trip slower${v.worstStage ? `, mostly ${STAGE_NAME[v.worstStage]}` : ''})`).join(', ')}` });
  // only once salaries are set in Setup (the Rates sheet's Driver Payment is a placeholder)
  const confirmed = (sp) => sp.trips.length && drivers.rows.filter((r) => r.spell === sp && r.salary != null).every((r) => r.salaryFrom === 'app');
  const overpaid = drivers.spells.filter((x) => x.balance > OVERPAID && confirmed(x));
  if (overpaid.length > 2) {
    todo.unshift({ kind: 'warn', href: '#/drivers', text: `${plural(overpaid.length, 'driver')} overpaid — ${rupees(overpaid.reduce((a, x) => a + x.balance, 0))} more than salary − your advances` });
  } else {
    for (const sp of overpaid) todo.unshift({ kind: 'warn', href: `#/drivers/${encodeURIComponent(sp.veh)}`, text: `${shortVeh(sp.veh)}: ${sp.name ? `driver ${sp.name}` : 'driver'} overpaid ${rupees(sp.balance)} (salary − your advances vs what SSFC paid)` });
  }
  const placeholder = [...new Set(drivers.rows.filter((r) => r.salaryFrom === 'rates').map((r) => routeOf(r.t)))];
  if (placeholder.length) todo.push({ kind: 'info', href: '#/setup', text: `Confirm the driver salary for ${placeholder.join(', ')} in Setup (now taken from the Rates sheet's Driver Payment)` });
  const since = addMonths(monthOf(today()), -3);
  for (const key of ['tyre', 'fastag']) {
    const recent = charges[key].flags.filter((f) => f.month >= since && f.kind !== 'low');
    if (recent.length) todo.push({ kind: 'warn', href: `#/costs/${key}`, text: `${CHARGE_RULES[key].name}: ${plural(recent.length, 'charge')} out of the usual trend in the last 3 months` });
  }
  if (drivers.missing.length) todo.push({ kind: 'info', href: '#/setup', text: `Driver salary not set for ${drivers.missing.map((m) => m.route).join(', ')} — set it in Setup to check driver pay` });
  if (![...kms.values()].some((k) => k.km)) todo.push({ kind: 'info', href: '#/setup', text: 'Add the distance of each route in Setup to see km, mileage and cost per km' });
  const onTrip = status.filter((s) => s.state !== 'idle');
  const loaded = status.filter((s) => s.state === 'loaded');
  const empty = status.filter((s) => s.state === 'empty');
  const avgDays = onTrip.length ? onTrip.reduce((a, s) => a + s.days, 0) / onTrip.length : 0;
  setMain(`
    ${vehStripHtml()}
    <section class="card greet logo-hero${play ? ' play' : ''}">
      ${logoMark()}<h1 class="logo-word" aria-label="Shree Shyam Logistics"></h1>
      <p class="greet-dates"><span>Today is <b>${esc(longDate(today()))}</b></span>
      <span>Trip Register updated until <b>${esc(d.latest ? dateYear(d.latest) : '—')}</b></span></p>
    </section>

    <section class="card">
      <div class="row-between"><h3>On the road now</h3><span class="row-gap"><span class="muted small">${plural(status.length, 'vehicle')}</span>${shareBtn('share-road')}</span></div>
      <div class="kpis live-kpis">
        <div class="kpi hero"><span class="lbl">On a trip</span><span class="val">${onTrip.length}<small> / ${status.length}</small></span><span class="sub">avg ${avgDays.toFixed(1)} days since start</span></div>
        <div class="kpi"><span class="lbl">Loaded · en route</span><span class="val">${loaded.length}</span><span class="sub">${esc(summarisePlaces(loaded.map((s) => s.trip.dest)))}</span></div>
        <div class="kpi"><span class="lbl">Empty · going to load</span><span class="val">${empty.length}</span><span class="sub">${esc(summarisePlaces(empty.map((s) => s.trip.port)))}</span></div>
        <div class="kpi"><span class="lbl">Idle</span><span class="val">${status.length - onTrip.length}</span><span class="sub">${esc(summarisePlaces(status.filter((s) => s.state === 'idle' && s.last).map((s) => s.last.dest)) || '—')}</span></div>
      </div>
      <div class="road-grid">${derived().liveTrips.map(roadCard).join('')}</div>
      ${status.some((s) => s.state === 'idle') ? `<div class="veh-grid idle-grid">${status.filter((s) => s.state === 'idle').map(vehTile).join('')}</div>` : ''}
    </section>

    ${todo.length ? `<section class="card"><h3>Needs a look</h3><div class="todos">${todo.slice(0, 8).map((t) => `<a class="todo ${t.kind}" href="${t.href}">${esc(t.text)}</a>`).join('')}
      ${todo.length > 8 ? `<p class="muted small">…and ${todo.length - 8} more.</p>` : ''}</div></section>` : ''}

    ${account ? ssfcMiniHtml(account) : ''}

    <div id="dash"></div>
    ${state.meta ? `<p class="muted small">From “${esc(state.meta.file_name)}”${state.meta.created_at ? ` · uploaded ${new Date(state.meta.created_at).toLocaleString('en-IN')}` : ''}${state.meta.by_email ? ` · ${esc(state.meta.by_email)}` : ''}</p>` : ''}`);
  renderDashboard(document.getElementById('dash'));
  document.getElementById('share-road')?.addEventListener('click', () => sharePictures('Share the fleet', [roadOption(), fleetOption()]));
}

function summarisePlaces(list) {
  const m = new Map();
  list.forEach((p) => m.set(p, (m.get(p) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${n} → ${p}`).join(' · ');
}

// ---- a vehicle on a trip: route, where it is, its pace, what the trip should earn ----
const dm = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(iso.slice(5, 7)) - 1]}` : '');
function paceText(lt) {
  const p = lt.pace;
  if (p.best == null) return { cls: 'good', text: 'Just started', sub: '' };
  const own = p.own != null ? (p.own > 0 ? ` · ${p.own} d behind its own best` : p.own < 0 ? ` · ${-p.own} d ahead of its own best` : ' · matching its own best') : '';
  if (lt.status === 'late') return { cls: 'late', text: `Late — ${p.typical} d behind the usual`, sub: `${p.best} d behind the best${own}` };
  if (lt.status === 'behind') return { cls: 'behind', text: `${p.best} d behind the best`, sub: `on the usual pace${own}` };
  return { cls: 'good', text: p.best < 0 ? `Ahead of the best by ${-p.best} d` : 'On the best pace', sub: own.replace(/^ · /, '') };
}
function stepsHtml(lt) {
  const lastDone = lt.steps.map((x) => x.done).lastIndexOf(true);
  return `<ol class="steps5">${lt.steps.map((x, i) => {
    const cls = x.done ? (i === lastDone ? 'st-done st-last' : 'st-done') : i === lastDone + 1 ? 'st-next' : 'st-later';
    const when = x.done ? dm(x.date) : x.best ? `best ${dm(x.best)}` : '';
    return `<li class="${cls}"><i></i><b>${esc(x.name)}</b><small>${esc(x.place || '')}</small><em>${esc(when)}</em></li>`;
  }).join('')}</ol>`;
}
function projHtml(pr, { full = false } = {}) {
  const parts = [['Freight', pr.freight, pr.loaded ? `${pr.loadWt.toFixed(2)} T × ₹${indian(pr.rate)}` : `about ${pr.loadWt.toFixed(1)} T × ₹${indian(pr.rate)} (not loaded yet)`],
    ['Diesel filled', -pr.dieselSoFar, `${indian(pr.litresSoFar)} L logged`], ['Diesel still to fill', -pr.dieselLeft, pr.litresLeft ? `~${indian(pr.litresLeft)} L at ₹${pr.price.toFixed(2)}` : 'none expected'],
    ['Driver', -pr.driver, `${pr.driverFrom === 'setup' ? 'salary (Setup)' : pr.driverFrom === 'rates' ? 'Rates sheet driver payment' : 'what the route usually costs'}${pr.advances ? `, ${rupees(pr.advances)} advanced` : ''}`],
    ['SSFC other deductions', -pr.ssfcOther, 'fastag, tyre, maintenance, RTO… — its average a trip, last 90 days'],
    ['Urea & own misc', -(pr.urea + pr.ownOther), '']];
  if (!full) {
    return `<div class="rc-money"><span><small>Projected income</small><b class="${signed(pr.before)}">${money(pr.before)}</b><small>before EMI${pr.usual != null ? ` · usual ${money(pr.usual)}` : ''}</small></span>
      <span><small>After EMI share</small><b class="${signed(pr.after)}">${money(pr.after)}</b><small>EMI ${money(pr.emiShare)} a trip</small></span>
      <span><small>Diesel so far</small><b>${money(pr.dieselSoFar)}</b><small>${indian(pr.litresSoFar)} L${pr.litresLeft ? ` · ~${indian(pr.litresLeft)} L to go` : ''}</small></span></div>`;
  }
  return `<div class="ledger-lines proj-lines">${parts.map(([n, v, note]) => `<div class="ln${v < 0 ? ' minus' : ''}"><span>${esc(n)}${note ? `<small class="muted block">${esc(note)}</small>` : ''}</span><b>${v < 0 ? '− ' : ''}${rupees(Math.abs(v))}</b></div>`).join('')}
    <div class="ln total"><span>Projected income (before EMI)</span><b class="${signed(pr.before)}">${rupees(pr.before)}</b></div>
    <div class="ln minus"><span>EMI share a trip</span><b>− ${rupees(pr.emiShare)}</b></div>
    <div class="ln total"><span>After EMI</span><b class="${signed(pr.after)}">${rupees(pr.after)}</b></div></div>
    <p class="muted small">Freight, the diesel logged in HSD Data and any driver advance are actual; the rest is what this vehicle / route usually costs${pr.usual != null ? ` (the route usually earns ${rupees(pr.usual)} a trip before EMI)` : ''}.</p>`;
}
function roadCard(lt) {
  const t = lt.t;
  const pace = paceText(lt);
  const who = driverNow(lt.veh);
  return `<a class="road-card ${pace.cls}" href="#/vehicle/${encodeURIComponent(lt.veh)}">
    <div class="rc-head"><span class="hsrp">${esc(plateText(lt.veh))}</span>${perfBadge(lt.veh)}<span class="rc-day">Day ${lt.el}</span></div>
    <div class="rc-route"><span class="rc-place"><small>Loading port</small><b>${esc(t.port)}</b></span><span class="rc-arrow" aria-hidden="true"></span><span class="rc-place to"><small>Destination</small><b>${esc(t.dest)}</b></span></div>
    <div class="rc-sub"><span>${esc(t.trip)}</span>${who ? `<span>Driver ${esc(who)}</span>` : ''}<span>Started ${dm(t.start)}</span></div>
    ${bulkerFor(lt.stage === 'start' || lt.stage === 'out' ? null : t, { veh: lt.veh, routeTrip: t })}
    <div class="rc-phase"><b>${esc(lt.phase.title)}</b></div>
    ${stepsHtml(lt)}
    <div class="rc-pace ${pace.cls}"><b>${esc(pace.text)}</b>${pace.sub ? `<small>${esc(pace.sub)}</small>` : ''}${lt.etaTypical ? `<small>At ${esc(t.dest)} ~${dm(lt.etaTypical)}${lt.etaBest && lt.etaBest !== lt.etaTypical ? ` (best ${dm(lt.etaBest)})` : ''}</small>` : ''}</div>
    ${(() => { const z = derived().tripDiesel.get(t.row); return z && z.allotted != null ? `<div class="rc-diesel ${dieselTone(z)}"><b>Diesel</b> ${esc(dieselLine(z))}</div>` : ''; })()}
    ${projHtml(lt.projection)}
  </a>`;
}

// a small card per vehicle, at the top of Home: tap for its page
function vehStripHtml() {
  const { status } = derived();
  const m = monthOf(today());
  return `<nav class="veh-strip" aria-label="Vehicles">${status.map((s) => {
    const mine = state.data.trips.filter((t) => t.veh === s.veh && t.month === m);
    const freight = mine.reduce((a, t) => a + (t.bhada || 0), 0);
    const t = s.trip;
    const where = s.state === 'loaded' ? `Loaded → ${t.dest}` : s.state === 'empty' ? `Empty → ${t.port}` : s.last ? `Idle · ${s.last.dest}` : 'Idle';
    const who = driverNow(s.veh);
    const behind = derived().live.some((x) => x.veh === s.veh);
    return `<a class="vs-card ${s.state}${behind ? ' behind' : ''}" href="#/vehicle/${encodeURIComponent(s.veh)}" aria-label="${esc(`${s.veh}: ${where}${who ? `, driver ${who}` : ''}`)}">
      <span class="vs-top"><b>${esc(shortVeh(s.veh))}</b><span class="vs-day">${s.days == null ? '' : s.state === 'idle' ? `${s.days}d idle` : `day ${s.days}`}</span></span>
      <span class="vs-state"><i></i>${esc(where)}</span>
      <small class="vs-who">${esc(who || '—')}</small>
      <small class="vs-month">${mine.length ? `${plural(mine.length, 'trip')} · ${money(freight)}` : 'no trip'} <em>this month</em></small>
    </a>`;
  }).join('')}</nav>`;
}

function vehTile(s) {
  const t = s.trip;
  const late = s.state !== 'idle' && s.days > 9;
  const behind = derived().live.find((x) => x.veh === s.veh);
  return `<a class="veh ${s.state}${behind ? ' behind' : ''}" href="#/vehicle/${encodeURIComponent(s.veh)}">
    ${bulkerFor(s.state === 'loaded' ? t : null, { compact: true, veh: s.veh })}
    <span class="veh-top"><b>${esc(shortVeh(s.veh))} ${perfBadge(s.veh)}</b><span class="veh-days${late || behind ? ' late' : ''}">${s.days == null ? '' : s.state === 'idle' ? `${s.days}d idle` : `day ${s.days}`}</span></span>
    <span class="veh-state"><i></i>${esc(s.text)}</span>
    <small>${t ? `${esc(t.trip)}${t.loadWt ? ` · ${t.loadWt.toFixed(2)} T` : ''}` : s.last ? `last: ${esc(s.last.trip)}, unloaded ${esc(shortDate(s.last.unloadDate))}` : ''}</small>
  </a>`;
}

function ssfcMiniHtml(a) {
  const pending = a.withGst.filter((b) => b.pending > 0.005);
  return `<a class="card ssfc-mini" href="#/ssfc">
    <div><span class="eyebrow">SSFC owes you · ${esc(a.party.name)}</span>
    <span class="big" ${exact(a.total)}>${money(a.total)}</span>
    <span class="muted small">${plural(pending.length, 'invoice')} pending · incl. GST ${money(a.igst)}</span></div>
    <div class="ssfc-split"><span><small>In SSL account</small><b ${exact(a.account)}>${money(a.account)}</b></span><span><small>In cash (with GST)</small><b ${exact(a.cashWithGst)}>${money(a.cashWithGst)}</b></span></div>
  </a>`;
}

function renderDashboard(box) {
  const p = currentPeriod();
  const trips = state.data.trips.filter((t) => inPeriod(t, p));
  const T = totals(trips);
  setChartWidth(box.clientWidth - 38);
  const cm = chartMonths(p);
  const months = cm ? monthly(state.data.trips, cm.from, cm.to) : [];
  const cost = costBreakdown(trips);
  const { vehicles } = derived();
  const vrows = byVehicle(trips, vehicles);
  const routes = byRoute(trips);
  const ui = state.ui.home || (state.ui.home = { sort: 'income', table: false });
  const beforeEmi = T.income + T.emi;
  const K = kmOf(trips);
  const sumBhada = () => { const { kms } = derived(); return trips.filter((t) => kms.get(t.row) && kms.get(t.row).complete && kms.get(t.row).km).reduce((a, t) => a + (t.bhada || 0), 0); };
  box.innerHTML = `
  <section class="card dash">
    <div class="row-between"><h2>Business</h2><span class="row-gap"><span class="muted small">${esc(periodRange(p))}</span>${shareBtn('share-fleet', 'Share report')}</span></div>
    ${periodHtml()}
    ${trips.length ? `
    <div class="kpis">
      <div class="kpi hero"><span class="lbl">Freight (bhada)</span><span class="val" ${exact(T.bhada)}>${money(T.bhada)}</span><span class="sub">${tonnes(T.tonnes, 1)} · ₹${indian(T.perTonne)}/T</span></div>
      <div class="kpi"><span class="lbl">Trips</span><span class="val">${T.trips}</span><span class="sub">${T.done} unloaded${T.open ? ` · ${T.open} on the way` : ''}</span></div>
      <div class="kpi"><span class="lbl">SSFC net</span><span class="val" ${exact(T.ssfcNet)}>${money(T.ssfcNet)}</span><span class="sub">after ${money(T.ssfcDed)} SSFC deductions</span></div>
      <div class="kpi"><span class="lbl">Profit before EMI</span><span class="val ${signed(beforeEmi)}" ${exact(beforeEmi)}>${money(beforeEmi)}</span><span class="sub">${T.trips ? `${money(beforeEmi / T.trips)} a trip` : ''}</span></div>
      <div class="kpi"><span class="lbl">EMI</span><span class="val" ${exact(T.emi)}>${money(T.emi)}</span><span class="sub">installments charged</span></div>
      <div class="kpi ${T.income < 0 ? 'warn' : ''}"><span class="lbl">Net after EMI</span><span class="val ${signed(T.income)}" ${exact(T.income)}>${money(T.income)}</span><span class="sub">Income/Trip total · ${Math.round(T.margin * 100)}% of freight</span></div>
      <div class="kpi"><span class="lbl">Diesel</span><span class="val">${litres(T.dieselL)}</span><span class="sub">${money(T.dieselAmt)} · ${T.trips ? Math.round(T.dieselL / T.trips) : 0} L a trip</span></div>
      <div class="kpi"><span class="lbl">Weight short</span><span class="val">${tonnes(-T.short)}</span><span class="sub">${plural(T.shortTrips, 'trip')} short · avg ${T.days.toFixed(1)} days a trip</span></div>
      ${K.km ? `<div class="kpi"><span class="lbl">Distance</span><span class="val">${indian(K.km)} km</span><span class="sub">₹${(sumBhada(K) / K.km).toFixed(1)} freight a km${K.trips < T.trips ? ` · ${K.trips} of ${T.trips} trips` : ''}</span></div>
      <div class="kpi"><span class="lbl">Mileage</span><span class="val">${K.litres ? (K.km / K.litres).toFixed(2) : '—'} km/L</span><span class="sub">diesel issued on those trips</span></div>` : ''}
    </div>

    <h3 class="sub-h">Where every ₹100 of freight goes</h3>
    ${flowHtml(cost)}
    <a class="btn ghost small trend-link" href="#/trends">Rates, costs &amp; income over time — what changed when the rate changed →</a>

    ${cm ? `<h3 class="sub-h">Month by month <span class="muted">${esc(cm.note)}</span></h3>
    ${legend([{ name: 'Freight', color: S1 }, { name: 'Profit before EMI', color: S3 }, { name: 'Net after EMI', color: S2 }])}
    ${groupedBars(months.map((m) => ({ ...m, before: m.income + m.emi })), [{ key: 'bhada', name: 'Freight', color: S1 }, { key: 'before', name: 'Profit before EMI', color: S3 }, { key: 'income', name: 'Net after EMI', color: S2 }], {
    label: 'Freight, profit before EMI and net after EMI per month',
    tip: (m) => `<b>${monthLong(m.month)}</b><br>${plural(m.trips, 'trip')} · ${tonnes(m.tonnes, 1)}<br><i style="background:${S1}"></i>Freight ${money(m.bhada)}<br><i style="background:${S3}"></i>Before EMI ${money(m.before)}<br><i style="background:${S2}"></i>Net after EMI ${money(m.income)}`,
  })}
    <button class="btn ghost small" id="month-table" aria-expanded="${ui.table}">${ui.table ? 'Hide' : 'Show'} the table</button>
    ${ui.table ? monthTableHtml(months) : ''}` : ''}

    <h3 class="sub-h">Vehicles</h3>
    <div class="chips small-chips" role="group" aria-label="Sort vehicles">
      ${[['income', 'Net after EMI'], ['before', 'Before EMI'], ['bhada', 'Freight'], ['trips', 'Trips'], ['tonnes', 'Tonnes']].map(([k, n]) => `<button class="chip${ui.sort === k ? ' on' : ''}" data-vsort="${k}">${n}</button>`).join('')}
    </div>
    ${vehicleRankHtml(vrows, ui.sort)}

    <h3 class="sub-h">Routes</h3>
    ${routesHtml(routes)}` : '<p class="muted">No trips loaded in this period.</p>'}
  </section>`;
  bindPeriod(box);
  box.querySelector('#share-fleet')?.addEventListener('click', () => sharePictures('Share the fleet', [fleetOption(), roadOption()]));
  box.querySelectorAll('[data-vsort]').forEach((b) => b.addEventListener('click', () => { ui.sort = b.dataset.vsort; renderDashboard(box); }));
  box.querySelector('#month-table')?.addEventListener('click', () => { ui.table = !ui.table; renderDashboard(box); });
  bindCharts(box);
}

function flowHtml(cost) {
  if (!cost.bhada) return '<p class="muted">No freight in this period.</p>';
  const per100 = (v) => (v / cost.bhada) * 100;
  const max = Math.max(...cost.groups.map((g) => g.amount), Math.abs(cost.income));
  const row = (name, amount, note, cls = '') => `<div class="flow-row ${cls}">
      <span class="flow-name"><b>${esc(name)}</b>${note ? `<small>${esc(note)}</small>` : ''}</span>
      <span class="flow-bar"><i style="width:${Math.max(1, (Math.abs(amount) / max) * 100).toFixed(1)}%"></i></span>
      <span class="flow-val"><b>${amount < 0 ? '−' : ''}₹${Math.abs(per100(amount)).toFixed(1)}</b><small ${exact(amount)}>${money(amount)}</small></span></div>`;
  return `<div class="flow">${cost.groups.map((g) => row(g.name, g.amount, g.note)).join('')}
    ${row(cost.income >= 0 ? 'Left as profit (after EMI)' : 'Loss after EMI', cost.income, cost.income >= 0 ? '' : 'costs and EMI were more than the freight', cost.income >= 0 ? 'profit' : 'loss')}</div>`;
}

function monthTableHtml(months) {
  return `<div class="table-wrap"><table class="compact"><thead><tr><th>Month</th><th class="r">Trips</th><th class="r">Tonnes</th><th class="r">Freight</th><th class="r">SSFC net</th><th class="r">Before EMI</th><th class="r">EMI</th><th class="r">Net</th></tr></thead><tbody>
    ${[...months].reverse().map((m) => `<tr><td>${monthName(m.month)}</td><td class="r">${m.trips}</td><td class="r">${indian(m.tonnes, 1)}</td><td class="r">${rupees(m.bhada)}</td><td class="r">${rupees(m.ssfcNet)}</td><td class="r ${signed(m.income + m.emi)}">${rupees(m.income + m.emi)}</td><td class="r">${rupees(m.emi)}</td><td class="r ${signed(m.income)}">${rupees(m.income)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function vehicleRankHtml(rows, sort) {
  const val = (r) => (sort === 'before' ? r.income + r.emi : r[sort]);
  const list = [...rows].sort((a, b) => val(b) - val(a));
  const max = Math.max(1, ...list.map((r) => Math.abs(val(r))));
  const show = (r) => (sort === 'trips' ? `${r.trips}` : sort === 'tonnes' ? tonnes(r.tonnes, 1) : money(val(r)));
  return `<ol class="rank">${list.map((r, i) => `<li><a class="rank-row" href="#/vehicle/${encodeURIComponent(r.veh)}">
    <span class="n">${i + 1}</span>
    <span class="who"><b>${esc(r.veh)}</b><small class="muted">${plural(r.trips, 'trip')} · ${tonnes(r.tonnes, 1)}</small>
      <span class="mini-track"><span class="mini"><i style="width:${((Math.abs(val(r)) / max) * 100).toFixed(1)}%;background:${val(r) < 0 ? 'var(--s-neg)' : S1}"></i></span></span></span>
    <span class="amt"><b class="${signed(val(r))}">${show(r)}</b><small>${sort === 'income' ? `before EMI ${money(r.income + r.emi)}` : `net ${money(r.income)}`}</small></span></a></li>`).join('')}</ol>`;
}

function routesHtml(routes) {
  return `<div class="table-wrap"><table class="compact"><thead><tr><th>Route</th><th class="r">Trips</th><th class="r">Avg load</th><th class="r">₹ / T</th><th class="r">Diesel / trip</th><th class="r">Days</th><th class="r">Before EMI / trip</th><th class="r">Net / trip</th></tr></thead><tbody>
    ${routes.map((r) => `<tr><td><a href="#/trips?r=${encodeURIComponent(r.route)}">${esc(r.route)}</a></td><td class="r">${r.trips}</td><td class="r">${r.avgLoad.toFixed(2)} T</td><td class="r">₹${indian(r.perTonne)}</td><td class="r">${Math.round(r.dieselPerTrip)} L</td><td class="r">${r.days ? r.days.toFixed(1) : '—'}</td><td class="r ${signed(r.income + r.emi)}">${money((r.income + r.emi) / r.trips)}</td><td class="r ${signed(r.income)}">${money(r.perTrip)}</td></tr>`).join('')}
  </tbody></table></div><p class="muted small">Days = trip start to unloading. EMI is charged on one trip a month, so “before EMI” compares routes fairly.</p>`;
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------
async function viewTrips(q) {
  const d = state.data;
  const { vehicles, issues } = derived();
  const f = q.get('f') || 'all';
  const veh = q.get('v') || '';
  const mon = q.get('m') || '';
  const rt = q.get('r') || '';
  const text = (q.get('q') || '').toLowerCase();
  const odd = new Map(issues.map((x) => [x.t.row, x.why]));
  let list = [...d.trips].sort((a, b) => b.row - a.row);
  if (f === 'road') list = list.filter((t) => t.status !== 'done');
  if (f === 'done') list = list.filter((t) => t.status === 'done');
  if (f === 'short') list = list.filter((t) => (t.diff || 0) < -0.1);
  if (f === 'under') { const L = derived().loads; list = list.filter((t) => { const b = L.get(t.row); return b && (b.grade === 'low' || b.grade === 'poor'); }); }
  if (f === 'loss') list = list.filter((t) => t.status === 'done' && (t.income || 0) + (t.emi || 0) < 0);
  if (f === 'check') list = list.filter((t) => odd.has(t.row));
  if (veh) list = list.filter((t) => t.veh === veh);
  if (mon) list = list.filter((t) => t.month === mon);
  if (rt) list = list.filter((t) => routeOf(t) === rt);
  if (text) list = list.filter((t) => `${t.trip} ${t.veh} ${t.remarks} ${t.port} ${t.dest}`.toLowerCase().includes(text));
  const T = totals(list);
  const all = state.ui.allTrips;
  const shown = all ? list : list.slice(0, 80);
  const months = [...new Set(d.trips.map((t) => t.month).filter(Boolean))].sort().reverse();
  const routes = [...new Set(d.trips.map(routeOf))].sort();
  const link = (patch) => {
    const p = new URLSearchParams({ f, v: veh, m: mon, r: rt, q: q.get('q') || '', ...patch });
    [...p.keys()].forEach((k) => { if (!p.get(k) || (k === 'f' && p.get(k) === 'all')) p.delete(k); });
    const s = p.toString();
    return `#/trips${s ? `?${s}` : ''}`;
  };
  setMain(`<section class="card">
    <div class="row-between"><h2>Trips</h2><span class="muted small">${plural(list.length, 'trip')}</span></div>
    <div class="chips" role="group" aria-label="Show">
      ${[['all', 'All'], ['road', 'On the road'], ['done', 'Unloaded'], ['short', 'Short weight'], ['under', 'Under-loaded'], ['loss', 'Loss before EMI'], ['check', `Dates to check${issues.length ? ` (${issues.length})` : ''}`]].map(([k, n]) => `<a class="chip${f === k ? ' on' : ''}" href="${link({ f: k })}">${n}</a>`).join('')}
    </div>
    <form class="row-form" id="trip-filter">
      <label>Vehicle <select name="v"><option value="">All vehicles</option>${vehicles.map((v) => `<option${v === veh ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label>Month loaded <select name="m"><option value="">All months</option>${months.map((m) => `<option value="${m}"${m === mon ? ' selected' : ''}>${monthLong(m)}</option>`).join('')}</select></label>
      <label>Route <select name="r"><option value="">All routes</option>${routes.map((r) => `<option${r === rt ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
      <label>Search <input name="q" type="search" value="${esc(q.get('q') || '')}" placeholder="Trip no, remarks…"></label>
    </form>
    <div class="sumline"><span><b>${tonnes(T.tonnes, 1)}</b> loaded</span><span><b>${money(T.bhada)}</b> freight</span><span><b>${money(T.ssfcNet)}</b> SSFC net</span><span><b class="${signed(T.income + T.emi)}">${money(T.income + T.emi)}</b> before EMI</span><span><b class="${signed(T.income)}">${money(T.income)}</b> net</span></div>
    ${loadLegend(list)}
    <div class="trips">
      <div class="trow head"><span>Loaded</span><span>Trip</span><span class="r">Tonnes</span><span class="r">Freight</span><span class="r">SSFC net</span><span class="r">Net</span></div>
      ${shown.map((t) => tripRow(t, odd.get(t.row))).join('') || '<p class="muted">No trips match.</p>'}
    </div>
    ${list.length > shown.length ? `<button class="btn ghost small" id="all-trips">Show all ${list.length}</button>` : ''}
  </section>`);
  const form = document.getElementById('trip-filter');
  const go = () => { location.hash = link({ v: form.v.value, m: form.m.value, r: form.r.value, q: form.q.value.trim() }); };
  form.querySelectorAll('select').forEach((s) => s.addEventListener('change', go));
  let tq;
  form.q.addEventListener('input', () => { clearTimeout(tq); tq = setTimeout(go, 400); });
  form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  if (text) { form.q.focus(); form.q.setSelectionRange(form.q.value.length, form.q.value.length); }
  document.getElementById('all-trips')?.addEventListener('click', () => { state.ui.allTrips = true; rerender(); });
}

const loadCls = (t) => { const b = derived().loads.get(t.row); return b ? LOAD_GRADES[b.grade].cls : ''; };
const loadTitle = (t) => { const b = derived().loads.get(t.row); return b ? `${LOAD_GRADES[b.grade].name}: ${b.gapNear ? `${b.gapNear.toFixed(2)} T below ` : ''}the best on the route then (${b.near.toFixed(2)} T)` : ''; };
// what the load colours mean, and what under-loading cost on these trips
function loadLegend(trips) {
  const L = loadSummary(trips, derived().loads);
  if (!L.trips) return '';
  return `<p class="load-legend small"><span class="muted">Load vs the best on the same route then (overload is paid for — fuller is better):</span>
    <span class="load-top">● full ${L.top}</span><span class="load-ok">● near full ${L.ok}</span><span class="load-low">● under ${L.low}</span><span class="load-poor">● well under ${L.poor}</span>
    <span class="muted">· ${tonnes(L.lostT, 1)} short of the best · <b class="${L.lostRs > 0 ? 'warn-text' : ''}">${money(L.lostRs)}</b> freight missed</span></p>`;
}
// a trip's diesel against its allotment, with what it carries in from the trips before
const L1 = (n) => `${indian(Math.abs(n), Math.abs(n) % 1 && Math.abs(n) < 100 ? 1 : 0)} L`;
function dieselTone(z) {
  if (!z || z.allotted == null) return '';
  if (z.extra > 0.5 || z.after < -100) return 'bad';
  if (z.after < -0.5) return 'warn';
  return 'good';
}
function dieselLine(z) {
  if (!z || z.allotted == null) return '';
  if (z.live) {
    if (z.extra > 0.5) return `${L1(z.taken)} of ${L1(z.allotted)} — ${L1(z.extra)} extra${z.carryIn < -0.5 ? `, ${L1(-z.after)} owed in all` : ''}`;
    return `${L1(z.taken)} of ${L1(z.allotted)}${z.est ? ' (est.)' : ''} taken · ${L1(z.mayTake)} more may be taken${z.carryIn < -0.5 ? ` (${L1(-z.carryIn)} owed from before)` : ''}`;
  }
  return `${L1(z.taken)} of ${L1(z.allotted)}${z.extra > 0.5 ? ` — ${L1(z.extra)} extra` : ''} · balance after ${z.after > 0 ? '+' : z.after < 0 ? '−' : ''}${L1(z.after)}`;
}
function dieselPanelHtml(z) {
  if (!z) return '<p class="muted small">This trip is before the diesel recon starts.</p>';
  if (z.allotted == null) return `<p class="muted small">No diesel set for ${esc(routeOf(z.t))} — set it in <a href="#/setup">Setup</a> or the Rates sheet.</p>`;
  const tone = dieselTone(z);
  const scale = Math.max(z.allotted, z.taken, z.allotted + Math.max(0, z.carryIn), 1);
  const pct = (v) => `${Math.max(0, Math.min(100, (v / scale) * 100)).toFixed(1)}%`;
  const within = Math.min(z.taken, z.allotted);
  const limit = z.allotted + Math.min(0, z.carryIn);                           // what may be taken in all, after what's owed
  const cell = (lbl, val, sub, cls = '') => `<div class="dz-cell ${cls}"><span class="lbl">${lbl}</span><b>${val}</b><small>${sub}</small></div>`;
  return `<div class="dz-panel ${tone}">
    <div class="dz-bar" role="img" aria-label="${esc(dieselLine(z))}">
      <span class="dz-taken" style="width:${pct(within)}"></span>${z.extra > 0.5 ? `<span class="dz-extra" style="left:${pct(z.allotted)};width:${pct(z.extra)}"></span>` : ''}
      <i class="dz-mark" style="left:${pct(z.allotted)}" title="the allotment"></i>
      ${z.carryIn < -0.5 ? `<i class="dz-mark dz-limit" style="left:${pct(Math.max(0, limit))}" title="the limit after what's owed"></i>` : ''}
    </div>
    <p class="dz-key"><span><i class="k-taken"></i>taken</span>${z.extra > 0.5 ? '<span><i class="k-extra"></i>extra</span>' : ''}<span><i class="k-mark"></i>allotment ${L1(z.allotted)}</span>${z.carryIn < -0.5 ? `<span><i class="k-limit"></i>limit after what's owed ${L1(Math.max(0, limit))}</span>` : ''}</p>
    <div class="dz-grid">
      ${cell('Allotted', L1(z.allotted), z.est ? 'route diesel — over/underload once loaded' : `${z.base ?? '—'} base${z.over ? ` + ${z.over.toFixed(1)} overload` : ''}${z.under ? ` − ${z.under} underload` : ''}`)}
      ${cell('Taken', L1(z.taken), `${plural(z.fills.length, 'fill')}${z.fills.length ? ` · last ${shortDate(z.fills[z.fills.length - 1].date)}` : ''}`)}
      ${z.live ? cell('To take', L1(z.toTake), 'left of this trip\'s allotment') : ''}
      ${cell('Extra this trip', z.extra > 0.5 ? `+${L1(z.extra)}` : '—', z.extra > 0.5 ? 'over the allotment — to be cut from the next trips' : 'within the allotment', z.extra > 0.5 ? 'bad' : '')}
      ${cell('Carried in', z.carryIn < -0.5 ? `−${L1(-z.carryIn)}` : z.carryIn > 0.5 ? `+${L1(z.carryIn)}` : '—', z.carryIn < -0.5 ? 'extra from earlier trips, owed' : z.carryIn > 0.5 ? 'saved on earlier trips' : 'nothing owed from before', z.carryIn < -0.5 ? 'warn' : '')}
      ${z.live ? cell('May still take', L1(z.mayTake), z.carryIn < -0.5 ? 'after cutting what\'s owed' : 'for the rest of the trip', z.mayTake < 0.5 ? 'bad' : 'good') : ''}
      ${cell(z.live ? 'Balance if no more' : 'Balance after', `${z.after > 0.5 ? '+' : z.after < -0.5 ? '−' : ''}${L1(z.after)}`, z.after < -0.5 ? 'owed — comes off the next trips' : z.after > 0.5 ? 'saved' : 'square', z.after < -0.5 ? 'bad' : 'good')}
    </div>
    ${z.extraHsd ? `<p class="small muted">Plus ${L1(z.extraHsd)} extra HSD bought on the trip (own, outside the recon).</p>` : ''}
  </div>`;
}
function tripRow(t, why) {
  const day = t.loadDate || t.start;
  const diff = t.diff ? `<span class="pill ${t.diff < -0.1 ? 'bad-pill' : t.diff < 0 ? 'warn-pill' : 'good-pill'}">${t.diff > 0 ? '+' : '−'}${Math.abs(t.diff).toFixed(2)}</span>` : '';
  return `<a class="trow${t.status !== 'done' ? ' open' : ''}" href="#/trip/${t.row}">
    <span class="s-date">${day ? `<b>${Number(day.slice(8))}</b><small>${shortDate(day).split(' ')[1]} ${day.slice(2, 4)}</small>` : '—'}</span>
    <span class="t-main"><b>${esc(t.trip)}</b> <span class="b-veh">${esc(t.veh)}</span>${t.status !== 'done' ? ` ${statusPill(t)}` : ''}${why ? ' <span class="pill bad-pill">check date</span>' : ''}
      <small>${esc(routeOf(t))}${t.remarks ? ` · ${esc(t.remarks)}` : ''}</small></span>
    <span class="r t-ton ${t.loadWt ? loadCls(t) : ''}" title="${t.loadWt ? esc(loadTitle(t)) : ''}">${t.loadWt ? `${t.loadWt.toFixed(2)} T` : '—'} ${diff}</span>
    <span class="r t-fr">${t.bhada ? rupees(t.bhada) : '—'}</span>
    <span class="r t-net">${t.ssfcNet != null ? rupees(t.ssfcNet) : '—'}</span>
    <span class="r t-inc ${signed(t.income)}">${t.income != null ? rupees(t.income) : '—'}${t.emi ? '<small>incl. EMI</small>' : ''}</span></a>`;
}

function driverLine(t) {
  const { drivers: dc, kms } = derived();
  const r = dc.rows.find((x) => x.t === t);
  const k = kms.get(t.row);
  const km = k && k.complete && k.km ? `<p class="small muted">Distance ${indian(k.km)} km (${k.empty ? `${indian(k.empty)} empty + ` : ''}${indian(k.loaded)} loaded)${dieselLitres(t) ? ` · ${(k.km / dieselLitres(t)).toFixed(2)} km/L` : ''}</p>` : '';
  const info = dc.tripInfo(t);
  const paid = info && info.paid.length ? `<p class="small muted">Advances in this trip (Driver Payment): ${info.paid.map((x) => `${fmtDate(x.date)} ${rupees(x.amount)} to ${esc(x.name)}${x.note ? ` (${esc(x.note)})` : ''}`).join(' · ')}</p>` : '';
  if (!r) return km + paid;
  if (r.salary == null) return `${km}${paid}<p class="small muted">Driver salary for ${esc(routeOf(t))} isn't set — <a href="#/setup">Setup</a>.</p>`;
  return `${km}<div class="drv-line ${r.over > dc.tolerance ? 'bad' : ''}"><span>Driver salary <b>${rupees(r.salary)}</b></span><span>− your advance <b>${rupees(r.advance)}</b></span><span>= SSFC should pay <b>${rupees(r.expected)}</b></span><span>SSFC paid <b>${rupees(r.ssfc)}</b></span>
    <span class="${r.over > dc.tolerance ? 'bad-text' : r.over < -dc.tolerance ? '' : 'good-text'}"><b>${r.over > dc.tolerance ? `Overpaid ${rupees(r.over)}` : r.over < -dc.tolerance ? `${rupees(-r.over)} less` : '✓ matches'}</b></span></div>${paid}`;
}

// ---------------------------------------------------------------------------
// Day book: every dated entry in the workbook, day by day
// ---------------------------------------------------------------------------
function briefCtx() {
  const x = derived();
  const lastFill = [...state.data.hsd].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  return { status: x.status, live: x.liveTrips, loads: x.loads, account: x.account, recon: x.recon, drivers: x.drivers, issues: x.issues, driverNow, tripDiesel: x.tripDiesel, dieselPrice: lastFill ? lastFill.rsp : 0 };
}
const DAY_LINK = (e) => (e.t ? `#/trip/${e.t.row}` : e.kind === 'advance' ? `#/drivers/${encodeURIComponent(e.veh)}` : e.kind === 'ssfc' ? '#/ssfc' : `#/vehicle/${encodeURIComponent(e.veh)}`);
function dayState() {
  const ui = state.ui.day || (state.ui.day = { r: 'today', from: null, to: null, kinds: [], veh: '', days: 31 });
  const R = dayRanges(today());
  if (ui.r !== 'custom' && R[ui.r]) { ui.from = R[ui.r].from; ui.to = R[ui.r].to; }
  if (!ui.from) { ui.from = today(); ui.to = today(); }
  return { ui, R };
}
function dayAll() {
  const x = derived();
  if (!x.dayAll) x.dayAll = dayEntries(state.data, { driverOf: x.drivers.byPayments ? x.drivers.tripDriver : null, payments: x.account ? x.account.payments : [] });
  return x.dayAll;
}
const dayRangeText = (from, to) => (from === to ? longDate(from) : `${dateYear(from)} – ${dateYear(to)}`);
function daySumText(s) {
  return [
    s.loads ? `${plural(s.loads, 'loading')} · ${tonnes(s.tonnes, 1)} · ${money(s.freight)}` : '',
    s.unloads ? `${plural(s.unloads, 'unloading')}${s.short < 0 ? ` · ${tonnes(-s.short)} short` : ''}` : '',
    s.fills ? `diesel ${litres(s.litres)} · ${money(s.diesel)}` : '',
    s.urea ? `urea ${money(s.urea)}` : '',
    s.advances ? `advances ${money(s.advances)}` : '',
    s.received ? `SSFC paid ${money(s.received)}` : '',
  ].filter(Boolean).join('  ·  ');
}
function dayRight(e) {
  if (e.kind === 'load') {
    const b = e.t && derived().loads.get(e.t.row);
    return `<b>${rupees(e.amount)}</b>${b ? `<small class="${LOAD_GRADES[b.grade].cls}">${b.grade === 'top' ? '★ full load' : `−${b.gapNear.toFixed(2)} T vs best`}</small>` : '<small>freight</small>'}`;
  }
  if (e.kind === 'unload') return `<b>${e.tonnes ? tonnes(e.tonnes) : '—'}</b>${e.short < 0 ? `<small class="bad-text">${tonnes(-e.short)} short</small>` : '<small>delivered</small>'}`;
  if (e.kind === 'diesel') return `<b>${rupees(e.amount)}</b><small>${litres(e.litres)}</small>`;
  if (e.kind === 'urea') return `<b>${rupees(e.amount)}</b><small>${e.litres ? `${indian(e.litres, 1)} L` : 'urea'}</small>`;
  if (e.kind === 'advance') return `<b class="warn-text">${rupees(e.amount)}</b><small>paid out</small>`;
  if (e.kind === 'ssfc') return `<b class="good-text">${rupees(e.amount)}</b><small>received</small>`;
  return '';
}

async function viewDaybook() {
  const { ui, R } = dayState();
  const all = dayAll();
  const issues = new Set(derived().issues.map((x) => x.t.row));
  const kinds = ui.kinds.length ? new Set(ui.kinds) : null;
  const book = dayBook(all, { from: ui.from, to: ui.to, kinds, veh: ui.veh });
  const inRange = dayBook(all, { from: ui.from, to: ui.to, veh: ui.veh });            // for the counts on the type chips
  const count = (k) => inRange.list.filter((e) => e.kind === k).length;
  const S = book.sums;
  const latest = all.find((e) => e.date <= today());
  const shown = book.days.slice(0, ui.days);
  const tile = (lbl, val, sub, cls = '') => `<div class="kpi ${cls}"><span class="lbl">${lbl}</span><span class="val">${val}</span><span class="sub">${sub}</span></div>`;
  const ob = ownerBrief(state.data, briefCtx(), today());
  const TONE_CLS = { good: 'good-text', warn: 'warn-text', bad: 'bad-text', info: '' };
  setMain(`<section class="card brief-card">
    <div class="row-between"><h2>Today's brief <span class="muted small">${esc(longDate(today()))}</span></h2>
      <span class="row-gap">${shareBtn('share-drivers', 'Drivers (हिंदी)')}${shareBtn('share-owner', 'Owner')}</span></div>
    <p class="muted small">For you below; for the drivers' WhatsApp group, a picture in Hindi — each truck's next stop with the date to reach it by, its pace and load.</p>
    ${ob.sections.map((sec) => `<h3 class="sub-h">${esc(sec.title)}</h3><ul class="brief">${sec.items.map((it) => `<li class="tone-${it.tone}">${it.href ? `<a href="${it.href}">` : ''}<span class="${TONE_CLS[it.tone]}">${esc(it.text)}</span>${it.href ? '</a>' : ''}</li>`).join('')}</ul>`).join('')}
  </section>
  <section class="card">
    <div class="row-between"><h2>Day book</h2><span class="row-gap"><span class="muted small">${esc(dayRangeText(ui.from, ui.to))}</span>${book.list.length ? shareBtn('share-day') : ''}</span></div>
    <p class="muted small">Everything in the workbook with a date: trips started, loaded and unloaded, diesel fills, urea, driver advances and SSFC payments. A trip's other costs (fastag, tyre, maintenance…) have no date of their own — they're on each trip.</p>
    <div class="chips period" role="group" aria-label="Dates">
      ${Object.entries(R).map(([k, r]) => `<button class="chip${ui.r === k ? ' on' : ''}" data-dr="${k}" aria-pressed="${ui.r === k}">${esc(r.label)}</button>`).join('')}
      <button class="chip${ui.r === 'custom' ? ' on' : ''}" data-dr="custom" aria-pressed="${ui.r === 'custom'}">Custom</button>
    </div>
    ${ui.r === 'custom' ? `<form class="custom-range" id="day-range"><label>From <input type="date" name="from" value="${ui.from}"></label><label>To <input type="date" name="to" value="${ui.to}"></label><button class="btn small" type="submit">Show</button></form>` : ''}
    <div class="day-nav"><button class="btn ghost small" data-shift="-1" type="button">‹ Earlier</button><b>${esc(dayRangeText(ui.from, ui.to))}</b><button class="btn ghost small" data-shift="1" type="button"${ui.to >= today() ? ' disabled' : ''}>Later ›</button></div>
    <div class="day-filters">
      <div class="chips small-chips" role="group" aria-label="What">
        <button class="chip${!kinds ? ' on' : ''}" data-dk="" aria-pressed="${!kinds}">All · ${inRange.list.length}</button>
        ${DAY_KINDS.map((k) => `<button class="chip${kinds && kinds.has(k.key) ? ' on' : ''}" data-dk="${k.key}" aria-pressed="${!!(kinds && kinds.has(k.key))}"><i class="dot" style="background:${k.color}"></i>${esc(k.name)} · ${count(k.key)}</button>`).join('')}
      </div>
      <label class="inline-label">Vehicle <select id="day-veh"><option value="">All vehicles</option>${vehiclesOf(state.data).map((v) => `<option value="${esc(v)}"${ui.veh === v ? ' selected' : ''}>${esc(v)}${driverNow(v) ? ` · ${esc(driverNow(v))}` : ''}</option>`).join('')}</select></label>
    </div>
    <div class="kpis">
      ${tile('Loaded', S.loads ? `${S.loads} · ${tonnes(S.tonnes, 1)}` : '—', S.loads ? `freight ${money(S.freight)}` : 'no loading')}
      ${tile('Unloaded', S.unloads ? `${S.unloads} · ${tonnes(S.delivered, 1)}` : '—', S.short < 0 ? `${tonnes(-S.short)} short` : S.unloads ? 'no shortage' : 'no unloading', S.short < -0.5 ? 'warn' : '')}
      ${tile('Diesel', S.fills ? litres(S.litres) : '—', S.fills ? `${money(S.diesel)} · ${plural(S.fills, 'fill')}${S.ssfcLitres ? (Math.abs(S.ssfcLitres - S.litres) < 0.5 ? ' · all at SSFC pumps' : ` · ${Math.round((S.ssfcLitres / S.litres) * 100)}% at SSFC pumps`) : ''}` : 'no fill')}
      ${tile('Urea', S.urea ? money(S.urea) : '—', S.ureaL ? `${indian(S.ureaL, 1)} L` : 'none')}
      ${tile('Driver advances', S.advances ? money(S.advances) : '—', S.advanceN ? plural(S.advanceN, 'payment') : 'none')}
      ${tile('SSFC received', S.received ? money(S.received) : '—', S.receivedN ? plural(S.receivedN, 'payment') : 'none', S.received ? 'good' : '')}
    </div>
  </section>
  ${shown.map((day) => `<section class="card day-card">
    <div class="day-head"><h3>${esc(longDate(day.date))}${day.date === today() ? ' <span class="pill fuel-pill">Today</span>' : ''}</h3><span class="muted small">${esc(daySumText(day.sums))}</span></div>
    <div class="day-list">${day.entries.map((e) => { const k = DAY_KINDS.find((x) => x.key === e.kind); const odd = e.t && issues.has(e.t.row) && (e.kind === 'unload' || e.kind === 'load'); return `<a class="day-row" href="${DAY_LINK(e)}">
      <span class="day-kind" style="--k:${k.color}"><i></i>${esc(k.name)}</span>
      <span class="day-veh">${esc(shortVeh(e.veh))}</span>
      <span class="day-what"><b>${esc(e.title)}</b><small>${esc(e.detail)}${odd ? ' <span class="pill warn-pill">date to check</span>' : ''}</small></span>
      <span class="day-amt">${dayRight(e)}</span></a>`; }).join('')}</div>
  </section>`).join('')}
  ${book.days.length > shown.length ? `<p class="center-p"><button class="btn ghost" id="day-more">${plural(book.days.length - shown.length, 'more day')}</button></p>` : ''}
  ${!book.list.length ? `<section class="card"><p class="muted">Nothing ${kinds || ui.veh ? 'of this kind ' : ''}on ${ui.from === ui.to ? 'this day' : 'these days'}.</p>${latest && latest.date < ui.from ? `<button class="btn small" id="day-latest">Go to ${esc(longDate(latest.date))}, the latest day with entries</button>` : ''}</section>` : ''}`);
  const m = main();
  m.querySelectorAll('[data-dr]').forEach((b) => b.addEventListener('click', () => { ui.r = b.dataset.dr; ui.days = 31; rerender(); }));
  m.querySelector('#day-range')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const from = e.target.from.value;
    const to = e.target.to.value;
    if (!from || !to || to < from) { toast('Pick a From date on or before the To date.', 'bad'); return; }
    ui.from = from; ui.to = to; ui.days = 31;
    rerender();
  });
  m.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => {
    const r = shiftRange(ui.from, ui.to, Number(b.dataset.shift));
    ui.r = 'custom'; ui.from = r.from; ui.to = r.to; ui.days = 31;
    rerender();
  }));
  m.querySelectorAll('[data-dk]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.dk;
    if (!k) ui.kinds = [];
    else ui.kinds = ui.kinds.includes(k) ? ui.kinds.filter((x) => x !== k) : [...ui.kinds, k];
    rerender();
  }));
  m.querySelector('#day-veh').addEventListener('change', (e) => { ui.veh = e.target.value; rerender(); });
  m.querySelector('#day-more')?.addEventListener('click', () => { ui.days += 31; rerender(); });
  m.querySelector('#day-latest')?.addEventListener('click', () => { ui.r = 'custom'; ui.from = latest.date; ui.to = latest.date; rerender(); });
  m.querySelector('#share-drivers').addEventListener('click', () => sharePictures("Drivers' instructions (Hindi)", [{ label: 'हिंदी', make: async () => {
    const kit = await shareKit();
    const hi = await hindiFontCss();
    return cardFiles(driverBriefSvg(driverBrief(state.data, briefCtx(), today()), { ...kit, fontCss: `${kit.fontCss}\n${hi}` }), `Driver instructions ${fmtDate(today())}`);
  } }]));
  m.querySelector('#share-owner').addEventListener('click', () => sharePictures("Owner's insight", [{ label: 'Insight', make: async () => cardFiles(ownerBriefSvg(ownerBrief(state.data, briefCtx(), today()), await shareKit()), `Daily insight ${fmtDate(today())}`) }]));
  m.querySelector('#share-day')?.addEventListener('click', () => {
    const label = dayRangeText(ui.from, ui.to);
    const what = [kinds ? DAY_KINDS.filter((k) => kinds.has(k.key)).map((k) => k.name).join(', ') : '', ui.veh].filter(Boolean).join(' · ');
    sharePictures('Day book', [{ label: 'Day book', make: async () => pageFiles(daybookPagesSvg(book, { ...(await shareKit()), label, what, driverOf: (v) => driverNow(v), loads: derived().loads }), `Day book ${ui.from === ui.to ? fmtDate(ui.from) : `${fmtDate(ui.from)} to ${fmtDate(ui.to)}`}${ui.veh ? ` ${ui.veh}` : ''}`) }]);
  });
}

async function viewTrip(row) {
  const d = state.data;
  const t = d.trips.find((x) => x.row === row);
  if (!t) { setMain('<section class="card"><p>No such trip.</p><a class="btn ghost" href="#/trips">All trips</a></section>'); return; }
  const { recon, issues } = derived();
  const rec = recon.vehicles.find((v) => v.veh === t.veh)?.list.find((x) => x.t.row === row);
  const why = issues.find((x) => x.t.row === row)?.why;
  const fills = d.hsd.filter((h) => h.veh === t.veh && h.trip === t.trip);
  const ureas = d.urea.filter((u) => u.veh === t.veh && u.trip === t.trip);
  const line = (name, v, cls = '') => (v ? `<div class="ln ${cls}"><span>${esc(name)}</span><b>${cls.includes('minus') ? '− ' : ''}${rupees(v)}</b></div>` : '');
  const days = tripDays(t);
  setMain(`<section class="card">
    <a class="muted small" href="#/trips">← Trips</a>
    <div class="acct-top"><div class="acct-id"><span class="avatar">${esc(shortVeh(t.veh))}</span><div><h2>${esc(t.trip)}</h2><p class="muted">${vehLink(t.veh)} · ${esc(routeOf(t))}${derived().drivers.tripDriver(t) ? ` · driver <b>${esc(derived().drivers.tripDriver(t))}</b>` : ''}</p></div></div><span class="row-gap">${statusPill(t)}${shareBtn('share-trip')}</span></div>
    ${why ? `<div class="todo warn" style="margin-top:12px">Check this trip in Excel: ${esc(why)}.</div>` : ''}
    <div class="bulker-hero">${bulkerFor(t.loadWt ? t : null, { animate: true })}
      <p class="bk-cap">${t.loadWt ? `<b>${t.loadWt.toFixed(2)} T</b> of alumina · tare ${t.tare ? t.tare.toFixed(2) : '—'} T · gross <b>${t.gross ? t.gross.toFixed(2) : '—'} T</b> ${weightLine(t)}` : 'Not loaded yet'}</p></div>
    <div class="timeline">
      <div class="${t.start ? 'on' : ''}"><small>Trip start</small><b>${t.start ? dateYear(t.start) : '—'}</b></div>
      <div class="${t.loadDate ? 'on' : ''}"><small>Loaded at ${esc(t.port)}</small><b>${t.loadDate ? dateYear(t.loadDate) : '—'}</b></div>
      <div class="${t.unloadDate ? 'on' : ''}"><small>Unloaded at ${esc(t.dest)}</small><b>${t.unloadDate ? dateYear(t.unloadDate) : '—'}</b></div>
      <div class="on"><small>${t.unloadDate ? 'Trip took' : 'On the road for'}</small><b>${t.unloadDate ? (days != null ? `${days} days` : '—') : t.start ? `${daysBetween(t.start, today())} days` : '—'}</b></div>
    </div>
    <div class="kpis acct-kpis">
      <div class="kpi"><span class="lbl">Loaded</span><span class="val">${t.loadWt ? tonnes(t.loadWt) : '—'}</span><span class="sub">tare ${t.tare ? t.tare.toFixed(2) : '—'} · gross ${t.gross ? t.gross.toFixed(2) : '—'}</span></div>
      <div class="kpi"><span class="lbl">Unloaded</span><span class="val">${t.unloadWt ? tonnes(t.unloadWt) : '—'}</span><span class="sub">${t.diff ? `${t.diff > 0 ? 'excess' : 'short'} ${Math.abs(t.diff).toFixed(2)} T` : t.unloadWt ? 'no difference' : ''}</span></div>
      <div class="kpi hero"><span class="lbl">Freight</span><span class="val">${t.bhada ? rupees(t.bhada) : '—'}</span><span class="sub">${t.loadWt ? `${t.loadWt.toFixed(2)} T × ₹${indian(t.rate || 0)}` : ''}</span></div>
      <div class="kpi"><span class="lbl">Net after EMI</span><span class="val ${signed(t.income)}">${t.income != null ? rupees(t.income) : '—'}</span><span class="sub">${t.emi ? `before EMI ${rupees(t.income + t.emi)}` : t.status !== 'done' ? 'costs may still be added' : ''}</span></div>
    </div>
  </section>
  ${t.bhada ? `<section class="card"><h3>The trip's money</h3>
    <div class="ledger-lines">
      ${line('Trip bhada', t.bhada, 'big')}
      <p class="ln-h">Taken by SSFC</p>
      ${line(`SSFC diesel${t.ssfcLtr ? ` (${t.ssfcLtr} L)` : ''}`, t.ssfcAmt, 'minus')}${line('Driver SSFC payment', t.drvSsfc, 'minus')}${line('SSFC misc', t.ssfcMisc, 'minus')}
      ${line('Fastag', t.fastag, 'minus')}${line('Maintenance', t.maint, 'minus')}${line('Tyre', t.tyre, 'minus')}${line('Less over/unload', t.lessOver, 'minus')}
      ${line('RTO entry', t.rtoEntry, 'minus')}${line('RTO challan', t.rtoChallan, 'minus')}${line('Shortage', t.shortage, 'minus')}${line('Document expense', t.docExp, 'minus')}
      <div class="ln total"><span>SSFC net amount</span><b>${rupees(t.ssfcNet)}</b></div>
      <p class="ln-h">Paid by you</p>
      ${line(`Own diesel${t.ownLtr ? ` (${t.ownLtr} L)` : ''}`, t.ownAmt, 'minus')}${line(`Extra HSD${t.extraLtr ? ` (${t.extraLtr} L)` : ''}`, t.extraAmt, 'minus')}
      ${line('Urea', t.urea, 'minus')}${line('Extra driver pay', t.drvExtra, 'minus')}${line('Trip driver payment', t.drvTrip, 'minus')}
      ${line('Own document expense', t.docOwn, 'minus')}${line('Own misc kharcha', t.ownMisc, 'minus')}${line('EMI (installment)', t.emi, 'minus')}
      ${!ownExpenses(t) ? '<div class="ln muted"><span>Nothing yet</span><b></b></div>' : ''}
      <div class="ln total"><span>Income from the trip</span><b class="${signed(t.income)}">${rupees(t.income)}</b></div>
      ${t.drvDebit ? `<div class="ln muted"><span>Driver debit (not in income)</span><b>${rupees(t.drvDebit)}</b></div>` : ''}
    </div>
    ${driverLine(t)}
    ${t.remarks ? `<p class="remark">“${esc(t.remarks)}”</p>` : ''}
  </section>` : t.remarks ? `<section class="card"><p class="remark">“${esc(t.remarks)}”</p></section>` : ''}
  ${sameTimeHtml(t)}
  <section class="card"><div class="row-between"><h3>Diesel</h3><span class="muted small">${litres(dieselLitres(t))} filled · ${money(dieselAmount(t))}</span></div>
    ${dieselPanelHtml(derived().tripDiesel.get(t.row))}
    ${fills.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>Pump</th><th>Where</th><th class="r">Litres</th><th class="r">₹/L</th><th class="r">Amount</th></tr></thead><tbody>
      ${fills.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${esc(h.source)}</td><td>${esc(h.location)}</td><td class="r">${indian(h.qty, 2)}</td><td class="r">${h.rsp.toFixed(2)}</td><td class="r">${rupees(h.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No HSD fills tagged to this trip in HSD Data.</p>'}
    ${ureas.length ? `<p class="small muted">Urea: ${ureas.map((u) => `${fmtDate(u.date)} ${indian(u.qty, 1)} L from ${esc(u.from)} (${rupees(u.amount)})`).join(' · ')}</p>` : ''}
  </section>`);
  bindCharts(main());
  document.getElementById('share-trip').addEventListener('click', () => shareTrip(t));
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------
async function viewVehicles() {
  const p = currentPeriod();
  const { vehicles, status, recon } = derived();
  const rows = byVehicle(state.data.trips.filter((t) => inPeriod(t, p)), vehicles);
  setMain(`<section class="card">
    <div class="row-between"><h2>Vehicles</h2><span class="muted small">${esc(periodRange(p))}</span></div>
    ${subNav('cards')}
    ${periodHtml()}
    <div class="co-grid">
      ${rows.map((r) => {
    const s = status.find((x) => x.veh === r.veh);
    const dl = recon.vehicles.find((x) => x.veh === r.veh);
    return `<a class="co-card veh-card ${s.state}" href="#/vehicle/${encodeURIComponent(r.veh)}">
        ${bulkerFor(s.state === 'loaded' ? s.trip : null, { compact: true, veh: r.veh })}
        <div class="co-head"><span class="avatar sm">${esc(shortVeh(r.veh))}</span><b>${esc(r.veh)}</b>${perfBadge(r.veh)}</div>
        <span class="veh-state"><i></i>${esc(s.text)}${s.days != null && s.state !== 'idle' ? ` · day ${s.days}` : ''}</span>
        <span class="co-val ${signed(r.income)}" ${exact(r.income)}>${money(r.income)}</span>
        <dl class="co-facts">
          <dt>Trips</dt><dd>${r.trips} <small>${tonnes(r.tonnes, 1)}</small></dd>
          <dt>Freight</dt><dd>${money(r.bhada)}</dd>
          <dt>Before EMI</dt><dd class="${signed(r.income + r.emi)}">${money(r.income + r.emi)}</dd>
          <dt>Diesel recon</dt><dd class="${dl && dl.balance < 0 ? 'bad-text' : ''}">${dl ? `${dl.balance > 0 ? '+' : ''}${litres(dl.balance)}` : '—'}</dd>
        </dl></a>`;
  }).join('')}
    </div>
    <p class="muted small">The big number is net after EMI for the period. Diesel recon is the running balance since the recon started (− = more issued than allotted).</p>
  </section>`);
  bindPeriod(main());
}

async function viewVehicle(veh) {
  const d = state.data;
  const p = currentPeriod();
  const { status, recon } = derived();
  const s = status.find((x) => x.veh === veh);
  if (!s) { setMain('<section class="card"><p>No such vehicle.</p><a class="btn ghost" href="#/vehicles">All vehicles</a></section>'); return; }
  const mine = d.trips.filter((t) => t.veh === veh);
  const inP = mine.filter((t) => inPeriod(t, p));
  const T = totals(inP);
  const dl = recon.vehicles.find((x) => x.veh === veh);
  const emiNow = [...mine].reverse().find((t) => t.emi)?.emi || 0;
  const cm = chartMonths(p);
  const months = cm ? monthly(mine, cm.from, cm.to) : [];
  setChartWidth(main().clientWidth - 70);
  const recent = [...inP].sort((a, b) => b.row - a.row);
  const KV = kmOf(inP);
  const heroTrip = s.state === 'loaded' ? s.trip : [...mine].reverse().find((t) => t.loadWt && t.status === 'done');
  const liveNow = derived().liveTrips.find((x) => x.veh === veh);
  setMain(`<section class="card">
    <a class="muted small" href="#/vehicles">← Vehicles</a>
    <div class="acct-top"><div class="acct-id"><span class="avatar">${esc(shortVeh(veh))}</span><div><h2>${esc(veh)}</h2><p class="muted">${plural(mine.length, 'trip')} in the register${emiNow ? ` · EMI ${rupees(emiNow)} a month` : ''}</p></div></div>${shareBtn('share-veh')}</div>
    <div class="live-line ${s.state}"><span class="veh-state"><i></i>${esc(s.long)}</span>${s.trip ? ` · <a href="#/trip/${s.trip.row}">${esc(s.trip.trip)}</a> · ${s.state === 'idle' ? '' : `day ${s.days}`}${s.trip.loadWt ? ` · ${s.trip.loadWt.toFixed(2)} T` : ''}` : s.days != null ? ` · ${s.days} days` : ''}</div>
    <div class="bulker-hero">${bulkerFor(heroTrip, { animate: true, veh })}
      <p class="bk-cap">${heroTrip ? `${s.state === 'loaded' ? 'Now carrying' : 'Last load'} <b>${heroTrip.loadWt.toFixed(2)} T</b> of alumina (${esc(heroTrip.trip)}, ${esc(routeOf(heroTrip))}) · gross <b>${heroTrip.gross ? heroTrip.gross.toFixed(2) : '—'} T</b> ${weightLine(heroTrip)}` : 'Empty'}${driverNow(veh) ? ` · driver <b>${esc(driverNow(veh))}</b>` : ''}</p></div>
    ${liveNow ? `<div class="road-card in-page ${paceText(liveNow).cls}"><div class="rc-route"><span class="rc-place"><small>Loading port</small><b>${esc(liveNow.t.port)}</b></span><span class="rc-arrow" aria-hidden="true"></span><span class="rc-place to"><small>Destination</small><b>${esc(liveNow.t.dest)}</b></span></div>
      <div class="rc-phase"><b>${esc(liveNow.phase.title)}</b> <span class="muted">· day ${liveNow.el}</span></div>${stepsHtml(liveNow)}
      <div class="rc-pace ${paceText(liveNow).cls}"><b>${esc(paceText(liveNow).text)}</b>${paceText(liveNow).sub ? `<small>${esc(paceText(liveNow).sub)}</small>` : ''}${liveNow.etaTypical ? `<small>At ${esc(liveNow.t.dest)} ~${dm(liveNow.etaTypical)}${liveNow.etaBest && liveNow.etaBest !== liveNow.etaTypical ? ` (best ${dm(liveNow.etaBest)})` : ''}</small>` : ''}</div>
      <h3 class="sub-h">This trip's projected income</h3>${projHtml(liveNow.projection, { full: true })}</div>` : ''}
    ${periodHtml()}
    ${vehPerfHtml(veh, p)}
    <div class="acct-hero">
      <div><span class="lbl">Net after EMI · ${esc(periodRange(p))}</span><span class="val">${money(T.income)}</span><span class="sub">before EMI ${money(T.income + T.emi)} · EMI ${money(T.emi)}</span></div>
      <div class="side"><span class="lbl">Freight</span><b>${money(T.bhada)}</b><span class="sub">${plural(T.trips, 'trip')} · ${tonnes(T.tonnes, 1)}</span></div>
    </div>
    <div class="kpis acct-kpis">
      <div class="kpi"><span class="lbl">SSFC net</span><span class="val">${money(T.ssfcNet)}</span><span class="sub">${money(T.ssfcDed)} deducted</span></div>
      <div class="kpi"><span class="lbl">Own expenses</span><span class="val">${money(T.own - T.emi)}</span><span class="sub">diesel, urea, driver, misc</span></div>
      <div class="kpi"><span class="lbl">Diesel</span><span class="val">${litres(T.dieselL)}</span><span class="sub">${T.trips ? Math.round(T.dieselL / T.trips) : 0} L a trip</span></div>
      <a class="kpi ${dl && dl.balance < 0 ? 'warn' : ''}" href="#/diesel/${encodeURIComponent(veh)}"><span class="lbl">Diesel recon</span><span class="val ${dl && dl.balance < 0 ? 'bad-text' : ''}">${dl ? `${dl.balance > 0 ? '+' : ''}${litres(dl.balance)}` : '—'}</span><span class="sub">running balance ›</span></a>
      <div class="kpi"><span class="lbl">Avg trip</span><span class="val">${T.days ? `${T.days.toFixed(1)} d` : '—'}</span><span class="sub">start to unloading</span></div>
      ${KV.km ? `<div class="kpi"><span class="lbl">Distance</span><span class="val">${indian(KV.km)} km</span><span class="sub">${KV.litres ? `${(KV.km / KV.litres).toFixed(2)} km/L mileage` : ''}</span></div>` : ''}
      <div class="kpi"><span class="lbl">Weight short</span><span class="val">${tonnes(-T.short)}</span><span class="sub">${plural(T.shortTrips, 'trip')}</span></div>
      ${(() => { const L = loadSummary(inP, derived().loads); return L.trips ? `<div class="kpi ${L.avgGap > 1.5 ? 'warn' : ''}"><span class="lbl">Load vs the best</span><span class="val ${L.avgGap <= 0.5 ? 'good-text' : L.avgGap <= 1.5 ? '' : L.avgGap <= 3 ? 'warn-text' : 'bad-text'}">−${L.avgGap.toFixed(2)} T</span><span class="sub">avg ${L.avgLoad.toFixed(2)} T · ${money(L.lostRs)} freight missed</span></div>` : ''; })()}
    </div>
    ${cm ? `<h3 class="sub-h">Month by month <span class="muted">${esc(cm.note)}</span></h3>
      ${legend([{ name: 'Profit before EMI', color: S3 }, { name: 'Net after EMI', color: S2 }])}
      ${groupedBars(months.map((m) => ({ ...m, before: m.income + m.emi })), [{ key: 'before', name: 'Profit before EMI', color: S3 }, { key: 'income', name: 'Net after EMI', color: S2 }], {
    label: `${veh} profit per month`,
    tip: (m) => `<b>${monthLong(m.month)}</b><br>${plural(m.trips, 'trip')} · freight ${money(m.bhada)}<br><i style="background:${S3}"></i>Before EMI ${money(m.before)}<br><i style="background:${S2}"></i>Net ${money(m.income)}`,
  })}
      ${monthTableHtml(months)}` : ''}
    <h3 class="sub-h">Trips <span class="muted">${esc(periodRange(p))}</span></h3>
    <div class="trips">${recent.slice(0, 60).map((t) => tripRow(t)).join('') || '<p class="muted">No trips in this period.</p>'}</div>
    ${recent.length > 60 ? `<a class="btn ghost small" href="#/trips?v=${encodeURIComponent(veh)}">All ${recent.length} trips</a>` : ''}
  </section>`);
  bindPeriod(main());
  bindCharts(main());
  document.getElementById('share-veh').addEventListener('click', () => shareVehicle(veh));
}

// ---------------------------------------------------------------------------
// SSFC account
// ---------------------------------------------------------------------------
async function viewSsfc() {
  const { account: a } = derived();
  if (!a) { setMain('<section class="card"><h2>SSFC</h2><p class="muted">The workbook had no Ledger sheet.</p></section>'); return; }
  const ui = state.ui.ssfc || (state.ui.ssfc = { gst: true, all: false });
  const list = ui.gst ? a.withGst : a.exGstList;
  const pending = list.filter((b) => b.pending > 0.005);
  const lastPay = [...a.payments].sort((x, y) => ((x.date || x.month) < (y.date || y.month) ? 1 : -1))[0];
  setChartWidth(main().clientWidth - 38);
  const shownInv = ui.all ? [...list].reverse() : [...list].reverse().filter((b) => b.pending > 0.005 || b === list[list.length - 1]);
  setMain(`<section class="card">
    <div class="acct-top"><div class="acct-id"><span class="avatar">SS</span><div><h2>${esc(a.party.name)}</h2><p class="muted">${a.party.gstin ? `GSTIN ${esc(a.party.gstin)} · ` : ''}bulker hiring account</p></div></div>${shareBtn('share-ssfc')}</div>
    <div class="acct-hero">
      <div><span class="lbl">SSFC owes you</span><span class="val" ${exact(a.total)}>${money(a.total)}</span><span class="sub">${rupees(a.total)} incl. GST ${money(a.igst)}</span></div>
      <div class="side"><span class="lbl">Without GST</span><b ${exact(a.exGst)}>${money(a.exGst)}</b><span class="sub">${lastPay ? `last payment ${money(lastPay.account + lastPay.other)}${lastPay.date ? ` on ${dateYear(lastPay.date)}` : ` (${monthName(lastPay.month)})`}` : ''}</span></div>
    </div>
    <div class="kpis acct-kpis">
      <div class="kpi"><span class="lbl">To come in SSL account</span><span class="val" ${exact(a.account)}>${money(a.account)}</span><span class="sub">invoices (with GST) − paid in account</span></div>
      <div class="kpi"><span class="lbl">To settle in cash</span><span class="val" ${exact(a.cashWithGst)}>${money(a.cashWithGst)}</span><span class="sub">GST ${money(a.igst)} ${a.cash < 0 ? '−' : '+'} cash balance ${money(Math.abs(a.cash))}</span></div>
      <div class="kpi"><span class="lbl">Earned (SSFC net)</span><span class="val" ${exact(a.net)}>${money(a.net)}</span><span class="sub">invoiced ${money(a.hireTotal)} with GST</span></div>
      <div class="kpi"><span class="lbl">Received</span><span class="val" ${exact(a.paid)}>${money(a.paid)}</span><span class="sub">${money(a.paidAcct)} in account · ${money(a.paidOther)} own diesel / cash</span></div>
    </div>
    ${a.memos.length ? `<div class="memos">${a.memos.map((m) => `<span><small>${esc(m.label)}</small><b>${rupees(m.amount)}</b></span>`).join('')}</div>` : ''}
    ${state.data.checks && state.data.checks.ssfcTotal != null ? `<p class="small ${Math.abs(state.data.checks.ssfcTotal - a.total) < 1 ? 'good-text' : 'warn-text'}">${Math.abs(state.data.checks.ssfcTotal - a.total) < 1 ? '✓ Same as the Ledger sheet’s Total Outstanding' : `Ledger sheet shows ${rupees(state.data.checks.ssfcTotal)} — re-save the workbook in Excel and upload again`}</p>` : ''}
  </section>

  <section class="card">
    <div class="row-between"><h3>Invoices · cleared oldest first</h3>
      <div class="chips small-chips" role="group" aria-label="GST"><button class="chip${ui.gst ? ' on' : ''}" data-gst="1">With GST</button><button class="chip${!ui.gst ? ' on' : ''}" data-gst="0">Without GST</button></div></div>
    <p class="muted small">Every payment (SSL account + own diesel + cash) clears the months not invoiced first, then each invoice in order — like the Ledger sheet's clearance table. ${plural(pending.length, 'invoice')} still pending: <b>${rupees(pending.reduce((x, b) => x + b.pending, 0))}</b>.</p>
    <div class="pend-list">
      <div class="pend-row head"><span>Month</span><span>Invoice</span><span class="r">Amount</span><span class="r">Pending</span><span class="r">Age</span></div>
      ${shownInv.map((b) => `<div class="pend-row${b.status === 'cleared' ? ' adv' : ''}">
        <span>${monthName(b.month)}${b.toMonth && b.toMonth !== b.month ? `–${monthName(b.toMonth)}` : ''}</span>
        <span><b>${esc(b.no || 'Not invoiced')}</b><small>${plural(b.vehicles, 'vehicle row')}${b.status === 'part' ? ` · ${money(b.cleared)} cleared` : ''}</small></span>
        <span class="r">${rupees(b.amount)}</span>
        <span class="r">${b.pending > 0.005 ? `<b>${rupees(b.pending)}</b>` : '<span class="pill good-pill">Cleared</span>'}</span>
        <span class="r">${b.age != null ? `<span class="age${b.age > 90 ? ' old' : b.age > 45 ? ' mid' : ''}">${b.age}d</span>` : ''}</span></div>`).join('')}
    </div>
    <button class="btn ghost small" id="inv-all">${ui.all ? 'Only pending' : `All ${list.length} (with cleared)`}</button>
  </section>

  <section class="card">
    <h3>Earned vs received, month by month</h3>
    ${legend([{ name: 'SSFC net + GST', color: 'var(--s-sales)' }, { name: 'Received', color: 'var(--s-paid)' }])}
    ${groupedBars(a.months.map((m) => ({ ...m, owed: m.net + m.igst })), [{ key: 'owed', name: 'SSFC net + GST', color: 'var(--s-sales)' }, { key: 'paid', name: 'Received', color: 'var(--s-paid)' }], {
    label: 'SSFC net amount with GST and payments received per month',
    tip: (m) => `<b>${monthLong(m.month)}</b><br><i style="background:var(--s-sales)"></i>Net ${money(m.net)} + GST ${money(m.igst)}<br><i style="background:var(--s-paid)"></i>Received ${money(m.paid)}${m.invoices.length ? `<br>${esc(m.invoices.join(', '))}` : ''}`,
  })}
    <p class="muted small">Payments are shown in the month they were entered against on the Ledger sheet.</p>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Month</th><th>Invoice</th><th class="r">SSFC net (real)</th><th class="r">Invoiced base</th><th class="r">GST</th><th class="r">Cash diff</th><th class="r">Received</th></tr></thead><tbody>
      ${[...a.months].reverse().map((m) => `<tr><td>${monthName(m.month)}</td><td class="small">${esc(m.invoices.join(', ') || '—')}</td><td class="r">${rupees(m.net)}</td><td class="r">${m.base ? rupees(m.base) : '—'}</td><td class="r">${m.igst ? rupees(m.igst) : '—'}</td><td class="r ${signed(m.net - m.billed)}">${m.billed ? rupees(m.net - m.billed) : '—'}</td><td class="r">${m.paid ? rupees(m.paid) : '—'}</td></tr>`).join('')}
    </tbody></table></div>
  </section>

  <section class="card"><h3>Payments received</h3>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>How</th><th>Against</th><th class="r">Amount</th></tr></thead><tbody>
      ${[...a.payments].reverse().map((x) => `<tr><td>${x.date ? fmtDate(x.date) : monthName(x.month)}</td><td>${esc(x.how)}</td><td class="small">${monthName(x.month)} · ${esc(x.veh)}${x.remarks ? ` · ${esc(x.remarks)}` : ''}</td><td class="r"><b>${rupees(x.account + x.other)}</b></td></tr>`).join('')}
    </tbody></table></div></section>`);
  main().querySelectorAll('[data-gst]').forEach((b) => b.addEventListener('click', () => { ui.gst = b.dataset.gst === '1'; rerender(); }));
  document.getElementById('inv-all').addEventListener('click', () => { ui.all = !ui.all; rerender(); });
  document.getElementById('share-ssfc').addEventListener('click', shareSsfc);
  bindCharts(main());
}

// ---------------------------------------------------------------------------
// Diesel
// ---------------------------------------------------------------------------
const SRC_COLORS = { SSFC: S1, 'Vriddhi Fuels': S2, 'SSL Own Filling': S3, 'Extra Filling': S4, Other: S5 };

async function viewDiesel() {
  const d = state.data;
  const p = currentPeriod();
  const { recon } = derived();
  const F = fuel(d.hsd, p);
  const U = urea(d.urea, p);
  setChartWidth(main().clientWidth - 38);
  const maxAbs = Math.max(1, ...recon.vehicles.map((v) => Math.abs(v.balance)));
  const keys = [...SOURCES, 'Other'].filter((s) => F.sources.some((x) => x.name === s)).map((s) => ({ key: s, name: s, color: SRC_COLORS[s] }));
  const check = d.checks && d.checks.reconTotal != null ? Math.abs(d.checks.reconTotal - recon.total) < 0.05 : null;
  setMain(`${dieselNowHtml()}
  <section class="card">
    <div class="row-between"><h2>Diesel</h2><span class="muted small">${esc(periodRange(p))}</span></div>
    ${periodHtml()}
    <div class="kpis">
      <div class="kpi hero"><span class="lbl">Filled</span><span class="val">${litres(F.litres)}</span><span class="sub">${plural(F.list.length, 'fill')}</span></div>
      <div class="kpi"><span class="lbl">Amount</span><span class="val" ${exact(F.amount)}>${money(F.amount)}</span><span class="sub">avg ₹${F.avg.toFixed(2)}/L</span></div>
      <div class="kpi"><span class="lbl">Urea (DEF)</span><span class="val">${litres(U.litres)}</span><span class="sub">${money(U.amount)}</span></div>
      <div class="kpi ${recon.total < 0 ? 'warn' : ''}"><span class="lbl">Recon balance</span><span class="val ${signed(recon.total)}">${recon.total > 0 ? '+' : ''}${litres(recon.total)}</span><span class="sub">all vehicles, since ${recon.since ? dateYear(recon.since) : '—'}</span></div>
    </div>
    ${F.litres ? `<h3 class="sub-h">By pump</h3>
    <div class="share" role="img" aria-label="Litres by pump">${F.sources.map((s) => `<span style="flex:${s.litres};background:${SRC_COLORS[s.name]}" title="${esc(s.name)} ${litres(s.litres)}"></span>`).join('')}</div>
    <div class="prods">${F.sources.map((s) => `<div class="prod"><span class="prod-head"><i style="background:${SRC_COLORS[s.name]}"></i><b>${esc(s.name)}</b></span><span class="big">${litres(s.litres)}</span><span class="muted small">${Math.round((s.litres / F.litres) * 100)}% · ${money(s.amount)} · ₹${(s.amount / s.litres).toFixed(2)}/L</span></div>`).join('')}</div>
    <h3 class="sub-h">Litres per month</h3>
    ${legend(keys)}
    ${stackedBars(F.months.map((m) => ({ ...m, parts: m.bySource })), keys, {
    fmt: (v) => litres(v), label: 'Litres filled per month by pump',
    tip: (m) => `<b>${monthLong(m.month)}</b><br>${keys.filter((k) => m.parts[k.key]).map((k) => `<i style="background:${k.color}"></i>${esc(k.name)} ${litres(m.parts[k.key])}`).join('<br>')}<br>Total ${litres(m.litres)} · ${money(m.amount)}`,
  })}
    <h3 class="sub-h">Where it was filled</h3>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Place</th><th class="r">Fills</th><th class="r">Litres</th><th class="r">Amount</th></tr></thead><tbody>
      ${F.places.slice(0, 12).map((x) => `<tr><td>${esc(x.place)}</td><td class="r">${x.fills}</td><td class="r">${indian(x.litres)}</td><td class="r">${rupees(x.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No HSD fills in this period.</p>'}
  </section>

  ${mileageHtml(p)}
  <section class="card">
    <div class="row-between"><h3>Diesel recon · allotted vs issued</h3><span class="muted small">since ${recon.since ? dateYear(recon.since) : '—'}</span></div>
    <p class="muted small">Each trip is allotted its route's diesel (Rates sheet) + ${recon.rules.perTonne} L a tonne over ${recon.rules.overloadOver} T gross − underload; issued = SSFC litres + own trip litres. Below zero = more diesel went in than allotted.</p>
    ${check != null ? `<p class="small ${check ? 'good-text' : 'warn-text'}">${check ? '✓ Same as the Diesel Recon sheet' : `Diesel Recon sheet shows ${litres(d.checks.reconTotal)}`}</p>` : ''}
    <div class="recon">${[...recon.vehicles].sort((a, b) => a.balance - b.balance).map((v) => `<a class="recon-row" href="#/diesel/${encodeURIComponent(v.veh)}">
      <b>${esc(v.veh)}</b>
      <span class="div-bar"><span class="neg">${v.balance < 0 ? `<i style="width:${((-v.balance / maxAbs) * 100).toFixed(1)}%"></i>` : ''}</span><span class="pos">${v.balance > 0 ? `<i style="width:${((v.balance / maxAbs) * 100).toFixed(1)}%"></i>` : ''}</span></span>
      <span class="r"><b class="${signed(v.balance)}">${v.balance > 0 ? '+' : ''}${indian(v.balance, 1)} L</b><small>${v.balance < 0 ? 'extra taken — owed' : v.balance > 0 ? 'saved' : 'square'}</small></span></a>`).join('')}</div>
  </section>

  <section class="card"><h3>Urea (DEF) · ${esc(periodRange(p))}</h3>
    ${U.vendors.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Bought from</th><th class="r">Times</th><th class="r">Litres</th><th class="r">Amount</th></tr></thead><tbody>
      ${U.vendors.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.buys}</td><td class="r">${indian(x.litres, 1)}</td><td class="r">${rupees(x.amount)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">Urea bought from SS Freight Carrier is theirs to settle; the rest is in each trip's “Own Urea”.</p>` : '<p class="muted">No urea in this period.</p>'}
  </section>`);
  bindPeriod(main());
  bindCharts(main());
}

// the trips on the road: how much of each allotment is taken, what's left, what's owed
function dieselNowHtml() {
  const d = state.data;
  const { recon, tripDiesel: td } = derived();
  const lastFill = [...d.hsd].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const price = lastFill ? lastFill.rsp : 0;
  const F = fleetDiesel(recon, td, price);
  const live = F.live.filter((z) => z.allotted != null).sort((a, b) => a.after - b.after);
  return `<section class="card">
    <div class="row-between"><h3>Diesel on the road now</h3><span class="muted small">${plural(live.length, 'trip')}</span></div>
    <p class="muted small">Each trip may take its allotment (route diesel + overload − underload); diesel taken over it is owed and comes off the next trips. <b>May still take</b> = the allotment − what's taken − what the truck still owes from before.</p>
    <div class="kpis">
      <div class="kpi ${F.owedL > 0.5 ? 'warn' : ''}"><span class="lbl">Extra taken, owed</span><span class="val ${F.owedL > 0.5 ? 'bad-text' : ''}">${F.owedL > 0.5 ? litres(F.owedL) : '—'}</span><span class="sub">${F.owed.length ? `${plural(F.owed.length, 'truck')}${price ? ` · ≈ ${money(F.owedRs)} at ₹${price.toFixed(2)}/L` : ''}` : 'no truck owes diesel'}</span></div>
      <div class="kpi"><span class="lbl">Saved</span><span class="val ${F.savedL > 0.5 ? 'good-text' : ''}">${F.savedL > 0.5 ? litres(F.savedL) : '—'}</span><span class="sub">${plural(F.saved.length, 'truck')} under their allotments</span></div>
      <div class="kpi ${F.overNow.length ? 'warn' : ''}"><span class="lbl">Over the allotment now</span><span class="val ${F.overNow.length ? 'bad-text' : ''}">${F.overNow.length || '—'}</span><span class="sub">${F.overNow.length ? F.overNow.map((z) => `${shortVeh(z.t.veh)} +${L1(z.extra)}`).join(', ') : 'trips on the road'}</span></div>
      <div class="kpi"><span class="lbl">Still to fill</span><span class="val">${litres(F.mayTake)}</span><span class="sub">${litres(F.toTake)} left of the allotments, less what's owed</span></div>
    </div>
    ${live.length ? `<div class="table-wrap"><table class="compact dz-table"><thead><tr><th>Vehicle</th><th>Trip</th><th class="r">Allotted</th><th class="r">Taken</th><th class="r">To take</th><th class="r">Extra</th><th class="r">Carried in</th><th class="r">May still take</th><th class="r">Balance</th></tr></thead><tbody>
      ${live.map((z) => `<tr class="${dieselTone(z) === 'bad' ? 'row-under' : ''}"><td><a href="#/vehicle/${encodeURIComponent(z.t.veh)}"><b>${esc(shortVeh(z.t.veh))}</b></a><small class="muted block">${esc(driverNow(z.t.veh) || '')}</small></td><td><a href="#/trip/${z.t.row}">${esc(z.t.trip)}</a><small class="muted block">${z.t.loadDate ? 'loaded' : 'to load'}${z.est ? ' · est.' : ''}</small></td>
        <td class="r">${L1(z.allotted)}</td><td class="r">${L1(z.taken)}</td><td class="r">${z.toTake > 0.5 ? L1(z.toTake) : '—'}</td><td class="r ${z.extra > 0.5 ? 'bad-text' : ''}">${z.extra > 0.5 ? `+${L1(z.extra)}` : '—'}</td>
        <td class="r ${z.carryIn < -0.5 ? 'warn-text' : ''}">${z.carryIn < -0.5 ? `−${L1(-z.carryIn)}` : z.carryIn > 0.5 ? `+${L1(z.carryIn)}` : '—'}</td><td class="r"><b class="${z.mayTake < 0.5 ? 'bad-text' : 'good-text'}">${L1(z.mayTake)}</b></td>
        <td class="r"><b class="${z.after < -0.5 ? 'bad-text' : 'good-text'}">${z.after > 0.5 ? '+' : z.after < -0.5 ? '−' : ''}${L1(z.after)}</b></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No trip on the road.</p>'}
  </section>`;
}

function mileageHtml(p) {
  const { vehicles } = derived();
  const rows = vehicles.map((v) => ({ v, ...kmOf(state.data.trips.filter((t) => t.veh === v && inPeriod(t, p))) })).filter((r) => r.km && r.litres);
  if (!rows.length) return '<section class="card"><h3>Mileage</h3><p class="muted small">Set each route\'s distance in <a href="#/setup">Setup</a> to see km run and km per litre for every vehicle.</p></section>';
  const avg = rows.reduce((a, r) => a + r.km, 0) / rows.reduce((a, r) => a + r.litres, 0);
  return `<section class="card"><h3>Mileage · ${esc(periodRange(p))}</h3>
    <p class="muted small">km = loaded leg + empty leg from the last unloading point; litres = SSFC + own + extra diesel on those trips. Fleet: <b>${avg.toFixed(2)} km/L</b>.</p>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Vehicle</th><th class="r">Trips</th><th class="r">Km</th><th class="r">Litres</th><th class="r">km/L</th><th class="r">vs fleet</th></tr></thead><tbody>
    ${rows.sort((a, b) => a.km / a.litres - b.km / b.litres).map((r) => { const kpl = r.km / r.litres; const d = (kpl / avg - 1) * 100; return `<tr><td><a href="#/vehicle/${encodeURIComponent(r.v)}">${esc(r.v)}</a></td><td class="r">${r.trips}</td><td class="r">${indian(r.km)}</td><td class="r">${indian(r.litres)}</td><td class="r"><b>${kpl.toFixed(2)}</b></td><td class="r ${d < -5 ? 'bad-text' : ''}">${d > 0 ? '+' : ''}${d.toFixed(1)}%</td></tr>`; }).join('')}
    </tbody></table></div></section>`;
}

async function viewDieselVehicle(veh) {
  const { recon } = derived();
  const v = recon.vehicles.find((x) => x.veh === veh);
  if (!v) { setMain('<section class="card"><p>No such vehicle.</p></section>'); return; }
  setChartWidth(main().clientWidth - 38);
  const list = v.list.filter((x) => x.allotted != null);
  setMain(`<section class="card">
    <a class="muted small" href="#/diesel">← Diesel</a>
    <div class="acct-top"><div class="acct-id"><span class="avatar">${esc(shortVeh(veh))}</span><div><h2>${esc(veh)} · diesel recon</h2><p class="muted">${plural(list.length, 'trip')} since ${recon.since ? dateYear(recon.since) : '—'}</p></div></div>${shareBtn('share-recon')}</div>
    ${(() => { const live = v.list.map((x) => derived().tripDiesel.get(x.t.row)).filter((z) => z && z.live && z.t.start).pop(); return live ? `<h3 class="sub-h">On the road now · <a href="#/trip/${live.t.row}">${esc(live.t.trip)}</a></h3>${dieselPanelHtml(live)}` : ''; })()}
    <div class="acct-hero"><div><span class="lbl">Running balance</span><span class="val">${v.balance > 0 ? '+' : ''}${indian(v.balance, 2)} L</span><span class="sub">${v.balance < 0 ? 'more issued than allotted (short)' : v.balance > 0 ? 'less issued than allotted (surplus)' : 'nil'}</span></div>
      <div class="side"><span class="lbl">Allotted / issued</span><b>${litres(v.allotted)}</b><span class="sub">issued ${litres(v.issued)}</span></div></div>
    <h3 class="sub-h">Each trip's balance</h3>
    ${signedBars(list.map((x) => ({ ...x, value: x.balance })), {
    fmt: (n) => `${Math.round(n)} L`, label: `${veh} diesel balance per trip`, labelOf: (x) => shortDate(x.t.loadDate || x.t.start),
    up: 'var(--s-1)', down: 'var(--s-neg)',
    tip: (x) => `<b>${esc(x.t.trip)}</b> · ${esc(routeOf(x.t))}<br>Allotted ${indian(x.allotted, 1)} L · issued ${indian(x.issued, 1)} L<br>Trip ${x.balance > 0 ? '+' : ''}${indian(x.balance, 1)} L · running ${indian(x.running, 1)} L`,
  })}
    <div class="table-wrap"><table class="compact"><thead><tr><th>Trip</th><th>Loaded</th><th>Route</th><th class="r">Gross</th><th class="r">Base</th><th class="r">+Over</th><th class="r">−Under</th><th class="r">Allotted</th><th class="r">Issued</th><th class="r">Trip</th><th class="r">Running</th></tr></thead><tbody>
      ${[...v.list].reverse().map((x) => `<tr><td><a href="#/trip/${x.t.row}">${esc(x.t.trip)}</a></td><td>${fmtDate(x.t.loadDate || x.t.start)}</td><td class="small">${esc(routeOf(x.t))}</td><td class="r">${x.t.gross ? x.t.gross.toFixed(2) : '—'}</td><td class="r">${x.base ?? '—'}</td><td class="r">${x.over ? x.over.toFixed(1) : ''}</td><td class="r">${x.under || ''}</td><td class="r">${x.allotted != null ? indian(x.allotted, 1) : '—'}</td><td class="r">${indian(x.issued, 1)}</td><td class="r ${signed(x.balance)}">${indian(x.balance, 1)}</td><td class="r ${signed(x.running)}"><b>${indian(x.running, 1)}</b></td></tr>`).join('')}
    </tbody></table></div>
  </section>`);
  bindCharts(main());
  document.getElementById('share-recon').addEventListener('click', () => shareRecon(veh));
}

// ---------------------------------------------------------------------------
// Sharing: data-rich pictures of the screens (share-svg.js), like the Ledger
// app's — Share (WhatsApp etc.), Download, or a PDF of the pages
// ---------------------------------------------------------------------------
let shareAssets = null;
function shareKit() {
  if (!shareAssets) {
    shareAssets = Promise.all([toDataUrl('assets/logo-mark.png').catch(() => ''), toDataUrl('assets/logo-word-light.png').catch(() => ''), brandFontCss()])
      .then(([mark, word, fontCss]) => ({ images: { mark, word }, fontCss, asOn: today() }));
  }
  return shareAssets.then((k) => ({ ...k, asOn: today() }));
}
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
// the bulker drawing for a picture: its logo as a data: URL
const pictureBulker = (svg, mark) => svg.replace(/href="assets\/logo-mark\.png"/g, mark ? `href="${mark}"` : '');

async function pageFiles(svgs, base) {
  base = safeName(base);
  const files = [];
  for (let i = 0; i < svgs.length; i++) {
    files.push(new File([await jpegFromSvg(svgs[i], PAGE)], `${base}${svgs.length > 1 ? ` (${i + 1} of ${svgs.length})` : ''}.jpeg`, { type: 'image/jpeg' }));
  }
  return { files, pdf: async () => download(await pdfFromSvgs(svgs, PAGE, PAGE_PT), `${base}.pdf`) };
}
async function cardFiles({ svg, size }, base) {
  return { files: [new File([await jpegFromSvg(svg, size)], `${safeName(base)}.jpeg`, { type: 'image/jpeg' })] };
}

// A sheet that draws the pictures, shows them and hands them over. Sharing
// needs the files ready before the tap, so they're drawn first and the Share
// button only passes them on. options: [{ label, make: async () => { files, pdf? } }]
async function sharePictures(title, options) {
  document.querySelector('.share-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.className = 'share-sheet';
  sheet.innerHTML = `<div class="share-box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="row-between"><h3>${esc(title)}</h3><button class="icon" data-close aria-label="Close">✕</button></div>
      ${options.length > 1 ? `<div class="chips small-chips share-variants">${options.map((o, i) => `<button class="chip" data-variant="${i}">${esc(o.label)}</button>`).join('')}</div>` : ''}
      <div class="share-body">${loadingHtml('Drawing the pictures…')}</div>
    </div>`;
  document.body.append(sheet);
  let urls = [];
  const freeUrls = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { sheet.remove(); freeUrls(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey);
  sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) close(); });
  const body = sheet.querySelector('.share-body');
  const made = new Map();
  let showing = 0;
  const show = async (i) => {
    showing = i;
    sheet.querySelectorAll('[data-variant]').forEach((b) => { b.classList.toggle('on', Number(b.dataset.variant) === i); b.setAttribute('aria-pressed', String(Number(b.dataset.variant) === i)); });
    body.innerHTML = loadingHtml('Drawing the pictures…');
    let set;
    try {
      if (!made.has(i)) made.set(i, options[i].make());
      set = await made.get(i);
    } catch (err) {
      console.error(err);
      made.delete(i);
      if (showing === i) body.innerHTML = errorHtml(err);
      return;
    }
    if (!sheet.isConnected || showing !== i) return;
    freeUrls();
    const shots = set.files.map((f) => { const u = URL.createObjectURL(f); urls.push(u); return u; });
    const share = canShareFiles(set.files);
    body.innerHTML = `<div class="share-shots${set.files.length === 1 ? ' one' : ''}">${shots.map((u, j) => `<img src="${u}" alt="${esc(set.files[j].name)}">`).join('')}</div>
      <p class="muted small">${set.files.length === 1 ? esc(set.files[0].name) : `${set.files.length} pages — swipe to see them all`}</p>
      <div class="actions">${share ? '<button class="btn" data-share>Share</button>' : ''}
        <button class="btn ${share ? 'ghost' : ''}" data-save>Download${set.files.length > 1 ? ' all' : ''}</button>
        ${set.pdf ? '<button class="btn ghost" data-pdf>PDF</button>' : ''}</div>`;
    body.querySelector('[data-share]')?.addEventListener('click', () => guard(async () => {
      try {
        await navigator.share({ files: set.files });              // pictures only: extra text can make apps drop them
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        throw err;
      }
    }));
    body.querySelector('[data-save]').addEventListener('click', () => guard(async () => {
      if (set.files.length === 1) download(set.files[0], set.files[0].name);
      else download(await zipBlob(set.files), `${set.files[0].name.replace(/ \(1 of \d+\)\.jpeg$/, '')}.zip`);
    }));
    body.querySelector('[data-pdf]')?.addEventListener('click', (e) => guard(async () => {
      e.target.disabled = true;
      try { await set.pdf(); } finally { e.target.disabled = false; }
    }));
  };
  sheet.querySelectorAll('[data-variant]').forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.variant))));
  await show(0);
}
const shareBtn = (id, label = 'Share') => `<button class="btn small share-btn" id="${id}" type="button"><span aria-hidden="true">⇪</span> ${esc(label)}</button>`;

// what each screen shares
function shareSsfc() {
  const { account: a } = derived();
  const make = (gst) => async () => {
    const kit = await shareKit();
    return pageFiles(ssfcPagesSvg(a, { gst, ...kit, checks: state.data.checks }), `SSFC account ${fmtDate(today())}${gst ? '' : ' without GST'}`);
  };
  sharePictures('SSFC account', [{ label: 'With GST', make: make(true) }, { label: 'Without GST', make: make(false) }]);
}
function shareVehicle(veh) {
  const p = currentPeriod();
  const d = state.data;
  const { recon, drivers: dc } = derived();
  const rv = recon.vehicles.find((x) => x.veh === veh);
  const mine = d.trips.filter((t) => t.veh === veh);
  const emi = [...mine].reverse().find((t) => t.emi)?.emi || 0;
  const opts = [{ label: `Statement · ${periodRange(p)}`, make: async () => {
    const kit = await shareKit();
    return pageFiles(vehiclePagesSvg(veh, mine.filter((t) => inPeriod(t, p)), { ...kit, period: periodRange(p), recon: rv, driver: driverNow(veh), driverOf: dc.byPayments ? dc.tripDriver : null, emi, loads: derived().loads }),
      `${veh} statement ${periodRange(p)}`);
  } }];
  if (rv && rv.list.length) opts.push({ label: 'Diesel recon', make: async () => pageFiles(reconPagesSvg(rv, { ...(await shareKit()), since: recon.since }), `${veh} diesel recon ${fmtDate(today())}`) });
  sharePictures(`${veh}`, opts);
}
function shareRecon(veh) {
  const { recon } = derived();
  const rv = recon.vehicles.find((x) => x.veh === veh);
  sharePictures(`${veh} · diesel recon`, [{ label: 'Diesel recon', make: async () => pageFiles(reconPagesSvg(rv, { ...(await shareKit()), since: recon.since }), `${veh} diesel recon ${fmtDate(today())}`) }]);
}
function shareTrip(t) {
  const d = state.data;
  const { recon, drivers: dc } = derived();
  const rec = recon.vehicles.find((v) => v.veh === t.veh)?.list.find((x) => x.t.row === t.row);
  const info = dc.tripInfo(t);
  sharePictures(`${t.trip} · ${shortVeh(t.veh)}`, [{ label: 'Trip', make: async () => {
    const kit = await shareKit();
    const card = tripCardSvg(t, {
      ...kit, bulker: pictureBulker(bulkerFor(t.loadWt ? t : null, { veh: t.veh, routeTrip: t }), kit.images.mark), bulkerCss: bulkerCss(),
      fills: d.hsd.filter((h) => h.veh === t.veh && h.trip === t.trip).sort((a, b) => (a.date < b.date ? -1 : 1)),
      recon: rec, driver: dc.tripDriver(t), paid: info ? info.paid : [], check: dc.rows.find((r) => r.t === t) || null, load: derived().loads.get(t.row) || null, diesel: derived().tripDiesel.get(t.row) || null,
    });
    return cardFiles(card, `${t.trip.replace('/', '-')} ${t.veh}`);
  } }]);
}
function shareDriver(veh, i) {
  const { drivers: dc } = derived();
  const sp = dc.spells.filter((x) => x.veh === veh)[i];
  if (!sp) return;
  const rows = dc.rows.filter((r) => r.spell === sp);
  sharePictures(`${sp.label} · ${shortVeh(veh)}`, [{ label: 'Driver statement', make: async () => pageFiles(driverPagesSvg(sp, rows, { ...(await shareKit()), now: sp.current }), `${sp.label} ${veh} ${fmtDate(today())}`) }]);
}
function fleetOption() {
  const p = currentPeriod();
  const d = state.data;
  const { account, status } = derived();
  return { label: `Fleet report · ${periodRange(p)}`, make: async () => {
    const trips = d.trips.filter((t) => inPeriod(t, p));
    const ms = trips.map((t) => t.month).filter(Boolean).sort();
    return pageFiles(fleetPagesSvg(trips, {
      ...(await shareKit()), period: periodRange(p), vehicles: byVehicle(trips, vehiclesOf(d)), routes: byRoute(trips),
      months: ms.length ? monthly(trips, ms[0], ms[ms.length - 1]) : [], driverOf: (v) => driverNow(v), account, onRoad: status.filter((s) => s.state !== 'idle').length,
    }), `Fleet report ${periodRange(p)}`);
  } };
}
function roadOption() {
  const { status, liveTrips: lts } = derived();
  return { label: 'On the road now', make: async () => {
    const kit = await shareKit();
    const css = bulkerCss();
    const rows = status.map((s) => {
      const lt = lts.find((x) => x.veh === s.veh);
      const t = s.trip;
      const pace = lt ? paceText(lt) : null;
      const showLoad = lt ? !(lt.stage === 'start' || lt.stage === 'out') : s.state === 'loaded';
      return {
        veh: s.veh, driver: driverNow(s.veh), state: s.state,
        title: t ? `${t.port} → ${t.dest}` : s.text, phase: t ? (lt ? lt.phase.title : s.long) : '',
        sub: t ? `${t.trip} · started ${dm(t.start)} · day ${lt ? lt.el : s.days}${t.loadWt ? ` · ${t.loadWt.toFixed(2)} T` : ''}${lt && lt.etaTypical ? ` · at ${t.dest} ~${dm(lt.etaTypical)}` : ''}` : s.last ? `last unloaded ${dm(s.last.unloadDate)}${s.days != null ? ` · ${s.days} days ago` : ''}` : '',
        pace: pace ? pace.text : '', paceColor: pace ? { good: 'good', behind: 'warn', late: 'bad' }[pace.cls] : '',
        ...(() => { const z = t && derived().tripDiesel.get(t.row); return z && z.allotted != null ? { diesel: dieselLine(z), dieselColor: dieselTone(z) } : {}; })(),
        bulker: pictureBulker(t ? bulkerFor(showLoad ? t : null, { veh: s.veh, routeTrip: t, compact: true }) : bulkerFor(null, { veh: s.veh, compact: true }), kit.images.mark),
      };
    }).sort((a, b) => ['loaded', 'empty', 'idle'].indexOf(a.state) - ['loaded', 'empty', 'idle'].indexOf(b.state));
    return cardFiles(roadCardSvg(rows, { ...kit, bulkerCss: css }), `On the road ${fmtDate(today())}`);
  } };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
async function readFile(file) {
  const XLSX = await loadSheetJS();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellFormula: true, cellStyles: false, cellHTML: false, cellText: false });
  return extractFleet(bookFromSheetJS(XLSX, wb), { fileName: file.name });
}

async function uploadSection(box) {
  let history = [];
  if (!state.localOnly && state.store) history = (await guard(() => state.store.uploads(10))) || [];
  box.innerHTML = `<section class="card" id="upload">
    <h2>Upload Trip Register</h2>
    <p class="muted">Choose the workbook you keep in Excel (<code>Trip_Register.xlsm</code>). Save it in Excel first so its formulas are up to date. It's read in this browser; ${state.localOnly ? 'nothing is saved (this device only).' : 'only the figures the app needs are saved, for your fleet logins only.'}</p>
    <label class="file"><input type="file" id="file" accept=".xlsm,.xlsx,.xls"><span class="btn">Choose Trip Register…</span></label>
    <div id="preview" class="preview"></div>
  </section>
  ${history.length ? `<section class="card"><h3>Earlier uploads</h3><div class="table-wrap"><table class="compact"><thead><tr><th>When</th><th>File</th><th class="r">Trips</th><th>Up to</th><th>By</th></tr></thead><tbody>
    ${history.map((h) => `<tr><td>${new Date(h.created_at).toLocaleString('en-IN')}</td><td>${esc(h.file_name)}</td><td class="r">${h.counts && h.counts.trips || ''}</td><td>${h.latest_trip ? fmtDate(h.latest_trip) : ''}</td><td class="small">${esc(h.by_email)}</td></tr>`).join('')}
  </tbody></table></div></section>` : ''}`;
  const input = document.getElementById('file');
  input.addEventListener('change', () => guard(async () => {
    const file = input.files[0];
    if (!file) return;
    const preview = document.getElementById('preview');
    preview.innerHTML = logoLoader('Reading the workbook…');
    let data;
    try {
      data = await readFile(file);
    } catch (err) {
      preview.innerHTML = errorHtml(err);
      return;
    }
    await showPreview(preview, file, data);
  }));
}

// the file against what's saved right now (fetched fresh, so another
// device's upload since this page opened is what it's compared with)
async function showPreview(preview, file, data, note = '') {
  let base = null;
  if (state.store && !state.localOnly) {
    preview.innerHTML = logoLoader('Comparing with the saved data…');
    try {
      base = await state.store.latest();
    } catch (err) {
      preview.innerHTML = errorHtml(err);
      return;
    }
  } else if (state.data && state.data !== data) {
    base = { meta: state.meta, payload: state.data };
  }
  const cmp = base && base.payload ? compareUploads(base.payload, data) : null;
  preview.innerHTML = (note ? `<div class="todo warn">${note}</div>` : '') + previewHtml(data, cmp, base && base.meta);
  const save = document.getElementById('save');
  const override = document.getElementById('override');
  override?.addEventListener('change', () => { save.disabled = !override.checked; });
  save?.addEventListener('click', (e) => guard(async () => {
    e.target.disabled = true;
    e.target.textContent = 'Saving…';
    // saved by someone else since the comparison? compare again first
    const [top] = (await state.store.uploads(1)) || [];
    const baseId = base && base.meta ? base.meta.id : null;
    if ((top ? top.id : null) !== baseId) {
      await showPreview(preview, file, data, `The saved data changed while you were looking${top ? ` — ${esc(top.file_name)} was saved ${new Date(top.created_at).toLocaleString('en-IN')}${top.by_email ? ` by ${esc(top.by_email)}` : ''}` : ''}. Nothing was saved: the changes below are against what's saved now — check them and save again.`);
      return;
    }
    const meta = await state.store.save(file.name, data);
    state.data = data;
    state.meta = meta;
    state.newer = null;
    if (state.preview) state.preview = false;
    renderShell();
    toast(`Saved — ${plural(data.trips.length, 'trip')} up to ${fmtDate(data.latest)}.`);
    if (location.hash === '#/') route(); else location.hash = '#/';
  }).finally(() => { if (document.body.contains(e.target)) { e.target.disabled = !!(override && !override.checked); e.target.textContent = 'Save — replace the app\'s data'; } }));
  document.getElementById('view-only')?.addEventListener('click', () => {
    state.data = data;
    state.meta = { file_name: file.name, created_at: new Date().toISOString(), by_email: '' };
    if (!state.localOnly) state.preview = true;
    renderShell();
    if (location.hash === '#/') route(); else location.hash = '#/';
  });
}

// what this file changes against the saved upload
function fieldVal(f, v) {
  if (v == null || v === '') return '<span class="muted">blank</span>';
  if (f.date) return fmtDate(v);
  if (typeof v === 'number') return indian(v, Number.isInteger(v) ? 0 : 2);
  return `“${esc(v)}”`;
}
function changesHtml(c, meta) {
  const when = meta && meta.created_at ? `${new Date(meta.created_at).toLocaleString('en-IN')}${meta.by_email ? ` by ${esc(meta.by_email)}` : ''}` : '';
  const tripName = (t) => `${esc(t.trip)} <small class="muted">${esc(shortVeh(t.veh))} · row ${t.row}</small>`;
  const many = (xs, n, f) => `${xs.slice(0, n).map(f).join('')}${xs.length > n ? `<li class="muted">…and ${xs.length - n} more</li>` : ''}`;
  const T = c.trips;
  const counts = [
    T.added.length && `+${plural(T.added.length, 'trip')}`, T.changed.length && `${plural(T.changed.length, 'trip')} edited`, T.removed.length && `${plural(T.removed.length, 'trip')} deleted`,
    (c.pay.added.length || c.pay.removed.length) && `advances +${c.pay.added.length}${c.pay.removed.length ? ` −${c.pay.removed.length}` : ''}`,
    (c.hsd.added.length || c.hsd.removed.length) && `HSD fills +${c.hsd.added.length}${c.hsd.removed.length ? ` −${c.hsd.removed.length}` : ''}`,
    (c.urea.added.length || c.urea.removed.length) && `urea +${c.urea.added.length}${c.urea.removed.length ? ` −${c.urea.removed.length}` : ''}`,
    (c.ledger.added.length || c.ledger.removed.length) && `Ledger rows changed ${Math.max(c.ledger.added.length, c.ledger.removed.length)}`,
    (c.roster.added.length || c.roster.removed.length) && 'drivers list changed',
  ].filter(Boolean);
  const pay = (p) => `<li>${fmtDate(p.date)} · ${esc(shortVeh(p.veh))} · ${rupees(p.amount)} · ${esc(p.name)}${p.note ? ` <small class="muted">${esc(p.note)}</small>` : ''}</li>`;
  return `<div class="changes">
    <h4>Changes against the saved data${when ? ` <small class="muted">(uploaded ${when})</small>` : ''}</h4>
    ${c.risks.length ? `<ul class="checks">${c.risks.map((r) => `<li class="${r.level === 'stop' ? 'bad-text' : 'warn-text'}">${r.level === 'stop' ? '⛔' : '!'} ${esc(r.text)}</li>`).join('')}</ul>` : ''}
    ${c.none ? '<p class="good-text">✓ Nothing has changed since then.</p>' : `<p class="chg-sum">${counts.map((x) => `<span>${x}</span>`).join('')}</p>
    ${T.added.length ? `<details><summary>New trips (${T.added.length})</summary><ul class="chg-list">${many(T.added, 40, (t) => `<li>${tripName(t)} · ${esc(routeOf(t))} · started ${t.start ? fmtDate(t.start) : '—'}</li>`)}</ul></details>` : ''}
    ${T.changed.length ? `<details${T.changed.length <= 8 ? ' open' : ''}><summary>Edited trips (${T.changed.length})</summary><ul class="chg-list">${many(T.changed, 60, (x) => `<li>${tripName(x.t)}: ${x.fields.map((f) => `${esc(f.name)} ${fieldVal(f, f.from)} → <b>${fieldVal(f, f.to)}</b>`).join(' · ')}</li>`)}</ul></details>` : ''}
    ${T.removed.length ? `<details open><summary class="warn-text">Trips not in this file (${T.removed.length})</summary><ul class="chg-list">${many(T.removed, 40, (t) => `<li>${tripName(t)} · ${esc(routeOf(t))}</li>`)}</ul></details>` : ''}
    ${c.pay.added.length || c.pay.removed.length ? `<details><summary>Driver advances (+${c.pay.added.length} −${c.pay.removed.length})</summary>${c.pay.added.length ? `<p class="small">New:</p><ul class="chg-list">${many(c.pay.added, 30, pay)}</ul>` : ''}${c.pay.removed.length ? `<p class="small warn-text">Not in this file any more:</p><ul class="chg-list">${many(c.pay.removed, 30, pay)}</ul>` : ''}</details>` : ''}
    ${c.roster.added.length || c.roster.removed.length ? `<details><summary>Drivers list</summary><ul class="chg-list">${c.roster.removed.map((r) => `<li>${esc(shortVeh(r.veh))}: <s>${esc(r.name)}</s></li>`).join('')}${c.roster.added.map((r) => `<li>${esc(shortVeh(r.veh))}: <b>${esc(r.name)}</b></li>`).join('')}</ul></details>` : ''}`}
  </div>`;
}

function previewHtml(data, cmp = null, baseMeta = null) {
  const acc = ssfcAccount(data.ssfc, today());
  const rec = dieselRecon(data);
  const odd = dateIssues(data, today());
  const vehicles = vehiclesOf(data);
  const ok = (good, text) => `<li class="${good ? 'good-text' : 'warn-text'}">${good ? '✓' : '!'} ${text}</li>`;
  const checks = [];
  if (acc && data.checks.ssfcTotal != null) checks.push(ok(Math.abs(acc.total - data.checks.ssfcTotal) < 1, `SSFC outstanding ${rupees(acc.total)} ${Math.abs(acc.total - data.checks.ssfcTotal) < 1 ? 'matches the Ledger sheet' : `— the Ledger sheet shows ${rupees(data.checks.ssfcTotal)}`}`));
  if (data.checks.reconTotal != null) checks.push(ok(Math.abs(rec.total - data.checks.reconTotal) < 0.05, `Diesel recon ${indian(rec.total, 2)} L ${Math.abs(rec.total - data.checks.reconTotal) < 0.05 ? 'matches the Diesel Recon sheet' : `— the sheet shows ${indian(data.checks.reconTotal, 2)} L`}`));
  if (odd.length) checks.push(ok(false, `${plural(odd.length, 'trip')} with dates that look mistyped: ${odd.slice(0, 4).map((x) => `${esc(x.t.trip)} ${esc(shortVeh(x.t.veh))}`).join(', ')}${odd.length > 4 ? '…' : ''} (shown under Trips → Dates to check)`));
  const found = dataChecks(data, today());
  if ((data.driverPay || []).length) {
    const total = data.driverPay.reduce((a, x) => a + x.amount, 0);
    const good = !found.some((x) => /Trip Driver Payment doesn't match|Driver Payment rows? \d/.test(x.text));
    checks.push(ok(good, `Driver advances ${rupees(total)} in ${plural(data.driverPay.length, 'payment')}${good ? ' — each trip\'s Trip Driver Payment matches them' : ''} · ${plural((data.roster || []).length, 'driver')} on the drivers list`));
  }
  if (!found.some((x) => /don't add up/.test(x.text))) checks.push(ok(true, 'Gross Weight, Excess/Short, Trip Bhada, SSFC Net Amount and Income/Trip add up on every trip'));
  for (const w of data.warnings) checks.push(ok(false, esc(w)));
  for (const x of found) checks.push(x.level === 'warn' ? ok(false, esc(x.text)) : `<li class="muted">ⓘ ${esc(x.text)}</li>`);
  const canSave = state.store && !state.localOnly;
  return `<div class="card good-card">
    <b>${esc(data.fileName)}</b>
    <div class="stats">
      <div><span class="num">${data.trips.length}</span><span class="lbl">trips · ${vehicles.length} vehicles</span></div>
      <div><span class="num">${fmtDate(data.latest)}</span><span class="lbl">latest trip</span></div>
      <div><span class="num">${data.hsd.length}</span><span class="lbl">HSD fills</span></div>
      <div><span class="num">${data.urea.length}</span><span class="lbl">urea entries</span></div>
      ${(data.driverPay || []).length ? `<div><span class="num">${data.driverPay.length}</span><span class="lbl">driver advances</span></div>` : ''}
      <div><span class="num">${data.ssfc ? data.ssfc.rows.length : 0}</span><span class="lbl">SSFC ledger rows</span></div>
    </div>
    ${checks.length ? `<ul class="checks">${checks.join('')}</ul>` : ''}
    ${cmp ? changesHtml(cmp, baseMeta) : ''}
    ${canSave && cmp && blocking(cmp) ? '<label class="override"><input type="checkbox" id="override"> I\'ve checked the above — save this file anyway</label>' : ''}
    <div class="actions">
      ${canSave ? `<button class="btn" id="save"${cmp && blocking(cmp) ? ' disabled' : ''}>Save — replace the app's data</button>` : ''}
      <button class="btn ghost" id="view-only">${canSave ? 'Just look, don\'t save' : 'Open'}</button>
    </div></div>`;
}

// ---------------------------------------------------------------------------
// Drivers: salary − your advances = what SSFC should pay the driver
// ---------------------------------------------------------------------------
const owes = (bal) => (bal > OVERPAID ? `<span class="pill bad-pill">Overpaid ${rupees(bal)}</span>`
  : bal < -OVERPAID ? `<span class="pill info-pill">You owe ${rupees(-bal)}</span>` : '<span class="pill good-pill">Square</span>');

function salaryNote(dc) {
  if (!dc.missing.length) return '';
  return `<div class="todo info" style="margin:10px 0">Driver salary isn't set for <b>${dc.missing.map((m) => `${esc(m.route)} (${plural(m.trips, 'trip')})`).join(', ')}</b> — those trips aren't checked. <a href="#/setup">Set it in Setup →</a></div>`;
}

async function viewDrivers() {
  const p = currentPeriod();
  const { drivers: dc, vehicles } = derived();
  const tol = dc.tolerance;
  const rows = dc.rows.filter((r) => inPeriod(r.t, p) && r.salary != null);
  const sum = (f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
  const over = rows.filter((r) => r.over > tol).sort((a, b) => b.over - a.over);
  const overpaid = dc.spells.filter((x) => x.balance > OVERPAID && x.trips.length).sort((a, b) => b.balance - a.balance);
  const fromRates = [...new Set(dc.rows.filter((r) => r.salaryFrom === 'rates').map((r) => routeOf(r.t)))];
  const opt = state.settings.driver;
  setMain(`<section class="card">
    <div class="row-between"><h2>Drivers</h2><span class="muted small">${esc(periodRange(p))}</span></div>
    <p class="muted small">Each trip's driver salary (Setup → Routes) is paid partly by you — <b>Trip Driver Payment</b>${opt.extraIsAdvance ? ' and <b>Extra Own Driver Pay</b>' : ''} — and the rest by SSFC (<b>Driver SSFC Payment</b>). SSFC should pay <b>salary − your advances</b>; more than that is an overpayment.${opt.extraIsAdvance ? '' : ' <b>Extra Own Driver Pay</b> is the extra promised for those trips — on top of the salary and settled, so it\'s left out of the check.'}${opt.debitCounts ? ' <b>Driver Debit</b> (damage, fines…) is money the driver owes back.' : ''}</p>
    ${salaryNote(dc)}
    <p class="small">Checked from <b>${monthLong(dc.checkFrom)}</b> on; trips before that are as the Trip Register has them (settled). <a href="#/setup">Change in Setup</a></p>
    ${fromRates.length ? `<p class="small warn-text">Using the Rates sheet's Driver Payment for ${esc(fromRates.join(', '))} until you set the salary in <a href="#/setup">Setup</a>.</p>` : ''}
    ${periodHtml()}
    <div class="kpis">
      <div class="kpi"><span class="lbl">Salary earned</span><span class="val" ${exact(sum((r) => r.salary))}>${money(sum((r) => r.salary))}</span><span class="sub">${plural(rows.length, 'trip')} checked</span></div>
      <div class="kpi"><span class="lbl">Your advances</span><span class="val" ${exact(sum((r) => r.advance))}>${money(sum((r) => r.advance))}</span><span class="sub">paid by you</span></div>
      <div class="kpi"><span class="lbl">Paid by SSFC</span><span class="val" ${exact(sum((r) => r.ssfc))}>${money(sum((r) => r.ssfc))}</span><span class="sub">should be ${money(sum((r) => r.expected))}</span></div>
      <div class="kpi ${sum((r) => Math.max(0, r.over)) > OVERPAID ? 'warn' : ''}"><span class="lbl">Paid over salary</span><span class="val ${sum((r) => Math.max(0, r.over)) > OVERPAID ? 'bad-text' : ''}" ${exact(sum((r) => Math.max(0, r.over)))}>${money(sum((r) => Math.max(0, r.over)))}</span><span class="sub">${plural(over.length, 'trip')} paid more</span></div>
      <div class="kpi"><span class="lbl">Driver debits</span><span class="val">${money(sum((r) => r.t.drvDebit))}</span><span class="sub">to recover from drivers</span></div>
    </div>
  </section>

  <section class="card">
    <h3>Overpaid drivers</h3>
    <p class="muted small">Each driver's spell on a vehicle (${dc.byPayments ? 'who drove which trip comes from the advances in the Driver Payment sheet' : 'a new spell starts at a trip whose remarks say “New Driver” / “Driver Changed”'}), all trips: what reached him (SSFC + your advances) + debits − salary earned.</p>
    ${overpaid.length ? `<div class="co-grid">${overpaid.map((x) => `<a class="co-card driver-card" href="#/drivers/${encodeURIComponent(x.veh)}">
      <div class="co-head"><span class="avatar sm">${esc(shortVeh(x.veh))}</span><b>${esc(x.label)}</b>${x.current ? '<span class="pill fuel-pill">Now</span>' : ''}</div>
      <span class="co-val bad-text">${rupees(x.balance)}</span>
      <dl class="co-facts"><dt>Since</dt><dd>${x.from ? dateYear(x.from) : '—'}</dd><dt>Trips</dt><dd>${x.trips.length} <small>${x.overTrips} paid over</small></dd>
      <dt>Salary</dt><dd>${money(x.salary)}</dd><dt>SSFC + you</dt><dd>${money(x.ssfc + x.advance)}</dd>${x.debit ? `<dt>Debits</dt><dd>${money(x.debit)}</dd>` : ''}</dl></a>`).join('')}</div>`
    : '<p class="good-text">✓ No driver has been paid more than his salary.</p>'}
  </section>

  <section class="card">
    <h3>Each vehicle's driver now</h3>
    ${dc.now.size && [...dc.now.values()].some((n) => n.from === 'list') ? '<p class="muted small">From the drivers list in the Driver Payment sheet; “since” is his first trip on the truck by the advances paid.</p>' : ''}
    <div class="table-wrap"><table class="compact"><thead><tr><th>Vehicle</th><th>Driver</th><th>Since</th><th class="r">Trips</th><th class="r">Salary</th><th class="r">SSFC + you</th><th class="r">Debits</th><th class="r">Balance</th></tr></thead><tbody>
      ${vehicles.map((v) => {
        const x = [...dc.spells].reverse().find((y) => y.veh === v);
        const now = dc.now.get(v);
        if (!x) return '';
        const differs = now && x.name && !now.matches;
        return `<tr><td><a href="#/drivers/${encodeURIComponent(v)}">${esc(v)}</a></td><td>${esc(now ? now.name : x.label)}${differs ? `<small class="warn-text block">last advance was to ${esc(x.name)} — no advance to ${esc(now.name)} yet</small>` : ''}</td><td>${differs ? '—' : x.from ? fmtDate(x.from) : '—'}</td><td class="r">${x.all.length}</td><td class="r">${rupees(x.salary)}</td><td class="r">${rupees(x.ssfc + x.advance)}</td><td class="r">${x.debit ? rupees(x.debit) : '—'}</td><td class="r">${owes(x.balance)}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <p class="muted small">Trips = trips he has driven on it; salary, SSFC and balance count only the trips checked (from ${monthLong(dc.checkFrom)}).</p>
  </section>
  ${dc.byPayments ? driverChangesHtml(dc) + advancesHtml(dc, p) : ''}

  <section class="card">
    <h3>Trips where SSFC paid the driver more than salary − advances <span class="muted">${esc(periodRange(p))}</span></h3>
    ${over.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Loaded</th><th>Trip</th><th>Vehicle</th><th>Route</th><th class="r">Salary</th><th class="r">Your advance</th><th class="r">SSFC should pay</th><th class="r">SSFC paid</th><th class="r">Over</th></tr></thead><tbody>
      ${over.slice(0, state.ui.allOver ? 999 : 40).map((r) => `<tr><td>${fmtDate(r.t.loadDate)}</td><td><a href="#/trip/${r.t.row}">${esc(r.t.trip)}</a></td><td>${esc(shortVeh(r.veh))}</td><td class="small">${esc(routeOf(r.t))}</td><td class="r">${rupees(r.salary)}</td><td class="r">${r.advance ? rupees(r.advance) : '—'}</td><td class="r">${rupees(r.expected)}</td><td class="r">${rupees(r.ssfc)}</td><td class="r bad-text"><b>+${rupees(r.over)}</b></td></tr>`).join('')}
    </tbody></table></div>${over.length > 40 && !state.ui.allOver ? `<button class="btn ghost small" id="all-over">Show all ${over.length}</button>` : ''}` : '<p class="good-text">✓ None in this period.</p>'}
  </section>`);
  bindPeriod(main());
  document.getElementById('all-over')?.addEventListener('click', () => { state.ui.allOver = true; rerender(); });
  document.getElementById('all-changes')?.addEventListener('click', () => { state.ui.allChanges = true; rerender(); });
}

// who took over which truck, newest first
function driverChangesHtml(dc) {
  const changes = dc.spells.filter((x) => !x.first).sort((a, b) => (a.from < b.from ? 1 : -1));
  if (!changes.length) return '';
  const prevOf = (x) => { const mine = dc.spells.filter((y) => y.veh === x.veh); return mine[mine.indexOf(x) - 1]; };
  const show = state.ui.allChanges ? changes : changes.slice(0, 12);
  return `<section class="card">
    <h3>Driver changes</h3>
    <p class="muted small">A new driver's first advance (Driver Payment sheet) falls in the trip he took over. A settlement to the driver who left (security, balance, last trip …) doesn't count as driving.</p>
    <div class="table-wrap"><table class="compact"><thead><tr><th>From</th><th>Vehicle</th><th>Took over</th><th>From driver</th><th>First trip</th><th class="r">Trips driven</th></tr></thead><tbody>
      ${show.map((x) => { const pv = prevOf(x); return `<tr><td>${fmtDate(x.from)}</td><td><a href="#/drivers/${encodeURIComponent(x.veh)}">${esc(shortVeh(x.veh))}</a></td><td><b>${esc(x.label)}</b>${x.current ? ' <span class="pill fuel-pill">Now</span>' : ''}</td><td>${pv ? esc(pv.label) : '—'}${pv ? `<small class="muted block">${plural(pv.all.length, 'trip')}</small>` : ''}</td><td><a href="#/trip/${x.fromTrip.row}">${esc(x.fromTrip.trip)}</a><small class="muted block">${esc(routeOf(x.fromTrip))}</small></td><td class="r">${x.all.length}</td></tr>`; }).join('')}
    </tbody></table></div>
    ${changes.length > show.length ? `<button class="btn ghost small" id="all-changes">Show all ${changes.length}</button>` : ''}
  </section>`;
}

// advances paid in the period, by driver (one person across trucks)
function advancesHtml(dc, p) {
  const pays = (state.data.driverPay || []).filter((x) => x.date.slice(0, 7) >= p.from && x.date.slice(0, 7) <= p.to);
  if (!pays.length) return '';
  const canon = (n) => { const sp = dc.spells.find((x) => x.name && sameDriver(x.name, n)); return sp ? sp.name : n; };
  const by = new Map();
  for (const x of pays) {
    const k = canon(x.name);
    if (!by.has(k)) by.set(k, { name: k, total: 0, n: 0, vehs: new Set(), last: '', notes: [] });
    const g = by.get(k);
    g.total += x.amount; g.n += 1; g.vehs.add(shortVeh(x.veh));
    if (x.date > g.last) g.last = x.date;
    if (x.note) g.notes.push(`${fmtDate(x.date)}: ${x.note}`);
  }
  const list = [...by.values()].sort((a, b) => b.total - a.total);
  const total = pays.reduce((a, x) => a + x.amount, 0);
  return `<section class="card">
    <div class="row-between"><h3>Advances paid by driver</h3><span class="muted small">${esc(periodRange(p))} · ${rupees(total)} in ${plural(pays.length, 'payment')}</span></div>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Driver</th><th>Trucks</th><th class="r">Payments</th><th class="r">Paid</th><th>Last paid</th><th>Notes</th></tr></thead><tbody>
      ${list.map((g) => `<tr><td><b>${esc(g.name)}</b></td><td>${esc([...g.vehs].join(', '))}</td><td class="r">${g.n}</td><td class="r">${rupees(g.total)}</td><td>${fmtDate(g.last)}</td><td class="small muted">${esc(g.notes.join(' · '))}</td></tr>`).join('')}
    </tbody></table></div>
  </section>`;
}

async function viewDriverVehicle(veh) {
  const { drivers: dc } = derived();
  const spells = dc.spells.filter((x) => x.veh === veh);
  if (!spells.length) { setMain('<section class="card"><p>No such vehicle.</p><a class="btn ghost" href="#/drivers">Drivers</a></section>'); return; }
  const rowsOf = (sp) => dc.rows.filter((r) => r.spell === sp);
  setMain(`<section class="card">
    <a class="muted small" href="#/drivers">← Drivers</a>
    <div class="acct-top"><div class="acct-id"><span class="avatar">${esc(shortVeh(veh))}</span><div><h2>${esc(veh)} · drivers</h2><p class="muted">${plural(spells.length, 'driver spell')}</p></div></div></div>
    ${salaryNote(dc)}
  </section>
  ${[...spells].reverse().map((sp) => `<section class="card">
    <div class="row-between"><h3>${esc(sp.label)} ${sp.current ? '<span class="pill fuel-pill">Now</span>' : ''}</h3><span class="row-gap">${owes(sp.balance)}<button class="btn small share-btn" type="button" data-share-spell="${spells.indexOf(sp)}"><span aria-hidden="true">⇪</span> Share</button></span></div>
    <p class="muted small">${sp.from ? dateYear(sp.from) : '—'} (${esc(sp.fromTrip.trip)}) → ${sp.current ? 'now' : `${sp.to ? dateYear(sp.to) : '—'} (${esc(sp.all[sp.all.length - 1].trip)})`} · ${plural(sp.all.length, 'trip')} driven${sp.remark ? ` · “${esc(sp.remark)}”` : ''} · ${plural(sp.trips.length, 'trip')} checked · salary ${rupees(sp.salary)} · SSFC ${rupees(sp.ssfc)} + you ${rupees(sp.advance)}${sp.debit ? ` · debits ${rupees(sp.debit)}` : ''}</p>
    ${sp.payments.length ? `<details class="pay-list"><summary>${plural(sp.payments.length, 'advance')} paid in his trips · ${rupees(sp.payments.reduce((a, x) => a + x.amount, 0))}</summary><div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>Paid to</th><th class="r">Amount</th><th>Note</th></tr></thead><tbody>
      ${[...sp.payments].reverse().map((x) => `<tr><td>${fmtDate(x.date)}</td><td>${esc(x.name)}</td><td class="r">${rupees(x.amount)}</td><td class="small muted">${esc(x.note || '')}</td></tr>`).join('')}
    </tbody></table></div></details>` : ''}
    <div class="table-wrap"><table class="compact"><thead><tr><th>Loaded</th><th>Trip</th><th>Route</th><th class="r">Salary</th><th class="r">Your advance</th><th class="r">SSFC paid</th><th class="r">Debit</th><th class="r">Trip ±</th><th class="r">Running</th></tr></thead><tbody>
      ${rowsOf(sp).reverse().map((r) => `<tr><td>${fmtDate(r.t.loadDate || r.t.start)}</td><td><a href="#/trip/${r.t.row}">${esc(r.t.trip)}</a>${r.t.remarks ? `<small class="muted block">${esc(r.t.remarks)}</small>` : ''}</td><td class="small">${esc(routeOf(r.t))}</td>
        <td class="r">${r.salary != null ? rupees(r.salary) : '<span class="muted">not set</span>'}</td><td class="r">${r.advance ? rupees(r.advance) : '—'}</td><td class="r">${r.ssfc ? rupees(r.ssfc) : '—'}</td><td class="r">${r.debit ? rupees(r.debit) : ''}</td>
        <td class="r ${r.over > dc.tolerance ? 'bad-text' : ''}">${r.over == null ? '' : `${r.over > 0 ? '+' : ''}${rupees(r.over)}`}</td><td class="r"><b class="${r.running > OVERPAID ? 'bad-text' : ''}">${r.running == null ? '' : rupees(r.running)}</b></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">Trip ± = SSFC paid − (salary − your advance); + means paid more. Running = the spell so far, with debits (+ = the driver has more than he earned).</p>
  </section>`).join('')}`);
  main().querySelectorAll('[data-share-spell]').forEach((b) => b.addEventListener('click', () => shareDriver(veh, Number(b.dataset.shareSpell))));
}

// ---------------------------------------------------------------------------
// Tyre & Fastag: SSFC's monthly charges, against the fleet and each vehicle's trend
// ---------------------------------------------------------------------------
async function viewCharges(key) {
  key = key || state.ui.chargeKey || 'tyre';
  state.ui.chargeKey = key;
  const p = currentPeriod();
  const c = derived().charges[key];
  const other = key === 'tyre' ? 'fastag' : 'tyre';
  let months = c.months.filter((m) => m >= p.from && m <= p.to);
  let note = '';
  if (months.length < 3) { months = c.months.slice(-12); note = ' · last 12 months'; }
  if (months.length > 18) { months = months.slice(-18); note = ' · last 18 months'; }
  const basis = { trips: 'per trip', month: 'per month', km: 'per km' }[c.basis];
  const cells = c.included.flatMap((v) => months.map((m) => c.cell[v][m]));
  const total = cells.reduce((a, x) => a + x.amount, 0);
  const trips = cells.reduce((a, x) => a + x.trips, 0);
  const vm = cells.filter((x) => x.amount > 0).length;
  const kmCells = cells.filter((x) => x.km);
  const km = kmCells.reduce((a, x) => a + x.km, 0);
  const max = Math.max(1, ...cells.map((x) => x.amount));
  const flags = c.flags.filter((f) => months.includes(f.month)).sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  const monthTotals = months.map((m) => ({ month: m, value: c.included.reduce((a, v) => a + c.cell[v][m].amount, 0) }));
  setChartWidth(main().clientWidth - 38);
  const icon = { high: '▲', low: '▼', twice: '×2' };
  const flagText = (f) => {
    const x = f.cell;
    if (f.kind === 'twice') return `booked ${x.entries.length} times (${x.entries.map((t) => rupees(t[key])).join(' + ')})`;
    return `${rupees(x.amount)} — the fleet's rate that month gives about ${rupees(x.expected)}${x.trend != null ? `, its own trend about ${rupees(x.trend)}` : ' (no history of its own yet)'}${f.kind === 'low' ? ' · not booked yet?' : ''}`;
  };
  setMain(`<section class="card">
    <div class="row-between"><h2>Tyre &amp; Fastag</h2>
      <div class="chips small-chips" role="group" aria-label="Charge"><a class="chip${key === 'tyre' ? ' on' : ''}" href="#/costs/tyre">Tyre</a><a class="chip${key === 'fastag' ? ' on' : ''}" href="#/costs/fastag">Fastag</a></div></div>
    <p class="muted small">SSFC charges ${key === 'tyre' ? 'tyres' : 'fastag'} once a month per vehicle (on one of its trips). Each month is compared ${basis} with the rest of the fleet that month and with the vehicle's own last six months; each vehicle's first two months aren't judged.${c.basis !== 'km' ? ' Once every route\'s distance is set in Setup, the comparison goes per km.' : ''}</p>
    ${periodHtml()}
    <div class="kpis">
      <div class="kpi hero"><span class="lbl">${CHARGE_RULES[key].name} charged</span><span class="val" ${exact(total)}>${money(total)}</span><span class="sub">${esc(months.length ? `${monthName(months[0])} – ${monthName(months[months.length - 1])}` : '')}${note}</span></div>
      <div class="kpi"><span class="lbl">A vehicle-month</span><span class="val">${money(vm ? total / vm : 0)}</span><span class="sub">average, ${c.included.length} vehicles</span></div>
      <div class="kpi"><span class="lbl">A trip</span><span class="val">${money(trips ? total / trips : 0)}</span><span class="sub">${plural(trips, 'trip')}</span></div>
      ${km ? `<div class="kpi"><span class="lbl">A km</span><span class="val">₹${(kmCells.reduce((a, x) => a + x.amount, 0) / km).toFixed(2)}</span><span class="sub">${indian(km)} km</span></div>` : ''}
      <div class="kpi ${flags.length ? 'warn' : ''}"><span class="lbl">Out of trend</span><span class="val">${flags.length}</span><span class="sub">${flags.filter((f) => f.kind === 'high').length} high · ${flags.filter((f) => f.kind === 'low').length} low · ${flags.filter((f) => f.kind === 'twice').length} twice</span></div>
    </div>
    ${c.excluded.length ? `<p class="small muted">Not in this analysis: <b>${c.excluded.map((v) => esc(shortVeh(v))).join(', ')}</b>${c.excluded.some((v) => months.some((m) => c.cell[v][m].amount)) ? ` (charged ${rupees(c.excluded.reduce((a, v) => a + months.reduce((b, m) => b + c.cell[v][m].amount, 0), 0))} in these months)` : ''} · <a href="#/setup">change in Setup</a></p>` : ''}

    <h3 class="sub-h">Out of the usual trend</h3>
    ${flags.length ? `<div class="todos">${flags.map((f) => `<a class="todo ${f.kind === 'low' ? 'info' : 'warn'}" href="${f.cell.entries[0] ? `#/trip/${f.cell.entries[0].row}` : `#/vehicle/${encodeURIComponent(f.veh)}`}">
      <b>${icon[f.kind]} ${esc(f.veh)} · ${monthLong(f.month)}</b> — ${flagText(f)} <small class="muted">${plural(f.cell.trips, 'trip')}${f.cell.km ? ` · ${indian(f.cell.km)} km` : ''}</small></a>`).join('')}</div>`
    : '<p class="good-text">✓ Nothing out of the usual trend in these months.</p>'}

    <h3 class="sub-h">Fleet total per month</h3>
    ${groupedBars(monthTotals.map((m) => ({ ...m, total: m.value })), [{ key: 'total', name: CHARGE_RULES[key].name, color: 'var(--s-1)' }], {
    label: `${CHARGE_RULES[key].name} charged per month, all vehicles in the analysis`,
    tip: (m) => `<b>${monthLong(m.month)}</b><br>${CHARGE_RULES[key].name} ${rupees(m.value)}<br>Fleet rate ${c.peer[m.month] != null ? `${rupees(c.peer[m.month])} ${basis}` : '—'}`,
  })}

    <h3 class="sub-h">Vehicle by month</h3>
    <div class="table-wrap"><table class="compact heat"><thead><tr><th>Vehicle</th>${months.map((m) => `<th class="r">${monthName(m)}</th>`).join('')}<th class="r">Total</th></tr></thead><tbody>
      ${c.included.map((v) => `<tr><td><a href="#/vehicle/${encodeURIComponent(v)}"><b>${esc(shortVeh(v))}</b></a></td>${months.map((m) => {
    const x = c.cell[v][m];
    const pct = Math.round((x.amount / max) * 55);
    const tip = `${v} · ${monthLong(m)}: ${rupees(x.amount)} · ${plural(x.trips, 'trip')}${x.expected != null ? ` · fleet rate gives ${rupees(x.expected)}` : ''}${x.trend != null ? ` · own trend ${rupees(x.trend)}` : ''}${x.settling ? ' · first months, not judged' : ''}`;
    return `<td class="r h-cell${x.flag ? ` f-${x.flag}` : ''}${x.settling ? ' settling' : ''}" style="--h:${pct}%" title="${esc(tip)}">${x.amount ? `${x.flag ? `<i>${icon[x.flag]}</i>` : ''}${(x.amount / 1000).toFixed(1)}K` : x.trips ? '<span class="muted">—</span>' : ''}</td>`;
  }).join('')}<td class="r"><b>${money(months.reduce((a, m) => a + c.cell[v][m].amount, 0))}</b></td></tr>`).join('')}
      <tr class="foot"><td>Fleet rate</td>${months.map((m) => `<td class="r small">${c.peer[m] != null ? money(c.peer[m]) : '—'}</td>`).join('')}<td class="r small">${basis}</td></tr>
    </tbody></table></div>
    <p class="muted small">Darker = more. ▲ well above both the fleet and the vehicle's trend · ▼ well below (often not booked yet) · ×2 booked twice in the month · faded = a vehicle's first two months.</p>
    <p><a class="btn ghost small" href="#/costs/${other}">See ${CHARGE_RULES[other].name} →</a></p>
  </section>`);
  bindPeriod(main());
  bindCharts(main());
}

// ---------------------------------------------------------------------------
// Setup: upload, routes (distance, driver salary, diesel), vehicles, options
// ---------------------------------------------------------------------------
async function viewSetup() {
  setMain(`<div id="upload-box"></div>${state.data ? '<div id="setup-box"></div>' : ''}`);
  await uploadSection(document.getElementById('upload-box'));
  const box = document.getElementById('setup-box');
  if (!box) return;
  const d = state.data;
  // working copy, edited in place until Save
  const draft = state.ui.setupDraft || (state.ui.setupDraft = JSON.parse(JSON.stringify(state.settings)));
  if (!draft.routes.length) draft.routes = routePairs(d, draft).map((r) => ({ port: r.port, dest: r.dest, from: '', km: '', salary: '', diesel: '' }));
  const vehicles = vehiclesOf(d);
  const ratesOf = (r) => (d.rates || []).find((x) => x.port.toLowerCase() === String(r.port).toLowerCase() && x.dest.toLowerCase() === String(r.dest).toLowerCase());
  const tripsOn = (r) => d.trips.filter((t) => t.port.toLowerCase() === String(r.port).toLowerCase() && t.dest.toLowerCase() === String(r.dest).toLowerCase()).length;
  const paint = () => {
    box.innerHTML = `
    ${state.settingsMissing ? '<div class="card bad-card"><b>Setup can\'t be saved yet.</b> Re-run <code>supabase/fleet-schema.sql</code> in the Supabase SQL Editor (it adds the settings table), then reload. Changes below still apply until you close the app.</div>' : ''}
    <section class="card">
      <div class="row-between"><h2>Routes</h2><span class="muted small">every loading port × destination</span></div>
      <p class="muted small">Distance is used both ways — loaded from the port to the destination, and empty from where a vehicle unloaded to its next port — so each pair once is enough. Driver salary is per trip, the whole salary (your advances + SSFC's payment). Diesel is the litres allotted for the trip. Leave a box empty to use the Rates sheet (shown greyed). For a change from a month on, add a row with <b>From month</b>.</p>
      <div class="table-wrap"><table class="compact routes-edit"><thead><tr><th>Loading port</th><th>Destination</th><th>From month</th><th class="r">Distance (km)</th><th class="r">Driver salary / trip</th><th class="r">Diesel (L)</th><th class="r">Trips</th><th></th></tr></thead><tbody>
        ${draft.routes.map((r, i) => { const rt = ratesOf(r); return `<tr data-i="${i}">
          <td><input data-k="port" value="${esc(r.port)}" list="ports" aria-label="Loading port"></td>
          <td><input data-k="dest" value="${esc(r.dest)}" list="dests" aria-label="Destination"></td>
          <td><input data-k="from" type="month" value="${esc(r.from || '')}" aria-label="From month"></td>
          <td class="r"><input data-k="km" inputmode="decimal" value="${esc(r.km ?? '')}" placeholder="km" aria-label="Distance in km"></td>
          <td class="r"><input data-k="salary" inputmode="decimal" value="${esc(r.salary ?? '')}" placeholder="${rt && rt.driver ? rt.driver : '₹'}" aria-label="Driver salary per trip"></td>
          <td class="r"><input data-k="diesel" inputmode="decimal" value="${esc(r.diesel ?? '')}" placeholder="${rt && rt.diesel ? rt.diesel : 'L'}" aria-label="Diesel litres"></td>
          <td class="r muted">${tripsOn(r) || ''}</td>
          <td><button class="icon" data-del="${i}" title="Remove row" aria-label="Remove row">✕</button></td></tr>`; }).join('')}
      </tbody></table></div>
      <datalist id="ports">${[...new Set(d.trips.map((t) => t.port))].map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <datalist id="dests">${[...new Set(d.trips.map((t) => t.dest))].map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="actions"><button class="btn ghost small" id="add-route">Add a row</button><button class="btn ghost small" id="add-missing">Add missing pairs</button></div>
      <details><summary>Paste from Excel</summary>
        <p class="small muted">One route a line: <code>Loading port, Destination, Distance km, Driver salary, Diesel L</code> (optionally a 6th column <code>From month</code> like 2026-04). Copied Excel cells (tab-separated) work too. Matching rows are updated, new ones added.</p>
        <textarea id="paste" rows="5" placeholder="Kakinada	BALCO	820	11000	630"></textarea>
        <button class="btn ghost small" id="paste-go">Fill in</button></details>
    </section>

    <section class="card">
      <h2>Vehicles in the analysis</h2>
      <p class="muted small">Switch a vehicle off to leave it out of the tyre or fastag analysis for now (its trips stay everywhere else).</p>
      <div class="table-wrap"><table class="compact"><thead><tr><th>Vehicle</th><th class="c">Tyre analysis</th><th class="c">Fastag analysis</th></tr></thead><tbody>
        ${vehicles.map((v) => { const f = vehicleFlags(draft, v); return `<tr><td><b>${esc(v)}</b></td>
          <td class="c"><label class="switch"><input type="checkbox" data-veh="${esc(v)}" data-f="tyre"${f.tyre ? ' checked' : ''}><span></span><em class="sr">Tyre analysis for ${esc(v)}</em></label></td>
          <td class="c"><label class="switch"><input type="checkbox" data-veh="${esc(v)}" data-f="fastag"${f.fastag ? ' checked' : ''}><span></span><em class="sr">Fastag analysis for ${esc(v)}</em></label></td></tr>`; }).join('')}
      </tbody></table></div>
    </section>

    <section class="card">
      <h2>Driver pay</h2>
      <label class="radio"><input type="checkbox" id="opt-extra"${draft.driver.extraIsAdvance ? ' checked' : ''}> Count “Extra Own Driver Pay” as an advance out of the salary (leave unticked: it's the extra promised for those trips, paid on top and settled)</label>
      <label class="radio"><input type="checkbox" id="opt-debit"${draft.driver.debitCounts ? ' checked' : ''}> “Driver Debit” is money the driver owes back (counts against him)</label>
      <div class="row-form"><label>Check driver pay from <input id="opt-from" type="month" value="${esc(draft.driver.checkFrom || monthOf(today()))}"></label>
        <label>Ignore differences up to (₹ a trip) <input id="opt-tol" inputmode="decimal" value="${esc(draft.driver.tolerance)}"></label></div>
      <p class="muted small">Trips loaded before this month are as the Trip Register has them — salaries changed over time and those were settled — so they aren't checked. Set it to the month your salaries in Routes start from.</p>
    </section>

    <section class="card">
      <h2>Diesel recon</h2>
      <label class="radio"><input type="radio" name="recon" value="excel"${!draft.recon.useApp ? ' checked' : ''}> Use the workbook's Recon Engine (matches Excel); routes' diesel here only for trips after it</label>
      <label class="radio"><input type="radio" name="recon" value="app"${draft.recon.useApp ? ' checked' : ''}> Use the diesel set here for every trip (+ overload / − underload as in Excel)</label>
    </section>

    <div class="save-bar"><span class="muted small">${state.settingsMeta ? `Saved ${new Date(state.settingsMeta.updated_at).toLocaleString('en-IN')}${state.settingsMeta.by_email ? ` · ${esc(state.settingsMeta.by_email)}` : ''}` : 'Not saved yet'}</span>
      <button class="btn ghost" id="setup-reset">Undo changes</button><button class="btn" id="setup-save">Save setup</button></div>`;
    bind();
  };
  const num = (v) => { const n = Number(String(v).replace(/[,₹\s]/g, '')); return String(v).trim() === '' || !Number.isFinite(n) ? '' : n; };
  const bind = () => {
    box.querySelectorAll('.routes-edit input').forEach((inp) => inp.addEventListener('change', () => {
      const r = draft.routes[Number(inp.closest('tr').dataset.i)];
      const k = inp.dataset.k;
      r[k] = ['km', 'salary', 'diesel'].includes(k) ? num(inp.value) : inp.value.trim();
    }));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { draft.routes.splice(Number(b.dataset.del), 1); paint(); }));
    box.querySelector('#add-route').addEventListener('click', () => { draft.routes.push({ port: '', dest: '', from: '', km: '', salary: '', diesel: '' }); paint(); });
    box.querySelector('#add-missing').addEventListener('click', () => {
      const have = new Set(draft.routes.map((r) => `${r.port}|${r.dest}`.toLowerCase()));
      routePairs(d, draft).forEach((r) => { if (!have.has(`${r.port}|${r.dest}`.toLowerCase())) draft.routes.push({ port: r.port, dest: r.dest, from: '', km: '', salary: '', diesel: '' }); });
      paint();
    });
    box.querySelector('#paste-go').addEventListener('click', () => {
      let n = 0;
      for (const line of box.querySelector('#paste').value.split(/\r?\n/)) {
        const c = line.split(/\t|,|;/).map((x) => x.trim());
        if (c.length < 3 || !c[0] || !c[1] || /port|location/i.test(c[0])) continue;
        const from = /^\d{4}-\d{2}$/.test(c[5] || '') ? c[5] : '';
        let r = draft.routes.find((x) => x.port.toLowerCase() === c[0].toLowerCase() && x.dest.toLowerCase() === c[1].toLowerCase() && (x.from || '') === from);
        if (!r) { r = { port: c[0], dest: c[1], from }; draft.routes.push(r); }
        r.km = num(c[2] ?? ''); r.salary = num(c[3] ?? ''); r.diesel = num(c[4] ?? '');
        n += 1;
      }
      toast(n ? `Filled in ${plural(n, 'route')} — Save setup to keep them.` : 'Nothing to fill in: one route a line, port, destination, km, salary, diesel.', n ? 'ok' : 'bad');
      paint();
    });
    box.querySelectorAll('[data-veh]').forEach((c) => c.addEventListener('change', () => {
      draft.vehicles[c.dataset.veh] = { ...vehicleFlags(draft, c.dataset.veh), [c.dataset.f]: c.checked };
    }));
    box.querySelector('#opt-extra').addEventListener('change', (e) => { draft.driver.extraIsAdvance = e.target.checked; });
    box.querySelector('#opt-debit').addEventListener('change', (e) => { draft.driver.debitCounts = e.target.checked; });
    box.querySelector('#opt-tol').addEventListener('change', (e) => { draft.driver.tolerance = Number(num(e.target.value) || 0); });
    box.querySelector('#opt-from').addEventListener('change', (e) => { draft.driver.checkFrom = e.target.value || ''; });
    box.querySelectorAll('[name=recon]').forEach((r) => r.addEventListener('change', () => { draft.recon.useApp = r.value === 'app' && r.checked; }));
    box.querySelector('#setup-reset').addEventListener('click', () => { state.ui.setupDraft = null; viewSetup(); });
    box.querySelector('#setup-save').addEventListener('click', (e) => guard(async () => {
      const clean = withDefaults(JSON.parse(JSON.stringify(draft)));
      clean.routes = clean.routes.filter((r) => r.port && r.dest && (r.km !== '' || r.salary !== '' || r.diesel !== ''))
        .map((r) => ({ port: r.port, dest: r.dest, from: r.from || '', km: r.km === '' ? null : r.km, salary: r.salary === '' ? null : r.salary, diesel: r.diesel === '' ? null : r.diesel }));
      e.target.disabled = true;
      const shared = !state.settingsMissing && state.store && state.store.saveSettings && !state.localOnly;
      // changed on another device since this page loaded it? don't overwrite it unasked
      if (shared) {
        const cur = await state.store.settings().catch(() => null);
        const mine = state.settingsMeta ? state.settingsMeta.updated_at : null;
        if (cur && cur.updated_at && cur.updated_at !== mine
          && !window.confirm(`Setup was changed${cur.by_email ? ` by ${cur.by_email}` : ''} on ${new Date(cur.updated_at).toLocaleString('en-IN')}, after this page loaded it.\n\nOK = save yours over it.\nCancel = keep theirs (your edits here are dropped).`)) {
          state.settings = withDefaults(cur.value);
          state.settingsMeta = cur;
          state.rev += 1;
          state.ui.setupDraft = null;
          toast('Kept the other change — Setup reloaded.');
          viewSetup();
          return;
        }
      }
      state.settings = clean;
      state.rev += 1;
      if (shared) {
        try {
          state.settingsMeta = await state.store.saveSettings(clean);
          toast('Setup saved.');
        } catch (err) {
          state.settingsMissing = /fleet_settings|schema cache|does not exist/i.test(err.message);
          toast(state.settingsMissing ? 'Applied for now — run the updated fleet-schema.sql to save it.' : err.message, 'bad');
        }
      } else {
        toast('Applied on this device (not saved).');
      }
      state.ui.setupDraft = null;
      e.target.disabled = false;
      viewSetup();
    }));
  };
  paint();
}


// ---------------------------------------------------------------------------
// Performance: each vehicle against the others on the same route at the same time
// ---------------------------------------------------------------------------
const dd = (n, plus = true) => (n == null ? '—' : `${plus && n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)} d`);

function vehPerfHtml(veh, p) {
  const perf = performance(state.data, today(), { from: p.from, to: p.to });
  const v = perf.vehicles.find((x) => x.veh === veh);
  if (!v || !v.trips) return '';
  const fleetAvg = (k) => { const xs = perf.vehicles.filter((x) => x.trips && x[k] != null).map((x) => x[k]); return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null; };
  const cls = v.under ? 'bad-card' : v.top ? 'good-card' : '';
  return `<div class="perf-strip ${cls}">
    <div><b>${v.under ? '⚠ Underperforming' : v.watch ? 'Slipping' : v.top ? '★ Among the best' : 'On par'}</b> <span class="muted">vs the others on the same route at the same time · ${plural(v.trips, 'trip')}</span></div>
    <div class="perf-nums">
      <span><small>A trip vs peers</small><b class="${v.slowerPerTrip >= 1 ? 'bad-text' : v.slowerPerTrip <= -0.5 ? 'good-text' : ''}">${dd(v.slowerPerTrip)}</b></span>
      <span><small>To load</small><b>${dd(v.usualToLoad)}</b></span>
      <span><small>Loaded run</small><b>${dd(v.usualLoaded)}</b></span>
      <span><small>Idle after</small><b>${dd(v.usualIdle)}</b></span>
      <span><small>Trip (avg)</small><b>${v.avgTrip != null ? `${v.avgTrip.toFixed(1)} d` : '—'}</b><small>fleet ${fleetAvg('avgTrip') != null ? fleetAvg('avgTrip').toFixed(1) : '—'} d</small></span>
      <span><small>Best of its group</small><b>${v.wins}×</b></span>
      <span><small>Diesel fills / trip</small><b>${v.fillsPerTrip != null ? v.fillsPerTrip.toFixed(1) : '—'}</b><small>fleet ${fleetAvg('fillsPerTrip') != null ? fleetAvg('fillsPerTrip').toFixed(1) : '—'}</small></span>
    </div>
    <a class="small" href="#/performance">All vehicles' performance →</a></div>`;
}

// the trips on the same route that started within ±10 days, side by side
function sameTimeHtml(t) {
  const d = state.data;
  const { perfAll } = derived();
  const group = sameTimeTrips(t).sort((a, b) => (a.start < b.start ? -1 : 1));
  if (group.length < 2) return '';
  const st = perfAll.stages;
  const done = group.filter((x) => st.get(x.row) && st.get(x.row).valid);
  const best = done.length ? done.reduce((m, x) => (st.get(x.row).trip < st.get(m.row).trip ? x : m)) : null;
  const fillDates = (x) => (st.get(x.row) ? st.get(x.row).fills.map((h) => h.date) : []);
  const rows = group.map((x) => ({
    label: shortVeh(x.veh), sub: `${x.trip}${st.get(x.row) && st.get(x.row).trip != null ? ` · ${st.get(x.row).trip} d` : ''}`,
    start: x.start, load: x.loadDate, unload: x.unloadDate && x.unloadDate <= today() ? x.unloadDate : null, live: !x.unloadDate,
    fills: fillDates(x), best: best && x === best, mark: x === t,
  }));
  setChartWidth(main().clientWidth - 38);
  const c = perfAll.compared.find((x) => x.t === t);
  return `<section class="card">
    <h3>Same route, same time <span class="muted">${esc(routeOf(t))} · started ±10 days</span></h3>
    ${c ? `<p class="small">This trip: <b>${c.trip} days</b> (to load ${c.toLoad} d, loaded run ${c.loaded} d${c.idle != null ? `, then ${c.idle} d idle` : ''}). Best of the group: <b>${c.best.trip} days</b> by ${esc(shortVeh(c.bestBy.trip.veh))}; typical ${c.usual.trip} d. ${c.slow ? `<span class="pill bad-pill">${c.vsUsual.trip} days slower than typical</span>` : c.behind.trip === 0 ? '<span class="pill good-pill">★ Best of the group</span>' : ''}</p>` : ''}
    ${lanesLegend()}
    <div class="lanes-wrap" data-lanes>${lanesSvg(rows, { today: today(), width: Math.max(520, main().clientWidth - 38) })}</div>
    <p class="muted small">Green row = the quickest of the group; amber = this trip. Tap a row for its dates.</p>
  </section>`;
}
function sameTimeTrips(t) {
  return state.data.trips.filter((x) => x.port === t.port && x.dest === t.dest && x.start && t.start && Math.abs(daysBetween(x.start, t.start)) <= 10);
}

async function viewPerformance(route) {
  const d = state.data;
  const p = currentPeriod();
  const perf = performance(d, today(), { from: p.from, to: p.to, route });
  const { live } = derived();
  const routes = [...new Set(d.trips.map(routeOf))].sort();
  const vs = perf.vehicles.filter((v) => v.trips).sort((a, b) => b.slowerPerTrip - a.slowerPerTrip);
  const max = Math.max(1, ...vs.map((v) => Math.abs(v.slowerPerTrip)));
  const under = vs.filter((v) => v.under);
  const slowTrips = [...perf.compared].filter((c) => c.slow).sort((a, b) => b.vsUsual.trip - a.vsUsual.trip);
  const cyc = perf.cycle || 9;
  const avgFreight = (() => { const xs = d.trips.filter((t) => inPeriod(t, p) && t.bhada); return xs.length ? xs.reduce((a, t) => a + t.bhada, 0) / xs.length : 0; })();
  const dc = derived().drivers;
  const drv = dc.byPayments ? byDriver(perf, dc.tripDriver).sort((a, b) => b.slowerPerTrip - a.slowerPerTrip) : [];
  const drvMax = Math.max(1, ...drv.map((x) => Math.abs(x.slowerPerTrip)));
  // who drove the vehicle's compared trips (oldest first)
  const driversOf = (v) => { const out = []; for (const c of [...v.list].sort((a, b) => (a.t.start < b.t.start ? -1 : 1))) { const n = dc.tripDriver(c.t); if (n && out[out.length - 1] !== n) out.push(n); } return out.length ? out.join(' → ') : driverNow(v.veh); };
  setChartWidth(main().clientWidth - 38);
  setMain(`<section class="card">
    <div class="row-between"><h2>Performance</h2><span class="muted small">${esc(periodRange(p))}</span></div>
    ${subNav('perf')}
    <p class="muted small">Each trip is compared with the other trips on the <b>same route</b> that <b>started within ±10 days</b> (±21 when there are few): days to get loaded (empty run + port) and the loaded run; idle days after unloading are shown too but not counted against the driver (the next loading is mostly up to dispatch). A trip ${SLOW_DAYS}+ days slower than its group's typical is <b>slow</b>; a vehicle averaging a day or more a trip slower than its peers — or with 40%+ slow trips — is <b>underperforming</b>. Dates are whole days.</p>
    ${periodHtml()}
    <div class="chips small-chips" role="group" aria-label="Route"><a class="chip${!route ? ' on' : ''}" href="#/performance">All routes</a>${routes.map((r) => `<a class="chip${route === r ? ' on' : ''}" href="#/performance?r=${encodeURIComponent(r)}">${esc(r)}</a>`).join('')}</div>
  </section>

  ${live.length ? `<section class="card"><h3>Behind on the road now</h3>
    <div class="behind-grid">${live.map((x) => `<a class="behind-card" href="#/vehicle/${encodeURIComponent(x.veh)}">${bulkerFor(x.stage === 'loaded' ? x.t : null, { compact: true, veh: x.veh })}
      <span><b>${esc(shortVeh(x.veh))}</b> ${x.late ? `<span class="pill bad-pill">+${x.sofar - x.bench} d</span>` : '<span class="pill warn-pill">others ahead</span>'}</span>
      <small>${esc(liveText(x))}</small></a>`).join('')}</div></section>` : ''}

  <section class="card">
    <h3>Days a trip vs the others on the same route</h3>
    ${under.length ? `<div class="todo warn">⚠ <b>${under.map((v) => esc(shortVeh(v.veh))).join(', ')}</b> ${under.length === 1 ? 'is' : 'are'} underperforming — about ${under.reduce((a, v) => a + v.daysSlower, 0).toFixed(0)} days lost against typical peers, ≈ ${(under.reduce((a, v) => a + v.daysSlower, 0) / cyc).toFixed(1)} trips (~${money((under.reduce((a, v) => a + v.daysSlower, 0) / cyc) * avgFreight)} freight) in this period.</div>` : perf.compared.length ? '<p class="good-text">✓ No vehicle is consistently slower than the others in this period.</p>' : '<p class="muted">Not enough unloaded trips in this period to compare.</p>'}
    <div class="perf-rank">${vs.map((v) => `<a class="perf-row${v.under ? ' under' : v.top ? ' top' : ''}" href="#/vehicle/${encodeURIComponent(v.veh)}">
      <span class="pr-name"><b>${esc(shortVeh(v.veh))}</b>${v.under ? '<span class="pill bad-pill">⚠ Underperforming</span>' : v.watch ? '<span class="pill warn-pill">Slipping</span>' : v.top ? '<span class="pill good-pill">★ Top</span>' : ''}<small>${plural(v.trips, 'trip')} · ${v.slowTrips} slow · best ${v.wins}×${driversOf(v) ? ` · ${esc(driversOf(v))}` : ''}</small></span>
      <span class="div-bar"><span class="neg">${v.slowerPerTrip < 0 ? `<i style="width:${((-v.slowerPerTrip / max) * 100).toFixed(1)}%"></i>` : ''}</span><span class="pos">${v.slowerPerTrip > 0 ? `<i style="width:${((v.slowerPerTrip / max) * 100).toFixed(1)}%"></i>` : ''}</span></span>
      <span class="r pr-val"><b class="${v.slowerPerTrip >= 1 ? 'bad-text' : v.slowerPerTrip <= -0.5 ? 'good-text' : ''}">${dd(v.slowerPerTrip)}</b><small>${v.worstStage && v.slowerPerTrip > 0 ? `mostly ${STAGE_NAME[v.worstStage]}` : 'a trip'}</small></span></a>`).join('')}</div>
    <p class="muted small">Left (blue) = faster than its peers, right (red) = slower; days a trip from start to unloading.</p>
    ${drv.length ? `<h3 class="sub-h">By driver <span class="muted">the trips each one drove, on whichever truck</span></h3>
    ${drv.some((x) => x.under) ? `<div class="todo warn">⚠ <b>${drv.filter((x) => x.under).map((x) => esc(x.name)).join(', ')}</b> — slower than the others on the same route at the same time. ${drv.filter((x) => x.under && x.worstStage).map((x) => `${esc(x.name)}: mostly ${STAGE_NAME[x.worstStage]} (${dd(x.worstStage === 'toLoad' ? x.usualToLoad : x.usualLoaded)} a trip)`).join('; ')}</div>` : ''}
    <div class="perf-rank">${drv.map((x) => `<div class="perf-row${x.under ? ' under' : x.top ? ' top' : ''}">
      <span class="pr-name"><b>${esc(x.name)}</b>${x.under ? '<span class="pill bad-pill">⚠ Underperforming</span>' : x.watch ? '<span class="pill warn-pill">Slipping</span>' : x.top ? '<span class="pill good-pill">★ Top</span>' : ''}<small>${plural(x.trips, 'trip')} · ${x.slowTrips} slow · ${esc(x.vehs.map(shortVeh).join(', '))}${x.vehs.every((v) => (dc.now.get(v) || {}).name !== x.name) ? ' · left' : ''}</small></span>
      <span class="div-bar"><span class="neg">${x.slowerPerTrip < 0 ? `<i style="width:${((-x.slowerPerTrip / drvMax) * 100).toFixed(1)}%"></i>` : ''}</span><span class="pos">${x.slowerPerTrip > 0 ? `<i style="width:${((x.slowerPerTrip / drvMax) * 100).toFixed(1)}%"></i>` : ''}</span></span>
      <span class="r pr-val"><b class="${x.slowerPerTrip >= 1 ? 'bad-text' : x.slowerPerTrip <= -0.5 ? 'good-text' : ''}">${dd(x.slowerPerTrip)}</b><small>${x.worstStage && x.slowerPerTrip > 0 ? `mostly ${STAGE_NAME[x.worstStage]}` : 'a trip'}</small></span></div>`).join('')}</div>
    <p class="muted small">Who drove each trip comes from the advances in the Driver Payment sheet. Fewer than 3 trips in the period: shown, not judged.</p>` : ''}

    <h3 class="sub-h">Stage by stage <span class="muted">average days, and vs the group's typical</span></h3>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Vehicle</th><th class="r">Trips</th>${STAGES.map((s) => `<th class="r" title="${esc(s.note)}">${esc(s.name)}</th>`).join('')}<th class="r">Whole trip</th><th class="r">vs best</th><th class="r">Fills / trip</th><th class="r">Diesel / trip</th></tr></thead><tbody>
      ${vs.map((v) => `<tr class="${v.under ? 'row-under' : ''}"><td><a href="#/vehicle/${encodeURIComponent(v.veh)}"><b>${esc(shortVeh(v.veh))}</b></a></td><td class="r">${v.trips}</td>
        ${[['avgToLoad', 'usualToLoad'], ['avgLoaded', 'usualLoaded'], ['avgIdle', 'usualIdle']].map(([a, u]) => `<td class="r">${v[a] != null ? v[a].toFixed(1) : '—'} <small class="${v[u] >= 0.75 ? 'bad-text' : v[u] <= -0.5 ? 'good-text' : 'muted'}">${dd(v[u])}</small></td>`).join('')}
        <td class="r"><b>${v.avgTrip != null ? v.avgTrip.toFixed(1) : '—'}</b></td><td class="r muted">${dd(v.lostPerTrip)}</td><td class="r">${v.fillsPerTrip != null ? v.fillsPerTrip.toFixed(1) : '—'}</td><td class="r">${v.litresPerTrip != null ? `${Math.round(v.litresPerTrip)} L` : '—'}</td></tr>`).join('')}
    </tbody></table></div>
  </section>

  <section class="card"><h3>Slowest trips <span class="muted">${plural(slowTrips.length, 'trip')} ${SLOW_DAYS}+ days slower than their group</span></h3>
    ${slowTrips.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Started</th><th>Vehicle</th><th>Trip</th><th>Route</th><th class="r">Took</th><th class="r">Typical</th><th class="r">Best</th><th>Lost in</th></tr></thead><tbody>
      ${slowTrips.slice(0, state.ui.allSlow ? 999 : 30).map((c) => { const worst = ['toLoad', 'loaded'].sort((a, b) => (c.vsUsual[b] || 0) - (c.vsUsual[a] || 0))[0]; return `<tr><td>${fmtDate(c.t.start)}</td><td><b>${esc(shortVeh(c.t.veh))}</b>${dc.tripDriver(c.t) ? `<small class="muted block">${esc(dc.tripDriver(c.t))}</small>` : ''}</td><td><a href="#/trip/${c.t.row}">${esc(c.t.trip)}</a></td><td class="small">${esc(routeOf(c.t))}</td><td class="r bad-text"><b>${c.trip} d</b></td><td class="r">${c.usual.trip} d</td><td class="r">${c.best.trip} d <small class="muted">${esc(shortVeh(c.bestBy.trip.veh))}</small></td><td class="small">${worst === 'toLoad' ? `getting loaded +${c.vsUsual.toLoad} d` : `loaded run +${c.vsUsual.loaded} d`}${c.t.remarks ? ` · <span class="muted">${esc(c.t.remarks)}</span>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>${slowTrips.length > 30 && !state.ui.allSlow ? `<button class="btn ghost small" id="all-slow">Show all ${slowTrips.length}</button>` : ''}` : '<p class="good-text">✓ None.</p>'}
    <p class="muted small">Tap a trip to see it side by side with the others that started with it (with each diesel fill).</p>
  </section>`);
  bindPeriod(main());
  document.getElementById('all-slow')?.addEventListener('click', () => { state.ui.allSlow = true; rerender(); });
}

// ---------------------------------------------------------------------------
// Trends: rate per ton, the costs and what's kept, over time — as recorded in
// the Trip Register (the truth for every past trip)
// ---------------------------------------------------------------------------
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
function splitBar(sum, label, sub) {
  const segs = PARTS.map((p) => ({ p, v: Math.max(0, sum.share[p.key] || 0) })).filter((x) => x.v > 0);
  const tot = segs.reduce((a, x) => a + x.v, 0) || 1;
  const tip = PARTS.map((p) => `${p.name} ${pct1(sum.share[p.key] || 0)} · ${money(sum[p.key] || 0)} a trip`).join('\n');
  return `<div class="split-row"><span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    <span class="split-bar" title="${esc(tip)}">${segs.map((x) => `<i style="flex:${x.v / tot};background:${x.p.color}">${x.v >= 0.06 ? pct1(x.v).replace('.0%', '%') : ''}</i>`).join('')}</span></div>`;
}

function cmpTable(c) {
  const b = c.before;
  const a = c.after;
  const row = (name, kb, ka, { f = money, good = 'down', note = '' } = {}) => {
    const vb = typeof kb === 'function' ? kb(b) : b[kb];
    const va = typeof ka === 'function' ? ka(a) : a[ka];
    const dlt = va - vb;
    const better = good === 'up' ? dlt > 0 : dlt < 0;
    const cls = Math.abs(dlt) < 1e-9 ? '' : better ? 'good-text' : 'bad-text';
    return `<tr><td>${esc(name)}${note ? `<small class="muted block">${esc(note)}</small>` : ''}</td><td class="r">${f(vb)}</td><td class="r">${f(va)}</td><td class="r ${cls}">${dlt > 0 ? '+' : dlt < 0 ? '−' : ''}${f(Math.abs(dlt))}</td></tr>`;
  };
  const tonnesF = (v) => `${v.toFixed(2)} T`;
  return `<div class="table-wrap"><table class="compact cmp"><thead><tr><th>A trip, on average</th><th class="r">Before · ${b.trips}</th><th class="r">After · ${a.trips}</th><th class="r">Change</th></tr></thead><tbody>
    ${row('Rate per ton', 'rate', 'rate', { f: (v) => `₹${indian(v)}`, good: 'up' })}
    ${row('Load', 'loadWt', 'loadWt', { f: tonnesF, good: 'up' })}
    ${row('Freight (bhada)', 'bhada', 'bhada', { good: 'up' })}
    ${row('Diesel', 'diesel', 'diesel', { note: `${Math.round(b.litres)} → ${Math.round(a.litres)} L · ₹${b.perL.toFixed(2)} → ₹${a.perL.toFixed(2)} a litre` })}
    ${row('Driver', 'driver', 'driver')}
    ${row('Fastag & tolls', 'fastag', 'fastag')}
    ${row('Tyre & maintenance', 'tyreMaint', 'tyreMaint')}
    ${row('RTO & documents', 'rtoDocs', 'rtoDocs')}
    ${row('Urea, misc & shortage', 'other', 'other')}
    <tr class="sum">${row('Kept before yearly costs & EMI', 'keptRun', 'keptRun', { good: 'up' }).slice(4)}
    ${row('…as a share of freight', 'marginRun', 'marginRun', { f: pct1, good: 'up' })}
    ${row('Insurance, permit & road tax (yearly)', 'yearly', 'yearly', { note: 'booked on one trip a year' })}
    ${row('Kept before EMI', 'kept', 'kept', { good: 'up' })}
    ${row('EMI booked', 'emi', 'emi')}
  </tbody></table></div>`;
}

function verdict(c) {
  const b = c.before;
  const a = c.after;
  const fr = a.bhada - b.bhada;
  const di = a.diesel - b.diesel;
  const kr = a.keptRun - b.keptRun;
  const sgn = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;
  const loadNote = Math.abs(a.loadWt - b.loadWt) >= 0.3 ? ` (loads ${a.loadWt > b.loadWt ? 'up' : 'down'} ${Math.abs(a.loadWt - b.loadWt).toFixed(1)} T)` : '';
  return `<p class="verdict">The rate went ${c.by > 0 ? 'up' : 'down'} <b>₹${indian(Math.abs(c.by))} a ton (${c.pct > 0 ? '+' : ''}${(c.pct * 100).toFixed(1)}%)</b>: freight a trip <b>${sgn(fr)}</b>${loadNote}; diesel <b>${sgn(di)}</b> (₹${b.perL.toFixed(2)} → ₹${a.perL.toFixed(2)} a litre); what's kept before yearly costs and EMI <b class="${kr >= 0 ? 'good-text' : 'bad-text'}">${sgn(kr)}</b> a trip — ${pct1(b.marginRun)} → ${pct1(a.marginRun)} of freight.</p>`;
}

async function viewTrends(route) {
  const d = state.data;
  const rs = trendRoutes(d);
  const changes = rateChanges(d).filter((c) => !route || c.route === route);
  const trend = monthlyTrend(d, route);
  // the running month isn't complete (few trips unloaded, SSFC's monthly charges not booked yet)
  const thisMonth = monthOf(today());
  const recent = trend.filter((m) => m.month < thisMonth).slice(-18);
  // the small charts: as wide as their box (the grid fits boxes of 300px+)
  const inner = main().clientWidth - 38;
  const cols = Math.max(1, Math.floor((inner + 12) / 312));
  setChartWidth((inner - (cols - 1) * 12) / cols - 26);
  const fleetAll = trendSummary(d.trips.filter((t) => t.status === 'done' && t.bhada && (!route || `${t.port} → ${t.dest}` === route)), d);
  const eras = route ? rateEras(d, route) : [];
  const tipOf = (m, line) => `<b>${monthLong(m.month)}</b> · ${plural(m.trips, 'trip')}<br>${line}`;
  const small = (title, sub, key, fmt, color) => `<div class="sm-card"><h4>${esc(title)}</h4><p>${esc(sub)}</p>${lineChart(recent.map((m) => ({ label: monthName(m.month), value: typeof key === 'function' ? key(m) : m[key], tip: tipOf(m, `${title}: ${fmt(typeof key === 'function' ? key(m) : m[key])}`) })), { fmt, label: title, color, h: 140 })}</div>`;
  setMain(`<section class="card">
    <a class="muted small" href="#/">← Home</a>
    <div class="row-between"><h2>Rates, costs &amp; income</h2><span class="muted small">from the Trip Register</span></div>
    <p class="muted small">Every past trip as it is in the Trip Register — its rate per ton, diesel, what the driver was paid. Monthly SSFC charges (fastag, tyre, maintenance, RTO entry) are spread over each vehicle's trips that month; the yearly insurance / permit / road tax and the EMI are shown apart, so trips compare like for like.</p>
    <div class="chips small-chips" role="group" aria-label="Route"><a class="chip${!route ? ' on' : ''}" href="#/trends">All routes</a>${rs.map((r) => `<a class="chip${route === r.route ? ' on' : ''}" href="#/trends?r=${encodeURIComponent(r.route)}">${esc(r.route)} <small>${r.trips}</small></a>`).join('')}</div>
  </section>

  <section class="card"><h3>When the rate changed</h3>
    ${changes.length ? `<div class="chg-grid">${changes.map((c) => `<div class="chg-card">
      <div class="chg-head"><b>${esc(c.route)}</b><span class="muted">from ${dateYear(c.at)}</span><span class="chg-rate">₹${indian(c.from)} → ₹${indian(c.to)}<small> a ton · ${c.pct > 0 ? '+' : ''}${(c.pct * 100).toFixed(1)}%</small></span></div>
      ${verdict(c)}
      <p class="muted small">Before: the last ${c.before.trips} trips at ₹${indian(c.from)} · after: the first ${c.after.trips} at ₹${indian(c.to)}.</p>
      ${cmpTable(c)}</div>`).join('')}</div>` : `<p class="muted">The rate${route ? ' on this route' : ''} hasn't changed in the register.</p>`}
  </section>

  <section class="card"><h3>Where the bhada goes</h3>
    ${legend(PARTS.map((p) => ({ name: p.name, color: p.color })))}
    <div class="split100">
      ${splitBar(fleetAll, route ? 'All trips' : 'All routes, all trips', `${plural(fleetAll.trips, 'trip')} · ${money(fleetAll.bhada)} a trip`)}
      ${eras.length > 1 ? eras.map((e) => splitBar(e, `₹${indian(e.rate)} a ton`, `${dm(e.from)} ${e.from.slice(2, 4)} – ${dm(e.to)} ${e.to.slice(2, 4)} · ${plural(e.trips, 'trip')}`)).join('') : ''}
      ${!route ? rs.map((r) => splitBar(trendSummary(d.trips.filter((t) => t.status === 'done' && t.bhada && `${t.port} → ${t.dest}` === r.route), d), r.route, plural(r.trips, 'trip'))).join('') : ''}
      ${recent.slice(-6).map((m) => splitBar(m, monthLong(m.month), `${plural(m.trips, 'trip')} · ${money(m.bhada)} a trip`)).join('')}
    </div>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Share of freight</th>${PARTS.map((p) => `<th class="r">${esc(p.short || p.name)}</th>`).join('')}</tr></thead><tbody>
      <tr><td><b>${route ? 'All trips' : 'All routes'}</b></td>${PARTS.map((p) => `<td class="r">${pct1(fleetAll.share[p.key] || 0)}</td>`).join('')}</tr>
      ${[...recent].reverse().map((m) => `<tr><td>${monthName(m.month)}</td>${PARTS.map((p) => `<td class="r">${pct1(m.share[p.key] || 0)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
  </section>

  <section class="card"><h3>Month by month <span class="muted">${esc(route || 'all routes')} · a trip, on average</span></h3>
    <div class="small-multiples">
      ${route ? small('Rate per ton', 'as billed', 'rate', (v) => `₹${indian(v)}`, 'var(--s-1)') : small('Freight a trip', 'all routes', 'bhada', money, 'var(--s-1)')}
      ${small('Diesel price', 'what the pumps charged (HSD Data)', 'pumpPerL', (v) => `₹${v.toFixed(2)}`, 'var(--s-1)')}
      ${small('Diesel a trip', 'rupees', 'diesel', money, 'var(--s-1)')}
      ${small('Diesel litres a trip', 'litres', 'litres', (v) => `${Math.round(v)} L`, 'var(--s-1)')}
      ${small('Driver a trip', 'SSFC + your payments', 'driver', money, 'var(--s-2)')}
      ${small('Kept a trip', 'before yearly costs & EMI', 'keptRun', money, 'var(--s-8)')}
      ${small('Kept, share of freight', 'before yearly costs & EMI', 'marginRun', pct1, 'var(--s-8)')}
      ${small('Load a trip', 'tonnes', 'loadWt', (v) => `${v.toFixed(2)} T`, 'var(--s-1)')}
    </div>
    <div class="table-wrap"><table class="compact"><thead><tr><th>Month</th><th class="r">Trips</th>${route ? '<th class="r">Rate</th>' : ''}<th class="r">Load</th><th class="r">Freight</th><th class="r">Diesel</th><th class="r">₹/L</th><th class="r">Driver</th><th class="r">Fastag</th><th class="r">Tyre & maint</th><th class="r">RTO & docs</th><th class="r">Other</th><th class="r">Yearly</th><th class="r">Kept*</th><th class="r">Kept*%</th></tr></thead><tbody>
      ${[...trend].reverse().map((m) => `<tr><td>${monthName(m.month)}${m.month >= thisMonth ? ' <small class="muted">so far</small>' : ''}</td><td class="r">${m.trips}</td>${route ? `<td class="r">₹${m.rates.map((r) => indian(r)).join(' / ')}</td>` : ''}<td class="r">${m.loadWt.toFixed(1)}</td><td class="r">${rupees(m.bhada)}</td><td class="r">${rupees(m.diesel)}</td><td class="r">${m.perL ? m.perL.toFixed(1) : '—'}</td><td class="r">${rupees(m.driver)}</td><td class="r">${rupees(m.fastag)}</td><td class="r">${rupees(m.tyreMaint)}</td><td class="r">${rupees(m.rtoDocs)}</td><td class="r">${rupees(m.other)}</td><td class="r">${m.yearly ? rupees(m.yearly) : '—'}</td><td class="r ${signed(m.keptRun)}"><b>${rupees(m.keptRun)}</b></td><td class="r">${pct1(m.marginRun)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">Averages a trip of the trips loaded that month (unloaded trips only; this month's monthly SSFC charges may not be booked yet). *Kept = freight − diesel − driver − fastag − tyre & maintenance − RTO & documents − other, before the yearly costs and the EMI.</p>
  </section>`);
  bindCharts(main());
}
boot().catch((err) => {
  console.error(err);
  renderCentered(`${logoHead()}${errorHtml(err)}`);
});
