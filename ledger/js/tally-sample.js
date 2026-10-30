// A made-up Tally XML export for the demo (/ledger/?demo → Tally → "Try a
// sample Tally file") and the tests: the masters (groups, ledgers with their
// openings, stock items, a compound unit) and a financial year of vouchers —
// the demo's own bills and payments, plus cash sales, fuel and lubricant
// purchases, expenses and bank entries. A few differences from the app are
// planted on purpose so the Ledger vs Tally screen has something to find:
//   - a Demo Power bill left out of Tally
//   - a Twin Steel bill ₹150 higher in Tally
//   - a retail payment a day later in Tally
//   - a receipt in Tally that the app doesn't have (a retail customer)
//   - one retail customer's opening ₹2,500 higher in Tally
// Every name and figure is invented.

import { fyStartOf } from './tally-recon.js';

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r2 = (n) => Math.round(n * 100) / 100;
const amt = (n) => r2(n).toFixed(2);
const tdate = (iso) => iso.replace(/-/g, '');
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SAMPLE_LUBES = [
  { name: 'SERVO 4T XTRA 10W30 900ML', unit: 'Nos', rate: 310, lot: [24, 48] },
  { name: 'SERVO PRIDE 15W40 20 LTR', unit: 'Nos', rate: 4600, lot: [2, 6] },
  { name: 'SERVO SUPER MG 20W40 (7.5 LTR)', unit: 'Nos', rate: 1750, lot: [4, 10] },
  { name: 'SERVOGREASE MP 500 GM', unit: 'Nos', rate: 120, lot: [12, 36] },
  { name: 'SERVO 2T SUPREME 40ML', unit: 'Nos', rate: 22, lot: [100, 200] },
  { name: 'SERVO PRIDE TC 15W40 1X12X1L', unit: 'Box', rate: 3480, lot: [1, 3] },
  { name: 'ADBLUE 20 LTR', unit: 'Nos', rate: 980, lot: [5, 15] },
];
const FUEL_ITEM = { HSD: 'High Speed Diesel', MS: 'Motor Spirit', XG: 'XtraGreen Diesel' };
const SALE_TYPE = { HSD: 'HSD CREDIT', MS: 'MS CREDIT', XG: 'XG CREDIT', OTHER: 'Sales' };
const SALE_LEDGER = { HSD: 'SALE (HSD)', MS: 'SALE (MS)', XG: 'SALE (HSD)', OTHER: 'SALE (LUBES)' };

// the sample as Tally XML text, from the demo store as on `today`:
// {xml, planted: [{account, type, …}]}
export async function sampleTally(store, today) {
  const to = addDays(today, -1);
  const from = fyStartOf(to);
  const [dash, st] = await Promise.all([store.dashboard(to, to), store.statementData(from, to)]);
  const bulk = await Promise.all(dash.groups.map(async ([code]) => ({ code, data: await store.account(null, code, null, null) })));
  const rand = rng(424242);
  const between = (lo, hi) => lo + Math.round(rand() * (hi - lo));

  const ledgers = new Map();                                  // name -> {parent, opening (+ = Dr)}
  const led = (name, parent, opening = 0) => { if (!ledgers.has(name)) ledgers.set(name, { parent, opening }); };
  const vouchers = [];
  let guid = 0;
  const V = (type, date, number, party, lines, { items = [], narration = '', vehicle = '' } = {}) => {
    guid += 1;
    vouchers.push({ type, date, number, party, lines, items, narration, vehicle, guid: `demo-0000-${String(guid).padStart(6, '0')}` });
  };

  // ---- the app's customers: their bills and payments, with the planted differences
  const planted = [];
  const retailWithSales = st.customers.filter((c) => st.sales.some((s) => s.key === c.key));
  const extraFor = retailWithSales[0] || null;
  const bumpFor = retailWithSales[1] || null;
  const shifted = st.payments.find((p) => st.customers.some((c) => c.key === p.key) && (!extraFor || p.key !== extraFor.key)) || null;
  for (const c of st.customers) led(c.name, 'Sundry Debtors', r2(Number(c.opening) + (bumpFor && c.key === bumpFor.key ? 2500 : 0)));
  if (bumpFor) planted.push({ account: `c:${bumpFor.key}`, type: 'opening', effect: 2500 });
  // a bulk sheet's opening on its first company's ledger
  for (const b of bulk) (b.data.members || []).forEach((m, i) => led(m.name, 'RCP COMPANIES', i === 0 ? r2(Number(b.data.group.opening) || 0) : 0));
  const saleVoucher = (s, party, amount = Number(s.amount), date = s.sale_date) => {
    const p = s.product in FUEL_ITEM ? s.product : 'OTHER';
    V(SALE_TYPE[p], date, s.bill_no, party, [[party, -amount]], {
      items: [{ name: p === 'OTHER' ? (s.item || 'SERVO 4T XTRA 10W30 900ML') : FUEL_ITEM[p], qty: Number(s.qty) || 1, unit: p === 'OTHER' ? 'Nos' : 'LTR', rate: Number(s.rate) || amount, amount, ledger: SALE_LEDGER[p] }],
      vehicle: s.vehicle || '',
    });
  };
  for (const s of st.sales) {
    const c = st.customers.find((x) => x.key === s.key);
    if (c) saleVoucher(s, c.name);
  }
  let rcpt = 0;
  const receipt = (date, party, amount, { tds = 0, narration = '' } = {}) => {
    rcpt += 1;
    const lines = [[party, r2(amount + tds)], ['HDFC Bank', -amount]];
    if (tds) lines.push(['TDS Receivable', -tds]);
    V('Receipt', date, String(rcpt), party, lines, { narration });
  };
  for (const p of st.payments) {
    const c = st.customers.find((x) => x.key === p.key);
    if (!c) continue;
    let date = p.pay_date;
    if (p === shifted) {
      date = date < to ? addDays(date, 1) : addDays(date, -1);
      planted.push({ account: `c:${c.key}`, type: 'date', appDate: p.pay_date, tallyDate: date, effect: 0 });
    }
    receipt(date, c.name, Number(p.amount));
  }
  if (extraFor) {
    const last = st.sales.filter((s) => s.key === extraFor.key).at(-1);
    receipt(last.sale_date, extraFor.name, 5000, { narration: 'UPI — not in the app' });
    planted.push({ account: `c:${extraFor.key}`, type: 'tallyOnly', date: last.sale_date, effect: -5000 });
  }
  bulk.forEach((b, gi) => {
    const first = (b.data.members || [])[0];
    (b.data.sales || []).forEach((s, i) => {
      if (gi === 0 && i === 0) {                                    // left out of Tally
        planted.push({ account: `g:${b.code}`, type: 'appOnly', number: s.bill_no, effect: -Number(s.amount) });
        return;
      }
      const more = gi === 1 && i === 1 ? 150 : 0;
      if (more) planted.push({ account: `g:${b.code}`, type: 'amount', number: s.bill_no, effect: more });
      saleVoucher(s, s.customer || first.name, Number(s.amount) + more);
    });
    for (const p of b.data.payments || []) {
      const party = p.customer || first.name;
      receipt(p.pay_date, party, Number(p.amount), { tds: Number(p.tds) || 0 });
      if (Number(p.shortage)) {
        V('Journal', p.pay_date, `J${rcpt}`, party, [[party, Number(p.shortage)], ['Shortage Allowed', -Number(p.shortage)]], { narration: 'Shortage' });
      }
    }
  });

  // ---- the rest of the year: cash sales, purchases, expenses
  led('Cash', 'Cash-in-Hand', 85000);
  led('HDFC Bank', 'Bank Accounts', 4500000);
  led('Proprietor Capital', 'Capital Account', -4200000);
  led('Indian Oil Corporation Ltd', 'Sundry Creditors', -650000);
  led('Sample Lube Distributors', 'Sundry Creditors', -42000);
  led('Stock-in-Hand', 'Stock-in-Hand', 1150000);
  led('Furniture & Fixtures', 'Fixed Assets', 280000);
  led('Dispensing Units', 'Fixed Assets', 1450000);
  const opening = [...ledgers.values()].reduce((s, l) => s + l.opening, 0);
  led('Retained Earnings', 'Reserves & Surplus', r2(-opening));      // so the openings balance
  for (const [name, parent] of [['SALE (HSD)', 'Sales Accounts'], ['SALE (MS)', 'Sales Accounts'], ['SALE (LUBES)', 'Sales Accounts'],
    ['PURCHASE (HSD)', 'Purchase Accounts'], ['PURCHASE (MS)', 'Purchase Accounts'], ['Purchase (Lubes)', 'Purchase Accounts'],
    ['Freight Inward', 'Direct Expenses'], ['Salary & Wages', 'Indirect Expenses'], ['Electricity Charges', 'Indirect Expenses'],
    ['Rent', 'Indirect Expenses'], ['Bank Charges', 'Indirect Expenses'], ['Shortage Allowed', 'Indirect Expenses'], ['R/off', 'Indirect Expenses'],
    ['Repairs & Maintenance', 'Indirect Expenses'], ['Commission Received', 'Indirect Incomes'], ['Input CGST', 'Duties & Taxes'],
    ['Input SGST', 'Duties & Taxes'], ['TDS Receivable', 'Loans & Advances (Asset)']]) led(name, parent, 0);

  let cashNo = 0;
  let pur = 0;
  let pay = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    // cash sales every day, banked the same day
    let banked = 0;
    for (const [p, lo, hi, rate] of [['HSD', 3000, 4800, 90.52], ['MS', 900, 1500, 101.18]]) {
      const qty = between(lo, hi);
      cashNo += 1;
      V(`${p} CASH`, d, `C${cashNo}`, 'Cash', [['Cash', -r2(qty * rate)]], { items: [{ name: FUEL_ITEM[p], qty, unit: 'LTR', rate, amount: r2(qty * rate), ledger: SALE_LEDGER[p] }] });
      banked += qty * rate;
    }
    banked = Math.floor(banked / 1000) * 1000;
    V('Contra', d, `CT${d}`, 'HDFC Bank', [['HDFC Bank', -banked], ['Cash', banked]]);
    const day = Number(d.slice(8, 10));
    // fuel from IOCL every third day, paid the day after
    if (day % 3 === 0) {
      for (const [p, kl, rate] of [['HSD', 12, 87.9], ['MS', 4, 97.6]]) {
        pur += 1;
        const qty = kl * 1000;
        const value = r2(qty * rate);
        V('Purchase', d, `IOCL/${pur}`, 'Indian Oil Corporation Ltd', [['Indian Oil Corporation Ltd', value]], {
          items: [{ name: FUEL_ITEM[p], qty, unit: 'LTR', rate, amount: -value, ledger: p === 'HSD' ? 'PURCHASE (HSD)' : 'PURCHASE (MS)' }],
        });
        pay += 1;
        V('Payment', addDays(d, 1) > to ? d : addDays(d, 1), `P${pay}`, 'Indian Oil Corporation Ltd', [['Indian Oil Corporation Ltd', -value], ['HDFC Bank', value]]);
      }
    }
    // lubricants twice a month, with GST, paid at month end
    if (day === 5 || day === 20) {
      const pick = SAMPLE_LUBES.filter(() => rand() < 0.65);
      const items = pick.map((l) => {
        const qty = between(l.lot[0], l.lot[1]);
        return { name: l.name, qty, unit: l.unit, rate: l.rate, amount: -r2(qty * l.rate), ledger: 'Purchase (Lubes)' };
      });
      if (items.length) {
        const taxable = -items.reduce((s, i) => s + i.amount, 0);
        const gst = r2(taxable * 0.09);
        pur += 1;
        V('Purchase', d, `SLD/${pur}`, 'Sample Lube Distributors', [['Sample Lube Distributors', r2(taxable + 2 * gst)], ['Input CGST', -gst], ['Input SGST', -gst]], { items });
      }
    }
    // a few lubricant sales over the counter
    if (day % 4 === 1) {
      const l = SAMPLE_LUBES[between(0, 3)];
      const qty = between(1, 4);
      const value = r2(qty * l.rate * 1.25);
      cashNo += 1;
      V('Sales', d, `L${cashNo}`, 'Cash', [['Cash', -value]], { items: [{ name: l.name, qty, unit: l.unit, rate: r2(l.rate * 1.25), amount: value, ledger: 'SALE (LUBES)' }] });
    }
    // monthly expenses and income
    if (day === 1) {
      pay += 1; V('Payment', d, `P${pay}`, 'Salary & Wages', [['Salary & Wages', -between(180000, 210000)], ['HDFC Bank', 0]]);
      pay += 1; V('Payment', d, `P${pay}`, 'Rent', [['Rent', -45000], ['HDFC Bank', 45000]]);
    }
    if (day === 10) { pay += 1; V('Payment', d, `P${pay}`, 'Electricity Charges', [['Electricity Charges', -between(38000, 52000)], ['HDFC Bank', 0]]); }
    if (day === 15) { pay += 1; V('Payment', d, `P${pay}`, 'Repairs & Maintenance', [['Repairs & Maintenance', -between(3000, 18000)], ['Cash', 0]]); }
    if (day === 25) { pay += 1; V('Payment', d, `P${pay}`, 'Freight Inward', [['Freight Inward', -between(20000, 30000)], ['HDFC Bank', 0]]); }
    if (day === 28) { pay += 1; V('Payment', d, `P${pay}`, 'Bank Charges', [['Bank Charges', -between(300, 1200)], ['HDFC Bank', 0]]); }
    if (day === 28) {
      const lube = vouchers.filter((v) => v.party === 'Sample Lube Distributors' && v.date.slice(0, 7) === d.slice(0, 7) && v.type === 'Purchase')
        .reduce((s, v) => s + v.lines[0][1], 0);
      if (lube) { pay += 1; V('Payment', d, `P${pay}`, 'Sample Lube Distributors', [['Sample Lube Distributors', -r2(lube)], ['HDFC Bank', r2(lube)]]); }
      V('Receipt', d, `RC${d}`, 'Commission Received', [['Commission Received', between(4000, 9000)], ['HDFC Bank', 0]]);
    }
  }
  // the payments above balanced by their bank / cash line
  for (const v of vouchers) {
    const zero = v.lines.find((l) => l[1] === 0);
    if (zero) zero[1] = -v.lines.filter((l) => l !== zero).reduce((s, l) => s + l[1], 0);
  }
  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const company = `Demo Fuels (${from.slice(0, 4)}-${String((Number(from.slice(0, 4)) + 1) % 100).padStart(2, '0')})`;
  return { xml: xmlOf({ ledgers, vouchers, company }), planted, from, to };
}

function xmlOf({ ledgers, vouchers, company }) {
  const x = ['<ENVELOPE>', ' <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>', ' <BODY><IMPORTDATA>',
    `  <REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEsc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`,
    '  <REQUESTDATA>'];
  const msg = (body) => x.push(`   <TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE>`);
  // groups: Tally's own (the export carries them) and one of the firm's
  for (const [name, parent] of [['Current Assets', ''], ['Current Liabilities', ''], ['Capital Account', ''], ['Fixed Assets', ''],
    ['Sales Accounts', ''], ['Purchase Accounts', ''], ['Direct Expenses', ''], ['Indirect Expenses', ''], ['Indirect Incomes', ''],
    ['Sundry Debtors', 'Current Assets'], ['Sundry Creditors', 'Current Liabilities'], ['Bank Accounts', 'Current Assets'],
    ['Cash-in-Hand', 'Current Assets'], ['Duties & Taxes', 'Current Liabilities'], ['Stock-in-Hand', 'Current Assets'],
    ['Loans & Advances (Asset)', 'Current Assets'], ['Reserves & Surplus', 'Capital Account'], ['RCP COMPANIES', 'Sundry Debtors']]) {
    msg(`<GROUP NAME="${xmlEsc(name)}" ACTION="Create"><PARENT>${parent ? xmlEsc(parent) : '&#4; Primary'}</PARENT></GROUP>`);
  }
  x.push(`   <TALLYMESSAGE><UNIT NAME="Box of 12 Nos" ACTION="Create"><ISSIMPLEUNIT>No</ISSIMPLEUNIT><BASEUNITS>Box</BASEUNITS><ADDITIONALUNITS>Nos</ADDITIONALUNITS><CONVERSION> 12</CONVERSION></UNIT></TALLYMESSAGE>`);
  for (const [name, l] of ledgers) {
    msg(`<LEDGER NAME="${xmlEsc(name)}" ACTION="Create"><PARENT>${xmlEsc(l.parent)}</PARENT><OPENINGBALANCE>${amt(-l.opening)}</OPENINGBALANCE></LEDGER>`);
  }
  for (const [name, group, unit] of [['High Speed Diesel', 'Fuel', 'LTR'], ['Motor Spirit', 'Fuel', 'LTR'], ['XtraGreen Diesel', 'Fuel', 'LTR'],
    ...SAMPLE_LUBES.map((l) => [l.name, l.name.startsWith('ADBLUE') ? 'Other Items' : 'Servo Lubricants', l.unit])]) {
    msg(`<STOCKITEM NAME="${xmlEsc(name)}" ACTION="Create"><PARENT>${group}</PARENT><BASEUNITS>${unit}</BASEUNITS></STOCKITEM>`);
  }
  for (const v of vouchers) {
    const party = v.lines.find((l) => l[0] === v.party) ? v.party : '';
    const inv = v.items.map((i) => `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${xmlEsc(i.name)}</STOCKITEMNAME><RATE>${i.rate}/${i.unit}</RATE><AMOUNT>${amt(i.amount)}</AMOUNT>`
      + `<ACTUALQTY> ${i.qty} ${i.unit}</ACTUALQTY><BILLEDQTY> ${i.qty} ${i.unit}</BILLEDQTY>`
      + `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${xmlEsc(i.ledger)}</LEDGERNAME><AMOUNT>${amt(i.amount)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`).join('');
    const list = v.items.length ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
    const lines = v.lines.map(([n, a]) => `<${list}><LEDGERNAME>${xmlEsc(n)}</LEDGERNAME><AMOUNT>${amt(a)}</AMOUNT></${list}>`).join('');
    msg(`<VOUCHER VCHTYPE="${xmlEsc(v.type)}" ACTION="Create"><DATE>${tdate(v.date)}</DATE><GUID>${v.guid}</GUID><VOUCHERTYPENAME>${xmlEsc(v.type)}</VOUCHERTYPENAME>`
      + `<VOUCHERNUMBER>${xmlEsc(v.number)}</VOUCHERNUMBER>${party ? `<PARTYLEDGERNAME>${xmlEsc(party)}</PARTYLEDGERNAME>` : ''}`
      + `${v.narration ? `<NARRATION>${xmlEsc(v.narration)}</NARRATION>` : ''}<ISCANCELLED>No</ISCANCELLED>${inv}${lines}`
      + `${v.vehicle ? `<UDF:EIVEHNO.LIST DESC="\`EiVehNo\`"><UDF:EIVEHNO DESC="\`EiVehNo\`">${xmlEsc(v.vehicle)}</UDF:EIVEHNO></UDF:EIVEHNO.LIST>` : ''}</VOUCHER>`);
  }
  x.push('  </REQUESTDATA>', ' </IMPORTDATA></BODY>', '</ENVELOPE>');
  return x.join('\r\n');
}
