/* Tanker Loading — service worker (app-shell cache, offline-first) */
const CACHE = "vf-loading-v12";
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
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Tanker Loading", {
    body: d.body || "",
    icon: "../Vriddhi%20Fuels%20Logo.png",
    badge: "../Vriddhi%20Fuels%20Logo.png",
    tag: d.tag,
    renotify: !!d.tag,
    data: { url: d.url || "./" },
  }));
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
