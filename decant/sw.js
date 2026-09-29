// Service worker — app-shell cache. Network-first for the app's own files so
// updates land quickly (cache fallback keeps it working offline); the pinned
// CDN libraries (text reader, PDF reader, Supabase client) are cached on first
// use so reading a screenshot works without a signal later. Supabase data is
// never cached here — the app keeps its own copy.
const CACHE = "vriddhi-decant-v19";
const SHELL = [
  "./", "./index.html", "./config.js", "./manifest.webmanifest", "./icon.png",
  "./js/app.js", "./js/wizard.js", "./js/views.js", "./js/plan.js", "./js/tankers.js", "./js/shareimg.js", "./js/scene.js", "./js/store.js", "./js/core.js", "./js/ui.js",
  "./js/automation.js", "./js/ocr.js", "./js/invoice.js", "./js/report.js", "./js/charts.js", "./js/xlsx.js", "./js/archive.js", "./js/dipchart.js",
];
const CDN = ["cdn.jsdelivr.net", "esm.sh", "cdn.sheetjs.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co")) return;
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
