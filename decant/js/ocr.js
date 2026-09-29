// Reading the IOCL automation screenshots in the browser (Tesseract.js).
//
// The screenshot is read twice, each time cleaned up differently:
//   values — grey-scaled, enlarged and contrast-stretched: the black figures
//            (volume, ullage, height …) come out most reliably this way;
//   labels — darkest-colour-channel, enlarged and thresholded: this also
//            catches the light-grey labels, the "Last Updated" time and the
//            green ONLINE, at the cost of a few misread digits.
// automation.js then combines both readings and checks them against each other
// and the dip chart. A photo of the screen (glare, blur, a tilt) that doesn't
// check out gets a closer look, card by card, and any "Last Updated" line not
// read gets one on its own (readAutomationPhoto). Everything runs on the phone;
// nothing is uploaded.

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
// full passes missed. Each band is cut out, enlarged and cleaned on its own:
// clean = 'stretch' (its own contrast), 'even' (the light evened out — a
// photo) or false (as it is).
export async function readRegions(file, regions, clean = 'stretch') {
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
      if (clean === 'even') evenLight(px.data, c.width, c.height, 2.5 * c.height);
      else stretchBand(px.data);
      ctx.putImageData(px, 0, 0);
    }
    const { data } = await worker.recognize(c, {}, { text: true });
    out.push(data.text || '');
  }
  return out;
}

// Even out the light across a photo of a screen (glare, a dark corner, the
// screen's own gradient): each pixel against the mean of its surroundings
// (`win` px square), so the page comes out white and the print dark wherever
// it is. Grey-scale, in place.
export function evenLight(data, w, h, win) {
  const lum = new Float32Array(w * h);
  for (let i = 0, k = 0; k < lum.length; i += 4, k++) lum[k] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  // summed-area table for the local means
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(4, Math.round(win / 2));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      const mean = sum / ((y1 - y0) * (x1 - x0)) || 1;
      const t = Math.min(1, Math.max(0, (lum[y * w + x] / mean - 0.5) / 0.42));
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(255 * t ** 1.3);
      data[i + 3] = 255;
    }
  }
  return data;
}

// A closer look at single cards (a photo of the screen reads better card by
// card): each is cut out from its "Last Updated" line to below its last
// figure, enlarged so the print is ~36 px tall, cleaned up and read again.
// Two clean-ups that misread different digits (tried on photos of the screen):
//   even   — the light evened out, read as sparse text;
//   stretch — the band's own contrast stretched, read as one block.
// frames: [{ci, x0, x1, figTop, figBottom, pitch}] (automation.js).
// Returns [{card, words, how}] for parseAutomation's `ocr.zoom`.
export async function readCards(file, frames, how = 'even', onProgress) {
  const out = [];
  if (!frames.length) return out;
  const img = await loadImage(file);
  const worker = await ocrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: how === 'even' ? '11' : '6', preserve_interword_spaces: '1' });
  for (const [i, f] of frames.entries()) {
    onProgress?.(i / frames.length);
    const x0 = Math.max(0, f.x0 - 0.02 * img.width);
    const x1 = Math.min(img.width, f.x1);
    const y0 = Math.max(0, f.figTop - 2.7 * f.pitch);
    const y1 = Math.min(img.height, f.figBottom + 0.9 * f.pitch);
    const w = x1 - x0;
    const h = y1 - y0;
    if (!(w > 20 && h > 20)) continue;
    const scale = Math.min(5, Math.max(1, 36 / (0.45 * f.pitch)), 2200 / w);
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, x0, y0, w, h, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height);
    if (how === 'even') evenLight(px.data, c.width, c.height, 2.2 * f.pitch * scale);
    else stretchBand(px.data);
    ctx.putImageData(px, 0, 0);
    const { data } = await worker.recognize(c, {}, { text: true, tsv: true });
    out.push({ card: f.ci, words: wordsFromTsv(data.tsv, 1), how });
  }
  return out;
}

// A card to look at closer: its stock not checked every way, its product
// height missing, or its time (or the time's date) not read. Density and
// temperature don't count.
const unsure = (t) => t.confidence !== 'high' || !t.timeFrom || t.timeFrom === 'clock' || !Number.isFinite(t.reading.height);

// The whole job for one screenshot: read it and find the tank cards; any card
// whose "Last Updated" time the two passes missed gets a closer look at that
// line, and — if a card is still unsure (the picture is a photo, not a clean
// screenshot) — every card a closer look.
// opts: {tanks, chart, dateOrder, now, onProgress}
export async function readAutomationPhoto(file, opts = {}) {
  const ocr = await readImage(file, (f, label) => opts.onProgress?.(f * 0.75, label));
  let parsed = parseAutomation(ocr, opts);
  // a time the whole picture's passes didn't read: its line on its own,
  // cleaned up one way after another until it reads with its date (each
  // reading joins the card's others — automation.js picks)
  let todo = parsed.tanks.filter((t) => t.timeFrom !== 'screen' && t.region).map((t) => t.region);
  if (todo.length) {
    opts.onProgress?.(0.76, 'Reading the time…');
    try {
      ocr.lines = [];
      for (const how of ['stretch', 'even', false]) {
        if (!todo.length) break;
        const texts = await readRegions(file, todo, how);
        todo.forEach((r, i) => ocr.lines.push({ card: r.ci, text: texts[i], how }));
        todo = todo.filter((r, i) => !readTime(texts[i], opts.dateOrder, opts.now));
      }
      parsed = parseAutomation(ocr, opts);
    } catch { /* the time is a nice-to-have */ }
  }
  // a card still unsure: look at every card closer, and at the ones still
  // unsure once more, cleaned up the other way (each reading counts as a vote)
  if (parsed.tanks.some(unsure)) {
    try {
      opts.onProgress?.(0.8, 'Looking closer at each tank…');
      ocr.zoom = await readCards(file, parsed.tanks.map((t) => t.frame).filter(Boolean), 'even', (f) => opts.onProgress?.(0.8 + 0.1 * f, 'Looking closer at each tank…'));
      parsed = parseAutomation(ocr, opts);
      const again = parsed.tanks.filter(unsure).map((t) => t.frame).filter(Boolean);
      if (again.length) {
        ocr.zoom = [...ocr.zoom, ...await readCards(file, again, 'stretch', (f) => opts.onProgress?.(0.9 + 0.1 * f, 'Looking closer at each tank…'))];
        parsed = parseAutomation(ocr, opts);
      }
    } catch { /* the reading so far stands */ }
  }
  opts.onProgress?.(1, 'Done');
  return { ...parsed, ms: ocr.ms, width: ocr.width, height: ocr.height, ...(opts.keepOcr ? { ocr } : {}) };
}
