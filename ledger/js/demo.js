// Made-up data for the demo (/ledger/?demo). Every name, vehicle, PO and
// figure here is invented; nothing is read from or saved to anywhere.

import { fyOf } from './util.js';

function rng(seed) {                      // small deterministic PRNG (mulberry32)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDay(base, offset) {
  const d = new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate() + offset));
  return d.toISOString().slice(0, 10);
}

export function demoSeed(today = new Date()) {
  const rand = rng(20260401);
  const between = (lo, hi, step = 10) => lo + Math.round((rand() * (hi - lo)) / step) * step;
  const plate = () => `OD${String(between(1, 35, 1)).padStart(2, '0')}${'ABCDEFGHJK'[between(0, 9, 1)]}${between(1000, 9999, 1)}`;
  const fyStart = `${fyOf(isoDay(today, -1)).slice(0, 4)}-04-01`;

  const RATE = { HSD: 90.52, MS: 101.18, XG: 93.76 };
  const counters = { HSD: 1400, MS: 310, XG: 40 };
  const nextBill = (p) => {
    counters[p] += 1;
    return p === 'XG' ? `XG${counters[p]}` : String(counters[p]);
  };
  const sale = (product, date, customer, qty, extra = {}) => ({
    product, bill_no: nextBill(product), sale_date: date, vehicle: plate(), qty,
    rate: RATE[product], amount: Math.round(qty * RATE[product] * 100) / 100, customer, ...extra,
  });

  const masterSales = [];
  const lastRows = [];
  const days = 24;
  let twinUnit = 0;
  for (let i = days; i >= 1; i--) {
    const date = isoDay(today, -i);
    const rows = i === 1 ? lastRows : masterSales;
    for (let k = 0; k < (i % 3 === 0 ? 2 : 1); k++) {
      rows.push(sale('HSD', date, 'Demo Power Ltd', between(2400, 4800, 100),
        i > days - 3 ? { po_mode: 'fixed', po_fixed: 'DP/25/0990' } : {}));
    }
    const unit = i <= 2 ? '' : (twinUnit++ % 2 ? 'UNIT 2' : 'UNIT 1');
    rows.push(sale('HSD', date, 'Twin Steel Ltd', between(1500, 3200, 100), i === 1 ? {} : { unit }));
    rows.push(sale('HSD', date, i % 2 ? 'Crew One Logistics' : 'Crew Two Movers', between(500, 900, 50)));
    rows.push(sale('HSD', date, 'Sample Roadlines', between(120, 320, 10)));
    if (i % 2 === 0) rows.push(sale('MS', date, 'Example Infra', between(20, 45, 1)));
    if (i % 5 === 0) rows.push(sale('XG', date, 'Sample Roadlines', between(60, 140, 5)));
    if (i === 6) rows.push(sale('HSD', date, 'Test Carriers', 180));
    if (i % 7 === 3) rows.push(sale('XG', date, 'Demo Power Ltd', 600, { po_mode: 'fixed', po_fixed: 'DP/26/XG-07' }));
  }
  lastRows.push(sale('HSD', isoDay(today, -1), 'Fresh Traders', 150));
  masterSales.forEach((s, i) => { s.seq = i + 2; });

  const payments = [];
  for (let i = days - 2; i >= 2; i -= 4) {
    payments.push({ pay_date: isoDay(today, -i), customer: 'Demo Power Ltd', amount: between(250000, 400000, 1000), mode: 'HDFC 1010' });
    payments.push({ pay_date: isoDay(today, -i + 1), customer: 'Sample Roadlines', amount: between(20000, 40000, 500), mode: 'ICICI 2020' });
  }
  payments.push({ pay_date: isoDay(today, -9), customer: 'Twin Steel Ltd', amount: 1200000, mode: 'HDFC 1010', tds: 12000 });
  payments.forEach((p, i) => { p.seq = i + 2; });

  const monthStart = `${isoDay(today, -days).slice(0, 7)}-01`;
  const payload = {
    groups: [
      { code: 'Demo Power_Bulk', title: 'Demo Power Ltd — Bulk Ledger — Diesel', kind: 'po', units: [], period_from: fyStart, opening: 850000, opening_by_unit: {} },
      { code: 'Twin Steel_Bulk', title: 'Twin Steel Ltd — Bulk Ledger — Diesel', kind: 'po_units', units: ['UNIT 1', 'UNIT 2'], period_from: fyStart, opening: 420000, opening_by_unit: { 'UNIT 1': 250000, 'UNIT 2': 170000 } },
      { code: 'Crew Group_Bulk', title: 'Crew Group — Bulk Ledger — Diesel', kind: 'group', units: [], period_from: fyStart, opening: 0, opening_by_unit: {} },
    ],
    customers: [
      { name: 'Demo Power Ltd', bulk_group: 'Demo Power_Bulk', gstin: '21AAACD0000A1Z1' },
      { name: 'Twin Steel Ltd', bulk_group: 'Twin Steel_Bulk', gstin: '21AAACT0000B1Z2' },
      { name: 'Crew One Logistics', bulk_group: 'Crew Group_Bulk' },
      { name: 'Crew Two Movers', bulk_group: 'Crew Group_Bulk' },
      { name: 'Sample Roadlines', ledger: 'Sample', gstin: '21AAACS0000C1Z3' },
      { name: 'Example Infra', ledger: 'Example' },
    ],
    sales: masterSales,
    payments,
    pos: [
      { group_code: 'Demo Power_Bulk', unit: '', po_no: 'DP/26/0142', allotted: 50000, seq: 1 },
      { group_code: 'Demo Power_Bulk', unit: '', po_no: 'DP/26/0187', allotted: 40000, seq: 2 },
      { group_code: 'Demo Power_Bulk', unit: '', po_no: 'DP/26/XG-07', allotted: 3000, seq: 3 },
      { group_code: 'Twin Steel_Bulk', unit: 'UNIT 1', po_no: 'TS-U1-7781', allotted: 24000, seq: 1 },
      { group_code: 'Twin Steel_Bulk', unit: 'UNIT 2', po_no: 'TS-U2-3310', allotted: 25000, seq: 1 },
    ],
    opening: [
      { customer: 'Sample Roadlines', month: monthStart, amount: 48250 },
      { customer: 'Example Infra', month: monthStart, amount: 12600 },
    ],
    tanker: [
      { company: 'Demo Power Ltd', hsd_rate: 90.52, address: ['At- Demo Industrial Estate', 'Post- Sampleganj, Via- Testpur.', 'GSTIN: 21AAACD0000A1Z1'], payment: ['Payment Details:', 'Account No. – 000000000000', 'IFSC Code – DEMO0000000', 'Branch Name – DEMO BANK, SAMPLE BRANCH', 'Beneficiary – DEMO FUELS'], po_label: 'P.O. No.:', po_no: '', price_tier: 'Bulk' },
      { company: 'Twin Steel Ltd, UNIT I', hsd_rate: 90.02, address: ['Unit I, Twin Steel Works', 'Sample Road, Testpur.', 'GSTIN: 21AAACT0000B1Z2'], payment: ['Payment Details:', 'Account No. – 000000000000', 'IFSC Code – DEMO0000000'], po_label: 'P.O. No.:', po_no: '', price_tier: 'Bulk' },
      { company: 'Twin Steel Ltd, UNIT II', hsd_rate: 90.02, address: ['Unit II, Twin Steel Works', 'Sample Road, Testpur.', 'GSTIN: 21AAACT0000B1Z2'], payment: ['Payment Details:', 'Account No. – 000000000000', 'IFSC Code – DEMO0000000'], po_label: 'P.O. No.:', po_no: '', price_tier: 'Bulk' },
      { company: 'Crew One Logistics', hsd_rate: 90.52, address: ['Crew Camp, Sample Mines', 'Testpur.'], payment: ['Payment Details:', 'Account No. – 000000000000'], po_label: '', po_no: '', price_tier: 'Retail' },
    ],
    settings: {
      slip_header: {
        title: 'CREDIT MEMO', mobile: 'Mob : 00000 00000',
        lines: ['DEMO FUELS (2026-27)', 'AT- SAMPLE ROAD PO- TESTPUR', 'DIST- DEMO, 000000', 'DEMO STATE',
          'GSTIN/UIN: 00DEMO0000D0Z0', 'State Name : Demo, Code : 00', 'E-Mail : demo@example.com'],
      },
    },
  };

  return {
    master: { fileName: 'Demo Master Ledger.xlsm', payload },
    daybooks: [{ fileName: `DayBook ${isoDay(today, -1)}.xlsx`, rows: lastRows }],
  };
}
