// Tool registry. Each tool is declarative: options render as a form, and one
// of these does the work:
//   transform(bytes, opts, ctx) -> Uint8Array   (one PDF in, one PDF out; batch + workflows)
//   perFile(file, opts, ctx)    -> [outputs]    (batch, any output type)
//   run(files, opts, ctx)       -> [outputs]    (all files at once)
//   mount(el, ctx)                              (interactive tools, see editor.js etc.)

import {
  PDFLib, PDFDocument, StandardFonts, rgb, degrees, PageSizes,
  readBytes, baseName, out, loadPdf, openPdfjs, renderPage, canvasBytes, decodeImage,
  parseRanges, hexToRgb, winAnsiSafe, visual, tick, pageLines, ocrRecognize, PasswordError,
} from "./lib.js";
import * as convert from "./convert.js";

const { PDFName, PDFRawStream, PDFDict, PDFArray, PDFNumber, PDFHexString, PDFString, decodePDFRawStream } = PDFLib;

const save = (doc, opts) => doc.save({ useObjectStreams: true, ...opts });

export const OCR_LANGS = [
  ["eng", "English"], ["hin", "Hindi"], ["ben", "Bengali"], ["mar", "Marathi"], ["tam", "Tamil"],
  ["tel", "Telugu"], ["guj", "Gujarati"], ["kan", "Kannada"], ["mal", "Malayalam"], ["pan", "Punjabi"],
  ["urd", "Urdu"], ["fra", "French"], ["deu", "German"], ["spa", "Spanish"], ["ita", "Italian"],
  ["por", "Portuguese"], ["nld", "Dutch"], ["rus", "Russian"], ["ukr", "Ukrainian"], ["pol", "Polish"],
  ["tur", "Turkish"], ["ara", "Arabic"], ["fas", "Persian"], ["chi_sim", "Chinese (Simplified)"],
  ["chi_tra", "Chinese (Traditional)"], ["jpn", "Japanese"], ["kor", "Korean"], ["vie", "Vietnamese"],
  ["tha", "Thai"], ["ind", "Indonesian"], ["ell", "Greek"],
];

const PAGES_OPT = { key: "pages", label: "Pages", type: "text", default: "all", placeholder: "all, or e.g. 1-3, 5, 8-" };

// ===========================================================================
// ORGANIZE
// ===========================================================================

async function merge(files, opts, ctx) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    ctx.progress(i / files.length, `Adding ${files[i].name}`);
    const f = files[i];
    if (/^image\//.test(f.type)) {
      await addImagePage(doc, f, { size: "fit", margin: 0 });
      continue;
    }
    const src = await loadPdf(await readBytes(f));
    const pages = await doc.copyPages(src, src.getPageIndices());
    pages.forEach((p) => doc.addPage(p));
  }
  return [out("merged.pdf", await save(doc))];
}

async function copyInto(src, indices) {
  const doc = await PDFDocument.create();
  (await doc.copyPages(src, indices)).forEach((p) => doc.addPage(p));
  return doc;
}

async function split(file, opts, ctx) {
  const src = await loadPdf(await readBytes(file));
  const n = src.getPageCount();
  const base = baseName(file.name);
  let groups = [];
  if (opts.mode === "ranges") {
    groups = String(opts.ranges).split(/[,;]+/).map((r) => r.trim()).filter(Boolean)
      .map((r) => ({ label: r.replace(/\s+/g, ""), pages: parseRanges(r, n) }));
    if (!groups.length) throw new Error("Enter at least one range, e.g. 1-3, 4-6");
  } else if (opts.mode === "every") {
    const k = Math.max(1, opts.every | 0);
    for (let i = 0; i < n; i += k) {
      const pages = [...Array(Math.min(k, n - i)).keys()].map((j) => i + j);
      groups.push({ label: pages.length > 1 ? `${i + 1}-${i + pages.length}` : `${i + 1}`, pages });
    }
  } else if (opts.mode === "size") {
    // greedy: add pages until the estimated size passes the limit
    const limit = Math.max(0.05, +opts.maxMb) * 1024 * 1024;
    let cur = [];
    for (let i = 0; i < n; i++) {
      ctx.progress(i / n, `Measuring page ${i + 1}`);
      const trial = [...cur, i];
      const size = (await save(await copyInto(src, trial))).length;
      if (size > limit && cur.length) {
        groups.push({ pages: cur });
        cur = [i];
      } else cur = trial;
    }
    if (cur.length) groups.push({ pages: cur });
    groups.forEach((g) => (g.label = g.pages.length > 1 ? `${g.pages[0] + 1}-${g.pages.at(-1) + 1}` : `${g.pages[0] + 1}`));
  } else {
    for (let i = 0; i < n; i++) groups.push({ label: String(i + 1), pages: [i] });
  }
  const outs = [];
  for (let i = 0; i < groups.length; i++) {
    ctx.progress(i / groups.length, `Writing part ${i + 1} of ${groups.length}`);
    const doc = await copyInto(src, groups[i].pages);
    outs.push(out(`${base}_${groups[i].label}.pdf`, await save(doc)));
  }
  return outs;
}

async function removePages(bytes, opts) {
  const src = await loadPdf(bytes);
  const drop = new Set(parseRanges(opts.pages, src.getPageCount()));
  if (drop.size >= src.getPageCount()) throw new Error("That would remove every page.");
  [...drop].sort((a, b) => b - a).forEach((i) => src.removePage(i));
  return save(src);
}

async function extractPages(bytes, opts) {
  const src = await loadPdf(bytes);
  return save(await copyInto(src, parseRanges(opts.pages, src.getPageCount())));
}

// ===========================================================================
// OPTIMIZE
// ===========================================================================

const COMPRESS_LEVELS = {
  low: { maxPx: 2600, quality: 0.85, minPixels: 600 * 600 },
  recommended: { maxPx: 1700, quality: 0.72, minPixels: 300 * 300 },
  extreme: { maxPx: 1100, quality: 0.5, minPixels: 150 * 150 },
};

function colorComponents(doc, cs) {
  const c = cs instanceof PDFLib.PDFRef ? doc.context.lookup(cs) : cs;
  if (c === PDFName.of("DeviceRGB") || c === PDFName.of("CalRGB")) return 3;
  if (c === PDFName.of("DeviceGray") || c === PDFName.of("CalGray")) return 1;
  if (c instanceof PDFArray) {
    const kind = c.lookup(0);
    if (kind === PDFName.of("ICCBased")) {
      const n = c.lookup(1).dict.lookup(PDFName.of("N"));
      return n ? n.asNumber() : 0;
    }
    if (kind === PDFName.of("CalRGB")) return 3;
    if (kind === PDFName.of("CalGray")) return 1;
  }
  return 0; // CMYK / Indexed / Lab / Separation: leave alone
}

/** Undo PNG (10-15) or TIFF (2) predictors on decoded Flate image data. */
function unpredict(data, parms, width, colors, bpc) {
  const pred = parms ? (parms.lookup(PDFName.of("Predictor"))?.asNumber() ?? 1) : 1;
  if (pred < 2) return data;
  const cols = parms.lookup(PDFName.of("Columns"))?.asNumber() ?? width;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((cols * colors * bpc) / 8);
  if (pred === 2) {
    if (bpc !== 8) throw new Error("tiff predictor");
    const outData = new Uint8Array(data);
    for (let r = 0; r * rowBytes < outData.length; r++)
      for (let i = r * rowBytes + bpp; i < (r + 1) * rowBytes; i++) outData[i] = (outData[i] + outData[i - bpp]) & 255;
    return outData;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const res = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const inOff = r * (rowBytes + 1) + 1, o = r * rowBytes, p = o - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[inOff + i];
      const a = i >= bpp ? res[o + i - bpp] : 0;
      const b = r ? res[p + i] : 0;
      const c = r && i >= bpp ? res[p + i - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("bad png filter");
      }
      res[o + i] = v & 255;
    }
  }
  return res;
}

async function recompressImage(doc, ref, stream, level) {
  const dict = stream.dict;
  if (dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Image")) return false;
  if (dict.lookup(PDFName.of("ImageMask")) || dict.lookup(PDFName.of("Decode"))) return false;
  const w = dict.lookup(PDFName.of("Width"))?.asNumber(), h = dict.lookup(PDFName.of("Height"))?.asNumber();
  if (!w || !h || w * h < level.minPixels) return false;
  const comps = colorComponents(doc, dict.get(PDFName.of("ColorSpace")));
  if (comps !== 1 && comps !== 3) return false;
  const bpc = dict.lookup(PDFName.of("BitsPerComponent"))?.asNumber() ?? 8;
  const f = dict.lookup(PDFName.of("Filter"));
  const filters = f instanceof PDFArray ? f.asArray().map((x) => doc.context.lookup(x)) : f ? [f] : [];
  const generic = new Set(["FlateDecode", "ASCII85Decode", "ASCIIHexDecode", "LZWDecode", "RunLengthDecode"].map((n) => PDFName.of(n)));
  const isJpeg = filters.at(-1) === PDFName.of("DCTDecode");
  if (!filters.slice(0, isJpeg ? -1 : undefined).every((x) => generic.has(x))) return false;

  let bitmap;
  if (isJpeg) {
    let jpeg = stream.contents;
    if (filters.length > 1) {
      // undo the wrapper filters (e.g. ASCII85) to get at the JPEG bytes
      const tmp = dict.clone(doc.context);
      tmp.set(PDFName.of("Filter"), doc.context.obj(filters.slice(0, -1)));
      tmp.delete(PDFName.of("DecodeParms"));
      try { jpeg = decodePDFRawStream(PDFRawStream.of(tmp, stream.contents)).decode(); } catch { return false; }
    }
    try { bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" })); } catch { return false; }
  } else if (filters.length && bpc === 8) {
    let raw;
    try {
      raw = decodePDFRawStream(stream).decode();
      let parms = dict.lookup(PDFName.of("DecodeParms"));
      if (parms instanceof PDFArray) parms = parms.lookup(filters.indexOf(PDFName.of("FlateDecode")));
      raw = unpredict(raw, parms instanceof PDFDict ? parms : null, w, comps, 8);
    } catch { return false; }
    if (raw.length < w * h * comps) return false;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += comps) {
      rgba[i * 4] = raw[j];
      rgba[i * 4 + 1] = raw[j + (comps === 3 ? 1 : 0)];
      rgba[i * 4 + 2] = raw[j + (comps === 3 ? 2 : 0)];
      rgba[i * 4 + 3] = 255;
    }
    bitmap = await createImageBitmap(new ImageData(rgba, w, h));
  } else return false;

  const s = Math.min(1, level.maxPx / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const canvas = document.createElement("canvas");
  canvas.width = nw; canvas.height = nh;
  const cx = canvas.getContext("2d");
  cx.imageSmoothingQuality = "high";
  cx.drawImage(bitmap, 0, 0, nw, nh);
  bitmap.close?.();
  const jpg = await canvasBytes(canvas, "image/jpeg", level.quality);
  if (jpg.length >= stream.contents.length * 0.9) return false;

  const nd = dict.clone(doc.context);
  nd.set(PDFName.of("Width"), PDFNumber.of(nw));
  nd.set(PDFName.of("Height"), PDFNumber.of(nh));
  nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
  nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
  nd.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
  nd.set(PDFName.of("Length"), PDFNumber.of(jpg.length));
  nd.delete(PDFName.of("DecodeParms"));
  doc.context.assign(ref, PDFRawStream.of(nd, jpg));
  return true;
}

async function compress(bytes, opts, ctx) {
  const level = COMPRESS_LEVELS[opts.level] || COMPRESS_LEVELS.recommended;
  if (opts.rasterize) {
    const dpi = { low: 150, recommended: 110, extreme: 80 }[opts.level] || 110;
    const r = await rasterizePdf(bytes, { dpi, quality: level.quality, grayscale: opts.grayscale }, ctx);
    return r.length < bytes.length ? r : bytes;
  }
  const doc = await loadPdf(bytes);
  const objs = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream);
  let done = 0, changed = 0;
  for (const [ref, obj] of objs) {
    if (++done % 5 === 0) ctx.progress(done / objs.length, `Optimizing images (${changed} recompressed)`);
    try { if (await recompressImage(doc, ref, obj, level)) changed++; } catch (e) { console.warn(e); }
  }
  if (opts.grayscale) await grayscaleImages(doc);
  if (opts.stripMeta) stripMetadata(doc);
  const res = await save(doc);
  // never hand back a bigger file
  return res.length < bytes.length ? res : bytes;
}

async function grayscaleImages(doc) {
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    let f = obj.dict.lookup(PDFName.of("Filter"));
    if (f instanceof PDFArray) f = f.size() === 1 ? f.lookup(0) : null;
    if (f !== PDFName.of("DCTDecode") || colorComponents(doc, obj.dict.get(PDFName.of("ColorSpace"))) !== 3) continue;
    try {
      const bmp = await createImageBitmap(new Blob([obj.contents], { type: "image/jpeg" }));
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      const cx = c.getContext("2d");
      cx.filter = "grayscale(1)";
      cx.drawImage(bmp, 0, 0);
      const jpg = await canvasBytes(c, "image/jpeg", 0.8);
      const nd = obj.dict.clone(doc.context);
      nd.set(PDFName.of("Length"), PDFNumber.of(jpg.length));
      doc.context.assign(ref, PDFRawStream.of(nd, jpg));
    } catch {}
  }
}

function stripMetadata(doc) {
  doc.catalog.delete(PDFName.of("Metadata"));
  const info = doc.getInfoDict();
  for (const k of info.keys()) info.delete(k);
}

/** Every page → one JPEG image page (fonts, layers and hidden content gone). */
export async function rasterizePdf(bytes, { dpi = 150, quality = 0.85, grayscale = false, pages } = {}, ctx) {
  const pdf = await openPdfjs(bytes);
  const doc = await PDFDocument.create();
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      ctx?.progress((i - 1) / pdf.numPages, `Rendering page ${i} of ${pdf.numPages}`);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      if (pages && !pages.has(i - 1)) continue;
      const canvas = await renderPage(page, dpi / 72);
      if (grayscale) {
        const c2 = document.createElement("canvas");
        c2.width = canvas.width; c2.height = canvas.height;
        const cx = c2.getContext("2d");
        cx.filter = "grayscale(1)";
        cx.drawImage(canvas, 0, 0);
        canvas.getContext("2d").drawImage(c2, 0, 0);
      }
      const img = await doc.embedJpg(await canvasBytes(canvas, "image/jpeg", quality));
      const p = doc.addPage([vp.width, vp.height]);
      p.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
      page.cleanup();
    }
  } finally {
    pdf.destroy();
  }
  return save(doc);
}

async function repair(bytes, opts, ctx) {
  ctx.progress(0.1, "Rebuilding document structure");
  try {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
    if (src.isEncrypted) throw new PasswordError("This PDF is password-protected. Use “Unlock PDF” first.");
    const doc = await copyInto(src, src.getPageIndices());
    // keep the document info where it survived
    for (const k of ["Title", "Author", "Subject", "Keywords"]) {
      const v = src.getInfoDict().lookup(PDFName.of(k));
      if (v) doc.getInfoDict().set(PDFName.of(k), v);
    }
    const res = await save(doc);
    // verify the result renders before trusting it
    (await openPdfjs(res)).destroy();
    return res;
  } catch (e) {
    if (e instanceof PasswordError) throw e;
    console.warn("structural repair failed, falling back to re-rendering", e);
    ctx.progress(0.3, "Recovering pages by re-rendering");
    return rasterizePdf(bytes, { dpi: 150 }, ctx);
  }
}

// ---- OCR ------------------------------------------------------------------
export async function ocrPdf(bytes, opts, ctx) {
  const doc = await loadPdf(bytes);
  const pdf = await openPdfjs(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextRenderingMode,
    TextRenderingMode, rotateAndSkewTextDegreesAndTranslate, setCharacterSqueeze, showText } = PDFLib;
  const scale = (+opts.dpi || 300) / 72;
  let recognized = 0;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      if (opts.skipText !== false) {
        const tc = await page.getTextContent();
        if (tc.items.some((t) => t.str.trim())) continue; // already searchable
      }
      ctx.progress((i - 1) / pdf.numPages, `Recognizing text on page ${i} of ${pdf.numPages}`);
      const canvas = await renderPage(page, scale);
      const data = await ocrRecognize(canvas, opts.lang || "eng", (p) =>
        ctx.progress((i - 1 + p) / pdf.numPages, `Recognizing text on page ${i} of ${pdf.numPages}`));
      page.cleanup();
      const pdfPage = doc.getPage(i - 1);
      const v = visual(pdfPage);
      const k = canvas.width / v.width;
      const key = pdfPage.node.newFontDictionary(font.name, font.ref);
      const ops = [pushGraphicsState()];
      for (const w of data.words || []) {
        const text = winAnsiSafe(font, w.text.trim());
        if (!text || w.confidence < 20) continue;
        const { x0, y0, x1, y1 } = w.bbox;
        const size = Math.max(1, ((y1 - y0) / k) * 0.85);
        const width = (x1 - x0) / k;
        const natural = font.widthOfTextAtSize(text, size) || 1;
        const pt = v.map(x0 / k, v.height - y1 / k + size * 0.15);
        ops.push(beginText(), setFontAndSize(key, size), setTextRenderingMode(TextRenderingMode.Invisible),
          setCharacterSqueeze((width / natural) * 100),
          rotateAndSkewTextDegreesAndTranslate(v.rot, 0, 0, pt.x, pt.y),
          showText(font.encodeText(text)), endText());
      }
      ops.push(popGraphicsState());
      pdfPage.pushOperators(...ops);
      recognized++;
      await tick();
    }
  } finally {
    pdf.destroy();
  }
  if (!recognized) ctx.note?.("Every page already had selectable text, so nothing needed OCR. Untick “Skip pages that already have text” to force it.");
  return save(doc);
}

// ===========================================================================
// EDIT
// ===========================================================================

async function rotate(bytes, opts) {
  const doc = await loadPdf(bytes);
  const which = parseRanges(opts.pages, doc.getPageCount());
  for (const i of which) {
    const p = doc.getPage(i);
    p.setRotation(degrees((p.getRotation().angle + +opts.angle) % 360));
  }
  return save(doc);
}

const POSITIONS = [
  ["bc", "Bottom center"], ["br", "Bottom right"], ["bl", "Bottom left"],
  ["tc", "Top center"], ["tr", "Top right"], ["tl", "Top left"],
];

function anchorPoint(pos, v, w, h, margin) {
  const x = pos[1] === "l" ? margin : pos[1] === "r" ? v.width - margin - w : (v.width - w) / 2;
  const y = pos[0] === "b" ? margin : v.height - margin - h;
  return { x, y };
}

async function pageNumbers(bytes, opts) {
  const doc = await loadPdf(bytes);
  const font = await doc.embedFont(opts.font === "times" ? StandardFonts.TimesRoman : opts.font === "courier" ? StandardFonts.Courier : StandardFonts.Helvetica);
  const n = doc.getPageCount();
  const which = parseRanges(opts.pages, n);
  const size = +opts.size || 11;
  const color = hexToRgb(opts.color || "#000000");
  const margin = { small: 18, medium: 32, large: 54 }[opts.margin] ?? 32;
  which.forEach((idx, k) => {
    const num = (+opts.start || 1) + k;
    const total = (+opts.start || 1) + which.length - 1;
    const text = String(opts.format || "{n}").replace(/\{n\}/g, num).replace(/\{total\}/g, total).replace(/\{p\}/g, idx + 1);
    const page = doc.getPage(idx);
    const v = visual(page);
    let pos = opts.position;
    if (opts.mirror && k % 2 === 1) pos = pos.replace("l", "_").replace("r", "l").replace("_", "r");
    const w = font.widthOfTextAtSize(text, size);
    const a = anchorPoint(pos, v, w, size * 0.7, margin);
    const p = v.map(a.x, a.y);
    page.drawText(winAnsiSafe(font, text), { x: p.x, y: p.y, size, font, color, rotate: v.rotate });
  });
  return save(doc);
}

/** Move the content stream drawn last to the front so it sits under the page. */
function sendLastStreamToBack(page) {
  const contents = page.node.Contents();
  if (contents instanceof PDFArray && contents.size() > 1) {
    const last = contents.get(contents.size() - 1);
    contents.remove(contents.size() - 1);
    contents.insert(0, last);
  }
}

async function watermark(bytes, opts) {
  const doc = await loadPdf(bytes);
  const which = parseRanges(opts.pages, doc.getPageCount());
  const opacity = Math.min(1, Math.max(0.02, (+opts.opacity || 30) / 100));
  const angle = +opts.angle || 0;
  let font, image;
  if (opts.type === "image") {
    if (!opts.image) throw new Error("Choose a watermark image.");
    image = await embedAnyImage(doc, opts.image);
  } else {
    font = await doc.embedFont({ helvetica: StandardFonts.HelveticaBold, times: StandardFonts.TimesRomanBold, courier: StandardFonts.CourierBold }[opts.font] || StandardFonts.HelveticaBold);
  }
  const text = font ? winAnsiSafe(font, opts.text || "CONFIDENTIAL") : "";
  const rad = (angle * Math.PI) / 180;
  for (const idx of which) {
    const page = doc.getPage(idx);
    const v = visual(page);
    let w, h, size;
    if (font) {
      // auto size: span most of the page along the watermark's direction
      const reach = angle % 180 === 0 ? v.width : Math.abs(angle) % 180 === 90 ? v.height : Math.hypot(v.width, v.height) * 0.75;
      size = +opts.size || Math.min(140, (reach * 0.75) / Math.max(1, font.widthOfTextAtSize(text, 1)));
      w = font.widthOfTextAtSize(text, size);
      h = size * 0.7;
    } else {
      const s = ((+opts.imageScale || 40) / 100) * v.width / image.width;
      w = image.width * s; h = image.height * s;
    }
    const centers = [];
    if (opts.layout === "tile") {
      const gx = w * 1.6 + 40, gy = h * 4 + 60;
      for (let y = gy / 2; y < v.height + gy; y += gy)
        for (let x = (Math.round(y / gy) % 2 ? gx / 2 : 0); x < v.width + gx; x += gx) centers.push([x, y]);
    } else {
      const c = {
        center: [v.width / 2, v.height / 2], top: [v.width / 2, v.height - h - 40], bottom: [v.width / 2, h + 40],
      }[opts.layout] || [v.width / 2, v.height / 2];
      centers.push(c);
    }
    for (const [cx, cy] of centers) {
      // offset from center to the drawing origin, rotated by the watermark angle
      const ox = -w / 2, oy = -h / 2;
      const vx = cx + ox * Math.cos(rad) - oy * Math.sin(rad);
      const vy = cy + ox * Math.sin(rad) + oy * Math.cos(rad);
      const p = v.map(vx, vy);
      const r = degrees(v.rot + angle);
      if (font) page.drawText(text, { x: p.x, y: p.y, size, font, color: hexToRgb(opts.color || "#d32f2f"), opacity, rotate: r });
      else page.drawImage(image, { x: p.x, y: p.y, width: w, height: h, opacity, rotate: r });
    }
    if (opts.under) sendLastStreamToBack(page);
  }
  return save(doc);
}

export async function embedAnyImage(doc, file) {
  const bytes = await readBytes(file);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return doc.embedJpg(bytes);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return doc.embedPng(bytes);
  // anything else the browser can decode → PNG
  const bmp = await decodeImage(new Blob([bytes]));
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return doc.embedPng(await canvasBytes(c, "image/png"));
}

async function metadata(bytes, opts) {
  const doc = await loadPdf(bytes);
  if (opts.clear) stripMetadata(doc);
  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  if (opts.subject) doc.setSubject(opts.subject);
  if (opts.keywords) doc.setKeywords(opts.keywords.split(",").map((s) => s.trim()).filter(Boolean));
  if (opts.creator) doc.setCreator(opts.creator);
  if (opts.producer) doc.setProducer(opts.producer);
  doc.setModificationDate(new Date());
  return save(doc);
}

async function flatten(bytes) {
  const doc = await loadPdf(bytes);
  try { doc.getForm().flatten(); } catch (e) { console.warn(e); }
  return save(doc);
}

async function grayscale(bytes, opts, ctx) {
  return rasterizePdf(bytes, { dpi: +opts.dpi || 150, quality: 0.85, grayscale: true }, ctx);
}

// ===========================================================================
// SECURITY
// ===========================================================================

async function unlock(bytes, opts) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { password: opts.password || "", updateMetadata: false });
  } catch (e) {
    throw new Error(opts.password ? "Wrong password — the PDF could not be opened." : "This PDF needs its password to open. Enter it above.");
  }
  return doc.save({ useObjectStreams: true });
}

async function protect(bytes, opts) {
  if (!opts.userPassword && !opts.ownerPassword) throw new Error("Enter a password.");
  if (opts.confirm !== undefined && opts.userPassword !== opts.confirm) throw new Error("The passwords don't match.");
  const doc = await loadPdf(bytes);
  doc.encrypt({
    userPassword: opts.userPassword || "",
    ownerPassword: opts.ownerPassword || opts.userPassword || crypto.randomUUID(),
    permissions: {
      printing: opts.allowPrint ? "highResolution" : false,
      copying: !!opts.allowCopy,
      modifying: !!opts.allowModify,
      annotating: !!opts.allowModify,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: !!opts.allowModify,
    },
    algorithm: opts.algorithm || "AES-256",
  });
  return doc.save();
}

// ===========================================================================
// PDF/A (best effort)
// ===========================================================================

// minimal sRGB ICC profile (generated with LittleCMS), used as the OutputIntent
const SRGB_ICC_B64 =
  "AAACTGxjbXMEQAAAbW50clJHQiBYWVogB+oACgARAA0AHAAwYWNzcEFQUEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1sY21zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALZGVzYwAAAQgAAAA2Y3BydAAAAUAAAABMd3RwdAAAAYwAAAAUY2hhZAAAAaAAAAAsclhZWgAAAcwAAAAUYlhZWgAAAeAAAAAUZ1hZWgAAAfQAAAAUclRSQwAAAggAAAAgZ1RSQwAAAggAAAAgYlRSQwAAAggAAAAgY2hybQAAAigAAAAkbWx1YwAAAAAAAAABAAAADGVuVVMAAAAaAAAAHABzAFIARwBCACAAYgB1AGkAbAB0AC0AaQBuAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAADAAAAAcAE4AbwAgAGMAbwBwAHkAcgBpAGcAaAB0ACwAIAB1AHMAZQAgAGYAcgBlAGUAbAB5WFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDEIAAAXe///zJQAAB5MAAP2Q///7of///aIAAAPcAADAblhZWiAAAAAAAABvoAAAOPUAAAOQWFlaIAAAAAAAACSfAAAPhAAAtsNYWVogAAAAAAAAYpcAALeHAAAY2XBhcmEAAAAAAAMAAAACZmYAAPKnAAANWQAAE9AAAApbY2hybQAAAAAAAwAAAACj1wAAVHsAAEzNAACZmgAAJmYAAA9c";

function b64ToBytes(b64) {
  const s = atob(b64);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

const isoDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function toPdfA(bytes, opts, ctx) {
  const part = opts.level?.[0] || "2";
  const conf = "B";
  let srcBytes = bytes;
  if (opts.mode === "rasterize") srcBytes = await rasterizePdf(bytes, { dpi: +opts.dpi || 200, quality: 0.9 }, ctx);
  const doc = await loadPdf(srcBytes);
  const ctxObj = doc.context;
  const now = new Date();
  const title = doc.getTitle() || baseName(opts.__name || "Document");
  doc.setTitle(title);
  doc.setProducer("PDF Toolkit");
  doc.setCreator(doc.getCreator() || "PDF Toolkit");
  doc.setCreationDate(doc.getCreationDate() || now);
  doc.setModificationDate(now);

  // remove things PDF/A forbids
  const cat = doc.catalog;
  cat.delete(PDFName.of("OpenAction"));
  cat.delete(PDFName.of("AA"));
  const names = cat.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) { names.delete(PDFName.of("JavaScript")); names.delete(PDFName.of("EmbeddedFiles")); }
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("AA"));
    // transparency groups are not allowed in PDF/A-1
    if (part === "1") page.node.delete(PDFName.of("Group"));
  }

  // OutputIntent with an embedded sRGB profile
  const icc = ctxObj.flateStream(b64ToBytes(SRGB_ICC_B64), { N: 3 });
  const iccRef = ctxObj.register(icc);
  const intent = ctxObj.obj({
    Type: "OutputIntent", S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    DestOutputProfile: iccRef,
  });
  cat.set(PDFName.of("OutputIntents"), ctxObj.obj([ctxObj.register(intent)]));

  // XMP metadata declaring conformance (must match the Info dictionary)
  const created = doc.getCreationDate() || now;
  const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c]));
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>${part}</pdfaid:part>
   <pdfaid:conformance>${conf}</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>
   ${doc.getAuthor() ? `<dc:creator><rdf:Seq><rdf:li>${esc(doc.getAuthor())}</rdf:li></rdf:Seq></dc:creator>` : ""}
   <xmp:CreateDate>${isoDate(created)}</xmp:CreateDate>
   <xmp:ModifyDate>${isoDate(now)}</xmp:ModifyDate>
   <xmp:MetadataDate>${isoDate(now)}</xmp:MetadataDate>
   <xmp:CreatorTool>${esc(doc.getCreator())}</xmp:CreatorTool>
   <pdf:Producer>PDF Toolkit</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const meta = ctxObj.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" });
  cat.set(PDFName.of("Metadata"), ctxObj.register(meta));

  // file identifier
  const id = PDFHexString.of([...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""));
  ctxObj.trailerInfo.ID = ctxObj.obj([id, id]);

  // PDF/A-1 forbids object streams
  return doc.save({ useObjectStreams: part !== "1" });
}

// ===========================================================================
// IMAGES → PDF
// ===========================================================================

const SIZES = { a4: PageSizes.A4, letter: PageSizes.Letter, legal: PageSizes.Legal, a3: PageSizes.A3, a5: PageSizes.A5 };

export async function addImagePage(doc, file, { size = "fit", orientation = "auto", margin = 0, filter } = {}) {
  let img;
  if (filter && filter !== "none") {
    const bmp = await decodeImage(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext("2d");
    cx.filter = filter === "gray" ? "grayscale(1) contrast(1.15)" : filter === "bw" ? "grayscale(1) contrast(2.2) brightness(1.1)" : "contrast(1.25) saturate(1.1) brightness(1.05)";
    cx.drawImage(bmp, 0, 0);
    img = await doc.embedJpg(await canvasBytes(c, "image/jpeg", 0.88));
  } else img = await embedAnyImage(doc, file);
  let pw, ph;
  if (size === "fit") {
    pw = img.width * 0.75 + margin * 2; ph = img.height * 0.75 + margin * 2; // 96 dpi → pt
  } else {
    [pw, ph] = SIZES[size] || PageSizes.A4;
    const land = orientation === "landscape" || (orientation === "auto" && img.width > img.height);
    if (land) [pw, ph] = [ph, pw];
  }
  const page = doc.addPage([pw, ph]);
  const s = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height);
  const w = img.width * s, h = img.height * s;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return page;
}

async function imagesToPdf(files, opts, ctx) {
  const margin = { none: 0, small: 18, big: 40 }[opts.margin] ?? 0;
  const conf = { size: opts.size, orientation: opts.orientation, margin, filter: opts.filter };
  if (opts.merge === false) {
    const outs = [];
    for (let i = 0; i < files.length; i++) {
      ctx.progress(i / files.length, `Converting ${files[i].name}`);
      const doc = await PDFDocument.create();
      await addImagePage(doc, files[i], conf);
      outs.push(out(baseName(files[i].name) + ".pdf", await save(doc)));
    }
    return outs;
  }
  const doc = await PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    ctx.progress(i / files.length, `Adding ${files[i].name}`);
    await addImagePage(doc, files[i], conf);
  }
  let bytes = await save(doc);
  if (opts.ocr) bytes = await ocrPdf(bytes, { lang: opts.lang, dpi: 200, skipText: true }, ctx);
  return [out((files.length === 1 ? baseName(files[0].name) : opts.__scan ? "scan" : "images") + ".pdf", bytes)];
}

// ===========================================================================
// REGISTRY
// ===========================================================================

export const CATEGORIES = [
  ["organize", "Organize"], ["optimize", "Optimize"], ["to-pdf", "Convert to PDF"],
  ["from-pdf", "Convert from PDF"], ["edit", "Edit"], ["security", "Security"], ["advanced", "Advanced"],
];

const pdfOnly = { accept: ".pdf,application/pdf" };

export const TOOLS = [
  // ---- organize
  { id: "merge", cat: "organize", name: "Merge PDF", color: "#e5322d", glyph: "⊕",
    desc: "Combine PDFs (and images) in the order you want, with no file limit.",
    accept: ".pdf,application/pdf,image/*", multiple: true, min: 2, ordered: true, run: merge, verb: "Merge" },
  { id: "split", cat: "organize", name: "Split PDF", color: "#e5322d", glyph: "⊘",
    desc: "Split by page ranges, every N pages, by file size, or into single pages.",
    ...pdfOnly, batch: true, perFile: split, verb: "Split",
    options: [
      { key: "mode", label: "Split mode", type: "select", default: "ranges", choices: [["ranges", "Custom ranges"], ["every", "Every N pages"], ["size", "By maximum file size"], ["all", "Every page into its own PDF"]] },
      { key: "ranges", label: "Ranges (one PDF per range)", type: "text", default: "1-2, 3-", when: (o) => o.mode === "ranges", placeholder: "1-3, 4-6, 7-" },
      { key: "every", label: "Pages per file", type: "number", default: 1, min: 1, when: (o) => o.mode === "every" },
      { key: "maxMb", label: "Maximum size per file (MB)", type: "number", default: 5, min: 0.1, step: 0.1, when: (o) => o.mode === "size" },
    ] },
  { id: "remove", cat: "organize", name: "Remove pages", color: "#e5322d", glyph: "⌫",
    desc: "Delete the pages you don't need.", ...pdfOnly, batch: true, transform: removePages, suffix: "_removed", verb: "Remove pages",
    options: [{ ...PAGES_OPT, label: "Pages to remove", default: "1" }] },
  { id: "extract", cat: "organize", name: "Extract pages", color: "#e5322d", glyph: "⇱",
    desc: "Pull selected pages into a new PDF.", ...pdfOnly, batch: true, transform: extractPages, suffix: "_extract", verb: "Extract",
    options: [{ ...PAGES_OPT, label: "Pages to keep", default: "1" }] },
  { id: "organize", cat: "organize", name: "Organize PDF", color: "#e5322d", glyph: "▦",
    desc: "Drag to reorder, rotate, delete, duplicate or insert blank pages visually.", ...pdfOnly, interactive: "organize" },
  { id: "scan", cat: "organize", name: "Scan to PDF", color: "#e5322d", glyph: "⎙",
    desc: "Use your phone camera to capture documents, clean them up and make a searchable PDF.",
    accept: "image/*", capture: true, multiple: true, min: 1, ordered: true, verb: "Create PDF",
    run: (f, o, c) => imagesToPdf(f, { ...o, size: o.size, __scan: true }, c),
    options: [
      { key: "filter", label: "Enhance", type: "select", default: "doc", choices: [["doc", "Auto document"], ["gray", "Grayscale"], ["bw", "Black & white"], ["none", "Original color"]] },
      { key: "size", label: "Page size", type: "select", default: "a4", choices: [["a4", "A4"], ["letter", "US Letter"], ["fit", "Same as photo"]] },
      { key: "margin", type: "hidden", default: "none" },
      { key: "ocr", label: "Make text searchable (OCR)", type: "checkbox", default: false },
      { key: "lang", label: "Document language", type: "select", default: "eng", choices: OCR_LANGS, when: (o) => o.ocr },
    ] },

  // ---- optimize
  { id: "compress", cat: "optimize", name: "Compress PDF", color: "#3d9a42", glyph: "⇲",
    desc: "Shrink file size by recompressing images, without a size cap.", ...pdfOnly, batch: true, transform: compress, suffix: "_compressed", verb: "Compress",
    options: [
      { key: "level", label: "Compression level", type: "radio", default: "recommended", choices: [["low", "Less compression — high quality"], ["recommended", "Recommended — good quality, smaller"], ["extreme", "Extreme — smallest, lower quality"]] },
      { key: "grayscale", label: "Convert images to grayscale", type: "checkbox", default: false },
      { key: "rasterize", label: "Flatten every page to an image (best for scans; text becomes non-selectable)", type: "checkbox", default: false },
      { key: "stripMeta", label: "Remove metadata", type: "checkbox", default: false },
    ] },
  { id: "repair", cat: "optimize", name: "Repair PDF", color: "#3d9a42", glyph: "✚",
    desc: "Rebuild damaged or corrupt PDFs and recover what can be read.", ...pdfOnly, batch: true, transform: repair, suffix: "_repaired", verb: "Repair" },
  { id: "ocr", cat: "optimize", name: "OCR PDF", color: "#3d9a42", glyph: "⌕",
    desc: "Turn scanned PDFs into searchable, selectable text in 30+ languages.", ...pdfOnly, batch: true, transform: ocrPdf, suffix: "_ocr", verb: "Run OCR",
    options: [
      { key: "lang", label: "Document language", type: "select", default: "eng", choices: OCR_LANGS },
      { key: "dpi", label: "Scan resolution", type: "select", default: "300", choices: [["200", "200 dpi — faster"], ["300", "300 dpi — more accurate"]] },
      { key: "skipText", label: "Skip pages that already have text", type: "checkbox", default: true },
    ], note: "The OCR engine and language data are downloaded once on first use (a few MB)." },

  // ---- to PDF
  { id: "jpg-to-pdf", cat: "to-pdf", name: "JPG to PDF", color: "#f5a623", glyph: "▣",
    desc: "Convert JPG, PNG, WebP, GIF and other images to PDF.", accept: "image/*", multiple: true, min: 1, ordered: true, run: imagesToPdf, verb: "Convert",
    options: [
      { key: "size", label: "Page size", type: "select", default: "a4", choices: [["fit", "Same as image"], ["a4", "A4"], ["letter", "US Letter"], ["legal", "Legal"], ["a3", "A3"], ["a5", "A5"]] },
      { key: "orientation", label: "Orientation", type: "select", default: "auto", choices: [["auto", "Automatic"], ["portrait", "Portrait"], ["landscape", "Landscape"]], when: (o) => o.size !== "fit" },
      { key: "margin", label: "Margin", type: "select", default: "none", choices: [["none", "No margin"], ["small", "Small"], ["big", "Big"]] },
      { key: "merge", label: "Merge all images into one PDF", type: "checkbox", default: true },
    ] },
  { id: "word-to-pdf", cat: "to-pdf", name: "Word to PDF", color: "#2b579a", glyph: "W",
    desc: "Convert DOCX documents to PDF.", accept: ".docx", batch: true, perFile: convert.wordToPdf, verb: "Convert",
    options: [convert.PAPER_OPT] },
  { id: "ppt-to-pdf", cat: "to-pdf", name: "PowerPoint to PDF", color: "#d24726", glyph: "P",
    desc: "Convert PPTX slideshows to PDF.", accept: ".pptx", batch: true, perFile: convert.pptToPdf, verb: "Convert" },
  { id: "excel-to-pdf", cat: "to-pdf", name: "Excel to PDF", color: "#217346", glyph: "X",
    desc: "Convert XLSX, XLS, ODS and CSV spreadsheets to PDF.", accept: ".xlsx,.xls,.xlsm,.ods,.csv", batch: true, perFile: convert.excelToPdf, verb: "Convert",
    options: [{ ...convert.PAPER_OPT, default: "a4-landscape" }, { key: "gridlines", label: "Show gridlines", type: "checkbox", default: true }] },
  { id: "html-to-pdf", cat: "to-pdf", name: "HTML to PDF", color: "#f5a623", glyph: "</>",
    desc: "Convert HTML files, pasted HTML or a web address to PDF.", accept: ".html,.htm", batch: true, filesOptional: true,
    perFile: convert.htmlToPdf, run: convert.htmlSourceToPdf, verb: "Convert",
    options: [
      { key: "source", label: "Or paste HTML / a URL (used when no file is added)", type: "textarea", default: "", placeholder: "<h1>Hello</h1> or https://example.com" },
      convert.PAPER_OPT,
    ], note: "Web addresses can only be fetched when the site allows it (CORS). If it fails, save the page as .html and add the file." },

  // ---- from PDF
  { id: "pdf-to-jpg", cat: "from-pdf", name: "PDF to JPG", color: "#f5a623", glyph: "▤",
    desc: "Turn each page into an image, or extract all embedded images.", ...pdfOnly, batch: true, perFile: convert.pdfToImages, verb: "Convert",
    options: [
      { key: "mode", label: "Mode", type: "radio", default: "pages", choices: [["pages", "Page to image"], ["extract", "Extract images"]] },
      { key: "format", label: "Format", type: "select", default: "jpg", choices: [["jpg", "JPG"], ["png", "PNG"], ["webp", "WebP"]], when: (o) => o.mode === "pages" },
      { key: "dpi", label: "Resolution", type: "select", default: "150", choices: [["72", "72 dpi"], ["150", "150 dpi"], ["300", "300 dpi"], ["600", "600 dpi"]], when: (o) => o.mode === "pages" },
      { ...PAGES_OPT, when: (o) => o.mode === "pages" },
    ] },
  { id: "pdf-to-word", cat: "from-pdf", name: "PDF to Word", color: "#2b579a", glyph: "W",
    desc: "Convert PDF to an editable DOCX, with OCR for scanned pages.", ...pdfOnly, batch: true, perFile: convert.pdfToWord, verb: "Convert",
    options: [
      { key: "mode", label: "Output", type: "radio", default: "text", choices: [["text", "Editable text"], ["both", "Editable text + page images"], ["image", "Exact look (page images)"]] },
      { key: "ocr", label: "Use OCR on scanned pages", type: "checkbox", default: true, when: (o) => o.mode !== "image" },
      { key: "lang", label: "OCR language", type: "select", default: "eng", choices: OCR_LANGS, when: (o) => o.mode !== "image" && o.ocr },
    ] },
  { id: "pdf-to-ppt", cat: "from-pdf", name: "PDF to PowerPoint", color: "#d24726", glyph: "P",
    desc: "Turn every page into a PPTX slide.", ...pdfOnly, batch: true, perFile: convert.pdfToPpt, verb: "Convert",
    options: [{ key: "dpi", label: "Slide image quality", type: "select", default: "150", choices: [["100", "Standard"], ["150", "High"], ["220", "Very high"]] },
      { key: "notes", label: "Put the page text in the speaker notes", type: "checkbox", default: true }] },
  { id: "pdf-to-excel", cat: "from-pdf", name: "PDF to Excel", color: "#217346", glyph: "X",
    desc: "Pull tables out of PDFs into XLSX spreadsheets.", ...pdfOnly, batch: true, perFile: convert.pdfToExcel, verb: "Convert",
    options: [{ key: "sheets", label: "Layout", type: "select", default: "page", choices: [["page", "One sheet per page"], ["single", "Everything on one sheet"]] },
      { key: "ocr", label: "Use OCR on scanned pages", type: "checkbox", default: false },
      { key: "lang", label: "OCR language", type: "select", default: "eng", choices: OCR_LANGS, when: (o) => o.ocr }] },
  { id: "pdf-to-pdfa", cat: "from-pdf", name: "PDF to PDF/A", color: "#2c6ecb", glyph: "A",
    desc: "Convert to PDF/A for long-term archiving.", ...pdfOnly, batch: true, transform: toPdfA, suffix: "_pdfa", verb: "Convert",
    options: [
      { key: "level", label: "Conformance", type: "select", default: "2b", choices: [["1b", "PDF/A-1b"], ["2b", "PDF/A-2b"], ["3b", "PDF/A-3b"]] },
      { key: "mode", label: "Method", type: "radio", default: "preserve", choices: [["preserve", "Keep text and vectors (best effort)"], ["rasterize", "Rebuild pages as images (strictest)"]] },
      { key: "dpi", label: "Image resolution", type: "select", default: "200", choices: [["150", "150 dpi"], ["200", "200 dpi"], ["300", "300 dpi"]], when: (o) => o.mode === "rasterize" },
    ], note: "Adds the sRGB output intent, XMP conformance metadata and file ID, and removes JavaScript and embedded files. For legal archiving, check the result with a validator such as veraPDF." },
  { id: "pdf-to-text", cat: "from-pdf", name: "PDF to Text", color: "#6b7280", glyph: "T",
    desc: "Extract all text to a .txt file (OCR optional).", ...pdfOnly, batch: true, perFile: convert.pdfToText, verb: "Extract",
    options: [{ key: "ocr", label: "Use OCR on scanned pages", type: "checkbox", default: false },
      { key: "lang", label: "OCR language", type: "select", default: "eng", choices: OCR_LANGS, when: (o) => o.ocr }] },

  // ---- edit
  { id: "edit", cat: "edit", name: "Edit PDF", color: "#a347ba", glyph: "✎",
    desc: "Add text, images, shapes, highlights, white-out and freehand drawing.", ...pdfOnly, interactive: "edit" },
  { id: "rotate", cat: "edit", name: "Rotate PDF", color: "#a347ba", glyph: "↻",
    desc: "Rotate all or selected pages. Batch-rotate many PDFs at once.", ...pdfOnly, batch: true, transform: rotate, suffix: "_rotated", verb: "Rotate",
    options: [
      { key: "angle", label: "Rotation", type: "radio", default: "90", choices: [["90", "90° right"], ["180", "180°"], ["270", "90° left"]] },
      PAGES_OPT,
    ] },
  { id: "page-numbers", cat: "edit", name: "Add page numbers", color: "#a347ba", glyph: "#",
    desc: "Number pages with your choice of position, format and style.", ...pdfOnly, batch: true, transform: pageNumbers, suffix: "_numbered", verb: "Add numbers",
    options: [
      { key: "position", label: "Position", type: "select", default: "bc", choices: POSITIONS },
      { key: "mirror", label: "Mirror left/right on facing pages", type: "checkbox", default: false },
      { key: "format", label: "Text", type: "text", default: "{n}", help: "{n} = number, {total} = last number, {p} = physical page" },
      { key: "start", label: "First number", type: "number", default: 1 },
      PAGES_OPT,
      { key: "font", label: "Font", type: "select", default: "helvetica", choices: [["helvetica", "Helvetica"], ["times", "Times"], ["courier", "Courier"]] },
      { key: "size", label: "Font size", type: "number", default: 11, min: 4, max: 72 },
      { key: "color", label: "Color", type: "color", default: "#000000" },
      { key: "margin", label: "Margin", type: "select", default: "medium", choices: [["small", "Small"], ["medium", "Recommended"], ["large", "Large"]] },
    ] },
  { id: "watermark", cat: "edit", name: "Add watermark", color: "#a347ba", glyph: "≋",
    desc: "Stamp text or an image over or under your pages.", ...pdfOnly, batch: true, transform: watermark, suffix: "_watermarked", verb: "Add watermark",
    options: [
      { key: "type", label: "Watermark", type: "radio", default: "text", choices: [["text", "Text"], ["image", "Image"]] },
      { key: "text", label: "Text", type: "text", default: "CONFIDENTIAL", when: (o) => o.type === "text" },
      { key: "font", label: "Font", type: "select", default: "helvetica", choices: [["helvetica", "Helvetica"], ["times", "Times"], ["courier", "Courier"]], when: (o) => o.type === "text" },
      { key: "size", label: "Font size (blank = auto)", type: "number", default: "", min: 6, when: (o) => o.type === "text" },
      { key: "color", label: "Color", type: "color", default: "#d32f2f", when: (o) => o.type === "text" },
      { key: "image", label: "Image", type: "file", accept: "image/*", when: (o) => o.type === "image" },
      { key: "imageScale", label: "Image width (% of page)", type: "range", min: 5, max: 100, default: 40, when: (o) => o.type === "image" },
      { key: "layout", label: "Placement", type: "select", default: "center", choices: [["center", "Center"], ["top", "Top"], ["bottom", "Bottom"], ["tile", "Tiled (mosaic)"]] },
      { key: "angle", label: "Rotation", type: "select", default: "45", choices: [["0", "0°"], ["45", "45°"], ["90", "90°"], ["-45", "-45°"], ["180", "180°"]] },
      { key: "opacity", label: "Opacity %", type: "range", min: 5, max: 100, default: 30 },
      { key: "under", label: "Place under the page content", type: "checkbox", default: false },
      PAGES_OPT,
    ] },
  { id: "crop", cat: "edit", name: "Crop PDF", color: "#a347ba", glyph: "⌗",
    desc: "Trim margins or crop a region on one page or all pages.", ...pdfOnly, interactive: "crop" },
  { id: "forms", cat: "edit", name: "Fill & flatten forms", color: "#a347ba", glyph: "☑",
    desc: "Fill in PDF form fields and optionally lock them as plain content.", ...pdfOnly, interactive: "forms" },
  { id: "metadata", cat: "edit", name: "Edit metadata", color: "#a347ba", glyph: "ℹ",
    desc: "Change or remove title, author, subject and keywords.", ...pdfOnly, batch: true, transform: metadata, suffix: "", verb: "Save",
    options: [
      { key: "clear", label: "Remove all existing metadata first", type: "checkbox", default: false },
      { key: "title", label: "Title", type: "text", default: "" },
      { key: "author", label: "Author", type: "text", default: "" },
      { key: "subject", label: "Subject", type: "text", default: "" },
      { key: "keywords", label: "Keywords (comma separated)", type: "text", default: "" },
      { key: "creator", label: "Creator", type: "text", default: "" },
      { key: "producer", label: "Producer", type: "text", default: "" },
    ], note: "Blank fields keep their current values." },
  { id: "grayscale", cat: "edit", name: "Grayscale PDF", color: "#a347ba", glyph: "◐",
    desc: "Convert every page to black & white for cheaper printing.", ...pdfOnly, batch: true, transform: grayscale, suffix: "_gray", verb: "Convert",
    options: [{ key: "dpi", label: "Resolution", type: "select", default: "150", choices: [["110", "110 dpi"], ["150", "150 dpi"], ["220", "220 dpi"]] }] },

  // ---- security
  { id: "unlock", cat: "security", name: "Unlock PDF", color: "#1f6feb", glyph: "🔓",
    desc: "Remove the password and restrictions from PDFs you have the password for.", ...pdfOnly, batch: true, transform: unlock, suffix: "_unlocked", verb: "Unlock",
    options: [{ key: "password", label: "Password (leave blank if it opens without one)", type: "password", default: "" }] },
  { id: "protect", cat: "security", name: "Protect PDF", color: "#1f6feb", glyph: "🔒",
    desc: "Encrypt with AES-256 and control printing, copying and editing.", ...pdfOnly, batch: true, transform: protect, suffix: "_protected", verb: "Protect",
    options: [
      { key: "userPassword", label: "Password to open", type: "password", default: "" },
      { key: "confirm", label: "Repeat password", type: "password", default: "" },
      { key: "ownerPassword", label: "Permissions password (optional)", type: "password", default: "" },
      { key: "allowPrint", label: "Allow printing", type: "checkbox", default: true },
      { key: "allowCopy", label: "Allow copying text", type: "checkbox", default: true },
      { key: "allowModify", label: "Allow editing", type: "checkbox", default: false },
      { key: "algorithm", label: "Encryption", type: "select", default: "AES-256", choices: [["AES-256", "AES-256 (recommended)"], ["AES-128", "AES-128 (older readers)"]] },
    ] },
  { id: "sign", cat: "security", name: "Sign PDF", color: "#1f6feb", glyph: "✍",
    desc: "Draw, type or upload a signature, plus initials, date and text.", ...pdfOnly, interactive: "sign" },
  { id: "redact", cat: "security", name: "Redact PDF", color: "#1f6feb", glyph: "▮",
    desc: "Permanently black out text and areas, including search-and-redact.", ...pdfOnly, interactive: "redact" },
  { id: "compare", cat: "security", name: "Compare PDF", color: "#1f6feb", glyph: "⇆",
    desc: "Spot text changes and visual differences between two versions.", ...pdfOnly, interactive: "compare" },

  // ---- advanced
  { id: "workflow", cat: "advanced", name: "Workflows", color: "#111e3e", glyph: "⛓",
    desc: "Chain tools (e.g. OCR → compress → watermark → protect) and run them on many files.", ...pdfOnly, interactive: "workflow" },
  { id: "flatten", cat: "advanced", name: "Flatten PDF", color: "#111e3e", glyph: "▭",
    desc: "Turn form fields into regular page content.", ...pdfOnly, batch: true, transform: flatten, suffix: "_flat", verb: "Flatten" },
];

export const toolById = (id) => TOOLS.find((t) => t.id === id);
