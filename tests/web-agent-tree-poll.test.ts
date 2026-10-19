/** The sidebar's agent-tree loop, driven as the real code with an injected clock and timers — the
 *  measurements of E54 turned into rules: the pace measures the work it covers, a slow or hung
 *  sibling cannot stretch or silence another session, and a hidden tab is suspended and polls at
 *  once when seen again. (No hand-written model of the loop: this IS the loop — E51's lesson.) */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { AgentTreePoll, PACE_LIVE_MS, PACE_QUIET_MS } from "../web/src/lib/agentTreePoll";

interface PendingRead {
  id: string;
  startedAt: number;
  signal: AbortSignal;
  settled: boolean;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

function harness(opts: { deadlineMs?: number; hidden?: boolean; live?: boolean; throwFirst?: boolean } = {}) {
  let now = 0;
  let nextHandle = 1;
  let hidden = opts.hidden ?? false;
  let live = opts.live ?? true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const pending: PendingRead[] = [];
  const starts: Record<string, number[]> = {};
  const applied: Array<{ id: string; view: unknown; at: number }> = [];
  const aborts: Array<{ id: string; at: number }> = [];
  let timerArms = 0;

  const deps = {
    read(id: string, signal: AbortSignal) {
      (starts[id] ??= []).push(now);
      if (opts.throwFirst) {
        opts.throwFirst = false;
        throw new Error("sync throw from the reader");
      }
      return new Promise((resolve, reject) => {
        const entry: PendingRead = {
          id,
          startedAt: now,
          signal,
          settled: false,
          resolve: (v) => {
            entry.settled = true;
            resolve(v);
          },
          reject: (e) => {
            entry.settled = true;
            reject(e);
          },
        };
        pending.push(entry);
        // A real fetch rejects with AbortError when its signal fires; the loop must see that.
        signal.addEventListener("abort", () => {
          aborts.push({ id, at: now });
          if (!entry.settled) entry.reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
    apply(id: string, view: unknown) {
      applied.push({ id, view, at: now });
    },
    hasLive: () => live,
    hidden: () => hidden,
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      timerArms++;
      const h = nextHandle++;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer(handle: unknown) {
      timers.delete(handle as number);
    },
    deadlineMs: opts.deadlineMs ?? 10_000,
  };
  const poll = new AgentTreePoll(deps);

  /** Fire every timer due within `ms`, in time order (each sees the clock at its own moment). */
  function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const find = (id: string) => pending.filter((p) => p.id === id && !p.settled);
  return {
    poll,
    advance,
    flush,
    starts,
    applied,
    aborts,
    pending,
    find,
    setHidden: (v: boolean) => {
      hidden = v;
    },
    setLive: (v: boolean) => {
      live = v;
    },
    get now() {
      return now;
    },
    get timerArms() {
      return timerArms;
    },
  };
}

describe("the loop's pace measures the work it covers", () => {
  test("a read that takes 500ms does not become 500ms of everyone's period", async () => {
    const h = harness();
    h.poll.sync(["a"]);
    h.advance(0); // tick at t=0: read starts
    expect(h.starts.a).toEqual([0]);
    h.advance(500); // the read takes 500 ms...
    h.find("a")[0]!.resolve({ rows: [1], live: 1, total: 1 });
    await h.flush();
    h.advance(2499); // ...and the next read is still paced from the tick's START
    expect(h.starts.a).toEqual([0]);
    h.advance(1);
    expect(h.starts.a).toEqual([0, 3000]);
  });

  test("the quiet pace is the slow one, the live pace the fast one", async () => {
    const h = harness({ live: false });
    h.poll.sync(["a"]);
    h.advance(0);
    h.find("a")[0]!.resolve({ rows: [], live: 0, total: 0 });
    await h.flush();
    h.advance(PACE_QUIET_MS - 1);
    expect(h.starts.a).toEqual([0]);
    h.advance(1);
    expect(h.starts.a).toEqual([0, PACE_QUIET_MS]);
    // The pace is chosen when a tick STARTS (the loop deliberately awaits no read): a tree that
    // comes alive speeds the next tick, not the sleep already underway.
    h.setLive(true);
    h.find("a")[0]!.resolve({ rows: [], live: 1, total: 1 });
    await h.flush();
    h.advance(PACE_QUIET_MS);
    expect(h.starts.a).toEqual([0, PACE_QUIET_MS, PACE_QUIET_MS * 2]);
    h.find("a")[0]!.resolve({ rows: [], live: 1, total: 1 });
    await h.flush();
    h.advance(PACE_LIVE_MS);
    expect(h.starts.a).toEqual([0, PACE_QUIET_MS, PACE_QUIET_MS * 2, PACE_QUIET_MS * 2 + PACE_LIVE_MS]);
  });
});

describe("one session's trouble is only its own", () => {
  test("a sibling's 8s read does not stretch another session's cadence", async () => {
    const h = harness();
    h.poll.sync(["a", "b"]);
    h.advance(0);
    // b hangs on a slow read: its promise never settles
    for (let i = 0; i < 3; i++) {
      h.find("a")[0]!.resolve({ rows: [], live: 1, total: 0 });
      await h.flush();
      h.advance(PACE_LIVE_MS);
    }
    expect(h.starts.a).toEqual([0, 3000, 6000, 9000]); // not 11000+ as with sleep-after-completion
  });

  test("a hung sibling does not silence the others (0 in 25s was the measured freeze)", async () => {
    const h = harness();
    h.poll.sync(["a", "b"]);
    h.advance(0);
    for (let t = 0; t < 25; t += 1) {
      for (const p of h.find("a")) p.resolve({ rows: [], live: 1, total: 0 });
      await h.flush();
      h.advance(1000);
    }
    expect(h.starts.a.length).toBe(9); // one per pace, hung sibling aside
    // and the hung session does not stack reads: at most one in flight for it
    expect(h.find("b").length).toBeLessThanOrEqual(1);
  });

  test("a hung read is abandoned at its deadline and retried later, never stacked", async () => {
    const h = harness({ deadlineMs: 10_000 });
    h.poll.sync(["b"]);
    h.advance(0);
    expect(h.starts.b).toEqual([0]);
    h.advance(10_000); // the deadline aborts the read
    await h.flush();
    expect(h.aborts).toEqual([{ id: "b", at: 10_000 }]);
    h.advance(PACE_LIVE_MS); // the next tick retries it
    await h.flush();
    expect(h.starts.b).toEqual([0, 12_000]);
    expect(h.find("b").length).toBe(1);
  });

  test("a read that fails keeps the last good tree and the next tick retries", async () => {
    const h = harness();
    h.poll.sync(["a"]);
    h.advance(0);
    h.find("a")[0]!.resolve({ rows: ["good"], live: 1, total: 1 });
    await h.flush();
    h.advance(PACE_LIVE_MS);
    h.find("a")[0]!.reject(new Error("network"));
    await h.flush();
    expect(h.applied.map((a) => a.view)).toEqual([{ rows: ["good"], live: 1, total: 1 }]);
    h.advance(PACE_LIVE_MS);
    expect(h.starts.a.length).toEqual(3);
  });

  test("a session dropped mid-read has its answer discarded and its read aborted", async () => {
    const h = harness();
    h.poll.sync(["a"]);
    h.advance(0);
    const read = h.find("a")[0]!;
    h.poll.sync([]);
    expect(h.aborts).toEqual([{ id: "a", at: 0 }]);
    read.resolve({ rows: ["ghost"], live: 1, total: 1 });
    await h.flush();
    expect(h.applied).toEqual([]); // "a session that closed mid-tick: drop it rather than remember a ghost"
    h.advance(PACE_QUIET_MS * 3);
    expect(h.starts.a).toEqual([0]); // and a dropped session is not polled
  });

  test("a set that changes does not reset the cadence; a gained session is read at once", async () => {
    const h = harness();
    h.poll.sync(["a"]);
    h.find("a")[0]!.resolve({ rows: [], live: 1, total: 0 });
    await h.flush();
    h.advance(1000); // t=1000: a second session shows up in the sidebar
    h.poll.sync(["a", "b"]);
    expect(h.starts.b).toEqual([1000]); // its first read is NOW, not at the next tick
    h.find("b")[0]!.resolve({ rows: [], live: 1, total: 0 });
    await h.flush();
    h.advance(1999); // the cadence is the loop's: still paced from the first read, not the change
    expect(h.starts.a).toEqual([0]);
    h.advance(1);
    expect(h.starts.a).toEqual([0, 3000]);
    h.poll.sync(["a"]); // a drop is not a kick either
    expect(h.starts.a).toEqual([0, 3000]);
  });

  test("a reader that throws synchronously is not a crash and the tick retries", async () => {
    const h = harness({ throwFirst: true });
    h.poll.sync(["a"]); // first read throws; the loop must survive its own reader
    await h.flush();
    h.advance(0);
    h.advance(PACE_LIVE_MS);
    expect(h.starts.a.length).toBe(2); // retried on the next tick
    h.find("a")[0]!.resolve({ rows: ["ok"], live: 1, total: 1 });
    await h.flush();
    expect(h.applied.length).toBe(1);
  });

  test("the same id list is not a fresh kick", async () => {
    const h = harness();
    h.poll.sync(["a", "b"]);
    h.poll.sync(["b", "a"]);
    h.advance(0);
    expect(h.starts.a).toEqual([0]);
    expect(h.starts.b).toEqual([0]);
  });
});

describe("a hidden tab is suspended and polls at once when seen", () => {
  test("hidden: no reads at all (12 in 25s was the measured drain)", async () => {
    const h = harness({ hidden: true });
    h.poll.sync(["a"]);
    h.advance(25_000);
    await h.flush();
    expect(h.starts.a ?? []).toEqual([]);
  });

  test("resync does not wake a hidden tab (E53's R2, pinned here too)", async () => {
    const h = harness({ hidden: true });
    h.poll.sync(["a"]);
    const armsAfterSync = h.timerArms;
    h.poll.resync();
    // Not "no read happens" (the tick would see `hidden` anyway) but NO WAKE: not even a timer is
    // armed for a tab that draws nothing — the E53 bug was a resync that rearmed a hidden tab.
    expect(h.timerArms).toBe(armsAfterSync);
    h.advance(30_000);
    await h.flush();
    expect(h.starts.a ?? []).toEqual([]);
  });

  test("becoming visible polls immediately, not at the next scheduled tick", async () => {
    const h = harness({ hidden: true });
    h.poll.sync(["a"]);
    h.advance(5_000);
    h.setHidden(false);
    h.poll.resync();
    h.advance(0);
    expect(h.starts.a).toEqual([5_000]); // the deployed loop answered at the next pace (measured +6s)
  });

  test("hidden mid-life suspends the loop until it is seen again", async () => {
    const h = harness();
    h.poll.sync(["a"]);
    h.advance(0);
    h.find("a")[0]!.resolve({ rows: [], live: 1, total: 0 });
    await h.flush();
    h.setHidden(true);
    h.advance(60_000);
    await h.flush();
    expect(h.starts.a).toEqual([0]); // one read, then silence while hidden
    h.setHidden(false);
    h.poll.resync();
    h.advance(0);
    expect(h.starts.a).toEqual([0, 60_000]);
  });
});

describe("the loop lives in one file (source guard)", () => {
  const web = join(import.meta.dir, "..", "web", "src", "lib");
  const code = (f: string) =>
    readFileSync(f.startsWith("/") ? f : join(web, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : statSync(join(dir, e.name)).isFile() ? [join(dir, e.name)] : [],
    );
  const rel = (p: string) => p.split("/web/src/lib/")[1]!;

  test("the policy neither finds a clock nor touches the page", () => {
    const c = code("agentTreePoll.ts");
    expect({ date: c.includes("Date.now("), doc: c.includes("document."), interval: c.includes("setInterval(") }).toEqual({ date: false, doc: false, interval: false });
  });

  test("the store is wiring only: no loop, no cadence of its own", () => {
    const c = code("stores/agentTree.svelte.ts");
    expect({ promiseAll: c.includes("Promise.all("), loop: /\bwhile\s*\(/.test(c), interval: c.includes("setInterval("), pace: c.includes("3000") || c.includes("5000") }).toEqual({ promiseAll: false, loop: false, interval: false, pace: false });
  });

  test("only the store wires the poll", () => {
    const users = walk(web)
      .filter((f) => /\.(ts|svelte)$/.test(f))
      .filter((f) => code(f).includes("AgentTreePoll"))
      .map(rel)
      .sort();
    expect(users).toEqual(["agentTreePoll.ts", "stores/agentTree.svelte.ts"]);
  });
});
