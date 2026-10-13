// Service worker — app-shell cache. Network-first for the app's own files so
// updates land quickly (cache fallback keeps it working offline); the pinned
// CDN libraries (text reader, PDF reader, Supabase client) are cached on first
// use so reading a screenshot works without a signal later. Supabase data is
// never cached here — the app keeps its own copy.
const CACHE = "vriddhi-decant-v29";
// A screenshot shared to the app from Android's share sheet (the manifest's
// share_target) waits here until the app opens and takes it.
const SHARE = "vriddhi-decant-share";
const SHARED = "./shared-shot";
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
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Android's share sheet POSTs the picture to ./share-target: keep it and open
// the app, which reads it as a stock screenshot (app.js takeShared).
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const file = form.getAll("shot").find((f) => f && typeof f !== "string" && /^image\//.test(f.type || ""));
    if (file) {
      const c = await caches.open(SHARE);
      await c.put(SHARED, new Response(file, { headers: {
        "Content-Type": file.type, "X-Name": encodeURIComponent(file.name || "screenshot"), "X-Modified": String(file.lastModified || Date.now()),
      } }));
    }
  } catch { /* opens the app anyway */ }
  return Response.redirect("./?shared=1", 303);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method === "POST" && new URL(req.url).pathname.endsWith("/share-target")) {
    e.respondWith(receiveShare(req));
    return;
  }
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
