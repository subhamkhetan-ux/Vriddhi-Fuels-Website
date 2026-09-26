// Small helpers shared by the ledger app and its tests (no DOM, no network).

// Customer names match the way Excel matches them (case-insensitive) and
// also ignore stray/double spaces. Same rule as ledger_norm() in
// supabase/ledger-schema.sql.
export function normKey(s) {
  return String(s ?? '').replace(/[\t\n\v\f\r  ]+/g, ' ').trim().toLowerCase();
}

// Indian financial year of an ISO date: 2026-04-01 .. 2027-03-31 -> '2026-27'.
export function fyOf(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function billKey(product, iso, billNo) {
  return `${product}|${fyOf(iso)}|${String(billNo).trim()}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoFromParts(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;                 // e.g. 31-02
  return `${y}-${pad(m)}-${pad(d)}`;
}

// Excel date serial -> 'YYYY-MM-DD'. The 1904 flag is for workbooks saved
// with the Mac 1904 date system.
export function serialToISO(serial, date1904 = false) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  if (days < 61) return null;                                  // before 1900-03-01: not a real date here
  const dt = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function isoToSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12,
};

function fullYear(t) {
  const n = Number(t);
  if (t.length === 2) return n < 70 ? 2000 + n : 1900 + n;
  return n;
}

// Dates typed as text. Day comes first (Indian style): 07-04-2026, 7/4/26,
// 7-Apr-26, 7 April 2026; ISO 2026-04-07 also works.
export function parseTextDate(s) {
  const t = String(s ?? '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (m) return isoFromParts(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  if (m) return isoFromParts(fullYear(m[3]), +m[2], +m[1]);
  m = t.match(/^(\d{1,2})[-\s/.]+([A-Za-z]{3,9})[-\s/.,]+(\d{4}|\d{2})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return isoFromParts(fullYear(m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

// True for an Excel number format that shows a date (dd/mm/yy, mmm-yy,
// [$-14009]dd/mm/yy;@ ...), false for General, 0.00, currency formats ...
export function isDateFormat(z) {
  if (!z || typeof z !== 'string') return false;
  const s = z.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  if (/general/i.test(s)) return false;
  return /[dy]/i.test(s) || /m{3,}/i.test(s) || (/m/i.test(s) && !/[#0?]/.test(s));
}

// ---- SheetJS cells -------------------------------------------------------
// A cell is {t: 'n'|'s'|'b'|'e'|'d'|'z', v, z?, f?} (z = number format,
// f = formula). Error cells (#N/A, #REF! ...) read as blank.

export function cellText(c) {
  if (!c || c.t === 'e' || c.t === 'z' || c.v == null) return '';
  if (c.t === 'n') return Number.isInteger(c.v) ? String(c.v) : String(+c.v.toFixed(6));
  if (c.t === 'b') return c.v ? 'TRUE' : 'FALSE';
  if (c.t === 'd') return c.v instanceof Date ? c.v.toISOString().slice(0, 10) : String(c.v);
  return String(c.v).replace(/[\t\n\v\f\r  ]+/g, ' ').trim();
}

export function parseNumber(s) {
  let t = String(s ?? '').replace(/[₹,\s ]/g, '');
  t = t.replace(/(ltrs?|litres?|liters?|kl|nos|dr|cr|l)\.?$/i, '');
  if (/^\(\d+(\.\d+)?\)$/.test(t)) t = '-' + t.slice(1, -1);   // (1,234) accounting negative
  return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

export function cellNumber(c) {
  if (!c || c.t === 'e' || c.t === 'z' || c.v == null || c.v === '') return null;
  if (c.t === 'n') return Number.isFinite(c.v) ? c.v : null;
  if (c.t === 'b') return null;
  return parseNumber(c.v);
}

// A date cell -> ISO. Numbers are read as Excel serials (callers only ask
// this of columns that hold dates); text dates are parsed.
export function cellDate(c, date1904 = false) {
  if (!c || c.t === 'e' || c.t === 'z' || c.v == null || c.v === '') return null;
  if (c.t === 'd') {
    const d = c.v instanceof Date ? c.v : new Date(c.v);
    return Number.isNaN(d.getTime()) ? null : isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  if (c.t === 'n') return serialToISO(c.v, date1904);
  if (c.t === 's') return parseTextDate(c.v);
  return null;
}

// VBA IsDate() on a DayBook cell: a date-formatted number, a date value, or
// text that reads as a date. A bare number in the 2000-2099 range counts
// too (a date column saved without its format).
export function isDateCell(c) {
  if (!c || c.v == null || c.v === '') return false;
  if (c.t === 'd') return true;
  if (c.t === 'n') return isDateFormat(c.z) || (c.v >= 36526 && c.v < 73051);
  if (c.t === 's') return parseTextDate(c.v) != null;
  return false;
}

// ---- A1 addresses --------------------------------------------------------
export function colLetter(i) {                // 0 -> A
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(letters) {           // A -> 0
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function addr(r, c) {                  // 0-based row/col -> 'A1'
  return colLetter(c) + (r + 1);
}

export function sheetBounds(ws) {
  const ref = ws && ws['!ref'];
  if (!ref) return { rows: 0, cols: 0 };
  const m = ref.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) return { rows: 0, cols: 0 };
  return { rows: Number(m[4] || m[2]), cols: colIndex(m[3] || m[1]) + 1 };
}

// ---- formatting ----------------------------------------------------------
const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const LITRES = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export function fmtMoney(n) {
  return n == null || n === '' || Number.isNaN(Number(n)) ? '' : '₹' + INR.format(Number(n));
}

export function fmtLitres(n) {
  return n == null || n === '' || Number.isNaN(Number(n)) ? '' : LITRES.format(Number(n));
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso) {                // 2026-04-07 -> 07 Apr 2026
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d} ${MON[Number(m) - 1]} ${y}`;
}

// A ledger (tab) name suggestion, like the workbook's SanitizeName().
export function suggestLedgerName(name) {
  return String(name ?? '').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim();
}
