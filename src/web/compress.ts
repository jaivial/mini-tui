/**
 * Compression for the JSON API. The static handler has had a gzip memo for the whole life of the
 * server; the API route had none, so the two halves of the same server disagreed about whether
 * their bytes were worth shrinking.
 *
 * WHAT WAS MEASURED, against the deployed server on 2026-10-17 with `Bun.gzipSync` on the real
 * response bodies (not on a sample):
 *
 *   - `/api/skills`  answers **36 412 B**. gzip: **13 611 B**. 62.6% of a first visit's bytes.
 *   - `/api/usage`   answers **12 191 B**. gzip:  **1 165 B**. 90.4%.
 *   - `/api/task-graph` 11 951 B -> 4 394 B.  `/api/commands` 1 248 B -> 442 B.
 *   - `/api/settings` 457 B -> 243 B.
 *
 * These are the payloads, not the noise: the same server gzips `App-*.js` (244 405 -> 76 831 B)
 * thirty lines away from where it shipped 36 KB of plain English prose. A chat UI's own API
 * answers were the only uncompressed thing a new visitor downloaded.
 *
 * WHY THE ORDER IS THE WHOLE FIX
 *
 * `mayRevalidate()` (see `etag.ts`) returns false the moment a response carries
 * `content-encoding` — deliberately, so the wrapper never hashes an encoded body and cannot
 * mistake one representation for another. That makes the order load-bearing rather than
 * stylistic, and it is a trap that looks like a refactor:
 *
 *   gzip first, revalidate after  -> mayRevalidate() sees `content-encoding` and returns false,
 *                                    so NO validator is attached and NO 304 is ever reachable.
 *                                    Measured: `false`. E25's whole conditional-GET layer
 *                                    silently stops working, and nothing errors.
 *   revalidate first, gzip after  -> mayRevalidate() sees plain JSON: `true`. The ETag is the
 *                                    digest of the IDENTITY body, so the same validator answers
 *                                    for both encodings. Measured: `true`.
 *
 * So compression is a step that runs on the way OUT, after the body has been read and the
 * validator decided. `serve.ts` calls `revalidate()` and then hands its result here.
 *
 * WHY THE VALIDATOR STILL WORKS ACROSS ENCODINGS
 *
 * The ETag is the digest of the uncompressed body, never of the compressed one, so a client
 * that stored the gzipped representation and a client that stored the plain one send back the
 * SAME `If-None-Match` and both match. `isFresh()` already compares weakly (it drops the `W/`
 * prefix), which is what RFC 7232 §3.2 requires for GET. `Vary: accept-encoding` is declared by
 * `revalidationHeaders()` for the same reason, so a shared cache cannot hand one encoding to a
 * client that asked for the other.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not compress streams, and it does not compress small bodies. Both exclusions are
 * decided from the RESPONSE HEADERS and the request alone, never by reading a body that may not
 * end: `/api/stream` and the SSE queue feed answer as they arrive, and `await
 * response.arrayBuffer()` on one never resolves. `etag.ts` measured that failure the hard way —
 * those two routes answered 0 bytes where the build before it answered 59 and 62 — so this
 * module is built so that rule cannot be violated by accident: it never touches a body it has
 * not already been handed.
 *
 * Below the size floor gzip makes the response BIGGER, because the format carries its own
 * dictionary and header. Measured on synthetic JSON: 80 B -> 92 B (costs 12), and only from
 * ~159 B does it start paying. A 36 KB body that loses 62.6% is worth 0.48 ms of CPU; a
 * `{"ok":true}` that grows by 20 bytes is not worth anything at all.
 */

/** Below this, gzip's own header costs more than it saves. Measured: 80 B -> 92 B. */
export const MIN_GZIP_BYTES = 512;

/** `Accept-Encoding` names gzip at all (a list, possibly with q-values and other codings). */
export function acceptsGzip(acceptEncoding: string | null | undefined): boolean {
  if (!acceptEncoding) return false;
  // `gzip;q=0` is an explicit refusal, which is different from not naming it.
  return acceptEncoding
    .split(",")
    .map((part) => part.split(";")[0]!.trim().toLowerCase())
    .some((coding) => coding === "gzip");
}

/**
 * Whether a response may be compressed at all, decided from the request and the RESPONSE
 * HEADERS ALONE.
 *
 * The content-type test is what does the work: the live feeds are `text/event-stream`, so they
 * are excluded by the same shape of test that admits JSON, with no list of streaming routes to
 * keep in step with the code. `content-encoding` excludes anything already encoded, which is
 * also what keeps two steps from encoding the same body twice.
 *
 * `method` is not filtered on here, and deliberately: compression is a property of a response,
 * not of what the request was. A `POST` that answers a JSON body is just as compressible, and
 * the encoding rule belongs in one place rather than at the 102 call sites that produce bodies.
 */
export function mayCompress(headers: Headers): boolean {
  if (headers.get("content-encoding")) return false;
  return /^application\/json\b/i.test(headers.get("content-type") ?? "");
}

/**
 * Compress a response body when it is worth it, and say so in the headers.
 *
 * Returns the response UNCHANGED when the answer is no, so a caller can apply it without
 * branching: there is exactly one place in `serve.ts` that decides, and this is it.
 *
 * `body` is the IDENTITY bytes, already in hand from the revalidation step. Nothing here reads
 * `response.body()` — that is the rule that keeps the live feeds out of trouble, and it is why
 * the caller can hand over a `304` (no body at all) without a special case.
 *
 * A compressed response must NOT carry a stale `content-length` from the identity body: the
 * header would name 36 412 for a 13 611-byte payload and the client would wait for bytes that
 * are never coming. It is deleted explicitly rather than trusted to be absent.
 */
export function compressBody(
  response: Response,
  body: Uint8Array,
  acceptEncoding: string | null | undefined,
): Response {
  if (body.length < MIN_GZIP_BYTES) return response;
  if (!acceptsGzip(acceptEncoding)) return response;
  if (!mayCompress(response.headers)) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-encoding", "gzip");
  // The two encodings are different representations of the same resource; a shared cache that
  // did not know that could hand gzip to a client that cannot read it.
  headers.set("vary", "accept-encoding");
  // The ETag is the digest of the identity body (computed upstream), so it is left untouched:
  // it has to answer for both encodings or revalidation breaks on one of them.
  // The same `new Uint8Array(...)` the static handler's gzip memo uses: a parameter typed as a
  // plain `Uint8Array` is `Uint8Array<ArrayBufferLike>`, and `gzipSync` only takes one backed by
  // an `ArrayBuffer` under the current DOM lib. It copies a payload that is already in memory and
  // about to go to the socket.
  const encoded = Bun.gzipSync(new Uint8Array(body));
  return new Response(encoded as BodyInit, { status: response.status, headers });
}
