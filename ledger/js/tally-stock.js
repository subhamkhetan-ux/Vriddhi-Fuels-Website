// Stock bought (or sold), item by item and month by month: how many packs,
// how many litres / kg — the pack size is read from the item's name
// ("SERVO 4T XTRA 10W30 900ML", "SERVO PRIDE 15W40 20 LTR", "1X12X1L",
// "GREASE 500 GM") — and the amount. Pure — no DOM.

import { FUELS } from './dash.js';
import { normName } from './tally-file.js';

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

const SIZE_UNIT = 'ML|MLS|L|LT|LTR|LTRS|LITRES?|LITERS?|KL|KGS?|KG|GMS?|GRMS?|GRAMS?|G';
const SIZE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${SIZE_UNIT})(?![A-Z0-9])`, 'g');
const CASE_BEFORE = new RegExp(`(\\d+)\\s*[X×*]\\s*(\\d+(?:\\.\\d+)?)\\s*(${SIZE_UNIT})(?![A-Z0-9])`);   // 12 X 1 L, 1X12X1L
const CASE_AFTER = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${SIZE_UNIT})\\s*[X×*]\\s*(\\d+)(?![A-Z0-9])`);    // 1 L X 12
// units that are one pack, a case of packs, or the volume itself
const PACK = new Set(['NOS', 'NO', 'PCS', 'PC', 'PIECE', 'PIECES', 'BTL', 'BTLS', 'BOTTLE', 'BOTTLES', 'CAN', 'CANS', 'TIN', 'TINS', 'PKT', 'PKTS', 'PACKET', 'PACKETS',
  'POUCH', 'POUCHES', 'JAR', 'JARS', 'BUCKET', 'BUCKETS', 'BKT', 'DRUM', 'DRUMS', 'BARREL', 'BARRELS', 'BRL', 'UNIT', 'UNITS', 'EA', 'SET', 'SETS', 'PAIL', 'PAILS']);
const CASE = new Set(['BOX', 'BOXES', 'CASE', 'CASES', 'CTN', 'CTNS', 'CARTON', 'CARTONS', 'CS']);
const VOLUME = { L: 1, LT: 1, LTR: 1, LTRS: 1, LITRE: 1, LITRES: 1, LITER: 1, LITERS: 1, KL: 1000, KG: 1, KGS: 1, ML: 0.001, G: 0.001, GM: 0.001, GMS: 0.001 };
const toMeasure = (u) => {
  const x = u.toUpperCase();
  if (/^(ML|MLS|L|LT|LTR|LTRS|LITRES?|LITERS?|KL)$/.test(x)) return { measure: 'L', factor: x.startsWith('ML') ? 0.001 : x === 'KL' ? 1000 : 1 };
  return { measure: 'KG', factor: /^(KG|KGS)$/.test(x) ? 1 : 0.001 };
};

// The pack in an item's name: {size, measure: 'L' | 'KG', perCase} (nulls when not there)
export function packOf(name) {
  const s = String(name || '').toUpperCase().replace(/(\d),(\d)/g, '$1.$2');
  let m = s.match(CASE_BEFORE);
  if (m) {
    const { measure, factor } = toMeasure(m[3]);
    // 1X12X1L: the count is the larger of the numbers before the size
    const counts = s.slice(0, m.index + m[0].length).match(/(\d+)\s*[X×*]\s*(?=\d)/g) || [];
    const per = Math.max(Number(m[1]), ...counts.map((c) => Number(c.replace(/\D/g, ''))));
    return { size: round3(Number(m[2]) * factor), measure, perCase: per > 1 ? per : null };
  }
  m = s.match(CASE_AFTER);
  if (m) {
    const { measure, factor } = toMeasure(m[2]);
    return { size: round3(Number(m[1]) * factor), measure, perCase: Number(m[3]) > 1 ? Number(m[3]) : null };
  }
  const all = [...s.matchAll(SIZE)];
  if (!all.length) return { size: null, measure: null, perCase: null };
  const last = all[all.length - 1];                         // the pack size comes last
  const { measure, factor } = toMeasure(last[2]);
  return { size: round3(Number(last[1]) * factor), measure, perCase: null };
}

// One stock line -> {packs, volume, measure}: packs bought and their litres / kg.
//   units: the masters' units (a compound 'Box of 24 Nos' says how many in a box)
export function lineVolume(item, units = new Map()) {
  const p = packOf(item.name);
  const unit = String(item.unit || '').toUpperCase();
  const qty = Number(item.qty) || 0;
  const vol = VOLUME[unit];
  if (vol != null) {
    const measure = /^(KG|KGS|G|GM|GMS)$/.test(unit) ? 'KG' : 'L';
    const volume = round3(qty * vol);
    return { packs: p.size ? round3(volume / p.size) : null, volume, measure, size: p.size };
  }
  let per = 1;
  if (CASE.has(unit) || (units.get(unit) && !units.get(unit).simple)) {
    const u = [...units.values()].find((x) => !x.simple && (x.base === unit || x.name.toUpperCase() === unit));
    per = (u && u.conversion) || p.perCase || null;
  } else if (!PACK.has(unit) && unit && !p.size) {
    return { packs: qty, volume: null, measure: null, size: null };
  }
  if (per == null) return { packs: null, volume: null, measure: p.measure, size: p.size, cases: qty };
  const packs = round3(qty * per);
  return { packs, volume: p.size ? round3(packs * p.size) : null, measure: p.measure, size: p.size };
}

const monthOf = (d) => d.slice(0, 7);

// Items bought (kind 'purchase') or sold (kind 'sale') from..to:
//   category: 'lubes' (everything that isn't diesel, petrol or XtraGreen),
//   'fuel', or 'all'. Purchase returns (debit notes) and sales returns
//   (credit notes) count against them.
//   exclude: items left out (normName of the item): still listed with their
//   own figures (off: true), but out of the months, parties and totals
export function stockSummary(vouchers, masters, { from, to, kind = 'purchase', category = 'lubes', exclude = new Set() } = {}) {
  const units = (masters && masters.units) || new Map();
  const back = kind === 'purchase' ? 'debitnote' : 'creditnote';
  const items = new Map();
  const months = new Map();
  const parties = new Map();
  const keep = (it) => (category === 'all') || (category === 'fuel' ? FUELS.includes(it.product) : !FUELS.includes(it.product));
  for (const v of vouchers) {
    if (v.cancelled || v.optional || v.date < from || v.date > to) continue;
    if (v.kind !== kind && v.kind !== back) continue;
    const sign = v.kind === back ? -1 : 1;
    let any = false;
    let counted = 0;
    for (const it of v.items) {
      if (!keep(it)) continue;
      const lv = lineVolume(it, units);
      const k = normName(it.name);
      const on = !exclude.has(k);
      if (on) { any = true; counted += sign * it.amount; }
      if (!items.has(k)) {
        items.set(k, {
          key: k, off: !on, name: it.name, group: it.group || (masters && (masters.stockItems.get(k) || {}).parent) || '', unit: it.unit, size: lv.size, measure: lv.measure,
          qty: 0, packs: 0, volume: 0, amount: 0, lines: 0, months: new Map(), parties: new Set(), lastRate: null, lastDate: null, unknownPack: false,
        });
      }
      const x = items.get(k);
      const add = (o) => {
        o.qty += sign * it.qty;
        o.amount += sign * it.amount;
        if (lv.packs != null) o.packs += sign * lv.packs;
        if (lv.volume != null) o.volume += sign * lv.volume;
      };
      add(x);
      x.lines += 1;
      if (lv.volume == null) x.unknownPack = true;
      if (v.party) x.parties.add(v.party);
      if (sign > 0 && (!x.lastDate || v.date >= x.lastDate)) { x.lastDate = v.date; x.lastRate = it.rate; }
      const mk = monthOf(v.date);
      const xm = x.months.get(mk) || { qty: 0, packs: 0, volume: 0, amount: 0 };
      add(xm);
      x.months.set(mk, xm);
      if (!on) continue;
      const tm = months.get(mk) || { month: mk, amount: 0, L: 0, KG: 0, packs: 0 };
      tm.amount += sign * it.amount;
      if (lv.volume != null && lv.measure) tm[lv.measure] += sign * lv.volume;
      if (lv.packs != null) tm.packs += sign * lv.packs;
      months.set(mk, tm);
    }
    if (any && v.party) {
      const p = parties.get(normName(v.party)) || { name: v.party, amount: 0, vouchers: 0, total: 0 };
      p.vouchers += 1;
      p.amount += counted;
      p.total += sign * v.amount;
      parties.set(normName(v.party), p);
    }
  }
  const list = [...items.values()].map((x) => ({
    ...x, parties: [...x.parties], qty: round3(x.qty), packs: round3(x.packs), volume: round3(x.volume), amount: round2(x.amount),
    perUnit: x.volume ? x.amount / x.volume : null, perPack: x.packs ? x.amount / x.packs : null,
  })).sort((a, b) => b.amount - a.amount);
  const live = list.filter((x) => !x.off);
  const monthList = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => ({ ...m, amount: round2(m.amount), L: round3(m.L), KG: round3(m.KG), packs: round3(m.packs) }));
  return {
    from, to, kind, category,
    items: list,
    months: monthList,
    parties: [...parties.values()].map((p) => ({ ...p, amount: round2(p.amount), total: round2(p.total) })).sort((a, b) => b.amount - a.amount),
    totals: {
      amount: round2(live.reduce((s, x) => s + x.amount, 0)),
      L: round3(live.filter((x) => x.measure === 'L').reduce((s, x) => s + x.volume, 0)),
      KG: round3(live.filter((x) => x.measure === 'KG').reduce((s, x) => s + x.volume, 0)),
      packs: round3(live.reduce((s, x) => s + x.packs, 0)),
      items: live.length,
      off: list.length - live.length,
      unknown: live.filter((x) => x.unknownPack).length,
    },
  };
}

// rows for an Excel sheet of one measure: item × month + total (the items
// left out aren't in it)
export function pivotSheet(sum, months, metric) {
  const items = sum.items.filter((x) => !x.off);
  const val = (o) => (metric === 'amount' ? round2(o.amount) : metric === 'packs' ? round3(o.packs) : metric === 'qty' ? round3(o.qty) : round3(o.volume));
  const head = ['Item', 'Group', 'Pack', ...months, 'Total'];
  const rows = items.map((x) => [x.name, x.group, x.size ? `${x.size} ${x.measure}` : '', ...months.map((m) => (x.months.get(m) ? val(x.months.get(m)) : '')), val(x)]);
  const total = ['Total', '', '', ...months.map((m) => {
    const t = items.reduce((s, x) => s + (x.months.get(m) && (metric !== 'volume' || x.measure === 'L') ? val(x.months.get(m)) : 0), 0);
    return metric === 'amount' ? round2(t) : round3(t);
  }), metric === 'amount' ? sum.totals.amount : metric === 'packs' ? sum.totals.packs : metric === 'volume' ? sum.totals.L : ''];
  return [head, ...rows, total];
}
