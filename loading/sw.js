/* Tanker Loading — service worker (app-shell cache, offline-first) */
const CACHE = "vf-loading-v14";
// Cache storage is per-origin, not per-scope — the other Vriddhi apps (/app/,
// /pay/, /payments/, /tally/) keep their caches alongside ours. Only ever
// delete our own, so bumping this app's version can't wipe theirs.
const MINE = "vf-loading-";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith(MINE) && k !== CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ---- Web Push (loading alerts: started / full / sent for sale) ----
const ICON = "../Vriddhi%20Fuels%20Logo.png";
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: (e.data && e.data.text()) || "" }; }
  const title = d.title || "Tanker Loading";
  const data = { url: d.url || "./" };
  // Decoration must never cost us the message: some platforms reject the whole
  // notification when an icon or badge fails to load, and renotify is invalid
  // without a tag. Fall back to the plainest notification that can still show.
  const rich = { body: d.body || "", icon: ICON, badge: ICON, data: data };
  if (d.tag) { rich.tag = d.tag; rich.renotify = true; }
  e.waitUntil(
    self.registration.showNotification(title, rich)
      .catch(() => self.registration.showNotification(title, { body: d.body || "", data: data }))
      .catch(() => self.registration.showNotification(title))
  );
});

// Lets the page ask which worker is actually running, so a stale service
// worker can be told apart from a delivery failure.
self.addEventListener("message", (e) => {
  if (e.data && e.data.q === "version" && e.source) e.source.postMessage({ swVersion: CACHE });
});

// Tapping a notification focuses the already-open app rather than opening a
// second copy of it.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          if (w.navigate) { try { w.navigate(url); } catch (_) {} }
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Network-first for the shell (so updates land), cache fallback for offline.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("./index.html")))
  );
});
