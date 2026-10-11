// Dates, numbers and names for the fleet app. No DOM here (the tests import it).

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---- dates (ISO yyyy-mm-dd strings everywhere) ------------------------------------

// Excel serial (1900 date system) -> ISO date
export function serialToIso(n) {
  const ms = Math.round((Number(n) - 25569) * 86400000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function toIso(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null
      : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') return v > 20000 && v < 80000 ? serialToIso(v) : null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);            // dd/mm/yyyy, as typed in India
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}

export function localToday() {
  return toIso(new Date());
}

const utc = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
export function addDays(iso, n) {
  return new Date(utc(iso) + n * 86400000).toISOString().slice(0, 10);
}
export const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);           // 2026-10
export function addMonths(month, n) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}
export function monthEnd(month) {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}
// Indian financial year starting month of a date: 2026-05-09 -> 2026-04
export function fyStart(iso) {
  const y = Number(iso.slice(0, 4));
  return Number(iso.slice(5, 7)) >= 4 ? `${y}-04` : `${y - 1}-04`;
}
export const fyLabel = (startMonth) => `FY ${startMonth.slice(0, 4)}-${String((Number(startMonth.slice(0, 4)) + 1) % 100).padStart(2, '0')}`;

export const monthName = (m) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;          // Oct 26
export const monthLong = (m) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;          // Oct 2026
export const shortDate = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}` : '—');
export const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '—');
export const dateYear = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}` : '—');
export function longDate(iso) {
  const d = new Date(utc(iso));
  return `${DAY[d.getUTCDay()]}, ${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

// ---- numbers ------------------------------------------------------------------------

export const num = (v) => {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function indian(n, digits = 0) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
// ₹1.23 Cr / ₹4.56 L / ₹7.8 K / ₹950
export function money(n, { exact = false } = {}) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (exact || a < 1000) return `${s}₹${indian(a, 0)}`;
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)} L`;
  return `${s}₹${(a / 1e3).toFixed(1)} K`;
}
export const rupees = (n) => money(n, { exact: true });
export function tonnes(n, digits = 2) {
  const v = Number(n) || 0;
  return `${v < 0 ? '−' : ''}${indian(Math.abs(v), digits)} T`;
}
export function litres(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e4) return `${s}${indian(a / 1000, 2)} KL`;
  return `${s}${indian(a, a % 1 ? 1 : 0)} L`;
}
export const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

// ---- names --------------------------------------------------------------------------

export const normKey = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
// XX01AB2010 -> "2010" (how the fleet is talked about)
export const shortVeh = (v) => {
  const m = String(v || '').match(/(\d{3,4})$/);
  return m ? m[1] : String(v || '');
};
