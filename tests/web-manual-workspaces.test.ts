import { describe, expect, test } from "bun:test";
import { groupWorkspaces, loadPlace, savePlace, workspaceForCwd, PLACE_KEY, type LiveSession } from "../web/src/lib/savedWorkspaces";
import { workspaceForCwd as serverWorkspaceForCwd, type SavedWorkspace } from "../src/workspaces";
import type { HistoryItem } from "../web/src/lib/types";

const ws = (id: string, path: string, hostId?: string): SavedWorkspace => ({ id, name: id, path, ...(hostId ? { hostId } : {}), createdAt: 1, updatedAt: 1 });
const live = (id: string, cwd: string, extra: Partial<LiveSession> = {}): LiveSession => ({ id, title: id, cwd, status: "idle", createdAt: 10, updatedAt: 10, ...extra });
const saved = (id: string, cwd: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({ id, title: id, cwd, model: "m", task: "t", createdAt: 5, updatedAt: 5, apiCalls: 1, cost: 0, exitStatus: "Submitted", resumable: true, open: false, ...extra });

describe("workspaceForCwd (client)", () => {
  const list = [ws("root", "/work"), ws("api", "/work/api/"), ws("remote", "/work", "h1"), ws("slash", "/")];

  test("the deepest containing folder on the same host wins", () => {
    expect(workspaceForCwd(list, "/work/api/src")?.id).toBe("api");
    expect(workspaceForCwd(list, "/work/api")?.id).toBe("api");
    expect(workspaceForCwd(list, "/work/web")?.id).toBe("root");
    expect(workspaceForCwd(list, "/work", "h1")?.id).toBe("remote");
    expect(workspaceForCwd(list, "/elsewhere")?.id).toBe("slash");
    expect(workspaceForCwd(list, "/work/apis")?.id).toBe("root");
    expect(workspaceForCwd(list, "")).toBeUndefined();
    expect(workspaceForCwd([ws("a", "/a")], "/b")).toBeUndefined();
  });

  test("agrees with the server's rule", () => {
    for (const [cwd, host] of [["/work/api/x", undefined], ["/work", "h1"], ["/work/apis", undefined], ["/x", "h2"], ["/", undefined]] as const) {
      expect(workspaceForCwd(list, cwd, host)?.id).toBe(serverWorkspaceForCwd(list, cwd, host)?.id);
    }
  });
});

describe("groupWorkspaces", () => {
  test("live and saved sessions land under their workspace, newest first, without repeats", () => {
    const list = [ws("a", "/a"), ws("b", "/b")];
    const groups = groupWorkspaces(
      list,
      [live("l1", "/a/sub", { updatedAt: 30, status: "running" }), live("l2", "/b", { updatedAt: 20, status: "done" }), live("out", "/c")],
      { a: [saved("s1", "/a", { updatedAt: 25 }), saved("l1", "/a/sub")], b: [saved("s2", "/b", { updatedAt: 1, exitStatus: "" })] },
    );
    expect(groups.map((g) => g.workspace.id)).toEqual(["a", "b"]);
    expect(groups[0]!.rows.map((r) => [r.id, r.state, r.live])).toEqual([["l1", "working", true], ["s1", "done", false]]);
    expect(groups[0]!.running).toBe(1);
    expect(groups[1]!.rows.map((r) => [r.id, r.state])).toEqual([["l2", "done"], ["s2", "idle"]]);
  });

  test("queue sessions, subagents and excluded ids are not listed", () => {
    const groups = groupWorkspaces(
      [ws("a", "/a")],
      [live("d", "/a", { role: "dispatcher" }), live("w", "/a", { role: "worker" }), live("sub", "/a", { parentId: "x" }), live("keep", "/a")],
      { a: [saved("main", "/a"), saved("old", "/a")] },
      ["main"],
    );
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["keep", "old"]);
  });

  test("a live session is never also shown as a saved one, even under another workspace", () => {
    const groups = groupWorkspaces([ws("a", "/a"), ws("b", "/a/b")], [live("x", "/a/b")], { a: [saved("x", "/a/b")] });
    expect(groups[0]!.rows).toEqual([]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["x"]);
  });

  test("no workspaces, no groups", () => {
    expect(groupWorkspaces([], [live("x", "/a")], {})).toEqual([]);
  });
});

describe("the place this device was last", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  test("round-trips", () => {
    const s = memory();
    savePlace({ workspaceId: "w1", sessionId: "s1" }, s);
    expect(loadPlace(s)).toEqual({ workspaceId: "w1", sessionId: "s1" });
  });

  test("garbage reads as nowhere", () => {
    const s = memory();
    s.m.set(PLACE_KEY, "{not json");
    expect(loadPlace(s)).toEqual({ workspaceId: "", sessionId: "" });
    s.m.set(PLACE_KEY, JSON.stringify({ workspaceId: 3, sessionId: null }));
    expect(loadPlace(s)).toEqual({ workspaceId: "", sessionId: "" });
    expect(loadPlace(null)).toEqual({ workspaceId: "", sessionId: "" });
  });
});
