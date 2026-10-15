/** The sidebar's bot groups (a partition) and the team map's wording for a pet's state.
 *
 *  Regression 1: the three groups were three independent `filter`s over the same list. `idle`
 *  excluded only "running" and "done", so `error` and `interrupted` matched BOTH `idle` and
 *  `done` — the session rendered twice and threw `each_key_duplicate` on every page load.
 *
 *  Regression 2: a session node on the team map showed the RAW status ("interrupted", "error")
 *  next to delegate rows saying "working"/"done", so the same map spoke two languages. */
import { describe, expect, test } from "bun:test";
import { bucketOf, partitionBots, mapLabel, mapTone } from "../web/src/lib/botGroups";
import type { SessionState, SessionStatus } from "../web/src/lib/types";

const ALL: SessionStatus[] = ["idle", "running", "done", "error", "interrupted"];

function sess(id: string, status: SessionStatus, startedAt = 0): SessionState {
  return {
    id,
    title: id,
    cwd: "/tmp",
    model: "m",
    status,
    task: "",
    updatedAt: startedAt,
    startedAt,
  } as unknown as SessionState;
}

const byStart = (a: SessionState, b: SessionState) => a.startedAt - b.startedAt;

describe("bucketOf", () => {
  test("every status lands in exactly one bucket", () => {
    for (const s of ALL) expect(["live", "idle", "done"]).toContain(bucketOf(s));
    expect(bucketOf("running")).toBe("live");
    expect(bucketOf("idle")).toBe("idle");
    expect(bucketOf("done")).toBe("done");
  });

  test("error and interrupted are finished, never idle (the duplicate)", () => {
    expect(bucketOf("error")).toBe("done");
    expect(bucketOf("interrupted")).toBe("done");
  });
});

describe("partitionBots", () => {
  test("is a partition: every session appears exactly once", () => {
    const list = ALL.map((s, i) => sess(s, s, i));
    const g = partitionBots(list, byStart);
    const all = [...g.live, ...g.idle, ...g.done];
    expect(all).toHaveLength(list.length);
    expect(new Set(all.map((s) => s.id)).size).toBe(list.length);
  });

  test("an interrupted session is not duplicated (the each_key_duplicate crash)", () => {
    const g = partitionBots([sess("x", "interrupted")], byStart);
    expect(g.idle).toHaveLength(0);
    expect(g.done.map((s) => s.id)).toEqual(["x"]);
  });

  test("an errored session is not duplicated either", () => {
    const g = partitionBots([sess("y", "error")], byStart);
    expect(g.idle).toHaveLength(0);
    expect(g.done.map((s) => s.id)).toEqual(["y"]);
  });

  test("live rows keep the order they were started in", () => {
    const g = partitionBots([sess("l3", "running", 30), sess("l1", "running", 10), sess("l2", "running", 20)], byStart);
    expect(g.live.map((s) => s.id)).toEqual(["l1", "l2", "l3"]);
  });

  test("an empty list yields three empty groups", () => {
    expect(partitionBots([], byStart)).toEqual({ live: [], idle: [], done: [] });
  });
});

describe("the team map's wording", () => {
  test("never leaks a raw status word into the UI", () => {
    // "idle" and "done" read the same in both vocabularies; the other three used to leak.
    for (const s of ["running", "error", "interrupted"] as SessionStatus[]) {
      const label = mapLabel(s);
      expect(label).not.toBe(s); // "error" -> "failed", "interrupted" -> "stopped"
      expect(label).toMatch(/^[a-z]+$/);
    }
  });

  test("matches the delegate vocabulary the map already used", () => {
    expect(mapLabel("running")).toBe("working");
    expect(mapLabel("done")).toBe("done");
    expect(mapLabel("idle")).toBe("idle");
    expect(mapLabel("interrupted")).toBe("stopped");
    expect(mapLabel("error")).toBe("failed");
  });

  test("a working node is live and the rest are quiet", () => {
    expect(mapTone("running")).toBe("live");
    for (const s of ALL.filter((x) => x !== "running")) expect(mapTone(s)).not.toBe("live");
  });

  test("a stopped session is not coloured like a healthy one", () => {
    expect(mapTone("done")).toBe("ok");
    expect(mapTone("error")).toBe("err");
    expect(mapTone("interrupted")).toBe("warn");
  });
});