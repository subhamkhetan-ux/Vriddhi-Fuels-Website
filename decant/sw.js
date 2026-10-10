// Service worker — app-shell cache. Network-first for the app's own files so
// updates land quickly (cache fallback keeps it working offline); the pinned
// CDN libraries (text reader, PDF reader, Supabase client) are cached on first
// use so reading a screenshot works without a signal later. Supabase data is
// never cached here — the app keeps its own copy.
const CACHE = "vriddhi-decant-v28";
const SHELL = [
  "./", "./index.html", "./config.js", "./manifest.webmanifest", "./icon.png",
  "./js/app.js", "./js/wizard.js", "./js/views.js", "./js/plan.js", "./js/tankers.js", "./js/shareimg.js", "./js/shots.js", "./js/theme.js", "./js/scene.js", "./js/worker.js", "./js/store.js", "./js/core.js", "./js/ui.js",
  "./js/automation.js", "./js/ocr.js", "./js/invoice.js", "./js/report.js", "./js/charts.js", "./js/xlsx.js", "./js/archive.js", "./js/dipchart.js",
];
const CDN = ["cdn.jsdelivr.net", "esm.sh", "cdn.sheetjs.com", "fonts.googleapis.com", "fonts.gstatic.com"];

// The app's own files always come from the server when there's a signal —
// past the browser's HTTP cache too (GitHub Pages lets it keep a file for 10
// minutes), so a phone opened just after an update doesn't run the old code.
// "no-cache" still lets an unchanged file come back as a small 304.
const fresh = (req) => (req.mode === "navigate"
  ? new Request(req.url, { cache: "no-cache", credentials: "same-origin" })
  : new Request(req, { cache: "no-cache" }));

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
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
    fetch(fresh(req)).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
