// Vehicle loans (EMIs): the banks' repayment schedules, read from their PDFs
// (the text, as pdf.js gives it), and where each loan stands today.
//   parseSchedule()  a schedule's text → the loan: bank, account no., amount,
//                    rate, tenure, EMI and every instalment (HDFC's
//                    "Repayment Schedule" and ICICI's "Amortisation schedule")
//   loanStatus()     as of today: every instalment due till today is paid
//                    unless marked not paid; principal and interest paid and
//                    still to pay, the next EMI, what's overdue
//   loansSummary()   the fleet and each bank, and month by month
//   loanFromTerms()  a loan typed in (when the bank's PDF is a scan with no
//                    text): its schedule worked out from the amount, EMI,
//                    number of EMIs, first EMI date and — to match the bank
//                    to the rupee — the last EMI
//   suggestTrucks()  which truck a new loan is probably for, from the EMI the
//                    Trip Register charges each truck a month
// A loan as kept in Setup (settings.loans): { lan, bank, veh, amount, rate,
// rateFrom: 'schedule' | 'derived', tenure, emi, dueDay, file, rows:
// [{ n, date, emi, principal, interest, closing }], unpaid: [n, …] }. Pure functions.

// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st
export const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const amt = (s) => Number(String(s).replace(/,/g, ''));
const r2 = (n) => Math.round(n * 100) / 100;

// 05/08/2025 or 07-Aug-2025 → 2025-08-05 / 2025-08-07
function isoOf(s) {
  const m = String(s).trim().match(/^(\d{1,2})[/-](\d{1,2}|[A-Za-z]{3})[/-](\d{4})$/);
  if (!m) return null;
  const mon = /^\d+$/.test(m[2]) ? Number(m[2]) : MON[m[2].toLowerCase()];
  if (!mon || mon > 12) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}
const NUM = '([\\d,]+(?:\\.\\d+)?)';
// a row: no., due date, (a cheque / mode column like "SI", on some), EMI, principal, interest, balance
const ROW = new RegExp(`^\\s*(\\d{1,3})\\s+(\\d{1,2}[/-](?:\\d{1,2}|[A-Za-z]{3})[/-]\\d{4})(?:\\s+[A-Z]{1,6})?\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s*$`);
const mode = (xs) => {
  const c = new Map();
  xs.forEach((x) => c.set(x, (c.get(x) || 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// text: the PDF's text, a line a row of the table → { …loan } or { error }
export function parseSchedule(text, { fileName = '' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const byN = new Map();
  for (const line of lines) {
    const m = line.match(ROW);
    if (!m) continue;
    const date = isoOf(m[2]);
    if (!date) continue;
    const n = Number(m[1]);
    if (!byN.has(n)) byN.set(n, { n, date, emi: amt(m[3]), principal: amt(m[4]), interest: amt(m[5]), closing: amt(m[6]) });
  }
  const rows = [...byN.values()].sort((a, b) => a.n - b.n);
  if (rows.length < 3) return { error: `No repayment schedule found in ${fileName || 'the file'} — is it the bank's repayment / amortisation schedule?` };
  const all = lines.join('\n');
  const bank = /\bHDFC\b/i.test(all) ? 'HDFC' : /\bICICI\b/i.test(all) ? 'ICICI' : /\bAXIS\b/i.test(all) ? 'Axis' : /\bSBI\b|State Bank/i.test(all) ? 'SBI' : '';
  const lan = (all.match(/(?:Agreement No\.?|LAN Number|Loan Account Number(?:\s*\(LAN\))?|Loan A\/?c(?:count)? No\.?)\s*:?\s*([A-Z0-9][A-Z0-9-]{5,})/i) || [])[1]
    || String(fileName).replace(/\.pdf$/i, '');
  const amountM = all.match(/(?:Amount Financed|Loan Amount|Principal amount of the facility|Sanctioned Amount)\s*:?\s*(?:₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d+)?)/i);
  const principalSum = rows.reduce((a, r) => a + r.principal, 0);
  const amount = amountM ? amt(amountM[1]) : r2(principalSum);
  const rateM = all.match(/Rate of Interest[^:\d\n]*:?\s*([\d.]+)\s*%?/i);
  // no rate printed (HDFC): the second month's interest on the first month's balance, a year
  const derived = rows[1] && rows[0].closing ? r2((rows[1].interest / rows[0].closing) * 1200) : null;
  const rate = rateM ? Number(rateM[1]) : derived;
  const warnings = [];
  if (Math.abs(principalSum - amount) > 5) warnings.push(`the instalments' principal adds up to ₹${Math.round(principalSum).toLocaleString('en-IN')}, not the ₹${Math.round(amount).toLocaleString('en-IN')} lent — a page missing?`);
  if (rows[rows.length - 1].closing > 5) warnings.push('the last instalment doesn\'t close the loan — a page missing?');
  const gaps = rows.filter((r, i) => i && r.n !== rows[i - 1].n + 1).length;
  if (gaps || rows[0].n !== 1) warnings.push('instalment numbers skip — a page missing?');
  return {
    lan, bank, amount, rate, rateFrom: rateM ? 'schedule' : 'derived', tenure: rows.length, emi: mode(rows.map((r) => r.emi)),
    dueDay: Number(mode(rows.map((r) => r.date.slice(8, 10)))), first: rows[0].date, last: rows[rows.length - 1].date,
    file: fileName, rows, unpaid: [], warnings,
  };
}

// a loan as of today: every instalment due on or before today is paid unless marked not paid
export function loanStatus(loan, today) {
  const unpaid = new Set(loan.unpaid || []);
  const rows = (loan.rows || []).map((r) => ({ ...r, status: r.date > today ? 'upcoming' : unpaid.has(r.n) ? 'unpaid' : 'paid' }));
  const sum = (xs, k) => r2(xs.reduce((a, r) => a + (r[k] || 0), 0));
  const paid = rows.filter((r) => r.status === 'paid');
  const overdue = rows.filter((r) => r.status === 'unpaid');
  const upcoming = rows.filter((r) => r.status === 'upcoming');
  const amount = loan.amount || sum(rows, 'principal');
  const totalInterest = sum(rows, 'interest');
  const principalPaid = sum(paid, 'principal');
  const interestPaid = sum(paid, 'interest');
  return {
    loan, rows, amount, totalInterest, totalPayable: r2(amount + totalInterest),
    paidN: paid.length, dueN: paid.length + overdue.length, tenure: rows.length,
    principalPaid, interestPaid, emiPaid: r2(principalPaid + interestPaid),
    principalLeft: r2(amount - principalPaid), interestLeft: r2(totalInterest - interestPaid),
    overdueN: overdue.length, overdueAmt: sum(overdue, 'emi'), overdue,
    next: upcoming[0] || null, upcomingN: upcoming.length, ends: rows.length ? rows[rows.length - 1].date : null,
    done: !upcoming.length && !overdue.length,
  };
}

// the fleet, each bank and each month (of every loan's schedule)
export function loansSummary(loans, today) {
  const S = loans.map((l) => loanStatus(l, today));
  const add = (list) => {
    const s = { loans: list.length, amount: 0, totalInterest: 0, principalPaid: 0, interestPaid: 0, principalLeft: 0, interestLeft: 0, overdueN: 0, overdueAmt: 0, paidN: 0, dueN: 0, tenure: 0, emi: 0 };
    for (const x of list) {
      for (const k of ['amount', 'totalInterest', 'principalPaid', 'interestPaid', 'principalLeft', 'interestLeft', 'overdueN', 'overdueAmt', 'paidN', 'dueN', 'tenure']) s[k] += x[k];
      if (!x.done) s.emi += x.loan.emi || (x.next ? x.next.emi : 0);          // each running loan's regular EMI
    }
    for (const k of Object.keys(s)) s[k] = r2(s[k]);
    s.ends = list.map((x) => x.ends).filter(Boolean).sort().pop() || null;
    s.next = list.map((x) => x.next).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
    return s;
  };
  const banks = [...new Set(S.map((x) => x.loan.bank || 'Other'))].sort();
  const months = new Map();
  for (const x of S) {
    for (const r of x.rows) {
      const m = r.date.slice(0, 7);
      if (!months.has(m)) months.set(m, { month: m, principal: 0, interest: 0, emi: 0, past: r.date <= today, unpaid: 0 });
      const o = months.get(m);
      o.principal = r2(o.principal + r.principal);
      o.interest = r2(o.interest + r.interest);
      o.emi = r2(o.emi + r.emi);
      if (r.status === 'unpaid') o.unpaid += 1;
    }
  }
  const thisMonth = today.slice(0, 7);
  return {
    loans: S, total: add(S), banks: banks.map((b) => ({ bank: b, ...add(S.filter((x) => (x.loan.bank || 'Other') === b)) })),
    months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    thisMonth: months.get(thisMonth) || null,
  };
}

// trucks for loans not yet given one: a truck's bank by the EMI its trips are charged a month in the
// Trip Register (its Installment column, added up a month) — the same EMI ±2% — then in order (account
// no. ↔ truck no.) among that bank's trucks not on a loan yet. → Map(lan → veh)
export function suggestTrucks(loans, trips = []) {
  const perMonth = new Map();
  for (const t of trips) {
    if (!t.emi || !t.month) continue;
    if (!perMonth.has(t.veh)) perMonth.set(t.veh, new Map());
    const m = perMonth.get(t.veh);
    m.set(t.month, (m.get(t.month) || 0) + t.emi);
  }
  const usual = new Map();
  for (const [veh, m] of perMonth) {
    const xs = [...m.values()].sort((a, b) => a - b);
    usual.set(veh, xs[xs.length >> 1]);
  }
  const taken = new Set(loans.map((l) => l.veh).filter(Boolean));
  const out = new Map();
  for (const l of [...loans].filter((x) => !x.veh).sort((a, b) => String(a.lan).localeCompare(String(b.lan)))) {
    const free = [...usual.entries()].filter(([veh, e]) => !taken.has(veh) && l.emi && Math.abs(e - l.emi) <= 0.02 * l.emi).map(([veh]) => veh).sort();
    if (free.length) { out.set(l.lan, free[0]); taken.add(free[0]); }
  }
  return out;
}

// ---- a loan from its terms ---------------------------------------------------------------------
// The banks work a schedule like this: each month's interest is the balance × the monthly rate,
// rounded to the rupee; the rest of the EMI is principal; the last EMI is whatever clears the
// balance. The rate comes from the last EMI when it's given (that pins it to the bank's own,
// to within a rupee a row), else from the rate given, else from the EMI (the annuity formula).
const sameDayMonthsOn = (iso, k) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
function amortise(amount, emi, tenure, r, first) {
  let bal = amount;
  const rows = [];
  for (let n = 1; n <= tenure; n++) {
    const interest = Math.round(bal * r);
    const principal = n === tenure ? bal : Math.min(bal, emi - interest);
    bal = r2(bal - principal);
    rows.push({ n, date: sameDayMonthsOn(first, n - 1), emi: r2(principal + interest), principal: r2(principal), interest, closing: Math.max(0, bal) });
    if (bal <= 0 && n < tenure) break;
  }
  return rows;
}
const solve = (f, target, lo = 1e-6, hi = 0.05) => {
  for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (f(mid) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
};
// terms: { veh, bank, lan, amount, emi, tenure, first (yyyy-mm-dd), lastEmi?, rate? (% a year) } → a loan, or { error }
export function loanFromTerms(terms) {
  const amount = Number(terms.amount);
  const emi = Number(terms.emi);
  const tenure = Math.round(Number(terms.tenure));
  const first = String(terms.first || '');
  if (!(amount > 0) || !(emi > 0) || !(tenure >= 1 && tenure <= 360) || !/^\d{4}-\d{2}-\d{2}$/.test(first)) return { error: 'Fill in the amount financed, the EMI, the number of EMIs and the first EMI date.' };
  if (emi * tenure <= amount) return { error: `${tenure} EMIs of ₹${emi.toLocaleString('en-IN')} don't even repay the ₹${amount.toLocaleString('en-IN')} lent — check the numbers.` };
  const lastEmi = Number(terms.lastEmi) > 0 ? Number(terms.lastEmi) : null;
  const given = Number(terms.rate) > 0 ? Number(terms.rate) : null;
  let r;
  let rateFrom;
  if (lastEmi) { r = solve((x) => { const rows = amortise(amount, emi, tenure, x, first); return rows.length < tenure ? 0 : rows[tenure - 1].emi; }, lastEmi); rateFrom = 'last EMI'; }
  else if (given) { r = given / 1200; rateFrom = 'given'; }
  else { r = solve((x) => -(emi * (1 - (1 + x) ** -tenure) / x), -amount); rateFrom = 'EMI'; }
  const rows = amortise(amount, emi, tenure, r, first);
  const warnings = [];
  if (rows.length < tenure) warnings.push(`at ${r2(r * 1200)}% the loan is paid off in ${rows.length} EMIs, not ${tenure} — check the rate`);
  const lastRow = rows[rows.length - 1];
  if (lastEmi && Math.abs(lastRow.emi - lastEmi) > 2) warnings.push(`the last EMI works out to ₹${lastRow.emi.toLocaleString('en-IN')}, not ₹${lastEmi.toLocaleString('en-IN')} — check the numbers`);
  if (lastRow.emi > emi * 1.5) warnings.push(`the last EMI comes to ₹${Math.round(lastRow.emi).toLocaleString('en-IN')} — far more than the others; check the rate`);
  return {
    lan: String(terms.lan || '').trim() || `typed-${first}`, bank: String(terms.bank || '').trim(), veh: String(terms.veh || '').toUpperCase().replace(/[\s-]+/g, ''),
    amount, rate: r2(r * 1200), rateFrom: 'terms', rateBy: rateFrom, tenure, emi, dueDay: Number(first.slice(8, 10)), first, last: lastRow.date,
    file: '', typed: true, rows, unpaid: [], warnings,
  };
}
