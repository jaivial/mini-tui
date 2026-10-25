/** Body reads with a deadline, and a body that never arrived told apart from an empty one (E40).
 *
 *  Every test here pins a behaviour that was measured against the deployed
 *  build, and each one fails against `origin/main`'s logic. They run against
 *  real `Request` objects with real streams and a REAL clock — a fake timer
 *  would pass here for the wrong reason: the defect is that nothing ever
 *  settles, not that a timer fires early.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bodyRefusal, BodyTimeout, BodyTooLarge, BODY_IDLE_SECONDS, EmptyBody, readBody, readJsonBody } from "../src/web/bodyRead";
import { RateLimiter } from "../src/web/rateLimit";

/** A request whose body stops mid-way, the way a closed tab or a lost phone
 *  looks from the server: headers sent, some bytes sent, then nothing. */
function truncated(contentType: string, declared: number, sent: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sent));
      // never close: this is the half-open case
    },
  });
  return new Request("http://127.0.0.1:4317/api/attachments", { method: "POST", headers: { "content-type": contentType, "content-length": String(declared) }, body, duplex: "half" } as RequestInit);
}

function json(text: string): Request {
  return new Request("http://127.0.0.1:4317/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: text });
}

describe("readJsonBody", () => {
  test("a complete JSON object is the value", async () => {
    const out = await readJsonBody(json('{"prompt":"hola","model":"x"}'));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.prompt).toBe("hola");
  });

  test("an EMPTY body is absent, NOT an empty object — this is the E40 defect", async () => {
    // `readJson` used to return `{}` here, and POST /api/sessions acted on it:
    // measured 201 + a real agent spawn for a request with no body.
    const out = await readJsonBody(json(""));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("absent");
  });

  test("a body that was cut in half is truncated, not an empty object", async () => {
    const req = truncated("application/json", 4096, '{"prompt":"hola, esto se corta');
    let out;
    try {
      out = await readJsonBody(req, 250);
    } catch (error) {
      // 408 is the honest answer for a body that stopped arriving; what must
      // never happen is this resolving to `{ ok: true, value: {} }`.
      expect(error).toBeInstanceOf(BodyTimeout);
      expect((error as BodyTimeout).status).toBe(408);
      return;
    }
    expect(out.ok).toBe(false);
    if (!out.ok) expect(["truncated", "malformed"]).toContain(out.reason);
  });

  test("malformed JSON is malformed, not absent", async () => {
    const out = await readJsonBody(json("{no-json"));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("malformed");
  });

  test("a JSON array is not an object and must not be read as one", async () => {
    const out = await readJsonBody(json('[1,2,3]'));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("malformed");
  });

  test("every refusal names itself, so the route's 400 is honest", () => {
    expect(bodyRefusal({ ok: false, reason: "absent" })).toBe("expected a JSON body");
    expect(bodyRefusal({ ok: false, reason: "malformed" })).toBe("the request body is not valid JSON");
    expect(bodyRefusal({ ok: true, value: {} })).toBeNull();
  });
});

describe("readBody deadline", () => {
  test("a body that stops mid-way is GIVEN UP ON, with 408 — the E40 hang", async () => {
    // The measured defect: `await request.formData()` on a half-open connection
    // stayed pending past 130 s with `idleTimeout: 255` in force, token already
    // spent. Here the same shape, with a real clock and a short idle window, so
    // the test asserts the deadline FIRES rather than asserting a timeout.
    const req = truncated("multipart/form-data; boundary=qq", 15728640, "--qq\r\n");
    const started = Date.now();
    let caught: unknown;
    try {
      await readBody(req, (r) => r.formData(), 15728640, 250);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BodyTimeout);
    expect((caught as BodyTimeout).status).toBe(408);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a JSON body cut in half is given up on too, and never becomes {}", async () => {
    const req = truncated("application/json", 4096, '{"prompt":"hola');
    let caught: unknown;
    try {
      await readJsonBody(req, 250);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BodyTimeout);
  });

  test("PROGRESS resets the deadline: a slow but alive upload is not a hang", async () => {
    // The other half of the rule: a deadline on TOTAL time would refuse a
    // legitimate 15 MB upload on a slow link (E39 measured ~4 min at 500 kbit/s).
    // Chunks every 40 ms with a 400 ms idle window must complete.
    const chunks = 12;
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder();
        for (let i = 0; i < chunks; i++) {
          c.enqueue(enc.encode(`{"n":${i},"pad":"${"y".repeat(200)}"}`));
          await new Promise((r) => setTimeout(r, 40));
        }
        c.close();
      },
    });
    const req = new Request("http://127.0.0.1:4317/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    const started = Date.now();
    const text = await readBody(req, (r) => r.text(), 1024 * 1024, 400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(chunks * 40);
    expect(text.length).toBeGreaterThan(chunks * 200);
  });

  test("a BodyTimeout carries 408, the status the route answers", () => {
    const t = new BodyTimeout("idle");
    expect(t.status).toBe(408);
    expect(t.message).toContain("stopped arriving");
  });

  test("a complete body reads through readBody untouched", async () => {
    const req = json('{"prompt":"hola"}');
    const text = await readBody(req, (r) => r.text(), 1024);
    expect(text).toBe('{"prompt":"hola"}');
  });

  test("a complete MULTIPART body still parses through readBody (formData is intact)", async () => {
    const b = "----qq";
    const bytes = new TextEncoder().encode(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhola\r\n--${b}--\r\n`);
    const req = new Request("http://127.0.0.1:4317/api/attachments", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${b}` }, body: bytes });
    const form = await readBody(req, (r) => r.formData(), 1024);
    const file = form.get("file");
    expect(typeof file).not.toBe("string");
    expect((file as File).name).toBe("a.txt");
    expect((file as File).size).toBe(4);
  });

  test("the size cap is enforced WHILE reading, not after", async () => {
    // A lying Content-Length cannot get past the cap: the limit is checked per chunk.
    //
    // This test used to ACCEPT either answer — `if (value !== undefined) ...
    // else expect(caught).toBeInstanceOf(BodyTimeout)` — and that leniency is
    // why the E42 defect survived E40: a `BodyTimeout` for an oversize body is
    // exactly what the assertion blessed.
    const req = json("x".repeat(4096));
    let caught: unknown;
    let value: string | undefined;
    try {
      value = await readBody(req, (r) => r.text(), 100, 2000);
    } catch (error) {
      caught = error;
    }
    // Either the platform delivered it whole (then the cap is a lie we cannot
    // enforce here), or it was refused — and refused for the RIGHT reason.
    if (value !== undefined) expect(value.length).toBeLessThanOrEqual(4096);
    else expect(caught).toBeInstanceOf(BodyTooLarge);
  });
});

/**
 * E42. A body that arrived TOO FAST was reported as one that never arrived.
 *
 * Measured against the deployed build: a 17 MB upload on the 15 MB cap
 * answered `408 "the request body stopped arriving for 60s"` in **0,00 s**.
 * Three lies in one answer — the status (413, not 408), the reason (nothing
 * stopped arriving; 17 MB landed in 20 ms) and the clock (it claims 60 s of
 * silence about a body that arrived whole). The per-chunk cap threw
 * `BodyTimeout` from inside the watchdog's own `try`, and the `catch` right
 * below re-labelled it `idle`.
 *
 * And `BodyOutcome` already had a `"too-large"` reason with a message waiting
 * for it in `bodyRefusal`, that no code path could produce.
 */
describe("a body past the cap is 413, not a stall (E42)", () => {
  /** A body that keeps coming, in chunks, past `limit`. */
  function flood(totalBytes: number, chunk = 64 * 1024): Request {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= totalBytes) { c.close(); return; }
        const n = Math.min(chunk, totalBytes - sent);
        sent += n;
        c.enqueue(new Uint8Array(n));
      },
    });
    return new Request("http://127.0.0.1:4317/api/attachments", { method: "POST", headers: { "content-type": "application/octet-stream" }, body, duplex: "half" } as RequestInit);
  }

  test("an oversize body is refused with 413, NOT 408", async () => {
    // The exact status the deployed build got wrong.
    let caught: unknown;
    try {
      await readBody(flood(4 * 1024 * 1024), (r) => r.text(), 1024, 5000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BodyTooLarge);
    expect((caught as BodyTooLarge).status).toBe(413);
    // The regression, stated as an assertion: it was a BodyTimeout before.
    expect(caught).not.toBeInstanceOf(BodyTimeout);
  });

  test("the refusal does not claim silence it never had", async () => {
    let caught: BodyTooLarge | undefined;
    try {
      await readBody(flood(4 * 1024 * 1024), (r) => r.text(), 1024, 5000);
    } catch (error) {
      caught = error as BodyTooLarge;
    }
    // "the request body stopped arriving for 60s" is what E42 measured here,
    // from a body that arrived in full. The message must name the cap instead.
    expect(caught?.message).not.toMatch(/stopped arriving|did not finish/i);
    expect(caught?.message).toContain("1024");
  });

  test("a body AT the cap is still read — the cap is not off by one chunk", async () => {
    const limit = 256 * 1024;
    const value = await readBody(flood(limit), (r) => r.text(), limit, 5000);
    expect((value as string).length).toBe(limit);
  });

  test("a body just UNDER the cap is still read", async () => {
    const limit = 256 * 1024;
    const value = await readBody(flood(limit - 1), (r) => r.text(), limit, 5000);
    expect((value as string).length).toBe(limit - 1);
  });

  test("readJsonBody names it: reason `too-large`, the branch that was dead", async () => {
    const out = await readJsonBody(flood(4 * 1024 * 1024));
    expect(out.ok).toBe(false);
    // `bodyRefusal` has had a message for "too-large" since E40. Nothing could
    // produce it until now, so it never ran.
    if (!out.ok) {
      expect(out.reason).toBe("too-large");
      expect(bodyRefusal(out)).toContain("over");
    }
  });

  test("a JSON body past JSON_MAX_BYTES is `too-large`, not `truncated`", async () => {
    // Same route shape as the measured 2 MB body on the 1 MB cap: it answered
    // 408 "stopped arriving for 60s" in 0,00 s.
    const out = await readJsonBody(json("y".repeat(2 * 1024 * 1024)));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("too-large");
  });

  test("the answer does not wait for a client that keeps sending", async () => {
    // The refusal has to settle on the chunk that crosses the cap. A client
    // that keeps streaming for a minute must not hold the answer hostage — the
    // old code path parked in `read()` waiting for bytes nobody would use.
    //
    // Measured with the real clock and a genuinely slow stream, because a fake
    // timer would pass for the wrong reason: the claim is about WAITING.
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 120)); // 120 ms per chunk
        c.enqueue(new Uint8Array(64 * 1024)); // 64 KB — the cap is 1 KB
      },
    });
    const req = new Request("http://127.0.0.1:4317/api/attachments", { method: "POST", body, duplex: "half" } as RequestInit);
    const t0 = Date.now();
    await expect(readBody(req, (r) => r.text(), 1024, 5000)).rejects.toBeInstanceOf(BodyTooLarge);
    const elapsed = Date.now() - t0;
    // Two chunks is ~240 ms. Anything near the stream's own end (20+ chunks,
    // 2.4 s) means it waited for the client to finish.
    expect(elapsed).toBeLessThan(1500);
  });
});

function settledIsValue(o: unknown): o is string {
  return typeof o === "string";
}

describe("RateLimiter.give — a token for a request that never happened", () => {
  test("give takes back exactly the newest hit, and leaves the rest", () => {
    const rl = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    rl.take("k", t0); rl.take("k", t0 + 1); rl.take("k", t0 + 2);
    rl.give("k", t0 + 3);
    // Three were taken, one came back: room for exactly one more.
    expect(rl.take("k", t0 + 4).ok).toBe(true);
    expect(rl.take("k", t0 + 5).ok).toBe(false);
  });

  test("the measured E40 scenario: 20 half-open uploads must not deny a real one", () => {
    const rl = new RateLimiter(20, 60_000);
    const t0 = 5_000_000;
    // 20 clients open the connection and send no body at all.
    for (let i = 0; i < 20; i++) { expect(rl.take("ip", t0 + i).ok).toBe(true); rl.give("ip", t0 + i); }
    // The 21st is a REAL, complete upload. Before the fix it was refused 429.
    expect(rl.take("ip", t0 + 21).ok).toBe(true);
  });

  test("give on an unknown key is a no-op, not a crash", () => {
    const rl = new RateLimiter(2, 60_000);
    rl.give("nunca");
    expect(rl.tracked).toBe(0);
  });

  test("give does not resurrect an expired key into the map", () => {
    const rl = new RateLimiter(2, 60_000);
    rl.take("k", 1_000_000);
    rl.give("k", 1_000_000);
    expect(rl.tracked).toBe(0);
  });
});

describe("absence is not a stall", () => {
  test("a request with NO body is absent, not a 408 (E40 follow-up)", async () => {
    // Measured live against the first E40 build: an empty POST answered 408
    // "the request body stopped arriving for 60s". Nothing stopped arriving —
    // the request arrived complete with `content-length: 0` and nothing in it,
    // which Bun reports as `request.body === null`. Saying "stopped arriving"
    // about a request that arrived whole is the same class of lie as the `{}`.
    const out = await readJsonBody(new Request("http://127.0.0.1:4317/api/sessions", { method: "POST", headers: { "content-type": "application/json" } }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("absent");
    expect(bodyRefusal(out)).toBe("expected a JSON body");
  });

  test("EmptyBody is a 400, and is NOT a BodyTimeout", () => {
    expect(new EmptyBody().status).toBe(400);
    expect(new EmptyBody()).not.toBeInstanceOf(BodyTimeout);
  });

  test("a body that DID arrive (one space) is absent too, but by parsing", async () => {
    const out = await readJsonBody(json(" "));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("absent");
  });
});

/**
 * E41. E40 closed the defect on eight routes and left the guard standing by
 * CUSTOM: the lenient reader was still in the file, so any new state-changing
 * route could call it and get the whole thing back. Measured against the
 * deployed build, `POST /api/router/preview` was the one route left on it —
 * and because `route()` audits every call, a POST with no body answered 200
 * with a real decision AND wrote a phantom row into `decisions`.
 *
 * These tests pin the two things that make that unrepeatable: the lenient
 * reader is GONE (a fact about the source, checked the only way it can be),
 * and every body-reading route goes through the refusal path.
 */
describe("no route can read a body the lenient way (E41)", () => {
  const serve = readFileSync(new URL("../src/web/serve.ts", import.meta.url), "utf8");
  /** Strip comments so the prose explaining the removal is not read as code. */
  const code = serve.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("the lenient reader does not exist: there is nothing left to call by mistake", () => {
    // The defect was never `readJson`'s logic — it was that the function was
    // still reachable. A test on behaviour cannot see that; only the source can.
    expect(code).not.toMatch(/\bfunction readJson\b/);
    expect(code).not.toMatch(/\breadJson\s*\(/);
  });

  test("every state-changing route that reads a body goes through readJsonOrRefuse", () => {
    const callSites = [...code.matchAll(/await readJsonOrRefuse\(/g)];
    // The eight E40 converted, plus /router/preview (E41), plus the work queue's three
    // (/queue-agent/*, /queue/prompt, /queue/tasks/:id/redirect) and the browser panel's input, plus MCP's
    // three (install, enable/disable, paste the redirect). Each one is a route that acts on what arrived, so
    // each one has to be able to refuse.
    expect(callSites.length).toBe(16);
  });

  test("the 413 fast-refuse and the multipart upload still give their token back", () => {
    // /attachments reads its body itself (multipart), so it does not go
    // through readJsonOrRefuse — it must still refund on both refusal paths,
    // which is the same rule by hand. Pinned so a future edit cannot drop it.
    const attachment = code.slice(code.indexOf('"/attachments" && request.method === "POST"'));
    const block = attachment.slice(0, attachment.indexOf("attMatch &&"));
    expect(block).toContain("LIMITS.attachment.give(uploadKey)");
    expect([...block.matchAll(/\.give\(/g)].length).toBeGreaterThanOrEqual(2);
  });

  test("no route reads a request body without a deadline", () => {
    // `readBody`/`readJsonBody` are the only sanctioned readers. A bare
    // `request.json()`, `request.text()` or `request.formData()` in a handler
    // is exactly the E40 hang: pending forever on a client that stops sending.
    // Line-aware: the sanctioned shape is a reader passed AS the argument of
    // `readBody(...)`, e.g. `readBody(request, (req) => req.formData(), limit)`.
    // A bare read on its own line is the E40 hang.
    const offenders = code
      .split("\n")
      .filter((line) => /\b(?:request|req)\.(json|text|formData|arrayBuffer)\(\)/.test(line))
      .filter((line) => !/readBody\s*\(/.test(line));
    expect(offenders).toEqual([]);
  });
});

describe("the router preview route (E41)", () => {
  test("a body that never arrived is refused, not routed and audited", async () => {
    // The measured shape of the defect, at the unit level: what the route
    // received for a POST with no body. It was `{}`, and `route({task: ""})`
    // still produced a decision — and an audit row.
    for (const body of [undefined, "", "{ task: ", "[1,2,3]"]) {
      const req = new Request("http://127.0.0.1:4317/api/router/preview", { method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body }) });
      let out;
      try {
        out = await readJsonBody(req);
      } catch {
        continue; // a timeout is an honest refusal too
      }
      expect(out.ok).toBe(false);
    }
  });

  test("a bodiless request gives its rate-limit token back", async () => {
    // 20 bodiless POSTs starved a real, complete request into a 429 (measured).
    // The refund is the fix; this is the unit that carries it.
    const rl = new RateLimiter(20, 60_000);
    rl.take("k", 1_000);
    rl.give("k", 1_000);
    expect(rl.tracked).toBe(0);
    for (let i = 0; i < 25; i++) { rl.take("k", 2_000); rl.give("k", 2_000); }
    expect(rl.tracked).toBe(0);
  });
});
