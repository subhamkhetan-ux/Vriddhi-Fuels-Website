// Payments by mode — how money came in (Master Paid's "Payment Mode": HDFC
// 1010, ICICI Bank Ltd, XtraPower, Cash, …) over a period. Pure functions:
// no DOM, no network.
//
// The modes are typed by hand, so:
//   * spelling and case don't matter: "XtraPower" and "Xtrapower" are one
//     mode, shown as it is written most often;
//   * a split payment — "2.5 Cash + 1Lac HDFC 1010", "15000 HDFC + 35000
//     Cash" — counts in each mode with its own part, when the parts add up to
//     the payment (bare small numbers are lakhs, "k" thousands, "L" / "Lac" /
//     "lakh" lakhs; one part may leave its amount out: it gets the rest).
//     A part naming the start of a mode used whole in the period goes to that
//     mode ("HDFC" -> "HDFC 1010", "Swipe" -> "Swipe Machine Pine Labs");
//   * only the modes used in the period are listed: Cash first, XtraPower
//     next, the rest by amount, payments with no mode last.

const round2 = (n) => Math.round(n * 100) / 100;

// "ICICI BANK LTD." -> "icici bank ltd"
export function modeKey(mode) {
  return String(mode ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
export const NO_MODE = '';
export const isCash = (key) => /^cash\b/.test(key);
export const isXtraPower = (key) => /^xtra ?power\b/.test(key);
// Cash, XtraPower, the rest (by amount), no mode
const rankOf = (key) => (isCash(key) ? 0 : isXtraPower(key) ? 1 : key === NO_MODE ? 3 : 2);

const UNIT = { k: 1e3, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5 };
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)\s*(k|lacs?|lakhs?|l)?\b`;
const AMOUNT_FIRST = new RegExp(`^${NUM}\\s*(.*)$`, 'i');
const AMOUNT_LAST = new RegExp(`^(.*?)\\s+${NUM}$`, 'i');

// one part of a split: its mode and amount ("15000 HDFC", "1Lac HDFC 1010",
// "Cash 35000"); `last` marks an amount read off the end, which may as well
// be part of the name ("HDFC 1010")
function partOf(text) {
  const t = String(text).trim();
  let m = t.match(AMOUNT_FIRST);
  if (m && m[3].trim()) return { mode: m[3].trim(), n: Number(m[1].replace(/,/g, '')), unit: (m[2] || '').toLowerCase(), text: t };
  m = t.match(AMOUNT_LAST);
  if (m && m[1].trim()) return { mode: m[1].trim(), n: Number(m[2].replace(/,/g, '')), unit: (m[3] || '').toLowerCase(), text: t, last: true };
  return { mode: t, n: null, unit: '', text: t };
}

// "2.5 Cash + 1Lac HDFC 1010", 350000 -> [{mode: 'Cash', amount: 250000}, {mode: 'HDFC 1010', amount: 100000}]
// null when it isn't a split, or its parts don't add up to the payment.
export function splitMode(mode, amount) {
  const text = String(mode ?? '');
  if (!/[+&]/.test(text)) return null;
  const raw = text.split(/\s*[+&]\s*/).filter((x) => x.trim()).map(partOf);
  if (raw.length < 2 || raw.some((p) => !modeKey(p.mode))) return null;
  const total = Number(amount) || 0;
  if (!(total > 0)) return null;
  const scale = [(p) => p.n * (UNIT[p.unit] || 1), (p) => p.n * (UNIT[p.unit] || (p.n < 100 ? 1e5 : 1))];   // "2.5 Cash": lakhs
  for (const keepLast of [true, false]) {
    const parts = raw.map((p) => (p.last && !keepLast ? { mode: p.text, n: null } : p));
    for (const value of scale) {
      const vals = parts.map((p) => (p.n == null ? null : value(p)));
      const open = vals.filter((v) => v == null).length;
      const known = vals.reduce((a, v) => a + (v || 0), 0);
      if (open === 1 && known > 0 && known < total) {
        return parts.map((p, i) => ({ mode: p.mode, amount: round2(vals[i] == null ? total - known : vals[i]) }));
      }
      if (!open && Math.abs(known - total) < 1) return parts.map((p, i) => ({ mode: p.mode, amount: round2(vals[i]) }));
    }
  }
  return null;
}

// payments: [{pay_date, customer, amount, mode, remarks?, ...}] (one period)
// -> { total, count, modes: [{key, label, amount, count, customers, first,
//      last, share, split, refunds, byCustomer, months, payments}], from, to }
// payments of a mode: [{...payment, part (this mode's amount), whole (the
// payment), written (the mode as typed), split, modeKey}]
export function modeSummary(payments) {
  const rows = (payments || []).filter((p) => Number(p.amount));
  // the modes paid whole this period — what a split's short name stands for
  const whole = new Set();
  for (const p of rows) if (!splitMode(p.mode, p.amount)) whole.add(modeKey(p.mode));
  const resolve = (key) => {
    if (!key || whole.has(key)) return key;
    const longer = [...whole].filter((k) => k.startsWith(`${key} `));
    return longer.length === 1 ? longer[0] : key;
  };
  const modes = new Map();
  const spell = new Map();                      // key -> {written: count}
  const add = (key, written, p, part, split) => {
    if (!modes.has(key)) {
      modes.set(key, { key, amount: 0, count: 0, split: 0, refunds: 0, first: p.pay_date, last: p.pay_date, payments: [] });
      spell.set(key, new Map());
    }
    const m = modes.get(key);
    m.amount = round2(m.amount + part);
    if (part > 0) m.count += 1; else m.refunds += 1;
    if (split) m.split += 1;
    if (p.pay_date < m.first) m.first = p.pay_date;
    if (p.pay_date > m.last) m.last = p.pay_date;
    m.payments.push({ ...p, part, whole: Number(p.amount), written: String(p.mode ?? '').trim(), split, modeKey: key });
    const w = String(written ?? '').trim();
    if (w) spell.get(key).set(w, (spell.get(key).get(w) || 0) + (split ? 0.5 : 1));
  };
  for (const p of rows) {
    const parts = splitMode(p.mode, p.amount);
    if (parts) parts.forEach((x) => add(resolve(modeKey(x.mode)), x.mode, p, x.amount, true));
    else add(modeKey(p.mode), p.mode, p, Number(p.amount), false);
  }
  const total = round2(rows.reduce((a, p) => a + Number(p.amount), 0));
  const list = [...modes.values()].map((m) => {
    const names = [...spell.get(m.key)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const byCust = new Map();
    const byMonth = new Map();
    for (const p of m.payments) {
      const c = String(p.customer || '').trim() || 'Unnamed';
      const ck = modeKey(c);
      if (!byCust.has(ck)) byCust.set(ck, { name: c, amount: 0, count: 0, last: p.pay_date });
      const x = byCust.get(ck);
      x.amount = round2(x.amount + p.part); x.count += 1; if (p.pay_date > x.last) x.last = p.pay_date;
      const mk = p.pay_date.slice(0, 7);
      byMonth.set(mk, round2((byMonth.get(mk) || 0) + p.part));
    }
    m.payments.sort((a, b) => b.pay_date.localeCompare(a.pay_date) || b.part - a.part);
    return {
      ...m,
      label: m.key === NO_MODE ? 'No mode entered' : m.key === 'cash' ? 'Cash' : m.key === 'xtrapower' || m.key === 'xtra power' ? 'XtraPower'
        : (names[0] ? names[0][0] : m.key),
      cash: isCash(m.key), xtrapower: isXtraPower(m.key),
      customers: byCust.size,
      share: total ? m.amount / total : 0,
      byCustomer: [...byCust.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
      months: [...byMonth].sort((a, b) => a[0].localeCompare(b[0])).map(([month, amount]) => ({ month, amount })),
    };
  }).sort((a, b) => rankOf(a.key) - rankOf(b.key) || b.amount - a.amount || a.label.localeCompare(b.label));
  const dates = rows.map((p) => p.pay_date).sort();
  return { total, count: rows.length, modes: list, from: dates[0] || '', to: dates[dates.length - 1] || '' };
}
