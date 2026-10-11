// Turning the share pictures (share-svg.js) into files: JPEG, PDF, zip.
// The same helpers as the Ledger app's render.js, kept here so the two apps
// don't depend on each other. Browser only.

const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

function loadScript(src, ready) {
  if (ready()) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (ready() ? resolve(ready()) : reject(new Error(`${src} loaded without its library`)));
    s.onerror = () => reject(new Error(`Couldn't load ${new URL(src).hostname}. Check the internet connection.`));
    document.head.append(s);
  });
}

const dataUrlCache = new Map();
export async function toDataUrl(url) {
  if (!dataUrlCache.has(url)) {
    dataUrlCache.set(url, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.blob();
    }).then((b) => new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(b);
    })));
  }
  return dataUrlCache.get(url);
}

async function svgToJpeg(svg, size, scale) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  // an embedded font can finish loading just after decode(): give it a
  // moment, or the first picture can come out without its text
  if (svg.includes('@font-face')) await new Promise((r) => setTimeout(r, 150));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0807';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// one page as a JPEG Blob, `size` in pixels
export async function jpegFromSvg(svg, size) {
  const url = await svgToJpeg(svg, size, 1);
  return (await fetch(url)).blob();
}

// pages (same size) -> one PDF Blob; `pt` = the page in points
export async function pdfFromSvgs(svgs, size, pt) {
  const { jsPDF } = await loadScript(JSPDF, () => window.jspdf);
  const pdf = new jsPDF({ unit: 'pt', format: [pt.width, pt.height], orientation: 'portrait', compress: true });
  for (let i = 0; i < svgs.length; i++) {
    if (i) pdf.addPage([pt.width, pt.height], 'portrait');
    pdf.addImage(await svgToJpeg(svgs[i], size, 1.5), 'JPEG', 0, 0, pt.width, pt.height);
  }
  return pdf.output('blob');
}

export async function zipBlob(files) {
  const JSZip = await loadScript(JSZIP, () => window.JSZip);
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f);
  return zip.generateAsync({ type: 'blob' });
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The app's font, Sora, as data: URLs (a picture made from an SVG can't fetch
// anything). '' when offline: the phone's own sans-serif font.
const SORA_CSS = 'https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&display=block';
let fontPromise = null;
export function brandFontCss() {
  if (!fontPromise) {
    fontPromise = (async () => {
      try {
        const css = await (await fetch(SORA_CSS)).text();
        const blocks = css.split('/*').filter((b) => /^\s*latin(-ext)?\s*\*\//.test(b)).map((b) => b.slice(b.indexOf('*/') + 2));
        let out = blocks.join('\n');
        for (const url of new Set([...out.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))) {
          out = out.split(url).join(await toDataUrl(url));
        }
        return out;
      } catch {
        return '';
      }
    })();
  }
  return fontPromise;
}

// Hindi (the drivers' instructions): Noto Sans Devanagari's Devanagari
// letters as data: URLs; the Latin ones come from Sora. '' when offline: the
// phone's own Hindi font.
const DEVANAGARI_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;600;700;800&display=block';
let hindiPromise = null;
export function hindiFontCss() {
  if (!hindiPromise) {
    hindiPromise = (async () => {
      try {
        const css = await (await fetch(DEVANAGARI_CSS)).text();
        let out = css.split('/*').filter((b) => /^\s*devanagari\s*\*\//.test(b)).map((b) => b.slice(b.indexOf('*/') + 2)).join('\n');
        for (const url of new Set([...out.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]))) {
          out = out.split(url).join(await toDataUrl(url));
        }
        return out;
      } catch {
        return '';
      }
    })();
  }
  return hindiPromise;
}

// The bulker drawing's look lives in the page's stylesheet (.bk-…); a picture
// needs it inside. Its variables are given their dark-theme values (the
// pictures are always dark).
const VARS = { '--display': 'Sora, sans-serif', '--mono': '"IBM Plex Mono", ui-monospace, monospace', '--grid-zero': 'rgba(255,255,255,.28)' };
let bulkerCssText = null;
export function bulkerCss() {
  if (bulkerCssText != null) return bulkerCssText;
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }                      // another site's sheet
    for (const r of rules || []) {
      if (!r.selectorText || !/\.bk-|\.bulker/.test(r.selectorText) || /:root|data-theme|:hover/.test(r.selectorText)) continue;
      out.push(r.cssText);
    }
  }
  bulkerCssText = out.join('\n').replace(/var\((--[\w-]+)\)/g, (m, v) => VARS[v] || m);
  return bulkerCssText;
}

export const canShareFiles = (files) => {
  try { return !!(navigator.canShare && navigator.canShare({ files })); } catch { return false; }
};
