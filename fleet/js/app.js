// Shree Shyam Fleet — the /fleet/ web app. Plain ES modules, no build step.
// parse.js reads the Trip Register, analyse.js works out the figures, this
// file draws the screens (in the ledger app's look).

import {
  attention, byRoute, byVehicle, costBreakdown, dateIssues, dieselAmount, dieselLitres, dieselRecon, fleetStatus, fuel,
  inPeriod, monthly, ownExpenses, periods, routeOf, sourceOf, SOURCES, ssfcAccount, ssfcDeductions, totals, tripDays, urea, vehiclesOf,
} from './analyse.js';
import { bindCharts, groupedBars, legend, setChartWidth, signedBars, stackedBars } from './charts.js';
import { demoData } from './demo.js';
import { bookFromSheetJS, extractFleet } from './parse.js';
import { memoryStore, supabaseStore } from './store.js';
import {
  addMonths, dateYear, daysBetween, esc, fmtDate, indian, litres, localToday, longDate, money, monthLong, monthName, monthOf,
  plural, rupees, shortDate, shortVeh, tonnes,
} from './util.js';

const SUPABASE_JS = 'https://esm.sh/@supabase/supabase-js@2';
const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const BRAND = 'Shree Shyam <b>Fleet</b>';

const root = document.getElementById('app');
const state = {
  store: null, client: null, me: null, demo: false, data: null, meta: null, localOnly: false,
  period: 'fy', custom: null, ui: {},
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
    state.store = memoryStore(demoData(today()));
    return enter();
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return renderSetup();
  let createClient;
  try {
    ({ createClient } = await import(SUPABASE_JS));
  } catch {
    return renderCentered(`<h1>${BRAND}</h1><p>Couldn't load the sign-in library. Check the internet connection and reload.</p>`);
  }
  // same storage key as the ledger app: signed in there = signed in here
  state.client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'vriddhi-ledger-auth' },
  });
  state.store = supabaseStore(state.client);
  state.client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') renderLogin(); });
  const { data } = await state.client.auth.getSession();
  if (!data || !data.session) return renderLogin();
  return enter();
}

function renderCentered(inner) {
  root.innerHTML = `<div class="center"><div class="card center-card">${inner}</div></div>`;
}

function renderSetup() {
  renderCentered(`
    <h1>${BRAND}</h1>
    <p>This app isn't connected to its database yet. It uses the ledger app's Supabase project — put that project's URL and publishable key in <code>fleet/config.js</code> (the same two values as <code>ledger/config.js</code>), then run <code>supabase/fleet-schema.sql</code> once in its SQL Editor.</p>
    <p><a class="btn" href="?demo">Try the demo</a> <span class="muted">— made-up data, nothing is saved.</span></p>
    ${localPickerHtml()}`);
  bindLocalPicker();
}

function renderLogin(message = '') {
  renderCentered(`
    <h1>${BRAND}</h1>
    <p class="muted small">Sign in with your ledger login.</p>
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
    startApp();
  }));
}

async function enter() {
  let me;
  try {
    me = await state.store.whoami();
  } catch (err) {
    if (err.code === 'NO_SCHEMA') {
      renderCentered(`<h1>${BRAND}</h1>
        <p>You're signed in, but the fleet tables aren't in the database yet. One-time setup: open the ledger's Supabase project → <b>SQL Editor</b>, paste all of <code>supabase/fleet-schema.sql</code> and press <b>Run</b>. Then reload this page.</p>
        ${localPickerHtml()}
        <p><button class="btn ghost" id="out">Sign out</button></p>`);
      bindLocalPicker();
    } else {
      renderCentered(`<h1>${BRAND}</h1>${errorHtml(err)}<p><button class="btn ghost" id="out">Sign out</button></p>`);
    }
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  state.me = me;
  if (!me.member) {
    renderCentered(`<h1>${BRAND}</h1>
      <p>You're signed in as <b>${esc(me.email)}</b>, but this login isn't on the ledger members list.</p>
      <p>The owner can allow it by running this once in the Supabase SQL Editor:</p>
      <pre class="code">select ledger_add_member('${esc(String(me.email).replace(/'/g, "''"))}');</pre>
      <p><button class="btn ghost" id="out">Sign out</button></p>`);
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  renderCentered(loadingHtml('Loading the Trip Register…'));
  try {
    const latest = await state.store.latest();
    if (latest) { state.data = latest.payload; state.meta = latest.meta; }
  } catch (err) {
    renderCentered(`<h1>${BRAND}</h1>${errorHtml(err)}<p><button class="btn ghost" id="out">Sign out</button></p>`);
    document.getElementById('out').addEventListener('click', signOut);
    return;
  }
  startApp();
}

function startApp() {
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
const TABS = [['#/', 'Home'], ['#/trips', 'Trips'], ['#/vehicles', 'Vehicles'], ['#/ssfc', 'SSFC'], ['#/diesel', 'Diesel'], ['#/upload', 'Upload']];

function renderShell() {
  root.innerHTML = `
    <header class="top">
      <a class="brand" href="#/">${BRAND}</a>
      ${state.demo ? '<span class="pill warn-pill" title="Nothing you do here is saved">Demo<span class="hide-sm"> · made-up data</span></span>' : ''}
      ${state.localOnly ? '<span class="pill info-pill" title="Read from a file on this device; not saved">This device only</span>' : ''}
      ${state.preview ? '<span class="pill info-pill" title="This file was opened but not saved">Preview · not saved</span>' : ''}
      <span class="spacer"></span>
      <a class="btn ghost small hide-sm" href="../ledger/">Ledger ↗</a>
      <span class="who">${esc(state.me ? state.me.email : '')}</span>
      <button class="btn ghost small" id="signout">${state.demo ? 'Leave demo' : state.client ? 'Sign out' : 'Close'}</button>
    </header>
    <nav class="tabs" aria-label="Sections">
      ${TABS.map(([href, name]) => `<a href="${href}" data-tab="${href}">${name}</a>`).join('')}
    </nav>
    <main id="main"></main>`;
  document.getElementById('signout').addEventListener('click', signOut);
}

const ROUTES = [
  [/^#?\/?$/, () => viewHome()],
  [/^#\/trips(?:\?(.*))?$/, (m) => viewTrips(new URLSearchParams(m[1] || ''))],
  [/^#\/trip\/(\d+)$/, (m) => viewTrip(Number(m[1]))],
  [/^#\/vehicles$/, () => viewVehicles()],
  [/^#\/vehicle\/([^/?]+)$/, (m) => viewVehicle(decodeURIComponent(m[1]))],
  [/^#\/ssfc$/, () => viewSsfc()],
  [/^#\/diesel$/, () => viewDiesel()],
  [/^#\/diesel\/([^/?]+)$/, (m) => viewDieselVehicle(decodeURIComponent(m[1]))],
  [/^#\/upload$/, () => viewUpload()],
];

async function route() {
  if (!main()) return;
  const hash = location.hash || '#/';
  const tabOf = (h) => {
    if (h.startsWith('#/trip')) return '#/trips';
    if (h.startsWith('#/vehicle')) return '#/vehicles';
    if (h.startsWith('#/diesel')) return '#/diesel';
    return h.split('?')[0];
  };
  const cur = tabOf(hash);
  document.querySelectorAll('.tabs a').forEach((a) => {
    const on = a.dataset.tab === '#/' ? cur === '#/' || cur === '' : cur === a.dataset.tab;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const hit = ROUTES.map(([re, fn]) => [hash.match(re), fn]).find(([m]) => m);
  setMain(loadingHtml());
  try {
    if (!state.data && !hash.startsWith('#/upload')) viewWelcome();
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
    <p><a class="btn" href="#/upload">Upload Trip Register</a></p></section>`);
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

const cache = new WeakMap();
function derived() {
  const d = state.data;
  let x = cache.get(d);
  if (!x) {
    x = { recon: dieselRecon(d), account: ssfcAccount(d.ssfc, today()), status: fleetStatus(d, today()), vehicles: vehiclesOf(d), issues: dateIssues(d, today()) };
    cache.set(d, x);
  }
  return x;
}
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
  const onTrip = status.filter((s) => s.state !== 'idle');
  const loaded = status.filter((s) => s.state === 'loaded');
  const empty = status.filter((s) => s.state === 'empty');
  const avgDays = onTrip.length ? onTrip.reduce((a, s) => a + s.days, 0) / onTrip.length : 0;
  setMain(`
    <section class="card greet">
      <h1 class="jsk${play ? ' play' : ''}"><span class="jsk-text">Jai Shree Krishna</span><img class="jsk-feather" src="assets/morpankh.png" alt=""></h1>
      <p class="greet-dates"><span>Today is <b>${esc(longDate(today()))}</b></span>
      <span>Trip Register updated until <b>${esc(d.latest ? dateYear(d.latest) : '—')}</b></span></p>
    </section>

    <section class="card">
      <div class="row-between"><h3>On the road now</h3><span class="muted small">${plural(status.length, 'vehicle')}</span></div>
      <div class="kpis live-kpis">
        <div class="kpi hero"><span class="lbl">On a trip</span><span class="val">${onTrip.length}<small> / ${status.length}</small></span><span class="sub">avg ${avgDays.toFixed(1)} days since start</span></div>
        <div class="kpi"><span class="lbl">Loaded · en route</span><span class="val">${loaded.length}</span><span class="sub">${esc(summarisePlaces(loaded.map((s) => s.trip.dest)))}</span></div>
        <div class="kpi"><span class="lbl">Empty · going to load</span><span class="val">${empty.length}</span><span class="sub">${esc(summarisePlaces(empty.map((s) => s.trip.port)))}</span></div>
        <div class="kpi"><span class="lbl">Idle</span><span class="val">${status.length - onTrip.length}</span><span class="sub">${esc(summarisePlaces(status.filter((s) => s.state === 'idle' && s.last).map((s) => s.last.dest)) || '—')}</span></div>
      </div>
      <div class="veh-grid">${status.map(vehTile).join('')}</div>
    </section>

    ${todo.length ? `<section class="card"><h3>Needs a look</h3><div class="todos">${todo.slice(0, 8).map((t) => `<a class="todo ${t.kind}" href="${t.href}">${esc(t.text)}</a>`).join('')}
      ${todo.length > 8 ? `<p class="muted small">…and ${todo.length - 8} more.</p>` : ''}</div></section>` : ''}

    ${account ? ssfcMiniHtml(account) : ''}

    <div id="dash"></div>
    ${state.meta ? `<p class="muted small">From “${esc(state.meta.file_name)}”${state.meta.created_at ? ` · uploaded ${new Date(state.meta.created_at).toLocaleString('en-IN')}` : ''}${state.meta.by_email ? ` · ${esc(state.meta.by_email)}` : ''}</p>` : ''}`);
  renderDashboard(document.getElementById('dash'));
}

function summarisePlaces(list) {
  const m = new Map();
  list.forEach((p) => m.set(p, (m.get(p) || 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${n} → ${p}`).join(' · ');
}

function vehTile(s) {
  const t = s.trip;
  const late = s.state !== 'idle' && s.days > 9;
  return `<a class="veh ${s.state}" href="#/vehicle/${encodeURIComponent(s.veh)}">
    <span class="veh-top"><b>${esc(shortVeh(s.veh))}</b><span class="veh-days${late ? ' late' : ''}">${s.days == null ? '' : s.state === 'idle' ? `${s.days}d idle` : `day ${s.days}`}</span></span>
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
  box.innerHTML = `
  <section class="card dash">
    <div class="row-between"><h2>Business</h2><span class="muted small">${esc(periodRange(p))}</span></div>
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
    </div>

    <h3 class="sub-h">Where every ₹100 of freight goes</h3>
    ${flowHtml(cost)}

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
      ${[['all', 'All'], ['road', 'On the road'], ['done', 'Unloaded'], ['short', 'Short weight'], ['loss', 'Loss before EMI'], ['check', `Dates to check${issues.length ? ` (${issues.length})` : ''}`]].map(([k, n]) => `<a class="chip${f === k ? ' on' : ''}" href="${link({ f: k })}">${n}</a>`).join('')}
    </div>
    <form class="row-form" id="trip-filter">
      <label>Vehicle <select name="v"><option value="">All vehicles</option>${vehicles.map((v) => `<option${v === veh ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label>Month loaded <select name="m"><option value="">All months</option>${months.map((m) => `<option value="${m}"${m === mon ? ' selected' : ''}>${monthLong(m)}</option>`).join('')}</select></label>
      <label>Route <select name="r"><option value="">All routes</option>${routes.map((r) => `<option${r === rt ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
      <label>Search <input name="q" type="search" value="${esc(q.get('q') || '')}" placeholder="Trip no, remarks…"></label>
    </form>
    <div class="sumline"><span><b>${tonnes(T.tonnes, 1)}</b> loaded</span><span><b>${money(T.bhada)}</b> freight</span><span><b>${money(T.ssfcNet)}</b> SSFC net</span><span><b class="${signed(T.income + T.emi)}">${money(T.income + T.emi)}</b> before EMI</span><span><b class="${signed(T.income)}">${money(T.income)}</b> net</span></div>
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

function tripRow(t, why) {
  const day = t.loadDate || t.start;
  const diff = t.diff ? `<span class="pill ${t.diff < -0.1 ? 'bad-pill' : t.diff < 0 ? 'warn-pill' : 'good-pill'}">${t.diff > 0 ? '+' : '−'}${Math.abs(t.diff).toFixed(2)}</span>` : '';
  return `<a class="trow${t.status !== 'done' ? ' open' : ''}" href="#/trip/${t.row}">
    <span class="s-date">${day ? `<b>${Number(day.slice(8))}</b><small>${shortDate(day).split(' ')[1]} ${day.slice(2, 4)}</small>` : '—'}</span>
    <span class="t-main"><b>${esc(t.trip)}</b> <span class="b-veh">${esc(t.veh)}</span>${t.status !== 'done' ? ` ${statusPill(t)}` : ''}${why ? ' <span class="pill bad-pill">check date</span>' : ''}
      <small>${esc(routeOf(t))}${t.remarks ? ` · ${esc(t.remarks)}` : ''}</small></span>
    <span class="r t-ton">${t.loadWt ? `${t.loadWt.toFixed(2)} T` : '—'} ${diff}</span>
    <span class="r t-fr">${t.bhada ? rupees(t.bhada) : '—'}</span>
    <span class="r t-net">${t.ssfcNet != null ? rupees(t.ssfcNet) : '—'}</span>
    <span class="r t-inc ${signed(t.income)}">${t.income != null ? rupees(t.income) : '—'}${t.emi ? '<small>incl. EMI</small>' : ''}</span></a>`;
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
    <div class="acct-top"><div class="acct-id"><span class="avatar">${esc(shortVeh(t.veh))}</span><div><h2>${esc(t.trip)}</h2><p class="muted">${vehLink(t.veh)} · ${esc(routeOf(t))}</p></div></div>${statusPill(t)}</div>
    ${why ? `<div class="todo warn" style="margin-top:12px">Check this trip in Excel: ${esc(why)}.</div>` : ''}
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
    ${t.remarks ? `<p class="remark">“${esc(t.remarks)}”</p>` : ''}
  </section>` : t.remarks ? `<section class="card"><p class="remark">“${esc(t.remarks)}”</p></section>` : ''}
  <section class="card"><h3>Diesel</h3>
    <div class="kpis">
      <div class="kpi"><span class="lbl">Issued</span><span class="val">${litres(dieselLitres(t))}</span><span class="sub">${money(dieselAmount(t))}</span></div>
      ${rec && rec.allotted != null ? `<div class="kpi"><span class="lbl">Allotted</span><span class="val">${litres(rec.allotted)}</span><span class="sub">${rec.base} base${rec.over ? ` + ${rec.over.toFixed(1)} overload` : ''}${rec.under ? ` − ${rec.under} underload` : ''}</span></div>
      <div class="kpi ${rec.balance < 0 ? 'warn' : ''}"><span class="lbl">This trip</span><span class="val ${signed(rec.balance)}">${rec.balance > 0 ? '+' : ''}${litres(rec.balance)}</span><span class="sub">${rec.balance < 0 ? 'more issued than allotted' : rec.balance > 0 ? 'less issued than allotted' : 'exactly as allotted'}</span></div>` : ''}
    </div>
    ${fills.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>Pump</th><th>Where</th><th class="r">Litres</th><th class="r">₹/L</th><th class="r">Amount</th></tr></thead><tbody>
      ${fills.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${esc(h.source)}</td><td>${esc(h.location)}</td><td class="r">${indian(h.qty, 2)}</td><td class="r">${h.rsp.toFixed(2)}</td><td class="r">${rupees(h.amount)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No HSD fills tagged to this trip in HSD Data.</p>'}
    ${ureas.length ? `<p class="small muted">Urea: ${ureas.map((u) => `${fmtDate(u.date)} ${indian(u.qty, 1)} L from ${esc(u.from)} (${rupees(u.amount)})`).join(' · ')}</p>` : ''}
  </section>`);
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
    ${periodHtml()}
    <div class="co-grid">
      ${rows.map((r) => {
    const s = status.find((x) => x.veh === r.veh);
    const dl = recon.vehicles.find((x) => x.veh === r.veh);
    return `<a class="co-card veh-card ${s.state}" href="#/vehicle/${encodeURIComponent(r.veh)}">
        <div class="co-head"><span class="avatar sm">${esc(shortVeh(r.veh))}</span><b>${esc(r.veh)}</b></div>
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
  setMain(`<section class="card">
    <a class="muted small" href="#/vehicles">← Vehicles</a>
    <div class="acct-top"><div class="acct-id"><span class="avatar">${esc(shortVeh(veh))}</span><div><h2>${esc(veh)}</h2><p class="muted">${plural(mine.length, 'trip')} in the register${emiNow ? ` · EMI ${rupees(emiNow)} a month` : ''}</p></div></div></div>
    <div class="live-line ${s.state}"><span class="veh-state"><i></i>${esc(s.long)}</span>${s.trip ? ` · <a href="#/trip/${s.trip.row}">${esc(s.trip.trip)}</a> · ${s.state === 'idle' ? '' : `day ${s.days}`}${s.trip.loadWt ? ` · ${s.trip.loadWt.toFixed(2)} T` : ''}` : s.days != null ? ` · ${s.days} days` : ''}</div>
    ${periodHtml()}
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
      <div class="kpi"><span class="lbl">Weight short</span><span class="val">${tonnes(-T.short)}</span><span class="sub">${plural(T.shortTrips, 'trip')}</span></div>
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
    <div class="acct-top"><div class="acct-id"><span class="avatar">SS</span><div><h2>${esc(a.party.name)}</h2><p class="muted">${a.party.gstin ? `GSTIN ${esc(a.party.gstin)} · ` : ''}bulker hiring account</p></div></div></div>
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
  setMain(`<section class="card">
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

  <section class="card">
    <div class="row-between"><h3>Diesel recon · allotted vs issued</h3><span class="muted small">since ${recon.since ? dateYear(recon.since) : '—'}</span></div>
    <p class="muted small">Each trip is allotted its route's diesel (Rates sheet) + ${recon.rules.perTonne} L a tonne over ${recon.rules.overloadOver} T gross − underload; issued = SSFC litres + own trip litres. Below zero = more diesel went in than allotted.</p>
    ${check != null ? `<p class="small ${check ? 'good-text' : 'warn-text'}">${check ? '✓ Same as the Diesel Recon sheet' : `Diesel Recon sheet shows ${litres(d.checks.reconTotal)}`}</p>` : ''}
    <div class="recon">${[...recon.vehicles].sort((a, b) => a.balance - b.balance).map((v) => `<a class="recon-row" href="#/diesel/${encodeURIComponent(v.veh)}">
      <b>${esc(v.veh)}</b>
      <span class="div-bar"><span class="neg">${v.balance < 0 ? `<i style="width:${((-v.balance / maxAbs) * 100).toFixed(1)}%"></i>` : ''}</span><span class="pos">${v.balance > 0 ? `<i style="width:${((v.balance / maxAbs) * 100).toFixed(1)}%"></i>` : ''}</span></span>
      <span class="r"><b class="${signed(v.balance)}">${v.balance > 0 ? '+' : ''}${indian(v.balance, 1)} L</b><small>${v.balance < 0 ? 'short' : v.balance > 0 ? 'surplus' : 'nil'}</small></span></a>`).join('')}</div>
  </section>

  <section class="card"><h3>Urea (DEF) · ${esc(periodRange(p))}</h3>
    ${U.vendors.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Bought from</th><th class="r">Times</th><th class="r">Litres</th><th class="r">Amount</th></tr></thead><tbody>
      ${U.vendors.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.buys}</td><td class="r">${indian(x.litres, 1)}</td><td class="r">${rupees(x.amount)}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">Urea bought from SS Freight Carrier is theirs to settle; the rest is in each trip's “Own Urea”.</p>` : '<p class="muted">No urea in this period.</p>'}
  </section>`);
  bindPeriod(main());
  bindCharts(main());
}

async function viewDieselVehicle(veh) {
  const { recon } = derived();
  const v = recon.vehicles.find((x) => x.veh === veh);
  if (!v) { setMain('<section class="card"><p>No such vehicle.</p></section>'); return; }
  setChartWidth(main().clientWidth - 38);
  const list = v.list.filter((x) => x.allotted != null);
  setMain(`<section class="card">
    <a class="muted small" href="#/diesel">← Diesel</a>
    <div class="acct-top"><div class="acct-id"><span class="avatar">${esc(shortVeh(veh))}</span><div><h2>${esc(veh)} · diesel recon</h2><p class="muted">${plural(list.length, 'trip')} since ${recon.since ? dateYear(recon.since) : '—'}</p></div></div></div>
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

async function viewUpload() {
  let history = [];
  if (!state.localOnly && state.store) history = (await guard(() => state.store.uploads(10))) || [];
  setMain(`<section class="card">
    <h2>Upload Trip Register</h2>
    <p class="muted">Choose the workbook you keep in Excel (<code>Trip_Register.xlsm</code>). Save it in Excel first so its formulas are up to date. It's read in this browser; ${state.localOnly ? 'nothing is saved (this device only).' : 'only the figures the app needs are saved, for your ledger logins only.'}</p>
    <label class="file"><input type="file" id="file" accept=".xlsm,.xlsx,.xls"><span class="btn">Choose Trip Register…</span></label>
    <div id="preview" class="preview"></div>
  </section>
  ${history.length ? `<section class="card"><h3>Earlier uploads</h3><div class="table-wrap"><table class="compact"><thead><tr><th>When</th><th>File</th><th class="r">Trips</th><th>Up to</th><th>By</th></tr></thead><tbody>
    ${history.map((h) => `<tr><td>${new Date(h.created_at).toLocaleString('en-IN')}</td><td>${esc(h.file_name)}</td><td class="r">${h.counts && h.counts.trips || ''}</td><td>${h.latest_trip ? fmtDate(h.latest_trip) : ''}</td><td class="small">${esc(h.by_email)}</td></tr>`).join('')}
  </tbody></table></div></section>` : ''}`);
  const input = document.getElementById('file');
  input.addEventListener('change', () => guard(async () => {
    const file = input.files[0];
    if (!file) return;
    const box = document.getElementById('preview');
    box.innerHTML = loadingHtml('Reading the workbook…');
    let data;
    try {
      data = await readFile(file);
    } catch (err) {
      box.innerHTML = errorHtml(err);
      return;
    }
    box.innerHTML = previewHtml(data);
    document.getElementById('save')?.addEventListener('click', (e) => guard(async () => {
      e.target.disabled = true;
      e.target.textContent = 'Saving…';
      const meta = await state.store.save(file.name, data);
      state.data = data;
      state.meta = meta;
      if (state.preview) { state.preview = false; renderShell(); }
      toast(`Saved — ${plural(data.trips.length, 'trip')} up to ${fmtDate(data.latest)}.`);
      location.hash = '#/';
    }).finally(() => { e.target.disabled = false; }));
    document.getElementById('view-only')?.addEventListener('click', () => {
      state.data = data;
      state.meta = { file_name: file.name, created_at: new Date().toISOString(), by_email: '' };
      if (!state.localOnly) state.preview = true;
      renderShell();
      if (location.hash === '#/') route(); else location.hash = '#/';
    });
  }));
}

function previewHtml(data) {
  const acc = ssfcAccount(data.ssfc, today());
  const rec = dieselRecon(data);
  const odd = dateIssues(data, today());
  const vehicles = vehiclesOf(data);
  const ok = (good, text) => `<li class="${good ? 'good-text' : 'warn-text'}">${good ? '✓' : '!'} ${text}</li>`;
  const checks = [];
  if (acc && data.checks.ssfcTotal != null) checks.push(ok(Math.abs(acc.total - data.checks.ssfcTotal) < 1, `SSFC outstanding ${rupees(acc.total)} ${Math.abs(acc.total - data.checks.ssfcTotal) < 1 ? 'matches the Ledger sheet' : `— the Ledger sheet shows ${rupees(data.checks.ssfcTotal)}`}`));
  if (data.checks.reconTotal != null) checks.push(ok(Math.abs(rec.total - data.checks.reconTotal) < 0.05, `Diesel recon ${indian(rec.total, 2)} L ${Math.abs(rec.total - data.checks.reconTotal) < 0.05 ? 'matches the Diesel Recon sheet' : `— the sheet shows ${indian(data.checks.reconTotal, 2)} L`}`));
  if (odd.length) checks.push(ok(false, `${plural(odd.length, 'trip')} with dates that look mistyped: ${odd.slice(0, 4).map((x) => `${esc(x.t.trip)} ${esc(shortVeh(x.t.veh))}`).join(', ')}${odd.length > 4 ? '…' : ''} (shown under Trips → Dates to check)`));
  for (const w of data.warnings) checks.push(ok(false, esc(w)));
  const canSave = state.store && !state.localOnly;
  return `<div class="card good-card">
    <b>${esc(data.fileName)}</b>
    <div class="stats">
      <div><span class="num">${data.trips.length}</span><span class="lbl">trips · ${vehicles.length} vehicles</span></div>
      <div><span class="num">${fmtDate(data.latest)}</span><span class="lbl">latest trip</span></div>
      <div><span class="num">${data.hsd.length}</span><span class="lbl">HSD fills</span></div>
      <div><span class="num">${data.urea.length}</span><span class="lbl">urea entries</span></div>
      <div><span class="num">${data.ssfc ? data.ssfc.rows.length : 0}</span><span class="lbl">SSFC ledger rows</span></div>
    </div>
    ${checks.length ? `<ul class="checks">${checks.join('')}</ul>` : ''}
    <div class="actions">
      ${canSave ? '<button class="btn" id="save">Save — replace the app\'s data</button>' : ''}
      <button class="btn ghost" id="view-only">${canSave ? 'Just look, don\'t save' : 'Open'}</button>
    </div></div>`;
}

boot().catch((err) => {
  console.error(err);
  renderCentered(`<h1>${BRAND}</h1>${errorHtml(err)}`);
});
