/** The live agents stream with ONE poller per session (E55): the deployed handler gave every open
 *  stream its own 2 s `setInterval` that rebuilt and serialized the same view — N tabs, N rebuilds
 *  per tick, all thrown away unless changed. Here the tick is shared, a push happens only on real
 *  change, and the timer dies with the last subscriber. Real timers injected, real cache in the
 *  integration case. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentsViewCache } from "../src/web/agentsCache";
import { AgentsStreamHub } from "../src/web/agentsStream";

function fakeTimers() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timers,
    setTimer(fn: () => void, ms: number) {
      const h = nextHandle++;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer(h: unknown) {
      timers.delete(h as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const [h, t] of timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [h, t];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = target;
    },
  };
}

describe("the agents stream hub", () => {
  test("N watchers on one session share ONE payload computation per tick", () => {
    const t = fakeTimers();
    let computes = 0;
    let payload = "A";
    const hub = new AgentsStreamHub({ payload: () => (computes++, payload), setTimer: t.setTimer, clearTimer: t.clearTimer });
    const got: Record<string, string[]> = { a: [], b: [], c: [] };
    for (const who of ["a", "b", "c"] as const) hub.subscribe("s1", (p) => got[who]!.push(p));
    t.advance(10_000); // 5 ticks of 2 s
    // 3 initial frames (one per subscriber at subscribe time) + 5 shared ticks = 8 computations.
    expect(computes).toBe(8);
    for (const who of ["a", "b", "c"] as const) {
      expect(got[who]!.filter((p) => p === "A").length).toBe(1); // one push, then silence
    }
    expect(hub.stats.ticks).toBe(5);
  });

  test("a push happens only when the payload really changed", () => {
    const t = fakeTimers();
    let payload = "A";
    const hub = new AgentsStreamHub({ payload: () => payload, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const got: string[] = [];
    hub.subscribe("s1", (p) => got.push(p));
    t.advance(6_000);
    payload = "B";
    t.advance(2_000);
    t.advance(2_000);
    expect(got).toEqual(["A", "B"]);
    expect(hub.stats.pushes).toBe(2);
  });

  test("a watcher that joins a quiet session gets the current payload at once", () => {
    const t = fakeTimers();
    let payload = "A";
    const hub = new AgentsStreamHub({ payload: () => payload, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const early: string[] = [];
    hub.subscribe("s1", (p) => early.push(p));
    t.advance(10_000);
    payload = "B";
    const late: string[] = [];
    hub.subscribe("s1", (p) => late.push(p));
    expect(late).toEqual(["B"]); // its own first frame, at once — and not everyone else's
    expect(early).toEqual(["A"]); // ...who had already been pushed B? No: they get it on the tick.
    t.advance(2_000);
    expect(early).toEqual(["A", "B"]);
  });

  test("the last one out turns the poller off", () => {
    const t = fakeTimers();
    let computes = 0;
    const hub = new AgentsStreamHub({ payload: () => (computes++, "A"), setTimer: t.setTimer, clearTimer: t.clearTimer });
    const stops = ["a", "b", "c"].map((who) => hub.subscribe("s1", () => void who));
    t.advance(4_000);
    const before = computes;
    stops[0]!();
    stops[1]!();
    t.advance(4_000);
    expect(computes).toBeGreaterThan(before); // one watcher left: it keeps ticking
    const mid = computes;
    stops[2]!();
    expect(hub.sessions).toEqual([]);
    t.advance(60_000);
    expect(computes).toBe(mid); // and a session with nobody watching computes nothing
  });

  test("a watcher whose send throws is dropped; the others go on", () => {
    const t = fakeTimers();
    let payload = "A";
    const hub = new AgentsStreamHub({ payload: () => payload, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const dead: string[] = [];
    const alive: string[] = [];
    hub.subscribe("s1", (p) => {
      dead.push(p);
      throw new Error("controller closed");
    });
    hub.subscribe("s1", (p) => alive.push(p));
    payload = "B";
    t.advance(2_000);
    expect(alive).toEqual(["A", "B"]);
    payload = "C";
    t.advance(2_000);
    expect(alive).toEqual(["A", "B", "C"]);
    expect(dead).toEqual(["A"]);
  });

  test("a payload that throws keeps the last good push (and the timer alive)", () => {
    const t = fakeTimers();
    let boom = false;
    const hub = new AgentsStreamHub({
      payload: () => {
        if (boom) throw new Error("cannot read the tree");
        return "A";
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    const got: string[] = [];
    hub.subscribe("s1", (p) => got.push(p));
    boom = true;
    t.advance(4_000);
    boom = false;
    t.advance(2_000);
    expect(got).toEqual(["A"]);
  });

  describe("with the real cache over real files", () => {
    let dir: string;
    let prevAgentsDir: string | undefined;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "agents-hub-"));
      prevAgentsDir = process.env.MINITUI_AGENTS_DIR;
      process.env.MINITUI_AGENTS_DIR = join(dir, "defs");
      mkdirSync(process.env.MINITUI_AGENTS_DIR, { recursive: true });
      const run = join(dir, "runs", "s1");
      mkdirSync(join(run, "subagents"), { recursive: true });
      writeFileSync(join(run, "traj.json"), "{}");
      writeFileSync(join(run, "subagents", "index.json"), JSON.stringify({ children: [{ name: "worker1", state: "running", task: "t", steps: 1, exit_status: "", started_at: 1, last_activity: 2, traj_path: "" }] }));
      writeFileSync(join(run, "subagents", "events.jsonl"), "");
    });
    afterEach(() => {
      if (prevAgentsDir === undefined) delete process.env.MINITUI_AGENTS_DIR;
      else process.env.MINITUI_AGENTS_DIR = prevAgentsDir;
      rmSync(dir, { recursive: true, force: true });
    });

    test("quiet watchers for 60 s cost ONE build, not thirty (the deployed cost)", () => {
      const t = fakeTimers();
      const cache = new AgentsViewCache();
      const traj = join(dir, "runs", "s1", "traj.json");
      const hub = new AgentsStreamHub({ payload: () => cache.get("s1", [traj]).fullJson, setTimer: t.setTimer, clearTimer: t.clearTimer });
      const got: string[][] = [[], [], []];
      for (let i = 0; i < 3; i++) hub.subscribe("s1", (p) => got[i]!.push(p));
      t.advance(60_000); // 30 ticks, 3 watchers
      expect(cache.stats.builds).toBe(1); // the deployed handler: 3 rebuilds x 30 ticks
      expect(hub.stats.ticks).toBe(30);
      for (const g of got) expect(g.length).toBe(1);
    });

    test("a roster change reaches every watcher on the next tick — one rebuild, three pushes", () => {
      const t = fakeTimers();
      const cache = new AgentsViewCache();
      const traj = join(dir, "runs", "s1", "traj.json");
      const hub = new AgentsStreamHub({ payload: () => cache.get("s1", [traj]).fullJson, setTimer: t.setTimer, clearTimer: t.clearTimer });
      const got: string[][] = [[], []];
      for (let i = 0; i < 2; i++) hub.subscribe("s1", (p) => got[i]!.push(p));
      t.advance(2_000);
      writeFileSync(join(dir, "runs", "s1", "subagents", "index.json"), JSON.stringify({ children: [{ name: "worker1", state: "waiting", task: "t", steps: 2, exit_status: "", started_at: 1, last_activity: 2, traj_path: "" }] }));
      t.advance(2_000);
      expect(cache.stats.builds).toBe(2);
      expect(got[0]!.length).toBe(2);
      expect(got[1]!.length).toBe(2);
      expect(JSON.parse(got[0]![1]!).nodes[0].state).toBe("waiting");
    });
  });
});
