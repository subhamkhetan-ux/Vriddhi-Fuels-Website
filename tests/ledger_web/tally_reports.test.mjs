// The Tally viewer's financials, Ledger app vs Tally balances and the stock
// bought, from Tally XML (masters + vouchers). Run: node --test tests/ledger_web
// All names and numbers are made up.
import assert from 'node:assert/strict';
import test from 'node:test';

import { demoSeed } from '../../ledger/js/demo.js';
import { memoryStore } from '../../ledger/js/store.js';
import { shortGroup } from '../../ledger/js/dash.js';
import { mergeTally, parseMasters, parseTallyXml } from '../../ledger/js/tally-file.js';
import { classify, financials, trialSheet } from '../../ledger/js/tally-fin.js';
import { appAccounts, matchEntries, reconcile, reconSheet, similarity } from '../../ledger/js/tally-recon.js';
import { finHtml, reconHtml, stockHtml } from '../../ledger/js/tally-reports.js';
import { sampleTally } from '../../ledger/js/tally-sample.js';
import { lineVolume, packOf, pivotSheet, stockSummary } from '../../ledger/js/tally-stock.js';

// ---- a small hand-made export ------------------------------------------------
const L = (name, amount, list = 'ALLLEDGERENTRIES.LIST') => `<${list}><LEDGERNAME>${name}</LEDGERNAME><AMOUNT>${amount}</AMOUNT></${list}>`;
const V = (type, date, no, party, body) => `<VOUCHER VCHTYPE="${type}"><DATE>${date}</DATE><VOUCHERNUMBER>${no}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>${body}</VOUCHER>`;
const G = (name, parent) => `<GROUP NAME="${name}"><PARENT>${parent || '&#4; Primary'}</PARENT></GROUP>`;
const LED = (name, parent, ob = '0.00') => `<LEDGER NAME="${name}"><PARENT>${parent}</PARENT><OPENINGBALANCE>${ob}</OPENINGBALANCE>
  <BILLALLOCATIONS.LIST><NAME>old bill</NAME><OPENINGBALANCE>-99.00</OPENINGBALANCE></BILLALLOCATIONS.LIST></LEDGER>`;
const ITEM = (name, qty, unit, rate, amount, ledger) => `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${name}</STOCKITEMNAME><RATE>${rate}/${unit}</RATE><AMOUNT>${amount}</AMOUNT>
  <BILLEDQTY> ${qty} ${unit}</BILLEDQTY><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${ledger}</LEDGERNAME><AMOUNT>${amount}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;

const MASTERS = `<ENVELOPE><BODY><SVCURRENTCOMPANY>Demo Fuels (2026-27)</SVCURRENTCOMPANY>
  ${G('Current Assets')}${G('Current Liabilities')}${G('Capital Account')}${G('Sales Accounts')}${G('Purchase Accounts')}${G('Indirect Expenses')}
  ${G('Sundry Debtors', 'Current Assets')}${G('Sundry Creditors', 'Current Liabilities')}${G('Bank Accounts', 'Current Assets')}${G('Cash-in-Hand', 'Current Assets')}
  ${G('RCP COMPANIES', 'Sundry Debtors')}
  <GROUP NAME="Office Costs"><PARENT>&#4; Primary</PARENT><ISREVENUE>Yes</ISREVENUE><AFFECTSGROSSPROFIT>No</AFFECTSGROSSPROFIT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
  ${LED('Demo Power Ltd', 'RCP COMPANIES', '-50000.00')}${LED('Sample Lubes', 'Sundry Creditors', '20000.00')}${LED('Demo Bank', 'Bank Accounts', '-100000.00')}
  ${LED('Cash', 'Cash-in-Hand', '-5000.00')}${LED('Owner Capital', 'Capital Account', '135000.00')}${LED('SALE (HSD)', 'Sales Accounts')}
  ${LED('Purchase (Lubes)', 'Purchase Accounts')}${LED('Rent', 'Indirect Expenses')}${LED('Tea &amp; Snacks', 'Office Costs')}
  <UNIT NAME="Box of 12 Nos"><ISSIMPLEUNIT>No</ISSIMPLEUNIT><BASEUNITS>Box</BASEUNITS><ADDITIONALUNITS>Nos</ADDITIONALUNITS><CONVERSION> 12</CONVERSION></UNIT>
  <STOCKITEM NAME="SERVO 4T 1L"><PARENT>Servo Lubricants</PARENT><BASEUNITS>Nos</BASEUNITS><OPENINGBALANCE> 10 Nos</OPENINGBALANCE><OPENINGVALUE>-3000.00</OPENINGVALUE></STOCKITEM>
</BODY></ENVELOPE>`;

const DAYBOOK = `<ENVELOPE><BODY>
  ${V('HSD CREDIT', '20260410', '101', 'Demo Power Ltd', `${ITEM('High Speed Diesel', 1000, 'LTR', '90.00', '90000.00', 'SALE (HSD)')}${L('Demo Power Ltd', '-90000.00', 'LEDGERENTRIES.LIST')}`)}
  ${V('HSD CREDIT', '20260512', '102', 'Demo Power Ltd', `${ITEM('High Speed Diesel', 500, 'LTR', '91.00', '45500.00', 'SALE (HSD)')}${L('Demo Power Ltd', '-45500.00', 'LEDGERENTRIES.LIST')}`)}
  ${V('Receipt', '20260420', '1', 'Demo Power Ltd', `${L('Demo Power Ltd', '60000.00')}${L('Demo Bank', '-60000.00')}`)}
  ${V('Purchase', '20260415', 'P1', 'Sample Lubes', `${ITEM('SERVO 4T 1L', 2, 'Box', '3480.00', '-6960.00', 'Purchase (Lubes)')}${L('Sample Lubes', '6960.00', 'LEDGERENTRIES.LIST')}`)}
  ${V('Purchase', '20260516', 'P2', 'Sample Lubes', `${ITEM('SERVO 4T 1L', 24, 'Nos', '300.00', '-7200.00', 'Purchase (Lubes)')}${L('Sample Lubes', '7200.00', 'LEDGERENTRIES.LIST')}`)}
  ${V('Debit Note', '20260518', 'DN1', 'Sample Lubes', `${ITEM('SERVO 4T 1L', 4, 'Nos', '300.00', '1200.00', 'Purchase (Lubes)')}${L('Sample Lubes', '-1200.00', 'LEDGERENTRIES.LIST')}`)}
  ${V('Payment', '20260501', '1', 'Rent', `${L('Rent', '-10000.00')}${L('Demo Bank', '10000.00')}`)}
  ${V('Payment', '20260502', '2', 'Tea &amp; Snacks', `${L('Tea &amp; Snacks', '-500.00')}${L('Cash', '500.00')}`)}
  ${V('Contra', '20260503', 'C1', 'Demo Bank', `${L('Demo Bank', '-4000.00')}${L('Cash', '4000.00')}`)}
  ${V('Receipt', '20260520', '2', 'Demo Power Ltd', `${L('Demo Power Ltd', '1000.00')}${L('Demo Power Ltd', '1000.00', 'LEDGERENTRIES.LIST')}${L('Demo Bank', '-1000.00')}`)}
</BODY></ENVELOPE>`;

function small() {
  return mergeTally([{ name: 'masters.xml', ...parseTallyXml(MASTERS) }, { name: 'daybook.xml', ...parseTallyXml(DAYBOOK) }]);
}

test('masters: groups, openings (Dr = +), compound units, stock items', () => {
  const m = parseMasters(MASTERS);
  assert.equal(m.groups.get('current assets').parent, '');
  assert.equal(m.groups.get('rcp companies').parent, 'Sundry Debtors');
  assert.equal(m.ledgers.get('demo power ltd').opening, 50000);           // its own opening, not the bill-wise one
  assert.equal(m.ledgers.get('sample lubes').opening, -20000);
  assert.equal(m.ledgers.get('tea & snacks').name, 'Tea & Snacks');
  assert.deepEqual(m.units.get('BOX OF 12 NOS'), { name: 'Box of 12 Nos', simple: false, base: 'BOX', of: 'NOS', conversion: 12 });
  assert.deepEqual(m.stockItems.get('servo 4t 1l'), { name: 'SERVO 4T 1L', parent: 'Servo Lubricants', unit: 'NOS', openingQty: 10, openingValue: 3000 });
});

test('several files: one voucher list, masters added, nothing counted twice', () => {
  const t = small();
  assert.equal(t.company, 'Demo Fuels (2026-27)');
  assert.equal(t.vouchers.length, 10);
  assert.equal(t.masters.ledgers.size, 9);
  assert.equal(t.vouchers.find((v) => v.type === 'Purchase').items[0].group, 'Servo Lubricants');
  const again = mergeTally([{ name: 'a', ...parseTallyXml(DAYBOOK) }, { name: 'b', ...parseTallyXml(DAYBOOK) }]);
  assert.equal(again.vouchers.length, 10);
  assert.equal(again.duplicates, 10);
  // a voucher listing the party in both ALLLEDGERENTRIES and LEDGERENTRIES counts once
  const r = t.vouchers.find((v) => v.number === '2' && v.kind === 'receipt');
  assert.ok(r.balanced);
  assert.equal(r.ledgers.filter((l) => l.name === 'Demo Power Ltd').length, 1);
});

test('ledgers placed in Tally\'s groups — or guessed without masters', () => {
  const { masters } = small();
  assert.deepEqual(classify('Demo Power Ltd', masters), { cls: 'currentAssets', sub: 'debtors', group: 'RCP COMPANIES', guessed: false });
  assert.equal(classify('Demo Bank', masters).sub, 'bank');
  assert.equal(classify('Tea & Snacks', masters).cls, 'indirectExpense');   // a renamed primary group, by its flags
  assert.equal(classify('SALE (MS)', null).cls, 'sales');
  assert.equal(classify('HDFC Bank A/c', null).sub, 'bank');
  assert.equal(classify('Output CGST', null).sub, 'duties');
  assert.equal(classify('Salary', null).cls, 'indirectExpense');
  assert.equal(classify('Acme Movers', null, { sale: true }).sub, 'debtors');
  assert.equal(classify('Acme Supplies', null, { purchase: true }).sub, 'creditors');
});

test('financials: P&L, stock, balance sheet, month by month, trial balance', () => {
  const { vouchers, masters } = small();
  const f = financials(vouchers, masters, { from: '2026-04-01', to: '2026-05-31' });
  assert.ok(f.exact);
  assert.equal(f.pl.sales, 135500);
  assert.equal(f.pl.purchases, 6960 + 7200 - 1200);
  assert.equal(f.pl.indirectExpense, 10500);
  assert.equal(f.pl.beforeStock, 135500 - 12960);
  assert.equal(f.pl.openingStock, 3000);
  assert.equal(f.pl.gross, null);
  assert.equal(f.pl.net, 135500 - 12960 - 10500);
  const s = financials(vouchers, masters, { from: '2026-04-01', to: '2026-05-31', closingStock: 5000 });
  assert.equal(s.pl.gross, 135500 - 12960 - 3000 + 5000);
  assert.equal(s.pl.net, s.pl.gross - 10500);
  // the balance sheet on 31 May
  assert.equal(f.bs.receivable, 50000 + 90000 + 45500 - 60000 - 1000);
  assert.equal(f.bs.payable, 20000 + 6960 + 7200 - 1200);
  assert.equal(f.bs.bank, 100000 + 60000 - 10000 + 4000 + 1000);
  assert.equal(f.bs.cash, 5000 - 500 - 4000);
  assert.equal(f.bs.capital, 135000);
  // months: the contra between bank and cash isn't money in or out
  const [apr, may] = f.pl.monthly;
  assert.deepEqual([apr.month, apr.sales, apr.purchases, apr.cashIn, apr.cashOut], ['2026-04', 90000, 6960, 60000, 0]);
  assert.deepEqual([may.month, may.sales, may.expenses, may.cashIn, may.cashOut], ['2026-05', 45500, 10500, 1000, 10500]);
  assert.equal(may.liquid, f.bs.liquid);
  assert.equal(f.checks.openingDiff, 0);
  assert.equal(f.checks.trial.diff, 0);
  assert.equal(f.checks.unbalanced, 0);
  assert.deepEqual(f.expenses.map((l) => [l.name, l.amount]), [['Rent', 10000], ['Tea & Snacks', 500]]);
  assert.equal(trialSheet(f)[0][2], 'Ledger');
  // a period inside the file: opening = the masters + everything before it
  const may2 = financials(vouchers, masters, { from: '2026-05-01', to: '2026-05-31' });
  assert.equal(may2.pl.sales, 45500);
  assert.equal(may2.pl.openingStock, null);
  assert.equal(may2.liquidList.find((l) => l.name === 'Demo Bank').openAtFrom, 160000);
});

test('stock: pack sizes from names, compound units, returns, month by month', () => {
  assert.deepEqual(packOf('SERVO 4T XTRA 10W30 900ML'), { size: 0.9, measure: 'L', perCase: null });
  assert.deepEqual(packOf('SERVO PRIDE 15W40 20 LTR'), { size: 20, measure: 'L', perCase: null });
  assert.deepEqual(packOf('SERVOGREASE MP 500 GM'), { size: 0.5, measure: 'KG', perCase: null });
  assert.deepEqual(packOf('SERVO PRIDE TC 15W40 1X12X1L'), { size: 1, measure: 'L', perCase: 12 });
  assert.deepEqual(packOf('Servo 4T 1 L x 20'), { size: 1, measure: 'L', perCase: 20 });
  assert.deepEqual(packOf('SERVO FUTURA G+ 5W30 3.5L'), { size: 3.5, measure: 'L', perCase: null });
  assert.deepEqual(packOf('SERVO HYDRAULIC 68'), { size: null, measure: null, perCase: null });
  assert.equal(lineVolume({ name: 'SERVO 4T 900ML', qty: 24, unit: 'NOS' }).volume, 21.6);
  assert.equal(lineVolume({ name: 'SERVO 20 LTR', qty: 100, unit: 'LTR' }).packs, 5);

  const { vouchers, masters } = small();
  const s = stockSummary(vouchers, masters, { from: '2026-04-01', to: '2026-05-31' });
  assert.equal(s.items.length, 1);
  const it = s.items[0];
  assert.equal(it.group, 'Servo Lubricants');
  assert.equal(it.packs, 24 + 24 - 4);                                    // 2 boxes of 12 (masters' unit), 24, less 4 returned
  assert.equal(it.volume, 44);
  assert.equal(it.amount, 6960 + 7200 - 1200);
  assert.deepEqual(s.months.map((m) => [m.month, m.L, m.amount]), [['2026-04', 24, 6960], ['2026-05', 20, 6000]]);
  assert.deepEqual(s.parties.map((p) => [p.name, p.vouchers, p.amount]), [['Sample Lubes', 3, 12960]]);
  const sheet = pivotSheet(s, ['2026-04', '2026-05'], 'volume');
  assert.deepEqual(sheet[1], ['SERVO 4T 1L', 'Servo Lubricants', '1 L', 24, 20, 44]);
  assert.deepEqual(sheet.at(-1), ['Total', '', '', 24, 20, 44]);
  // an item left out: still listed with its own figures, out of every total
  const out = stockSummary(vouchers, masters, { from: '2026-04-01', to: '2026-05-31', exclude: new Set(['servo 4t 1l']) });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].off, true);
  assert.equal(out.items[0].volume, 44);
  assert.deepEqual([out.totals.amount, out.totals.L, out.totals.packs, out.totals.items, out.totals.off], [0, 0, 0, 0, 1]);
  assert.deepEqual(out.months, []);
  assert.deepEqual(out.parties, []);
  assert.deepEqual(pivotSheet(out, ['2026-04', '2026-05'], 'volume'), [['Item', 'Group', 'Pack', '2026-04', '2026-05', 'Total'], ['Total', '', '', 0, 0, 0]]);
  // fuel
  const fuel = stockSummary(vouchers, masters, { from: '2026-04-01', to: '2026-05-31', kind: 'sale', category: 'fuel' });
  assert.equal(fuel.totals.L, 1500);
});

// ---- the app against Tally ---------------------------------------------------
test('matching entries: bills by number, payments with TDS, amounts by day, one side only', () => {
  const f = matchEntries([
    { date: '2026-04-10', kind: 'bill', number: '101', amount: 1000 },
    { date: '2026-04-11', kind: 'bill', number: '102', amount: 2000 },
    { date: '2026-04-12', kind: 'bill', number: '103', amount: 3000 },
    { date: '2026-04-13', kind: 'bill', number: '104', amount: 4000 },
    { date: '2026-04-14', kind: 'payment', amount: -9000, pay: 'p1' },
    { date: '2026-04-14', kind: 'tds', amount: -90, pay: 'p1' },
    { date: '2026-04-15', kind: 'payment', amount: -500 },
    { date: '2026-04-16', kind: 'bill', number: '105', amount: 700 },
  ], [
    { date: '2026-04-10', kind: 'bill', number: '101', amount: 1000 },                // equal
    { date: '2026-04-11', kind: 'bill', number: '102', amount: 2050 },                // amount
    { date: '2026-04-13', kind: 'bill', number: '103', amount: 3000 },                // date
    { date: '2026-04-14', kind: 'payment', amount: -9090 },                           // payment + TDS together
    { date: '2026-04-17', kind: 'payment', amount: -500 },                            // date, by amount
    { date: '2026-04-16', kind: 'bill', number: '205', amount: 700 },                 // renumbered
    { date: '2026-04-18', kind: 'credit', amount: -250, type: 'Journal' },            // Tally only
  ]);
  assert.deepEqual(f.map((x) => [x.type, x.date, x.effect]), [
    ['amount', '2026-04-11', 50], ['date', '2026-04-12', 0], ['appOnly', '2026-04-13', -4000],
    ['date', '2026-04-15', 0], ['number', '2026-04-16', 0], ['tallyOnly', '2026-04-18', -250],
  ]);
  // TDS booked by journal at the quarter end: one date difference, not two one-sided entries
  const q = matchEntries([{ date: '2026-05-02', kind: 'payment', amount: -50000, pay: 'p1' }, { date: '2026-05-02', kind: 'tds', amount: -500, pay: 'p1' }],
    [{ date: '2026-05-02', kind: 'payment', amount: -50000 }, { date: '2026-06-30', kind: 'credit', amount: -500, type: 'Journal' }]);
  assert.deepEqual(q.map((x) => [x.type, x.effect]), [['date', 0]]);
});

async function demo() {
  const store = memoryStore(demoSeed(new Date(2026, 9, 30)));
  const s = await sampleTally(store, '2026-10-30');
  const t = mergeTally([{ name: 'sample.xml', ...parseTallyXml(s.xml) }]);
  const dash = await store.dashboard(s.to, s.to);
  const st = await store.statementData(s.from, s.to);
  const bulk = await Promise.all(dash.groups.map(async ([code, title]) => ({ code, title: shortGroup(code, title), data: await store.account(null, code, null, null) })));
  return { s, t, dash, accounts: appAccounts(st, bulk, { from: s.from }) };
}

test('Ledger vs Tally: the sample\'s planted differences are found, and add up', async () => {
  const { s, t, dash, accounts } = await demo();
  assert.equal(t.vouchers.filter((v) => !v.balanced).length, 0);
  const res = reconcile(accounts, t.vouchers, t.masters, { asOn: s.to, appCustomers: dash.customers });
  assert.equal(res.totals.notInTally, 0);
  assert.equal(res.tallyOnly.length, 0);
  for (const p of s.planted) {
    const row = res.rows.find((r) => r.acct.id === p.account);
    const hit = row.findings.find((f) => f.type === p.type);
    assert.ok(hit, `${p.account}: ${p.type}`);
    assert.equal(hit.effect, p.effect, `${p.account}: ${p.type} effect`);
    if (p.number) assert.equal((hit.app || hit.tally).number, p.number);
    if (p.type === 'date') assert.deepEqual([hit.app.date, hit.tally.date], [p.appDate, p.tallyDate]);
  }
  for (const r of res.rows) {
    assert.equal(r.residual, 0, r.acct.name);
    assert.equal(Math.round((r.openingDiff + r.findings.filter((f) => f.type !== 'opening').reduce((x, f) => x + f.effect, 0)) * 100) / 100, r.diff);
    assert.equal(r.status, r.findings.length ? (Math.abs(r.diff) >= 0.005 ? 'diff' : 'timing') : 'ok', r.acct.name);
  }
  // Twin Steel's payment with TDS is one receipt in Tally: it matches
  assert.equal(res.rows.find((r) => r.acct.id === 'g:Twin Steel_Bulk').status, 'ok');
  assert.equal(res.totals.diff, Math.round(s.planted.reduce((x, p) => x + p.effect, 0) * 100) / 100);
  // where the difference starts
  const opening = res.rows.find((r) => s.planted.some((p) => p.type === 'opening' && p.account === r.acct.id));
  assert.equal(opening.firstOff, s.from);
  assert.ok(reconSheet(res).length > res.rows.length);
  // an earlier date: the bills after it don't count
  const early = reconcile(accounts, t.vouchers, t.masters, { asOn: '2026-10-05', appCustomers: dash.customers });
  assert.ok(early.rows.every((r) => r.findings.every((f) => f.date <= '2026-10-05')));
});

test('Ledger vs Tally: a renamed ledger is suggested and can be compared; no masters = movement only', async () => {
  const { s, t, dash, accounts } = await demo();
  const name = 'Sample Roadlines';
  const renamed = t.vouchers.map((v) => ({ ...v, party: v.party === name ? 'M/s Sample Roadlines Pvt Ltd' : v.party, ledgers: v.ledgers.map((l) => (l.name === name ? { ...l, name: 'M/s Sample Roadlines Pvt Ltd' } : l)) }));
  const masters = { ...t.masters, ledgers: new Map([...t.masters.ledgers].filter(([k]) => k !== 'sample roadlines')) };
  const res = reconcile(accounts, renamed, masters, { asOn: s.to, appCustomers: dash.customers });
  const row = res.rows.find((r) => r.acct.names.includes(name));
  assert.equal(row.status, 'notInTally');
  assert.equal(row.suggest[0].options[0].name, 'M/s Sample Roadlines Pvt Ltd');
  assert.ok(res.tallyOnly.some((x) => x.name === 'M/s Sample Roadlines Pvt Ltd' && x.inApp === false));
  assert.ok(similarity('Sample Roadlines', 'M/s Sample Roadlines Pvt Ltd') === 1);
  const mapped = reconcile(accounts, renamed, masters, { asOn: s.to, appCustomers: dash.customers, map: { 'sample roadlines': 'M/s Sample Roadlines Pvt Ltd' } });
  assert.notEqual(mapped.rows.find((r) => r.acct.names.includes(name)).status, 'notInTally');

  // without masters: only what happened in the file is compared (the opening difference can't be seen)
  const bare = reconcile(accounts, t.vouchers, null, { asOn: s.to, appCustomers: dash.customers });
  assert.equal(bare.openingKnown, false);
  assert.ok(bare.rows.every((r) => !r.findings.some((f) => f.type === 'opening')));
  assert.ok(bare.rows.find((r) => r.acct.id === 'g:Crew Group_Bulk').findings.some((f) => f.type === 'appOnly'));
});

test('the sample makes sense as a set of books', async () => {
  const { s, t } = await demo();
  const f = financials(t.vouchers, t.masters, { from: s.from, to: s.to });
  assert.ok(f.exact);
  assert.equal(f.checks.openingDiff, 0);
  assert.equal(f.checks.trial.diff, 0);
  assert.equal(f.checks.unknown.length, 0);
  assert.ok(f.pl.sales > f.pl.purchases);
  assert.ok(f.bs.bank > 0);
  const st = stockSummary(t.vouchers, t.masters, { from: s.from, to: s.to });
  assert.equal(st.totals.unknown, 0);
  // leaving one item out takes exactly its figures off the totals, month by month
  const grease = st.items.find((x) => x.name === 'SERVOGREASE MP 500 GM');
  const adblue = st.items.find((x) => x.name === 'ADBLUE 20 LTR');
  const less = stockSummary(t.vouchers, t.masters, { from: s.from, to: s.to, exclude: new Set([adblue.key]) });
  assert.equal(less.totals.amount, Math.round((st.totals.amount - adblue.amount) * 100) / 100);
  assert.equal(less.totals.L, Math.round((st.totals.L - adblue.volume) * 1000) / 1000);
  assert.equal(less.totals.KG, grease.volume);
  assert.equal(less.items.length, st.items.length);
  for (const m of less.months) {
    const was = st.months.find((x) => x.month === m.month);
    const a = adblue.months.get(m.month);
    assert.equal(m.amount, Math.round((was.amount - (a ? a.amount : 0)) * 100) / 100, m.month);
  }
  assert.equal(less.parties[0].amount, Math.round((st.parties[0].amount - adblue.amount) * 100) / 100);
  assert.ok(st.items.find((x) => x.name === 'SERVO PRIDE TC 15W40 1X12X1L').packs % 12 === 0);
});

test('screens render and escape names', async () => {
  const { s, t, dash, accounts } = await demo();
  accounts[0].name = '<i>x</i>';
  const html = [
    finHtml(financials(t.vouchers, t.masters, { from: s.from, to: s.to })),
    reconHtml(reconcile(accounts, t.vouchers, t.masters, { asOn: s.to, appCustomers: dash.customers }), { asOnMax: s.to }),
    stockHtml(stockSummary(t.vouchers, t.masters, { from: s.from, to: s.to }), ['2026-04', '2026-05']),
    stockHtml(stockSummary([], null, { from: s.from, to: s.to }), []),
  ].join('');
  assert.ok(html.includes('&lt;i&gt;x&lt;/i&gt;'));
  assert.ok(!html.includes('<i>x</i>'));
});

// ---- exports that don't cover the whole year, and exports that overlap ------
test('coverage: unbroken from 1 April, a late start, a month left out', async () => {
  const { coverage, gapsIn } = await import('../../ledger/js/tally-file.js');
  const v = (date, cancelled = false) => ({ date, cancelled });
  const days = (from, to) => { const out = []; for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86400000) out.push(v(new Date(d).toISOString().slice(0, 10))); return out; };
  const full = coverage(days('2026-04-03', '2026-10-29'));            // a few days in: still unbroken
  assert.deepEqual([full.complete, full.from, full.gaps.length], [true, '2026-04-01', 0]);
  const late = coverage(days('2026-10-01', '2026-10-29'));
  assert.deepEqual([late.complete, late.from], [false, '2026-10-01']);
  assert.deepEqual(late.gaps, [{ from: '2026-04-01', to: '2026-09-30', days: 183, start: true }]);
  const hole = coverage([...days('2026-04-01', '2026-06-30'), ...days('2026-10-01', '2026-10-29')]);
  assert.deepEqual([hole.complete, hole.from], [false, '2026-10-01']);
  assert.deepEqual(hole.gaps, [{ from: '2026-07-01', to: '2026-09-30', days: 92, start: false }]);
  assert.equal(gapsIn(hole, '2026-08-01', '2026-08-31').length, 1);
  assert.equal(gapsIn(hole, '2026-05-01', '2026-05-31').length, 0);
  // up to a date: what comes after it doesn't matter
  assert.equal(coverage([...days('2026-04-01', '2026-06-30'), ...days('2026-10-01', '2026-10-29')], { to: '2026-06-30' }).complete, true);
  // a quiet week is not a gap; cancelled vouchers don't count as entries
  assert.equal(coverage([...days('2026-04-01', '2026-04-10'), ...days('2026-04-18', '2026-04-30')]).complete, true);
  assert.equal(coverage([...days('2026-04-01', '2026-04-10'), v('2026-04-15', true), ...days('2026-04-19', '2026-04-30')]).complete, false);
});

test('overlapping exports: a voucher edited in Tally keeps only its latest version', () => {
  const vch = (alter, amount) => `<VOUCHER VCHTYPE="HSD CREDIT"><DATE>20261010</DATE><GUID>g-101</GUID><ALTERID> ${alter}</ALTERID><VOUCHERNUMBER>101</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Demo Power Ltd</PARTYLEDGERNAME>${ITEM('High Speed Diesel', 1000, 'LTR', '90.00', `${amount}.00`, 'SALE (HSD)')}${L('Demo Power Ltd', `-${amount}.00`, 'LEDGERENTRIES.LIST')}</VOUCHER>`;
  const other = `<VOUCHER VCHTYPE="Receipt"><DATE>20261011</DATE><GUID>g-r1</GUID><ALTERID> 5</ALTERID><VOUCHERNUMBER>1</VOUCHERNUMBER><PARTYLEDGERNAME>Demo Power Ltd</PARTYLEDGERNAME>${L('Demo Power Ltd', '5000.00')}${L('Demo Bank', '-5000.00')}</VOUCHER>`;
  const older = { name: 'oct-1-15.xml', ...parseTallyXml(`<ENVELOPE>${vch(7, 90000)}${other}</ENVELOPE>`) };
  const newer = { name: 'oct-10-31.xml', ...parseTallyXml(`<ENVELOPE>${vch(9, 91000)}${other}</ENVELOPE>`) };
  for (const files of [[older, newer], [newer, older]]) {                // whichever order they're chosen in
    const t = mergeTally(files);
    assert.equal(t.vouchers.length, 2);
    assert.equal(t.duplicates, 2);
    assert.equal(t.vouchers.find((x) => x.number === '101').amount, 91000);
  }
  assert.equal(mergeTally([older, newer]).replaced, 1);
});

test('Ledger vs Tally with only part of the year: compares from where the files are unbroken', async () => {
  const { s, t, dash, accounts } = await demo();
  const { reconStart } = await import('../../ledger/js/tally-recon.js');
  // only October (the masters still in): nothing before 1 Oct may be taken for missing
  const oct = t.vouchers.filter((x) => x.date >= '2026-10-01');
  const st = reconStart(oct, t.masters, s.to);
  assert.deepEqual([st.openingKnown, st.start], [false, '2026-10-01']);
  const store = memoryStore(demoSeed(new Date(2026, 9, 30)));
  const statement = await store.statementData(st.start, s.to);
  const bulk = await Promise.all(dash.groups.map(async ([code, title]) => ({ code, title: shortGroup(code, title), data: await store.account(null, code, null, null) })));
  const accts = appAccounts(statement, bulk, { from: st.start });
  const res = reconcile(accts, oct, t.masters, { asOn: s.to, appCustomers: dash.customers });
  assert.equal(res.openingKnown, false);
  assert.equal(res.start, '2026-10-01');
  for (const r of res.rows) {
    assert.ok(r.findings.every((f) => f.date >= '2026-10-01' && f.type !== 'opening'), r.acct.name);
    assert.equal(r.residual, 0);
  }
  // the planted differences in October are still found
  for (const p of s.planted.filter((x) => x.type !== 'opening')) {
    assert.ok(res.rows.find((r) => r.acct.id === p.account).findings.some((f) => f.type === p.type), `${p.account} ${p.type}`);
  }
  // a stretch left out in the middle: compared from after it
  const holed = t.vouchers.filter((x) => x.date < '2026-07-01' || x.date > '2026-09-30');
  assert.equal(reconStart(holed, t.masters, s.to).start, '2026-10-01');
  // whole year: whole balances, as before
  assert.deepEqual(reconStart(t.vouchers, t.masters, s.to), { cov: reconStart(t.vouchers, t.masters, s.to).cov, openingKnown: true, start: s.from });
  assert.equal(accounts.length, accts.length);
});

test('financials with part of the year: the P&L stands, balances are flagged', async () => {
  const { s, t } = await demo();
  const full = financials(t.vouchers, t.masters, { from: s.from, to: s.to });
  assert.equal(full.covered.balances, true);
  assert.deepEqual(full.covered.periodGaps, []);
  const holed = t.vouchers.filter((x) => x.date < '2026-07-01' || x.date > '2026-09-30');
  const f = financials(holed, t.masters, { from: s.from, to: s.to });
  assert.equal(f.covered.balances, false);
  assert.deepEqual(f.covered.periodGaps.map((g) => [g.from, g.to]), [['2026-07-01', '2026-09-30']]);
  const html = finHtml(f);
  assert.ok(html.includes('Balances here are short'));
  assert.ok(html.includes('no vouchers 1 Jul – 30 Sep'));
  // October alone: its P&L has no gap; the balances are flagged
  const oct = financials(t.vouchers.filter((x) => x.date >= '2026-10-01'), t.masters, { from: '2026-10-01', to: s.to });
  assert.deepEqual(oct.covered.periodGaps, []);
  assert.equal(oct.covered.balances, false);
  assert.ok(reconHtml(reconcile([], t.vouchers.filter((x) => x.date >= '2026-10-01'), t.masters, { asOn: s.to }), { appUntil: '2026-10-20' })
    .includes('nothing before 1 Oct'));
});
