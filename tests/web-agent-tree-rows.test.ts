/** The sidebar's agent-tree rows: flattening, per-path dedupe (a resumed run can list
 *  one delegate twice), and the live/total counters. */
import { describe, expect, test } from "bun:test";
import { viewOf, type SessionBots } from "../web/src/lib/agentTreeRows";
import type { AgentNode } from "../web/src/lib/types";

function node(over: Partial<AgentNode> & { path: string; children?: AgentNode[] }): AgentNode {
  const { path, children = [], ...rest } = over;
  return {
    name: path.split("/").pop() ?? path,
    path,
    sessionId: `sid-${path}`,
    agent: "",
    origin: "delegate",
    from: "parent",
    state: "running",
    exitStatus: "",
    model: "",
    task: "do things",
    steps: 0,
    cost: 0,
    lastCommand: "",
    awaiting: "",
    waitingChildren: [],
    startedAt: 0,
    lastActivity: 0,
    children,
    ...rest,
  };
}

describe("viewOf", () => {
  test("flattens a tree depth-first, children after their parent", () => {
    const v = viewOf({
      nodes: [node({ path: "login", children: [node({ path: "login/backend" })] }), node({ path: "writer" })],
    });
    expect(v.rows.map((r) => r.path)).toEqual(["login", "login/backend", "writer"]);
    expect(v.rows.map((r) => r.depth)).toEqual([0, 1, 0]);
  });

  test("a resumed run listing the same delegate twice yields one row per path (first wins)", () => {
    const v = viewOf({
      nodes: [
        node({ path: "login", state: "waiting", exitStatus: "Submitted", children: [node({ path: "login/backend", state: "running" })] }),
        // The duplicate the resume left behind: same path, stale state.
        node({ path: "login", state: "running" }),
      ],
    });
    expect(v.rows.map((r) => r.path)).toEqual(["login", "login/backend"]);
    expect(v.rows.find((r) => r.path === "login")?.label).toBe("done");
  });

  test("duplicate keys never reach the rows the sidebar's keyed each renders", () => {
    const v = viewOf({
      nodes: [
        node({ path: "a/b", children: [node({ path: "a/b/c" })] }),
        node({ path: "a/b/c" }), // dup at depth 0
        node({ path: "a/b" }), // dup of an interior path
      ],
    });
    const paths = v.rows.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(["a/b", "a/b/c"]);
  });

  test("live and total count the deduped rows only", () => {
    const v = viewOf({
      nodes: [node({ path: "one", state: "running" }), node({ path: "one" }), node({ path: "two", state: "dead" })],
    });
    expect(v).toMatchObject({ live: 1, total: 2 } satisfies Pick<SessionBots, "live" | "total">);
  });

  test("an empty tree gives the empty view", () => {
    expect(viewOf({ nodes: [] })).toEqual({ rows: [], live: 0, total: 0 });
  });
});
