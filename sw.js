/* Network-first service worker.
   Fresh code loads on every online launch — no reinstall, no version-bump ritual.
   Static assets (icons, css) fall back to cache when offline. */

const CACHE = "rl-shared";               // single rolling cache; no per-release bump needed
const OFFLINE_SHELL = ["./index.html", "./styles.css", "./icon-192.png", "./icon-512.png", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  // Pre-cache the shell so the app still opens offline, then take over immediately.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Let cross-origin (Firebase, gstatic, the Worker) go straight to the network, untouched.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // NETWORK-FIRST: always try the network; update the cache; fall back to cache only if offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});