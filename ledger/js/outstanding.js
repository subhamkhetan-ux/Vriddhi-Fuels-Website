// A customer's outstanding: the account behind it and the card that is shared
// as a picture. Pure functions over the store — no DOM — so every ledger
// screen draws exactly the same cards.
//   accountFor(store, o, today) -> the account of anyone on Home's
//                                 outstanding list (o: analyse().due row)
//   cardSets(...)               -> which cards to draw (unit-wise / together)

import { bulkRows } from './account.js';
import {
  bulkStatement, companyStatements, fifoPending, groupPending, poSummary, retailStatement, unitKey, unitLabel, unitStatement,
} from './ledger-view.js';
import { allocate, billOrder } from './po.js';
import { ledgerRows, monthEnd } from './statements.js';
import { normKey } from './util.js';

const round2 = (n) => Math.round(n * 100) / 100;
export const dmyDash = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
export const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

// Each bulk sheet's PO lists with every bill's PO (the Bulk sheets' rule)
export function poGroups(data) {
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

export const groupName = (g, members) => (members.length === 1 ? members[0].name : (g.title || g.code).split(' — ')[0]);

// the card a customer gets for their outstanding (pending: the FIFO bills)
export function cardOf(st, { asOn, name = st.name, kind = st.kind, note = '', fifo = null, units = null } = {}) {
  const t = st.totals;
  return {
    name, kind, note, balance: st.closing, asOn, since: st.from, opening: st.opening,
    billed: t.billed, qty: t.qty, received: t.received, deductions: round2(t.tds + t.shortage),
    bills: t.bills, payments: t.payments, lastPayment: st.lastPayment, lastBill: st.lastBill, companies: st.companies,
    pending: fifo ? fifo.pending : null, advance: fifo ? fifo.advance : 0, pos: fifo ? poSummary(fifo.pending) : null,
    units: units ? unitsBlock(units, st.closing) : null,
  };
}

// SMC-style sheets: each unit's figures for the combined card / page
export const unitsBlock = (units, total) => ({
  title: 'UNIT-WISE OUTSTANDING', totalLabel: 'Account balance', opening: 0, total,
  list: units.map((u) => ({
    name: unitLabel(u.unit), bills: u.st.totals.bills, billed: u.st.totals.billed, received: u.st.totals.received,
    deductions: round2(u.st.totals.tds + u.st.totals.shortage), outstanding: u.st.closing, qty: u.st.totals.qty, lastPayment: u.st.lastPayment,
  })),
});

// A bulk account with its FIFO pending bills; on an SMC-style (unit-wise)
// sheet also each unit's own statement and pending bills.
// openingByUnit: the sheet's opening split by unit (ledger_po_data groups)
export function bulkAccount(data, res, name, openingByUnit, asOn) {
  const st = bulkStatement(res, data, { name });
  const unitWise = res.kind === 'po_units';
  const obu = unitWise ? (openingByUnit || {}) : {};
  // a group: each company's payments clear its own bills
  const fifo = res.kind === 'group' ? groupPending(st, { asOn })
    : fifoPending(st.entries, { opening: st.opening, openingByKey: obu, keyOf: unitWise ? unitKey : () => '', from: st.from, asOn });
  let units = null;
  if (unitWise) {
    const keys = (data.group.units || []).map((u) => String(u).trim().toUpperCase()).filter(Boolean);
    for (const k of Object.keys(fifo.keys)) if (k && !keys.includes(k)) keys.push(k);
    const none = unitStatement(st, fifo, '', { openingByUnit: obu });
    units = keys.map((k) => ({ unit: k, st: unitStatement(st, fifo, k, { openingByUnit: obu }) }));
    // bills with no unit yet (or an opening the units don't split): their own
    // part — only while something there is owed (or in advance)
    if (Math.round(none.closing)) units.push({ unit: '', st: none });
    for (const u of units) {
      u.fifo = { pending: fifo.pending.filter((d) => d.key === u.unit), advance: fifo.keys[u.unit]?.advance || 0 };
    }
  }
  // a group: each company's own statement of account and pending bills
  const companies = res.kind === 'group'
    ? companyStatements(st).map((cst) => ({ name: cst.name, st: cst, fifo: fifoPending(cst.entries, { asOn }) }))
    : null;
  return { st, fifo, units, companies };
}

// A bulk sheet's account as on today (or its last entry, if later), read
// from the store: {acct, data, asOn}
export async function loadBulkAccount(store, code, name, today) {
  const [data, pod] = await Promise.all([store.account(null, code, null, null), store.poData()]);
  const poById = new Map();
  const pg = poGroups(pod).find((x) => x.group.code === code);
  if (pg) pg.rows.forEach((r) => poById.set(r.id, r.po));
  const res = bulkRows(data, (sid) => poById.get(sid) || '');
  const last = res.rows.length ? res.rows[res.rows.length - 1].date : today;
  const asOn = last > today ? last : today;
  const acct = bulkAccount(data, res, name, (pod.groups.find((x) => x.code === code) || {}).opening_by_unit, asOn);
  return { acct, data, asOn };
}

// FIFO of one company of a group sheet (its own bills and payments)
const companyFifo = (st, c, asOn) => fifoPending(st.entries.filter((e) => normKey(e.company) === normKey(c.name)), { asOn });

// one company of a group, as its own card
export function companyCard(c, st, asOn) {
  const f = companyFifo(st, c, asOn);
  return {
    name: c.name, kind: 'bulk', note: `Part of the ${st.name} account`, balance: c.outstanding, asOn, since: st.from,
    billed: c.billed, qty: c.qty, received: c.received, deductions: c.deductions, bills: c.bills, payments: c.payments,
    lastPayment: c.lastPayment, lastBill: c.lastBill, companies: null, pending: f.pending, advance: f.advance,
  };
}

// The outstanding cards of a bulk account: unit-wise first on an SMC-style
// sheet (one card per unit, each for its own recipient), then together.
//   -> [{label, sets: [{label, card, base}]}]   (base: the file name)
export function cardSets(acct, name, asOn) {
  const together = {
    label: acct.units ? 'Both units together' : '',
    sets: [{ label: '', card: cardOf(acct.st, { asOn, fifo: acct.fifo, units: acct.units }), base: safeName(`${name} Outstanding ${dmyDash(asOn)}`) }],
  };
  if (!acct.units) return [together];
  const unitWise = {
    label: 'Unit-wise',
    sets: acct.units.map((u) => ({
      label: unitLabel(u.unit),
      card: cardOf(u.st, { asOn, note: `Part of the ${name} account`, fifo: u.fifo }),
      base: safeName(`${name} ${unitLabel(u.unit)} Outstanding ${dmyDash(asOn)}`),
    })),
  };
  return [unitWise, together];
}

// The outstanding of anyone on Home's list (o: analyse().due row, id 'g:CODE'
// for a bulk sheet or 'c:KEY' for a retail ledger) -> card sets as above,
// plus the account for figures (bulk: acct; retail: the month's statement).
export async function outstandingFor(store, o, today) {
  const id = o.id.slice(2);
  if (o.id.startsWith('g:')) {
    const { acct, asOn } = await loadBulkAccount(store, id, o.name, today);
    return { kind: 'bulk', asOn, acct, st: acct.st, options: cardSets(acct, o.name, asOn) };
  }
  const from = `${today.slice(0, 7)}-01`;
  const data = await store.account(id, null, from, monthEnd(from));
  const led = ledgerRows({ opening: data.customer.opening, from, sales: data.sales, payments: data.payments });
  const st = retailStatement(led, { name: o.name, from, to: today });
  const card = cardOf(st, { asOn: today });
  return {
    kind: 'retail', asOn: today, acct: null, st,
    options: [{ label: '', sets: [{ label: '', card, base: safeName(`${o.name} Outstanding ${dmyDash(today)}`) }] }],
  };
}
