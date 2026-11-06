// Reads what the app needs of the Tanker Billing workbook into one model,
// at import, so the Quotes screens follow the workbook as it is:
//   - every cell (value, formula, number format) of the Quotation Maker and
//     Proforma Invoice sheets and of every sheet their formulas reach;
//   - the tables (Customers, RateCard, TierTerms …) and the names (HSD_RSP …);
//   - each document sheet's print area as Excel prints it: column widths, row
//     heights, merged cells, fonts, fills, borders, alignment, conditional
//     formats, drop-down lists, page margins and where the pictures sit;
//   - the macros' source (the PI Log is filled as Module1 says).
// Pure: buildModel(wb, files) takes a SheetJS workbook (read with
// cellFormula + cellNF) and the file's parts as text {path: xml}.

import { colNum, parseRange } from './formula.js';

export const DOC_SHEETS = ['Quotation Maker', 'Proforma Invoice'];
export const PT_PER_UNIT = 6;            // Mac Excel: a width unit of Aptos Narrow 12 is 8 px = 6 pt

// ---- tiny XML helpers -------------------------------------------------------
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
export function attrs(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = unxml(m[2]);
  return out;
}
// every <name ...>…</name> or <name .../> (no nesting of the same name)
export function tags(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${name}>)`, 'g');
  for (const m of String(xml || '').matchAll(re)) out.push({ a: attrs(m[1] || ''), inner: m[3] || '' });
  return out;
}
const tag = (xml, name) => tags(xml, name)[0] || null;

const relTarget = (rels, id) => {
  const r = tags(rels, 'Relationship').find((x) => x.a.Id === id);
  return r ? r.a.Target : null;
};
export function resolvePath(base, rel) {
  if (!rel) return null;
  if (rel.startsWith('/')) return rel.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of rel.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); }
  return parts.join('/');
}
const relsOf = (path) => path.replace(/([^/]+)$/, '_rels/$1.rels');

// ---- colours ----------------------------------------------------------------
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00',
  '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366',
  'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600',
  '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333', '000000', 'FFFFFF'];
function themeColors(xml) {
  const scheme = (tag(xml, 'a:clrScheme') || {}).inner || '';
  const pick = (n) => {
    const t = tag(scheme, `a:${n}`);
    if (!t) return null;
    const rgb = /srgbClr val="([0-9A-Fa-f]{6})"/.exec(t.inner) || /lastClr="([0-9A-Fa-f]{6})"/.exec(t.inner);
    return rgb ? rgb[1].toUpperCase() : null;
  };
  // Excel's theme numbers: 0 lt1, 1 dk1, 2 lt2, 3 dk2, 4… accents
  return [pick('lt1') || 'FFFFFF', pick('dk1') || '000000', pick('lt2') || 'E7E6E6', pick('dk2') || '44546A',
    ...['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((n) => pick(n) || '000000')];
}
function tint(hex, t) {
  if (!t) return hex;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  let h = 0; let s = 0; let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const f = (p, q, x) => { if (x < 0) x += 1; if (x > 1) x -= 1; if (x < 1 / 6) return p + (q - p) * 6 * x; if (x < 1 / 2) return q; if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6; return p; };
  if (s === 0) { r = g = b = l; } else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function colorOf(a, theme) {
  if (!a) return null;
  let hex = null;
  if (a.rgb) hex = a.rgb.slice(-6).toUpperCase();
  else if (a.theme != null) hex = theme[Number(a.theme)] || null;
  else if (a.indexed != null) hex = INDEXED[Number(a.indexed)] || null;
  if (!hex) return null;
  return `#${tint(hex, Number(a.tint || 0))}`;
}

// ---- styles.xml -> the renderer's style objects --------------------------------
const BORDER = { thin: 1, hair: 1, dotted: 1, dashed: 1, dashDot: 1, dashDotDot: 1, medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, slantDashDot: 2, thick: 3, double: 3 };
export function readStyles(xml, themeXml) {
  const theme = themeColors(themeXml || '');
  const on = (inner, n) => { const t = tag(inner, n); return t && t.a.val !== '0' && t.a.val !== 'false'; };
  const fontOf = (inner) => {
    const c = tag(inner, 'color');
    return {
      f: (tag(inner, 'name') || { a: {} }).a.val || 'Aptos Narrow',
      s: Number((tag(inner, 'sz') || { a: { val: 11 } }).a.val),
      b: on(inner, 'b'), i: on(inner, 'i'), u: on(inner, 'u'),
      c: c ? colorOf(c.a, theme) : null,
    };
  };
  const fonts = tags((tag(xml, 'fonts') || {}).inner, 'font').map((t) => fontOf(t.inner));
  const fills = tags((tag(xml, 'fills') || {}).inner, 'fill').map((t) => {
    const p = tag(t.inner, 'patternFill');
    if (!p || p.a.patternType !== 'solid') return null;
    const fg = tag(p.inner, 'fgColor');
    return fg ? colorOf(fg.a, theme) : null;
  });
  const borders = tags((tag(xml, 'borders') || {}).inner, 'border').map((t) => ['left', 'right', 'top', 'bottom'].map((side) => {
    const b = tag(t.inner, side);
    return b && b.a.style ? (BORDER[b.a.style] || 1) : 0;
  }));
  // number formats: the file's own, and Excel's built-in ones (dates as in India)
  const numFmts = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 14: 'dd/mm/yyyy',
    15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm',
    37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
  };
  for (const t of tags((tag(xml, 'numFmts') || {}).inner, 'numFmt')) numFmts[Number(t.a.numFmtId)] = t.a.formatCode;
  const xf = tags((tag(xml, 'cellXfs') || {}).inner, 'xf').map((t) => {
    const font = fonts[Number(t.a.fontId || 0)] || fonts[0];
    const al = tag(t.inner, 'alignment');
    const st = { f: font.f, s: font.s, c: font.c || '#000000' };
    if (font.b) st.b = 1;
    if (font.i) st.i = 1;
    const bg = fills[Number(t.a.fillId || 0)];
    if (bg) st.bg = bg;
    if (al && al.a.horizontal && al.a.horizontal !== 'general') st.h = al.a.horizontal;
    if (al && al.a.vertical) st.v = al.a.vertical;
    if (al && (al.a.wrapText === '1' || al.a.wrapText === 'true')) st.w = 1;
    const bd = borders[Number(t.a.borderId || 0)];
    if (bd && bd.some(Boolean)) st.bd = bd;
    const z = numFmts[Number(t.a.numFmtId || 0)];
    if (z && z !== 'General') st.z = z;
    return st;
  });
  // conditional-format styles: font bold / italic / colour, fill
  const dxf = tags((tag(xml, 'dxfs') || {}).inner, 'dxf').map((t) => {
    const out = {};
    const f = tag(t.inner, 'font');
    if (f) {
      const b = tag(f.inner, 'b'); if (b) out.b = b.a.val === '0' ? 0 : 1;
      const i = tag(f.inner, 'i'); if (i) out.i = i.a.val === '0' ? 0 : 1;
      const c = tag(f.inner, 'color'); if (c) out.c = colorOf(c.a, theme);
    }
    const p = tag(t.inner, 'patternFill');
    if (p && p.a.patternType !== 'none') {
      const c = tag(p.inner, 'bgColor') || tag(p.inner, 'fgColor');
      if (c) out.bg = colorOf(c.a, theme);
    }
    return out;
  });
  return { xf, dxf };
}

// ---- the parts of one sheet ----------------------------------------------------
function sheetParts(xml) {
  const fmt = attrs((/<sheetFormatPr\b[^>]*>/.exec(xml) || [''])[0]);
  const defaultWidth = Number(fmt.defaultColWidth) || (Number(fmt.baseColWidth || 8) + 0.83);
  const defaultHeight = Number(fmt.defaultRowHeight) || 15;
  const cols = tags((tag(xml, 'cols') || {}).inner, 'col').map((t) => ({
    min: Number(t.a.min) - 1, max: Number(t.a.max) - 1, width: t.a.width != null ? Number(t.a.width) : null, hidden: t.a.hidden === '1',
  }));
  const rows = {};
  const styleOf = {};
  const formulaOf = {};
  for (const m of xml.matchAll(/<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g)) {
    const a = attrs(m[1]);
    const r = Number(a.r) - 1;
    if (a.ht) rows[r] = { ht: Number(a.ht), hidden: a.hidden === '1' };
    else if (a.hidden === '1') rows[r] = { hidden: true };
    for (const c of (m[3] || '').matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(c[1]);
      if (ca.s && ca.s !== '0') styleOf[ca.r] = Number(ca.s);
      else if (ca.s === '0') styleOf[ca.r] = 0;
      const f = c[3] && /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(c[3]);
      if (f && f[1]) formulaOf[ca.r] = unxml(f[1]);               // a formula written out in full
    }
  }
  const merges = tags(xml, 'mergeCell').map((t) => t.a.ref);
  const dv = tags((tag(xml, 'dataValidations') || {}).inner, 'dataValidation').map((t) => ({
    sqref: t.a.sqref, type: t.a.type || '', formula: unxml((tag(t.inner, 'formula1') || { inner: '' }).inner),
  }));
  const cf = [];
  for (const block of tags(xml, 'conditionalFormatting')) {
    for (const rule of tags(block.inner, 'cfRule')) {
      cf.push({
        sqref: block.a.sqref, type: rule.a.type, operator: rule.a.operator || '', dxf: rule.a.dxfId != null ? Number(rule.a.dxfId) : null,
        priority: Number(rule.a.priority || 0), stop: rule.a.stopIfTrue === '1',
        formulas: tags(rule.inner, 'formula').map((f) => unxml(f.inner)),
      });
    }
  }
  const pm = attrs((/<pageMargins\b[^>]*>/.exec(xml) || [''])[0]);
  const po = attrs((/<printOptions\b[^>]*>/.exec(xml) || [''])[0]);
  const drawing = (/<drawing\b[^>]*r:id="([^"]+)"/.exec(xml) || [])[1] || null;
  const tableIds = [...xml.matchAll(/<tablePart\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  return {
    defaultWidth, defaultHeight, cols, rows, styleOf, formulaOf, merges, dv, cf, drawing, tableIds,
    margins: {
      left: Number(pm.left ?? 0.7) * 72, right: Number(pm.right ?? 0.7) * 72, top: Number(pm.top ?? 0.75) * 72, bottom: Number(pm.bottom ?? 0.75) * 72,
    },
    center: po.horizontalCentered === '1' || po.horizontalCentered === 'true',
  };
}

function pictures(drawingXml, drawingPath, files) {
  const rels = files[relsOf(drawingPath)] || '';
  const out = [];
  const nums = (inner, t) => {
    const x = tag(inner, `xdr:${t}`);
    if (!x) return null;
    const v = (n) => Number((tag(x.inner, `xdr:${n}`) || { inner: '0' }).inner);
    return [v('col'), v('colOff'), v('row'), v('rowOff')];
  };
  for (const m of String(drawingXml).matchAll(/<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g)) {
    const inner = m[2];
    if (!/<xdr:pic>/.test(inner)) continue;
    const embed = (/<a:blip\b[^>]*r:embed="([^"]+)"/.exec(inner) || [])[1];
    const from = nums(inner, 'from');
    if (!from || !embed) continue;
    const to = nums(inner, 'to');
    const ext = attrs((/<xdr:ext\b[^>]*>/.exec(inner) || /<a:ext\b[^>]*>/.exec(inner) || [''])[0]);
    out.push({
      media: resolvePath(drawingPath, relTarget(rels, embed)), from, to,
      ext: ext.cx ? [Number(ext.cx), Number(ext.cy)] : null,
    });
  }
  return out;
}

// ---- the model ----------------------------------------------------------------
// wb: SheetJS workbook (cellFormula, cellNF); files: {path: text} of the xml parts
export function buildModel(wb, files, { docSheets = DOC_SHEETS, vba = null } = {}) {
  const wbXml = files['xl/workbook.xml'] || '';
  const wbRels = files['xl/_rels/workbook.xml.rels'] || '';
  const sheetPath = {};
  for (const s of tags(wbXml, 'sheet')) sheetPath[s.a.name] = resolvePath('xl/workbook.xml', relTarget(wbRels, s.a['r:id']));
  const styles = readStyles(files['xl/styles.xml'] || '', files['xl/theme/theme1.xml'] || '');

  // names (workbook-wide) and print areas (one per sheet)
  const names = {};
  const printArea = {};
  const sheetNames = wb.SheetNames || Object.keys(wb.Sheets);
  for (const n of (wb.Workbook && wb.Workbook.Names) || []) {
    if (/^_xlpm\./i.test(n.Name)) continue;
    if (n.Name === '_xlnm.Print_Area' && n.Sheet != null) { printArea[sheetNames[n.Sheet]] = n.Ref; continue; }
    if (n.Sheet == null && !/^_xlnm\./.test(n.Name)) names[n.Name] = String(n.Ref || '');
  }

  // tables, from each sheet's table parts
  const tables = {};
  const parts = {};
  for (const [name, path] of Object.entries(sheetPath)) {
    const xml = files[path];
    if (!xml) continue;
    parts[name] = sheetParts(xml);
    const rels = files[relsOf(path)] || '';
    for (const id of parts[name].tableIds) {
      const tp = resolvePath(path, relTarget(rels, id));
      const tx = files[tp];
      if (!tx) continue;
      const t = attrs((/<table\b[^>]*>/.exec(tx) || [''])[0]);
      const rg = parseRange(t.ref);
      if (!rg) continue;
      tables[t.displayName || t.name] = {
        sheet: name, ...rg, cols: tags(tx, 'tableColumn').map((c) => c.a.name),
        header: t.headerRowCount !== '0', totals: Number(t.totalsRowCount || 0) > 0,
      };
    }
  }

  // a formula saved without its result (not by Excel) is dropped by SheetJS: take it from the sheet itself
  for (const [name, p] of Object.entries(parts)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    for (const [a, f] of Object.entries(p.formulaOf)) if (!ws[a] || !ws[a].f) ws[a] = { ...(ws[a] || { t: 'z' }), f };
  }

  // which sheets the documents need: theirs and every sheet their formulas reach
  const need = new Set(docSheets.filter((s) => wb.Sheets[s]));
  const refsIn = (f) => {
    const out = new Set();
    for (const m of String(f).matchAll(/'((?:[^']|'')+)'!|([A-Za-z_][\w.]*)!/g)) out.add((m[1] || m[2]).replace(/''/g, "'"));
    for (const m of String(f).matchAll(/([A-Za-z_][\w.]*)\[/g)) { const t = tables[m[1]]; if (t) out.add(t.sheet); }
    for (const m of String(f).matchAll(/[A-Za-z_][\w.]*/g)) {
      const def = names[m[0]];
      if (def) for (const s of refsIn(def)) out.add(s);
    }
    return out;
  };
  const queue = [...need];
  while (queue.length) {
    const s = queue.shift();
    const ws = wb.Sheets[s];
    if (!ws) continue;
    for (const [a, c] of Object.entries(ws)) {
      if (a[0] === '!' || !c || !c.f) continue;
      for (const x of refsIn(c.f)) if (wb.Sheets[x] && !need.has(x)) { need.add(x); queue.push(x); }
    }
    for (const rule of (parts[s] ? [...parts[s].cf.flatMap((r) => r.formulas), ...parts[s].dv.map((d) => d.formula)] : [])) {
      for (const x of refsIn(rule)) if (wb.Sheets[x] && !need.has(x)) { need.add(x); queue.push(x); }
    }
  }

  // cells
  const sheets = {};
  let savedToday = null;
  for (const s of need) {
    const ws = wb.Sheets[s];
    const cells = {};
    const spills = new Set();
    for (const [a, c] of Object.entries(ws)) {
      if (a[0] === '!' || !c) continue;
      const cell = {};
      if (c.t === 'e') cell.e = c.w || '#N/A';
      else if (c.t !== 'z' && c.v !== undefined) cell.v = c.t === 'd' ? c.v : c.v;
      // a link into another workbook ([1]Sheet!A1) can't be worked out here:
      // the cell keeps what Excel saved, as Excel does until links are refreshed
      if (c.f && /(^|[^A-Za-z0-9_"])\[\d+\]/.test(c.f.replace(/"[^"]*"/g, '""'))) cell.ext = 1;
      else if (c.f) cell.f = c.f;
      if (c.F && c.F !== `${a}:${a}` && c.f) for (const x of expand(c.F)) if (x !== a) spills.add(x);
      if (c.z && c.z !== 'General') cell.z = c.z;
      if (Object.keys(cell).length) cells[a] = cell;
      if (c.f && /^TODAY\(\)$/i.test(c.f) && typeof c.v === 'number') savedToday = c.v;
    }
    for (const x of spills) if (cells[x] && !cells[x].f) cells[x].spill = true;
    const sheet = { cells };
    if (docSheets.includes(s) && parts[s]) {
      const p = parts[s];
      for (const [a, xfi] of Object.entries(p.styleOf)) { cells[a] = cells[a] || {}; cells[a].s = xfi; }
      const area = parseRange(String(printArea[s] || ws['!ref'] || 'A1').replace(/^.*!/, ''));
      let maxC = area.c1;
      let maxR = area.r1;
      for (const a of Object.keys(cells)) { const rc = parseRange(a); if (rc) { maxC = Math.max(maxC, rc.c1); maxR = Math.max(maxR, rc.r1); } }
      const widths = [];
      for (let c = 0; c <= maxC; c++) {
        const col = p.cols.find((x) => c >= x.min && c <= x.max);
        widths.push(col && col.hidden ? 0 : col && col.width != null ? col.width : p.defaultWidth);
      }
      const heights = [];
      for (let r = 0; r <= maxR; r++) { const row = p.rows[r]; heights.push(row && row.hidden ? 0 : row && row.ht != null ? row.ht : p.defaultHeight); }
      let pics = [];
      if (p.drawing) {
        const dPath = resolvePath(sheetPath[s], relTarget(files[relsOf(sheetPath[s])] || '', p.drawing));
        if (files[dPath]) pics = pictures(files[dPath], dPath, files);
      }
      sheet.layout = {
        area, widths, heights, merges: p.merges, margins: p.margins, center: p.center, cf: p.cf, dv: p.dv, pictures: pics,
      };
    }
    sheets[s] = sheet;
  }
  return {
    version: 2, sheets, names, tables, styles, saved_today: savedToday,
    ...(vba ? { vba } : {}),
  };
}

export function expand(ref) {
  const out = [];
  for (const part of String(ref).split(/\s+/)) {
    const rg = parseRange(part);
    if (!rg) continue;
    for (let r = rg.r0; r <= rg.r1; r++) for (let c = rg.c0; c <= rg.c1; c++) out.push(`${colLetters(c)}${r + 1}`);
  }
  return out;
}
const colLetters = (i) => { let s = ''; let n = i + 1; while (n) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); } return s; };
export { colNum };

// The part paths buildModel reads (to unzip only those)
export const MODEL_PARTS = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|theme\/theme1\.xml|worksheets\/[^/]+\.xml|worksheets\/_rels\/[^/]+\.rels|tables\/[^/]+\.xml|drawings\/drawing\d+\.xml|drawings\/_rels\/[^/]+\.rels)$/;
