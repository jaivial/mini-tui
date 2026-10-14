/** The agents accordion's rules: an agent's mood, and the subagent tree under a bot. */
import { describe, expect, test } from "bun:test";
import { agentMood, subagentRows, subRowLabel, type SubRow } from "../web/src/lib/agents";
import type { SubagentView } from "../web/src/lib/types";

const view = (sessionId: string, state = "running", name = sessionId): SubagentView => ({
  sessionId,
  name,
  state,
  exitStatus: "",
  steps: 3,
  cost: 0.1,
  task: `do ${sessionId}`,
  lastCommand: "",
  memRss: 0,
  memAvg: 0,
  memPeak: 0,
});

describe("agentMood", () => {
  test("an agent with no bots, or only new chats, just floats", () => {
    expect(agentMood([])).toBe("idle");
    expect(agentMood([{ status: null }, { status: null }])).toBe("idle");
  });
  test("any bot working and the agent is thinking", () => {
    expect(agentMood([{ status: "done" }, { status: "running" }])).toBe("thinking");
  });
  test("a snag beats happiness: an error among finished bots is a break", () => {
    expect(agentMood([{ status: "done" }, { status: "error" }])).toBe("break");
    expect(agentMood([{ status: "done" }, { status: "interrupted" }])).toBe("break");
  });
  test("all finished and well: celebrate", () => {
    expect(agentMood([{ status: "done" }, { status: "done" }])).toBe("happy");
  });
});

describe("subagentRows", () => {
  const roster: Record<string, SubagentView[] | undefined> = {
    root: [view("a"), view("b", "waiting")],
    a: [view("a1", "exited"), view("a2", "running", "deep-worker")],
    a1: [view("a1x", "running", "grandchild")],
    b: undefined,
  };
  const sessionOf = (id: string) => (id in roster ? { subagents: roster[id] } : undefined);

  test("walks the tree depth first, with each generation one level deeper", () => {
    const rows = subagentRows(sessionOf, "root");
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["grandchild", 2],
      ["deep-worker", 1],
      ["b", 0],
    ]);
  });

  test("a subagent the server has open contributes its own children; one that is not is a leaf", () => {
    const rows = subagentRows(sessionOf, "root");
    // "b" is waiting and has no roster of its own: a leaf. "a" is open here, so a1/a2 appear.
    expect(rows.find((r) => r.name === "b")?.depth).toBe(0);
    expect(rows.some((r) => r.name === "a1")).toBe(true);
  });

  test("a cycle (a roster naming an ancestor) stops instead of looping", () => {
    const cyclical: Record<string, SubagentView[] | undefined> = { root: [view("x")], x: [view("root")] };
    const rows = subagentRows((id) => (id in cyclical ? { subagents: cyclical[id] } : undefined), "root");
    expect(rows).toHaveLength(2); // x, then root listed as its child, then nothing
  });

  test("maxDepth caps how deep the tree goes", () => {
    const rows = subagentRows(sessionOf, "root", 1);
    expect(rows.some((r) => r.depth > 1)).toBe(false);
  });

  test("a bot with no session yet has no tree", () => {
    expect(subagentRows(sessionOf, null)).toEqual([]);
    expect(subagentRows(sessionOf, undefined)).toEqual([]);
  });

  test("the label says what it is and how far along", () => {
    const rows: SubRow[] = subagentRows(sessionOf, "root");
    const a = rows[0]!;
    expect(subRowLabel(a)).toContain("Subagent a");
    expect(subRowLabel(a)).toContain("3 steps");
  });
});
