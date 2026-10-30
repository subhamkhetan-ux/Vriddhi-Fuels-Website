// Tally viewer: reads a Tally file and works out what is in it. Pure — no
// DOM, no network; the file never leaves the device and nothing is saved.
//
// Two kinds of file:
//   - the DayBook exported to Excel (the file Import reads): first sheet,
//     A Date  B Particulars  C Vch Type  D Qty  E Rate  F Vehicle  G Vch No.
//     H Debit  I Credit — every voucher type, not only the fuel credit bills;
//   - Tally's XML export (Day Book → Export → XML, UTF-16 or UTF-8): every
//     voucher with its ledger lines, stock items, narration and the
//     cancelled flag. Read with a plain-text scan, like the voucher app's
//     import, so a 100 MB export doesn't need a DOM.
// Both become the same voucher rows; analyseTally() works out the insights.

import { cellDate, cellNumber, cellText, isDateCell } from './util.js';
import { dayRsp, earningOf, FUELS } from './dash.js';

export const KIND_NAME = {
  sale: 'Sales', receipt: 'Receipts', payment: 'Payments', purchase: 'Purchases', journal: 'Journals',
  contra: 'Contra', creditnote: 'Credit notes', debitnote: 'Debit notes', other: 'Other',
};
export const KINDS = Object.keys(KIND_NAME);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// voucher types and products
// ---------------------------------------------------------------------------

// Fuel from a voucher type or stock item name: 'HSD CREDIT', 'High Speed
// Diesel' -> HSD; 'MS CASH', 'Motor Spirit' -> MS; 'XtraGreen Diesel' -> XG.
export function fuelOf(name) {
  const s = String(name || '').toUpperCase();
  if (/\bXG\b|XTRA\s*GREEN|XTRAGREEN/.test(s)) return 'XG';
  if (/\bHSD\b|DIESEL/.test(s)) return 'HSD';
  if (/\bMS\b|PETROL|MOTOR\s*SPIRIT/.test(s)) return 'MS';
  return null;
}

// What a voucher type is, from its name (Tally's own voucher types are named
// after their kind; the pump's are 'HSD CREDIT', 'MS CREDIT', 'XG CREDIT').
export function kindOf(type) {
  const s = String(type || '').toUpperCase();
  if (/CREDIT\s*NOTE|SALES?\s*RETURN|\bCN\b/.test(s)) return 'creditnote';
  if (/DEBIT\s*NOTE|PURCHASE\s*RETURN|\bDN\b/.test(s)) return 'debitnote';
  if (/RECEIPT|\bRCPT\b|\bREC\b/.test(s)) return 'receipt';
  if (/PAYMENT|\bPYMT\b|\bPMT\b/.test(s)) return 'payment';
  if (/CONTRA/.test(s)) return 'contra';
  if (/JOURNAL|\bJV\b/.test(s)) return 'journal';
  if (/PURCHASE|\bPURC/.test(s)) return 'purchase';
  if (/SALE|INVOICE|CREDIT|CASH|\bBILL\b/.test(s) || fuelOf(s)) return 'sale';
  return 'other';
}

// ---------------------------------------------------------------------------
// reading the file
// ---------------------------------------------------------------------------

// bytes -> text: Tally's XML export is UTF-16 (with BOM); other files UTF-8
export function decodeText(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  // no BOM: many zero bytes in the first few hundred = UTF-16
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < Math.min(b.length, 400); i++) if (!b[i]) { if (i % 2) zeroOdd++; else zeroEven++; }
  if (zeroOdd > 40) return new TextDecoder('utf-16le').decode(b);
  if (zeroEven > 40) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b).replace(/^﻿/, '');
}

// does this look like a Tally XML export (and not an Excel / zip file)?
export function looksLikeXml(buffer) {
  const head = decodeText(buffer.slice(0, 4096)).trimStart();
  return head.startsWith('<') && /<ENVELOPE|<TALLYMESSAGE|<VOUCHER/i.test(head);
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, d) => { const n = Number(d); return n >= 32 || n === 9 || n === 10 || n === 13 ? String.fromCodePoint(n) : ''; })
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const n = parseInt(h, 16); return n >= 32 || n === 9 || n === 10 || n === 13 ? String.fromCodePoint(n) : ''; })
    .replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => XML_ENTITIES[e])
    .trim();
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function tag(body, name) {
  const m = body.match(new RegExp(`<${reEsc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${reEsc(name)}>`));
  return m ? unescapeXml(m[1]) : '';
}
function attr(open, name) {
  const m = String(open || '').match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : '';
}
function blocks(body, name) {
  const re = new RegExp(`<${reEsc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${reEsc(name)}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}
// a list entry without the lists nested in it, so its own <AMOUNT> is the first
function own(body) {
  let s = body;
  let prev;
  do {
    prev = s;
    s = s.replace(/<([A-Z0-9_:]+)\.LIST(?:\s[^>]*)?>(?:(?!<\1\.LIST[\s>])[\s\S])*?<\/\1\.LIST>/g, '');
  } while (s !== prev);
  return s;
}
const num = (s) => {
  const v = parseFloat(String(s || '').replace(/,/g, '').trim().replace(/[^0-9.+-].*$/, ''));
  return Number.isFinite(v) ? v : null;
};
const tallyDate = (d) => (/^\d{8}$/.test(String(d).trim()) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);

// '24 Nos' -> {qty: 24, unit: 'NOS'}; ' 12000.000 LTR' -> {qty: 12000, unit: 'LTR'}
export function qtyUnit(s) {
  const m = String(s || '').trim().match(/^(-?[\d,]*\.?\d+)\s*([A-Za-z][A-Za-z.]*)?/);
  if (!m) return { qty: null, unit: '' };
  return { qty: Math.abs(Number(m[1].replace(/,/g, ''))), unit: (m[2] || '').replace(/\.$/, '').toUpperCase() };
}

const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
export { normName };

// Masters in a Tally XML export (All Masters, or a Day Book that carries
// them): groups, ledgers with their opening balance, stock items, stock
// groups and units. Opening balances in Tally's XML are negative for debit;
// here they are turned round: + = Dr (owed to us / an asset or expense).
export function parseMasters(text) {
  const groups = new Map();
  const ledgers = new Map();
  const stockItems = new Map();
  const stockGroups = new Map();
  const units = new Map();
  const re = /<(GROUP|LEDGER|STOCKITEM|STOCKGROUP|UNIT)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(text))) {
    const [, kind, open = '', body] = m;
    const o = own(body);
    const name = attr(open, 'NAME') || tag(o, 'NAME');
    if (!name) continue;
    const parent = tag(o, 'PARENT').replace(/^\W*Primary$/i, '');
    if (kind === 'GROUP') {
      groups.set(normName(name), {
        name, parent, revenue: /^yes$/i.test(tag(o, 'ISREVENUE')), grossProfit: /^yes$/i.test(tag(o, 'AFFECTSGROSSPROFIT')),
        debit: /^yes$/i.test(tag(o, 'ISDEEMEDPOSITIVE')),
      });
    } else if (kind === 'LEDGER') {
      const ob = num(tag(o, 'OPENINGBALANCE'));
      ledgers.set(normName(name), { name, parent, opening: ob == null ? 0 : round2(-ob), gstin: tag(o, 'PARTYGSTIN') });
    } else if (kind === 'STOCKITEM') {
      const oq = qtyUnit(tag(o, 'OPENINGBALANCE'));
      stockItems.set(normName(name), {
        name, parent, unit: tag(o, 'BASEUNITS').toUpperCase(), openingQty: oq.qty || 0, openingValue: Math.abs(num(tag(o, 'OPENINGVALUE')) || 0),
      });
    } else if (kind === 'STOCKGROUP') {
      stockGroups.set(normName(name), { name, parent });
    } else {
      // a compound unit: 'Box of 24 Nos' = 24 of its additional unit
      const simple = !/^no$/i.test(tag(o, 'ISSIMPLEUNIT'));
      units.set(name.toUpperCase(), {
        name, simple, base: tag(o, 'BASEUNITS').toUpperCase(), of: tag(o, 'ADDITIONALUNITS').toUpperCase(), conversion: num(tag(o, 'CONVERSION')),
      });
    }
  }
  return { groups, ledgers, stockItems, stockGroups, units };
}

const emptyMasters = () => ({ groups: new Map(), ledgers: new Map(), stockItems: new Map(), stockGroups: new Map(), units: new Map() });
export const hasMasters = (ms) => Boolean(ms && (ms.ledgers.size || ms.groups.size));

function entries(body, list) {
  const out = [];
  for (const e of blocks(body, list)) {
    const o = own(e);
    const amount = num(tag(o, 'AMOUNT'));
    const ledger = tag(o, 'LEDGERNAME');
    if (ledger && amount != null) out.push({ name: ledger, amount: round2(amount) });
  }
  return out;
}
const balanced = (list) => list.length && Math.abs(list.reduce((s, l) => s + l.amount, 0)) < 0.05;

// Tally XML text -> {vouchers, masters, company, skipped}
export function parseTallyXml(text) {
  const vouchers = [];
  let skipped = 0;
  const company = tag(text.slice(0, 20000), 'SVCURRENTCOMPANY') || null;
  const re = /<VOUCHER(\s[^>]*)?>([\s\S]*?)<\/VOUCHER>/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m[1] || '';
    const body = m[2];
    const type = attr(open, 'VCHTYPE') || tag(body, 'VOUCHERTYPENAME');
    const date = tallyDate(tag(body, 'DATE'));
    if (!date) { skipped += 1; continue; }
    const party = tag(body, 'PARTYLEDGERNAME') || tag(body, 'PARTYNAME');
    const items = [];
    const alloc = [];
    for (const name of ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST', 'INVENTORYALLOCATIONS.LIST']) {
      for (const e of blocks(body, name)) {
        const o = own(e);
        const item = tag(o, 'STOCKITEMNAME');
        if (!item) continue;
        const q = qtyUnit(tag(o, 'BILLEDQTY') || tag(o, 'ACTUALQTY'));
        items.push({
          name: item,
          product: fuelOf(item) || 'OTHER',
          qty: q.qty ?? 0,
          unit: q.unit,
          rate: num(tag(o, 'RATE')),
          amount: round2(Math.abs(num(tag(o, 'AMOUNT')) || 0)),
        });
        // the sales / purchase ledger the item books to
        if (name !== 'INVENTORYALLOCATIONS.LIST') alloc.push(...entries(e, 'ACCOUNTINGALLOCATIONS.LIST'));
      }
    }
    // An invoice lists the party in LEDGERENTRIES and the sales ledger under
    // its items; an accounting voucher lists everything in ALLLEDGERENTRIES.
    // Take the first set whose debits equal its credits, so nothing counts twice.
    const all = entries(body, 'ALLLEDGERENTRIES.LIST');
    const led = entries(body, 'LEDGERENTRIES.LIST');
    const sets = [[...all, ...led, ...alloc], [...all, ...alloc], [...led, ...alloc], all, led];
    const ledgers = sets.find(balanced) || sets.find((x) => x.length) || [];
    // Tally: a negative amount is a debit
    const debitSide = round2(ledgers.reduce((s, l) => s + (l.amount < 0 ? -l.amount : 0), 0));
    const creditSide = round2(ledgers.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0));
    const partyLine = ledgers.find((l) => l.name === party);
    const amount = debitSide || creditSide || round2(items.reduce((s, i) => s + i.amount, 0));
    const fuel = items.find((i) => i.product !== 'OTHER');
    vouchers.push(voucher({
      date,
      type,
      number: tag(body, 'VOUCHERNUMBER'),
      party: party || (ledgers[0] && ledgers[0].name) || '',
      vehicle: tag(body, 'UDF:EIVEHNO') || tag(body, 'BASICSHIPVEHICLENO'),
      qty: items.length ? round2(items.reduce((s, i) => s + i.qty, 0)) : null,
      rate: fuel ? fuel.rate : (items[0] ? items[0].rate : null),
      amount,
      debit: partyLine ? (partyLine.amount < 0 ? -partyLine.amount : null) : null,
      credit: partyLine ? (partyLine.amount > 0 ? partyLine.amount : null) : null,
      cancelled: /^yes$/i.test(tag(body, 'ISCANCELLED')),
      optional: /^yes$/i.test(tag(body, 'ISOPTIONAL')),
      narration: tag(body, 'NARRATION'),
      gstin: tag(body, 'PARTYGSTIN'),
      guid: tag(body, 'GUID'),
      balanced: balanced(ledgers),
      ledgers,
      items,
    }));
  }
  return { vouchers, masters: parseMasters(text), company, skipped, source: 'xml' };
}

// Several files read together (say the masters export and a year's Day Book,
// or the DayBook in Excel and in XML): one voucher list and one set of
// masters. A voucher already read from an earlier file (same type, number,
// date, party and amount) isn't added again; repeats inside one file stay.
export function mergeTally(files) {
  const vouchers = [];
  const masters = emptyMasters();
  const seen = new Map();
  const keyOf = (v) => `${v.type}|${v.number}|${v.date}|${normName(v.party)}|${Math.round(v.amount * 100)}`;
  let company = null;
  let duplicates = 0;
  for (const f of files) {
    company = company || f.company || null;
    const here = new Map();
    for (const v of f.vouchers) {
      const k = keyOf(v);
      if ((seen.get(k) || 0) > 0) { seen.set(k, seen.get(k) - 1); duplicates += 1; continue; }
      here.set(k, (here.get(k) || 0) + 1);
      vouchers.push(v);
    }
    for (const [k, n] of here) seen.set(k, (seen.get(k) || 0) + n);
    if (f.masters) for (const key of Object.keys(masters)) for (const [k, x] of f.masters[key]) masters[key].set(k, x);
  }
  // a stock item's group, from the masters
  for (const v of vouchers) for (const it of v.items) it.group = (masters.stockItems.get(normName(it.name)) || {}).parent || '';
  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    vouchers, masters, company, duplicates,
    names: files.map((f) => f.name).filter(Boolean),
    source: files.some((f) => f.source === 'xml') ? 'xml' : 'excel',
  };
}

// DayBook Excel rows (arrays of SheetJS cells, A..I) -> {vouchers, skipped}.
// Rows whose column A isn't a date (headers, totals, the ledger lines of a
// detailed DayBook) are skipped, as in Import.
export function parseDaybookSheet(rows, { date1904 = false } = {}) {
  const vouchers = [];
  let skipped = 0;
  let company = null;
  rows.forEach((r, i) => {
    if (!isDateCell(r[0])) {
      // the heading over the table: the company's name comes first
      const t = cellText(r[0]);
      if (!vouchers.length && !company && t && !/day\s*book|register|^date$|^for\b|^total/i.test(t)) company = t;
      else if (r.some((c) => cellText(c))) skipped += 1;
      return;
    }
    const date = cellDate(r[0], date1904);
    if (!date) { skipped += 1; return; }
    const debit = cellNumber(r[7]);
    const credit = cellNumber(r[8]);
    const type = cellText(r[2]);
    const qty = cellNumber(r[3]);
    const rate = cellNumber(r[4]);
    const amount = round2(Math.abs(debit ?? credit ?? 0));
    const kind = kindOf(type);
    const fuel = fuelOf(type);
    vouchers.push(voucher({
      date,
      type,
      number: cellText(r[6]),
      party: cellText(r[1]),
      vehicle: cellText(r[5]),
      qty,
      rate,
      amount,
      debit,
      credit,
      cancelled: /cancel/i.test(cellText(r[1])),
      items: kind === 'sale' ? [{ name: type, product: fuel || 'OTHER', qty: Math.abs(qty || 0), unit: '', rate, amount }] : [],
      // only the party's side is in the file: Debit = Dr (Tally: negative)
      ledgers: cellText(r[1]) && amount ? [{ name: cellText(r[1]), amount: debit != null ? -Math.abs(debit) : Math.abs(credit) }] : [],
      row: i + 1,
    }));
  });
  return { vouchers, company, skipped, source: 'excel' };
}

function voucher(v) {
  const kind = kindOf(v.type);
  return {
    date: v.date,
    type: String(v.type || '').trim() || '(no type)',
    kind,
    product: kind === 'sale' ? (fuelOf(v.type) || ((v.items || []).find((i) => i.product !== 'OTHER') || {}).product || 'OTHER') : null,
    number: String(v.number || '').trim(),
    party: String(v.party || '').trim(),
    vehicle: String(v.vehicle || '').replace(/\s+/g, '').toUpperCase(),
    qty: v.qty == null ? null : Number(v.qty),
    rate: v.rate == null ? null : Number(v.rate),
    amount: Number(v.amount) || 0,
    debit: v.debit ?? null,
    credit: v.credit ?? null,
    cancelled: Boolean(v.cancelled),
    optional: Boolean(v.optional),
    narration: v.narration || '',
    gstin: v.gstin || '',
    ledgers: v.ledgers || [],
    items: v.items || [],
    guid: v.guid || '',
    balanced: v.balanced ?? null,
    row: v.row ?? null,
  };
}

// ---------------------------------------------------------------------------
// insights
// ---------------------------------------------------------------------------

const blankFuel = () => ({ qty: 0, amount: 0, bills: 0, rateMin: null, rateMax: null, earning: 0, discount: 0 });
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fyOf = (iso) => { const y = Number(iso.slice(0, 4)); const s = Number(iso.slice(5, 7)) >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

// the dates in the file: {from, to}
export function spanOf(vouchers) {
  let from = null;
  let to = null;
  for (const v of vouchers) {
    if (!from || v.date < from) from = v.date;
    if (!to || v.date > to) to = v.date;
  }
  return { from, to };
}

// Everything the viewer shows, for the vouchers dated from..to.
//   earnings use the Home dashboard's rule (Module14), the day's RSP being
//   the highest rate billed that day in this file
export function analyseTally(all, { from = null, to = null } = {}) {
  const span = spanOf(all);
  from = from || span.from;
  to = to || span.to;
  const list = all.filter((v) => v.date >= from && v.date <= to);
  const live = list.filter((v) => !v.cancelled && !v.optional);

  // the day's RSP per fuel: the highest rate billed that day (whole file, so
  // a filtered range still gets its edges right)
  const rspRows = new Map();
  for (const v of all) {
    if (v.cancelled || v.kind !== 'sale') continue;
    for (const it of v.items) {
      if (!FUELS.includes(it.product) || !(it.rate > 0)) continue;
      const k = `${v.date}|${it.product}`;
      if (!rspRows.has(k) || rspRows.get(k) < it.rate) rspRows.set(k, it.rate);
    }
  }
  const rsp = dayRsp([...rspRows].map(([k, r]) => [...k.split('|'), r]));

  const products = { HSD: blankFuel(), MS: blankFuel(), XG: blankFuel(), OTHER: { amount: 0, bills: 0, items: new Map() } };
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { count: 0, amount: 0 }]));
  const types = new Map();
  const days = new Map();
  const parties = new Map();
  const vehicles = new Map();
  const ledgers = new Map();
  const rates = { HSD: new Map(), MS: new Map(), XG: new Map() };
  let noRsp = 0;

  for (let d = from; d && d <= to; d = addDays(d, 1)) {
    days.set(d, { date: d, qty: { HSD: 0, MS: 0, XG: 0 }, amount: 0, earning: 0, receipts: 0, payments: 0, bills: 0, vouchers: 0 });
  }
  const partyOf = (name) => {
    const key = name.toLowerCase();
    if (!parties.has(key)) {
      parties.set(key, {
        name, sales: 0, qty: 0, bills: 0, receipts: 0, payments: 0, other: 0, earning: 0, discount: 0, vouchers: 0,
        products: { HSD: { qty: 0, amount: 0 }, MS: { qty: 0, amount: 0 }, XG: { qty: 0, amount: 0 }, OTHER: { qty: 0, amount: 0 } },
        vehicles: new Set(), first: null, last: null, lastReceipt: null, gstin: '',
      });
    }
    return parties.get(key);
  };

  for (const v of list) {
    const t = types.get(v.type) || { type: v.type, kind: v.kind, product: v.product, count: 0, cancelled: 0, amount: 0, qty: 0, from: v.date, to: v.date };
    types.set(v.type, t);
    if (v.cancelled) { t.cancelled += 1; continue; }
    if (v.optional) continue;
    t.count += 1;
    t.amount += v.amount;
    if (v.date < t.from) t.from = v.date;
    if (v.date > t.to) t.to = v.date;
    byKind[v.kind].count += 1;
    byKind[v.kind].amount += v.amount;
    const day = days.get(v.date);
    day.vouchers += 1;
    const p = v.party ? partyOf(v.party) : null;
    if (p) {
      p.vouchers += 1;
      if (v.gstin) p.gstin = v.gstin;
    }
    for (const l of v.ledgers) {
      const x = ledgers.get(l.name) || { name: l.name, debit: 0, credit: 0, count: 0 };
      if (l.amount < 0) x.debit += -l.amount; else x.credit += l.amount;
      x.count += 1;
      ledgers.set(l.name, x);
    }
    if (v.kind === 'sale') {
      day.amount += v.amount;
      day.bills += 1;
      if (p) {
        p.sales += v.amount;
        p.bills += 1;
        if (!p.first || v.date < p.first) p.first = v.date;
        if (!p.last || v.date > p.last) p.last = v.date;
        if (v.vehicle) p.vehicles.add(v.vehicle);
      }
      let billQty = 0;
      for (const it of v.items) {
        if (it.product === 'OTHER') {
          products.OTHER.amount += it.amount;
          products.OTHER.items.set(it.name, (products.OTHER.items.get(it.name) || 0) + it.amount);
          if (p) p.products.OTHER.amount += it.amount;
          continue;
        }
        const f = products[it.product];
        f.qty += it.qty;
        f.amount += it.amount;
        billQty += it.qty;
        day.qty[it.product] += it.qty;
        if (it.rate > 0) {
          f.rateMin = f.rateMin == null ? it.rate : Math.min(f.rateMin, it.rate);
          f.rateMax = f.rateMax == null ? it.rate : Math.max(f.rateMax, it.rate);
          const r = rates[it.product].get(v.date) || { date: v.date, min: it.rate, max: it.rate, bills: 0 };
          r.min = Math.min(r.min, it.rate);
          r.max = Math.max(r.max, it.rate);
          r.bills += 1;
          rates[it.product].set(v.date, r);
        }
        const dayRate = rsp.at(it.product, v.date);
        const earn = earningOf(it.product, it.qty, it.amount, dayRate);
        if (earn == null) noRsp += 1;
        else {
          f.earning += earn;
          day.earning += earn;
          if (p) p.earning += earn;
        }
        // discount: litres × (day's RSP − rate billed), when billed under it
        const disc = dayRate != null && it.rate > 0 && it.rate < dayRate ? it.qty * (dayRate - it.rate) : 0;
        f.discount += disc;
        if (p) {
          p.products[it.product].qty += it.qty;
          p.products[it.product].amount += it.amount;
          p.qty += it.qty;
          p.discount += disc;
        }
      }
      const hasFuel = v.items.some((i) => i.product !== 'OTHER');
      if (hasFuel) products[v.product !== 'OTHER' ? v.product : v.items.find((i) => i.product !== 'OTHER').product].bills += 1;
      else products.OTHER.bills += 1;
      t.qty += billQty;
      if (v.vehicle && billQty > 0) {
        const x = vehicles.get(v.vehicle) || { vehicle: v.vehicle, qty: 0, amount: 0, fills: 0, parties: new Set(), last: null, products: new Set() };
        x.qty += billQty;
        x.amount += v.amount;
        x.fills += 1;
        if (v.party) x.parties.add(v.party);
        v.items.forEach((i) => { if (i.product !== 'OTHER') x.products.add(i.product); });
        if (!x.last || v.date > x.last) x.last = v.date;
        vehicles.set(v.vehicle, x);
      }
    } else if (v.kind === 'receipt') {
      day.receipts += v.amount;
      if (p) {
        p.receipts += v.amount;
        if (!p.lastReceipt || v.date > p.lastReceipt) p.lastReceipt = v.date;
      }
    } else if (v.kind === 'payment') {
      day.payments += v.amount;
      if (p) p.payments += v.amount;
    } else if (p) {
      p.other += v.amount;
    }
  }

  const dayList = [...days.values()];
  const active = dayList.filter((d) => d.vouchers);
  const saleDays = dayList.filter((d) => d.bills);
  const fuelQty = FUELS.reduce((s, f) => s + products[f].qty, 0);
  const salesAmt = byKind.sale.amount;
  const earning = FUELS.reduce((s, f) => s + products[f].earning, 0);

  // average litres per weekday, over the days that had sales
  const week = WEEKDAYS.map((name) => ({ name, days: 0, qty: 0, amount: 0 }));
  for (const d of saleDays) {
    const w = week[new Date(`${d.date}T00:00:00Z`).getUTCDay()];
    w.days += 1;
    w.qty += FUELS.reduce((s, f) => s + d.qty[f], 0);
    w.amount += d.amount;
  }
  const weekday = [1, 2, 3, 4, 5, 6, 0].map((i) => week[i]).map((w) => ({ ...w, avgQty: w.days ? w.qty / w.days : 0, avgAmount: w.days ? w.amount / w.days : 0 }));

  const partyList = [...parties.values()].map((p) => ({
    ...p, vehicles: p.vehicles.size, net: round2(p.sales - p.receipts), perLitre: p.qty ? p.earning / p.qty : 0,
  }));
  const vehicleList = [...vehicles.values()].map((x) => ({ ...x, parties: [...x.parties], products: [...x.products] }))
    .sort((a, b) => b.qty - a.qty);

  // rate changes: the day's highest rate moving from one sale day to the next
  const rateSeries = {};
  const changes = [];
  for (const f of FUELS) {
    const s = [...rates[f].values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    rateSeries[f] = s;
    for (let i = 1; i < s.length; i++) {
      if (Math.abs(s[i].max - s[i - 1].max) >= 0.005) changes.push({ product: f, date: s[i].date, from: s[i - 1].max, to: s[i].max });
    }
  }
  changes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    from,
    to,
    span,
    days: dayList.length,
    activeDays: active.length,
    saleDays: saleDays.length,
    counts: { all: list.length, live: live.length, cancelled: list.filter((v) => v.cancelled).length, optional: list.filter((v) => v.optional).length },
    byKind,
    kpi: {
      sales: salesAmt,
      qty: fuelQty,
      bills: byKind.sale.count,
      receipts: byKind.receipt.amount,
      payments: byKind.payment.amount,
      purchases: byKind.purchase.amount,
      earning,
      perLitre: fuelQty ? earning / fuelQty : 0,
      avgBill: byKind.sale.count ? salesAmt / byKind.sale.count : 0,
      perDay: saleDays.length ? fuelQty / saleDays.length : 0,
      parties: partyList.filter((p) => p.bills).length,
      vehicles: vehicleList.length,
      discount: FUELS.reduce((s, f) => s + products[f].discount, 0),
      noRsp,
    },
    types: [...types.values()].sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1)),
    products: { ...products, OTHER: { ...products.OTHER, items: [...products.OTHER.items].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount) } },
    daily: dayList,
    weekday,
    parties: partyList,
    vehicles: vehicleList,
    rates: rateSeries,
    changes,
    ledgers: [...ledgers.values()].sort((a, b) => (b.debit + b.credit) - (a.debit + a.credit)),
    series: numberSeries(list),
    checks: checks(list),
  };
}

// Voucher numbers per type (and prefix, and FY — numbering restarts each
// April): the range, the numbers missing in between, numbers used twice and
// bills numbered lower than the one before them.
export function numberSeries(list, { maxGap = 5000, listMissing = 200 } = {}) {
  const groups = new Map();
  for (const v of list) {
    if (!v.number) continue;
    const m = v.number.match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const key = `${v.type}|${m[1]}|${fyOf(v.date)}`;
    if (!groups.has(key)) groups.set(key, { type: v.type, kind: v.kind, prefix: m[1], fy: fyOf(v.date), rows: [] });
    groups.get(key).rows.push({ n: Number(m[2]), number: v.number, date: v.date, cancelled: v.cancelled, order: v.row ?? 0 });
  }
  const out = [];
  for (const g of groups.values()) {
    const seen = new Map();
    for (const r of g.rows) seen.set(r.n, (seen.get(r.n) || 0) + 1);
    const ns = [...seen.keys()].sort((a, b) => a - b);
    const min = ns[0];
    const max = ns[ns.length - 1];
    const missing = [];
    let missingCount = 0;
    if (max - min <= maxGap) {
      for (let n = min + 1; n < max; n++) {
        if (!seen.has(n)) {
          missingCount += 1;
          if (missing.length < listMissing) missing.push(`${g.prefix}${n}`);
        }
      }
    }
    const duplicates = [...seen].filter(([, c]) => c > 1).map(([n, c]) => ({ number: `${g.prefix}${n}`, count: c }));
    // out of order: by date (then the file's order), a number lower than the highest before it
    const byDate = [...g.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    let hi = -Infinity;
    const outOfOrder = [];
    for (const r of byDate) {
      if (r.n < hi) outOfOrder.push({ number: r.number, date: r.date });
      hi = Math.max(hi, r.n);
    }
    out.push({
      type: g.type, kind: g.kind, prefix: g.prefix, fy: g.fy, count: g.rows.length,
      first: `${g.prefix}${min}`, last: `${g.prefix}${max}`, missing, missingCount, tooWide: max - min > maxGap,
      duplicates, outOfOrder,
      cancelled: g.rows.filter((r) => r.cancelled).length,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

// Things worth a second look: litres × rate ≠ amount, fuel bills without a
// vehicle or party, zero-amount vouchers, cancelled ones.
export function checks(list) {
  const out = { mismatch: [], noVehicle: [], noParty: [], zero: [], cancelled: [], noNumber: [] };
  for (const v of list) {
    if (v.cancelled) { out.cancelled.push(v); continue; }
    if (v.optional) continue;
    if (!v.amount) out.zero.push(v);
    if (!v.party) out.noParty.push(v);
    if (!v.number && v.kind === 'sale') out.noNumber.push(v);
    if (v.kind !== 'sale') continue;
    for (const it of v.items) {
      if (it.product === 'OTHER' || !(it.qty > 0) || !(it.rate > 0)) continue;
      const diff = it.qty * it.rate - it.amount;
      if (Math.abs(diff) > 1) out.mismatch.push({ ...v, expected: round2(it.qty * it.rate), diff: round2(diff) });
    }
    if (v.items.some((i) => i.product !== 'OTHER') && !v.vehicle) out.noVehicle.push(v);
  }
  return out;
}

// the voucher list, filtered: {kind, product, q (party / vehicle / no. /
// type / narration)}, newest first
export function filterVouchers(all, { from, to, kind = 'all', product = 'all', q = '', cancelled = true } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return all.filter((v) => (!from || v.date >= from) && (!to || v.date <= to)
    && (kind === 'all' || v.kind === kind)
    && (product === 'all' || v.product === product || v.items.some((i) => i.product === product))
    && (cancelled || !v.cancelled)
    && (!needle || [v.party, v.vehicle, v.number, v.type, v.narration].some((s) => String(s).toLowerCase().includes(needle))))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.row ?? 0) - (a.row ?? 0)));
}

// rows for an Excel download of a voucher list
export function voucherSheet(list) {
  const head = ['Date', 'Vch Type', 'Kind', 'Vch No.', 'Particulars', 'Vehicle', 'Product', 'Qty', 'Rate', 'Amount', 'Debit', 'Credit', 'Cancelled', 'Narration'];
  return [head, ...list.map((v) => [
    v.date, v.type, KIND_NAME[v.kind], v.number, v.party, v.vehicle, v.product || '', v.qty ?? '', v.rate ?? '', v.amount,
    v.debit ?? '', v.credit ?? '', v.cancelled ? 'Yes' : '', v.narration,
  ])];
}
