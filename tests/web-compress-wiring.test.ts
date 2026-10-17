/**
 * The WIRING of compression in the web server, read from the source.
 *
 * WHY A SEPARATE FILE, and why it reads text instead of importing: `tests/web-compress.test.ts`
 * imports `src/web/compress`, so on a tree without that module the whole file dies on the import
 * and executes ZERO assertions. E23 recorded exactly that mistake ("si los importara caeria
 * entero sin ejecutar ni asercion"). This file imports nothing from the fix, so on the old tree
 * it RUNS and FAILS — which is the only thing that proves the rule is applied rather than merely
 * written down.
 *
 * THE ASSERTION THAT MATTERS MOST is the ORDER. `mayRevalidate` refuses a response that already
 * carries `content-encoding`, so compressing inside or before `revalidate` does not merely add a
 * second step: it makes the conditional-GET layer answer false, attach no validator, and send a
 * full body on every visit — silently, with nothing failing. A test that only checked "is there
 * a call to compressBody somewhere" would pass against exactly the broken wiring.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const serve = readFileSync(new URL("../src/web/serve.ts", import.meta.url), "utf8");

describe("the wiring in serve.ts, read from the source", () => {
  test("compression is applied on the way out of the single response choke point", () => {
    expect(serve).toMatch(/const response = await handle\(request, srv\)/);
    expect(serve).toMatch(/compressBody\(validated, body, request\.headers\.get\("accept-encoding"\)\)/);
  });

  test("revalidate runs BEFORE compressBody, and that order is the fix", () => {
    // Measured: with this order `mayRevalidate("GET", 200, jsonHeaders)` is `true`; with the
    // other one it is `false` and every 304 becomes a full body again.
    const revalidateAt = serve.indexOf("await revalidate(request, response)");
    const compressAt = serve.indexOf("compressBody(validated");
    expect(revalidateAt).toBeGreaterThan(-1);
    expect(compressAt).toBeGreaterThan(-1);
    expect(revalidateAt).toBeLessThan(compressAt);
  });

  test("the body handed to the compressor is the one revalidation read, never a second read", () => {
    // A `Response` body cannot be read twice, and the live feeds must never be read at all.
    expect(serve).toMatch(/const \{ response: validated, body \} = await revalidate\(request, response\)/);
    expect(serve).toMatch(/body === null\s*\?\s*validated/);
  });

  test("revalidate now returns the identity body alongside the response", () => {
    expect(serve).toMatch(/Promise<\{ response: Response; body: Uint8Array \| null \}>/);
  });

  test("the 304 is still an empty body, and it carries no body to compress", () => {
    expect(serve).toMatch(/new Response\(null, \{ status: 304/);
    // A `304` that also handed back bytes would be malformed, and the compressor must not be
    // reachable for it: `body: null` on that branch is what keeps it that way.
    expect(serve).toMatch(/status: 304, headers: revalidationHeaders\(etag\) \}\), body: null/);
  });

  test("the module is imported once, from its own file", () => {
    expect([...serve.matchAll(/from "\.\/compress"/g)]).toHaveLength(1);
    expect([...serve.matchAll(/[^\w]compressBody\(/g)]).toHaveLength(1);
  });

  test("the static handler keeps its own gzip, and the API now has one too", () => {
    // Both halves of the server compress: the asset memo (immutable files, gzip once) and the
    // per-response API step (bodies that move, so gzip each time). Neither replaced the other.
    expect(serve).toMatch(/gzipCached\(/);
    expect(serve).toMatch(/"content-encoding": "gzip", vary: "accept-encoding"/);
  });
});
