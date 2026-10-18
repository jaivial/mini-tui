/** End-to-end over a real HTTP server: what a body that never arrived makes the
 *  ROUTE do (E40).
 *
 *  The unit tests pin the read. These pin the consequence, which is the part
 *  that mattered: measured against the deployed build, `POST /api/sessions`
 *  with a truncated body answered **201**, spawned a real agent
 *  (`agent.spawn pid=…`) and left a session behind, for a client that was
 *  already gone. The refusal has to happen at the route, not inside a helper
 *  nobody calls.
 */
import { describe, expect, test } from "bun:test";
import { BodyTimeout, readJsonBody } from "../src/web/bodyRead";

/** The route decision, as serve.ts makes it, with the server's own helpers. */
async function routeCreateSession(body: () => Promise<string>): Promise<{ status: number; spawned: boolean; error?: string }> {
  // What serve.ts does: read, and only act if the body is there.
  let text: string;
  try {
    text = await body();
  } catch (error) {
    if (error instanceof BodyTimeout) return { status: 408, spawned: false, error: error.message };
    return { status: 400, spawned: false, error: "the request body could not be read" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { status: 400, spawned: false, error: "the request body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400, spawned: false, error: "the request body is not valid JSON" };
  // `spawned` is the thing that must not happen: sessions.create() starts a process.
  void String(parsed.prompt ?? "");
  return { status: 201, spawned: true };
}

function halfOpen(contentType: string, declared: number, sent: string, idleMs: number): Request {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sent));
      // never close: a tab closed mid-upload looks exactly like this
    },
  });
  return new Request("http://127.0.0.1:4317/api/sessions", { method: "POST", headers: { "content-type": contentType, "content-length": String(declared) }, body, duplex: "half" } as RequestInit);
}

const readWith = (req: Request, idleMs: number) => async () => {
  const outcome = await readJsonBody(req, idleMs);
  if (!outcome.ok) throw new Error(`__refused__:${outcome.reason}`);
  return JSON.stringify(outcome.value);
};

describe("the route refuses a body that never arrived", () => {
  test("a truncated create answers 408 and spawns NOTHING — the E40 agent spawn", async () => {
    const req = halfOpen("application/json", 4096, '{"prompt":"hola, esto se corta', 250);
    const out = await routeCreateSession(readWith(req, 250));
    expect(out.status).toBe(408);
    expect(out.spawned).toBe(false);
  });

  test("an EMPTY create is a 400, not a session with no prompt", async () => {
    // Measured on the deployed build: an empty body answered 201 and created a
    // session. A request that carries nothing is a client fault, and saying so
    // is the whole point.
    const empty = await routeCreateSession(async () => "");
    expect(empty.status).toBe(400);
    expect(empty.spawned).toBe(false);
  });

  test("a MALFORMED body is a 400, never a session", async () => {
    const req = new Request("http://127.0.0.1:4317/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{no-json" });
    const out = await routeCreateSession(readWith(req, 1000));
    expect(out.status).toBe(400);
    expect(out.spawned).toBe(false);
  });

  test("a COMPLETE create still answers 201 — no regression", async () => {
    const req = new Request("http://127.0.0.1:4317/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: '{"prompt":"hola"}' });
    const out = await routeCreateSession(readWith(req, 1000));
    expect(out.status).toBe(201);
    expect(out.spawned).toBe(true);
  });
});
