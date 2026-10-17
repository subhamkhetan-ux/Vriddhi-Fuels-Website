/* PDF Toolkit — service worker: app shell precache + cache-as-you-go for the
   vendored libraries, so tools keep working offline once they've been used. */
const CACHE = "vf-pdf-v1";
// Cache storage is per-origin — the other Vriddhi apps keep caches alongside
// ours. Only ever delete our own.
const MINE = "vf-pdf-";
const SHELL = [
  "./", "./index.html", "./app.css", "./icon.svg", "./manifest.webmanifest",
  "./js/app.js", "./js/ui.js", "./js/lib.js", "./js/tools.js", "./js/convert.js",
  "./js/organize.js", "./js/editor.js", "./js/forms.js", "./js/compare.js", "./js/workflow.js",
  "./vendor/pdf-lib.esm.min.js", "./vendor/pdfjs/pdf.min.mjs", "./vendor/pdfjs/pdf.worker.min.mjs",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(MINE) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const ours = url.origin === location.origin && url.pathname.includes("/pdf/");
  // OCR engine + language data from the CDN: cache them too, so OCR works offline later
  const ocr = /tesseract|tessdata/.test(url.href);
  if (!ours && !ocr) return;
  const isCode = ours && /\.(html|js|css|webmanifest)$|\/$/.test(url.pathname) && !url.pathname.includes("/vendor/");
  if (isCode) {
    // network first for our own code, so updates show up
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // cache first for libraries, fonts, cmaps and OCR data
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
