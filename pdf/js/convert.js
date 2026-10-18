// Format conversions: Office / HTML → PDF and PDF → Office / images / text.

import {
  PDFDocument, PageSizes, readBytes, baseName, out, openPdfjs, renderPage, canvasBytes, canvasBlob,
  parseRanges, pageLines, linesToParagraphs, escapeXml, escapeHtml, ocrRecognize, jszip, sheetjs,
  mammoth, pptxgen, html2canvas, tick, pdfjs, StandardFonts, addInvisibleText,
} from "./lib.js";

export const PAPER_OPT = {
  key: "paper", label: "Paper", type: "select", default: "a4",
  choices: [["a4", "A4 portrait"], ["a4-landscape", "A4 landscape"], ["letter", "Letter portrait"], ["letter-landscape", "Letter landscape"]],
};

function paperSize(p = "a4") {
  let [w, h] = p.startsWith("letter") ? PageSizes.Letter : PageSizes.A4;
  if (p.endsWith("landscape")) [w, h] = [h, w];
  return [w, h];
}

// ===========================================================================
// HTML → PDF (shared by Word, Excel and HTML)
// ===========================================================================

const DOC_CSS = `
  body{font-family:Calibri,Carlito,"Segoe UI",Arial,sans-serif;font-size:11pt;line-height:1.35;color:#000}
  h1{font-size:20pt;margin:0 0 8pt} h2{font-size:16pt;margin:12pt 0 6pt} h3{font-size:13pt;margin:10pt 0 4pt}
  p{margin:0 0 8pt} img{max-width:100%;height:auto} ul,ol{margin:0 0 8pt 18pt;padding:0}
  table{border-collapse:collapse;margin:0 0 8pt;max-width:100%} td,th{border:1px solid #999;padding:3pt 5pt;vertical-align:top}
  h1.title{font-size:26pt;font-weight:600}
  .pb{page-break-before:always;break-before:page}`;

async function whenReady(doc) {
  await Promise.all([...doc.images].map((img) => (img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; }))));
  try { await doc.fonts.ready; } catch {}
}

/** Every word's box (CSS px, document coordinates) with its font size. */
function collectWords(doc) {
  const words = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    const cs = doc.defaultView.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const fontPx = parseFloat(cs.fontSize) || 14;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(node.data))) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const r = range.getClientRects()[0];
      if (r && r.width > 0) words.push({ text: m[0], x: r.left, y: r.top, w: r.width, h: r.height, fontPx });
    }
  }
  return words;
}

/**
 * Lay HTML out at the page's content width, rasterize it page by page exactly
 * as the browser draws it, and add an invisible text layer from the browser's
 * own word positions so the PDF stays searchable and selectable.
 */
export async function htmlToPdfBytes(html, { paper = "a4", margin = 40, css = DOC_CSS } = {}, ctx) {
  const [pw, ph] = paperSize(paper);
  const cwPt = pw - margin * 2, chPt = ph - margin * 2;
  const cwPx = Math.round((cwPt * 4) / 3), chPx = (chPt * 4) / 3;
  const k = 0.75; // CSS px → pt
  const render = await html2canvas();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${cwPx}px;height:800px;border:0;background:#fff`;
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}${css}</style></head><body>${html}</body></html>`);
    doc.close();
    await whenReady(doc);
    const total = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 1);
    frame.style.height = total + "px";
    const forced = [...doc.querySelectorAll(".pb, [style*='page-break-before'], [style*='break-before']")]
      .map((e) => e.getBoundingClientRect().top).filter((t) => t > 1).sort((a, b) => a - b);
    const bottoms = [...doc.body.querySelectorAll("p,li,tr,img,h1,h2,h3,h4,h5,h6,pre,blockquote,div,table")]
      .map((e) => e.getBoundingClientRect().bottom).sort((a, b) => a - b);
    const words = collectWords(doc);
    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);
    let y = 0, n = 0;
    while (y < total - 1) {
      let end = Math.min(y + chPx, total);
      const f = forced.find((t) => t > y + 1 && t < end);
      if (f) end = f;
      else if (end < total) {
        const best = bottoms.filter((b) => b <= end && b > y + chPx * 0.5).pop();
        if (best) end = best;
      }
      ctx?.progress(Math.min(0.95, y / total), `Rendering page ${++n}`);
      const canvas = await render(doc.body, {
        x: 0, y, width: cwPx, height: Math.ceil(end - y), windowWidth: cwPx, windowHeight: total,
        scale: 2, backgroundColor: "#ffffff", logging: false, useCORS: true,
      });
      const img = await out.embedJpg(await canvasBytes(canvas, "image/jpeg", 0.85));
      const page = out.addPage([pw, ph]);
      const hPt = (end - y) * k;
      page.drawImage(img, { x: margin, y: ph - margin - hPt, width: cwPt, height: hPt });
      const onPage = words.filter((w) => w.y + w.h / 2 >= y && w.y + w.h / 2 < end).map((w) => {
        const size = w.fontPx * k;
        // baseline sits about 80% down a line box centred on the glyphs
        return { text: w.text, x: margin + w.x * k, y: ph - margin - (w.y - y + w.h / 2) * k - size * 0.3, size, width: w.w * k };
      });
      addInvisibleText(page, font, onPage);
      y = end;
      await tick();
    }
    return out.save({ useObjectStreams: true });
  } finally {
    frame.remove();
  }
}

export async function wordToPdf(file, opts, ctx) {
  const m = await mammoth();
  ctx.progress(0.1, "Reading document");
  const bytes = await readBytes(file);
  const { value } = await m.convertToHtml(
    { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    { styleMap: ["p[style-name='Title'] => h1.title:fresh", "p[style-name='Subtitle'] => h2:fresh"] });
  const pdf = await htmlToPdfBytes(value || "<p></p>", { paper: opts.paper, margin: 56 }, ctx);
  return [out(baseName(file.name) + ".pdf", pdf)];
}

export async function excelToPdf(file, opts, ctx) {
  const XLSX = await sheetjs();
  ctx.progress(0.1, "Reading spreadsheet");
  const wb = XLSX.read(await readBytes(file), { type: "array", cellDates: true });
  const parts = [];
  wb.SheetNames.forEach((name, i) => {
    const ws = wb.Sheets[name];
    if (!ws["!ref"]) return;
    const html = XLSX.utils.sheet_to_html(ws, { editable: false });
    const table = (html.match(/<table[\s\S]*<\/table>/i) || [""])[0];
    if (!table) return;
    parts.push(`<h2 class="${parts.length ? "pb" : ""}">${escapeHtml(name)}</h2>${table}`);
  });
  if (!parts.length) throw new Error("The spreadsheet is empty.");
  const css = DOC_CSS + `body{font-size:9pt} h2{font-size:12pt} table{width:auto}
    td,th{border:${opts.gridlines === false ? "0" : "1px solid #bbb"};padding:2pt 4pt;white-space:nowrap}`;
  const pdf = await htmlToPdfBytes(parts.join(""), { paper: opts.paper, margin: 30, css }, ctx);
  return [out(baseName(file.name) + ".pdf", pdf)];
}

export async function htmlToPdf(file, opts, ctx) {
  const html = await file.text();
  const pdf = await htmlToPdfBytes(html, { paper: opts.paper, css: "" }, ctx);
  return [out(baseName(file.name) + ".pdf", pdf)];
}

/** HTML-to-PDF with no files: use the pasted HTML or URL. */
export async function htmlSourceToPdf(files, opts, ctx) {
  let src = String(opts.source || "").trim();
  if (!src) throw new Error("Add an .html file, or paste HTML or a web address.");
  let name = "page";
  if (/^https?:\/\/\S+$/i.test(src)) {
    let res;
    try { res = await fetch(src); } catch {
      throw new Error("That site doesn't allow other pages to read it (CORS). Save the page as .html in your browser and add the file instead.");
    }
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);
    name = new URL(src).hostname;
    src = (await res.text()).replace(/<head([^>]*)>/i, `<head$1><base href="${escapeHtml(src)}">`);
  }
  const pdf = await htmlToPdfBytes(src, { paper: opts.paper, css: "" }, ctx);
  return [out(name + ".pdf", pdf)];
}

// ===========================================================================
// PowerPoint → PDF (renders each slide from the PPTX XML onto a canvas)
// ===========================================================================

const EMU_PER_PT = 12700;
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const parseXml = (s) => new DOMParser().parseFromString(s, "application/xml");
const kids = (el, ns, name) => (el ? [...el.children].filter((c) => c.localName === name && (!ns || c.namespaceURI === ns)) : []);
const kid = (el, ns, name) => kids(el, ns, name)[0] || null;
const desc = (el, name) => (el ? el.getElementsByTagNameNS("*", name)[0] || null : null);

function resolvePath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function readRels(zip, partPath) {
  const relPath = partPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const f = zip.file(relPath);
  const map = {};
  if (!f) return map;
  const x = parseXml(await f.async("string"));
  for (const r of x.getElementsByTagName("Relationship")) {
    map[r.getAttribute("Id")] = { type: r.getAttribute("Type"), target: r.getAttribute("TargetMode") === "External" ? null : resolvePath(partPath, r.getAttribute("Target")) };
  }
  return map;
}

function colorOf(el, theme) {
  if (!el) return null;
  const srgb = kid(el, NS_A, "srgbClr");
  if (srgb) return "#" + srgb.getAttribute("val");
  const scheme = kid(el, NS_A, "schemeClr");
  if (scheme) {
    const alias = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
    const v = scheme.getAttribute("val");
    return theme[alias[v] || v] || null;
  }
  const sys = kid(el, NS_A, "sysClr");
  if (sys) return "#" + (sys.getAttribute("lastClr") || "000000");
  return null;
}

function xfrmOf(sp) {
  const x = desc(sp, "xfrm");
  if (!x) return null;
  const off = kid(x, NS_A, "off"), ext = kid(x, NS_A, "ext");
  if (!off || !ext) return null;
  return { x: +off.getAttribute("x"), y: +off.getAttribute("y"), w: +ext.getAttribute("cx"), h: +ext.getAttribute("cy") };
}

function phKey(sp) {
  const ph = desc(sp, "ph");
  if (!ph) return null;
  return { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") };
}

function findPh(shapes, key) {
  return shapes.find((s) => { const k = phKey(s); return k && key.idx != null && k.idx === key.idx; })
    || shapes.find((s) => { const k = phKey(s); return k && k.type === key.type; })
    || shapes.find((s) => { const k = phKey(s); return k && ((key.type === "ctrTitle" && k.type === "title") || (key.type === "subTitle" && k.type === "body")); });
}

function wrapText(cx, text, maxW) {
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const t = line + word;
      if (cx.measureText(t).width > maxW && line.trim()) { lines.push(line.trimEnd()); line = word.trimStart(); }
      else line = t;
    }
    lines.push(line);
  }
  return lines;
}

async function renderSlide(zip, slidePath, size, theme, scale) {
  const x = parseXml(await zip.file(slidePath).async("string"));
  const rels = await readRels(zip, slidePath);
  const layoutRel = Object.values(rels).find((r) => r.type.endsWith("/slideLayout"));
  let layoutShapes = [], masterShapes = [], bg = null;
  if (layoutRel?.target && zip.file(layoutRel.target)) {
    const lx = parseXml(await zip.file(layoutRel.target).async("string"));
    layoutShapes = [...lx.getElementsByTagNameNS(NS_P, "sp")];
    const lrels = await readRels(zip, layoutRel.target);
    const masterRel = Object.values(lrels).find((r) => r.type.endsWith("/slideMaster"));
    if (masterRel?.target && zip.file(masterRel.target)) {
      const mx = parseXml(await zip.file(masterRel.target).async("string"));
      masterShapes = [...mx.getElementsByTagNameNS(NS_P, "sp")];
      bg = colorOf(desc(desc(mx, "bg"), "solidFill"), theme);
    }
    bg = colorOf(desc(desc(lx, "bg"), "solidFill"), theme) || bg;
  }
  bg = colorOf(desc(desc(x, "bg"), "solidFill"), theme) || bg || "#ffffff";

  const W = size.w / EMU_PER_PT, H = size.h / EMU_PER_PT;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
  const cx = canvas.getContext("2d");
  cx.scale(scale, scale);
  cx.fillStyle = bg;
  cx.fillRect(0, 0, W, H);

  const spTree = desc(x, "spTree");
  const shapes = spTree ? [...spTree.querySelectorAll("*")].filter((e) => e.namespaceURI === NS_P && (e.localName === "sp" || e.localName === "pic")) : [];
  for (const sp of shapes) {
    const key = phKey(sp);
    let box = xfrmOf(sp);
    if (!box && key) box = xfrmOf(findPh(layoutShapes, key) || {}) || xfrmOf(findPh(masterShapes, key) || {});
    if (!box) continue;
    const bx = box.x / EMU_PER_PT, by = box.y / EMU_PER_PT, bw = box.w / EMU_PER_PT, bh = box.h / EMU_PER_PT;

    if (sp.localName === "pic") {
      const blip = desc(sp, "blip");
      const rid = blip && blip.getAttributeNS(NS_R, "embed");
      const target = rid && rels[rid]?.target;
      if (target && zip.file(target)) {
        try {
          const blob = new Blob([await zip.file(target).async("uint8array")]);
          const bmp = await createImageBitmap(blob);
          cx.drawImage(bmp, bx, by, bw, bh);
        } catch {}
      }
      continue;
    }
    const spPr = kid(sp, NS_P, "spPr");
    const fill = colorOf(kid(spPr, NS_A, "solidFill"), theme);
    if (fill) { cx.fillStyle = fill; cx.fillRect(bx, by, bw, bh); }
    const ln = kid(spPr, NS_A, "ln");
    const lnColor = ln && colorOf(kid(ln, NS_A, "solidFill"), theme);
    if (lnColor) { cx.strokeStyle = lnColor; cx.lineWidth = (+ln.getAttribute("w") || 12700) / EMU_PER_PT; cx.strokeRect(bx, by, bw, bh); }

    const body = kid(sp, NS_P, "txBody");
    if (!body) continue;
    const isTitle = key && /title/i.test(key.type);
    const anchor = desc(body, "bodyPr")?.getAttribute("anchor") || (isTitle ? "ctr" : "t");
    const pad = 7.2;
    const rendered = [];
    for (const p of kids(body, NS_A, "p")) {
      const runs = [...kids(p, NS_A, "r"), ...kids(p, NS_A, "fld")];
      const text = runs.map((r) => kid(r, NS_A, "t")?.textContent || "").join("");
      const rPr = runs.map((r) => kid(r, NS_A, "rPr")).find(Boolean) || desc(p, "endParaRPr");
      const sz = rPr?.getAttribute("sz") ? +rPr.getAttribute("sz") / 100 : isTitle ? 40 : key ? 24 : 18;
      const bold = rPr?.getAttribute("b") === "1" || isTitle;
      const italic = rPr?.getAttribute("i") === "1";
      const color = colorOf(kid(rPr, NS_A, "solidFill"), theme) || theme.dk1 || "#000";
      const pPr = kid(p, NS_A, "pPr");
      const algn = pPr?.getAttribute("algn") || (key?.type === "ctrTitle" || key?.type === "subTitle" ? "ctr" : "l");
      const lvl = +(pPr?.getAttribute("lvl") || 0);
      const bullet = text && !kid(pPr, NS_A, "buNone") && (kid(pPr, NS_A, "buChar") || (key && key.type === "body" && !isTitle && key.type !== "subTitle"));
      cx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${sz}px Calibri, Carlito, Arial, sans-serif`;
      const indent = lvl * 24 + (bullet ? sz * 0.9 : 0);
      const lines = wrapText(cx, text, Math.max(10, bw - pad * 2 - indent));
      rendered.push({ lines, sz, font: cx.font, color, algn, indent, bullet });
    }
    const totalH = rendered.reduce((s, r) => s + r.lines.length * r.sz * 1.2, 0);
    let ty = by + pad;
    if (anchor === "ctr") ty = by + (bh - totalH) / 2;
    else if (anchor === "b") ty = by + bh - pad - totalH;
    cx.save();
    cx.beginPath(); cx.rect(bx - 2, by - 2, bw + 4, bh + 400); cx.clip();
    for (const r of rendered) {
      cx.font = r.font; cx.fillStyle = r.color; cx.textBaseline = "top";
      r.lines.forEach((line, i) => {
        const lw = cx.measureText(line).width;
        let lx = bx + pad + r.indent;
        if (r.algn === "ctr") lx = bx + (bw - lw) / 2;
        else if (r.algn === "r") lx = bx + bw - pad - lw;
        if (i === 0 && r.bullet) cx.fillText("•", lx - r.sz * 0.9, ty);
        cx.fillText(line, lx, ty);
        ty += r.sz * 1.2;
      });
    }
    cx.restore();
  }
  return canvas;
}

export async function pptToPdf(file, opts, ctx) {
  const JSZip = await jszip();
  const zip = await JSZip.loadAsync(await readBytes(file));
  const presPath = "ppt/presentation.xml";
  if (!zip.file(presPath)) throw new Error("This doesn't look like a PowerPoint (.pptx) file.");
  const pres = parseXml(await zip.file(presPath).async("string"));
  const sz = desc(pres, "sldSz");
  const size = { w: +sz?.getAttribute("cx") || 12192000, h: +sz?.getAttribute("cy") || 6858000 };
  const rels = await readRels(zip, presPath);
  const theme = {};
  const themeRel = Object.values(rels).find((r) => r.type.endsWith("/theme"));
  if (themeRel?.target && zip.file(themeRel.target)) {
    const tx = parseXml(await zip.file(themeRel.target).async("string"));
    const scheme = desc(tx, "clrScheme");
    for (const c of scheme ? [...scheme.children] : []) theme[c.localName] = colorOf(c, {});
  }
  const ids = [...pres.getElementsByTagNameNS(NS_P, "sldId")].map((e) => e.getAttributeNS(NS_R, "id"));
  const slides = ids.map((id) => rels[id]?.target).filter((t) => t && zip.file(t));
  if (!slides.length) throw new Error("No slides found.");
  const doc = await PDFDocument.create();
  const W = size.w / EMU_PER_PT, H = size.h / EMU_PER_PT;
  for (let i = 0; i < slides.length; i++) {
    ctx.progress(i / slides.length, `Rendering slide ${i + 1} of ${slides.length}`);
    const canvas = await renderSlide(zip, slides[i], size, theme, 2.5);
    const img = await doc.embedJpg(await canvasBytes(canvas, "image/jpeg", 0.92));
    doc.addPage([W, H]).drawImage(img, { x: 0, y: 0, width: W, height: H });
    await tick();
  }
  return [out(baseName(file.name) + ".pdf", await doc.save({ useObjectStreams: true }))];
}

// ===========================================================================
// PDF → images
// ===========================================================================

export async function pdfToImages(file, opts, ctx) {
  const pdf = await openPdfjs(await readBytes(file));
  const base = baseName(file.name);
  const outs = [];
  try {
    if (opts.mode === "extract") {
      const lib = await pdfjs();
      const seen = new Set();
      for (let i = 1; i <= pdf.numPages; i++) {
        ctx.progress((i - 1) / pdf.numPages, `Scanning page ${i} for images`);
        const page = await pdf.getPage(i);
        const ops = await page.getOperatorList();
        for (let j = 0; j < ops.fnArray.length; j++) {
          const fn = ops.fnArray[j];
          if (fn !== lib.OPS.paintImageXObject && fn !== lib.OPS.paintImageXObjectRepeat && fn !== lib.OPS.paintInlineImageXObject) continue;
          const arg = ops.argsArray[j][0];
          let img;
          if (typeof arg === "string") {
            if (seen.has(arg)) continue;
            seen.add(arg);
            const store = arg.startsWith("g_") ? page.commonObjs : page.objs;
            img = await new Promise((res) => { try { store.get(arg, res); } catch { res(null); } });
          } else img = arg;
          const c = imageObjToCanvas(img);
          if (!c || c.width < 8 || c.height < 8) continue;
          outs.push(out(`${base}_p${i}_img${outs.length + 1}.png`, await canvasBlob(c, "image/png")));
        }
        page.cleanup();
      }
      if (!outs.length) throw new Error("No embedded images were found in this PDF.");
      return outs;
    }
    const pages = parseRanges(opts.pages, pdf.numPages);
    const fmt = opts.format === "png" ? "image/png" : opts.format === "webp" ? "image/webp" : "image/jpeg";
    const ext = opts.format === "png" ? "png" : opts.format === "webp" ? "webp" : "jpg";
    for (let k = 0; k < pages.length; k++) {
      ctx.progress(k / pages.length, `Rendering page ${pages[k] + 1}`);
      const page = await pdf.getPage(pages[k] + 1);
      const canvas = await renderPage(page, (+opts.dpi || 150) / 72);
      outs.push(out(`${base}_page${pages[k] + 1}.${ext}`, await canvasBlob(canvas, fmt, 0.92)));
      page.cleanup();
      canvas.width = canvas.height = 0;
    }
    return outs;
  } finally {
    pdf.destroy();
  }
}

function imageObjToCanvas(img) {
  if (!img) return null;
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const cx = c.getContext("2d");
  if (img.bitmap) { cx.drawImage(img.bitmap, 0, 0); return c; }
  if (!img.data) return null;
  const id = cx.createImageData(img.width, img.height);
  const d = img.data, o = id.data, n = img.width * img.height;
  if (d.length === n * 4) o.set(d);
  else if (d.length === n * 3) for (let i = 0; i < n; i++) { o[i * 4] = d[i * 3]; o[i * 4 + 1] = d[i * 3 + 1]; o[i * 4 + 2] = d[i * 3 + 2]; o[i * 4 + 3] = 255; }
  else if (img.kind === 1) {
    const rowBytes = (img.width + 7) >> 3;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const v = (d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0, p = (y * img.width + x) * 4;
      o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255;
    }
  } else return null;
  cx.putImageData(id, 0, 0);
  return c;
}

// ===========================================================================
// PDF → text structures (with OCR fallback)
// ===========================================================================

/** Lines for a page; OCR it when it has no text layer and OCR is on. */
async function linesWithOcr(page, opts, ctx, label) {
  const res = await pageLines(page);
  if (res.lines.length || !opts.ocr) return res;
  const scale = 300 / 72;
  const canvas = await renderPage(page, scale);
  const data = await ocrRecognize(canvas, opts.lang || "eng", (p) => ctx.progress(null, `${label} — OCR ${Math.round(p * 100)}%`));
  const lines = [];
  for (const l of data.lines || []) {
    const words = (l.words || []).map((w) => ({ x: w.bbox.x0 / scale, w: (w.bbox.x1 - w.bbox.x0) / scale, h: (w.bbox.y1 - w.bbox.y0) / scale, str: w.text }));
    if (!words.length) continue;
    lines.push({ y: l.bbox.y1 / scale, h: (l.bbox.y1 - l.bbox.y0) / scale, x: l.bbox.x0 / scale, text: l.text.trim(), items: words });
  }
  if (!lines.length && data.text) data.text.split("\n").filter((t) => t.trim()).forEach((t, i) => lines.push({ y: i * 14, h: 11, x: 0, text: t, items: [{ x: 0, w: 100, h: 11, str: t }] }));
  return { ...res, lines, ocr: true };
}

export async function pdfToText(file, opts, ctx) {
  const pdf = await openPdfjs(await readBytes(file));
  const parts = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const label = `Reading page ${i} of ${pdf.numPages}`;
      ctx.progress((i - 1) / pdf.numPages, label);
      const page = await pdf.getPage(i);
      const { lines } = await linesWithOcr(page, opts, ctx, label);
      parts.push(`--- Page ${i} ---\n` + lines.map((l) => l.text).join("\n"));
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  return [out(baseName(file.name) + ".txt", parts.join("\n\n") + "\n", "text/plain;charset=utf-8")];
}

// ---- PDF → Word -----------------------------------------------------------

function docxXml(body, sect) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${NS_R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="${NS_A}" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="${sect.w}" w:h="${sect.h}"${sect.w > sect.h ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${sect.m}" w:right="${sect.m}" w:bottom="${sect.m}" w:left="${sect.m}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

function docxParagraph(text, { size = 11, bold = false, indentTw = 0 } = {}) {
  const sz = Math.round(Math.min(72, Math.max(6, size)) * 2);
  return `<w:p><w:pPr><w:spacing w:after="120"/>${indentTw > 0 ? `<w:ind w:left="${indentTw}"/>` : ""}</w:pPr><w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function docxImage(rid, id, wPt, hPt) {
  const cx = Math.round(wPt * EMU_PER_PT), cy = Math.round(hPt * EMU_PER_PT);
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Page ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="page${id}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

async function buildDocx(body, media, sect) {
  const JSZip = await jszip();
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>PDF Toolkit</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`);
  zip.file("word/document.xml", docxXml(body, sect));
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join("")}</Relationships>`);
  for (const m of media) zip.file("word/media/" + m.name, m.bytes);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

export async function pdfToWord(file, opts, ctx) {
  const pdf = await openPdfjs(await readBytes(file));
  const media = [];
  const chunks = [];
  let sect;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const label = `Converting page ${i} of ${pdf.numPages}`;
      ctx.progress((i - 1) / pdf.numPages, label);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const margin = opts.mode === "image" ? 0 : 72;
      if (!sect) sect = { w: Math.round(vp.width * 20), h: Math.round(vp.height * 20), m: margin * 20 };
      if (i > 1) chunks.push(PAGE_BREAK);
      if (opts.mode === "image" || opts.mode === "both") {
        const canvas = await renderPage(page, 150 / 72);
        const rid = "rIdImg" + i;
        media.push({ rid, name: `page${i}.jpeg`, bytes: await canvasBytes(canvas, "image/jpeg", 0.88) });
        const maxW = vp.width - margin * 2, maxH = vp.height - margin * 2 - 4;
        const s = Math.min(maxW / vp.width, maxH / vp.height);
        chunks.push(docxImage(rid, i, vp.width * s, vp.height * s));
        if (opts.mode === "both") chunks.push(PAGE_BREAK);
      }
      if (opts.mode !== "image") {
        const { lines } = await linesWithOcr(page, opts, ctx, label);
        const paras = linesToParagraphs(lines);
        const sizes = paras.map((p) => p.size).sort((a, b) => a - b);
        const median = sizes[Math.floor(sizes.length / 2)] || 11;
        for (const p of paras) {
          const size = Math.round(p.size * 2) / 2;
          chunks.push(docxParagraph(p.text, { size, bold: size > median * 1.2, indentTw: Math.max(0, (p.x - 72) * 20) > 360 ? Math.round((p.x - 72) * 20) : 0 }));
        }
        if (!paras.length) chunks.push(docxParagraph(""));
      }
      page.cleanup();
      await tick();
    }
  } finally {
    pdf.destroy();
  }
  const blob = await buildDocx(chunks.join(""), media, sect || { w: 11906, h: 16838, m: 1440 });
  return [out(baseName(file.name) + ".docx", blob)];
}

// ---- PDF → Excel ----------------------------------------------------------

function linesToRows(lines) {
  // column starts: cluster the x of every text item on the page
  const xs = lines.flatMap((l) => l.items.map((it) => it.x)).sort((a, b) => a - b);
  const cols = [];
  for (const x of xs) if (!cols.length || x - cols.at(-1).max > 6) cols.push({ min: x, max: x }); else cols.at(-1).max = x;
  const starts = cols.map((c) => c.min);
  const colOf = (x) => { let k = 0; for (let i = 0; i < starts.length; i++) if (x >= starts[i] - 3) k = i; return k; };
  return lines.map((l) => {
    const row = [];
    // merge items that touch into one cell value first
    const cells = [];
    for (const it of l.items) {
      const last = cells.at(-1);
      if (last && it.x - (last.x + last.w) < Math.max(3, it.h * 0.6)) { last.str += (it.x - (last.x + last.w) > it.h * 0.2 ? " " : "") + it.str; last.w = it.x + it.w - last.x; }
      else cells.push({ ...it });
    }
    for (const c of cells) {
      const k = colOf(c.x);
      row[k] = row[k] ? row[k] + " " + c.str.trim() : c.str.trim();
    }
    for (let i = 0; i < row.length; i++) {
      if (row[i] === undefined) row[i] = null;
      else {
        const num = row[i].replace(/[,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
        if (/^-?\d+(\.\d+)?$/.test(num) && num.length < 16) row[i] = +num;
      }
    }
    return row;
  });
}

export async function pdfToExcel(file, opts, ctx) {
  const XLSX = await sheetjs();
  const pdf = await openPdfjs(await readBytes(file));
  const wb = XLSX.utils.book_new();
  const all = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const label = `Reading page ${i} of ${pdf.numPages}`;
      ctx.progress((i - 1) / pdf.numPages, label);
      const page = await pdf.getPage(i);
      const { lines } = await linesWithOcr(page, opts, ctx, label);
      const rows = linesToRows(lines);
      if (opts.sheets === "single") { all.push(...rows, []); }
      else XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.length ? rows : [[]]), `Page ${i}`);
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  if (opts.sheets === "single") XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(all.length ? all : [[]]), "Sheet1");
  const data = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return [out(baseName(file.name) + ".xlsx", new Uint8Array(data))];
}

// ---- PDF → PowerPoint -----------------------------------------------------

export async function pdfToPpt(file, opts, ctx) {
  const PptxGenJS = await pptxgen();
  const pdf = await openPdfjs(await readBytes(file));
  const pptx = new PptxGenJS();
  try {
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const wIn = first.width / 72, hIn = first.height / 72;
    pptx.defineLayout({ name: "PDF", width: wIn, height: hIn });
    pptx.layout = "PDF";
    for (let i = 1; i <= pdf.numPages; i++) {
      ctx.progress((i - 1) / pdf.numPages, `Converting page ${i} of ${pdf.numPages}`);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const canvas = await renderPage(page, (+opts.dpi || 150) / 72);
      const slide = pptx.addSlide();
      // fit pages of a different size inside the slide
      const s = Math.min(wIn / (vp.width / 72), hIn / (vp.height / 72));
      const w = (vp.width / 72) * s, h = (vp.height / 72) * s;
      slide.addImage({ data: canvas.toDataURL("image/jpeg", 0.88), x: (wIn - w) / 2, y: (hIn - h) / 2, w, h });
      if (opts.notes !== false) {
        const { lines } = await pageLines(page);
        const text = lines.map((l) => l.text).join("\n");
        if (text.trim()) slide.addNotes(text);
      }
      page.cleanup();
      await tick();
    }
  } finally {
    pdf.destroy();
  }
  const blob = await pptx.write({ outputType: "blob" });
  return [out(baseName(file.name) + ".pptx", blob)];
}
