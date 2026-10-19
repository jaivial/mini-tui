/** The panel's live feed, driven as the real code with injected timers, stream and fetch — the
 *  measurements of E55 turned into rules: a drop downgrades to the bridge and COMES BACK to the
 *  stream (the deployed copy polled for ever after one error), a hung read cannot silence it (the
 *  sidebar loop's deadline, in its third copy), a hidden tab does not poll, and becoming seen
 *  polls at once and retries the stream at once. No hand-written model: this IS the feed. */
import { describe, expect, test } from "bun:test";

import { AgentsFeed, type StreamHandlers } from "../web/src/lib/agentsFeed";
import { PACE_LIVE_MS, PACE_QUIET_MS } from "../web/src/lib/agentTreePoll";

interface FakeStream {
  id: string;
  handlers: StreamHandlers;
  closed: boolean;
}

interface PendingFetch {
  id: string;
  startedAt: number;
  settled: boolean;
  signal: AbortSignal;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

function harness(opts: { hidden?: boolean; autoResolve?: unknown } = {}) {
  let now = 0;
  let nextHandle = 1;
  let hidden = opts.hidden ?? false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const streams: FakeStream[] = [];
  const fetches: PendingFetch[] = [];
  const applied: unknown[] = [];
  const errors: string[] = [];

  const feed = new AgentsFeed({
    fetchView: (id, signal) =>
      new Promise((resolve, reject) => {
        const entry: PendingFetch = {
          id,
          startedAt: now,
          settled: false,
          signal,
          resolve: (v) => {
            entry.settled = true;
            resolve(v);
          },
          reject: (e) => {
            entry.settled = true;
            reject(e);
          },
        };
        fetches.push(entry);
        signal.addEventListener("abort", () => {
          if (!entry.settled) entry.reject(new DOMException("aborted", "AbortError"));
        });
        // A reader that answers by itself (the cases that care about pacing, not about hangs).
        if ("autoResolve" in opts) queueMicrotask(() => entry.resolve(opts.autoResolve ?? { nodes: [] }));
      }),
    openStream: (id, handlers) => {
      const stream: FakeStream = { id, handlers, closed: false };
      streams.push(stream);
      return () => {
        stream.closed = true;
      };
    },
    apply: (v) => applied.push(v),
    onError: (m) => errors.push(m),
    hasLive: () => false,
    hidden: () => hidden,
    now: () => now,
    setTimer: (fn, ms) => {
      const h = nextHandle++;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    reconnect: { random: () => 1 }, // delay = the ceiling exactly: the tests can count
  });

  /** Fake time, faithful to the runtime: every timer callback is its own task, and the promise
   *  callbacks it queues run BEFORE the next timer (the deadline's `done()` must free the read's
   *  slot before the next tick looks). */
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const [h, t] of timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [h, t];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    now = target;
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  return {
    feed,
    advance,
    flush,
    streams,
    fetches,
    applied,
    errors,
    timers,
    setHidden(v: boolean) {
      hidden = v;
    },
    get now() {
      return now;
    },
  };
}

describe("the panel's agents feed", () => {
  test("live first: a connected stream delivers and nothing is fetched", async () => {
    const h = harness();
    h.feed.start("s1");
    expect(h.streams.length).toBe(1);
    h.streams[0]!.handlers.onMessage({ nodes: [] });
    await h.flush();
    await h.advance(60_000);
    expect(h.fetches.length).toBe(0);
    expect(h.applied.length).toBe(1);
    expect(h.feed.live).toBe(true);
  });

  test("a drop bridges the gap AND comes back to the stream (the deployed copy polled for ever)", async () => {
    const h = harness();
    h.feed.start("s1");
    h.streams[0]!.handlers.onMessage({ nodes: [1] });
    h.streams[0]!.handlers.onDown();
    expect(h.fetches.length).toBe(1); // the bridge covers the gap
    await h.advance(1_000); // the shared backoff's first delay (random pinned: exactly the ceiling)
    expect(h.streams.length).toBe(2); // THE rule: the stream is retried (deployed: never)
    h.streams[1]!.handlers.onMessage({ nodes: [2] });
    await h.flush();
    const fetchesAtHandover = h.fetches.length;
    await h.advance(30_000); // stream back: the bridge stands down
    expect(h.fetches.length).toBe(fetchesAtHandover);
    expect(h.applied.length).toBe(2);
    expect(h.feed.live).toBe(true);
  });

  test("a stream that lived long enough resets the backoff (a quiet stream is a working stream)", async () => {
    const h = harness();
    h.feed.start("s1");
    h.streams[0]!.handlers.onMessage({ nodes: [] });
    await h.advance(20_000); // quiet but up: 20 s of life
    h.streams[0]!.handlers.onDown();
    // One failure was already counted by this drop; the long life resets, so the delay is the
    // FIRST one again (1 000 ms with the ceiling pinned), not the doubled one.
    await h.advance(999);
    expect(h.streams.length).toBe(1);
    await h.advance(1);
    expect(h.streams.length).toBe(2);
  });

  test("a hung bridge read cannot silence the panel (the sidebar's deadline, third copy)", async () => {
    const h = harness();
    h.feed.start("s1");
    h.streams[0]!.handlers.onDown();
    // The first bridge read never answers: it holds its slot until the deadline abandons it.
    await h.advance(25_000);
    expect(h.fetches.length).toBeGreaterThanOrEqual(3); // deployed: exactly 1, for ever
    expect(h.fetches.every((f) => f.id === "s1")).toBe(true);
  });

  test("a hidden tab does not bridge-poll, and becoming seen polls at once", async () => {
    const h = harness({ hidden: true });
    h.feed.start("s1");
    h.streams[0]!.handlers.onDown();
    await h.advance(30_000);
    expect(h.fetches.length).toBe(0); // deployed: a hidden tab polled for ever at 4 s
    h.feed.resync(); // never wakes a hidden tab (E53's R2, pinned here too)
    await h.advance(0);
    expect(h.fetches.length).toBe(0);
    h.setHidden(false);
    h.feed.resync();
    await h.advance(0); // one task later, not on the next pace tick
    expect(h.fetches.length).toBe(1);
  });

  test("becoming seen also retries the stream at once when it is down", async () => {
    const h = harness({ hidden: true });
    h.feed.start("s1");
    h.streams[0]!.handlers.onDown();
    await h.advance(200); // still inside the backoff
    expect(h.streams.length).toBe(1);
    h.setHidden(false);
    h.feed.resync();
    expect(h.streams.length).toBe(2); // no waiting out the rest of the backoff
  });

  test("the bridge keeps the pace vocabulary of the sidebar (live 3 s / quiet 5 s)", async () => {
    const h = harness({ autoResolve: { nodes: [] } });
    h.feed.start("s1");
    h.streams[0]!.handlers.onDown();
    await h.advance(4_999);
    expect(h.fetches.length).toBe(1);
    await h.advance(1);
    expect(h.fetches.length).toBe(2); // quiet pace: PACE_QUIET_MS after the tick STARTED
    expect(PACE_QUIET_MS).toBe(5000);
    expect(PACE_LIVE_MS).toBe(3000);
  });

  test("a failed bridge read shows the reason and the next landing clears it", async () => {
    const h = harness();
    h.feed.start("s1");
    h.streams[0]!.handlers.onDown();
    h.fetches[0]!.reject(new Error("boom"));
    await h.flush();
    expect(h.errors.at(-1)).toBe("boom");
    await h.advance(PACE_QUIET_MS);
    h.fetches[1]!.resolve({ nodes: [] });
    await h.flush();
    expect(h.errors.at(-1)).toBe("");
    expect(h.applied.length).toBe(1);
  });

  test("stop() closes the stream and leaves nothing armed", async () => {
    const h = harness();
    h.feed.start("s1");
    h.streams[0]!.handlers.onDown(); // bridging + a retry armed
    h.feed.stop();
    expect(h.streams[0]!.closed).toBe(true);
    const fetches = h.fetches.length;
    const streams = h.streams.length;
    await h.advance(120_000);
    await h.flush();
    expect(h.fetches.length).toBe(fetches);
    expect(h.streams.length).toBe(streams);
  });

  test("starting another session drops the previous one cleanly", async () => {
    const h = harness();
    h.feed.start("s1");
    h.streams[0]!.handlers.onDown();
    const fetchesBefore = h.fetches.length;
    h.feed.start("s2");
    expect(h.streams.at(-1)!.id).toBe("s2");
    const streams = h.streams.length;
    await h.advance(60_000);
    await h.flush();
    expect(h.streams.length).toBe(streams); // no retry for the abandoned session
    expect(h.fetches.slice(fetchesBefore).every((f) => f.id === "s2")).toBe(true);
  });

  test("an openStream that THROWS synchronously is a drop, not a crash in a timer callback", async () => {
    const h = harness();
    let calls = 0;
    const feed = new AgentsFeed({
      fetchView: () => new Promise(() => {}),
      openStream: () => {
        calls++;
        if (calls === 1) throw new Error("refused at construction");
        return () => {};
      },
      apply: () => {},
      now: () => 0,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (x) => clearTimeout(x as ReturnType<typeof setTimeout>),
      reconnect: { random: () => 1 },
    });
    feed.start("s1"); // must not throw
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 1200)); // the backoff opens it again (real timers here)
    expect(calls).toBeGreaterThanOrEqual(2);
    feed.stop();
  });

  test("a dead stream that keeps dying backs off instead of hammering", async () => {
    const h = harness();
    h.feed.start("s1");
    const opened: number[] = [0];
    // Kill each new stream the moment it opens: the gaps must grow 1 s, 2 s, 4 s, 8 s, 15 s (the
    // pinned jitter = the ceiling). The deployed hub-less copies hammered at a flat gap.
    let last = 0;
    for (const gap of [1_000, 2_000, 4_000, 8_000]) {
      h.streams.at(-1)!.handlers.onDown();
      await h.advance(gap - 1);
      expect(h.streams.length).toBe(opened.length);
      await h.advance(1);
      opened.push(h.now - last);
      last = h.now;
      expect(h.streams.length).toBe(opened.length);
    }
    expect(opened.slice(1)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });
});
