/**
 * The PWA's service worker: what makes the installed app an app.
 *
 * Four routes, by what the server already promises (src/web/serve.ts):
 *
 *   /api/*          never cached, never intercepted — the bot, the SSE stream and every write are
 *                   live; a cached answer would be a lie about the agent's state.
 *   navigations     network first, the cached shell only as the offline answer, so the app paints
 *                   even with no connection and its own reconnect banner (not a stale page) says
 *                   what is happening.
 *   /assets/*       cache first: Vite's bundles are content-hashed, so the bytes under a name never
 *                   change and a hit is always correct (and instant).
 *   everything else same-origin GET (icons, fonts, the manifest) stale-while-revalidate: show the
 *                   copy now, refresh it after.
 *
 * Two rules hold for every path below:
 *
 *   - A cache write never fails the request it rode in on. Storing is a side effect; the bytes the
 *     browser asked for are answered from the network (or from the copy on a miss), and a rejected
 *     `put` only costs the offline copy. Responding to a navigation with a rejected promise is a
 *     dead page — that exact bug is why the document's body is read once and turned into two
 *     independent Responses instead of a shared, teed one.
 *   - VERSION names the cache set. Bump it when this file or the build's public assets change and
 *     the old set is deleted on activate. A tab left open across a rebuild is already handled by
 *     the app's own stale-bundle reload (main.ts): a request for a bundle this cache no longer
 *     holds falls through to the server, 404s there, and the app reloads itself onto the new shell.
 */
const VERSION = "2026-10-21.2";
const SHELL_CACHE = `mini-tui-shell-${VERSION}`;
const ASSET_CACHE = `mini-tui-assets-${VERSION}`;
const PAGE_CACHE = `mini-tui-pages-${VERSION}`;
const CACHES = [SHELL_CACHE, ASSET_CACHE, PAGE_CACHE];

self.addEventListener("install", () => {
  // Take over as soon as it is fetched: the caches are versioned, so a page still running an older
  // build only ever loses an asset that no longer exists — which the app reloads itself for.
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set(CACHES);
      for (const name of await caches.keys()) if (!keep.has(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

/** Best-effort: a full body read for the cache copy. The caller still owns its own copy. */
async function storable(response) {
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" },
  });
}

/** Never rejects for a cache problem: only a network failure without a saved copy does. */
async function store(cache, key, response) {
  try {
    await cache.put(key, await storable(response));
  } catch (error) {
    console.error("[sw] cache put failed", key, error);
  }
}

async function networkFirstPage(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const fresh = await fetch(request);
    if (!fresh.ok) return fresh;
    // The document is read ONCE: the cache copy and the page's copy are two Responses over the
    // same bytes, never a clone of a response that is already on its way to becoming a document.
    const body = await fresh.arrayBuffer();
    const make = () =>
      new Response(body.slice(0), {
        status: fresh.status,
        headers: { "content-type": fresh.headers.get("content-type") ?? "text/html; charset=utf-8" },
      });
    await store(cache, "/", make());
    return make();
  } catch (error) {
    // Offline (or the server is gone): the shell this origin painted before is the page.
    const saved = await caches.match("/");
    if (saved) return saved;
    throw error;
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const fresh = await fetch(request);
  if (fresh.ok) await store(cache, request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const saved = await cache.match(request);
  if (saved) {
    // Show the copy now; the refresh is a side effect the fetch handler keeps the worker alive for.
    void fetch(request)
      .then((fresh) => (fresh.ok ? store(cache, request, fresh.clone()) : undefined))
      .catch(() => undefined);
    return saved;
  }
  const fresh = await fetch(request);
  if (fresh.ok) await store(cache, request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // a prompt, a rename, a logout: the network answers
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // anything else stays the browser's business
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(request));
  } else {
    // waitUntil is only legal while the event is dispatching, so it is called here — on the same
    // promise the response comes from — not from inside the async work.
    const work = staleWhileRevalidate(request);
    event.waitUntil(work.catch(() => undefined));
    event.respondWith(work);
  }
});
