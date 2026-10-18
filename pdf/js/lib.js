// Shared helpers: lazy library loading, PDF rendering, ranges, downloads.
// Everything runs in the browser — files never leave the device.

import * as PDFLib from "../vendor/pdf-lib.esm.min.js";
export { PDFLib };
export const { PDFDocument, StandardFonts, rgb, degrees, PageSizes } = PDFLib;

const VENDOR = new URL("../vendor/", import.meta.url).href;

// ---- lazy loaders ----------------------------------------------------------
const scriptCache = {};
function loadScript(file, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  if (!scriptCache[file]) {
    scriptCache[file] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = VENDOR + file;
      s.onload = () => resolve(globalName ? window[globalName] : undefined);
      s.onerror = () => reject(new Error("Could not load " + file));
      document.head.appendChild(s);
    });
  }
  return scriptCache[file];
}

let pdfjsPromise;
export function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(VENDOR + "pdfjs/pdf.min.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = VENDOR + "pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}
export const jszip = () => loadScript("jszip.min.js", "JSZip");
export const sheetjs = () => loadScript("xlsx.full.min.js", "XLSX");
export const mammoth = () => loadScript("mammoth.browser.min.js", "mammoth");
export const pptxgen = () => loadScript("pptxgen.bundle.js", "PptxGenJS");
export const html2canvas = () => loadScript("html2canvas.min.js", "html2canvas");
export const tesseract = () => loadScript("tesseract.min.js", "Tesseract");

// ---- file helpers ----------------------------------------------------------
export const readBytes = (file) =>
  file instanceof Uint8Array ? Promise.resolve(file) : file.arrayBuffer().then((b) => new Uint8Array(b));

export const baseName = (name) => name.replace(/\.[^.]+$/, "");

export function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

/** A produced file: {name, blob}. */
export function out(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || mimeOf(name) });
  return { name, blob };
}
function mimeOf(name) {
  const ext = name.split(".").pop().toLowerCase();
  return {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    zip: "application/zip", txt: "text/plain", html: "text/html",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }[ext] || "application/octet-stream";
}

export function download({ name, blob }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function zipOutputs(outputs, name = "files.zip") {
  const JSZip = await jszip();
  const zip = new JSZip();
  const used = new Set();
  for (const o of outputs) {
    let n = o.name, i = 1;
    while (used.has(n)) n = o.name.replace(/(\.[^.]+)?$/, ` (${i++})$1`);
    used.add(n);
    zip.file(n, o.blob);
  }
  return out(name, await zip.generateAsync({ type: "blob" }));
}

// ---- PDF loading -----------------------------------------------------------
export class PasswordError extends Error {}

/** Load with pdf-lib, surfacing encrypted files as PasswordError. */
export async function loadPdf(bytes, opts = {}) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, ...opts });
  } catch (e) {
    if (/encrypt|password/i.test(e.message)) throw new PasswordError("This PDF is password-protected. Use “Unlock PDF” first.");
    throw e;
  }
}

/** Open with pdf.js (for rendering / text). Caller must destroy(). */
export async function openPdfjs(bytes, password) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: bytes.slice(0), // pdf.js transfers the buffer
    password,
    cMapUrl: VENDOR + "pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: VENDOR + "pdfjs/standard_fonts/",
    isEvalSupported: false,
  });
  try {
    return await task.promise;
  } catch (e) {
    if (e.name === "PasswordException") throw new PasswordError("This PDF is password-protected. Use “Unlock PDF” first.");
    throw e;
  }
}

/** Render a pdf.js page into a new canvas at `scale` (1 = 72 dpi). */
export async function renderPage(page, scale, { background = "#fff" } = {}) {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

export const canvasBlob = (canvas, type = "image/jpeg", quality = 0.92) =>
  new Promise((res) => canvas.toBlob(res, type, quality));
export const canvasBytes = async (canvas, type, quality) =>
  new Uint8Array(await (await canvasBlob(canvas, type, quality)).arrayBuffer());

/** Decode any browser-supported image into an ImageBitmap-like drawable. */
export async function decodeImage(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch {}
  }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Unsupported image"));
    img.src = URL.createObjectURL(blob);
  });
}

// ---- page ranges -----------------------------------------------------------
/** "1-3, 5, 8-" → [0,1,2,4,7,...] (0-based, in given order). */
export function parseRanges(str, total) {
  const result = [];
  const s = String(str || "").trim();
  if (!s || s.toLowerCase() === "all") return [...Array(total).keys()];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    let a, b;
    if (m) {
      a = m[1] ? +m[1] : 1;
      b = m[2] ? +m[2] : total;
    } else if (/^\d+$/.test(part)) {
      a = b = +part;
    } else if (part.toLowerCase() === "last") {
      a = b = total;
    } else throw new Error(`Invalid page range “${part}”`);
    if (a < 1 || b < 1 || a > total || b > total) throw new Error(`Page ${Math.max(a, b)} is out of range (1–${total})`);
    const step = a <= b ? 1 : -1;
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) result.push(i - 1);
  }
  return result;
}

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Strip characters a standard (WinAnsi) font cannot encode. */
export function winAnsiSafe(font, text) {
  let outText = "";
  for (const ch of text) {
    try { font.encodeText(ch); outText += ch; } catch { outText += "?"; }
  }
  return outText;
}

/**
 * Invisible (render mode 3) text so a page image becomes searchable and
 * selectable. words: [{text, x, y (baseline), size, width}] in PDF points on
 * an unrotated page.
 */
export function addInvisibleText(page, font, words) {
  const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextRenderingMode,
    TextRenderingMode, setTextMatrix, setCharacterSqueeze, showText } = PDFLib;
  if (!words.length) return;
  const key = page.node.newFontDictionary(font.name, font.ref);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const w of words) {
    const text = winAnsiSafe(font, w.text);
    const natural = font.widthOfTextAtSize(text, w.size) || 1;
    ops.push(setFontAndSize(key, w.size), setCharacterSqueeze((w.width / natural) * 100),
      setTextMatrix(1, 0, 0, 1, w.x, w.y), showText(font.encodeText(text + " ")));
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

/** Yield to the UI thread so progress updates paint. */
export const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- text extraction (pdf.js) ---------------------------------------------
/**
 * Group a page's text items into lines. Returns
 * [{y, x, h, text, items:[{x, w, str}]}] top-to-bottom, in PDF points
 * measured from the top-left of the (unrotated viewport) page.
 */
export async function pageLines(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    const h = Math.hypot(it.transform[2], it.transform[3]) || 10;
    items.push({ x, y, h, w: it.width, str: it.str });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2, Math.min(l.h, it.h) * 0.5));
    if (line) { line.items.push(it); line.h = Math.max(line.h, it.h); }
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.x = l.items[0].x;
    let text = "", end = null;
    for (const it of l.items) {
      if (end !== null && it.x - end > it.h * 0.25 && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
      text += it.str;
      end = it.x + it.w;
    }
    l.text = text;
  }
  lines.sort((a, b) => a.y - b.y);
  return { lines, width: vp.width, height: vp.height };
}

/** Join lines into paragraphs using vertical gaps. */
export function linesToParagraphs(lines) {
  const paras = [];
  let cur = null, prev = null;
  const right = (l) => { const it = l.items.at(-1); return it.x + it.w; };
  const maxRight = Math.max(0, ...lines.map(right));
  for (const l of lines) {
    const gap = prev ? l.y - prev.y : 0;
    // a line that stops well short of the right margin ends its paragraph
    const short = prev && right(prev) < maxRight - Math.max(40, (maxRight - prev.x) * 0.15);
    if (!cur || short || gap > prev.h * 1.7 || Math.abs(l.h - prev.h) > prev.h * 0.3) {
      cur = { text: l.text, size: l.h, x: l.x };
      paras.push(cur);
    } else {
      cur.text = cur.text.endsWith("-") ? cur.text.slice(0, -1) + l.text : cur.text + " " + l.text;
    }
    prev = l;
  }
  return paras;
}

export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]))
    // strip characters XML 1.0 forbids
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
}
export const escapeHtml = escapeXml;

// ---- OCR -------------------------------------------------------------------
let ocrWorker = null, ocrLang = null, ocrProgress = null;
export async function ocrRecognize(canvas, lang = "eng", onProgress) {
  const T = await tesseract();
  if (!ocrWorker || ocrLang !== lang) {
    if (ocrWorker) await ocrWorker.terminate();
    const opts = {
      workerPath: VENDOR + "worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
      logger: (m) => ocrProgress && m.status === "recognizing text" && ocrProgress(m.progress),
      // tests can point the engine at local copies
      ...(window.PDFTK_TESSERACT || {}),
    };
    ocrWorker = await T.createWorker(lang, 1, opts);
    ocrLang = lang;
  }
  ocrProgress = onProgress;
  try {
    const { data } = await ocrWorker.recognize(canvas);
    return data; // .text, .words[{text, bbox:{x0,y0,x1,y1}}]
  } finally {
    ocrProgress = null;
  }
}

// ---- drawing on rotated pages ---------------------------------------------
/**
 * Coordinates as the page is *displayed* (after /Rotate), origin bottom-left,
 * mapped to PDF user space. Drawing with `rotate` keeps content upright.
 */
export function visual(page) {
  const cb = page.getCropBox();
  const rot = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const W = cb.width, H = cb.height;
  const map = (vx, vy) => {
    let px, py;
    if (rot === 90) { px = W - vy; py = vx; }
    else if (rot === 180) { px = W - vx; py = H - vy; }
    else if (rot === 270) { px = vy; py = H - vx; }
    else { px = vx; py = vy; }
    return { x: cb.x + px, y: cb.y + py };
  };
  return { width: rot % 180 ? H : W, height: rot % 180 ? W : H, rot, map, rotate: degrees(rot) };
}
