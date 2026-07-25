// Bump VERSION on every change to app files so updates actually ship.
const VERSION = "rl-shared-v1";
const SHELL = [
  "./index.html", "./styles.css", "./app.js", "./firebase-config.js",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only the local app shell is cached. Firebase, gstatic, the Worker, etc. always hit the network.
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match("./index.html"))));
});
