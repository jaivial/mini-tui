/**
 * The WIRING of conditional GET in the web server, read from the source.
 *
 * WHY A SEPARATE FILE, and why it reads text instead of importing: `tests/web-etag.test.ts`
 * imports `src/web/etag`, so on a tree without that module the whole file dies on the import
 * and executes ZERO assertions. E23 recorded exactly that mistake ("si los importara caeria
 * entero sin ejecutar ni una asercion"). This file imports nothing from the fix, so on the
 * old tree it RUNS and FAILS on the assertion — which is the only thing that proves the rule
 * is applied rather than merely written down.
 *
 * WHAT IS BEING HELD (all measured on the deployed server on 2026-10-17; see log.md, E25):
 * `/api/skills` answered 200 with 36 412 B and no `ETag`, no `Cache-Control` and no
 * `Content-Encoding`, on every visit including every alt-tab back and every `$` typed — while
 * the server re-read 60 `SKILL.md` files (701 904 B) synchronously to rebuild a list that had
 * not moved, and `/api/task-graph` was fetched three times on one board open.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const serve = readFileSync(new URL("../src/web/serve.ts", import.meta.url), "utf8");

describe("the wiring in serve.ts, read from the source", () => {
  const serve = readFileSync(new URL("../src/web/serve.ts", import.meta.url), "utf8");

  test("every response passes through the conditional-GET wrapper", () => {
    // The choke point: `fetch` hands off to `handle` and wraps what comes back. A per-route
    // call would have to be repeated at each of the 102 `json(...)` sites, and the site that
    // matters is exactly the one somebody forgets.
    expect(serve).toMatch(/const response = await handle\(request, srv\)/);
    expect(serve).toMatch(/revalidate\(request, response\)/);
  });

  test("the wrapper decides on the request's own method and validator", () => {
    expect(serve).toMatch(/mayRevalidate\(request\.method/);
    expect(serve).toMatch(/isFresh\(request\.headers\.get\("if-none-match"\)/);
  });

  test("a 304 is an empty body, never a body with a 304 status", () => {
    // `new Response(null, ...)` — a 304 carrying a body is malformed and some clients will
    // wait for bytes that never come.
    expect(serve).toMatch(/new Response\(null, \{ status: 304/);
  });

  test("no route sets its own cache-control in a way that fights the validator", () => {
    // A `no-store` on a route this module wraps would be honoured (it is), which would
    // silently disable revalidation for that route. None is set today; if one ever is, it
    // should be a decision, not an accident.
    const noStoreOnApi = [...serve.matchAll(/json\([^)]*no-store[^)]*\)/g)];
    expect(noStoreOnApi).toEqual([]);
  });

  test("the streaming routes are untouched by it", () => {
    // `/api/stream` and the SSE queue feed answer as they arrive; the wrapper must skip
    // them on content type alone, and must not have been given a special case that could
    // drift. Both still declare their own no-transform cache-control.
    expect(serve).toMatch(/text\/event-stream/);
    // Exactly ONE call site (the import is not a call): a second one would be a per-route
    // exception, and exceptions are where this kind of rule leaks.
    expect([...serve.matchAll(/[^\w]mayRevalidate\(/g)]).toHaveLength(1);
  });
});
