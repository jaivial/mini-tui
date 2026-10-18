/**
 * E44: the flat clock over the loopback weai bridge.
 *
 * Two reads live behind one 5 s constant, and they are not the same work:
 * `connectionState` is a local flag read, while `instance/connect` asks WhatsApp
 * for a fresh QR. Measured against the deployed code with an upstream answering
 * in 8 s: the clock threw away a QR that really was produced, told the user the
 * bridge was dead, and — because the call itself burned the whole 5 s rate-limit
 * window — let six clicks produce six upstream logins with nothing rate limited.
 *
 * fetch is stubbed; no real WhatsApp session is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { evoQr, evoStatus, evoPairingCode, resetPairingRateLimit, PAIRING_INTERVALS, UPSTREAM_BUDGETS } from "../src/web/channels";

const ENV = {
  EVO_CONNECT_INSTANCE: "mini-assistant",
  EVO_CONNECT_BASE_URL: "http://127.0.0.1:8952",
  EVO_CONNECT_API_KEY: "test-key",
};

let calls: string[] = [];
const realFetch = globalThis.fetch;

/** A stub whose answer takes `ms`, the way the slow-bridge probe did. */
function slowFetch(ms: number, body: unknown) {
  // @ts-expect-error test stub
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), ms);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
  };
}

function quickFetch(body: unknown) {
  // @ts-expect-error test stub
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  calls = [];
  resetPairingRateLimit();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPairingRateLimit();
});

describe("E44 · the clock that says `slow` is not `down`", () => {
  test("a QR that arrives after the read's clock is kept, not discarded", async () => {
    // Longer than the old flat 5 s, inside the pairing budget.
    const delay = 8_000;
    expect(delay).toBeGreaterThan(5_000);
    expect(delay).toBeLessThan(UPSTREAM_BUDGETS.connect);
    slowFetch(delay, { base64: "data:image/png;base64,AAAA", expiresAt: Date.now() + 60_000 });
    const view = await evoQr();
    expect(view.qr).toBe("data:image/png;base64,AAAA");
    expect(view.error).toBeUndefined();
  }, 20_000);

  test("a pairing code that arrives late is still a code", async () => {
    slowFetch(8_000, { pairingCode: "ABCD-WXYZ" });
    const view = await evoPairingCode("34600000000");
    expect(view.code).toBe("ABCD-WXYZ");
  }, 20_000);

  test("a bridge that is merely slow is not reported as one that is dead", async () => {
    slowFetch(8_000, { base64: "data:image/png;base64,AAAA" });
    const view = await evoQr();
    // Before the fix this was the same string a refused connection produced.
    expect(view.error).not.toBe("weai_mini_too_slow_means_dead");
    expect(view.error).toBeUndefined();
  }, 20_000);

  test("a genuinely refused connection is still reported as unreachable", async () => {
    // @ts-expect-error test stub
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
    const view = await evoQr();
    expect(view.error).toBe("weai_mini_unreachable");
    expect(view.qr).toBeUndefined();
  });

  test("the state read keeps its short ceiling: a wedged bridge cannot pin the panel", async () => {
    expect(UPSTREAM_BUDGETS.state).toBe(5_000);
    slowFetch(30_000, { instance: { state: "open" } });
    const t0 = Date.now();
    const view = await evoStatus();
    const took = Date.now() - t0;
    expect(took).toBeLessThan(UPSTREAM_BUDGETS.state + 2_000);
    expect(view.state).toBe("unreachable");
    // And it says "slow", which is a different problem from "down".
    expect(view.detail).toContain("tard");
  }, 40_000);
});

describe("E44 · a rate limit the call cannot spend by itself", () => {
  test("the pairing floor outlasts the call that spends it", () => {
    // The old floor equalled the old clock, so a slow call consumed the whole
    // window on its own and the limiter never spoke (measured: 6 logins, 0 refusals).
    expect(PAIRING_INTERVALS.connect).toBeGreaterThan(UPSTREAM_BUDGETS.connect);
  });

  test("repeated clicks on a slow bridge stop hitting the upstream", async () => {
    // Each connect call regenerates the WhatsApp login: this is the thing the
    // limiter exists to prevent.
    // 8 s is the measured slow-bridge case: the call itself outlasts the OLD
    // 5 s floor, so each click spent the whole window and the limiter never spoke.
    slowFetch(8_000, { base64: "data:image/png;base64,AAAA" });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await evoQr()).error);
    const upstream = results.filter((e) => e === undefined).length;
    const limited = results.filter((e) => e === "qr_rate_limited").length;
    expect(upstream).toBe(1);
    expect(limited).toBe(4);
    expect(calls.filter((u) => u.includes("/instance/connect/"))).toHaveLength(1);
  }, 60_000);

  test("a fast bridge still gets exactly one call per window", async () => {
    quickFetch({ base64: "data:image/png;base64,AAAA" });
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await evoQr()).error);
    expect(results.filter((e) => e === undefined)).toHaveLength(1);
    expect(results.filter((e) => e === "qr_rate_limited")).toHaveLength(3);
  });
});
