/**
 * The queue stream's reconnect, against a stream that keeps failing (E50).
 *
 * This was the fourth copy of the reconnect machinery in `web/src/lib`, and the one with no backoff
 * at all: a flat 5 s retry forever, whatever the failure. It now takes its delay from `Reconnect`,
 * like the hub, the per-session socket and the sessions stream.
 */
import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
const realEs = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEs;
});

class StubSource {
  static all: StubSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    StubSource.all.push(this);
    // The server accepts the stream and drops it right away, every time.
    setTimeout(() => this.onerror?.(), 1);
  }
  addEventListener() {}
  close() {}
}

function run(ms: number): Promise<number> {
  StubSource.all = [];
  (globalThis as { EventSource?: unknown }).EventSource = StubSource;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ nodes: [], edges: [] }), { status: 200 })) as unknown as typeof fetch;
  return import("../web/src/lib/queueEventsClient").then(({ QueueEventsClient }) => {
    const client = new QueueEventsClient("/api", { baseDelay: 10, maxDelay: 40, random: () => 1 });
    const release = client.watch(() => {});
    return new Promise<number>((resolve) => {
      setTimeout(() => {
        const attempts = StubSource.all.length;
        release(); // stop the loop so nothing keeps running past the test
        resolve(attempts);
      }, ms);
    });
  });
}

describe("the queue stream backs off", () => {
  test("a stream that keeps failing retries with widening gaps, not on a flat clock", async () => {
    const attempts = await run(300);
    // Backoff 10 + 20 + 40 + 40 ... ≈ 8 attempts in 300 ms. The old flat 5 s made exactly 1.
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(attempts).toBeLessThanOrEqual(12);
  });
});
