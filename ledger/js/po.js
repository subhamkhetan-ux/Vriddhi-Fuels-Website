// PO allocation — the same rule as the "PO No." formula on the *_Bulk sheets.
// The sheets have had two formulas; each bulk ledger keeps the one its sheet
// has (master.js reads it, `rule` below):
//
//   'pick'  (the formula now): going down the diesel bills in date order, the
//           POs whose litres left (allotted minus what earlier bills used)
//           cover the whole bill are the open ones. Exactly one → that PO.
//           More than one → no PO yet: Excel shows "Select PO ▼" and you pick
//           one (then it is typed in). None → no PO.
//   'first' (the earlier formula): the FIRST PO in the list with enough
//           litres left.
//
// Either way a bill too big for every PO gets no PO and uses nothing, so a
// later, smaller bill can still fit, and a PO typed in (po_mode 'fixed') is
// kept as it is and still uses up that PO's litres.
//
// Unit-wise lists (SMC): a bill needs a Unit first. "UNIT 1" bills use the
// first list, any other unit the second — as in
//   IF($J="UNIT 1", <UNIT 1 list>, <UNIT 2 list>)
// and litres are counted per unit.

export function poKey(s) {
  return String(s ?? '').trim().toUpperCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// Bills in the order the sheet has them: by date, then sheet row.
const PRODUCT_RANK = { HSD: 0, MS: 1, XG: 2 };
const rank = (p) => PRODUCT_RANK[p || 'HSD'] ?? 3;

// Bills in the order the sheet has them: by date; within a day the diesel
// rows, then petrol, then XtraGreen, each in its sale sheet's order.
export function billOrder(a, b) {
  return String(a.date).localeCompare(String(b.date)) || rank(a.product) - rank(b.product)
    || num(a.seq) - num(b.seq) || num(a.id) - num(b.id);
}

// kind: 'po' | 'po_units'; units: ['UNIT 1', 'UNIT 2'] for 'po_units'
// rule: 'pick' | 'first' (see above)
// pos:   [{id, unit, po_no, allotted, seq}]
// bills: [{qty, unit, po_mode, po_fixed, ...}] already in order (see billOrder)
// Returns {bills: [{po, how, choices?}] (same order), registers: [{unit, pos: [...]}]}
//   how: 'auto' | 'fixed' | 'choose' (more than one PO fits: pick one —
//        `choices` are those POs) | 'no-po' (no PO has enough left)
//        | 'needs-unit' | 'not-diesel' (petrol / XtraGreen: only a PO you pick)
export function allocate({ kind, units = [], pos = [], bills = [], rule = 'first' }) {
  const unitList = kind === 'po_units' ? units.map(poKey) : [''];
  const lists = new Map(unitList.map((u) => [u, []]));
  const sorted = [...pos].sort((a, b) => num(a.seq) - num(b.seq) || num(a.id) - num(b.id));
  for (const p of sorted) {
    const u = kind === 'po_units' ? poKey(p.unit) : '';
    if (!lists.has(u)) lists.set(u, []);
    lists.get(u).push(p);
  }
  const listFor = (unit) => {
    if (kind !== 'po_units') return lists.get('');
    if (lists.has(unit) && unitList.includes(unit)) return lists.get(unit);
    return lists.get(unitList[unitList.length - 1]) || [];
  };

  const used = new Map();                       // unit + PO -> litres used so far
  const results = bills.map((b) => {
    const qty = num(b.qty);
    const unit = kind === 'po_units' ? poKey(b.unit) : '';
    let po = '';
    let how;
    let choices = null;
    if (b.po_mode === 'fixed') {
      po = String(b.po_fixed ?? '').trim();
      how = 'fixed';
    } else if (b.product && b.product !== 'HSD') {
      how = 'not-diesel';
    } else if (kind === 'po_units' && !unit) {
      how = 'needs-unit';
    } else {
      const fits = [];
      for (const p of listFor(unit)) {
        const key = poKey(p.po_no);
        if (!key || fits.some((x) => poKey(x) === key)) continue;
        const left = num(p.allotted) - (used.get(unit + '\u0000' + key) || 0);
        if (qty > 0 && round3(left) >= qty) {
          fits.push(String(p.po_no).trim());
          if (rule !== 'pick') break;                      // the earlier formula: the first one
        }
      }
      if (fits.length === 1) { po = fits[0]; how = 'auto'; } else if (fits.length > 1) {
        how = 'choose';                                    // Excel: "Select PO ▼"
        choices = fits;
      } else how = 'no-po';
    }
    if (po) {
      const k = unit + '\u0000' + poKey(po);
      used.set(k, round3((used.get(k) || 0) + qty));
    }
    return choices ? { po, how, choices } : { po, how };
  });

  // Used / Balance / Status per PO (the tracker columns). With unit-wise
  // lists a PO's "Used" counts only bills of that list's unit.
  const registers = [...lists].map(([unit, list]) => ({
    unit,
    pos: list.map((p) => {
      const key = poKey(p.po_no);
      let usedL = 0;
      let count = 0;
      results.forEach((r, i) => {
        if (poKey(r.po) !== key) return;
        if (kind === 'po_units' && poKey(bills[i].unit) !== unit) return;
        usedL += num(bills[i].qty);
        count += 1;
      });
      const balance = round3(num(p.allotted) - usedL);
      return { ...p, used: round3(usedL), balance, bills: count, status: balance > 0 ? 'Pending' : 'Completed' };
    }),
  }));
  return { bills: results, registers };
}

// What a Master Ledger upload will do to the PO lists (the workbook is the
// source of truth — same rule as ledger_import_master in SQL): for every bulk
// ledger in the upload, its lists become the *_Bulk sheet's — POs added,
// litres / order changed, and POs not on the sheet (added in the app, or
// gone from Excel) removed.
//   current:  the app's POs [{group_code, unit, po_no, allotted, seq, source}]
//   incoming: the upload's POs [{group_code, unit, po_no, allotted, seq}]
//   groups:   the bulk ledgers in the upload (codes)
export function poListChanges(current, incoming, groups) {
  const up = new Set(groups);
  const key = (x) => `${x.group_code}|${poKey(x.unit)}|${poKey(x.po_no)}`;
  const src = new Map();
  for (const x of incoming || []) {
    const po = String(x.po_no ?? '').trim();
    if (!po || !up.has(x.group_code)) continue;
    const k = key(x);
    if (!src.has(k) || (x.seq || 0) < src.get(k).seq) src.set(k, { ...x, po_no: po, unit: poKey(x.unit), allotted: Number(x.allotted) || 0, seq: x.seq || 0 });
  }
  const rank = new Map();
  for (const x of [...src.values()].sort((a, b) => a.seq - b.seq || a.po_no.localeCompare(b.po_no))) {
    const lk = `${x.group_code}|${x.unit}`;
    rank.set(lk, (rank.get(lk) || 0) + 1);
    x.rn = rank.get(lk);
  }
  const lists = new Map();
  const list = (g, u) => {
    const lk = `${g}|${u}`;
    if (!lists.has(lk)) lists.set(lk, { group_code: g, unit: u, added: [], removed: [], changed: [], moved: 0 });
    return lists.get(lk);
  };
  const have = new Map((current || []).filter((x) => up.has(x.group_code)).map((x) => [key(x), x]));
  for (const [k, q] of have) if (!src.has(k)) list(q.group_code, q.unit).removed.push({ po_no: q.po_no, allotted: Number(q.allotted) || 0, source: q.source || 'app' });
  for (const [k, x] of src) {
    const q = have.get(k);
    const l = list(x.group_code, x.unit);
    if (!q) { l.added.push({ po_no: x.po_no, allotted: x.allotted }); continue; }
    if ((Number(q.allotted) || 0) !== x.allotted) l.changed.push({ po_no: x.po_no, from: Number(q.allotted) || 0, to: x.allotted });
    else if (q.seq !== x.rn) l.moved += 1;
  }
  return [...lists.values()].filter((l) => l.added.length || l.removed.length || l.changed.length || l.moved)
    .sort((a, b) => a.group_code.localeCompare(b.group_code) || a.unit.localeCompare(b.unit));
}
