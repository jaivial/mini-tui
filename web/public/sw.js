/*
 * The offline shell. The app itself is a thin client over the session server: without the
 * network there is nothing to show, so the worker only promises that the shell loads instead
 * of the browser's error page. Navigations go network-first (a new build must win) and fall
 * back to the cached shell when the server cannot be reached; the hashed assets the shell
 * references are cached as they are seen. /api is never touched — it is either alive or the
 * app is showing its own connection state.
 */
const SHELL = "minitui-shell-v1";
const SHELL_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(SHELL_URL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") return;
  if (url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest") return;

  // Navigations: the network wins; the cached shell answers when it cannot.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL).then((cache) => cache.put(SHELL_URL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL_URL)),
    );
    return;
  }

  // Everything else (hashed bundles, fonts, icons): cache first, fill as seen.
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            void caches.open(SHELL).then((cache) => cache.put(event.request, copy));
          }
          return response;
        }),
    ),
  );
});
