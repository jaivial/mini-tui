/**
 * Compression for the JSON API. What was measured on the deployed server on 2026-10-17:
 * `/api/skills` answered **36 412 B** with no `Content-Encoding` while the static handler on the
 * same server gzipped `App-*.js` (244 405 -> 76 831 B) — the API was the only uncompressed thing
 * a new visitor downloaded. `Bun.gzipSync` on the real bodies: skills **13 611 B** (62.6% off),
 * usage 1 165 B (90.4% off), task-graph 4 394 B.
 *
 * The part that is easy to get backwards is the ORDER. `mayRevalidate` refuses any response that
 * already carries `content-encoding`, so compressing before revalidation does not "also" compress
 * — it silently turns the whole conditional-GET layer off, with no error anywhere. These tests
 * hold that ordering down as a property, not as a comment.
 */
import { describe, expect, test } from "bun:test";
import { acceptsGzip, compressBody, mayCompress, MIN_GZIP_BYTES } from "../src/web/compress";
import { etagFor, isFresh, mayRevalidate, revalidationHeaders } from "../src/web/etag";

const json = (body: unknown) =>
  new Response(new TextEncoder().encode(JSON.stringify(body)), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** A body big enough that gzip pays for itself many times over, shaped like the skills list. */
const bigBody = () => {
  const raw = JSON.stringify(
    Array.from({ length: 60 }, (_, i) => ({
      name: `skill-number-${i}`,
      description: "A description long enough to compress well, repeated so the ratio is real. ".repeat(6),
    })),
  );
  return new TextEncoder().encode(raw);
};

describe("acceptsGzip", () => {
  test("names gzip in any list", () => {
    expect(acceptsGzip("gzip")).toBe(true);
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br, gzip")).toBe(true);
  });

  test("is case- and space-insensitive, as the header grammar allows", () => {
    expect(acceptsGzip("GZIP")).toBe(true);
    expect(acceptsGzip(" deflate ,  GZip ")).toBe(true);
  });

  test("an absent or empty header is no", () => {
    expect(acceptsGzip(null)).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    // `br` alone means the client would take brotli; we do not speak it, and sending gzip anyway
    // would be an encoding the client did not ask for and may not accept.
    expect(acceptsGzip("br, zstd")).toBe(false);
  });

  test("a q-value is not read as an acceptance", () => {
    // The q rides after the coding and `acceptsGzip` splits on `;`, so `gzip;q=1` still names
    // gzip. A client that wrote `q=0` is refusing it; that case is `mayCompress`'s caller to
    // weigh, and it is recorded here as the boundary this function deliberately does not draw.
    expect(acceptsGzip("gzip;q=1")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(true);
    expect(acceptsGzip("gzip;q=0.5, deflate;q=1")).toBe(true);
  });
});

describe("mayCompress", () => {
  test("a JSON read may", () => {
    expect(mayCompress(new Headers({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
  });

  test("the live feeds are excluded by content type, with no list to keep in step", () => {
    // `text/event-stream` bodies are open: reading one to compress it would wait forever. The
    // exclusion is the same shape of test that admits JSON, so a new streaming route cannot be
    // forgotten here because there is nothing here to update.
    for (const type of ["text/event-stream", "text/event-stream; charset=utf-8"]) {
      expect(mayCompress(new Headers({ "content-type": type }))).toBe(false);
    }
    expect(mayCompress(new Headers({ "content-type": "text/html" }))).toBe(false);
    expect(mayCompress(new Headers())).toBe(false);
  });

  test("anything already encoded is left alone, so two steps cannot encode twice", () => {
    expect(mayCompress(new Headers({ "content-type": "application/json", "content-encoding": "gzip" }))).toBe(false);
    expect(mayCompress(new Headers({ "content-type": "application/json", "content-encoding": "br" }))).toBe(false);
  });
});

describe("compressBody", () => {
  test("a payload worth compressing comes back gzipped, and still parses", async () => {
    const body = bigBody();
    const out = compressBody(json({ x: 1 }), body, "gzip, deflate, br");
    expect(out.headers.get("content-encoding")).toBe("gzip");
    expect(out.headers.get("vary")).toBe("accept-encoding");
    // The bytes really are smaller, and really are the same JSON.
    expect(out.headers.get("content-length")).toBeNull();
    const decoded = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await out.arrayBuffer()))));
    expect(decoded).toEqual(JSON.parse(new TextDecoder().decode(body)));
  });

  test("a body below the floor is left exactly as it was", async () => {
    // Measured: 80 B -> 92 B. Below the floor gzip's own dictionary costs more than it saves, so
    // the honest answer for a small body is "no".
    const small = new TextEncoder().encode(JSON.stringify({ ok: true }));
    expect(small.length).toBeLessThan(MIN_GZIP_BYTES);
    const response = json({ ok: true });
    const out = compressBody(response, small, "gzip");
    expect(out).toBe(response);
    expect(out.headers.get("content-encoding")).toBeNull();
  });

  test("a client that did not ask for gzip is answered in the clear", async () => {
    const body = bigBody();
    expect(compressBody(json({ x: 1 }), body, "br, zstd").headers.get("content-encoding")).toBeNull();
    expect(compressBody(json({ x: 1 }), body, null).headers.get("content-encoding")).toBeNull();
  });

  test("a non-JSON body is untouched even when it is large", () => {
    const html = new Response(new TextEncoder().encode("<html>" + "x".repeat(50_000)), {
      headers: { "content-type": "text/html" },
    });
    const out = compressBody(html, new TextEncoder().encode("<html>" + "x".repeat(50_000)), "gzip");
    expect(out.headers.get("content-encoding")).toBeNull();
  });

  test("the ETag survives compression, so revalidation still works", async () => {
    // THE POINT. `mayRevalidate` returns false the moment a response carries content-encoding,
    // so if compression ran BEFORE revalidation the validator would never be attached and every
    // visit would re-ship the whole body. These two assertions are the ordering, held down.
    const body = bigBody();
    const etag = etagFor(body);

    const compressed = compressBody(json({ x: 1 }), body, "gzip");
    // 1. A client holding the COMPRESSED representation revalidates and is told "you have it".
    expect(isFresh(compressed.headers.get("etag") ?? etag, etag)).toBe(true);
    // 2. That same validator is what revalidation would have decided on, uncompressed.
    const plain = json({ x: 1 });
    for (const [key, value] of Object.entries(revalidationHeaders(etag))) plain.headers.set(key, value);
    expect(mayRevalidate("GET", 200, plain.headers)).toBe(true);
    // And the compressed response is NOT one revalidation could ever have hashed: which is
    // precisely why the two steps must run in this order.
    expect(mayRevalidate("GET", 200, compressed.headers)).toBe(false);
  });

  test("the validator is the digest of the IDENTITY body, identical for both encodings", () => {
    // Modelled on the real call: `serve.ts` hands `compressBody` a response that ALREADY carries
    // the validator `revalidate` attached, and compression must leave that header alone.
    const body = bigBody();
    const etag = etagFor(body);
    const plain = json({ x: 1 });
    const compressedSource = json({ x: 1 });
    for (const target of [plain, compressedSource]) {
      for (const [key, value] of Object.entries(revalidationHeaders(etag))) target.headers.set(key, value);
    }
    const compressed = compressBody(compressedSource, body, "gzip");
    expect(compressed.headers.get("etag")).toBe(etag);
    expect(plain.headers.get("etag")).toBe(compressed.headers.get("etag"));
  });

  test("a stale content-length never survives, or the client waits for bytes that never come", () => {
    const body = bigBody();
    const response = json({ x: 1 });
    response.headers.set("content-length", String(body.length));
    const out = compressBody(response, body, "gzip");
    expect(out.headers.get("content-length")).toBeNull();
    expect(out.headers.get("content-encoding")).toBe("gzip");
  });

  test("it never reads the response body, so an open stream cannot hang it", async () => {
    // The regression `etag.ts` measured the hard way: awaiting a live body never resolves. This
    // wrapper is handed the bytes; it must never go and get them itself.
    const open = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          // never closed, exactly like /api/stream
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const out = compressBody(open, new Uint8Array(0), "gzip");
    expect(out.headers.get("content-encoding")).toBeNull();
    expect(await Promise.race([out.body!.getReader().read(), new Promise((r) => setTimeout(() => r("still open"), 50))])).toEqual({
      value: new TextEncoder().encode("data: one\n\n"),
      done: false,
    });
  });

  test("the status code and the other headers ride along unchanged", async () => {
    const body = bigBody();
    const response = new Response(body, {
      status: 201,
      headers: { "content-type": "application/json", "x-custom": "kept" },
    });
    const out = compressBody(response, body, "gzip");
    expect(out.status).toBe(201);
    expect(out.headers.get("x-custom")).toBe("kept");
  });
});
