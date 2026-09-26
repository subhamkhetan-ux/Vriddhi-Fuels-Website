// Builds SheetJS-shaped worksheets from plain objects, for the tests.
// All names and numbers used with it are made up.
import { addr, colIndex } from '../../ledger/js/util.js';

// Excel serial of an ISO date (1900 date system).
export function serial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

export const date = (iso, z = 'dd/mm/yy') => ({ t: 'n', v: serial(iso), z });
export const formula = (value, f = 'IFERROR(1,"")') => (
  typeof value === 'number' ? { t: 'n', v: value, f } : { t: 's', v: value ?? '', f });

function toCell(v) {
  if (v && typeof v === 'object' && 't' in v) return v;
  if (typeof v === 'number') return { t: 'n', v };
  if (typeof v === 'boolean') return { t: 'b', v };
  return { t: 's', v: String(v) };
}

// cells: {A1: value, ...}; rows: {startRow, cols: 'A', values: [[...], ...]}
export function sheet(cells = {}, ...blocks) {
  const ws = {};
  let maxR = 0;
  let maxC = 0;
  const put = (a, v) => {
    if (v === undefined || v === null) return;
    const m = a.match(/^([A-Z]+)(\d+)$/);
    ws[a] = toCell(v);
    maxR = Math.max(maxR, Number(m[2]));
    maxC = Math.max(maxC, colIndex(m[1]));
  };
  for (const [a, v] of Object.entries(cells)) put(a, v);
  for (const { start, col = 'A', rows } of blocks) {
    rows.forEach((row, i) => row.forEach((v, j) => put(addr(start - 1 + i, colIndex(col) + j), v)));
  }
  ws['!ref'] = maxR ? `A1:${addr(maxR - 1, maxC)}` : 'A1';
  return ws;
}

export function workbook(sheets) {
  return { SheetNames: Object.keys(sheets), Sheets: sheets, Workbook: { WBProps: { date1904: false } } };
}
