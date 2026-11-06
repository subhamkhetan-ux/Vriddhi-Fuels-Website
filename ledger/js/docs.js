// The Quotation and the Proforma Invoice, made from the workbook model
// (xl-model.js) and worked out by the workbook's own formulas (formula.js).
// Nothing about the sheets' layout or arithmetic is written here; what is:
//   - which sheet each document is ("Quotation Maker", "Proforma Invoice");
//   - how to find the cells you fill in: blue text (the sheet's own note:
//     "Blue-on-yellow cells are inputs"), drop-down lists, and — for the
//     Proforma — the cells the Print & Log PI macro restores on a reprint;
//   - the PI Log: which cell goes in which column is read from the macro
//     (WriteLogRow / LoadLogRowToSheet in Module1).
// Pure: tested in node (tests/ledger_web/docs.test.mjs).

import { addrOf, colName, display, isErr, isoToSerial, makeCalc, numText, parseAddr, parseRange, serialToIso } from './formula.js';
import { PT_PER_UNIT, expand } from './xl-model.js';
import { cleanName, firstTwoWords, longDate, PI_COLUMNS, headerLabel } from './quote.js';

export const DOCS = {
  quotation: { sheet: 'Quotation Maker', word: 'Quotation' },
  proforma: { sheet: 'Proforma Invoice', word: 'PI' },
};
const EMU = 12700;
const BLUE = /^#0000FF$/i;
const INPUT_FILL = /^#FFF2CC$/i;

// ---- the macro: where Print & Log PI reads and writes ----------------------------
// (also the app's fallback when a workbook has no macro)
export const DEFAULT_PI_MACRO = {
  sheet: 'Proforma Invoice', custSheet: 'Customers', logTable: 'PILog',
  write: {
    pi_no: 'G4', pi_date: 'G5', valid_to: 'G6', customer: 'A12', gstin: 'A15', place: 'G9', po_no: 'G7', po_date: 'G8',
    description: 'B19', hsn: 'D19', qty: 'E19', rate: 'F19', rsp: 'Customers!P2', sub_total: 'G23', round_off: 'G24',
    grand_total: 'G25', points: 'K25', words: 'C27', contact: 'E16',
  },
  load: {
    customer: 'A12', pi_no: 'G4', pi_date: 'G5', po_date: 'G8', place: 'G9', contact: 'E16', description: 'B19', hsn: 'D19',
    qty: 'E19', rate: 'F19', po_no: 'G7', rsp: 'Customers!P2',
  },
  required: [
    { addr: 'G4', msg: 'Proforma Invoice No. is blank.' }, { addr: 'A12', msg: 'Buyer is blank.' },
    { addr: 'E19', msg: 'Quantity is missing or zero.', positive: true },
  ],
  pdf: { customer: 'A12', date: 'G5', word: 'PI' },
  from: 'default',
};

const bodyOf = (src, name) => {
  const m = new RegExp(`Sub\\s+${name}\\b[\\s\\S]*?\\n([\\s\\S]*?)\\nEnd Sub`, 'i').exec(src);
  return m ? m[1] : '';
};
export function piMacro(model) {
  const src = Object.values((model && model.vba) || {}).find((t) => /Sub\s+PrintAndLogPI\b/i.test(t));
  if (!src) return { ...DEFAULT_PI_MACRO, note: 'The workbook has no Print & Log PI macro — the app uses the cells it had (G4, A12, E19 …).' };
  const consts = {};
  const strs = {};
  for (const line of src.split('\n')) {
    if (!/^\s*(Private\s+|Public\s+)?Const\b/i.test(line)) continue;
    for (const m of line.matchAll(/\b([A-Z_][A-Z0-9_]*)\s*(?:As\s+\w+\s*)?=\s*("([^"]*)"|-?\d+)/gi)) {
      if (m[3] != null) strs[m[1].toUpperCase()] = m[3]; else consts[m[1].toUpperCase()] = Number(m[2]);
    }
  }
  const sheet = strs.PI_SHEET || DEFAULT_PI_MACRO.sheet;
  const custSheet = strs.CUST_SHEET || DEFAULT_PI_MACRO.custSheet;
  const logTable = strs.LOG_TABLE || DEFAULT_PI_MACRO.logTable;
  const tbl = model.tables && model.tables[logTable];
  const fieldOfCol = (name) => {
    const n = consts[String(name).toUpperCase()];
    if (!tbl || !n) return null;
    const head = headerLabel(tbl.cols[n - 1] || '');
    return Object.keys(PI_COLUMNS).find((k) => PI_COLUMNS[k] === head) || null;
  };
  const where = (target, a) => (/^ws$/i.test(target) ? a : `${/cs|CUST_SHEET/i.test(target) ? custSheet : target}!${a}`);
  const write = {};
  for (const m of bodyOf(src, 'WriteLogRow').matchAll(/\.Range\(1,\s*(C_\w+)\)\.Value\s*=\s*(?:CStr\()?(ws|ThisWorkbook\.Worksheets\((\w+)\))\.Range\("([A-Z]+\d+)"\)/gi)) {
    const f = fieldOfCol(m[1]);
    if (f) write[f] = where(m[3] ? m[3] : m[2], m[4].toUpperCase());
  }
  const load = {};
  for (const m of bodyOf(src, 'LoadLogRowToSheet').matchAll(/\b(ws|cs)\.Range\("([A-Z]+\d+)"\)\.Value\s*=\s*(?:CStr\()?rw\.Range\(1,\s*(C_\w+)\)/gi)) {
    const f = fieldOfCol(m[3]);
    if (f) load[f] = where(m[1], m[2].toUpperCase());
  }
  const required = [];
  const main = bodyOf(src, 'PrintAndLogPI');
  const vars = {};                                       // piNo = Trim$(CStr(ws.Range("G4").Value))
  for (const m of main.matchAll(/^\s*(\w+)\s*=\s*[^\n]*?ws\.Range\("([A-Z]+\d+)"\)/gim)) vars[m[1].toLowerCase()] = m[2].toUpperCase();
  for (const m of main.matchAll(/If\s+([^\n]*?)Then\s*\n?\s*MsgBox\s+"([^"]+)"/gi)) {
    const cond = m[1];
    const cell = /ws\.Range\("([A-Z]+\d+)"\)/i.exec(cond);
    const v = Object.keys(vars).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(cond));
    const addr = cell ? cell[1].toUpperCase() : v ? vars[v] : null;
    if (addr && !required.some((x) => x.addr === addr)) required.push({ addr, msg: m[2].replace(/\s*\([A-Z]+\d+\)/, ''), positive: /IsNumeric/i.test(cond) });
  }
  const pdfCall = /PdfFileName\(\s*CStr\(ws\.Range\("([A-Z]+\d+)"\)\.Value\),\s*ws\.Range\("([A-Z]+\d+)"\)/i.exec(src);
  const word = (/nm\s*&\s*"\s+([^"]+?)\s+"\s*&\s*dt/i.exec(bodyOf(src.replace(/Function/g, 'Sub'), 'PdfFileName')) || [])[1];
  const ok = write.pi_no && write.customer && write.qty;
  if (!ok) return { ...DEFAULT_PI_MACRO, note: 'Couldn\'t read where Print & Log PI writes the PI Log (Module1 WriteLogRow) — the app uses the cells it had (G4, A12, E19 …).' };
  return {
    sheet, custSheet, logTable, write, load: Object.keys(load).length ? load : DEFAULT_PI_MACRO.load,
    required: required.length ? required : DEFAULT_PI_MACRO.required,
    pdf: { customer: pdfCall ? pdfCall[1].toUpperCase() : write.customer, date: pdfCall ? pdfCall[2].toUpperCase() : write.pi_date, word: word || 'PI' },
    from: 'macro',
  };
}
const splitRef = (ref, sheet) => {
  const m = /^(?:'?([^'!]+)'?!)?\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
  return m ? { sheet: m[1] || sheet, addr: `${m[2].toUpperCase()}${m[3]}` } : null;
};

// ---- reading the sheet ----------------------------------------------------------------
const sheetOf = (model, name) => model.sheets && model.sheets[name];
const styleOf = (model, sheet, a) => { const c = sheetOf(model, sheet)?.cells[a]; return c && c.s != null ? model.styles.xf[c.s] || null : null; };
const isFormula = (model, sheet, a) => Boolean(sheetOf(model, sheet)?.cells[a]?.f);
const textAt = (model, sheet, a) => { const c = sheetOf(model, sheet)?.cells[a]; return c && !c.f && typeof c.v === 'string' ? c.v.trim() : ''; };
const covering = (layout) => {
  const map = new Map();
  for (const rg of layout.merges || []) {
    const r = parseRange(rg);
    if (!r) continue;
    for (let i = r.r0; i <= r.r1; i++) for (let j = r.c0; j <= r.c1; j++) map.set(addrOf(i, j), addrOf(r.r0, r.c0));
  }
  return map;
};

// what a cell you fill in is called: its own prompt ("Contact Person / Mob:"),
// else the text to its left on the row, else the heading above it
function labelFor(model, sheet, a, inputs) {
  const own = textAt(model, sheet, a);
  if (own && /:\s*$/.test(own)) return own.replace(/:\s*$/, '');
  const L = sheetOf(model, sheet).layout;
  const top = covering(L);
  const { r, c } = parseAddr(a);
  for (let cc = c - 1; cc >= Math.max(0, c - 4); cc--) {
    const at = top.get(addrOf(r, cc)) || addrOf(r, cc);
    if (at === (top.get(a) || a)) continue;
    if (inputs.has(at) || isFormula(model, sheet, at)) break;
    const t = textAt(model, sheet, at);
    if (t) return t.replace(/:\s*$/, '');
  }
  for (let rr = r - 1; rr >= Math.max(0, r - 3); rr--) {
    const at = top.get(addrOf(rr, c)) || addrOf(rr, c);
    if (inputs.has(at)) continue;
    const t = textAt(model, sheet, at);
    if (t) return t.replace(/:\s*$/, '');
    if (isFormula(model, sheet, at)) break;
  }
  return own || a;
}

const DATE_FMT = /(^|[^"\\])[dmy]{1,4}/i;
const isDateFormat = (z) => Boolean(z) && DATE_FMT.test(z.replace(/"[^"]*"/g, '')) && !/[#0]/.test(z.replace(/"[^"]*"/g, ''));

// The cells the form asks for, in reading order (row by row)
export function inputsOf(model, docKey, calc, macro = null) {
  const sheet = DOCS[docKey].sheet;
  const sh = sheetOf(model, sheet);
  if (!sh || !sh.layout) return [];
  const L = sh.layout;
  const set = new Set();
  for (const [a, c] of Object.entries(sh.cells)) {
    const st = c.s != null ? model.styles.xf[c.s] : null;
    if (!st || !BLUE.test(st.c || '')) continue;
    if (c.f && !INPUT_FILL.test(st.bg || '')) continue;      // blue formulas are worked out, not typed
    set.add(a);
  }
  for (const d of L.dv || []) for (const a of expand(d.sqref)) if (d.type === 'list') set.add(a);
  if (macro) for (const ref of Object.values(macro.load)) { const p = splitRef(ref, sheet); if (p && p.sheet === sheet) set.add(p.addr); }
  const top = covering(L);
  for (const a of [...set]) if (top.has(a) && top.get(a) !== a) set.delete(a);   // the rest of a merged cell
  const out = [];
  for (const a of set) {
    const label = labelFor(model, sheet, a, set);
    if (/^s\.?\s*no\.?$/i.test(label) || /^sr\.?\s*no\.?$/i.test(label)) continue;   // a line number
    const cell = sh.cells[a] || {};
    const st = styleOf(model, sheet, a) || {};
    const dv = (L.dv || []).find((d) => d.type === 'list' && expand(d.sqref).includes(a));
    let kind = 'text';
    let options = null;
    if (dv) {
      kind = 'select';
      const f = dv.formula.trim();
      if (/^".*"$/.test(f)) options = f.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
      else options = [...new Set(calc.list(calc.formula(f, sheet, a)).filter((x) => x != null && x !== '' && !isErr(x)).map(String))];
    } else if (isDateFormat(cell.z || st.z) || (/date/i.test(label) && typeof cell.v === 'number')) kind = 'date';
    else if (typeof cell.v === 'number' && cell.z !== '@') kind = 'number';
    else if ((typeof cell.v === 'string' && cell.v.length > 60) || st.w) kind = 'textarea';
    out.push({ addr: a, label, kind, options, formula: Boolean(cell.f), outside: !inArea(L.area, a) });
  }
  const pos = (a) => { const p = parseAddr(a); return p.r * 1000 + p.c; };
  return out.sort((x, y) => (x.outside - y.outside) || pos(x.addr) - pos(y.addr));
}
const inArea = (area, a) => { const p = parseAddr(a); return p && p.r >= area.r0 && p.r <= area.r1 && p.c >= area.c0 && p.c <= area.c1; };

// The IOCL RSP the documents use: the cell Print & Log PI logs as the RSP
// (Customers!P2), else RateCard's "HSD RSP" row
export function rspCell(model, macro) {
  const ref = macro && macro.write.rsp ? splitRef(macro.write.rsp, macro.sheet) : null;
  if (ref && sheetOf(model, ref.sheet)) return ref;
  for (const t of Object.values(model.tables || {})) {
    const ci = t.cols.findIndex((x) => /price tier/i.test(x));
    const ri = t.cols.findIndex((x) => /^rate$/i.test(x));
    if (ci < 0 || ri < 0) continue;
    for (let r = t.r0 + 1; r <= t.r1; r++) {
      const v = sheetOf(model, t.sheet)?.cells[addrOf(r, t.c0 + ci)];
      if (v && String(v.v).trim().toUpperCase() === 'HSD RSP') return { sheet: t.sheet, addr: addrOf(r, t.c0 + ri) };
    }
  }
  return null;
}

// The helper block beside the page (outside the print area): headings, each
// label with its worked-out value, and notes — the "Calculated" panel.
export function helperRows(model, docKey, inputs = []) {
  const sheet = DOCS[docKey].sheet;
  const sh = sheetOf(model, sheet);
  if (!sh || !sh.layout) return [];
  const { area } = sh.layout;
  const skip = new Set(inputs.map((x) => x.addr));
  const byRow = new Map();
  for (const [a, c] of Object.entries(sh.cells)) {
    if (inArea(area, a) || (c.v == null && !c.f)) continue;
    const p = parseAddr(a);
    if (!byRow.has(p.r)) byRow.set(p.r, []);
    byRow.get(p.r).push({ a, c: p.c, cell: c });
  }
  const out = [];
  for (const r of [...byRow.keys()].sort((x, y) => x - y)) {
    const cells = byRow.get(r).sort((x, y) => x.c - y.c);
    for (let i = 0; i < cells.length; i++) {
      const x = cells[i];
      if (skip.has(x.a)) continue;
      const isText = !x.cell.f && typeof x.cell.v === 'string';
      const next = cells[i + 1];
      if (isText && next && next.c - x.c <= 2) {
        if (!skip.has(next.a)) out.push({ kind: 'pair', label: x.cell.v.trim().replace(/:\s*$/, ''), addr: next.a, formula: Boolean(next.cell.f) });
        i++;
        continue;
      }
      if (isText) {
        const st = styleOf(model, sheet, x.a) || {};
        out.push({ kind: x.cell.v.length > 40 || st.w ? 'note' : 'head', text: x.cell.v.trim() });
      } else out.push({ kind: 'pair', label: x.a, addr: x.a, formula: Boolean(x.cell.f) });
    }
  }
  // headings with nothing under them (e.g. "QUOTATION INPUTS" over the form's cells) are dropped
  return out.filter((row, i) => row.kind !== 'head' || (out[i + 1] && out[i + 1].kind === 'pair'));
}

// ---- working it out -----------------------------------------------------------------
// state: {inputs: {addr: value}, overrides: {'Sheet!A1' or addr: value}, rsp}
// Typed values: a date as an ISO string (-> Excel serial), numbers as numbers.
export function docCalc(model, docKey, state = {}, { format, today, macro } = {}) {
  const sheet = DOCS[docKey].sheet;
  const ov = {};
  const put = (ref, v) => { const p = splitRef(ref, sheet); if (p) ov[`${p.sheet}!${p.addr}`] = v; };
  for (const [ref, v] of Object.entries(state.overrides || {})) put(ref, v);
  for (const [a, v] of Object.entries(state.inputs || {})) if (v !== undefined) put(a, v);
  if (state.rsp != null && state.rsp !== '') { const c = rspCell(model, macro || piMacro(model)); if (c) ov[`${c.sheet}!${c.addr}`] = Number(state.rsp); }
  return makeCalc(model, { overrides: ov, format, today: today != null ? today : undefined });
}
// a typed value -> what goes in the cell
export function cellInput(kind, raw) {
  if (raw == null || raw === '') return kind === 'number' || kind === 'date' ? null : '';
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? isoToSerial(raw) : raw;
  if (kind === 'number') return Number.isFinite(Number(raw)) ? Number(raw) : raw;
  return String(raw);
}
// a cell's value -> what the form shows
export function formValue(kind, v) {
  if (v == null || isErr(v)) return '';
  if (kind === 'date') return typeof v === 'number' ? serialToIso(v) : '';
  if (typeof v === 'number') return numText(v);
  return String(v);
}

// What every cell of the page shows, with the sheet's conditional formats
export function pageValues(model, docKey, calc, format) {
  const sheet = DOCS[docKey].sheet;
  const sh = sheetOf(model, sheet);
  const L = sh.layout;
  const values = {};
  // every cell of the area the sheet knows (an empty one may have been typed into)
  for (const [a, c] of Object.entries(sh.cells)) {
    if (!inArea(L.area, a)) continue;
    const v = calc.value(sheet, a);
    const text = display(v, c.z || (c.s != null && model.styles.xf[c.s] ? model.styles.xf[c.s].z : undefined), format);
    if (text !== '') values[a] = { text, num: typeof v === 'number' };
  }
  for (const rule of L.cf || []) {
    const st = rule.dxf != null ? model.styles.dxf[rule.dxf] : null;
    if (!st) continue;
    const cells = expand(rule.sqref);
    const first = parseRange(String(rule.sqref).split(/\s+/)[0]);
    for (const a of cells) {
      const p = parseAddr(a);
      const shift = { dr: p.r - first.r0, dc: p.c - first.c0 };
      let hit = false;
      if (rule.type === 'expression' && rule.formulas[0]) hit = calc.one(calc.formula(rule.formulas[0], sheet, first ? addrOf(first.r0, first.c0) : a, shift)) === true;
      else if (rule.type === 'cellIs' && rule.formulas[0]) {
        const v = calc.value(sheet, a);
        const x = calc.one(calc.formula(rule.formulas[0], sheet, a, shift));
        const y = rule.formulas[1] != null ? calc.one(calc.formula(rule.formulas[1], sheet, a, shift)) : null;
        const n = (q) => (typeof q === 'number' ? q : Number.NaN);
        hit = ({
          equal: v === x || String(v) === String(x), notEqual: String(v) !== String(x), greaterThan: n(v) > n(x), lessThan: n(v) < n(x),
          greaterThanOrEqual: n(v) >= n(x), lessThanOrEqual: n(v) <= n(x), between: n(v) >= n(x) && n(v) <= n(y), notBetween: n(v) < n(x) || n(v) > n(y),
        })[rule.operator] || false;
      }
      if (!hit) continue;
      values[a] = { ...(values[a] || { text: '' }), ...(st.b != null ? { b: st.b } : {}), ...(st.i != null ? { i: st.i } : {}), ...(st.c ? { c: st.c } : {}), ...(st.bg ? { bg: st.bg } : {}) };
    }
  }
  return values;
}

// The sheet's print area for sheet-svg.js: widths and heights in points,
// merged cells, styles, and where the pictures are
export function layoutOf(model, docKey) {
  const sh = sheetOf(model, DOCS[docKey].sheet);
  const L = sh.layout;
  const { area } = L;
  const cols = L.widths.slice(0, area.c1 + 1).map((w, i) => (i < area.c0 ? 0 : Math.round(w * PT_PER_UNIT * 100) / 100));
  const rows = L.heights.slice(0, area.r1 + 1).map((h, i) => (i < area.r0 ? 0 : h));
  while (cols.length < area.c1 + 1) cols.push(Math.round(8.43 * PT_PER_UNIT * 100) / 100);
  while (rows.length < area.r1 + 1) rows.push(15);
  const cells = {};
  for (const [a, c] of Object.entries(sh.cells)) if (c.s != null && inArea(area, a)) cells[a] = { s: c.s };
  const x = (col, off) => cols.slice(0, col).reduce((s, w) => s + w, 0) + off / EMU;
  const y = (row, off) => rows.slice(0, row).reduce((s, h) => s + h, 0) + off / EMU;
  let stamps = 0;
  const images = (L.pictures || []).filter((p) => p.from[0] <= area.c1 && p.from[2] <= area.r1).map((p) => {
    const x0 = x(p.from[0], p.from[1]);
    const y0 = y(p.from[2], p.from[3]);
    const x1 = p.to ? x(p.to[0], p.to[1]) : x0 + (p.ext ? p.ext[0] / EMU : 0);
    const y1 = p.to ? y(p.to[2], p.to[3]) : y0 + (p.ext ? p.ext[1] / EMU : 0);
    const key = p.from[2] === 0 ? 'letterhead' : (stamps++ ? `stamp${stamps}` : 'stamp');
    return { key, media: p.media, x: +x0.toFixed(2), y: +y0.toFixed(2), w: +(x1 - x0).toFixed(2), h: +(y1 - y0).toFixed(2) };
  });
  return {
    sheet: DOCS[docKey].sheet, cols, rows, margins: L.margins, center: L.center,
    merges: (L.merges || []).filter((m) => { const r = parseRange(m); return r && r.r0 <= area.r1 && r.c0 <= area.c1; }),
    styles: model.styles.xf, cells, images,
  };
}

// ---- the PI Log ----------------------------------------------------------------
const DATE_FIELDS = new Set(['pi_date', 'valid_to', 'po_date']);
const NUM_FIELDS = new Set(['qty', 'rate', 'rsp', 'sub_total', 'round_off', 'grand_total', 'points']);
const asText = (v) => (v == null || isErr(v) ? '' : typeof v === 'number' ? numText(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

// WriteLogRow: the PI Log row of what is on the sheet now
export function piLogRowOf(calc, macro, model, extra = {}) {
  const row = {};
  for (const [field, ref] of Object.entries(macro.write)) {
    const p = splitRef(ref, macro.sheet);
    const v = p ? calc.value(p.sheet, p.addr) : null;
    if (DATE_FIELDS.has(field)) row[field] = typeof v === 'number' ? serialToIso(v) : null;
    else if (NUM_FIELDS.has(field)) row[field] = typeof v === 'number' ? v : (v == null || v === '' || isErr(v) ? null : Number(v));
    else row[field] = asText(v);
  }
  row.pi_no = String(row.pi_no || '').trim();
  row.doc = { customer_row: customerRow(model, calc, row.customer), ...extra };
  return row;
}
// the customer's row of the Customers table as it is now (kept with the PI)
export function customerRow(model, calc, company) {
  const t = customersTable(model);
  if (!t || !company) return null;
  const ci = t.cols.findIndex((x) => /^company$/i.test(x));
  for (let r = t.r0 + 1; r <= t.r1; r++) {
    if (String(calc.value(t.sheet, addrOf(r, t.c0 + ci)) ?? '').trim().toLowerCase() !== String(company).trim().toLowerCase()) continue;
    const out = {};
    t.cols.forEach((col, i) => { const v = calc.value(t.sheet, addrOf(r, t.c0 + i)); out[col] = isErr(v) ? null : v; });
    return out;
  }
  return null;
}
export const customersTable = (model) => Object.values(model.tables || {}).find((t) => t.cols.some((x) => /^company$/i.test(x)) && t.cols.some((x) => /^address 1$/i.test(x)))
  || Object.values(model.tables || {}).find((t) => t.cols.some((x) => /^company$/i.test(x)));

// LoadLogRowToSheet: a logged PI back on the sheet, with its own rate, RSP,
// P.O. — and the customer's lines as printed when the app kept them
export function piStateFromLog(row, macro, model) {
  const inputs = {};
  const overrides = {};
  for (const [field, ref] of Object.entries(macro.load)) {
    let v = row[field];
    if (DATE_FIELDS.has(field)) v = v ? isoToSerial(v) : null;
    else if (NUM_FIELDS.has(field)) v = v == null || v === '' ? null : Number(v);
    else v = v == null ? '' : String(v);
    overrides[ref] = v;
  }
  const doc = row.doc || {};
  const t = customersTable(model);
  const snap = doc.customer_row || (doc.address || doc.payment ? Object.fromEntries([
    ...(doc.address || []).map((x, i) => [`Address ${i + 1}`, x]), ...(doc.payment || []).map((x, i) => [`Payment ${i + 1}`, x]),
  ]) : null);
  if (t && snap) {
    const ci = t.cols.findIndex((x) => /^company$/i.test(x));
    for (let r = t.r0 + 1; r <= t.r1; r++) {
      const c = sheetOf(model, t.sheet)?.cells[addrOf(r, t.c0 + ci)];
      if (!c || String(c.v ?? '').trim().toLowerCase() !== String(row.customer || '').trim().toLowerCase()) continue;
      t.cols.forEach((col, i) => { if (col in snap && !/^company$/i.test(col)) overrides[`${t.sheet}!${addrOf(r, t.c0 + i)}`] = snap[col]; });
      break;
    }
  }
  for (const [a, v] of Object.entries(doc.inputs || {})) if (!(a in overrides)) inputs[a] = v;
  return { inputs, overrides };
}

// Print & Log PI's checks (PI No., buyer, quantity) — the first that fails
export function piProblem(calc, macro) {
  for (const r of macro.required) {
    const p = splitRef(r.addr, macro.sheet);
    const v = calc.value(p.sheet, p.addr);
    if (r.positive ? !(typeof v === 'number' && v > 0) : String(v ?? '').trim() === '') return r.msg;
  }
  return '';
}

// "<first two words of the customer> PI <d mmmm yyyy>.pdf" (the macro's PdfFileName)
export function docFileName(docKey, calc, { customerAddr, dateAddr, word }) {
  const sheet = DOCS[docKey].sheet;
  const cust = customerAddr ? calc.value(sheet, customerAddr) : '';
  const d = dateAddr ? calc.value(sheet, dateAddr) : null;
  const iso = typeof d === 'number' ? serialToIso(d) : new Date().toISOString().slice(0, 10);
  return `${cleanName(`${firstTwoWords(asText(cust)) || 'Customer'} ${word || DOCS[docKey].word} ${longDate(iso)}`)}.pdf`;
}

// ---- the self-check ------------------------------------------------------------------
// Every formula worked out with the workbook's own inputs, against what Excel
// saved: when they all agree, the app follows the workbook; when not, the
// import says which cells (and which functions it doesn't know).
export function selfCheck(model, format) {
  const calc = makeCalc(model, { format, today: model.saved_today != null ? model.saved_today : undefined });
  const bad = [];
  let count = 0;
  let linked = 0;
  let unsaved = 0;                                     // no result saved with the formula (file not last saved by Excel)
  for (const [s, sh] of Object.entries(model.sheets)) {
    for (const [a, c] of Object.entries(sh.cells)) {
      if (c.ext) { linked++; continue; }
      if (!c.f || c.spill) continue;
      if (model.saved_today == null && /\b(TODAY|NOW)\s*\(/i.test(c.f)) continue;
      if (c.v === undefined && !c.e) { unsaved++; continue; }
      count++;
      const got = calc.value(s, a);
      const want = c.e ? { code: c.e } : (c.v ?? null);
      let same;
      if (isErr(got)) same = Boolean(want && want.code === got.code);
      else if (typeof got === 'number' && typeof want === 'number') same = Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
      else same = (got ?? '') === (want ?? '') || (got === false && want === false);
      if (!same) bad.push({ sheet: s, addr: a, f: c.f, excel: want && want.code ? want.code : want, app: isErr(got) ? got.code : got });
    }
  }
  return { count, bad, unknown: [...calc.unknown], linked, unsaved };
}

export { colName };
