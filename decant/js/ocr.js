// Reading the IOCL automation screenshots in the browser (Tesseract.js).
//
// The screenshot is read twice, each time cleaned up differently:
//   values — grey-scaled, enlarged and contrast-stretched: the black figures
//            (volume, ullage, height …) come out most reliably this way;
//   labels — darkest-colour-channel, enlarged and thresholded: this also
//            catches the light-grey labels, the "Last Updated" time and the
//            green ONLINE, at the cost of a few misread digits.
// automation.js then combines both readings and checks them against each other
// and the dip chart. Everything runs on the phone; nothing is uploaded.

import { parseAutomation, readTime } from './automation.js';

const TESSERACT = {
  script: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js',
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
  langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
};

let workerPromise = null;
let progressFn = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) && window.Tesseract) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Couldn\'t load the text reader. Check the internet connection and try again.'));
    document.head.append(s);
  });
}

// One worker for the whole session (the language data is ~3 MB, fetched once
// and then cached by the browser).
export function ocrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT.script);
      const worker = await window.Tesseract.createWorker('eng', 1, {
        workerPath: TESSERACT.workerPath,
        corePath: TESSERACT.corePath,
        langPath: TESSERACT.langPath,
        logger: (m) => progressFn?.(m),
      });
      return worker;
    })().catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

export async function loadImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawScaled(img, scale) {
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

// The page's background level: the bright end of the darkest-channel values
// (white on a screenshot, grey-ish on a photo of a screen).
export function backgroundLevel(data) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    hist[Math.min(data[i], data[i + 1], data[i + 2])] += 1;
    n += 1;
  }
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= n * 0.6) return v;
  }
  return 255;
}

// For a small band of faint text: stretch its own darkest ink to its own
// background, and let Tesseract binarise (a hard threshold breaks thin strokes).
export function stretchBand(data) {
  const lum = new Float32Array(data.length / 4);
  for (let i = 0, k = 0; i < data.length; i += 4, k++) lum[k] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.6)] - 8;
  for (let i = 0, k = 0; i < data.length; i += 4, k++) {
    const t = Math.min(1, Math.max(0, (lum[k] - lo) / Math.max(1, hi - lo)));
    data[i] = data[i + 1] = data[i + 2] = Math.round(255 * t ** 1.4);
    data[i + 3] = 255;
  }
  return data;
}

// Pixel clean-up for one pass (see the top of the file).
export function cleanPixels(data, mode) {
  // labels: anything clearly darker than the background turns black
  const cut = mode === 'labels' ? Math.min(225, backgroundLevel(data) - 30) : 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    let v;
    if (mode === 'labels') {
      v = Math.min(r, g, b) < cut ? 0 : 255;
    } else {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const t = Math.min(1, Math.max(0, (y - 60) / 165));
      v = Math.round(255 * t ** 1.6);
    }
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return data;
}

// Enlarge small screenshots (text ~12 px tall reads badly), shrink big photos.
export function ocrScale(width, height) {
  const side = Math.max(width, height);
  return Math.min(3, Math.max(0.6, 2600 / side));
}

// Tesseract's TSV output -> words with boxes, in original-image pixels.
export function wordsFromTsv(tsv, scale) {
  const words = [];
  for (const line of String(tsv || '').split('\n')) {
    const f = line.split('\t');
    if (f.length < 12 || f[0] !== '5') continue;
    const text = f.slice(11).join('\t').trim();
    if (!text) continue;
    const [left, top, width, height, conf] = f.slice(6, 11).map(Number);
    words.push({
      text,
      conf: Math.round(conf),
      x0: left / scale,
      y0: top / scale,
      x1: (left + width) / scale,
      y1: (top + height) / scale,
    });
  }
  return words;
}

// Read one image both ways. onProgress(fraction 0..1, label).
export async function readImage(file, onProgress) {
  const started = Date.now();
  const img = await loadImage(file);
  const scale = ocrScale(img.width, img.height);
  onProgress?.(0.02, 'Loading the text reader…');
  let stage = 0;
  progressFn = (m) => {
    if (m.status === 'recognizing text') onProgress?.(0.15 + 0.42 * (stage + (m.progress || 0)), 'Reading the screenshot…');
    else if (/load|initializ/i.test(m.status || '')) onProgress?.(0.02 + 0.12 * (m.progress || 0), 'Loading the text reader…');
  };
  const worker = await ocrWorker();
  const passes = [];
  for (const mode of ['values', 'labels']) {
    const canvas = drawScaled(img, scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
    cleanPixels(px.data, mode);
    ctx.putImageData(px, 0, 0);
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(canvas, {}, { text: true, tsv: true });
    passes.push({ mode, text: data.text, words: wordsFromTsv(data.tsv, scale) });
    stage += 1;
  }
  progressFn = null;
  onProgress?.(1, 'Done');
  return { width: img.width, height: img.height, passes, ms: Date.now() - started };
}

// The text of a few bands of the picture — the "Last Updated" lines the two
// full passes missed. Each band is cut out, enlarged and cleaned on its own.
export async function readRegions(file, regions, clean = true) {
  const out = [];
  if (!regions.length) return out;
  const img = await loadImage(file);
  const worker = await ocrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  for (const r of regions) {
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (!(w > 8 && h > 4)) { out.push(''); continue; }
    const scale = Math.min(4, Math.max(1, 1400 / w));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, r.x0, r.y0, w, h, 0, 0, c.width, c.height);
    if (clean) {
      const px = ctx.getImageData(0, 0, c.width, c.height);
      stretchBand(px.data);
      ctx.putImageData(px, 0, 0);
    }
    const { data } = await worker.recognize(c, {}, { text: true });
    out.push(data.text || '');
  }
  return out;
}

// A smaller JPEG of the screenshot to keep with the log (≈100–250 KB).
export async function compressImage(file, maxSide = 1600, quality = 0.72) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = drawScaled(img, scale);
  return c.toDataURL('image/jpeg', quality);
}

// The whole job for one screenshot: read it, find the tank cards, and give any
// card whose "Last Updated" time was missed a second, closer look.
// opts: {tanks, chart, dateOrder, now, onProgress}
export async function readAutomationPhoto(file, opts = {}) {
  const ocr = await readImage(file, (f, label) => opts.onProgress?.(f * 0.9, label));
  const parsed = parseAutomation(ocr, opts);
  const missing = parsed.tanks.filter((t) => !t.reading.readingAt && t.region);
  if (missing.length) {
    opts.onProgress?.(0.92, 'Reading the time…');
    try {
      const texts = await readRegions(file, missing.map((t) => t.region));
      missing.forEach((t, i) => { t.reading.readingAt = readTime(texts[i], opts.dateOrder, opts.now); });
      const still = missing.filter((t) => !t.reading.readingAt);
      if (still.length) {
        const raw = await readRegions(file, still.map((t) => t.region), false);
        still.forEach((t, i) => { t.reading.readingAt = readTime(raw[i], opts.dateOrder, opts.now); });
      }
    } catch { /* the time is a nice-to-have */ }
  }
  opts.onProgress?.(1, 'Done');
  return { ...parsed, ms: ocr.ms, width: ocr.width, height: ocr.height };
}
