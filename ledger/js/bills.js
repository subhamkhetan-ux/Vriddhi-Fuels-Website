// Phase 2: which bills go into which PDF — the rules of the workbook's
//   Daily Tanker Bill  (Module8 ExportHSDBills)   and
//   Print Bills        (Module7 ExportBillsPerCustomer).
// Pure functions: no DOM, no network. Rendering is in render.js.

import { normKey } from './util.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

// ---- name helpers (Module8) -------------------------------------------------

// lower-case, leading "M/s" dropped, only letters and digits kept
export function normalizeName(s) {
  let t = String(s ?? '').trim().toLowerCase();
  if (t.startsWith('m/s')) t = t.slice(3);
  return t.replace(/[^a-z0-9]/g, '');
}

// ... and "private"/"limited" read as "pvt"/"ltd"
export function normalizeCompany(s) {
  return normalizeName(s).replaceAll('private', 'pvt').replaceAll('limited', 'ltd');
}

const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');

function unitToken(s) {                        // "UNIT 1" -> "i", "UNIT II" -> "ii"
  const d = digitsOnly(s);
  if (d) return { 1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v' }[Number(d)] || d;
  let n = normalizeName(s);
  if (n.startsWith('unit')) n = n.slice(4);
  return n;
}

function stripMs(nm) {
  let t = String(nm ?? '').trim();
  if (/^m\/s[ .]/i.test(t)) t = t.slice(4).trim();
  return t;
}

export function firstNWords(nm, n) {
  const words = stripMs(nm).split(' ').map((w) => w.trim()).filter(Boolean).slice(0, n);
  const w = words.join(' ').replace(/[/\\:*?"<>|,]/g, '-').trim();
  return w || 'Customer';
}

export function wordCount(nm) {
  return stripMs(nm).split(' ').filter((w) => w.trim()).length;
}

export function ddMonth(iso) {                 // 2026-09-05 -> "05 September"
  return `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

export function dmy(iso, sep = '-') {          // 2026-09-05 -> 05-09-2026
  return `${iso.slice(8, 10)}${sep}${iso.slice(5, 7)}${sep}${iso.slice(0, 4)}`;
}

// ---- Daily Tanker Bill --------------------------------------------------------

// Which Tanker Master company a sale is billed to: the same name (any case),
// or — for unit-wise customers — the name plus the bill's unit
// ("…, UNIT I" for UNIT 1). '' = not in Tanker Master: no bill.
export function resolveCustomer(customer, unit, companies) {
  const want = String(customer ?? '').trim().toLowerCase();
  if (!want) return '';
  const exact = companies.find((c) => String(c).trim().toLowerCase() === want);
  if (exact) return exact;
  if (!String(unit ?? '').trim()) return '';
  const cn = normalizeName(customer);
  if (!cn) return '';
  const tok = unitToken(unit);
  const dig = digitsOnly(unit);
  for (const c of companies) {
    const mn = normalizeName(c);
    if (mn.length > cn.length && mn.startsWith(cn)) {
      const tail = mn.slice(cn.length);
      if (tail === 'unit' + tok || (dig && tail === 'unit' + dig)) return c;
    }
  }
  return '';
}

function smcUnitDigit(resolved, unit) {
  const d = digitsOnly(unit);
  if (d) return d;
  const n = normalizeName(resolved);
  if (n.endsWith('unitiii')) return '3';
  if (n.endsWith('unitii')) return '2';
  if (n.endsWith('uniti')) return '1';
  return '';
}

// One PDF per group per day for the four group customers, and one per
// customer per day for everyone else (Module8 BundleInfo).
export function bundleInfo(resolved, unit, isoDate, lakhanpur) {
  const n = normalizeCompany(resolved);
  let prefix;
  let group = true;
  if (lakhanpur.has(n)) prefix = 'ESM';
  else if (n.startsWith('smcpowergeneration')) {
    const u = smcUnitDigit(resolved, unit);
    prefix = u ? `SMC Unit ${u}` : 'SMC';
  } else if (n.startsWith('orissametaliks')) prefix = 'OMPL';
  else if (n.startsWith('shyammetalics')) prefix = 'SMEL';
  else {
    group = false;
    prefix = firstNWords(resolved, 2);
  }
  const day = isoDate.replaceAll('-', '');
  return {
    key: group ? `GRP|${prefix.toUpperCase()}|${day}` : `CUST|${n}|${day}`,
    fileBase: `${prefix} ${ddMonth(isoDate)}`,
    group,
  };
}

// sales: HSD bills (any order; taken in sheet order = seq)
// tanker: [{company, address[], payment[], ...}]
// poOf(bill) -> PO for the bill ('' = none); lakhanpur: Set of normalizeCompany names
export function tankerBundles({ sales, tanker, poOf, lakhanpur = new Set(), from, to, filter = '' }) {
  const companies = tanker.map((t) => t.company);
  const byCompany = new Map(tanker.map((t) => [t.company, t]));
  const f = String(filter).trim().toLowerCase();
  const inRange = sales
    .filter((s) => s.product === 'HSD' && s.sale_date >= from && s.sale_date <= to)
    .filter((s) => !f || String(s.customer).toLowerCase().includes(f))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.id ?? 0) - (b.id ?? 0));

  const bundles = [];
  const byKey = new Map();
  const skipped = new Map();
  for (const s of inRange) {
    const resolved = resolveCustomer(s.customer, s.unit, companies);
    if (!resolved) {
      skipped.set(s.customer, (skipped.get(s.customer) || 0) + 1);
      continue;
    }
    const info = bundleInfo(resolved, s.unit, s.sale_date, lakhanpur);
    let b = byKey.get(info.key);
    if (!b) {
      b = { key: info.key, file: info.fileBase, name: resolved, date: s.sale_date, group: info.group, depth: 2, bills: [] };
      byKey.set(info.key, b);
      bundles.push(b);
    }
    b.bills.push({ ...s, company: byCompany.get(resolved), po: poOf(s) || '' });
  }

  // Two different bundles with the same file name: lengthen the customer
  // part word by word, then number what's still equal.
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 1; k < bundles.length; k++) {
      for (let m = 0; m < k; m++) {
        if (!same(bundles[k].file, bundles[m].file)) continue;
        for (const x of [bundles[k], bundles[m]]) {
          if (!x.group && x.depth < wordCount(x.name)) {
            x.depth += 1;
            x.file = `${firstNWords(x.name, x.depth)} ${ddMonth(x.date)}`;
            changed = true;
            break;
          }
        }
      }
    }
  }
  const files = bundles.map((b) => b.file);
  bundles.forEach((b, k) => {
    const dup = files.slice(0, k).filter((x) => same(x, files[k])).length + 1;
    b.fileName = `${dup > 1 ? `${b.file} (${dup})` : b.file}.pdf`;
  });

  return {
    bundles: bundles.map(({ key, fileName, name, date, bills }) => ({ key, fileName, name, date, bills })),
    bills: bundles.reduce((a, b) => a + b.bills.length, 0),
    inRange: inRange.length,
    skipped: [...skipped].map(([customer, count]) => ({ customer, count })),
  };
}

// ---- Print Bills (fuel slips) ---------------------------------------------------

export function safeName(s) {
  let t = String(s ?? '').replace(/[/\\:*?"<>|\n\r\t]/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (!t) t = 'Customer';
  return t.slice(0, 120);
}

const SLIP_ORDER = ['HSD', 'MS', 'XG'];

// One PDF per customer (one A5 page per bill): diesel bills first, then
// petrol, then XtraGreen, each in sheet order. The filter is an exact name
// (any case); blank = everyone.
export function slipBundles({ sales, from, to, filter = '' }) {
  const f = String(filter).trim().toLowerCase();
  const rows = sales
    .filter((s) => SLIP_ORDER.includes(s.product) && String(s.bill_no ?? '').trim() && s.sale_date >= from && s.sale_date <= to)
    .sort((a, b) => SLIP_ORDER.indexOf(a.product) - SLIP_ORDER.indexOf(b.product)
      || (a.seq ?? 0) - (b.seq ?? 0) || (a.id ?? 0) - (b.id ?? 0))
    .map((s) => ({ ...s, who: String(s.customer ?? '').trim() || '(No Customer)' }))
    .filter((s) => !f || s.who.toLowerCase() === f);

  const dateStr = from === to ? dmy(from) : `${dmy(from)} to ${dmy(to)}`;
  const groups = new Map();
  for (const s of rows) {
    const k = s.who.toLowerCase();
    if (!groups.has(k)) groups.set(k, { name: s.who, bills: [] });
    groups.get(k).bills.push(s);
  }
  const used = new Set();
  const bundles = [...groups.values()].map((g) => {
    const base = safeName(`${g.name} Slips ${dateStr}`);
    let name = base;
    for (let dup = 2; used.has(name.toLowerCase()); dup++) name = `${base} (${dup})`;
    used.add(name.toLowerCase());
    return { key: normKey(g.name), fileName: `${name}.pdf`, name: g.name, bills: g.bills };
  });
  return { folder: `Fuel Bills ${dmy(from)} to ${dmy(to)}`, bundles, bills: rows.length };
}
