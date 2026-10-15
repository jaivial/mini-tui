/**
 * Pairing by phone number (evo-weai-mini over loopback): number validation,
 * the weai 0.2.8 nested-envelope answers, rate limiting and fail-closed
 * parsing. fetch is stubbed — the real pairing is done by a human.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { evoPairingCode, normalizePairingNumber, resetPairingRateLimit } from "../src/web/channels";

const ENV = {
  EVO_CONNECT_INSTANCE: "mini-assistant",
  EVO_CONNECT_BASE_URL: "http://127.0.0.1:8952",
  EVO_CONNECT_API_KEY: "test-key",
};

let responses: Array<{ status: number; body: unknown }> = [];
let calls: string[] = [];
const realFetch = globalThis.fetch;

function stubFetch() {
  // @ts-expect-error test stub
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("no stubbed response");
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  responses = [];
  calls = [];
  resetPairingRateLimit();
});

describe("normalizePairingNumber", () => {
  test("accepts the shapes weai itself accepts", () => {
    expect(normalizePairingNumber("+34 600 000 000")).toBe("34600000000");
    expect(normalizePairingNumber("34-600-000-000")).toBe("34600000000");
    expect(normalizePairingNumber("(34) 600.000.000")).toBe("34600000000");
  });
  test("rejects letters, leading zeros and wrong lengths", () => {
    expect(normalizePairingNumber("600abc000")).toBeNull();
    expect(normalizePairingNumber("012345678")).toBeNull();
    expect(normalizePairingNumber("12345")).toBeNull();
    expect(normalizePairingNumber("12345678901234567890")).toBeNull();
    expect(normalizePairingNumber("")).toBeNull();
  });
});

describe("evoPairingCode", () => {
  test("a bad number never reaches the upstream API", async () => {
    stubFetch();
    process.env.EVO_CONNECT_API_KEY = ENV.EVO_CONNECT_API_KEY;
    const view = await evoPairingCode("abc");
    expect(view.error).toBe("invalid_number");
    expect(calls).toEqual([]);
  });

  test("a pairing answer is passed through with an expiry", async () => {
    stubFetch();
    process.env.EVO_CONNECT_INSTANCE = ENV.EVO_CONNECT_INSTANCE;
    process.env.EVO_CONNECT_BASE_URL = ENV.EVO_CONNECT_BASE_URL;
    process.env.EVO_CONNECT_API_KEY = ENV.EVO_CONNECT_API_KEY;
    responses.push({ status: 200, body: { pairingCode: "ABCD-WXYZ", count: 1 } });
    const view = await evoPairingCode("+34 600 000 000");
    expect(view.code).toBe("ABCD-WXYZ");
    expect(view.expiresAt).toBeGreaterThan(Date.now());
    expect(calls[0]).toContain("/instance/connect/mini-assistant?number=34600000000");
  });

  test("weai 0.2.8 nested open envelope answers already_connected, no code", async () => {
    stubFetch();
    process.env.EVO_CONNECT_API_KEY = ENV.EVO_CONNECT_API_KEY;
    responses.push({ status: 200, body: { instance: { instanceName: "mini-assistant", state: "open" } } });
    const view = await evoPairingCode("34600000000");
    expect(view.state).toBe("connected");
    expect(view.error).toBe("already_connected");
    expect(view.code).toBeUndefined();
  });

  test("a code-shaped answer wins over a stale nested state", async () => {
    stubFetch();
    process.env.EVO_CONNECT_API_KEY = ENV.EVO_CONNECT_API_KEY;
    responses.push({ status: 200, body: { pairingCode: "A1B2-C3D4", count: 1, instance: { state: "connecting" } } });
    const view = await evoPairingCode("34600000000");
    expect(view.code).toBe("A1B2-C3D4");
  });

  test("a malformed code is never surfaced", async () => {
    stubFetch();
    process.env.EVO_CONNECT_API_KEY = ENV.EVO_CONNECT_API_KEY;
    responses.push({ status: 200, body: { pairingCode: "DROP TABLE; --", count: 1 } });
    responses.push({ status: 200, body: { instance: { state: "connecting" } } });
    const view = await evoPairingCode("34600000000");
    expect(view.code).toBeUndefined();
    expect(view.error).toBe("no_code_available");
  });

  test("calls inside the rate-limit window are refused without an upstream call", async () => {
    stubFetch();
    process.env.EVO_CONNECT_API_KEY = ENV.EVO_CONNECT_API_KEY;
    responses.push({ status: 200, body: { pairingCode: "ABCD-WXYZ", count: 1 } });
    await evoPairingCode("34600000000");
    const view = await evoPairingCode("34600000001");
    expect(view.error).toBe("code_rate_limited");
    expect(calls.length).toBe(1);
  });

  test("an unreachable weai answers unreachable, never a code", async () => {
    stubFetch();
    process.env.EVO_CONNECT_API_KEY = ENV.EVO_CONNECT_API_KEY;
    responses.push({ status: 503, body: { error: "down" } });
    responses.push({ status: 503, body: { error: "down" } });
    const view = await evoPairingCode("34600000000");
    expect(view.state).toBe("unreachable");
    expect(view.code).toBeUndefined();
  });
});
