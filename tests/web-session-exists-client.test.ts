/**
 * The client's side of the existence question (E56).
 *
 * "Was that refused handshake a deleted session, or just a dead network?" has three answers, and the
 * middle one is the one that matters: `false` = the server says the id is nowhere (it is gone),
 * `true` = it is there, `null` = could not tell (the network, a busy database) so the caller keeps
 * trying. It is the same line the server draws in `held()`: 404 is a verdict, anything else is not.
 *
 * The question must be asked through the READ-ONLY route. `GET /sessions/:id` answers it by OPENING
 * the session (restoring the saved row, putting it back on the durable open list and announcing it
 * to every tab), so a client that merely wondered whether a closed session was still there brought
 * it back to life -- durably, since #345 (E52/E56).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, api, sessionExists } from "../web/src/lib/api";

const RealFetch = globalThis.fetch;

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return calls;
}

describe("the existence question asks the read-only route", () => {
  test("it asks /sessions/:id/exists, never the restoring read", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ exists: true }), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await sessionExists("s-1")).toBe(true);
    expect(calls).toEqual(["/api/sessions/s-1/exists"]);
    globalThis.fetch = RealFetch;
  });

  test("the id is encoded (a subagent id carries a tilde, a title can carry anything)", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ exists: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await sessionExists("s-1/2");
    expect(calls).toEqual(["/api/sessions/s-1%2F2/exists"]);
    globalThis.fetch = RealFetch;
  });

  test("404 is a verdict: the session is gone", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "unknown session" }), { status: 404, headers: { "content-type": "application/json" } }));
    expect(await sessionExists("s-gone")).toBe(false);
    globalThis.fetch = RealFetch;
  });

  test("a busy server is NOT a verdict: the caller must keep trying", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "could not look for the session" }), { status: 503, headers: { "content-type": "application/json" } }));
    expect(await sessionExists("s-busy")).toBe(null);
    globalThis.fetch = RealFetch;
  });

  test("the network failing is not a verdict either", async () => {
    stubFetch(() => { throw new TypeError("network down"); });
    expect(await sessionExists("s-offline")).toBe(null);
    globalThis.fetch = RealFetch;
  });
});

describe("the source keeps the question a question", () => {
  const apiSrc = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "api.ts"), "utf8");
  const storeSrc = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "stores", "sessions.svelte.ts"), "utf8");

  test("there is no client call left that restores a session just to ask", () => {
    // `api.session(id)` was the restoring read (`GET /sessions/:id`). It is gone: a client that only
    // wants to know must not have a door that opens.
    expect(apiSrc).not.toMatch(/^\s*session:\s*\(id/m);
  });

  test("the store's probe uses the read-only route", () => {
    expect(storeSrc).toContain("exists: sessionExists");
    expect(storeSrc).not.toContain("api.session(");
  });

  test("the probe is the named helper, so the harness can drive the app's own question", () => {
    expect(typeof sessionExists).toBe("function");
    expect(typeof api.sessionExists).toBe("function");
  });

  test("the error carries the status, so a 404 can be told from a 503", () => {
    expect(new HttpError("unknown session", 404).status).toBe(404);
  });
});
