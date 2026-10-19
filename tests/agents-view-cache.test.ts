/** The agents view is built only when its inputs moved (E55): a HIT is provably the same bytes —
 *  the stamps are taken at read time, `mtimeNs`-precise — and a build is a fresh read (the roster's
 *  own parse cache, keyed coarser, is dropped first so it cannot hand a rebuild the parse from
 *  before the file moved). Real files, real reads: no model of the cache. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, statSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentsViewWithInputs, agentsView, briefOf, inputIdentity } from "../src/web/agents";
import { AgentsViewCache } from "../src/web/agentsCache";

let dir: string;
let prevAgentsDir: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agents-cache-"));
  prevAgentsDir = process.env.MINITUI_AGENTS_DIR;
  process.env.MINITUI_AGENTS_DIR = join(dir, "defs");
  mkdirSync(process.env.MINITUI_AGENTS_DIR, { recursive: true });
});
afterEach(() => {
  if (prevAgentsDir === undefined) delete process.env.MINITUI_AGENTS_DIR;
  else process.env.MINITUI_AGENTS_DIR = prevAgentsDir;
  rmSync(dir, { recursive: true, force: true });
});

/** A session's run dir with one delegate (`worker1`), like a hub leaves on disk. */
function writeTree(id: string, names: string[], events: string[] = []) {
  const run = join(dir, "runs", id);
  mkdirSync(join(run, "subagents"), { recursive: true });
  writeFileSync(join(run, "traj.json"), "{}");
  writeFileSync(
    join(run, "subagents", "index.json"),
    JSON.stringify({
      children: names.map((n) => ({
        name: n, state: "running", task: `${n} task`, steps: 1, exit_status: "",
        started_at: 1000, last_activity: 2000, traj_path: join(dir, "runs", id, "subagents", n, "traj.json"),
      })),
    }),
  );
  mkdirSync(join(run, "subagents", names[0] ?? "worker1", "subagents"), { recursive: true });
  writeFileSync(join(run, "subagents", "events.jsonl"), events.map((t) => JSON.stringify({ at: 1, kind: "delegate", from: "parent", to: "worker1", text: t })).join("\n") + (events.length ? "\n" : ""));
  return join(run, "traj.json");
}

describe("the view cache", () => {
  test("a quiet tree is built ONCE however often it is asked for", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    for (let i = 0; i < 10; i++) cache.get("s1", [traj]);
    expect(cache.stats.builds).toBe(1);
    expect(cache.stats.hits).toBe(9);
  });

  test("every answer after the first says it did not rebuild", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    expect(cache.get("s1", [traj]).rebuilt).toBe(true);
    expect(cache.get("s1", [traj]).rebuilt).toBe(false);
  });

  test("a roster rewrite rebuilds even same-size with IDENTICAL timestamps (measured: same-ms writes share mtimeNs AND ctimeNs)", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    const first = cache.get("s1", [traj]);
    expect(first.view.nodes.map((n) => n.name)).toEqual(["worker1"]);
    const index = join(dir, "runs", "s1", "subagents", "index.json");
    const before = statSync(index);
    // Same byte length ("worker1" -> "worker2") and the mtime FORCED back to the previous value:
    // every timestamp identity is identical to what the build saw. The content is not — and a
    // `"state": "running"` -> `"state": "waiting"` rewrite is exactly this shape (same size).
    writeFileSync(index, JSON.stringify({
      children: [{ name: "worker2", state: "running", task: "worker2 task", steps: 1, exit_status: "", started_at: 1000, last_activity: 2000, traj_path: "" }],
    }));
    utimesSync(index, before.atime, before.mtime);
    const second = cache.get("s1", [traj]);
    expect(second.rebuilt).toBe(true);
    expect(second.view.nodes.map((n) => n.name)).toEqual(["worker2"]);
  });

  test("a rewrite that changes NOTHING is not a rebuild (the answer was already right)", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    cache.get("s1", [traj]);
    const index = join(dir, "runs", "s1", "subagents", "index.json");
    writeFileSync(index, readFileSync(index, "utf8"));
    expect(cache.get("s1", [traj]).rebuilt).toBe(false);
    expect(cache.stats.builds).toBe(1);
  });

  test("an appended event rebuilds and lands in the view", () => {
    const traj = writeTree("s1", ["worker1"], ["hello"]);
    const cache = new AgentsViewCache();
    expect(cache.get("s1", [traj]).view.events.length).toBe(1);
    appendFileSync(join(dir, "runs", "s1", "subagents", "events.jsonl"), JSON.stringify({ at: 2, kind: "handoff", from: "parent", to: "worker1", text: "second" }) + "\n");
    const again = cache.get("s1", [traj]);
    expect(again.rebuilt).toBe(true);
    expect(again.view.events.length).toBe(2);
  });

  test("a subtree that appears rebuilds (absence -> presence of the child's files)", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    expect(cache.get("s1", [traj]).view.nodes[0]!.children.length).toBe(0);
    // The hub adds a grandchild: the child's own roster appears under it.
    const kid = join(dir, "runs", "s1", "subagents", "worker1", "subagents");
    mkdirSync(kid, { recursive: true });
    writeFileSync(join(kid, "index.json"), JSON.stringify({ children: [{ name: "grand", state: "waiting", task: "t", steps: 1, exit_status: "", started_at: 1, last_activity: 2, traj_path: "" }] }));
    const again = cache.get("s1", [traj]);
    expect(again.rebuilt).toBe(true);
    expect(again.view.nodes[0]!.children.map((n) => n.name)).toEqual(["grand"]);
  });

  test("a changed agent def rebuilds", () => {
    const traj = writeTree("s1", ["worker1"]);
    writeFileSync(join(dir, "defs", "translator.json"), JSON.stringify({ name: "translator", description: "first" }));
    const cache = new AgentsViewCache();
    expect(cache.get("s1", [traj]).view.defs.find((d) => d.name === "translator")?.description).toBe("first");
    writeFileSync(join(dir, "defs", "translator.json"), JSON.stringify({ name: "translator", description: "second" }));
    const again = cache.get("s1", [traj]);
    expect(again.rebuilt).toBe(true);
    expect(again.view.defs.find((d) => d.name === "translator")?.description).toBe("second");
  });

  test("a def that appears is caught by the dir's own stamp", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    expect(cache.get("s1", [traj]).view.defs.some((d) => d.name === "reviewer")).toBe(false);
    writeFileSync(join(dir, "defs", "reviewer.json"), JSON.stringify({ name: "reviewer", description: "checks" }));
    const again = cache.get("s1", [traj]);
    expect(again.rebuilt).toBe(true);
    expect(again.view.defs.some((d) => d.name === "reviewer")).toBe(true);
  });

  test("a whole run dir added to the session rebuilds (it is part of the key)", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    expect(cache.get("s1", [traj]).view.nodes.length).toBe(1);
    const traj2 = join(dir, "runs", "s1-two", "traj.json");
    writeTree("s1-two", ["worker9"]);
    expect(cache.get("s1", [traj, traj2]).view.nodes.length).toBe(2);
  });

  test("the full payload is serialized ONCE per build, not per ask", () => {
    const traj = writeTree("s1", ["worker1"]);
    const cache = new AgentsViewCache();
    const a = cache.get("s1", [traj]).fullJson;
    const b = cache.get("s1", [traj]).fullJson;
    expect(a).toBe(b); // same string instance for a hit — the tick must not re-serialize 34 kB
    expect(JSON.parse(a).nodes.length).toBe(1);
  });

  test("brief is the rows only: no events, no defs", () => {
    const traj = writeTree("s1", ["worker1"], ["hello"]);
    const view = agentsView("s1", [traj]);
    const brief = briefOf(view);
    expect(Object.keys(brief).sort()).toEqual(["nodes", "sessionId"]);
    expect(brief.nodes).toEqual(view.nodes);
    expect(JSON.stringify(brief).length).toBeLessThan(JSON.stringify(view).length);
  });

  test("a session with no run dir is stable (one build, no churn)", () => {
    const cache = new AgentsViewCache();
    for (let i = 0; i < 5; i++) cache.get("ghost", [join(dir, "runs", "ghost", "traj.json")]);
    expect(cache.stats.builds).toBe(1);
    expect(cache.get("ghost", [join(dir, "runs", "ghost", "traj.json")]).view.nodes).toEqual([]);
  });

  test("a build records the identity of everything it read, and every identity re-derives", () => {
    const traj = writeTree("s1", ["worker1"], ["hello"]);
    const built = agentsViewWithInputs("s1", [traj]);
    const keys = [...built.inputs.stamps.keys()];
    expect(keys.length).toBeGreaterThan(0);
    // One key per kind: the roster (content), the log (size + stamps), the defs listing and files.
    expect(keys.some((k) => k.startsWith("bytes:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("log:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("list:"))).toBe(true);
    for (const [key, seen] of built.inputs.stamps) expect(inputIdentity(key)).toBe(seen);
    // A write that lands after the build flips the identity the entry would keep.
    const index = join(dir, "runs", "s1", "subagents", "index.json");
    writeFileSync(index, readFileSync(index, "utf8").replace("worker1", "worker2"));
    expect([...built.inputs.stamps].some(([k, seen]) => k === `bytes:${index}` && inputIdentity(k) !== seen)).toBe(true);
  });
});
