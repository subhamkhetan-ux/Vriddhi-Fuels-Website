/* Only public shell files are cached; never cache financial/auth API responses. */
const CACHE = "vf-tally-v27";
const SHELL = ["./", "./index.html", "./config.js", "./billing.js", "./slips.js", "./theme.css", "./vendor/Sora-Variable.ttf", "./theme.js", "./bridge.css", "./bridge.js", "./report-export.js", "./manifest.webmanifest", "./icon.png", "./icon-maskable.png", "./apple-touch-icon.png"];
const shellURLs = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("vf-tally-") && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for the shell (so updates land), cache fallback for offline.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !shellURLs.has(e.request.url)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && res.type !== "opaque") {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
