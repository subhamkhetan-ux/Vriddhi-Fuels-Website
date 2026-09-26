// Vriddhi Ledger — the /ledger/ web app. Plain ES modules, no build step.
// The logic lives in the other modules (daybook, master, po, store); this
// file is the screens.

import { daybookPayload, parseDaybook, sheetRows } from './daybook.js';
import { demoSeed } from './demo.js';
import { extractMaster, readWorkbook } from './master.js';
import { allocate, billOrder, poKey } from './po.js';
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
    state.store = memoryStore(demoSeed());
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
  ['#/', 'Home'], ['#/import', 'Import'], ['#/pos', 'POs'], ['#/customers', 'Customers'], ['#/sales', 'Sales'],
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
    ${todo.length ? `<section class="card"><h3>Needs your attention</h3><div class="todos">${todo.join('')}</div></section>` : (empty ? '' : '<section class="card good-card"><b>All caught up.</b> Every bulk bill has a PO and every customer has a ledger.</section>')}
    ${groups.length ? `<section class="card"><h3>PO lists</h3><div class="grid">${groups.map(poCard).join('')}</div></section>` : ''}
    ${last ? `<p class="muted small">Last upload: ${last.kind === 'daybook' ? 'DayBook' : 'Master Ledger'} “${esc(last.file_name)}” · ${new Date(last.created_at).toLocaleString('en-IN')}${last.by_email ? ` · ${esc(last.by_email)}` : ''}</p>` : ''}`);
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
    : `${c.sales_new ?? 0} new bills · ${c.sales_updated ?? 0} refreshed · ${c.payments ?? 0} payments · ${c.pos_new ?? 0} new POs`;
  return `<tr><td>${esc(new Date(i.created_at).toLocaleString('en-IN'))}</td><td>${i.kind === 'daybook' ? 'DayBook' : 'Master Ledger'}</td><td>${esc(i.file_name)}</td><td>${esc(result)}</td></tr>`;
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

boot().catch((err) => {
  console.error(err);
  renderCentered(`<h1>Vriddhi <b>Ledger</b></h1>${errorHtml(err)}`);
});
