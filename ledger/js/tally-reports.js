// Tally viewer screens for the company's financials (tally-fin.js), the
// Ledger app vs Tally balances (tally-recon.js) and the stock bought / sold
// (tally-stock.js). Pure — strings in, strings out; app.js binds them.

import { barChart, legend, litres, money, monthlyChart, monthName, shortDate } from './charts.js';
import { CLASS_NAME } from './tally-fin.js';
import { fmtDate } from './util.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = one + 's') => `${Number(n).toLocaleString('en-IN')} ${n === 1 ? one : many}`;
const exact = (n) => money(n, { exact: true });
const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);
const drcr = (n) => (Math.abs(n) < 0.005 ? '₹0' : `${exact(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`);
const qty = (n, d = 2) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: d });

// ---------------------------------------------------------------------------
// the views' tabs
// ---------------------------------------------------------------------------
export const TALLY_VIEWS = [['', 'Insights'], ['fin', 'Financials'], ['recon', 'Ledger vs Tally'], ['stock', 'Purchases & stock']];
export function viewTabsHtml(view) {
  return `<div class="chips view-chips">${TALLY_VIEWS.map(([k, n]) => `<a class="chip ${k === view ? 'on' : ''}" href="#/tally${k ? `/${k}` : ''}">${n}</a>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// financials
// ---------------------------------------------------------------------------
export function finHtml(f, { closingStock = '', allExpenses = false } = {}) {
  const p = f.pl;
  const gross = p.gross ?? p.beforeStock;
  const r = f.ratios;
  const row = (label, v, { sub = false, strong = false, sign = '' } = {}) => `<tr class="${strong ? 'pl-total' : ''}${sub ? ' pl-sub' : ''}">
    <td>${label}</td><td class="r">${sign}${exact(v)}</td><td class="r muted">${p.sales ? pct(v / p.sales) : ''}</td></tr>`;
  const expenses = allExpenses ? f.expenses : f.expenses.slice(0, 12);
  const expTotal = f.expenses.reduce((s, l) => s + l.amount, 0) || 1;
  const nMonths = Math.max(1, f.months.length);
  const lists = (title, list, val, { note = '' } = {}) => (list.length ? `<h3 class="sub-h">${title}</h3>${note}
    <div class="table-wrap"><table class="compact"><tbody>${list.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${val(l)}</td></tr>`).join('')}</tbody></table></div>` : '');
  return `
    <section class="card">
      <h2>Financials</h2>
      <p class="muted small">${fmtDate(f.from)} – ${fmtDate(f.to)} · ${f.exact ? 'grouped as in Tally (from the masters in the file)' : '<b class="warn-text">estimated</b> — the file has no masters, so ledgers are grouped by their names. Add the All Masters export (Gateway → Export → Masters) for exact figures.'}</p>
      <div class="kpis">
        <div class="kpi hero"><span class="lbl">Net profit${p.withStock ? '' : ' (before stock)'}</span><span class="val">${money(p.net)}</span><span class="sub">${pct(r.netMargin)} of sales</span></div>
        <div class="kpi"><span class="lbl">Sales</span><span class="val">${money(p.sales)}</span><span class="sub">${p.directIncome ? `+ ${money(p.directIncome)} direct income` : 'all sales accounts'}</span></div>
        <div class="kpi"><span class="lbl">Purchases</span><span class="val">${money(p.purchases)}</span><span class="sub">${pct(p.sales ? p.purchases / p.sales : null)} of sales</span></div>
        <div class="kpi"><span class="lbl">Gross profit${p.withStock ? '' : ' (before stock)'}</span><span class="val">${money(gross)}</span><span class="sub">${pct(r.grossMargin)} margin</span></div>
        <div class="kpi"><span class="lbl">Expenses</span><span class="val">${money(p.directExpense + p.indirectExpense)}</span><span class="sub">${pct(r.expenseRatio)} of sales</span></div>
        <div class="kpi"><span class="lbl">Cash &amp; bank</span><span class="val">${money(f.bs.liquid)}</span><span class="sub">on ${shortDate(f.to)}</span></div>
        <div class="kpi warn"><span class="lbl">Receivable</span><span class="val">${money(f.bs.receivable)}</span><span class="sub">${plural(f.debtorsCount, 'debtor')}${r.debtorDays != null ? ` · ${Math.round(r.debtorDays)} days of sales` : ''}</span></div>
        <div class="kpi"><span class="lbl">Payable</span><span class="val">${money(f.bs.payable)}</span><span class="sub">${r.creditorDays != null ? `${Math.round(r.creditorDays)} days of purchases` : 'to suppliers'}</span></div>
      </div>
    </section>

    <section class="card">
      <h3>Profit &amp; loss</h3>
      <div class="table-wrap"><table class="compact pl"><thead><tr><th></th><th class="r">Amount</th><th class="r">% of sales</th></tr></thead><tbody>
        ${row('Sales', p.sales)}
        ${p.directIncome ? row('Direct income', p.directIncome, { sign: '+ ' }) : ''}
        ${row('Purchases', p.purchases, { sign: '− ' })}
        ${p.directExpense ? row('Direct expenses', p.directExpense, { sign: '− ' }) : ''}
        ${p.withStock ? `${row('Opening stock', p.openingStock, { sign: '− ' })}${row('Closing stock', p.closingStock, { sign: '+ ' })}` : ''}
        ${row(p.withStock ? 'Gross profit' : 'Gross profit before stock', gross, { strong: true })}
        ${p.indirectIncome ? row('Indirect income', p.indirectIncome, { sign: '+ ' }) : ''}
        ${row('Indirect expenses', p.indirectExpense, { sign: '− ' })}
        ${row(p.withStock ? 'Net profit' : 'Net profit before stock', p.net, { strong: true })}
      </tbody></table></div>
      <form class="custom-range" id="fin-stock">
        <label>Closing stock on ${shortDate(f.to)} (₹) <input type="number" name="stock" min="0" step="0.01" inputmode="decimal" value="${esc(closingStock)}" placeholder="from Tally's Stock Summary"></label>
        <button class="btn small" type="submit">${p.withStock ? 'Update' : 'Add stock'}</button>
        ${p.withStock ? '<button class="btn ghost small" type="button" data-fin-nostock>Clear</button>' : ''}
      </form>
      <p class="small muted">${p.openingStock != null ? `Opening stock ${exact(p.openingStock)} (from the masters). ` : ''}The file doesn't carry the closing stock — Tally values it from the inventory. Type it from Tally's Stock Summary to see the true gross profit${p.openingStock == null ? ' (needs a period starting on 1 April)' : ''}.</p>
    </section>

    <section class="card">
      <h3>Month by month</h3>
      ${legend([{ name: 'Sales', color: 'var(--s-sales)' }, { name: 'Purchases', color: 'var(--s-paid)' }])}
      ${monthlyChart(p.monthly.map((m) => ({ month: m.month, amount: m.sales, paid: m.purchases, earning: m.result })), { names: ['Sales', 'Purchases', 'Result before stock'] })}
      <div class="table-wrap"><table class="compact"><thead><tr><th>Month</th><th class="r">Sales</th><th class="r">Purchases</th><th class="r">Expenses</th><th class="r">Other income</th><th class="r">Result*</th><th class="r">Money in</th><th class="r">Money out</th><th class="r">Cash &amp; bank</th></tr></thead>
        <tbody>${p.monthly.map((m) => `<tr><td>${monthName(m.month)}</td><td class="r">${money(m.sales)}</td><td class="r">${money(m.purchases)}</td><td class="r">${money(m.expenses)}</td>
          <td class="r">${m.income ? money(m.income) : ''}</td><td class="r ${m.result < 0 ? 'bad-text' : ''}">${money(m.result)}</td>
          <td class="r good-text">${money(m.cashIn)}</td><td class="r">${money(m.cashOut)}</td><td class="r"><b>${money(m.liquid)}</b></td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">* Sales + income − purchases − expenses, before the change in stock. Money in / out: into and out of cash and bank, not counting transfers between them.</p>
      <h3 class="sub-h">Cash &amp; bank at each month end</h3>
      ${barChart(p.monthly.map((m) => ({ label: monthName(m.month), value: Math.max(0, m.liquid), tip: `<b>${monthName(m.month)}</b><br>Cash &amp; bank ${exact(m.liquid)}<br>In ${money(m.cashIn)} · out ${money(m.cashOut)}` })), { label: 'Cash and bank at month end', color: 'var(--s-hsd)', h: 150 })}
    </section>

    <section class="card">
      <div class="row-between"><h3>Expenses</h3><b class="total">${exact(p.directExpense + p.indirectExpense)}</b></div>
      ${f.expenses.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Ledger</th><th>Group</th><th class="r">Amount</th><th class="r">Share</th><th class="r">A month</th></tr></thead>
        <tbody>${expenses.map((l) => `<tr><td>${esc(l.name)}</td><td class="small muted">${esc(l.group || CLASS_NAME[l.cls])}</td><td class="r">${exact(l.amount)}</td>
          <td class="r"><span class="bar-cell"><i style="width:${Math.max(2, (l.amount / expTotal) * 100)}%"></i></span>${pct(l.amount / expTotal)}</td><td class="r muted">${money(l.amount / nMonths)}</td></tr>`).join('')}</tbody></table></div>
        ${f.expenses.length > 12 ? `<p><button class="btn ghost small" data-fin-allexp>${allExpenses ? 'Show top 12' : `Show all ${f.expenses.length}`}</button></p>` : ''}` : '<p class="muted">No expenses in these dates.</p>'}
      ${lists('Income', f.incomes, (l) => exact(l.amount))}
      ${lists('Sales accounts', f.salesLedgers, (l) => exact(l.amount))}
      ${lists('Purchase accounts', f.purchaseLedgers, (l) => exact(l.amount))}
    </section>

    <section class="card">
      <h3>Balance sheet on ${fmtDate(f.to)}</h3>
      <div class="bs-grid">
        <div><h3 class="sub-h">What the firm has</h3><table class="compact"><tbody>
          ${[['Cash', f.bs.cash], ['Bank', f.bs.bank], ['Receivable from customers', f.bs.receivable], ['Advances to suppliers', f.bs.advancesToSuppliers],
    ['Other current assets', f.bs.currentAssets - f.bs.cash - f.bs.bank - f.bs.receivable - f.bs.advancesToSuppliers], ['Fixed assets', f.bs.fixedAssets], ['Investments', f.bs.investments]]
    .filter(([, v]) => Math.abs(v) >= 0.5).map(([n, v]) => `<tr><td>${n}</td><td class="r">${exact(v)}</td></tr>`).join('')}</tbody></table></div>
        <div><h3 class="sub-h">What it owes</h3><table class="compact"><tbody>
          ${[['Payable to suppliers', f.bs.payable], ['Advances from customers', f.bs.advancesFromCustomers], ['Duties & taxes payable', f.bs.duties],
    ['Other current liabilities', f.bs.currentLiabilities - f.bs.payable - f.bs.advancesFromCustomers - f.bs.duties], ['Bank OD', f.bs.bankOd], ['Loans', f.bs.loans], ['Capital & reserves', f.bs.capital]]
    .filter(([, v]) => Math.abs(v) >= 0.5).map(([n, v]) => `<tr><td>${esc(n)}</td><td class="r">${exact(v)}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="kpis">
        <div class="kpi"><span class="lbl">Working capital</span><span class="val">${money(f.bs.workingCapital)}</span><span class="sub">current assets − current liabilities</span></div>
        <div class="kpi"><span class="lbl">Current ratio</span><span class="val">${r.currentRatio != null ? r.currentRatio.toFixed(2) : '—'}</span><span class="sub">current assets ÷ liabilities</span></div>
        <div class="kpi"><span class="lbl">Collected</span><span class="val">${pct(r.collection)}</span><span class="sub">of sales received from debtors</span></div>
      </div>
      <p class="small muted">Balances as the vouchers leave them; profit for the period isn't moved into capital (as Tally's balance sheet shows it separately).</p>
    </section>

    <section class="card">
      <h3>Cash &amp; bank accounts</h3>
      ${f.liquidList.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Account</th><th class="r">Opening</th><th class="r">In</th><th class="r">Out</th><th class="r">Closing</th></tr></thead>
        <tbody>${f.liquidList.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${drcr(l.openAtFrom)}</td><td class="r good-text">${exact(l.dr)}</td><td class="r">${exact(l.cr)}</td><td class="r"><b>${drcr(l.closing)}</b></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No cash or bank ledgers found.</p>'}
      <div class="bs-grid">
        <div>${lists('Top debtors', f.topDebtors.slice(0, 10), (l) => exact(l.closing))}</div>
        <div>${lists('Top creditors', f.topCreditors.slice(0, 10), (l) => exact(-l.closing))}</div>
      </div>
      ${lists('Duties & taxes', f.duties, (l) => `${drcr(l.closing)} <small class="muted">${l.closing < 0 ? 'payable' : 'to claim'}</small>`)}
    </section>

    <section class="card">
      <div class="row-between"><h3>Checks</h3><button class="btn ghost small" data-fin-trial>Download trial balance (Excel)</button></div>
      <ul class="checks-list">
        <li class="${Math.abs(f.checks.trial.diff) < 1 ? 'good-text' : 'warn-text'}">Trial balance: Dr ${exact(f.checks.trial.dr)} · Cr ${exact(f.checks.trial.cr)}${Math.abs(f.checks.trial.diff) < 1 ? ' — agrees ✓' : ` — off by ${exact(f.checks.trial.diff)}`}</li>
        ${f.checks.openingDiff != null ? `<li class="${Math.abs(f.checks.openingDiff) < 1 ? 'good-text' : 'warn-text'}">${Math.abs(f.checks.openingDiff) < 1 ? 'Opening balances agree ✓' : `Difference in opening balances: ${drcr(f.checks.openingDiff)} (as Tally shows it)`}</li>` : '<li class="muted">No opening balances in the file (no masters): closing balances are only this file\'s movement.</li>'}
        ${f.checks.unbalanced ? `<li class="warn-text">${plural(f.checks.unbalanced, 'voucher')} whose debits and credits don't agree</li>` : ''}
        ${f.checks.unknown.length ? `<li class="warn-text">${plural(f.checks.unknown.length, 'ledger')} not placed in any group: ${f.checks.unknown.slice(0, 8).map((l) => esc(l.name)).join(', ')}${f.checks.unknown.length > 8 ? '…' : ''}</li>` : ''}
      </ul>
    </section>`;
}

// ---------------------------------------------------------------------------
// Ledger app vs Tally
// ---------------------------------------------------------------------------
const WHAT = {
  opening: ['Opening differs', 'warn'], amount: ['Amount differs', 'bad'], date: ['Date differs', 'info'], number: ['Bill no. differs', 'info'],
  appOnly: ['Not in Tally', 'bad'], tallyOnly: ['Not in the app', 'bad'],
};
const SHORT = { opening: 'opening differs', amount: 'amount differs', date: 'date differs', number: 'bill no. differs', appOnly: 'not in Tally', tallyOnly: 'not in the app' };
const KIND = { bill: 'Bill', payment: 'Payment', tds: 'TDS', shortage: 'Shortage', credit: 'Credit', debit: 'Debit' };
const STATUS = {
  ok: '<span class="pill good-pill">matches</span>', timing: '<span class="pill info-pill">same balance · dates differ</span>',
  diff: '<span class="pill bad-pill">differs</span>', notInTally: '<span class="pill warn-pill">not found in Tally</span>',
};

function entryText(x, side) {
  if (!x) return '';
  if (side === 'tally') return `${esc(x.type || KIND[x.kind] || '')}${x.number ? ` <b>${esc(x.number)}</b>` : ''}${x.narration ? ` <small class="muted">${esc(x.narration)}</small>` : ''}`;
  if (x.parts) return `Payment${x.parts.length > 1 ? ` with ${x.parts.filter((p) => p.kind !== 'payment').map((p) => KIND[p.kind]).join(' + ')}` : ''}`;
  return `${KIND[x.kind] || ''}${x.number ? ` <b>${esc(x.number)}</b>` : ''}${x.who ? ` <small class="muted">${esc(x.who)}</small>` : ''}`;
}

function findingRow(f) {
  const [what, tone] = WHAT[f.type];
  const a = f.app;
  const t = f.tally;
  let detail;
  if (f.type === 'opening') detail = `Balance at the start: app ${drcr(a.amount)}, Tally ${drcr(t.amount)}`;
  else if (f.type === 'date') detail = `${entryText(a, 'app')} on <b>${shortDate(a.date)}</b> in the app, <b>${shortDate(t.date)}</b> in Tally`;
  else if (f.type === 'number') detail = `App ${entryText(a, 'app')} = Tally ${entryText(t, 'tally')} (same day and amount)`;
  else if (f.type === 'amount') detail = `${entryText(a, 'app')}: app ${exact(Math.abs(a.amount))}, Tally ${exact(Math.abs(t.amount))}${a.date !== t.date ? ` · dated ${shortDate(a.date)} / ${shortDate(t.date)}` : ''}`;
  else if (f.type === 'appOnly') detail = `${entryText(a, 'app')} ${exact(Math.abs(a.amount))} — in the app, not in Tally`;
  else detail = `${entryText(t, 'tally')} ${exact(Math.abs(t.amount))}${t.ledger ? ` <small class="muted">${esc(t.ledger)}</small>` : ''} — in Tally, not in the app`;
  return `<tr><td class="nowrap">${shortDate(f.date)}</td><td><span class="pill ${tone}-pill">${what}</span></td><td>${detail}</td>
    <td class="r ${f.effect > 0 ? 'warn-text' : f.effect < 0 ? 'bad-text' : 'muted'}">${f.effect ? `${f.effect > 0 ? '+' : '−'}${exact(Math.abs(f.effect))}` : 'no effect'}</td></tr>`;
}

export function reconRowHtml(r, i) {
  const tag = r.acct.kind === 'bulk' ? '<span class="tag bulk">Bulk</span>' : '<span class="tag">Retail</span>';
  if (r.status === 'notInTally') {
    return `<li><div class="rank-row static"><span class="n">${i + 1}</span>
      <span class="who"><b>${esc(r.acct.name)}</b> ${tag} ${STATUS.notInTally}</span><span class="amt"><small>no Tally ledger named</small><small>${esc(r.missing.join(', '))}</small></span></div>
      ${suggestHtml(r)}</li>`;
  }
  const off = Math.abs(r.diff) >= 0.005;
  const counts = {};
  r.findings.forEach((f) => { counts[f.type] = (counts[f.type] || 0) + 1; });
  return `<li><button class="rank-row" data-recon="${i}" aria-expanded="false"><span class="n">${i + 1}</span>
      <span class="who"><b>${esc(r.acct.name)}</b> ${tag} ${STATUS[r.status]}
        <small class="muted recon-sub">App ${drcr(r.appClose)} · Tally ${drcr(r.tallyClose)}${r.firstOff && off ? ` · off since ${shortDate(r.firstOff)}` : ''}</small></span>
      <span class="amt"><b class="${off ? 'bad-text' : 'good-text'}">${off ? `${r.diff > 0 ? '+' : '−'}${exact(Math.abs(r.diff))}` : '✓'}</b>
        <small>${r.findings.length ? Object.entries(counts).map(([k, n]) => `${n} ${SHORT[k]}`).join(' · ') : 'every entry matches'}</small></span></button>
    <div class="rank-more recon-more" hidden>
      ${r.findings.length ? `<div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th>What</th><th>Entry</th><th class="r">Effect on Tally − app</th></tr></thead>
        <tbody>${r.findings.map(findingRow).join('')}</tbody>
        <tfoot><tr><td></td><td></td><td><b>Difference on ${shortDate(r.asOn)}</b>${Math.abs(r.residual) >= 0.01 ? ` <small class="warn-text">(${exact(r.residual)} not traced)</small>` : ''}</td><td class="r"><b>${off ? `${r.diff > 0 ? '+' : '−'}${exact(Math.abs(r.diff))}` : '₹0'}</b></td></tr></tfoot></table></div>` : '<p class="good-text small">Every bill and payment in the app is in Tally, on the same day and for the same amount.</p>'}
      ${r.timeline.some((d) => Math.abs(d.change) >= 0.005) ? `<details><summary>Day by day: the days the difference changes</summary>
        <div class="table-wrap"><table class="compact"><thead><tr><th>Date</th><th class="r">App</th><th class="r">Tally</th><th class="r">Change</th><th class="r">Difference after</th></tr></thead>
        <tbody>${r.timeline.filter((d) => Math.abs(d.change) >= 0.005).map((d) => `<tr><td>${fmtDate(d.date)}</td><td class="r">${drcr(d.app)}</td><td class="r">${drcr(d.tally)}</td>
          <td class="r">${d.change > 0 ? '+' : '−'}${exact(Math.abs(d.change))}</td><td class="r"><b>${Math.abs(d.diff) < 0.005 ? '₹0' : `${d.diff > 0 ? '+' : '−'}${exact(Math.abs(d.diff))}`}</b></td></tr>`).join('')}</tbody></table></div></details>` : ''}
      <p class="small muted">Compared from ${fmtDate(r.from)}${r.openingKnown ? '' : ' (movement only — no Tally opening in the file)'} · Tally ledger${r.found.length > 1 ? 's' : ''}: ${r.found.map(esc).join(', ')}${r.missing.length ? ` · <span class="warn-text">not in Tally: ${r.missing.map(esc).join(', ')}</span>` : ''}</p>
      ${suggestHtml(r)}
    </div></li>`;
}

function suggestHtml(r) {
  const s = (r.suggest || []).filter((x) => x.options.length);
  if (!s.length) return '';
  return `<div class="suggest">${s.map((x) => `<p class="small">“${esc(x.name)}” may be ${x.options.map((o) => `<button class="btn ghost small" data-map-from="${esc(x.name)}" data-map-to="${esc(o.name)}">${esc(o.name)}</button>`).join(' ')} in Tally</p>`).join('')}</div>`;
}

export function reconHtml(res, { filter = 'all', asOnMax = '', q = '' } = {}) {
  const t = res.totals;
  const keep = { all: () => true, diff: (r) => r.status === 'diff', timing: (r) => r.status === 'timing', missing: (r) => r.status === 'notInTally', ok: (r) => r.status === 'ok' };
  const needle = q.trim().toLowerCase();
  const rows = res.rows.map((r, i) => [r, i]).filter(([r]) => keep[filter](r) && (!needle || r.acct.name.toLowerCase().includes(needle) || r.acct.names.some((n) => n.toLowerCase().includes(needle))));
  return `
    <section class="card">
      <h2>Ledger app vs Tally</h2>
      <p class="muted small">Each customer's balance in this app — their ledger sheet, or their *_Bulk sheet (all its billing names together) — against their ledger in Tally, and the bills, payments and days any difference comes from.</p>
      <form class="custom-range" id="recon-date">
        <label>Balances as on <input type="date" name="asOn" value="${res.asOn}" max="${asOnMax}" required></label>
        <button class="btn small" type="submit">Compare</button>
        <button class="btn ghost small" type="button" data-recon-xlsx>Download Excel</button>
      </form>
      ${res.openingKnown ? `<p class="small muted">Tally's openings from the masters in the file (1 April ${res.start.slice(0, 4)}).</p>`
    : `<p class="small warn-text">The file has no masters, so Tally's opening balances aren't known: only what happened from ${fmtDate(res.start)} is compared. Add the All Masters export to compare whole balances.</p>`}
      <div class="kpis">
        <div class="kpi ${Math.abs(t.diff) >= 0.005 ? 'warn' : ''}"><span class="lbl">Tally − app</span><span class="val">${Math.abs(t.diff) < 0.005 ? '₹0' : `${t.diff > 0 ? '+' : '−'}${money(Math.abs(t.diff))}`}</span><span class="sub">${t.absDiff >= 0.005 ? `${exact(t.absDiff)} off in all` : 'all agree'}</span></div>
        <div class="kpi"><span class="lbl">Agree</span><span class="val good-text">${t.matching}</span><span class="sub">of ${plural(t.compared, 'account')} compared</span></div>
        <div class="kpi"><span class="lbl">Differ</span><span class="val ${t.differing ? 'bad-text' : ''}">${t.differing}</span><span class="sub">${t.notInTally ? `${t.notInTally} not found in Tally` : 'every account found'}</span></div>
        <div class="kpi"><span class="lbl">App · Tally</span><span class="val">${money(t.app)}</span><span class="sub">Tally ${money(t.tally)}</span></div>
      </div>
    </section>
    <section class="card">
      <div class="chips small-chips">${[['all', 'All', res.rows.length], ['diff', 'Differ', t.differing], ['timing', 'Dates differ', res.rows.filter((r) => r.status === 'timing').length],
    ['missing', 'Not in Tally', t.notInTally], ['ok', 'Agree', res.rows.filter((r) => r.status === 'ok').length]].map(([k, n, c]) => `<button class="chip ${k === filter ? 'on' : ''}" data-rfilter="${k}">${n} · ${c}</button>`).join('')}</div>
      <input type="search" id="recon-q" placeholder="Search an account" value="${esc(q)}" autocomplete="off">
      ${rows.length ? `<ol class="rank">${rows.map(([r, i]) => reconRowHtml(r, i)).join('')}</ol>` : '<p class="muted">No accounts here.</p>'}
      <p class="small muted">Effect: how much that entry moves Tally's balance against the app's (+ Tally higher). The effects add up to the difference. Dates that differ change nothing at the end, only in between.</p>
    </section>
    ${res.tallyOnly.length ? `<section class="card">
      <div class="row-between"><h3>Debtors in Tally the app doesn't compare</h3><b class="total">${exact(res.tallyOnly.reduce((s, x) => s + x.balance, 0))}</b></div>
      <div class="table-wrap"><table class="compact"><tbody>${res.tallyOnly.slice(0, 60).map((x) => `<tr><td>${esc(x.name)}</td><td class="small muted">${esc(x.note)}</td><td class="r">${drcr(x.balance)}</td></tr>`).join('')}</tbody></table></div>
      ${res.tallyOnly.length > 60 ? `<p class="small muted">First 60 of ${res.tallyOnly.length}.</p>` : ''}
    </section>` : ''}`;
}

// ---------------------------------------------------------------------------
// purchases & stock
// ---------------------------------------------------------------------------
export function stockHtml(sum, months, { metric = 'volume', q = '' } = {}) {
  const t = sum.totals;
  const buy = sum.kind === 'purchase';
  const needle = q.trim().toLowerCase();
  const items = sum.items.filter((x) => !needle || x.name.toLowerCase().includes(needle) || (x.group || '').toLowerCase().includes(needle));
  const counted = items.filter((x) => !x.off);                    // the totals: ticked items only
  const unitOf = (x) => (metric === 'volume' ? (x.measure === 'KG' ? 'kg' : 'L') : '');
  const val = (o, x) => (metric === 'amount' ? money(o.amount) : metric === 'packs' ? qty(o.packs, 0) : (x.unknownPack && !o.volume ? '—' : `${qty(o.volume)} ${unitOf(x)}`));
  const colTotal = (m, measure) => counted.reduce((s, x) => {
    const o = x.months.get(m);
    if (!o || (metric === 'volume' && x.measure !== measure)) return s;
    return s + (metric === 'amount' ? o.amount : metric === 'packs' ? o.packs : o.volume);
  }, 0);
  const rowTotal = (measure) => counted.filter((x) => metric !== 'volume' || x.measure === measure).reduce((s, x) => s + (metric === 'amount' ? x.amount : metric === 'packs' ? x.packs : x.volume), 0);
  const fmtTotal = (v, measure) => (metric === 'amount' ? money(v) : metric === 'packs' ? qty(v, 0) : `${qty(v)} ${measure === 'KG' ? 'kg' : 'L'}`);
  const totalRows = metric === 'volume'
    ? ['L', 'KG'].filter((u) => counted.some((x) => x.measure === u)).map((u) => `<tr class="pl-total"><td class="sticky">Total ${u === 'L' ? 'litres' : 'kg'}</td>${months.map((m) => `<td class="r">${colTotal(m, u) ? fmtTotal(colTotal(m, u), u) : ''}</td>`).join('')}<td class="r">${fmtTotal(rowTotal(u), u)}</td></tr>`).join('')
    : `<tr class="pl-total"><td class="sticky">Total</td>${months.map((m) => `<td class="r">${colTotal(m) ? fmtTotal(colTotal(m)) : ''}</td>`).join('')}<td class="r">${fmtTotal(rowTotal())}</td></tr>`;
  const chartVal = (m) => (metric === 'amount' ? m.amount : metric === 'packs' ? m.packs : m.L);
  return `
    <section class="card">
      <h2>${buy ? 'Purchases' : 'Sales'} &amp; stock</h2>
      <div class="chips small-chips">
        <button class="chip ${buy ? 'on' : ''}" data-skind="purchase">Bought</button><button class="chip ${!buy ? 'on' : ''}" data-skind="sale">Sold</button>
        <span class="chip-gap"></span>
        <button class="chip ${sum.category === 'lubes' ? 'on' : ''}" data-scat="lubes">Lubricants &amp; other items</button>
        <button class="chip ${sum.category === 'fuel' ? 'on' : ''}" data-scat="fuel">Fuel</button></div>
      <p class="muted small">${fmtDate(sum.from)} – ${fmtDate(sum.to)} · item amounts before GST · pack sizes read from the item names (900ML, 20 LTR, 1X12X1L, 500 GM)${buy ? ' · purchase returns count against them' : ''}</p>
      <div class="kpis">
        <div class="kpi hero"><span class="lbl">${buy ? 'Bought' : 'Sold'}</span><span class="val">${money(t.amount)}</span><span class="sub">${plural(t.items, 'item')}${t.off ? ` · ${t.off} left out` : ''}</span></div>
        <div class="kpi"><span class="lbl">Litres</span><span class="val">${litres(t.L)}</span><span class="sub">${t.KG ? `+ ${qty(t.KG)} kg` : 'oils &amp; fluids'}</span></div>
        <div class="kpi"><span class="lbl">Packs</span><span class="val">${qty(t.packs, 0)}</span><span class="sub">bottles, cans, buckets…</span></div>
        <div class="kpi"><span class="lbl">${buy ? 'Suppliers' : 'Customers'}</span><span class="val">${sum.parties.length}</span><span class="sub">${sum.parties[0] ? esc(sum.parties[0].name) : '&nbsp;'}</span></div>
      </div>
      ${t.unknown ? `<p class="small warn-text">${plural(t.unknown, 'item')} with no pack size in the name — counted in packs and amount, not in litres: ${sum.items.filter((x) => x.unknownPack).slice(0, 6).map((x) => esc(x.name)).join(', ')}</p>` : ''}
    </section>
    ${sum.items.length ? `<section class="card">
      <div class="row-between"><h3>Item by month</h3><button class="btn ghost small" data-stock-xlsx>Download Excel</button></div>
      <div class="chips small-chips">${[['volume', 'Litres / kg'], ['packs', 'Packs'], ['amount', 'Amount']].map(([k, n]) => `<button class="chip ${k === metric ? 'on' : ''}" data-smetric="${k}">${n}</button>`).join('')}</div>
      ${barChart(sum.months.map((m) => ({ label: monthName(m.month), value: Math.max(0, chartVal(m)), tip: `<b>${monthName(m.month)}</b><br>${exact(m.amount)}<br>${qty(m.L)} L${m.KG ? ` · ${qty(m.KG)} kg` : ''} · ${qty(m.packs, 0)} packs` })),
    { label: 'Per month', color: 'var(--s-xg)', h: 140, fmt: metric === 'amount' ? money : (v) => qty(v, 0) })}
      <input type="search" id="stock-q" placeholder="Search an item or group" value="${esc(q)}" autocomplete="off">
      <div class="row-between pick-bar"><span class="small muted">${t.items} of ${t.items + t.off} items counted${t.off ? ' — unticked items are left out of every total, the chart and the Excel' : ' — untick an item to leave it out of the totals'}</span>
        <span class="row-end"><button class="btn ghost small" data-sall>Tick ${needle ? 'these' : 'all'}</button><button class="btn ghost small" data-snone>Untick ${needle ? 'these' : 'all'}</button></span></div>
      <div class="table-wrap pivot-wrap"><table class="compact pivot"><thead><tr><th class="sticky">Item</th>${months.map((m) => `<th class="r">${monthName(m)}</th>`).join('')}<th class="r">Total</th></tr></thead>
        <tbody>${items.map((x) => `<tr class="${x.off ? 'off' : ''}"><td class="sticky"><label class="pick"><input type="checkbox" data-sitem="${esc(x.key)}" ${x.off ? '' : 'checked'} aria-label="Count ${esc(x.name)}">
          <span><b>${esc(x.name)}</b><small class="muted">${[x.group, x.size ? `${qty(x.size, 3)} ${x.measure === 'KG' ? 'kg' : 'L'} pack` : ''].filter(Boolean).map(esc).join(' · ')}${x.off ? ' · left out' : ''}</small></span></label></td>
          ${months.map((m) => `<td class="r">${x.months.get(m) ? val(x.months.get(m), x) : ''}</td>`).join('')}<td class="r"><b>${val(x, x)}</b></td></tr>`).join('')}
          ${totalRows}</tbody></table></div>
    </section>
    <section class="card">
      <h3>Items</h3>
      <div class="table-wrap"><table class="compact"><thead><tr><th>Item</th><th class="r">Packs</th><th class="r">Litres / kg</th><th class="r">Amount</th><th class="r">₹ a pack</th><th class="r">₹ a L / kg</th><th class="r">Last rate</th><th>Last</th></tr></thead>
        <tbody>${items.map((x) => `<tr class="${x.off ? 'off' : ''}"><td>${esc(x.name)}${x.off ? ' <small class="muted">left out</small>' : ''}</td><td class="r">${qty(x.packs, 0)}</td><td class="r">${x.volume ? `${qty(x.volume)} ${x.measure === 'KG' ? 'kg' : 'L'}` : '—'}</td><td class="r">${exact(x.amount)}</td>
          <td class="r">${x.perPack ? exact(Math.round(x.perPack * 100) / 100) : ''}</td><td class="r">${x.perUnit ? exact(Math.round(x.perUnit * 100) / 100) : ''}</td>
          <td class="r">${x.lastRate ? `${exact(Number(x.lastRate))}${x.unit ? `<small class="muted">/${esc(x.unit.toLowerCase())}</small>` : ''}` : ''}</td><td class="small muted nowrap">${x.lastDate ? shortDate(x.lastDate) : ''}</td></tr>`).join('')}</tbody></table></div>
      <h3 class="sub-h">${buy ? 'Suppliers' : 'Customers'}</h3>
      <div class="table-wrap"><table class="compact"><thead><tr><th>${buy ? 'Supplier' : 'Customer'}</th><th class="r">Vouchers</th><th class="r">Items (before GST)</th><th class="r">Bills (with GST)</th></tr></thead>
        <tbody>${sum.parties.map((p) => `<tr><td>${esc(p.name)}</td><td class="r">${p.vouchers}</td><td class="r">${exact(p.amount)}</td><td class="r">${exact(p.total)}</td></tr>`).join('')}</tbody></table></div>
    </section>` : `<section class="card"><p class="muted">No ${sum.category === 'fuel' ? 'fuel' : 'lubricants or other items'} ${buy ? 'bought' : 'sold'} in these dates${sum.items.length ? '' : ' — stock items are only in Tally\'s XML export, not the DayBook in Excel'}.</p></section>`}`;
}
