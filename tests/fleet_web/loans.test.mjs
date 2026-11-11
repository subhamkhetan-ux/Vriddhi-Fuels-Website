// Vehicle loans from the banks' EMI schedules. Made-up loans and numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loanStatus, loansSummary, parseSchedule, suggestTrucks } from '../../fleet/js/loans.js';
import { withDefaults } from '../../fleet/js/rules.js';
import { loansPagesSvg } from '../../fleet/js/share-svg.js';

// the shape of HDFC's "Repayment Schedule" (no rate printed), as pdf.js lines
const hdfc = `HDFC BANK LTD   Date :   01/06/2025
Repayment Schedule
Customer   DEMO TRANSPORT
Agreement No.   900000001   Loan Type   COMMERCIAL VEHICLE LOAN
Tenure   4   Amount Financed   400,000.00
Instl No   Due Date   Instl Amt   Principal   Interest   O/s Principal
1   05/08/2025   102,000.00   99,000.00   3,000.00   301,000.00
2   05/09/2025   102,000.00   99,742.00   2,258.00   201,258.00
3   05/10/2025   102,000.00   100,491.00   1,509.00   100,767.00
4   05/11/2025   101,523.00   100,767.00   756.00   0.00
Total :   407,523.00   400,000.00   7,523.00`;
// and ICICI's "Amortisation schedule" (rate printed, dates like 07-Aug-2025)
const icici = `Loan Account Number (LAN)   : DEMOLAN0001
Rate of Interest   : 9.50 % per annum
Amortisation schedule:
LAN Number   : DEMOLAN0001   Loan Amount   : ₹ 300,000.00
Instl No.   Installment Date   Instl. Amount (₹)   Principal (₹)   Interest (₹)   Closing Principal (₹)
1   07-Aug-2025   101,000.00   98,600.00   2,400.00   201,400.00
2   07-Sep-2025   101,000.00   99,405.00   1,595.00   101,995.00
3   07-Oct-2025   102,802.00   101,995.00   807.00   0.00
TOTAL   304,802.00   300,000.00   4,802.00
ICICI BANK LIMITED’S (ALL-INDIA) STANDARD TERMS AND CONDITIONS`;

test('both banks\' schedules are read: account, amount, rate, EMI, every instalment', () => {
  const h = parseSchedule(hdfc, { fileName: 'h.pdf' });
  assert.equal(h.bank, 'HDFC');
  assert.equal(h.lan, '900000001');
  assert.equal(h.amount, 400000);
  assert.equal(h.rateFrom, 'derived');                                   // not printed: 2,258 on 3,01,000 a year
  assert.equal(h.rate, 9);
  assert.deepEqual([h.tenure, h.emi, h.dueDay, h.first, h.last], [4, 102000, 5, '2025-08-05', '2025-11-05']);
  assert.deepEqual(h.rows[3], { n: 4, date: '2025-11-05', emi: 101523, principal: 100767, interest: 756, closing: 0 });
  assert.deepEqual(h.warnings, []);
  const i = parseSchedule(icici, { fileName: 'i.pdf' });
  assert.deepEqual([i.bank, i.lan, i.amount, i.rate, i.rateFrom, i.tenure, i.dueDay], ['ICICI', 'DEMOLAN0001', 300000, 9.5, 'schedule', 3, 7]);
  assert.equal(i.rows[1].date, '2025-09-07');
  // a page missing shows
  const short = parseSchedule(hdfc.split('\n').filter((l) => !/^3\s/.test(l)).join('\n'));
  assert.ok(short.warnings.some((w) => /page missing/.test(w)));
  assert.match(parseSchedule('a letter, no table', { fileName: 'x.pdf' }).error, /No repayment schedule found in x\.pdf/);
});

test('as of today every EMI due is paid unless marked not paid; principal and interest paid and left', () => {
  const h = parseSchedule(hdfc);
  const a = loanStatus(h, '2025-09-20');                                 // two EMIs due
  assert.deepEqual([a.paidN, a.dueN, a.overdueN, a.upcomingN], [2, 2, 0, 2]);
  assert.equal(a.principalPaid, 198742);
  assert.equal(a.interestPaid, 5258);
  assert.equal(a.principalLeft, 201258);
  assert.equal(a.interestLeft, 2265);
  assert.equal(a.next.n, 3);
  const b = loanStatus({ ...h, unpaid: [2] }, '2025-09-20');            // the second one marked not paid
  assert.deepEqual([b.paidN, b.overdueN, b.overdueAmt], [1, 1, 102000]);
  assert.equal(b.principalLeft, 301000);                                 // the bank still has its principal
  assert.equal(b.rows[1].status, 'unpaid');
  assert.equal(loanStatus(h, '2025-12-01').done, true);
});

test('the fleet, each bank, each month; a new loan\'s truck from the EMI the register charges it', () => {
  const h = { ...parseSchedule(hdfc), veh: 'XX01' };
  const i = parseSchedule(icici);
  const S = loansSummary([h, i], '2025-09-20');
  assert.equal(S.total.loans, 2);
  assert.equal(S.total.amount, 700000);
  assert.equal(S.total.paidN, 4);
  assert.equal(S.total.emi, 203000);                                     // the next EMI of each
  assert.deepEqual(S.banks.map((b) => [b.bank, b.loans]), [['HDFC', 1], ['ICICI', 1]]);
  assert.deepEqual(S.months.map((m) => [m.month, m.emi, m.past]).slice(0, 3), [['2025-08', 203000, true], ['2025-09', 203000, true], ['2025-10', 204802, false]]);
  assert.equal(S.thisMonth.month, '2025-09');
  // the register charges XX02 ₹1,01,000 a month (over two trips) and XX03 something else: XX02 gets the ICICI loan
  const trips = [{ veh: 'XX02', month: '2025-08', emi: 50500 }, { veh: 'XX02', month: '2025-08', emi: 50500 }, { veh: 'XX02', month: '2025-09', emi: 101000 }, { veh: 'XX03', month: '2025-08', emi: 150000 }];
  assert.deepEqual([...suggestTrucks([h, i], trips)], [['DEMOLAN0001', 'XX02']]);
  // kept in the settings; a Setup default with none
  assert.deepEqual(withDefaults({}).loans, []);
  assert.equal(withDefaults({ loans: [h] }).loans[0].lan, '900000001');
  // the picture
  const pages = loansPagesSvg(S, { asOn: '2025-09-20' });
  assert.ok(pages.length >= 1);
  assert.doesNotMatch(pages.join(''), /undefined|NaN/);
  assert.match(pages.join(''), /DEMOLAN0001/);
});

test('due days read as 5th, 7th, 1st, 22nd, 11th', async () => {
  const { ordinal } = await import('../../fleet/js/loans.js');
  assert.deepEqual([5, 7, 1, 2, 3, 22, 11, 12, 13, 21].map(ordinal), ['5th', '7th', '1st', '2nd', '3rd', '22nd', '11th', '12th', '13th', '21st']);
});

test('a loan typed in from its terms: the bank\'s schedule worked out — the last EMI pins the rate', async () => {
  const { loanFromTerms } = await import('../../fleet/js/loans.js');
  const r = 0.09 / 12;
  const emi = Math.round((500000 * r) / (1 - (1 + r) ** -36));            // ₹15,900
  const bank = loanFromTerms({ veh: 'xx 09 ab 1234', bank: 'Demo Bank', lan: 'D-1', amount: 500000, emi, tenure: 36, first: '2026-01-31', rate: 9 });
  assert.equal(bank.veh, 'XX09AB1234');                                  // any vehicle no., as typed, kept plain
  assert.equal(bank.rows.length, 36);
  assert.deepEqual(bank.rows.slice(0, 3).map((x) => x.date), ['2026-01-31', '2026-02-28', '2026-03-31']);   // the same day, or the month's last
  assert.equal(bank.rows[0].interest, 3750);                             // 5,00,000 × 9% ÷ 12
  assert.equal(bank.rows[35].closing, 0);
  const lastEmi = bank.rows[35].emi;
  // typed in with the last EMI: the same rate and the same schedule, to the rupee
  const typed = loanFromTerms({ veh: 'XX09AB1234', lan: 'D-1', amount: 500000, emi, tenure: 36, first: '2026-01-31', lastEmi });
  assert.equal(typed.rate, 9);
  assert.equal(typed.rateBy, 'last EMI');
  assert.ok(typed.rows.every((x, i) => Math.abs(x.interest - bank.rows[i].interest) <= 1 && Math.abs(x.closing - bank.rows[i].closing) <= 1));
  // with only the EMI: the annuity rate
  assert.ok(Math.abs(loanFromTerms({ amount: 500000, emi, tenure: 36, first: '2026-01-31' }).rate - 9) < 0.05);
  assert.deepEqual(typed.warnings, []);
  assert.match(loanFromTerms({ amount: 500000, emi: 10000, tenure: 36, first: '2026-01-31' }).error, /don't even repay/);
  assert.match(loanFromTerms({ amount: 500000 }).error, /Fill in/);
});

test('a schedule with a cheque / mode column (SI) between the date and the amounts is read too', () => {
  const t = `HDFC BANK   Repayment Schedule
Agreement No.   900000002
Amount Financed   300,000.00
Instl.   Due Date   Cheque Num   Instl Amt   Principal   Interest   O/s Principal
1   05/04/2026   SI   101,000.00   98,600.00   2,400.00   201,400.00
2   05/05/2026   SI   101,000.00   99,389.00   1,611.00   102,011.00
3   05/06/2026   SI   102,827.00   102,011.00   816.00   0.00`;
  const l = parseSchedule(t);
  assert.deepEqual([l.bank, l.lan, l.tenure, l.emi, l.dueDay], ['HDFC', '900000002', 3, 101000, 5]);
  assert.deepEqual(l.warnings, []);
});

test('the picture for the vehicles picked: their name on it, and each loan\'s EMIs when asked', () => {
  const h = { ...parseSchedule(hdfc), veh: 'XX01', unpaid: [2] };
  const S = loansSummary([h], '2025-10-20');
  const pages = loansPagesSvg(S, { asOn: '2025-10-20', name: 'XX 01', truckOf: () => 'XX 01', schedules: true }).join('');
  assert.match(pages, /XX 01/);
  assert.match(pages, /1 loan · ₹4,00,000 borrowed/);
  assert.match(pages, /Not paid/);                                         // EMI #2, marked
  assert.match(pages, /To pay/);                                           // #4, still to come
  assert.doesNotMatch(pages, /undefined|NaN/);
  assert.doesNotMatch(loansPagesSvg(S, { asOn: '2025-10-20' }).join(''), /To pay/);   // without: no EMI list
});
