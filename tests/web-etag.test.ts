/**
 * Conditional GET for the JSON API, as it is actually written.
 *
 * WHAT WAS MEASURED, against the DEPLOYED server on 2026-10-17 (Chrome 145 over CDP, the
 * bundle the 4317 process was serving at the time):
 *
 *   - `GET /api/skills` -> **200, 36 412 B**, and with `Accept-Encoding: gzip, br` the
 *     response came back with **no `Content-Encoding`** and the full 36 412 B on the wire.
 *     A hashed asset on the same server *is* gzipped (`App-…js` 244 405 -> 76 831 B), so
 *     the asset path had a gzip memo and the API path had nothing.
 *   - `GET /api/skills`, `/api/task-graph` and `/api/commands` carried **no `ETag`, no
 *     `Cache-Control`, no `Last-Modified`, no `Vary`**: nothing a browser could revalidate
 *     against, so every visit re-shipped the whole payload.
 *   - the client re-asks on a timer unrelated to whether anything changed. One page lifetime
 *     (load -> alt-tab away 6 s -> back -> type `$`) produced **2 `/api/skills` fetches,
 *     71.4 KB**, measured off `Network.loadingFinished`. `refreshSkills()` fires on every
 *     `visibilitychange` and on every `$` typed, and both go through `loadSkills(true)`,
 *     the forced path that skips the `skillsStatus === "ready"` early return.
 *   - answering it is not free: `skillList()` walks the skills folder and `readFileSync`s
 *     every `SKILL.md` — 60 files, **701 904 B** read per request, synchronously, on the
 *     one thread that also serves the terminal, the sockets and the channel mirror.
 *   - `/api/task-graph` (11 951 B **plus a `Bun.spawn` of the Rust binary**, median 2.3 ms,
 *     ~2.2 ms of CPU) had the same three missing headers, and the client asks for it
 *     **three times** on the first open of the task board (starts 5922 ms / 5949 ms /
 *     5964 ms — three overlapping `Bun.spawn`s).
 *
 * The rule under test is the one those measurements point at: a JSON read may be answered
 * in full or with a `304`, and never in full when the client already holds those bytes.
 *
 * These assertions read the module rather than a live server, because the defect is a
 * missing header and the proof that the wiring works is live (see log.md, E25).
 */
import { describe, expect, test } from "bun:test";
import { etagFor, isFresh, mayRevalidate, revalidationHeaders } from "../src/web/etag";

const jsonHeaders = (extra: Record<string, string> = {}): Headers =>
  new Headers({ "content-type": "application/json; charset=utf-8", ...extra });

describe("etagFor", () => {
  test("is stable for the same body, and different for a different one", () => {
    // The whole point: two visitors to an unmoved skills folder must produce the same
    // validator, and a skill added on disk must not.
    const a = etagFor('[{"name":"cu","description":"x"}]');
    const b = etagFor('[{"name":"cu","description":"x"}]');
    const c = etagFor('[{"name":"cu","description":"y"}]');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("accepts a string and the bytes it encodes to as the same body", () => {
    // `json()` stringifies, the wrapper re-reads the bytes: the two must not diverge.
    expect(etagFor('{"a":1}')).toBe(etagFor(new TextEncoder().encode('{"a":1}')));
  });

  test("is quoted, so it is a real entity-tag and not a bare hash", () => {
    expect(etagFor("x")).toMatch(/^"[0-9a-f]{64}"$/);
  });

  test("does not confuse a prefix of a body with the whole body", () => {
    // A truncated read (`""`, the shape a failed body takes) must never validate against
    // the full payload it came from.
    expect(etagFor("")).not.toBe(etagFor('[{"name":"cu"}]'));
  });
});

describe("isFresh", () => {
  const etag = etagFor("payload");

  test("a first visit (no header) is answered in full", () => {
    expect(isFresh(null, etag)).toBe(false);
    expect(isFresh(undefined, etag)).toBe(false);
    expect(isFresh("", etag)).toBe(false);
    expect(isFresh("   ", etag)).toBe(false);
  });

  test("the exact validator is fresh", () => {
    expect(isFresh(etag, etag)).toBe(true);
  });

  test("a different validator is not", () => {
    expect(isFresh(etagFor("other"), etag)).toBe(false);
  });

  test("* matches any existing representation", () => {
    expect(isFresh("*", etag)).toBe(true);
  });

  test("matches inside a list, which is what a browser that stacked validators sends", () => {
    expect(isFresh(`${etagFor("a")}, ${etag}, ${etagFor("b")}`, etag)).toBe(true);
    expect(isFresh(`${etagFor("a")}, ${etagFor("b")}`, etag)).toBe(false);
  });

  test("a weak comparison, as RFC 7232 requires for GET", () => {
    // A browser that stored the compressed representation sends the validator back weak.
    expect(isFresh(`W/${etag}`, etag)).toBe(true);
    expect(isFresh(`w/${etag}`, etag)).toBe(true);
  });

  test("a malformed header never validates", () => {
    // Fail closed: an unparseable `If-None-Match` costs a full body, which is recoverable.
    // The reverse mistake would tell a client it had a body it has never seen.
    for (const bad of ['""', '"', "W/", `W/${etagFor("a")},`, etag.slice(1)]) {
      expect(isFresh(bad, etag)).toBe(false);
    }
  });
});

describe("mayRevalidate", () => {
  const body = new TextEncoder().encode('{"ok":true}');

  test("a plain JSON GET may", () => {
    expect(mayRevalidate("GET", 200, jsonHeaders())).toBe(true);
  });

  test("HEAD may: it is the same read with no body to send", () => {
    expect(mayRevalidate("HEAD", 200, jsonHeaders())).toBe(true);
  });

  test("a write never may, whatever it answers with", () => {
    // The security-relevant half. `POST /api/sessions` starts an agent and
    // `PATCH /api/settings` writes a provider key: a validator on either would let a client
    // assert "I already have the answer" to a request that is supposed to DO something.
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(mayRevalidate(method, 200, jsonHeaders())).toBe(false);
    }
  });

  test("only a 200 carries a validator: an error is not a cached representation", () => {
    for (const status of [201, 204, 301, 400, 401, 403, 404, 421, 500, 503]) {
      expect(mayRevalidate("GET", status, jsonHeaders())).toBe(false);
    }
  });

  test("a streamed or already-encoded response never may", () => {
    // `/api/stream` and the SSE queue feed are read as they arrive: hashing one would
    // consume the stream the client is waiting on. An encoded body has no stable bytes.
    const stream = new Headers({ "content-type": "text/event-stream" });
    expect(mayRevalidate("GET", 200, stream)).toBe(false);
    expect(mayRevalidate("GET", 200, jsonHeaders({ "content-encoding": "gzip" }))).toBe(false);
  });

  test("a non-JSON body never may", () => {
    for (const type of ["text/html; charset=utf-8", "image/png", "text/plain", "font/woff2", ""]) {
      expect(mayRevalidate("GET", 200, new Headers({ "content-type": type }))).toBe(false);
    }
  });

  test("a response that says no-store is left alone", () => {
    // A caller that asked not to be stored must not end up behind an ETag in a disk cache.
    expect(mayRevalidate("GET", 200, jsonHeaders({ "cache-control": "no-store" }))).toBe(false);
    expect(mayRevalidate("GET", 200, jsonHeaders({ "cache-control": "private, no-store" }))).toBe(false);
    // but a plain no-cache (revalidate-always) is exactly the policy this module sets.
    expect(mayRevalidate("GET", 200, jsonHeaders({ "cache-control": "no-cache" }))).toBe(true);
  });

  test("it takes no body argument at all, and that is the contract", () => {
    // MEASURED regression this shape exists to prevent: a caller that reads the body before
    // asking hangs every open stream. `/api/stream` and the SSE queue feed answered 0 bytes
    // against a build that hashed first and the build before it answered 59 and 62.
    expect(mayRevalidate.length).toBe(3);
    expect(mayRevalidate.toString()).not.toMatch(/body|arrayBuffer|Uint8Array/);
  });

  test("an event stream never may, on content type alone and with no list to keep in step", () => {
    // The exclusion is the JSON test, not an enumeration: a route added later cannot be
    // forgotten here, because nothing here has to be updated when one appears.
    for (const type of ["text/event-stream", "text/event-stream; charset=utf-8"]) {
      expect(mayRevalidate("GET", 200, new Headers({ "content-type": type }))).toBe(false);
    }
  });
});

describe("revalidationHeaders", () => {
  const h = revalidationHeaders(etagFor("x"));

  test("cache-control is no-cache, which is not what it looks like", () => {
    // The load-bearing header, and the one most likely to be "fixed" by someone who reads
    // it as "do not store". It means: store it, ask again before using it. A `max-age`
    // would have bought silence between visits by letting the UI show a skills list that no
    // longer matches the folder behind it.
    expect(h["cache-control"]).toBe("no-cache");
    expect(h["cache-control"]).not.toMatch(/max-age/);
  });

  test("declares the encoding variance, or a shared cache could mix the two up", () => {
    expect(h.vary).toBe("accept-encoding");
  });

  test("carries the validator it was given", () => {
    expect(h.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(h.etag).toBe(etagFor("x"));
  });
});

describe("the rule the server applies, end to end", () => {
  /** What `revalidate()` in serve.ts does, over the pure pieces. */
  const serve = (method: string, body: string, ifNoneMatch?: string | null) => {
    // Headers first, body second — the order the real caller uses, and the order the
    // measured regression was about.
    if (!mayRevalidate(method, 200, jsonHeaders())) return { status: 200, body, etag: undefined };
    const bytes = new TextEncoder().encode(body);
    if (!bytes.length) return { status: 200, body: "", etag: undefined };
    const etag = etagFor(bytes);
    if (isFresh(ifNoneMatch, etag)) return { status: 304, body: "", etag };
    return { status: 200, body, etag };
  };

  test("first visit: the whole body", () => {
    const r = serve("GET", '{"skills":60}');
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"skills":60}');
    expect(r.etag).toBeTruthy();
  });

  test("second visit, unchanged: 304 and no body", () => {
    const first = serve("GET", '{"skills":60}');
    const second = serve("GET", '{"skills":60}', first.etag);
    expect(second.status).toBe(304);
    expect(second.body).toBe("");
    expect(second.etag).toBe(first.etag);
  });

  test("a skill added on disk: the full body again, with a new validator", () => {
    const first = serve("GET", '{"skills":60}');
    const moved = serve("GET", '{"skills":61}', first.etag);
    expect(moved.status).toBe(200);
    expect(moved.body).toBe('{"skills":61}');
    expect(moved.etag).not.toBe(first.etag);
  });

  test("a long visit settles: 304 while nothing moves, 200 the visit it does", () => {
    // The shape the client actually produces (visibilitychange + a `$` typed, over and
    // over), with a skill added to the folder at visit 3 and never taken away.
    let etag: string | undefined;
    const seen: number[] = [];
    for (let visit = 0; visit < 6; visit++) {
      const skills = visit < 3 ? 60 : 61;
      const r = serve("GET", `{"skills":${skills}}`, etag);
      seen.push(r.status);
      etag = r.etag;
    }
    // First visit has nothing cached; the two after it change nothing; the one that moves
    // ships in full; the two after it go quiet again.
    expect(seen).toEqual([200, 304, 304, 200, 304, 304]);
  });

  test("a body that reverts to an earlier value is NOT answered 304", () => {
    // The case that keeps this honest: the validator is of the bytes, not of a version
    // counter, so a body that goes back to what it was once validates against the copy the
    // client may still be holding. Sending the full body is the only safe answer, and it is
    // what this returns.
    const first = serve("GET", '{"skills":60}');
    const changed = serve("GET", '{"skills":61}', first.etag);
    const reverted = serve("GET", '{"skills":60}', changed.etag);
    expect(reverted.status).toBe(200);
    expect(reverted.body).toBe('{"skills":60}');
    expect(reverted.etag).toBe(first.etag); // it IS the same body again
  });

  test("a write is never answered with 304, however the client asks", () => {
    const etag = serve("GET", "{}").etag;
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const r = serve(method, '{"ok":true}', etag);
      expect(r.status).toBe(200);
      expect(r.body).toBe('{"ok":true}');
    }
  });

  test("what it costs: 36 KB of body becomes 0, at the price of one header line", () => {
    const skills = JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({ name: `skill-${i}`, description: "x".repeat(550) })),
    );
    const first = serve("GET", skills);
    const second = serve("GET", skills, first.etag);
    expect(skills.length).toBeGreaterThan(30_000); // the measured payload was 36 412 B
    expect(first.body.length).toBeGreaterThan(30_000);
    expect(second.body.length).toBe(0);
    expect(second.etag!.length).toBeLessThan(80);
  });
});

/**
 * THE REGRESSION THIS MODULE ALMOST SHIPPED, as a live test.
 *
 * The first version of the caller hashed the body and asked afterwards. On an open stream
 * `await response.arrayBuffer()` does not resolve until the stream CLOSES, which for a live
 * feed is never — so the wrapper held `/api/stream` and the SSE queue feed open forever.
 *
 * MEASURED on the deployed server, same machine, two builds side by side:
 *
 *   | build                                | `/api/stream` | `/api/task-events/stream` |
 *   |--------------------------------------|---------------|---------------------------|
 *   | `origin/main` (no validator)         | **59 B**      | **62 B**                  |
 *   | the first version of this wrapper    | **0 B**       | **0 B**                   |
 *
 * The mock below is what made that visible without a deploy: it is a real `Response` over a
 * real `ReadableStream` that stays open, so the test would have hung — and Bun's timeout
 * turns that into a failure rather than a flake. A `new Response("{}")` mock would have
 * passed against the broken code forever, because a body that is already in hand is exactly
 * the case that never hangs.
 */
describe("an open stream is left open (the regression that was measured)", () => {
  /** A body that produces one chunk and then never ends, like an SSE feed. */
  const openStream = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: task\ndata: {}\n\n"));
          // Deliberately never closed: this is the whole point.
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

  test("the decision is reached from the headers, without touching the body", () => {
    // Synchronous and total: if this ever needed the body it could not return at all.
    const response = openStream();
    expect(mayRevalidate("GET", response.status, response.headers)).toBe(false);
    expect(response.bodyUsed).toBe(false); // and the body was never read
  });

  test("a caller that follows the contract returns the response untouched", async () => {
    // The shape `revalidate()` has: decide, and only then read. Run against the real
    // streaming Response, so a wrapper that read first would hang here rather than pass.
    const request = new Request("http://127.0.0.1/api/stream");
    const response = openStream();
    const skip =
      !!response.headers.get("etag") || !mayRevalidate(request.method, response.status, response.headers);
    const out: Response = skip
      ? response
      : await Promise.race<Response>([
          (async () => new Response(await response.arrayBuffer()))(),
          new Promise<Response>((_, reject) =>
            setTimeout(() => reject(new Error("hung reading an open stream")), 250),
          ),
        ]);
    expect(out).toBe(response);
    expect(out.headers.get("etag")).toBeNull();
    expect(out.bodyUsed).toBe(false);
    // And it is still a working stream: the chunk is still there to be read.
    const reader = out.body!.getReader();
    expect((await reader.read()).value).toBeInstanceOf(Uint8Array);
  });

  test("a JSON response, by contrast, IS read — the two must not be conflated", async () => {
    const response = new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    expect(mayRevalidate("GET", response.status, response.headers)).toBe(true);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
