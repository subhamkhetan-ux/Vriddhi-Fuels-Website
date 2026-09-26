// Vriddhi Ledger — the /ledger/ web app. Plain ES modules, no build step.
// The logic lives in the other modules (daybook, master, po, store); this
// file is the screens.

import { normalizeCompany, slipBundles, tankerBundles } from './bills.js';
import { daybookPayload, parseDaybook, sheetRows } from './daybook.js';
import { demoSeed } from './demo.js';
import { fromQueue } from './payin.js';
import {
  barChart, bindCharts, dailyVolumeChart, legend, litres, money, monthlyChart, monthName, rspChart, SERIES, setChartWidth, shortDate,
} from './charts.js';
import { analyse, FUELS, periods, PRODUCT_NAME, shortGroup } from './dash.js';
import { extractMaster, readWorkbook } from './master.js';
import { allocate, billOrder, poKey } from './po.js';
import {
  A4, A5, download, inkBox, jpegFromSvg, pdfFromSvgs, slipSvg, statementFontCss, tankerBillSvg, toDataUrl, zipBlob,
} from './render.js';
import { billStatementSvgs, dailySummarySvg, DEFAULT_LAYOUT, ledgerSvg, PAGE, PAGE_PT } from './statement-svg.js';
import {
  bulkRows, cellText, COLUMN_HEAD, DEFAULT_BULK_WIDTHS, isNegative, xlDate, xlRupee,
} from './account.js';
import {
  addDays, buildStatements, ddmmyy, defaultMonth, firstWord, indAuto, ledgerRows, monthEnd, monthLabel, monthStart, rupeeAuto,
  shareBatches,
} from './statements.js';
import { memoryStore, supabaseStore } from './store.js';
import { billKey, fmtDate, fmtLitres, fmtMoney, normKey, suggestLedgerName } from './util.js';

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
    const seed = demoSeed();
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
}

async function signOut() {
  if (state.client) await state.client.auth.signOut();
  else location.href = location.pathname;
}

// ---------------------------------------------------------------------------
// shell + routing
// ---------------------------------------------------------------------------
const TABS = [
  ['#/', 'Home'], ['#/import', 'Import'], ['#/bills', 'Bills'], ['#/statements', 'Statements'], ['#/payments', 'Payments'], ['#/pos', 'POs'],
  ['#/customers', 'Customers'], ['#/sales', 'Sales'],
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
    <main id="main"></main>`;
  document.getElementById('signout').addEventListener('click', signOut);
}

const ROUTES = [
  [/^#?\/?$/, () => viewHome()],
  [/^#\/import$/, () => viewImport()],
  [/^#\/pos$/, () => viewPos()],
  [/^#\/pos\/(.+)$/, (m) => viewPoGroup(decodeURIComponent(m[1]))],
  [/^#\/customers$/, () => viewCustomers()],
  [/^#\/sales(?:\/(\d{4}-\d{2}-\d{2}))?$/, (m) => viewSales(m[1] || null)],
  [/^#\/bills$/, () => viewBills()],
  [/^#\/statements$/, () => viewStatements()],
  [/^#\/payments$/, () => viewPayments()],
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
function poGroups(data) {
  return data.groups.filter((g) => g.kind !== 'group').map((g) => {
    const bills = data.bills.filter((b) => b.group === g.code).sort(billOrder);
    const pos = data.pos.filter((p) => p.group_code === g.code);
    const res = allocate({ kind: g.kind, units: g.units, pos, bills });
    const rows = bills.map((b, i) => ({ ...b, po: res.bills[i].po, how: res.bills[i].how }));
    return {
      group: g,
      members: data.members.filter((m) => m.group === g.code),
      pos,
      rows,
      registers: res.registers,
      noPo: rows.filter((r) => r.how === 'no-po').length,
      needsUnit: rows.filter((r) => r.how === 'needs-unit').length,
    };
  });
}

const groupName = (g, members) => (members.length === 1 ? members[0].name : (g.title || g.code).split(' — ')[0]);

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
async function viewHome() {
  const [sum, pod] = await Promise.all([state.store.summary(), state.store.poData()]);
  const groups = poGroups(pod);
  const empty = !sum.last_sale_date;
  const todo = [];
  if (sum.needs_ledger) {
    todo.push(`<a class="todo" href="#/customers"><b>${plural(sum.needs_ledger, 'customer')}</b> need a ledger name</a>`);
  }
  for (const g of groups) {
    const name = esc(groupName(g.group, g.members));
    const href = `#/pos/${encodeURIComponent(g.group.code)}`;
    if (g.noPo) todo.push(`<a class="todo warn" href="${href}"><b>${name}:</b> ${plural(g.noPo, 'bill')} without a PO — add a new PO</a>`);
    if (g.needsUnit) todo.push(`<a class="todo warn" href="${href}"><b>${name}:</b> ${plural(g.needsUnit, 'bill')} need a unit</a>`);
  }
  const sales = sum.sales || {};
  const last = sum.last_import;
  setMain(`
    <section class="hero card">
      ${empty ? `
        <h2>Welcome</h2>
        <p>Start by uploading your <b>Master Ledger</b>: the app copies your sales, payments, customers and PO lists from it. Then import each day's Tally DayBook here instead of in Excel.</p>
        <p><a class="btn" href="#/import">Upload Master Ledger</a></p>` : `
        <p class="eyebrow">Sales in the app up to</p>
        <h2>${fmtDate(sum.last_sale_date)}</h2>
        <div class="stats">
          ${['HSD', 'MS', 'XG', 'OTHER'].filter((p) => sales[p]).map((p) => `
            <div><span class="num">${sales[p].bills.toLocaleString('en-IN')}</span><span class="lbl">${PRODUCT[p]} bills</span></div>`).join('')}
          <div><span class="num">${(sum.payments || 0).toLocaleString('en-IN')}</span><span class="lbl">payments</span></div>
        </div>
        <p class="actions"><a class="btn" href="#/import">Import sales (DayBook)</a> <a class="btn ghost" href="#/sales">See the latest day</a></p>`}
    </section>
    ${empty ? '' : `<div id="dash">${loadingHtml('Working out the figures…')}</div>`}
    ${todo.length ? `<section class="card"><h3>Needs your attention</h3><div class="todos">${todo.join('')}</div></section>` : (empty ? '' : '<section class="card good-card"><b>All caught up.</b> Every bulk bill has a PO and every customer has a ledger.</section>')}
    ${groups.length ? `<section class="card"><h3>PO lists</h3><div class="grid">${groups.map(poCard).join('')}</div></section>` : ''}
    ${last ? `<p class="muted small">Last upload: ${last.kind === 'daybook' ? 'DayBook' : 'Master Ledger'} “${esc(last.file_name)}” · ${new Date(last.created_at).toLocaleString('en-IN')}${last.by_email ? ` · ${esc(last.by_email)}` : ''}</p>` : ''}`);
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
// Home dashboard — the Master Ledger's analysis (Module14, Outstanding sheet)
// ---------------------------------------------------------------------------
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    <section class="card dash">
      <div class="row-between"><h2>Overview</h2>
        <div class="chips">${['month', 'last', 'd30', 'fy'].map((x) => `<button class="chip ${x === key ? 'on' : ''}" data-period="${x}">${per[x].label}</button>`).join('')}</div></div>
      <p class="muted small">${fmtDate(a.from)} – ${fmtDate(a.to)} · from the sales and payments in the app · earnings at ₹2.58/L diesel &amp; XtraGreen, ₹4/L petrol off the day's RSP</p>
      <div class="kpis">
        <div class="kpi hero"><span class="lbl">Earnings</span><span class="val">${money(k.earning)}</span><span class="sub">₹${k.perLitre.toFixed(2)} per litre</span></div>
        <div class="kpi"><span class="lbl">Sales</span><span class="val">${money(k.amount)}</span><span class="sub">${litres(k.qty)} · ${plural(k.customers, 'customer')}</span></div>
        <div class="kpi"><span class="lbl">Collections</span><span class="val">${money(k.collections)}</span><span class="sub">${k.amount ? `${Math.round((k.collections / k.amount) * 100)}% of sales` : '&nbsp;'}</span></div>
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

    <section class="card" id="dash-outstanding"></section>

    <section class="card">
      <h3>Bulk vs Retail</h3>
      <div class="seg">${['bulk', 'retail'].map((s) => {
    const x = a.segments[s];
    return `<div class="seg-row"><b>${s === 'bulk' ? 'Bulk' : 'Retail'}</b>
          <span>${litres(x.qty)}<small>${money(x.amount)}</small></span>
          <span>${money(x.earning)}<small>₹${x.qty ? (x.earning / x.qty).toFixed(2) : '0.00'}/L earned</small></span></div>`;
  }).join('')}</div>
      <p class="small muted share-label">Share of litres — Bulk / Retail</p>
      ${shareBar([{ name: 'Bulk', value: a.segments.bulk.qty, color: 'var(--s-sales)' }, { name: 'Retail', value: a.segments.retail.qty, color: 'var(--s-paid)' }])}
      ${legend([{ name: 'Bulk', color: 'var(--s-sales)' }, { name: 'Retail', color: 'var(--s-paid)' }])}
    </section>

    <section class="card" id="dash-months"></section>

    <section class="card">
      <h3>Day's RSP${a.days > 62 ? ' · last 62 days' : ''}</h3>
      <p class="small muted">The highest price billed each day — what the margin is worked from.</p>
      ${legend(FUELS.filter((x) => rspDays[x].some((d) => d.rsp != null)))}
      ${rspChart(rspDays)}
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

// '#/account/g/SMC_Bulk' or '#/account/c/<customer key>'
const acctHref = (e) => `#/account/${e.id.slice(0, 1)}/${encodeURIComponent(e.id.slice(2))}`;

function outstandingHtml(a, seg, all) {
  const list = a.due.filter((o) => seg === 'all' || o.kind === seg);
  const shown = all ? list : list.slice(0, 10);
  const total = list.reduce((s, o) => s + o.balance, 0);
  const max = Math.max(1, ...list.map((o) => o.balance));
  return `
    <div class="row-between"><h3>Outstanding today</h3><b class="total">${money(total, { exact: true })}</b></div>
    <div class="chips small-chips">${[['all', 'All'], ['retail', 'Retail'], ['bulk', 'Bulk']].map(([x, n]) => `<button class="chip ${x === seg ? 'on' : ''}" data-oseg="${x}">${n}</button>`).join('')}</div>
    ${shown.length ? `<ol class="rank">${shown.map((o, i) => `
      <li><a class="rank-row" href="${acctHref(o)}" title="Open the ledger"><span class="n">${i + 1}</span>
        <span class="who"><b>${esc(o.name)}</b> ${TAG[o.kind]}<span class="mini-track"><span class="mini owe" style="width:${Math.max(2, (o.balance / max) * 100)}%"></span></span></span>
        <span class="amt"><b>${money(o.balance, { exact: true })}</b><small>${Math.round((o.balance / (total || 1)) * 100)}% of the total ›</small></span></a></li>`).join('')}</ol>` : '<p class="muted">Nobody owes anything. ✓</p>'}
    ${list.length > 10 ? `<p><button class="btn ghost small" data-oall>${all ? 'Show top 10' : `Show all ${list.length}`}</button></p>` : ''}
    ${a.advance.length ? `<details><summary class="small">${plural(a.advance.length, 'customer')} paid in advance · ${money(-a.advance.reduce((s, o) => s + o.balance, 0), { exact: true })}</summary>
      <ul class="small">${a.advance.map((o) => `<li><a href="${acctHref(o)}">${esc(o.name)}</a> — ${money(-o.balance, { exact: true })}</li>`).join('')}</ul></details>` : ''}
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

async function renderDashboard(box) {
  const { per, data } = await dashboardData();
  const key = state.dashPeriod || 'month';
  const a = analyse(data, per[key]);
  setChartWidth(box.clientWidth - 38);                           // the card's inner width
  box.innerHTML = dashboardHtml(a, per, key);
  const fy = key === 'fy' ? a : analyse(data, per.fy);
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
  };
  paintCustomers();
  paintOutstanding();
  box.querySelector('#dash-months').innerHTML = monthsHtml(fy);
  box.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    state.dashPeriod = b.dataset.period;
    guard(() => renderDashboard(box));
  }));
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

// ---------------------------------------------------------------------------
// A customer's ledger, laid out like their sheet in the Master Ledger
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

async function viewAccount(type, id, month) {
  if (type === 'g') return viewBulkAccount(id);
  return viewRetailAccount(id, month);
}

async function viewBulkAccount(code) {
  const [data, pod] = await Promise.all([state.store.account(null, code, null, null), state.store.poData()]);
  const poById = new Map();
  const pg = poGroups(pod).find((x) => x.group.code === code);
  if (pg) pg.rows.forEach((r) => poById.set(r.id, r.po));
  const res = bulkRows(data, (sid) => poById.get(sid) || '');
  const g = data.group;
  const n = res.columns.length;
  const widths = (res.widths || DEFAULT_BULK_WIDTHS[res.kind]).slice(0, n).map(xlPx);
  const spacer = res.widths && res.widths[n] ? xlPx(res.widths[n]) : 60;
  const all = [...widths, spacer, xlPx(18), xlPx(18)];
  const name = shortGroup(g.code, g.title);
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
  setMain(`
    <section class="card">
      <p class="muted small"><a href="#/">← Home</a></p>
      <div class="row-between"><h2>${esc(name)} <span class="tag bulk">Bulk</span></h2>
        <div class="acct-bal"><span class="muted small">Balance</span><b class="${res.closing < 0 ? 'good-text' : ''}">${esc(money(res.closing, { exact: true }))}</b></div></div>
      <p class="muted small">The <b>${esc(g.code)}</b> sheet: ${plural(res.rows.filter((r) => !r.payment).length, 'bill')} and ${plural(res.rows.filter((r) => r.payment).length, 'payment')} since ${fmtDate(g.period_from || res.rows[0]?.date || '')} · members: ${data.members.map((m) => esc(m.name)).join(', ') || '—'}${res.widths ? '' : ' · <span class="warn-text">column widths come with the next Master Ledger upload</span>'}</p>
      ${sheetHtml(all, rows)}
    </section>`);
  bindSheet(main());
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
  const L = c.layout && Array.isArray(c.layout.cols) && c.layout.cols.length === 7 ? c.layout : DEFAULT_LAYOUT;
  const widths = L.cols.map(xlPx);
  const rowH = ptPx(Number(L.row) > 5 ? Number(L.row) : DEFAULT_LAYOUT.row);
  const headH = ptPx(Number(L.head) > 5 ? Number(L.head) : DEFAULT_LAYOUT.head);
  const period = `for The Month of  ${monthLabel(from)}`;
  const title = String(c.title || '').trim() || c.name;
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
  const first = data.first ? data.first.slice(0, 7) : ym;
  const prev = monthShift(ym, -1);
  const next = monthShift(ym, 1);
  setMain(`
    <section class="card">
      <p class="muted small"><a href="#/">← Home</a></p>
      <div class="row-between"><h2>${esc(c.name)} <span class="tag">Retail</span></h2>
        <div class="acct-bal"><span class="muted small">Balance ${ym === today.slice(0, 7) ? 'today' : `end of ${monthLabel(from)}`}</span><b>${esc(money(led.closing, { exact: true }))}</b></div></div>
      <div class="row-between month-nav">
        ${prev >= first ? `<a class="btn ghost small" href="#/account/c/${encodeURIComponent(key)}?m=${prev}">‹ ${monthLabel(`${prev}-01`)}</a>` : '<span></span>'}
        <b>${monthLabel(from)}</b>
        ${next <= today.slice(0, 7) ? `<a class="btn ghost small" href="#/account/c/${encodeURIComponent(key)}?m=${next}">${monthLabel(`${next}-01`)} ›</a>` : '<span></span>'}
      </div>
      <p class="muted small">The <b>${esc(c.ledger || c.name)}</b> sheet${L === DEFAULT_LAYOUT ? ' · <span class="warn-text">column widths come with the next Master Ledger upload</span>' : ''}</p>
      <div class="xl-retail">${sheetHtml(widths, rows)}</div>
      <p class="actions"><button class="btn small" data-acct="share">Share as picture</button><button class="btn ghost small" data-acct="pdf">PDF</button></p>
    </section>`);
  bindSheet(main());
  const svgOf = async () => ledgerSvg({
    title, subtitle: 'Ledger Account for Diesel', period, ...led, total: false, layout: c.layout,
  }, await statementImages());
  const base = `${firstWord(c.name)} Ledger ${monthLabel(from)}`;
  main().querySelector('[data-acct="share"]').addEventListener('click', (e) => guard(async () => {
    e.target.disabled = true;
    try {
      const blob = await jpegFromSvg(await svgOf(), PAGE);
      await shareOrSave([new File([blob], `${base}.jpeg`, { type: 'image/jpeg' })], `${base}.zip`);
    } finally { e.target.disabled = false; }
  }));
  main().querySelector('[data-acct="pdf"]').addEventListener('click', (e) => guard(async () => {
    e.target.disabled = true;
    try { download(await pdfFromSvgs([await svgOf()], PAGE_PT, { scale: 2.5 }), `${base}.pdf`); } finally { e.target.disabled = false; }
  }));
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
    ${g.noPo ? `<div class="warn-text">${plural(g.noPo, 'bill')} without a PO</div>` : ''}
    ${g.needsUnit ? `<div class="warn-text">${plural(g.needsUnit, 'bill')} need a unit</div>` : ''}
  </a>`;
}

// ---------------------------------------------------------------------------
// Import: Tally DayBook and Master Ledger
// ---------------------------------------------------------------------------
async function viewImport() {
  const imports = await state.store.imports(10);
  setMain(`
    <section class="card">
      <h2>Import sales — Tally DayBook</h2>
      <p class="muted">Same as the <b>Import Sales</b> button in Excel: HSD, MS and XG credit vouchers are added; bills already in the app are skipped.</p>
      <label class="file"><input type="file" id="daybook-file" accept=".xls,.xlsx,.xlsm,.csv"><span class="btn">Choose DayBook file</span></label>
      <div id="daybook-out"></div>
    </section>
    <section class="card" id="master">
      <h2>Upload Master Ledger</h2>
      <p class="muted">Copies sales, payments, customers, opening balances, the Bulk sheets' PO lists and what you typed against each bulk bill. The file is read on this device and isn't changed.</p>
      <label class="file"><input type="file" id="master-file" accept=".xlsm,.xlsx"><span class="btn ghost">Choose Master Ledger.xlsm</span></label>
      <div id="master-out"></div>
    </section>
    <section class="card">
      <h3>Recent uploads</h3>
      ${imports.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>What</th><th>File</th><th>Result</th></tr></thead>
        <tbody>${imports.map(importRow).join('')}</tbody></table></div>` : '<p class="muted">Nothing uploaded yet.</p>'}
    </section>`);
  document.getElementById('daybook-file').addEventListener('change', (e) => e.target.files[0] && daybookChosen(e.target.files[0], e.target));
  document.getElementById('master-file').addEventListener('change', (e) => e.target.files[0] && masterChosen(e.target.files[0], e.target));
}

function importRow(i) {
  const c = i.counts || {};
  const result = i.kind === 'daybook'
    ? `${Object.entries(c.inserted || {}).map(([p, n]) => `${n} ${p}`).join(', ') || 'no new bills'}${c.duplicates ? ` · ${c.duplicates} already there` : ''}`
    : i.kind === 'payments_app' ? `${c.payments ?? 0} payments added`
      : `${c.sales_new ?? 0} new bills · ${c.sales_updated ?? 0} refreshed · ${c.payments ?? 0} payments · ${c.pos_new ?? 0} new POs`;
  const what = { daybook: 'DayBook', payments_app: 'Payments app', master_ledger: 'Master Ledger' }[i.kind] || i.kind;
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
    const existing = new Set(await state.store.existingBills(rows.map(({ product, bill_no, sale_date }) => ({ product, bill_no, sale_date }))));
    const seen = new Set();
    const fresh = rows.filter((r) => {
      const k = billKey(r.product, r.sale_date, r.bill_no);
      if (existing.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const known = new Set((await state.store.customers()).map((c) => c.key));
    const newNames = [...new Map(fresh.filter((r) => !known.has(normKey(r.customer))).map((r) => [normKey(r.customer), r.customer])).values()];
    const count = (list, p) => list.filter((r) => r.product === p).length;
    out.innerHTML = `
      <div class="preview">
        <p><b>${esc(file.name)}</b> · ${parsed.from === parsed.to ? fmtDate(parsed.from) : `${fmtDate(parsed.from)} – ${fmtDate(parsed.to)}`}</p>
        <div class="table-wrap"><table class="compact">
          <thead><tr><th></th><th class="r">New</th><th class="r">Already in the app</th></tr></thead>
          <tbody>${['HSD', 'MS', 'XG'].map((p) => `<tr><td>${PRODUCT[p]}</td><td class="r"><b>${count(fresh, p)}</b></td><td class="r">${count(rows, p) - count(fresh, p)}</td></tr>`).join('')}</tbody>
        </table></div>
        ${newNames.length ? `<p class="warn-text">New customer${newNames.length > 1 ? 's' : ''}: ${newNames.map(esc).join(', ')} — you'll be asked for ledger names after the import.</p>` : ''}
        ${parsed.problems.length ? `<details open><summary class="warn-text">${plural(parsed.problems.length, 'row')} to check</summary><ul>${parsed.problems.map((p) => `<li>Row ${p.row}, bill ${esc(p.bill_no)}: ${esc(p.problem)}</li>`).join('')}</ul></details>` : ''}
        ${parsed.otherTypes.length ? `<p class="muted small">Skipped other vouchers: ${parsed.otherTypes.map((t) => `${esc(t.type)} (${t.count})`).join(', ')}.</p>` : ''}
        ${fresh.length ? `<details><summary>See the ${plural(fresh.length, 'new bill')}</summary>${salesTable(fresh.slice(0, 300))}${fresh.length > 300 ? `<p class="muted">…and ${fresh.length - 300} more.</p>` : ''}</details>` : ''}
        <p class="actions">
          <button class="btn" id="daybook-go" ${fresh.length ? '' : 'disabled'}>${fresh.length ? `Import ${plural(fresh.length, 'new bill')}` : 'Nothing new to import'}</button>
          <button class="btn ghost" id="daybook-cancel">Cancel</button>
        </p>
      </div>`;
    document.getElementById('daybook-cancel').addEventListener('click', () => { out.innerHTML = ''; input.value = ''; });
    const go = document.getElementById('daybook-go');
    go.addEventListener('click', () => guard(async () => {
      go.disabled = true;
      go.textContent = 'Importing…';
      const res = await state.store.importDaybook(file.name, rows);
      const added = Object.entries(res.inserted || {}).map(([p, n]) => `${n} ${PRODUCT[p]}`).join(', ') || 'nothing new';
      input.value = '';
      out.innerHTML = `<div class="card good-card"><b>Imported:</b> ${esc(added)}.${res.duplicates ? ` Skipped ${plural(res.duplicates, 'bill')} already in the app.` : ''}
        ${res.new_customers && res.new_customers.length ? `<p>New customer${res.new_customers.length > 1 ? 's' : ''}: ${res.new_customers.map(esc).join(', ')}. <a href="#/customers">Give ${res.new_customers.length > 1 ? 'them' : 'it'} a ledger name →</a></p>` : ''}
        <p><a href="#/sales/${esc(parsed.to)}">See ${fmtDate(parsed.to)} →</a> · <a href="#/pos">PO lists →</a></p></div>`;
      toast('Sales imported.');
    }).finally(() => { go.disabled = false; }));
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

async function masterChosen(file, input) {
  const out = document.getElementById('master-out');
  out.innerHTML = loadingHtml(`Reading ${file.name} — a big workbook can take a few seconds…`);
  await paint();
  try {
    const XLSX = await loadSheetJS();
    const wb = readWorkbook(XLSX, await file.arrayBuffer());
    const { payload, preview, warnings } = extractMaster(wb);
    const s = preview.sales;
    const span = (x) => (x.count ? `${x.count.toLocaleString('en-IN')} <span class="muted">(${fmtDate(x.from)} – ${fmtDate(x.to)})</span>` : '0');
    const checkLine = (c) => {
      if (!c) return '';
      if (!c.compared) return '<span class="muted">no auto POs to compare</span>';
      if (!c.mismatches.length) return `<span class="good-text">✓ same POs as Excel on all ${c.compared} bills</span>`;
      return `<span class="warn-text">${c.mismatches.length} of ${c.compared} bills differ from Excel</span>
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
        <details><summary>What an upload changes</summary>
          <ul class="small">
            <li>Sales, payments, opening balances and TDS / shortage / remarks are brought in line with the workbook.</li>
            <li>Ledger names, PO lists, and a bill's Unit or PO belong to the app after the first upload — later uploads only fill in blanks and add POs the app doesn't have.</li>
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
      out.innerHTML = `<div class="card good-card"><b>Done.</b> ${plural(res.sales_new, 'new bill')}, ${res.sales_updated} refreshed, ${plural(res.payments, 'payment')}, ${plural(res.customers_new, 'new customer')}, ${plural(res.pos_new, 'new PO')}, ${plural(res.opening, 'opening balance')}, ${plural(res.groups, 'bulk ledger')}.
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
  const filters = [['all', 'All'], ['no-po', 'No PO'], ...(units.length ? [['needs-unit', 'Needs unit']] : []), ['fixed', 'Typed PO'],
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
      ${g.noPo ? `<p class="warn-text">${plural(g.noPo, 'bill')} got no PO because no PO has enough litres left. Add a new PO below and they're assigned straight away.</p>` : ''}
      ${g.needsUnit ? `<p class="warn-text">${plural(g.needsUnit, 'bill')} need a unit before they can get a PO.</p>` : ''}
    </section>
    ${g.registers.map((r) => registerCard(g, r)).join('')}
    <section class="card">
      <h3>Add a PO</h3>
      <form id="po-add" class="row-form">
        <label>PO number <input name="po_no" required autocomplete="off"></label>
        <label>Allotted litres <input name="allotted" type="number" min="0" step="any" required inputmode="decimal"></label>
        ${units.length ? `<label>Unit <select name="unit">${units.map((u) => `<option>${esc(u)}</option>`).join('')}</select></label>` : ''}
        <button class="btn" type="submit">Add PO</button>
      </form>
      <p class="muted small">New POs go to the end of the list. Bills use POs in list order, so move a PO up to have it used first.</p>
    </section>
    <section class="card">
      <h3>Bills <span class="muted">(newest first)</span></h3>
      <p class="muted small">Diesel bills get a PO automatically. Petrol and XtraGreen bills keep the PO typed on the Bulk sheet, or the one you pick with <b>Change</b> — and those litres count against that PO.</p>
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
  main().querySelectorAll('select[data-unit]').forEach((sel) => sel.addEventListener('change', () => guard(async () => {
    await state.store.updateBill(Number(sel.dataset.unit), { unit: sel.value });
    await reload();
  })));
  main().querySelectorAll('[data-bill-po]').forEach((btn) => btn.addEventListener('click', () => editBillPo(btn, g, units, reload)));
}

function registerCard(g, r) {
  const pending = r.pos.filter((p) => p.status === 'Pending');
  return `<section class="card">
    <h3>${r.unit ? `${esc(r.unit)} — ` : ''}PO list <span class="muted">· ${pending.length ? `${plural(pending.length, 'open PO')}, ${fmtLitres(pending.reduce((a, p) => a + p.balance, 0))} L left` : 'nothing left'}</span></h3>
    ${r.pos.length ? `<div class="plist" role="table" aria-label="${r.unit ? `${esc(r.unit)} ` : ''}PO list">
      <div class="prow head" role="row"><span role="columnheader">#</span><span role="columnheader">PO number</span><span class="r" role="columnheader">Allotted</span><span class="r" role="columnheader">Used</span><span class="r" role="columnheader">Left</span><span role="columnheader">Status</span><span role="columnheader"><span class="sr">Actions</span></span></div>
      ${r.pos.map((p, i) => `<div class="prow" role="row" data-po-row="${p.id}">
        <span class="p-n" role="cell">${i + 1}</span>
        <span class="p-no" role="cell"><b>${esc(p.po_no)}</b></span>
        <span class="p-al r" role="cell"><span class="lbl-sm">Allotted </span>${fmtLitres(p.allotted)}</span>
        <span class="p-us r" role="cell"><span class="lbl-sm">Used </span>${fmtLitres(p.used)}</span>
        <span class="p-le r" role="cell"><span class="lbl-sm">Left </span><b>${fmtLitres(p.balance)}</b></span>
        <span class="p-st" role="cell"><span class="pill ${p.status === 'Pending' ? 'good-pill' : 'muted-pill'}">${p.status === 'Pending' ? 'Open' : 'Used up'}</span></span>
        <span class="p-act nowrap" role="cell">
          <button class="icon" title="Move up" aria-label="Move ${esc(p.po_no)} up" data-po-action="up" data-id="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon" title="Move down" aria-label="Move ${esc(p.po_no)} down" data-po-action="down" data-id="${p.id}" ${i === r.pos.length - 1 ? 'disabled' : ''}>↓</button>
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
  'no-po': ['no PO', 'bad-pill', 'No PO has enough litres left'],
  'needs-unit': ['needs unit', 'warn-pill', 'Pick a unit first'],
  'not-diesel': ['no PO', 'muted-pill', 'Petrol / XtraGreen bills only get a PO you pick with Change'],
};
const FUEL_TAG = { MS: 'Petrol', XG: 'XtraGreen' };

function billRow(b, g, units) {
  const [tag, cls, title] = HOW[b.how];
  return `<div class="bill" role="row">
    <span class="b-when" role="cell">${fmtDate(b.date)} · <b>${esc(b.bill_no)}</b>${FUEL_TAG[b.product] ? ` <span class="pill fuel-pill">${FUEL_TAG[b.product]}</span>` : ''}</span>
    <span class="b-veh" role="cell">${esc(b.vehicle)}</span>
    <span class="b-qty r" role="cell">${fmtLitres(b.qty)} L</span>
    ${units.length ? `<span class="b-unit" role="cell"><select data-unit="${b.id}" aria-label="Unit for bill ${esc(b.bill_no)}"><option value="">Unit —</option>${units.map((u) => `<option value="${esc(u)}" ${poKey(b.unit) === poKey(u) ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></span>` : ''}
    <span class="b-po" role="cell"><b>${esc(b.po) || '—'}</b> <span class="pill ${cls}" title="${esc(title)}">${tag}</span></span>
    <span class="b-act" role="cell"><button class="btn ghost small" data-bill-po="${b.id}" aria-label="Change the PO of bill ${esc(b.bill_no)}">Change</button></span>
  </div>`;
}

function editBillPo(btn, g, units, reload) {
  const b = g.rows.find((r) => r.id === Number(btn.dataset.billPo));
  const row = btn.closest('.bill');
  if (row.nextElementSibling && row.nextElementSibling.classList.contains('bill-editor')) return;
  const names = [...new Set(g.pos.map((p) => p.po_no))];
  const current = b.po_mode === 'fixed' ? b.po_fixed : '';
  row.insertAdjacentHTML('afterend', `<div class="bill-editor">
    <form class="stack" data-bill-form>
      <b>PO for bill ${esc(b.bill_no)} (${fmtLitres(b.qty)} L)</b>
      <label class="radio"><input type="radio" name="mode" value="auto" ${b.po_mode !== 'fixed' ? 'checked' : ''}> ${b.product && b.product !== 'HSD' ? 'Automatic — petrol / XtraGreen bills get no PO automatically' : 'Automatic — first PO with enough litres left'}</label>
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
  const [tanker, customers, stamp] = await Promise.all([state.store.tankerList(), state.store.customers(), state.store.setting('slip_stamp')]);
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
  const [sales, header, stamp] = await Promise.all([state.store.salesRange(from, to), state.store.setting('slip_header'), state.store.setting('slip_stamp')]);
  const res = slipBundles({ sales, from, to, filter });
  const range = `${rangeName(from, to)}${filter ? ` · ${esc(filter)}` : ''}`;
  if (!res.bills) {
    out.innerHTML = `<p class="warn-text">No sales bills for ${range}.${filter ? ' Check the spelling of the customer name.' : ''}</p>`;
    return;
  }
  const h = header || DEFAULT_SLIP_HEADER;
  const pages = (b) => b.bills.map((x) => slipSvg(x, h, stamp ? stamp.data_url : ''));
  renderBundles(out, {
    summary: `<b>${plural(res.bills, 'bill')}</b> in <b>${plural(res.bundles.length, 'PDF')}</b> · ${range}`,
    extra: header ? '' : '<p class="muted small">The slip heading comes from the HSD Bill sheet — upload the Master Ledger to bring in yours.</p>',
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

// Print only these pages (the browser's "Save as PDF" works too).
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
