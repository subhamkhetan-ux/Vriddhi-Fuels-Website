// A made-up workbook with the real Master Ledger layout (sheet names,
// headings, where the PO lists and labels sit): customers and figures are
// invented. Shared by the tests.
import { date, formula, serial, sheet, workbook } from './sheets.mjs';

const SALE_HEAD = ['Date', 'Bill No.', 'Vehicle', 'Quantity', 'RSP', 'Amount', 'Customer', 'Month'];
const d = (iso) => date(iso);

export function demoWorkbook() {
  const hsd = sheet({}, {
    start: 1,
    rows: [
      SALE_HEAD,
      [d('2026-04-01'), '1', 'OD01A1111', 600, 90, 54000, 'Demo Power Ltd'],
      [d('2026-04-01'), '2', 'OD01A2222', 400, 90, 36000, 'Twin Steel Ltd'],
      [d('2026-04-02'), '3', 'OD01A3333', 300, 90, 27000, 'Demo Power Ltd'],
      [d('2026-04-02'), '4', 'OD01A4444', 200, 90, 18000, 'Crew One Logistics'],
      [d('2026-04-03'), '5', '', 100, 90, 9000, 'Retail Roadways'],
      [d('2026-04-03'), '6', 'OD01A6666', 500, 90, 45000, 'Demo Power Ltd'],
      [d('2026-04-03'), '7', 'OD01A7777', 300, 90, 27000, 'Twin Steel Ltd'],
      [d('2026-04-04'), '8', 'OD01A8888', 250, 90, 22500, 'Twin Steel Ltd'],
      [d('2026-04-02'), '3', 'DUPLICATE', 1, 1, 1, 'Demo Power Ltd'],
      ['', '9', 'NO DATE', 1, 1, 1, 'Demo Power Ltd'],
    ],
  });
  const ms = sheet({}, { start: 1, rows: [SALE_HEAD, [d('2026-04-02'), '1', 'OD02B1111', 20, 100, 2000, 'Retail Roadways']] });
  const xg = sheet({}, {
    start: 1,
    rows: [
      ['Date', 'Bill No.', 'Vehicle', 'Quantity', 'RSP', 'Amount', 'Company'],
      [d('2026-04-02'), 'XG1', '', 10, 95, 950, 'Retail Roadways'],
      [d('2026-04-06'), 'XG2', 'OD01X2222', 200, 95, 19000, 'Demo Power Ltd'],
      [formula(''), '', '', '', '', '', ''],
    ],
  });
  const other = sheet({}, {
    start: 1,
    rows: [['Date', 'Bill No.', 'Product Name', 'Amount', 'Company'],
      [d('2026-04-03'), 'LUBE/001', 'Engine oil', 700, 'Retail Roadways']],
  });
  const paid = sheet({}, {
    start: 1,
    rows: [
      ['Date', 'Customer', 'Amount Paid', 'Payment Mode'],
      [d('2026-04-05'), 'Demo Power Ltd', 50000, 'HDFC 1010'],
      [d('2026-04-05'), 'Demo Power Ltd', 10000, 'Cash'],
      [d('2026-04-06'), 'Twin Steel Ltd', formula(20000, '15000+5000'), ''],
      [{ t: 'z', z: 'dd/mm/yy' }, '', '', ''],
      [d('2026-04-06'), '', 5, ''],
    ],
  });
  const outstanding = sheet({
    B4: 'Customer', C4: 'Ledger', D4: 'Outstanding Balance',
    B5: 'Retail Roadways', C5: 'Roadways', D5: formula(3700, 'Roadways!$I$5'),
    N3: date('2026-04-01', 'mmm-yy'), O3: date('2026-05-01', 'mmm-yy'),
    M4: 'Retail Roadways', N4: 2500,
    M5: 'Old Customer', N5: 100,
  });
  const gst = sheet({
    A1: 'Customer Name', B1: 'GSTIN', G1: 'Crew One Logistics', G2: 'Crew  Two Movers',
    A2: 'Demo Power Ltd', B2: 'GSTIN:22AAAAA0000A1Z5',
    A3: 'Retail Roadways', B3: 'GSTIN: 21BBBBB1111B1Z6',
  });

  const bulkHead = ['Date', 'Bill No.', 'Volume', 'Price', 'Amount', 'Paid', 'TDS', 'Shortage', 'Balance',
    'Product', 'PO No.', 'Remarks'];
  const liveStatus = {};
  for (let r = 5; r <= 54; r++) liveStatus[`W${r}`] = formula('', 'IFERROR(INDEX($AC$5:$AC$54,1),"")');
  const demo = sheet({
    A1: 'Demo Power — Bulk Ledger — Diesel (FY 2026-27)',
    L3: 'Customer:', M3: 'Demo Power Ltd', L4: 'Opening Balance:', M4: 1000,
    M5: { ...date('2026-04-01'), f: 'DATE(2026,4,1)' },
    T4: 'PO No.', U4: 'Allotted (L)', T5: 'PO-A', U5: 700, T6: 'PO-B', U6: 1000,
    W4: 'PO No.', X4: 'Allotted (L)', ...liveStatus,
  }, {
    start: 5,
    rows: [
      bulkHead,
      [d('2026-04-01'), '1', 600, 90, 54000, '', '', '', 55000, 'DIESEL', 'OLD-PO', ''],
      [d('2026-04-02'), '3', 300, 90, 27000, '', '', '', 82000, 'DIESEL', formula('PO-A', 'LET(1)'), ''],
      [d('2026-04-03'), '6', 500, 90, 45000, '', '', '', 127000, 'DIESEL', formula('PO-B', 'LET(1)'), ''],
      [d('2026-04-05'), '', '', '', '', 50000, 1000, '', 76000, 'Payment', formula('', 'LET(1)'), ''],
      [d('2026-04-05'), '', '', '', '', 10000, '', '', 66000, 'Payment', formula('', 'LET(1)'), 'cash'],
      [d('2026-04-06'), 'XG2', 200, 95, 19000, '', '', '', 85000, 'XtraGreen', 'PO-B', ''],
    ],
  });

  const twinHead = ['Date', 'Bill No.', 'Volume', 'Price', 'Amount', 'Paid', 'TDS', 'Shortage', 'Balance',
    'Unit', 'Product', 'PO No.', 'Remarks'];
  const twin = sheet({
    A1: 'Twin Steel — Bulk Ledger — Diesel (FY 2026-27)',
    O3: 'Customer:', P3: 'Twin Steel Ltd', O4: 'Opening Balance:', P4: formula(300, 'P16+Q16'),
    P5: date('2026-04-01'), P15: 'UNIT 1', Q15: 'UNIT 2', P16: 100, Q16: 200,
    V1: 'PO TRACKER — UNIT 1 (Diesel)', V2: 'Unit:', W2: 'UNIT 1', V4: 'PO No.', W4: 'Allotted (L)',
    V5: 'T1-A', W5: 1000,
    AC1: 'PO TRACKER — UNIT 2 (Diesel)', AC2: 'Unit:', AD2: 'UNIT 2', AC4: 'PO No.', AD4: 'Allotted (L)',
    AC5: 'T2-A', AD5: 250, AC6: 'T2-B', AD6: 500,
    AQ2: 'Unit:', AR2: 'UNIT 1',
  }, {
    start: 5,
    rows: [
      twinHead,
      [d('2026-04-01'), '2', 400, 90, 36000, '', '', '', 36300, 'UNIT 1', 'DIESEL', formula('T1-A', 'LET(1)'), ''],
      [d('2026-04-03'), '7', 300, 90, 27000, '', '', '', 63300, 'UNIT 2', 'DIESEL', formula('T2-B', 'LET(1)'), ''],
      [d('2026-04-04'), '8', 250, 90, 22500, '', '', '', 85800, '', 'DIESEL', formula('', 'LET(1)'), ''],
      [d('2026-04-06'), '', '', '', '', 20000, '', 50, 65750, '', 'Payment', formula('', 'LET(1)'), ''],
    ],
  });

  const crew = sheet({
    A1: 'Crew Group — Bulk Ledger — Diesel (FY 2026-27)',
    N3: 'Group:', O3: 'Crew Group', N4: 'Opening Balance:', O4: 0,
    N5: 'Period From:', O5: date('2026-04-01'),
    Q6: formula(serial('2026-04-02'), "LET(_xlpm.cut,$O$5,_xlpm.grp,'Customer GST'!$G$1:$G$50,1)"),
  }, {
    start: 5,
    rows: [
      ['Date', 'Billing Name', 'Bill No.', 'Volume', 'Price', 'Amount', 'Paid', 'TDS', 'Shortage', 'Balance',
        'Product', 'Remarks'],
      [d('2026-04-02'), 'Crew One Logistics', '4', 200, 90, 18000, '', 20, '', 18000, 'DIESEL', ''],
    ],
  });

  return workbook({
    Index: sheet({ B2: 'Master Ledger' }),
    'Master Paid': paid,
    Outstanding: outstanding,
    Demo_Bulk: demo,
    Twin_Bulk: twin,
    Crew_Bulk: crew,
    'HSD Sale': hsd,
    'MS Sale': ms,
    'XG Sale': xg,
    'Other Sale': other,
    'Customer GST': gst,
    Roadways: sheet({ K3: 'Retail Roadways' }),
  });
}
