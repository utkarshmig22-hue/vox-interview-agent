// Minimal service worker — caches the shell so the page loads instantly on
// repeat visits, but always tries network for API calls (which need fresh
// data from Claude / Whisper / etc).

const CACHE = "vox-shell-v2";
const SHELL = ["/", "/static/style.css", "/static/app.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API calls or audio
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/share/")) return;
  // Cache-first for the shell, network fallback
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      // Only cache successful same-origin GETs
      if (e.request.method === "GET" && res.ok && url.origin === self.location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match("/")))
  );
});
