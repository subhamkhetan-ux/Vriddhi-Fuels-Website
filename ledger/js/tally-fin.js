// Company financials from a Tally file: every ledger's opening, debits,
// credits and closing, grouped the way Tally groups them, then the profit
// and loss, the balance sheet as on a date, month-by-month figures and a few
// ratios. Pure — no DOM.
//
// Signs: + = Dr (an asset, an expense, what a customer owes), − = Cr.
// Tally's XML is the other way round (negative = Dr); tally-file.js keeps
// Tally's sign on voucher lines, so they are turned round here.
//
// Groups come from the masters (All Masters export). Without them, a ledger
// is placed by its name and use (the party of a sale = a debtor, …) and the
// figures are marked as estimated.

import { coverage, fyStartOf, gapsIn, hasMasters, normName } from './tally-file.js';

const round2 = (n) => Math.round(n * 100) / 100 + 0;          // + 0: no −0

// Tally's primary groups (and the names Tally Prime shows for them)
const PRIMARY = {
  'capital account': 'capital',
  'loans (liability)': 'loans',
  'current liabilities': 'currentLiabilities',
  'fixed assets': 'fixedAssets',
  investments: 'investments',
  'current assets': 'currentAssets',
  'branch / divisions': 'branch',
  'misc. expenses (asset)': 'miscAsset',
  'suspense a/c': 'suspense',
  'sales accounts': 'sales',
  'purchase accounts': 'purchases',
  'direct incomes': 'directIncome',
  'income (direct)': 'directIncome',
  'direct expenses': 'directExpense',
  'expenses (direct)': 'directExpense',
  'indirect incomes': 'indirectIncome',
  'income (indirect)': 'indirectIncome',
  'indirect expenses': 'indirectExpense',
  'expenses (indirect)': 'indirectExpense',
};
// Tally's reserved sub-groups
const SUB = {
  'bank accounts': 'bank',
  'bank od a/c': 'bankOd',
  'bank occ a/c': 'bankOd',
  'cash-in-hand': 'cash',
  'sundry debtors': 'debtors',
  'sundry creditors': 'creditors',
  'duties & taxes': 'duties',
  'stock-in-hand': 'stock',
  'deposits (asset)': 'deposits',
  'loans & advances (asset)': 'advances',
  provisions: 'provisions',
  'reserves & surplus': 'reserves',
  'secured loans': 'loans',
  'unsecured loans': 'loans',
};
const SUB_CLASS = {
  bank: 'currentAssets', cash: 'currentAssets', debtors: 'currentAssets', stock: 'currentAssets', deposits: 'currentAssets', advances: 'currentAssets',
  bankOd: 'loans', creditors: 'currentLiabilities', duties: 'currentLiabilities', provisions: 'currentLiabilities', reserves: 'capital', loans: 'loans',
};
export const CLASS_NAME = {
  capital: 'Capital', loans: 'Loans', currentLiabilities: 'Current liabilities', fixedAssets: 'Fixed assets', investments: 'Investments',
  currentAssets: 'Current assets', branch: 'Branch / divisions', miscAsset: 'Misc. expenses (asset)', suspense: 'Suspense',
  sales: 'Sales', purchases: 'Purchases', directIncome: 'Direct income', directExpense: 'Direct expenses',
  indirectIncome: 'Indirect income', indirectExpense: 'Indirect expenses', unknown: 'Not classified',
};
export const PL_CLASSES = ['sales', 'purchases', 'directIncome', 'directExpense', 'indirectIncome', 'indirectExpense'];

const BANKS = /\bBANK\b|\bHDFC\b|\bSBI\b|\bICICI\b|\bAXIS\b|\bKOTAK\b|\bPNB\b|\bCANARA\b|\bUCO\b|\bIDBI\b|\bBOB\b|\bINDUSIND\b|\bFEDERAL\b|\bUNION BANK\b|\bYES BANK\b|\bIDFC\b|\bRBL\b|\bO\.?D\.? A\/?C\b|\bC\.?C\.? A\/?C\b/;

// Where a ledger sits: {cls, sub, group, guessed}
export function classify(name, masters, usage = {}) {
  const led = masters && masters.ledgers.get(normName(name));
  if (led) {
    let g = led.parent;
    let sub = null;
    let top = null;
    const seen = new Set();
    while (g && !seen.has(normName(g))) {
      const key = normName(g);
      seen.add(key);
      if (!sub && SUB[key]) sub = SUB[key];
      top = g;
      const grp = masters.groups.get(key);
      if (!grp || !grp.parent) break;
      g = grp.parent;
    }
    let cls = top ? PRIMARY[normName(top)] : null;
    if (!cls && top) {
      // a renamed primary group: Tally's own flags say what it is
      const grp = masters.groups.get(normName(top));
      if (grp) {
        if (grp.revenue) cls = grp.grossProfit ? (grp.debit ? 'directExpense' : 'directIncome') : (grp.debit ? 'indirectExpense' : 'indirectIncome');
        else cls = grp.debit ? 'currentAssets' : 'currentLiabilities';
      }
    }
    if (!cls && sub) cls = SUB_CLASS[sub];
    return { cls: cls || 'unknown', sub, group: led.parent || '', guessed: false };
  }
  return { ...guess(name, usage), group: '', guessed: true };
}

// no masters: by the ledger's name and how the vouchers use it
function guess(name, usage) {
  const s = String(name || '').toUpperCase();
  if (/\bCASH\b/.test(s) && !/DISCOUNT|SALE/.test(s)) return { cls: 'currentAssets', sub: 'cash' };
  if (/\bSALES?\b/.test(s) && !/RETURN/.test(s)) return { cls: 'sales', sub: null };
  if (/\bPURCHASES?\b/.test(s)) return { cls: 'purchases', sub: null };
  if (/\bC\s?GST\b|\bS\s?GST\b|\bI\s?GST\b|\bUTGST\b|\bCESS\b|\bTDS\b|\bTCS\b|\bGST\b|\bVAT\b/.test(s)) return { cls: 'currentLiabilities', sub: 'duties' };
  if (BANKS.test(s)) return { cls: 'currentAssets', sub: 'bank' };
  if (/R\/?\s?OFF|ROUND/.test(s)) return { cls: 'indirectExpense', sub: null };
  if (/\bCAPITAL\b|\bDRAWINGS?\b/.test(s)) return { cls: 'capital', sub: null };
  if (/\bLOAN\b/.test(s)) return { cls: 'loans', sub: null };
  if (/INTEREST RECEIVED|COMMISSION|DISCOUNT RECEIVED|INCOME|INCENTIVE/.test(s)) return { cls: 'indirectIncome', sub: null };
  if (/SALAR|WAGES|RENT|ELECTRIC|EXPENSE|CHARGES|FREIGHT|REPAIR|INTEREST|TELEPHONE|MOBILE|PRINTING|STATIONERY|INSURANCE|FEES|BONUS|FUEL EXP|CONVEYANCE|DEPRECIATION|AUDIT|STAFF|MAINTENANCE|DISCOUNT/.test(s)) return { cls: 'indirectExpense', sub: null };
  if (usage.sale && !usage.purchase) return { cls: 'currentAssets', sub: 'debtors' };
  if (usage.purchase && !usage.sale) return { cls: 'currentLiabilities', sub: 'creditors' };
  if (usage.receipt) return { cls: 'currentAssets', sub: 'debtors' };
  if (usage.payment) return { cls: 'indirectExpense', sub: null };
  return { cls: 'unknown', sub: null };
}

const monthOf = (d) => d.slice(0, 7);
export function monthsBetween(from, to) {
  const out = [];
  for (let m = monthOf(from); m <= monthOf(to);) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

// Every ledger's figures for from..to. Openings from the masters apply at
// the start of the financial year of the file's first voucher.
export function ledgerBook(vouchers, masters, { from, to }) {
  const usage = new Map();
  for (const v of vouchers) {
    if (!v.party || v.cancelled) continue;
    const u = usage.get(normName(v.party)) || {};
    u[v.kind] = true;
    usage.set(normName(v.party), u);
  }
  const book = new Map();
  const get = (name) => {
    const k = normName(name);
    if (!book.has(k)) {
      const m = masters && masters.ledgers.get(k);
      book.set(k, {
        name: m ? m.name : name, ...classify(name, masters, usage.get(k)), opening: m ? m.opening : 0,
        before: 0, dr: 0, cr: 0, months: new Map(), entries: 0, last: null,
      });
    }
    return book.get(k);
  };
  if (masters) for (const l of masters.ledgers.values()) get(l.name);
  const months = monthsBetween(from, to);
  for (const v of vouchers) {
    if (v.cancelled || v.optional || v.date > to) continue;
    for (const l of v.ledgers) {
      const x = get(l.name);
      const amt = -l.amount;                                 // + = Dr
      if (v.date < from) { x.before += amt; continue; }
      if (amt > 0) x.dr += amt; else x.cr -= amt;
      const mk = monthOf(v.date);
      const mm = x.months.get(mk) || { dr: 0, cr: 0 };
      if (amt > 0) mm.dr += amt; else mm.cr -= amt;
      x.months.set(mk, mm);
      x.entries += 1;
      if (!x.last || v.date > x.last) x.last = v.date;
    }
  }
  for (const x of book.values()) {
    x.openAtFrom = round2(x.opening + x.before);
    x.net = round2(x.dr - x.cr);
    x.closing = round2(x.openAtFrom + x.net);
  }
  return { ledgers: [...book.values()], months };
}

// The financial picture for from..to.
//   closingStock: the value of stock on `to` (Tally works it out from the
//   inventory; the file doesn't carry it), when known
export function financials(vouchers, masters, { from, to, closingStock = null } = {}) {
  const exact = hasMasters(masters);
  const { ledgers, months } = ledgerBook(vouchers, masters, { from, to });
  const of = (cls) => ledgers.filter((l) => l.cls === cls);
  const sum = (list, f) => round2(list.reduce((s, l) => s + f(l), 0));
  const flow = (cls, sign) => sum(of(cls), (l) => sign * l.net);   // income: Cr − Dr

  const pl = {
    sales: flow('sales', -1),
    purchases: flow('purchases', 1),
    directIncome: flow('directIncome', -1),
    directExpense: flow('directExpense', 1),
    indirectIncome: flow('indirectIncome', -1),
    indirectExpense: flow('indirectExpense', 1),
  };
  // opening stock: the stock items' opening value, else the Stock-in-Hand ledgers'
  const items = masters ? [...masters.stockItems.values()] : [];
  const fyStart = vouchers.length ? fyStartOf(vouchers[0].date) : from;
  const stockLedgers = ledgers.filter((l) => l.sub === 'stock');
  const openingStock = from <= fyStart
    ? (items.some((i) => i.openingValue) ? round2(items.reduce((s, i) => s + i.openingValue, 0)) : sum(stockLedgers, (l) => l.opening))
    : null;
  pl.beforeStock = round2(pl.sales + pl.directIncome - pl.purchases - pl.directExpense);
  pl.openingStock = openingStock;
  pl.closingStock = closingStock;
  pl.gross = closingStock != null && openingStock != null ? round2(pl.beforeStock - openingStock + closingStock) : null;
  const gross = pl.gross ?? pl.beforeStock;
  pl.net = round2(gross + pl.indirectIncome - pl.indirectExpense);
  pl.withStock = pl.gross != null;

  // balance sheet as on `to`
  const bySub = (sub) => ledgers.filter((l) => l.sub === sub);
  const debtors = bySub('debtors');
  const creditors = bySub('creditors');
  const bs = {
    cash: sum(bySub('cash'), (l) => l.closing),
    bank: sum(bySub('bank'), (l) => l.closing),
    bankOd: 0 - sum(bySub('bankOd'), (l) => l.closing),
    receivable: sum(debtors.filter((l) => l.closing > 0), (l) => l.closing),
    advancesFromCustomers: 0 - sum(debtors.filter((l) => l.closing < 0), (l) => l.closing),
    payable: 0 - sum(creditors.filter((l) => l.closing < 0), (l) => l.closing),
    advancesToSuppliers: sum(creditors.filter((l) => l.closing > 0), (l) => l.closing),
    duties: 0 - sum(bySub('duties'), (l) => l.closing),                  // + = payable
    loans: 0 - sum(of('loans'), (l) => l.closing),
    capital: 0 - sum(of('capital'), (l) => l.closing),
    fixedAssets: sum(of('fixedAssets'), (l) => l.closing),
    investments: sum(of('investments'), (l) => l.closing),
    currentAssets: sum(of('currentAssets'), (l) => l.closing),
    currentLiabilities: 0 - sum(of('currentLiabilities'), (l) => l.closing),
  };
  bs.liquid = round2(bs.cash + bs.bank - bs.bankOd);
  bs.workingCapital = round2(bs.currentAssets - bs.currentLiabilities);

  // month by month
  const liquidSubs = new Set(['cash', 'bank', 'bankOd']);
  const liquidNames = new Set(ledgers.filter((l) => liquidSubs.has(l.sub)).map((l) => normName(l.name)));
  const monthly = months.map((m) => {
    const net = (cls, sign) => round2(of(cls).reduce((s, l) => { const x = l.months.get(m); return s + (x ? sign * (x.dr - x.cr) : 0); }, 0));
    return {
      month: m,
      sales: net('sales', -1),
      purchases: net('purchases', 1),
      expenses: round2(net('directExpense', 1) + net('indirectExpense', 1)),
      income: round2(net('directIncome', -1) + net('indirectIncome', -1)),
      cashIn: 0,
      cashOut: 0,
      liquid: 0,
    };
  });
  pl.monthly = monthly;
  for (const x of monthly) x.result = round2(x.sales + x.income - x.purchases - x.expenses);
  // money in and out of cash and bank — not counting transfers between them
  const idx = new Map(months.map((m, i) => [m, i]));
  let liquid = sum(ledgers.filter((l) => liquidSubs.has(l.sub)), (l) => l.openAtFrom);
  for (const v of vouchers) {
    if (v.cancelled || v.optional || v.date < from || v.date > to) continue;
    const mine = v.ledgers.filter((l) => liquidNames.has(normName(l.name)));
    if (!mine.length || mine.length === v.ledgers.length) continue;
    const m = monthly[idx.get(monthOf(v.date))];
    for (const l of mine) {
      if (l.amount < 0) m.cashIn += -l.amount; else m.cashOut += l.amount;
    }
  }
  for (const x of monthly) {
    x.cashIn = round2(x.cashIn);
    x.cashOut = round2(x.cashOut);
    liquid = round2(liquid + x.cashIn - x.cashOut);
    x.liquid = liquid;
  }

  // lists
  const byNet = (list, sign) => list.map((l) => ({ ...l, amount: round2(sign * l.net) })).filter((l) => Math.abs(l.amount) >= 0.5).sort((a, b) => b.amount - a.amount);
  const expenses = byNet([...of('directExpense'), ...of('indirectExpense')], 1);
  const incomes = byNet([...of('directIncome'), ...of('indirectIncome')], -1);
  const salesLedgers = byNet(of('sales'), -1);
  const purchaseLedgers = byNet(of('purchases'), 1);
  const liquidList = ledgers.filter((l) => liquidSubs.has(l.sub) && (l.openAtFrom || l.dr || l.cr || l.closing))
    .sort((a, b) => b.closing - a.closing);
  const topDebtors = debtors.filter((l) => l.closing >= 0.5).sort((a, b) => b.closing - a.closing);
  const topCreditors = creditors.filter((l) => l.closing <= -0.5).sort((a, b) => a.closing - b.closing);
  const duties = bySub('duties').filter((l) => Math.abs(l.closing) >= 0.5 || l.dr || l.cr).sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));

  // ratios
  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);
  const collected = round2(debtors.reduce((s, l) => s + l.cr, 0));
  const ratios = {
    grossMargin: pl.sales ? gross / pl.sales : null,
    netMargin: pl.sales ? pl.net / pl.sales : null,
    expenseRatio: pl.sales ? (pl.indirectExpense + pl.directExpense) / pl.sales : null,
    collection: pl.sales ? collected / pl.sales : null,
    debtorDays: pl.sales ? bs.receivable / (pl.sales / days) : null,
    creditorDays: pl.purchases ? bs.payable / (pl.purchases / days) : null,
    currentRatio: bs.currentLiabilities > 0 ? bs.currentAssets / bs.currentLiabilities : null,
  };

  // things to check
  const openingDiff = masters && masters.ledgers.size ? round2([...masters.ledgers.values()].reduce((s, l) => s + l.opening, 0)) : null;
  const unbalanced = vouchers.filter((v) => v.balanced === false && !v.cancelled && v.ledgers.length > 1).length;
  const unknown = ledgers.filter((l) => l.cls === 'unknown' && (l.dr || l.cr || l.closing));
  const trial = {
    dr: sum(ledgers.filter((l) => l.closing > 0), (l) => l.closing),
    cr: 0 - sum(ledgers.filter((l) => l.closing < 0), (l) => l.closing),
  };
  trial.diff = round2(trial.dr - trial.cr);

  // closing balances (balance sheet, cash & bank, debtors) are the masters'
  // openings plus every voucher since 1 April: right only when the files run
  // unbroken from then; the P&L only needs the period itself
  const cov = coverage(vouchers, { to });
  const covered = {
    balances: exact && Boolean(cov && cov.complete),
    gaps: cov ? cov.gaps : [],
    periodGaps: gapsIn(cov, from, to).map((g) => ({ ...g, from: g.from < from ? from : g.from, to: g.to > to ? to : g.to })),
    from: cov ? cov.from : from,
    first: cov ? cov.first : from,
  };

  return {
    from, to, days, exact, pl, bs, ratios, months, covered,
    expenses, incomes, salesLedgers, purchaseLedgers, liquidList, topDebtors, topCreditors, duties, debtorsCount: topDebtors.length,
    checks: { openingDiff, unbalanced, unknown, trial, guessed: !exact },
    ledgers,
  };
}

// The trial balance rows: [class, group, ledger, opening, Dr, Cr, closing]
export function trialSheet(f) {
  const head = ['Class', 'Group', 'Ledger', 'Opening (Dr+)', 'Debit', 'Credit', 'Closing (Dr+)'];
  const order = Object.keys(CLASS_NAME);
  const rows = f.ledgers.filter((l) => l.openAtFrom || l.dr || l.cr || l.closing)
    .sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
    .map((l) => [CLASS_NAME[l.cls], l.group || (l.sub || ''), l.name, l.openAtFrom, round2(l.dr), round2(l.cr), l.closing]);
  return [head, ...rows];
}
