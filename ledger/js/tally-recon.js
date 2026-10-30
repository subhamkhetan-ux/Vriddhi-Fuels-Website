// Ledger app vs Tally: each customer's balance in the app (their ledger
// sheet, or their *_Bulk sheet) against their ledger in Tally, as on a date,
// and where any difference comes from — which bill, which payment, which day.
// Pure — no DOM, no network: app.js fetches the app's side.
//
// Signs: + = Dr (the customer owes us), for both sides.
//
// How a difference is traced, per account:
//   1. bills by bill no. (same no. in the app and in Tally): equal, or the
//      amount differs, or the date differs;
//   2. a payment in the app with its TDS and shortage against one Tally
//      receipt (or credit) of the three together;
//   3. what's left by exact amount: the same day first, then the nearest
//      day within 10 days (a date difference) — TDS and shortage within
//      120 days, as Tally often books them later in a journal;
//   4. anything still unmatched is in one side only.
// Each finding carries its effect on the balance (Tally − app); the effects
// and the opening difference add up to the difference in the closing balance.

import { normName } from './tally-file.js';

const round2 = (n) => Math.round(n * 100) / 100;
const cents = (n) => Math.round(n * 100);
const dayNo = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const normNo = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
export const fyStartOf = (iso) => { const y = Number(iso.slice(0, 4)); return `${Number(iso.slice(5, 7)) >= 4 ? y : y - 1}-04-01`; };

// ---------------------------------------------------------------------------
// the app's side
// ---------------------------------------------------------------------------

// The app's accounts with their entries, from
//   statement: store.statementData(from, to) — retail ledger customers, with
//              their balance before `from`, and every sale and payment
//   bulk:      [{code, title, data: store.account(null, code)}] — bulk sheets
//   from:      the `from` statementData was asked for
// -> [{id, name, kind, names: [Tally party names], openingDate, opening, items}]
export function appAccounts(statement, bulk = [], { from } = {}) {
  const out = [];
  const byKey = new Map();
  for (const c of statement.customers || []) {
    const a = { id: `c:${c.key}`, name: c.name, kind: 'retail', names: [c.name], openingDate: from, opening: Number(c.opening) || 0, items: [] };
    byKey.set(c.key, a);
    out.push(a);
  }
  for (const s of statement.sales || []) {
    const a = byKey.get(s.key);
    if (a) a.items.push({ date: s.sale_date, kind: 'bill', number: s.bill_no, product: s.product, amount: round2(Number(s.amount) || 0) });
  }
  for (const p of statement.payments || []) {
    const a = byKey.get(p.key);
    if (a) a.items.push({ date: p.pay_date, kind: 'payment', amount: -round2(Number(p.amount) || 0) });
  }
  for (const b of bulk) {
    const d = b.data;
    const g = d.group || {};
    const a = {
      id: `g:${b.code}`, name: b.title || g.title || b.code, kind: 'bulk', names: (d.members || []).map((m) => m.name),
      openingDate: g.period_from || '1900-01-01', opening: Number(g.opening) || 0, items: [],
    };
    for (const s of d.sales || []) a.items.push({ date: s.sale_date, kind: 'bill', number: s.bill_no, product: s.product, amount: round2(Number(s.amount) || 0), who: s.customer });
    (d.payments || []).forEach((p, i) => {
      const pay = `p${i}`;
      if (Number(p.amount)) a.items.push({ date: p.pay_date, kind: 'payment', amount: -round2(Number(p.amount)), pay, who: p.customer, remarks: p.remarks });
      if (Number(p.tds)) a.items.push({ date: p.pay_date, kind: 'tds', amount: -round2(Number(p.tds)), pay, who: p.customer });
      if (Number(p.shortage)) a.items.push({ date: p.pay_date, kind: 'shortage', amount: -round2(Number(p.shortage)), pay, who: p.customer });
    });
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tally's side
// ---------------------------------------------------------------------------

// Every party ledger's entries in the file: Map(normName -> {name, opening,
// items}). opening is the masters' opening (null when the file has none).
export function tallyParties(vouchers, masters) {
  const out = new Map();
  const get = (name) => {
    const k = normName(name);
    if (!out.has(k)) {
      const m = masters && masters.ledgers.get(k);
      out.set(k, { name: m ? m.name : name, opening: m ? m.opening : null, parent: m ? m.parent : '', items: [] });
    }
    return out.get(k);
  };
  if (masters) for (const l of masters.ledgers.values()) get(l.name);
  for (const v of vouchers) {
    if (v.cancelled || v.optional) continue;
    // a voucher can post to the same party twice (say the bill and its round-off line)
    const perParty = new Map();
    for (const l of v.ledgers) perParty.set(normName(l.name), (perParty.get(normName(l.name)) || 0) - l.amount);
    for (const [k, amt] of perParty) {
      if (Math.abs(amt) < 0.005) continue;
      const p = get(v.ledgers.find((l) => normName(l.name) === k).name);
      p.items.push({ date: v.date, kind: tallyKind(v, amt), type: v.type, number: v.number, amount: round2(amt), narration: v.narration });
    }
  }
  return out;
}
function tallyKind(v, amt) {
  if (v.kind === 'sale') return 'bill';
  if (v.kind === 'receipt') return 'payment';
  if (v.kind === 'creditnote' || v.kind === 'journal' || v.kind === 'debitnote') return amt < 0 ? 'credit' : 'debit';
  return amt > 0 ? 'debit' : 'payment';
}

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------
const STOP = new Set(['m/s', 'ms', 'the', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'and', '&', 'enterprises', 'enterprise', 'india']);
const words = (s) => new Set(normName(s).replace(/\bm\/s\.?/g, ' ').replace(/[^a-z0-9& ]/g, ' ').split(' ').filter((w) => w && !STOP.has(w)));
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n += 1;
  return n / (x.size + y.size - n);
}
// the Tally ledgers most like `name` (score >= 0.5), best first
export function suggestions(name, ledgerNames, max = 3) {
  return ledgerNames.map((n) => ({ name: n, score: similarity(name, n) })).filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score).slice(0, max);
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

// app, tally: entries in the window. -> {pairs, findings}
export function matchEntries(app, tally) {
  const A = app.map((x, i) => ({ ...x, i, used: false }));
  const T = tally.map((x, i) => ({ ...x, i, used: false }));
  const findings = [];
  const pair = (a, t, extra = {}) => {
    a.used = true;
    t.used = true;
    const effect = round2(t.amount - a.amount);
    if (cents(effect)) findings.push({ type: 'amount', date: t.date < a.date ? t.date : a.date, app: a, tally: t, effect, ...extra });
    else if (a.date !== t.date) findings.push({ type: 'date', date: t.date < a.date ? t.date : a.date, app: a, tally: t, effect: 0, ...extra });
    else if (extra.renumbered) findings.push({ type: 'number', date: a.date, app: a, tally: t, effect: 0 });
  };
  const nearest = (list, date, ok) => {
    let best = null;
    for (const x of list) {
      if (x.used || !ok(x)) continue;
      const d = Math.abs(dayNo(x.date) - dayNo(date));
      if (!best || d < best.d) best = { x, d };
    }
    return best;
  };

  // 1. bills by number
  const tallyBills = new Map();
  for (const t of T) if (t.kind === 'bill' && t.number) {
    const k = normNo(t.number);
    if (!tallyBills.has(k)) tallyBills.set(k, []);
    tallyBills.get(k).push(t);
  }
  for (const a of A) {
    if (a.kind !== 'bill' || !a.number) continue;
    const best = nearest(tallyBills.get(normNo(a.number)) || [], a.date, () => true);
    if (best && best.d <= 400) pair(a, best.x);
  }

  // 2. a payment with its TDS and shortage = one Tally credit
  const pays = new Map();
  for (const a of A) if (a.pay && !a.used) {
    if (!pays.has(a.pay)) pays.set(a.pay, []);
    pays.get(a.pay).push(a);
  }
  for (const parts of pays.values()) {
    if (parts.length < 2) continue;
    const total = round2(parts.reduce((s, p) => s + p.amount, 0));
    const date = parts[0].date;
    const best = nearest(T, date, (t) => t.amount < 0 && cents(t.amount) === cents(total));
    if (best && best.d <= 5) {
      parts.forEach((p) => { p.used = true; });
      best.x.used = true;
      if (best.d) findings.push({ type: 'date', date: best.x.date < date ? best.x.date : date, app: { ...parts[0], amount: total, kind: 'payment', parts }, tally: best.x, effect: 0 });
    }
  }

  // 3. the rest by exact amount: same kind first, then any; same day, then nearest
  const sameKind = (a, t) => (a.kind === 'bill') === (t.kind === 'bill');
  for (const strict of [true, false]) {
    for (const a of A) {
      if (a.used) continue;
      const best = nearest(T, a.date, (t) => cents(t.amount) === cents(a.amount) && (!strict || sameKind(a, t)));
      if (best && best.d <= 10) pair(a, best.x, { renumbered: a.kind === 'bill' && best.x.kind === 'bill' && normNo(a.number) !== normNo(best.x.number) });
    }
  }

  // TDS and shortage are often booked in Tally weeks later (a journal at the
  // month or quarter end): the same amount within 120 days
  for (const a of A) {
    if (a.used || (a.kind !== 'tds' && a.kind !== 'shortage')) continue;
    const best = nearest(T, a.date, (t) => t.amount < 0 && t.kind !== 'bill' && cents(t.amount) === cents(a.amount));
    if (best && best.d <= 120) pair(a, best.x);
  }

  // 4. one side only
  for (const a of A) if (!a.used) findings.push({ type: 'appOnly', date: a.date, app: a, effect: round2(-a.amount) });
  for (const t of T) if (!t.used) findings.push({ type: 'tallyOnly', date: t.date, tally: t, effect: round2(t.amount) });
  findings.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return findings;
}

// ---------------------------------------------------------------------------
// one account
// ---------------------------------------------------------------------------

// acct: an appAccounts() entry; parties: tallyParties(); tally: {start,
// openingKnown, end}. asOn: the date to compare on.
export function reconcileAccount(acct, parties, { start, openingKnown, asOn, map = {} }) {
  const found = [];
  const missing = [];
  for (const n of acct.names) {
    const k = normName(map[normName(n)] || n);
    const p = parties.get(k);
    if (p) found.push(p); else missing.push(n);
  }
  if (!found.length) return { acct, status: 'notInTally', missing, found: [] };

  // the window: from when both sides know the balance
  const from = acct.openingDate > start ? acct.openingDate : start;
  const appBefore = round2(acct.opening + acct.items.filter((x) => x.date < from).reduce((s, x) => s + x.amount, 0));
  const tItems = found.flatMap((p) => p.items.map((x) => ({ ...x, ledger: p.name })));
  let tallyBefore;
  if (openingKnown) {
    tallyBefore = round2(found.reduce((s, p) => s + (p.opening || 0), 0) + tItems.filter((x) => x.date < from).reduce((s, x) => s + x.amount, 0));
  } else {
    tallyBefore = appBefore;                                   // no masters: compare the movement only
  }
  const inWin = (x) => x.date >= from && x.date <= asOn;
  const appWin = acct.items.filter(inWin);
  const tallyWin = tItems.filter(inWin);
  const appClose = round2(appBefore + appWin.reduce((s, x) => s + x.amount, 0));
  const tallyClose = round2(tallyBefore + tallyWin.reduce((s, x) => s + x.amount, 0));
  const diff = round2(tallyClose - appClose);
  const openingDiff = round2(tallyBefore - appBefore);
  const findings = matchEntries(appWin, tallyWin);
  if (cents(openingDiff)) findings.unshift({ type: 'opening', date: from, effect: openingDiff, app: { amount: appBefore }, tally: { amount: tallyBefore } });

  // the difference day by day: the days it changes
  const days = new Map();
  for (const x of appWin) { const d = days.get(x.date) || { date: x.date, app: 0, tally: 0 }; d.app += x.amount; days.set(x.date, d); }
  for (const x of tallyWin) { const d = days.get(x.date) || { date: x.date, app: 0, tally: 0 }; d.tally += x.amount; days.set(x.date, d); }
  let running = openingDiff;
  const timeline = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => {
    const change = round2(d.tally - d.app);
    running = round2(running + change);
    return { date: d.date, app: round2(d.app), tally: round2(d.tally), change, diff: running };
  });
  const firstOff = cents(openingDiff) ? from : (timeline.find((d) => cents(d.diff)) || {}).date || null;
  const explained = round2(findings.reduce((s, f) => s + f.effect, 0));
  return {
    // timing: the balances agree, but some entries sit on other days (or cancel out)
    acct, status: cents(diff) ? 'diff' : findings.length ? 'timing' : 'ok',
    found: found.map((p) => p.name), missing, from, asOn, appBefore, tallyBefore, appClose, tallyClose, diff, openingDiff,
    findings, timeline, firstOff, residual: round2(diff - explained), openingKnown,
  };
}

// Every account: {rows, tallyOnly, totals}
//   appCustomers: [[key, name, ledger, group]] — every customer the app
//   knows (to tell "in the app without a ledger" from "not in the app")
export function reconcile(accounts, vouchers, masters, { asOn, appCustomers = [], map = {} } = {}) {
  const parties = tallyParties(vouchers, masters);
  const openingKnown = Boolean(masters && masters.ledgers.size);
  const live = vouchers.filter((v) => !v.cancelled);
  const first = live.length ? live[0].date : asOn;
  const start = openingKnown ? fyStartOf(first) : first;
  const end = asOn || (live.length ? live[live.length - 1].date : null);
  const rows = accounts.map((a) => reconcileAccount(a, parties, { start, openingKnown, asOn: end, map }));

  // ledgers with a balance in Tally that no app account covers
  const covered = new Set();
  for (const r of rows) for (const n of r.found || []) covered.add(normName(n));
  const known = new Map(appCustomers.map(([, name, ledger, group]) => [normName(name), { ledger, group }]));
  const debtorLike = (p) => /debtor/i.test(p.parent) || (!p.parent && p.items.some((x) => x.kind === 'bill'));
  const tallyOnly = [];
  for (const [k, p] of parties) {
    if (covered.has(k) || !debtorLike(p)) continue;
    const bal = round2((openingKnown ? p.opening || 0 : 0) + p.items.filter((x) => x.date <= end).reduce((s, x) => s + x.amount, 0));
    if (!cents(bal)) continue;
    const app = known.get(k);
    tallyOnly.push({ name: p.name, balance: bal, inApp: Boolean(app), note: app ? (app.ledger || app.group ? 'in the app, not compared' : 'in the app with no ledger') : 'not in the app' });
  }
  tallyOnly.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  // a likely Tally name for accounts not found
  const names = [...parties.values()].filter(debtorLike).map((p) => p.name);
  for (const r of rows) if (r.status === 'notInTally') r.suggest = r.missing.map((n) => ({ name: n, options: suggestions(n, names) }));
  for (const r of rows) if (r.missing && r.missing.length && r.status !== 'notInTally') r.suggest = r.missing.map((n) => ({ name: n, options: suggestions(n, names) }));

  const compared = rows.filter((r) => r.status !== 'notInTally');
  return {
    rows: rows.sort((a, b) => Math.abs(b.diff || 0) - Math.abs(a.diff || 0) || (a.status === 'notInTally') - (b.status === 'notInTally')),
    tallyOnly, start, asOn: end, openingKnown,
    totals: {
      accounts: rows.length,
      compared: compared.length,
      matching: compared.filter((r) => !cents(r.diff)).length,
      differing: compared.filter((r) => cents(r.diff)).length,
      notInTally: rows.length - compared.length,
      app: round2(compared.reduce((s, r) => s + r.appClose, 0)),
      tally: round2(compared.reduce((s, r) => s + r.tallyClose, 0)),
      diff: round2(compared.reduce((s, r) => s + r.diff, 0)),
      absDiff: round2(compared.reduce((s, r) => s + Math.abs(r.diff), 0)),
    },
  };
}

// rows for an Excel download: one row per finding
export function reconSheet(res) {
  const head = ['Account', 'App balance', 'Tally balance', 'Difference', 'Date', 'What', 'Bill / voucher', 'App amount', 'Tally amount', 'Effect'];
  const out = [head];
  const what = { opening: 'Opening differs', amount: 'Amount differs', date: 'Date differs', number: 'Bill no. differs', appOnly: 'Only in the app', tallyOnly: 'Only in Tally' };
  for (const r of res.rows) {
    if (r.status === 'notInTally') { out.push([r.acct.name, '', '', '', '', 'Not found in Tally', r.missing.join(', '), '', '', '']); continue; }
    if (!r.findings.length) { out.push([r.acct.name, r.appClose, r.tallyClose, r.diff, '', 'Matches', '', '', '', '']); continue; }
    for (const f of r.findings) {
      const ref = f.tally ? [f.tally.type, f.tally.number].filter(Boolean).join(' ') : (f.app && f.app.number) || '';
      out.push([r.acct.name, r.appClose, r.tallyClose, r.diff, f.date, what[f.type], ref || (f.app && f.app.kind) || '',
        f.app ? f.app.amount : '', f.tally ? f.tally.amount : '', f.effect]);
    }
  }
  return out;
}
