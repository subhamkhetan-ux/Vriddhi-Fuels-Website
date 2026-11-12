// A small spreadsheet engine: works out the Tanker Billing workbook's own
// formulas, so the Quotation Maker and Proforma Invoice follow whatever the
// workbook says — new rows, new helper cells, new tables, new tiers — with
// no change to the app.
//
//   makeCalc(model, opts) -> { value(sheet, addr), text(sheet, addr), unknown }
//
// model: see xl-model.js — {sheets: {name: {cells: {A1: {v, f, z}}}}, names, tables}
// opts.overrides {'Sheet!A1': value} — what the form typed in (wins over the cell)
// opts.today     Excel serial for TODAY()
// opts.format    (numFmt, value) -> text (the app passes SheetJS's SSF.format)
//
// Values: number | string | boolean | null (blank) | XLError. A reference is a
// Range until it is used; arrays are {kind: 'array', rows: [[...]]}.
// Pure (no DOM): tested in node (tests/ledger_web/formula.test.mjs).

export class XLError {
  constructor(code) { this.code = code; }
  toString() { return this.code; }
}
const ERR = (c) => new XLError(c);
export const isErr = (v) => v instanceof XLError;
const NA = () => ERR('#N/A');
const VALUE = () => ERR('#VALUE!');

// ---- addresses ------------------------------------------------------------------
export function colNum(letters) { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
export function colName(i) { let s = ''; let n = i + 1; while (n) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); } return s; }
export const addrOf = (r, c) => `${colName(c)}${r + 1}`;
export function parseAddr(a) {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(String(a).trim());
  return m ? { r: Number(m[2]) - 1, c: colNum(m[1]) } : null;
}
export function parseRange(ref) {
  const [a, b] = String(ref).replace(/\$/g, '').split(':');
  const p = parseAddr(a);
  const q = b ? parseAddr(b) : p;
  if (!p || !q) return null;
  return { r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) };
}

// ---- tokens ------------------------------------------------------------------------
const ERRORS = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA)/i;
function tokenize(src) {
  const s = String(src).replace(/^=/, '');
  const out = [];
  let i = 0;
  const rest = () => s.slice(i);
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= s.length) throw new Error('A text in quotes is not closed');
        if (s[j] === '"') { if (s[j + 1] === '"') { v += '"'; j += 2; continue; } break; }
        v += s[j++];
      }
      out.push({ k: 'str', v });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const m = ERRORS.exec(rest());
      if (m) { out.push({ k: 'err', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    }
    if (ch === "'") {                                   // 'Sheet Name'!
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= s.length) throw new Error('A sheet name in quotes is not closed');
        if (s[j] === "'") { if (s[j + 1] === "'") { v += "'"; j += 2; continue; } break; }
        v += s[j++];
      }
      if (s[j + 1] !== '!') throw new Error(`'${v}' is not followed by !`);
      out.push({ k: 'sheet', v });
      i = j + 2;
      continue;
    }
    let m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?![A-Za-z0-9_.(![])/.exec(rest());
    if (m) {
      const raw = m[0];
      out.push({ k: 'ref', r: Number(m[2]) - 1, c: colNum(m[1]), absC: raw.startsWith('$'), absR: /\$\d/.test(raw) });
      i += raw.length;
      continue;
    }
    m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest());
    if (m) { out.push({ k: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if (ch === '[' || /[A-Za-z_\\]/.test(ch)) {
      let name = '';
      if (ch !== '[') {
        m = /^[A-Za-z_\\][A-Za-z0-9_.\\]*/.exec(rest());
        name = m[0];
        i += name.length;
      }
      if (s[i] === '[') {                               // Table[...] / [@Col] / [[#This Row],[Col]]
        let depth = 0;
        let j = i;
        for (; j < s.length; j++) {
          if (s[j] === "'" ) { j++; continue; }          // ' escapes the next character
          if (s[j] === '[') depth++;
          else if (s[j] === ']') { depth--; if (depth === 0) break; }
        }
        out.push({ k: 'sref', table: name || null, spec: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
      if (s[i] === '!') { out.push({ k: 'sheet', v: name }); i++; continue; }
      if (s[i] === '(') { out.push({ k: 'fn', v: name }); i++; continue; }
      const up = name.toUpperCase();
      if (up === 'TRUE' || up === 'FALSE') { out.push({ k: 'bool', v: up === 'TRUE' }); continue; }
      out.push({ k: 'name', v: name });
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') { out.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%:'.includes(ch)) { out.push({ k: 'op', v: ch }); i++; continue; }
    if ('(),;{}'.includes(ch)) { out.push({ k: ch }); i++; continue; }
    if (ch === '@') { i++; continue; }                   // implicit intersection: ignored
    throw new Error(`Can't read "${ch}" in the formula`);
  }
  return out;
}

// ---- parser (precedence as Excel's) ------------------------------------------------
const BIN = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
const parsed = new Map();
export function parseFormula(src) {
  if (parsed.has(src)) return parsed.get(src);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (k) => { const t = toks[p]; if (!t || (k && t.k !== k)) throw new Error(`Expected ${k || 'more'} in the formula`); p++; return t; };
  const primary = () => {
    const t = toks[p];
    if (!t) throw new Error('The formula ends too early');
    if (t.k === 'op' && (t.v === '-' || t.v === '+')) { p++; return { t: 'un', op: t.v, a: unary() }; }
    p++;
    switch (t.k) {
      case 'num': return { t: 'lit', v: t.v };
      case 'str': return { t: 'lit', v: t.v };
      case 'bool': return { t: 'lit', v: t.v };
      case 'err': return { t: 'lit', v: ERR(t.v) };
      case 'sheet': {
        const r = take('ref');
        return refNode(t.v, r);
      }
      case 'ref': return refNode(null, t);
      case 'sref': return { t: 'sref', table: t.table, spec: t.spec };
      case 'name': return { t: 'name', v: t.v };
      case 'fn': {
        const args = [];
        if (peek() && peek().k === ')') { p++; return { t: 'fn', name: fnName(t.v), args }; }
        for (;;) {
          if (peek() && (peek().k === ',' || peek().k === ')')) args.push({ t: 'missing' });
          else args.push(expr(0));
          const n = take();
          if (n.k === ')') break;
          if (n.k !== ',') throw new Error(`Expected , or ) after an argument of ${t.v}`);
        }
        return { t: 'fn', name: fnName(t.v), args };
      }
      case '(': { const e = expr(0); take(')'); return e; }
      case '{': {
        const rows = [[]];
        for (;;) {
          rows[rows.length - 1].push(unary());
          const n = take();
          if (n.k === '}') break;
          if (n.k === ';') rows.push([]);
          else if (n.k !== ',') throw new Error('Expected , ; or } in an array');
        }
        return { t: 'arr', rows };
      }
      default: throw new Error(`Unexpected ${t.k} in the formula`);
    }
  };
  const refNode = (sheet, r) => {
    const a = { t: 'ref', sheet, r: r.r, c: r.c, absR: r.absR, absC: r.absC };
    if (peek() && peek().k === 'op' && peek().v === ':' && toks[p + 1] && toks[p + 1].k === 'ref') {
      p++;
      const b = take('ref');
      return { t: 'range', sheet, a, b: { r: b.r, c: b.c, absR: b.absR, absC: b.absC } };
    }
    return a;
  };
  const unary = () => {
    let e = primary();
    while (peek() && peek().k === 'op' && peek().v === '%') { p++; e = { t: 'pct', a: e }; }
    return e;
  };
  const expr = (min) => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t || t.k !== 'op' || !(t.v in BIN)) break;
      const prec = BIN[t.v];
      if (prec < min) break;
      p++;
      const right = expr(prec + 1);                    // left to right, ^ too (as Excel)
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  };
  const ast = expr(0);
  if (p < toks.length) throw new Error('Something is left over at the end of the formula');
  parsed.set(src, ast);
  return ast;
}
const fnName = (n) => String(n).toUpperCase().replace(/^(_XLFN\.|_XLWS\.)+/, '').replace(/^_XLFN\./, '');

// ---- dates ------------------------------------------------------------------------
const DAY = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);
export const isoToSerial = (iso) => Math.round((Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) - EPOCH) / DAY);
export const serialToIso = (n) => new Date(EPOCH + Math.round(Number(n)) * DAY).toISOString().slice(0, 10);
const ymd = (n) => { const d = new Date(EPOCH + Math.floor(Number(n)) * DAY); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
const serialOf = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY);

// ---- value helpers ---------------------------------------------------------------
const isRange = (v) => v && typeof v === 'object' && v.kind === 'range';
const isArray = (v) => v && typeof v === 'object' && v.kind === 'array';
const multi = (v) => (isRange(v) && (v.r0 !== v.r1 || v.c0 !== v.c1)) || (isArray(v) && (v.rows.length > 1 || v.rows[0].length > 1));
const arr = (rows) => ({ kind: 'array', rows });

// a number as Excel puts it into text: 15 significant digits
export function numText(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  const v = Number(n.toPrecision(15));
  const s = String(v);
  return /e/.test(s) ? s.replace('e+', 'E+').replace('e-', 'E-') : s;
}
const pre = (x) => Number(Number(x).toPrecision(15));

// Excel's wildcards (* ? ~) -> RegExp
function wildcard(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '~' && i + 1 < pat.length) { out += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    out += ch === '*' ? '[\\s\\S]*' : ch === '?' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

// ---- the calculator ------------------------------------------------------------------
export function makeCalc(model, opts = {}) {
  const overrides = opts.overrides || {};
  const format = opts.format || basicFormat;
  const today = opts.today != null ? opts.today : isoToSerial(new Date().toISOString().slice(0, 10));
  const cache = new Map();
  const busy = new Set();
  const unknown = new Set();
  const sheets = model.sheets || {};
  const sheetOf = (name) => {
    if (sheets[name]) return name;
    const k = Object.keys(sheets).find((x) => x.toLowerCase() === String(name).toLowerCase());
    return k || null;
  };
  const tables = model.tables || {};
  const tableOf = (name) => tables[name] || tables[Object.keys(tables).find((x) => x.toLowerCase() === String(name).toLowerCase())];
  const names = {};
  for (const [k, v] of Object.entries(model.names || {})) names[k.toUpperCase()] = v;

  // a cell's value: typed-in override, else its formula, else what's in it
  function cellValue(sheet, r, c) {
    const key = `${sheet}!${addrOf(r, c)}`;
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    if (cache.has(key)) return cache.get(key);
    const sh = sheets[sheet];
    const cell = sh && sh.cells[addrOf(r, c)];
    if (!cell) return null;
    if (cell.f && !cell.spill) {
      if (busy.has(key)) return 0;                     // a circular reference: Excel shows 0
      busy.add(key);
      let v;
      try {
        v = scalarOut(evalNode(parseFormula(cell.f), { sheet, r, c, env: null }));
      } catch (err) {
        v = ERR('#NAME?');
        unknown.add(`${sheet}!${addrOf(r, c)}: ${err.message}`);
      }
      busy.delete(key);
      cache.set(key, v);
      return v;
    }
    return storedValue(cell);
  }
  const storedValue = (cell) => (cell.e ? ERR(cell.e) : cell.v === undefined ? null : cell.v);

  // what a formula leaves in its cell: one value (an array spills; its first value)
  const scalarOut = (v) => {
    if (isRange(v)) return v.r0 === v.r1 && v.c0 === v.c1 ? cellValue(v.sheet, v.r0, v.c0) : rangeTopLeft(v);
    if (isArray(v)) return v.rows[0][0];
    return v === undefined ? null : v;
  };
  const rangeTopLeft = (v) => cellValue(v.sheet, v.r0, v.c0);

  // a single value from anything, as a function argument that wants one
  const one = (v, ctx) => {
    if (isRange(v)) {
      if (v.r0 === v.r1 && v.c0 === v.c1) return cellValue(v.sheet, v.r0, v.c0);
      // implicit intersection with the formula's own row / column
      if (ctx && v.sheet === ctx.sheet && v.c0 === v.c1 && ctx.r >= v.r0 && ctx.r <= v.r1) return cellValue(v.sheet, ctx.r, v.c0);
      if (ctx && v.sheet === ctx.sheet && v.r0 === v.r1 && ctx.c >= v.c0 && ctx.c <= v.c1) return cellValue(v.sheet, v.r0, ctx.c);
      return VALUE();
    }
    if (isArray(v)) return v.rows[0][0];
    return v;
  };
  const matrix = (v) => {
    if (isRange(v)) {
      const rows = [];
      for (let r = v.r0; r <= v.r1; r++) { const row = []; for (let c = v.c0; c <= v.c1; c++) row.push(cellValue(v.sheet, r, c)); rows.push(row); }
      return rows;
    }
    if (isArray(v)) return v.rows;
    return [[v]];
  };
  const flat = (v) => matrix(v).flat();

  // coercions
  const toNum = (v) => {
    if (isErr(v)) return v;
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const t = String(v).trim().replace(/,/g, '');
    if (t !== '' && Number.isFinite(Number(t))) return Number(t);
    if (/%$/.test(t) && Number.isFinite(Number(t.slice(0, -1)))) return Number(t.slice(0, -1)) / 100;
    return VALUE();
  };
  const toStr = (v) => {
    if (isErr(v)) return v;
    if (v == null) return '';
    if (typeof v === 'number') return numText(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  };
  const toBool = (v) => {
    if (isErr(v)) return v;
    if (v == null) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const u = String(v).toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    return VALUE();
  };
  const firstErr = (...xs) => xs.find(isErr);

  // Excel's comparison: blank = 0 / "" / FALSE; numbers < text < logicals; text ignores case
  const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  function cmp(a, b) {
    if (a == null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b == null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (typeof a === 'string') { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
    if (typeof a === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    return pre(a) - pre(b);
  }
  function binop(op, a, b) {
    const e = firstErr(a, b);
    if (e) return e;
    switch (op) {
      case '&': { const x = toStr(a); const y = toStr(b); return firstErr(x, y) || x + y; }
      case '=': return cmp(a, b) === 0;
      case '<>': return cmp(a, b) !== 0;
      case '<': return cmp(a, b) < 0;
      case '>': return cmp(a, b) > 0;
      case '<=': return cmp(a, b) <= 0;
      case '>=': return cmp(a, b) >= 0;
      default: {
        const x = toNum(a);
        const y = toNum(b);
        const ee = firstErr(x, y);
        if (ee) return ee;
        if (op === '+') return x + y;
        if (op === '-') return x - y;
        if (op === '*') return x * y;
        if (op === '/') return y === 0 ? ERR('#DIV/0!') : x / y;
        if (op === '^') return x ** y;
        return VALUE();
      }
    }
  }
  // element by element when either side is a list of values (dynamic arrays)
  function lift(op, a, b, ctx) {
    if (!multi(a) && !multi(b)) return binop(op, one(a, ctx), one(b, ctx));
    const A = matrix(a);
    const B = matrix(b);
    const rows = Math.max(A.length, B.length);
    const cols = Math.max(A[0].length, B[0].length);
    const pick = (M, r, c) => (M.length === 1 ? (M[0].length === 1 ? M[0][0] : M[0][c]) : M[r] ? (M[r].length === 1 ? M[r][0] : M[r][c]) : NA());
    const out = [];
    for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(binop(op, pick(A, r, c), pick(B, r, c))); out.push(row); }
    return arr(out);
  }

  // ---- references ----
  const shiftRef = (n, ctx) => ({
    r: n.absR || !ctx.shift ? n.r : n.r + ctx.shift.dr,
    c: n.absC || !ctx.shift ? n.c : n.c + ctx.shift.dc,
  });
  function refValue(n, ctx) {
    const sheet = n.sheet ? sheetOf(n.sheet) : ctx.sheet;
    if (!sheet) return ERR('#REF!');
    if (n.t === 'ref') { const { r, c } = shiftRef(n, ctx); return { kind: 'range', sheet, r0: r, c0: c, r1: r, c1: c }; }
    const a = shiftRef(n.a, ctx);
    const b = shiftRef(n.b, ctx);
    return { kind: 'range', sheet, r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
  }
  // Table[Col], Table[[#This Row],[Col]], Table[@Col], Table[#Data], Table[[A]:[B]], Table
  function srefValue(n, ctx) {
    let tbl = n.table ? tableOf(n.table) : null;
    if (!n.table) tbl = Object.values(tables).find((t) => t.sheet === ctx.sheet && ctx.r >= t.r0 && ctx.r <= t.r1 && ctx.c >= t.c0 && ctx.c <= t.c1);
    if (!tbl) return ERR('#REF!');
    const unq = (s) => s.replace(/'(.)/g, '$1').trim();
    let spec = n.spec.trim();
    const items = [];
    if (spec.startsWith('@')) { items.push('#This Row'); spec = spec.slice(1).replace(/^\[|\]$/g, ''); if (spec) items.push(`[${spec}]`); } else if (!spec.startsWith('[')) {
      if (spec) items.push(spec.startsWith('#') ? spec : `[${spec}]`);
    } else {
      let depth = 0; let cur = '';
      for (let i = 0; i < spec.length; i++) {
        const ch = spec[i];
        if (ch === "'") { cur += ch + (spec[i + 1] || ''); i++; continue; }
        if (ch === '[') depth++;
        if (ch === ']') depth--;
        if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      if (cur.trim()) items.push(cur.trim());
    }
    const dataTop = tbl.r0 + (tbl.header ? 1 : 0);
    const dataBottom = tbl.r1 - (tbl.totals ? 1 : 0);
    let r0 = dataTop; let r1 = dataBottom; let c0 = tbl.c0; let c1 = tbl.c1;
    for (const raw of items) {
      const it = raw.replace(/^\[(#[^\]]+)\]$/, '$1');
      const low = it.toLowerCase();
      if (low === '#this row') { r0 = ctx.r; r1 = ctx.r; if (ctx.r < dataTop || ctx.r > dataBottom) return VALUE(); continue; }
      if (low === '#data') { continue; }
      if (low === '#all') { r0 = tbl.r0; r1 = tbl.r1; continue; }
      if (low === '#headers') { r0 = tbl.r0; r1 = tbl.r0; continue; }
      if (low === '#totals') { r0 = tbl.r1; r1 = tbl.r1; continue; }
      const cols = it.split(/\]\s*:\s*\[/).map((x) => unq(x.replace(/^\[|\]$/g, '')));
      const idx = cols.map((name) => tbl.cols.findIndex((x) => x.toLowerCase() === name.toLowerCase()));
      if (idx.some((x) => x < 0)) return ERR('#REF!');
      c0 = tbl.c0 + Math.min(...idx);
      c1 = tbl.c0 + Math.max(...idx);
    }
    return { kind: 'range', sheet: tbl.sheet, r0, c0, r1, c1 };
  }
  function nameValue(n, ctx) {
    const key = n.v.toUpperCase().replace(/^_XLPM\./, '');
    for (let e = ctx.env; e; e = e.up) if (e.vars.has(key)) return e.vars.get(key);
    const def = names[n.v.toUpperCase()];
    if (def == null) { unknown.add(`name ${n.v}`); return ERR('#NAME?'); }
    try {
      return evalNode(parseFormula(def), { sheet: ctx.sheet, r: ctx.r, c: ctx.c, env: null });
    } catch {
      return ERR('#NAME?');
    }
  }

  // ---- evaluation ----
  function evalNode(n, ctx) {
    switch (n.t) {
      case 'lit': return n.v;
      case 'missing': return null;
      case 'ref': case 'range': return refValue(n, ctx);
      case 'sref': return srefValue(n, ctx);
      case 'name': return nameValue(n, ctx);
      case 'arr': return arr(n.rows.map((row) => row.map((x) => one(evalNode(x, ctx), ctx))));
      case 'un': {
        const v = evalNode(n.a, ctx);
        if (multi(v)) return arr(matrix(v).map((row) => row.map((x) => (n.op === '-' ? binop('*', -1, x) : toNum(x)))));
        const x = toNum(one(v, ctx));
        return isErr(x) ? x : n.op === '-' ? -x : x;
      }
      case 'pct': { const x = toNum(one(evalNode(n.a, ctx), ctx)); return isErr(x) ? x : x / 100; }
      case 'bin': return lift(n.op, evalNode(n.a, ctx), evalNode(n.b, ctx), ctx);
      case 'fn': {
        const f = FN[n.name];
        if (f) return f(n.args, ctx);
        // a LAMBDA kept in a LET name: LET(w, LAMBDA(x, …), w(5))
        const key = n.name.replace(/^_XLPM\./, '');
        for (let e = ctx.env; e; e = e.up) {
          if (!e.vars.has(key)) continue;
          const fn = e.vars.get(key);
          if (!fn || !fn.lambda) break;
          if (n.args.length > fn.params.length) return VALUE();
          const vars = new Map(fn.params.map((p, i) => [p, i < n.args.length ? ev(n.args[i], ctx) : null]));
          return ev(fn.body, { ...ctx, env: { vars, up: fn.env } });
        }
        unknown.add(`function ${n.name}`);
        return ERR('#NAME?');
      }
      default: return VALUE();
    }
  }
  const ev = (node, ctx) => evalNode(node, ctx);
  const evOne = (node, ctx) => one(evalNode(node, ctx), ctx);
  const given = (node) => node && node.t !== 'missing';

  // ---- functions ----
  const numArgs = (args, ctx, f) => (args.length ? (() => {
    const xs = args.map((a) => toNum(evOne(a, ctx)));
    return firstErr(...xs) || f(...xs);
  })() : VALUE());
  const scalars = (args, ctx, { countText = false } = {}) => {   // SUM & co: numbers in ranges, coerced direct values
    const out = [];
    for (const a of args) {
      if (!given(a)) continue;
      const v = ev(a, ctx);
      if (isRange(v) || isArray(v)) {
        for (const x of flat(v)) { if (isErr(x)) return [x]; if (typeof x === 'number') out.push(x); else if (countText && x != null && x !== '') out.push(x); }
      } else {
        const x = countText ? v : toNum(v);
        if (isErr(x)) return [x];
        out.push(x);
      }
    }
    return out;
  };
  const roundTo = (x, d, mode) => {
    const k = 10 ** d;
    const v = pre(Math.abs(x) * k);
    const r = mode === 'up' ? Math.ceil(v - 1e-12) : mode === 'down' ? Math.floor(v + 1e-12) : Math.round(v + 1e-12);
    return (Math.sign(x) * r) / k;
  };
  // XLOOKUP / MATCH: where `want` sits in a list
  const findIn = (want, list, mode = 0, search = 1) => {
    const order = search < 0 ? [...list.keys()].reverse() : [...list.keys()];
    if (mode === 2 && typeof want === 'string') {
      const re = new RegExp(`^${wildcard(want)}$`, 'i');
      return order.find((i) => re.test(toStr(list[i]))) ?? -1;
    }
    const exact = order.find((i) => list[i] != null && cmp(list[i], want) === 0 && rank(list[i]) === rank(want));
    if (exact !== undefined) return exact;
    if (mode === -1 || mode === 1) {
      let best = -1;
      for (const i of order) {
        const x = list[i];
        if (x == null || rank(x) !== rank(want)) continue;
        const d = cmp(x, want);
        if (mode === -1 && d < 0 && (best < 0 || cmp(x, list[best]) > 0)) best = i;
        if (mode === 1 && d > 0 && (best < 0 || cmp(x, list[best]) < 0)) best = i;
      }
      return best;
    }
    return -1;
  };
  const pickAt = (v, i, vertical) => {
    if (isRange(v)) {
      if (vertical) return v.c0 === v.c1 ? { ...v, r0: v.r0 + i, r1: v.r0 + i } : { ...v, r0: v.r0 + i, r1: v.r0 + i };
      return { ...v, c0: v.c0 + i, c1: v.c0 + i };
    }
    const M = matrix(v);
    if (vertical) return M[i] ? (M[i].length === 1 ? M[i][0] : arr([M[i]])) : NA();
    return M.length === 1 ? (M[0][i] ?? NA()) : arr(M.map((row) => [row[i]]));
  };
  const textOf = (node, ctx) => toStr(evOne(node, ctx));
  const textSplit = (args, ctx, after) => {
    const text = textOf(args[0], ctx);
    const delim = textOf(args[1], ctx);
    const e = firstErr(text, delim);
    if (e) return e;
    let inst = given(args[2]) ? toNum(evOne(args[2], ctx)) : 1;
    const ci = given(args[3]) && toNum(evOne(args[3], ctx)) === 1;
    const matchEnd = given(args[4]) && toNum(evOne(args[4], ctx)) === 1;
    if (isErr(inst)) return inst;
    if (inst === 0) return VALUE();
    const hay = ci ? text.toLowerCase() : text;
    const nee = ci ? delim.toLowerCase() : delim;
    const hits = [];
    if (nee === '') hits.push(inst > 0 ? 0 : text.length);
    else for (let i = hay.indexOf(nee); i >= 0; i = hay.indexOf(nee, i + nee.length)) hits.push(i);
    if (matchEnd) hits.push(text.length);
    const at = inst > 0 ? hits[inst - 1] : hits[hits.length + inst];
    if (at === undefined) return given(args[5]) ? evOne(args[5], ctx) : NA();
    return after ? text.slice(at + (at === text.length ? 0 : nee.length)) : text.slice(0, at);
  };
  const criteria = (crit) => {                          // COUNTIF / SUMIF
    if (typeof crit !== 'string') return (x) => cmp(x, crit) === 0;
    const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(crit);
    const op = m[1] || '=';
    const raw = m[2];
    const n = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
    const val = n != null ? n : raw;
    if ((op === '=' || op === '<>') && n == null && /[*?]/.test(raw)) {
      const re = new RegExp(`^${wildcard(raw)}$`, 'i');
      return (x) => (op === '=') === re.test(toStr(x));
    }
    return (x) => { const r = binop(op, x == null && val === '' ? '' : x, val); return r === true; };
  };

  const FN = {
    // logic
    IF: (a, ctx) => { const c = toBool(evOne(a[0], ctx)); if (isErr(c)) return c; return c ? (given(a[1]) ? ev(a[1], ctx) : 0) : (a.length > 2 ? (given(a[2]) ? ev(a[2], ctx) : 0) : false); },
    IFS: (a, ctx) => { for (let i = 0; i + 1 < a.length; i += 2) { const c = toBool(evOne(a[i], ctx)); if (isErr(c)) return c; if (c) return ev(a[i + 1], ctx); } return NA(); },
    IFERROR: (a, ctx) => { const v = ev(a[0], ctx); const x = multi(v) ? v : one(v, ctx); return isErr(x) ? (given(a[1]) ? ev(a[1], ctx) : '') : v; },
    IFNA: (a, ctx) => { const v = ev(a[0], ctx); const x = one(v, ctx); return isErr(x) && x.code === '#N/A' ? ev(a[1], ctx) : v; },
    AND: (a, ctx) => { const xs = a.flatMap((n) => flat(ev(n, ctx))).filter((x) => x != null && x !== ''); const e = firstErr(...xs); if (e) return e; return xs.map(toBool).every((x) => x === true); },
    OR: (a, ctx) => { const xs = a.flatMap((n) => flat(ev(n, ctx))).filter((x) => x != null && x !== ''); const e = firstErr(...xs); if (e) return e; return xs.map(toBool).some((x) => x === true); },
    XOR: (a, ctx) => a.flatMap((n) => flat(ev(n, ctx))).filter((x) => x != null && x !== '').map(toBool).filter((x) => x === true).length % 2 === 1,
    NOT: (a, ctx) => { const x = toBool(evOne(a[0], ctx)); return isErr(x) ? x : !x; },
    TRUE: () => true,
    FALSE: () => false,
    SWITCH: (a, ctx) => { const v = evOne(a[0], ctx); for (let i = 1; i + 1 < a.length; i += 2) if (cmp(evOne(a[i], ctx), v) === 0) return ev(a[i + 1], ctx); return a.length % 2 === 0 ? ev(a[a.length - 1], ctx) : NA(); },
    CHOOSE: (a, ctx) => { const i = toNum(evOne(a[0], ctx)); if (isErr(i)) return i; return a[Math.trunc(i)] ? ev(a[Math.trunc(i)], ctx) : VALUE(); },
    // LAMBDA(x, y, body): a function value, called through a LET name
    LAMBDA: (a, ctx) => (a.length ? { lambda: true, params: a.slice(0, -1).map((x) => String(x.v || '').toUpperCase().replace(/^_XLPM\./, '')), body: a[a.length - 1], env: ctx.env } : VALUE()),
    LET: (a, ctx) => {
      const env = { vars: new Map(), up: ctx.env };
      const inner = { ...ctx, env };
      for (let i = 0; i + 1 < a.length; i += 2) env.vars.set(String(a[i].v || '').toUpperCase().replace(/^_XLPM\./, ''), ev(a[i + 1], inner));
      return ev(a[a.length - 1], inner);
    },
    // information
    ISNUMBER: (a, ctx) => typeof evOne(a[0], ctx) === 'number',
    ISTEXT: (a, ctx) => typeof evOne(a[0], ctx) === 'string',
    ISNONTEXT: (a, ctx) => typeof evOne(a[0], ctx) !== 'string',
    ISLOGICAL: (a, ctx) => typeof evOne(a[0], ctx) === 'boolean',
    ISBLANK: (a, ctx) => evOne(a[0], ctx) == null,
    ISERROR: (a, ctx) => isErr(evOne(a[0], ctx)),
    ISERR: (a, ctx) => { const x = evOne(a[0], ctx); return isErr(x) && x.code !== '#N/A'; },
    ISNA: (a, ctx) => { const x = evOne(a[0], ctx); return isErr(x) && x.code === '#N/A'; },
    ISEVEN: (a, ctx) => numArgs(a, ctx, (x) => Math.trunc(x) % 2 === 0),
    ISODD: (a, ctx) => numArgs(a, ctx, (x) => Math.abs(Math.trunc(x)) % 2 === 1),
    N: (a, ctx) => { const x = evOne(a[0], ctx); return isErr(x) ? x : typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : 0; },
    T: (a, ctx) => { const x = evOne(a[0], ctx); return isErr(x) ? x : typeof x === 'string' ? x : ''; },
    NA: () => NA(),
    // maths
    SUM: (a, ctx) => { const xs = scalars(a, ctx); return firstErr(...xs) || xs.reduce((s, x) => s + x, 0); },
    PRODUCT: (a, ctx) => { const xs = scalars(a, ctx); return firstErr(...xs) || xs.reduce((s, x) => s * x, 1); },
    MIN: (a, ctx) => { const xs = scalars(a, ctx); return firstErr(...xs) || (xs.length ? Math.min(...xs) : 0); },
    MAX: (a, ctx) => { const xs = scalars(a, ctx); return firstErr(...xs) || (xs.length ? Math.max(...xs) : 0); },
    AVERAGE: (a, ctx) => { const xs = scalars(a, ctx); return firstErr(...xs) || (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : ERR('#DIV/0!')); },
    COUNT: (a, ctx) => a.flatMap((n) => flat(ev(n, ctx))).filter((x) => typeof x === 'number').length,
    COUNTA: (a, ctx) => a.flatMap((n) => flat(ev(n, ctx))).filter((x) => x != null && x !== '').length,
    COUNTBLANK: (a, ctx) => flat(ev(a[0], ctx)).filter((x) => x == null || x === '').length,
    COUNTIF: (a, ctx) => { const t = criteria(evOne(a[1], ctx)); return flat(ev(a[0], ctx)).filter(t).length; },
    SUMIF: (a, ctx) => {
      const t = criteria(evOne(a[1], ctx));
      const test = flat(ev(a[0], ctx));
      const sum = given(a[2]) ? flat(ev(a[2], ctx)) : test;
      return test.reduce((s, x, i) => (t(x) && typeof sum[i] === 'number' ? s + sum[i] : s), 0);
    },
    SUMIFS: (a, ctx) => {
      const sum = flat(ev(a[0], ctx));
      const tests = [];
      for (let i = 1; i + 1 < a.length; i += 2) tests.push([flat(ev(a[i], ctx)), criteria(evOne(a[i + 1], ctx))]);
      return sum.reduce((s, x, i) => (tests.every(([r, t]) => t(r[i])) && typeof x === 'number' ? s + x : s), 0);
    },
    COUNTIFS: (a, ctx) => {
      const tests = [];
      for (let i = 0; i + 1 < a.length; i += 2) tests.push([flat(ev(a[i], ctx)), criteria(evOne(a[i + 1], ctx))]);
      return tests.length ? tests[0][0].filter((_, i) => tests.every(([r, t]) => t(r[i]))).length : 0;
    },
    ROUND: (a, ctx) => numArgs(a, ctx, (x, d = 0) => roundTo(x, Math.trunc(d))),
    ROUNDUP: (a, ctx) => numArgs(a, ctx, (x, d = 0) => roundTo(x, Math.trunc(d), 'up')),
    ROUNDDOWN: (a, ctx) => numArgs(a, ctx, (x, d = 0) => roundTo(x, Math.trunc(d), 'down')),
    TRUNC: (a, ctx) => numArgs(a, ctx, (x, d = 0) => roundTo(x, Math.trunc(d), 'down')),
    INT: (a, ctx) => numArgs(a, ctx, (x) => Math.floor(pre(x))),
    MOD: (a, ctx) => numArgs(a, ctx, (x, y) => (y === 0 ? ERR('#DIV/0!') : pre(x - y * Math.floor(pre(x / y))))),
    ABS: (a, ctx) => numArgs(a, ctx, Math.abs),
    SIGN: (a, ctx) => numArgs(a, ctx, Math.sign),
    SQRT: (a, ctx) => numArgs(a, ctx, (x) => (x < 0 ? ERR('#NUM!') : Math.sqrt(x))),
    POWER: (a, ctx) => numArgs(a, ctx, (x, y) => x ** y),
    CEILING: (a, ctx) => numArgs(a, ctx, (x, s = 1) => (s === 0 ? 0 : Math.ceil(pre(x / s)) * s)),
    FLOOR: (a, ctx) => numArgs(a, ctx, (x, s = 1) => (s === 0 ? ERR('#DIV/0!') : Math.floor(pre(x / s)) * s)),
    MROUND: (a, ctx) => numArgs(a, ctx, (x, m) => (m === 0 ? 0 : Math.round(pre(x / m)) * m)),
    PI: () => Math.PI,
    // text
    TRIM: (a, ctx) => { const t = textOf(a[0], ctx); return isErr(t) ? t : t.replace(/ +/g, ' ').trim(); },
    CLEAN: (a, ctx) => { const t = textOf(a[0], ctx); return isErr(t) ? t : t.replace(/[\x00-\x1f]/g, ''); },
    UPPER: (a, ctx) => { const t = textOf(a[0], ctx); return isErr(t) ? t : t.toUpperCase(); },
    LOWER: (a, ctx) => { const t = textOf(a[0], ctx); return isErr(t) ? t : t.toLowerCase(); },
    PROPER: (a, ctx) => { const t = textOf(a[0], ctx); return isErr(t) ? t : t.toLowerCase().replace(/(^|[^A-Za-z'])([a-z])/g, (m, p, c) => p + c.toUpperCase()); },
    LEN: (a, ctx) => { const t = textOf(a[0], ctx); return isErr(t) ? t : t.length; },
    LEFT: (a, ctx) => { const t = textOf(a[0], ctx); const n = given(a[1]) ? toNum(evOne(a[1], ctx)) : 1; return firstErr(t, n) || t.slice(0, Math.max(0, n)); },
    RIGHT: (a, ctx) => { const t = textOf(a[0], ctx); const n = given(a[1]) ? toNum(evOne(a[1], ctx)) : 1; return firstErr(t, n) || (n <= 0 ? '' : t.slice(-n)); },
    MID: (a, ctx) => { const t = textOf(a[0], ctx); const s = toNum(evOne(a[1], ctx)); const n = toNum(evOne(a[2], ctx)); return firstErr(t, s, n) || (s < 1 ? VALUE() : t.substr(s - 1, Math.max(0, n))); },
    REPT: (a, ctx) => { const t = textOf(a[0], ctx); const n = toNum(evOne(a[1], ctx)); return firstErr(t, n) || t.repeat(Math.max(0, Math.trunc(n))); },
    CONCAT: (a, ctx) => { const xs = a.flatMap((n) => flat(ev(n, ctx))).map(toStr); return firstErr(...xs) || xs.join(''); },
    CONCATENATE: (a, ctx) => { const xs = a.map((n) => textOf(n, ctx)); return firstErr(...xs) || xs.join(''); },
    TEXTJOIN: (a, ctx) => {
      const d = textOf(a[0], ctx);
      const skip = toBool(evOne(a[1], ctx));
      const xs = a.slice(2).flatMap((n) => flat(ev(n, ctx))).filter((x) => !(skip && (x == null || x === ''))).map(toStr);
      return firstErr(d, skip, ...xs) || xs.join(d);
    },
    SUBSTITUTE: (a, ctx) => {
      const t = textOf(a[0], ctx); const o = textOf(a[1], ctx); const n = textOf(a[2], ctx);
      const e = firstErr(t, o, n);
      if (e) return e;
      if (o === '') return t;
      if (given(a[3])) {
        const k = toNum(evOne(a[3], ctx));
        let i = -1;
        for (let j = 0; j < k; j++) { i = t.indexOf(o, i + 1); if (i < 0) return t; }
        return t.slice(0, i) + n + t.slice(i + o.length);
      }
      return t.split(o).join(n);
    },
    REPLACE: (a, ctx) => { const t = textOf(a[0], ctx); const s = toNum(evOne(a[1], ctx)); const n = toNum(evOne(a[2], ctx)); const r = textOf(a[3], ctx); return firstErr(t, s, n, r) || t.slice(0, s - 1) + r + t.slice(s - 1 + n); },
    SEARCH: (a, ctx) => {
      const f = textOf(a[0], ctx); const t = textOf(a[1], ctx);
      const s = given(a[2]) ? toNum(evOne(a[2], ctx)) : 1;
      const e = firstErr(f, t, s);
      if (e) return e;
      const m = new RegExp(wildcard(f), 'i').exec(t.slice(s - 1));
      return m ? m.index + s : VALUE();
    },
    FIND: (a, ctx) => {
      const f = textOf(a[0], ctx); const t = textOf(a[1], ctx);
      const s = given(a[2]) ? toNum(evOne(a[2], ctx)) : 1;
      const e = firstErr(f, t, s);
      if (e) return e;
      const i = t.indexOf(f, s - 1);
      return i < 0 ? VALUE() : i + 1;
    },
    EXACT: (a, ctx) => { const x = textOf(a[0], ctx); const y = textOf(a[1], ctx); return firstErr(x, y) || x === y; },
    VALUE: (a, ctx) => { const v = evOne(a[0], ctx); return typeof v === 'number' ? v : toNum(v); },
    CHAR: (a, ctx) => numArgs(a, ctx, (n) => String.fromCharCode(n)),
    CODE: (a, ctx) => { const t = textOf(a[0], ctx); return isErr(t) ? t : t ? t.charCodeAt(0) : VALUE(); },
    TEXT: (a, ctx) => {
      const v = evOne(a[0], ctx);
      const f = textOf(a[1], ctx);
      const e = firstErr(v, f);
      if (e) return e;
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
      if (n == null) return toStr(v);
      try { return format(f, n); } catch { return VALUE(); }
    },
    FIXED: (a, ctx) => numArgs(a, ctx, (x, d = 2, noCommas = 0) => {
      const s = roundTo(x, d).toFixed(Math.max(0, d));
      return noCommas ? s : s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }),
    TEXTBEFORE: (a, ctx) => textSplit(a, ctx, false),
    TEXTAFTER: (a, ctx) => textSplit(a, ctx, true),
    // dates
    TODAY: () => Math.floor(today),
    NOW: () => today,
    DATE: (a, ctx) => numArgs(a, ctx, (y, m, d) => serialOf(y < 1900 ? y + 1900 : y, m, d)),
    DAY: (a, ctx) => numArgs(a, ctx, (n) => ymd(n)[2]),
    MONTH: (a, ctx) => numArgs(a, ctx, (n) => ymd(n)[1]),
    YEAR: (a, ctx) => numArgs(a, ctx, (n) => ymd(n)[0]),
    WEEKDAY: (a, ctx) => numArgs(a, ctx, (n, t = 1) => { const w = new Date(EPOCH + Math.floor(n) * DAY).getUTCDay(); return t === 2 ? ((w + 6) % 7) + 1 : t === 3 ? (w + 6) % 7 : w + 1; }),
    EOMONTH: (a, ctx) => numArgs(a, ctx, (n, k) => { const [y, m] = ymd(n); return serialOf(y, m + Math.trunc(k) + 1, 0); }),
    EDATE: (a, ctx) => numArgs(a, ctx, (n, k) => { const [y, m, d] = ymd(n); const last = new Date(Date.UTC(y, m - 1 + Math.trunc(k) + 1, 0)).getUTCDate(); return serialOf(y, m + Math.trunc(k), Math.min(d, last)); }),
    DAYS: (a, ctx) => numArgs(a, ctx, (e, s) => Math.floor(e) - Math.floor(s)),
    DATEVALUE: (a, ctx) => { const t = textOf(a[0], ctx); if (isErr(t)) return t; const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t.trim()); return m ? serialOf(+m[3], +m[2], +m[1]) : VALUE(); },
    // lookup
    XLOOKUP: (a, ctx) => {
      const want = evOne(a[0], ctx);
      if (isErr(want)) return want;
      const look = ev(a[1], ctx);
      const ret = ev(a[2], ctx);
      const mode = given(a[4]) ? toNum(evOne(a[4], ctx)) : 0;
      const search = given(a[5]) ? toNum(evOne(a[5], ctx)) : 1;
      const M = matrix(look);
      const vertical = M.length > 1 || M[0].length === 1;
      const list = vertical ? M.map((row) => row[0]) : M[0];
      const i = findIn(want, list, mode, search);
      if (i < 0) return given(a[3]) ? ev(a[3], ctx) : NA();          // if_not_found ("" counts as given)
      return pickAt(ret, i, vertical);
    },
    XMATCH: (a, ctx) => {
      const want = evOne(a[0], ctx);
      const list = flat(ev(a[1], ctx));
      const i = findIn(want, list, given(a[2]) ? toNum(evOne(a[2], ctx)) : 0, given(a[3]) ? toNum(evOne(a[3], ctx)) : 1);
      return i < 0 ? NA() : i + 1;
    },
    MATCH: (a, ctx) => {
      const want = evOne(a[0], ctx);
      const list = flat(ev(a[1], ctx));
      const t = given(a[2]) ? toNum(evOne(a[2], ctx)) : 1;
      if (t === 0) { const i = findIn(want, list, typeof want === 'string' && /[*?]/.test(want) ? 2 : 0); return i < 0 ? NA() : i + 1; }
      let best = -1;
      list.forEach((x, i) => { if (x != null && rank(x) === rank(want) && (t > 0 ? cmp(x, want) <= 0 : cmp(x, want) >= 0)) best = i; });
      return best < 0 ? NA() : best + 1;
    },
    VLOOKUP: (a, ctx) => {
      const want = evOne(a[0], ctx);
      const M = matrix(ev(a[1], ctx));
      const col = toNum(evOne(a[2], ctx));
      const approx = given(a[3]) ? toBool(evOne(a[3], ctx)) : true;
      const list = M.map((row) => row[0]);
      let i = findIn(want, list, 0);
      if (i < 0 && approx) { list.forEach((x, j) => { if (x != null && rank(x) === rank(want) && cmp(x, want) <= 0) i = j; }); }
      if (i < 0) return NA();
      return M[i][col - 1] === undefined ? ERR('#REF!') : M[i][col - 1];
    },
    HLOOKUP: (a, ctx) => {
      const want = evOne(a[0], ctx);
      const M = matrix(ev(a[1], ctx));
      const row = toNum(evOne(a[2], ctx));
      const i = findIn(want, M[0], 0);
      return i < 0 ? NA() : (M[row - 1] ? M[row - 1][i] : ERR('#REF!'));
    },
    INDEX: (a, ctx) => {
      const v = ev(a[0], ctx);
      let r = given(a[1]) ? toNum(evOne(a[1], ctx)) : 0;
      let c = given(a[2]) ? toNum(evOne(a[2], ctx)) : 0;
      const e = firstErr(r, c);
      if (e) return e;
      const M = matrix(v);
      if (!given(a[2]) && M.length === 1) { c = r; r = 1; }          // one row: the number picks the column
      if (!given(a[2]) && M[0].length === 1) c = 1;
      if (isRange(v)) {
        if (r === 0 && c === 0) return v;
        if (r === 0) return { ...v, c0: v.c0 + c - 1, c1: v.c0 + c - 1 };
        if (c === 0) return { ...v, r0: v.r0 + r - 1, r1: v.r0 + r - 1 };
        if (r - 1 > v.r1 - v.r0 || c - 1 > v.c1 - v.c0) return ERR('#REF!');
        return cellValue(v.sheet, v.r0 + r - 1, v.c0 + c - 1);
      }
      const row = M[(r || 1) - 1];
      if (!row || row[(c || 1) - 1] === undefined) return ERR('#REF!');
      return row[(c || 1) - 1];
    },
    FILTER: (a, ctx) => {
      const M = matrix(ev(a[0], ctx));
      const keep = flat(ev(a[1], ctx)).map((x) => toBool(x) === true);
      const rows = M.length > 1 ? M.filter((_, i) => keep[i]) : [M[0].filter((_, i) => keep[i])];
      if (!rows.length || !rows[0].length) return given(a[2]) ? ev(a[2], ctx) : ERR('#CALC!');
      return arr(rows);
    },
    UNIQUE: (a, ctx) => { const seen = new Set(); const rows = matrix(ev(a[0], ctx)).filter((row) => { const k = row.map(toStr).join('\u0001').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); return arr(rows); },
    ROWS: (a, ctx) => matrix(ev(a[0], ctx)).length,
    COLUMNS: (a, ctx) => matrix(ev(a[0], ctx))[0].length,
    ROW: (a, ctx) => { if (!given(a[0])) return ctx.r + 1; const v = ev(a[0], ctx); return isRange(v) ? v.r0 + 1 : VALUE(); },
    COLUMN: (a, ctx) => { if (!given(a[0])) return ctx.c + 1; const v = ev(a[0], ctx); return isRange(v) ? v.c0 + 1 : VALUE(); },
  };

  const value = (sheet, a) => {
    const p = parseAddr(a);
    const s = sheetOf(sheet);
    return p && s ? cellValue(s, p.r, p.c) : ERR('#REF!');
  };
  // what the cell shows: its value in its number format
  const text = (sheet, a) => display(value(sheet, a), (sheets[sheetOf(sheet)]?.cells[String(a).toUpperCase()] || {}).z, format);
  // a formula worked out at a cell (CF rules, data validation lists): shift
  // moves its relative references, as Excel does for each cell of a range
  const formula = (src, sheet, a, shift = null) => {
    const p = parseAddr(a) || { r: 0, c: 0 };
    try {
      return evalNode(parseFormula(src), { sheet: sheetOf(sheet) || sheet, r: p.r, c: p.c, env: null, shift });
    } catch (err) {
      unknown.add(`${sheet}!${a}: ${err.message}`);
      return ERR('#NAME?');
    }
  };
  const list = (v) => flat(v);
  return { value, text, formula, list, unknown, one: (v) => one(v, null) };
}

// what a value looks like in a cell with number format `z`
export function display(v, z, format = basicFormat) {
  if (v == null) return '';
  if (isErr(v)) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    try { return format(z && z !== 'General' ? z : 'General', v); } catch {
      // "##,##0.00": Excel takes any comma between digit signs as the thousands separator
      const z2 = String(z || '').replace(/#+,#+0/g, '#,##0');
      if (z2 !== z) { try { return format(z2, v); } catch { /* fall through */ } }
      return numText(v);
    }
  }
  if (z === '@' || !z) return String(v);
  return String(v);
}

// a stand-in for SheetJS's SSF.format, for tests: General, 0, 0.00, #,##0(.00), 0%, 0.00%, dd/mm/yyyy
export function basicFormat(fmt, n) {
  const f = String(fmt || 'General');
  if (f === 'General') return numText(Number(n.toPrecision(10)));
  if (/^d{1,2}\/m{1,2}\/y{2,4}$/i.test(f)) { const d = serialToIso(n); return `${d.slice(8, 10)}/${d.slice(5, 7)}/${f.endsWith('yyyy') ? d.slice(0, 4) : d.slice(2, 4)}`; }
  if (/^0+$/.test(f)) return String(Math.round(n)).padStart(f.length, '0');                     // "000": 7 -> 007
  // other dates: d dd mmm mmmm yy yyyy with separators ("mmmm yyyy", "dd\-mmm\-yyyy")
  const plain = f.replace(/\\(.)/g, '$1');
  if (/^(d{1,2}|m{1,4}|y{2}|y{4}|[\s\-/.,])+$/i.test(plain) && /[dmy]/i.test(plain)) {
    const [y, mo, d] = serialToIso(n).split('-');
    const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(mo) - 1];
    return plain.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/gi, (t) => ({ yyyy: y, yy: y.slice(2), mmmm: MN, mmm: MN.slice(0, 3), mm: mo, m: String(Number(mo)), dd: d, d: String(Number(d)) })[t.toLowerCase()]);
  }
  const pct = f.endsWith('%');
  const body = pct ? f.slice(0, -1) : f;
  const m = /^(#,##)?0(\.(0+))?$/.exec(body);
  if (!m) return numText(n);
  const dec = m[3] ? m[3].length : 0;
  const v = pct ? n * 100 : n;
  let s = (Math.round(Math.abs(v) * 10 ** dec + 1e-9) / 10 ** dec).toFixed(dec);
  if (m[1]) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 && Number(s.replace(/,/g, '')) !== 0 ? '-' : ''}${s}${pct ? '%' : ''}`;
}
