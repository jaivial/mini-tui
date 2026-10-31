/** Saved workspaces (manual chat mode): the shared file, validation and cwd matching. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-ws-"));
const file = join(dir, "workspaces.json");
process.env.MINITUI_WORKSPACES_PATH = file;
const ws = await import("../src/workspaces");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(file, { force: true }));

describe("saved workspaces", () => {
  test("a local folder is added once, named after its basename by default", () => {
    const repo = join(dir, "repo-a");
    mkdirSync(repo, { recursive: true });
    const a = ws.addWorkspace({ path: repo });
    expect(a.name).toBe("repo-a");
    expect(a.path).toBe(repo);
    expect(a.hostId).toBeUndefined();
    const again = ws.addWorkspace({ path: `${repo}/` });
    expect(again.id).toBe(a.id);
    expect(ws.listWorkspaces()).toHaveLength(1);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.workspaces[0].path).toBe(repo);
  });

  test("adding an existing folder with a new name renames it", () => {
    const repo = join(dir, "repo-b");
    mkdirSync(repo, { recursive: true });
    const a = ws.addWorkspace({ path: repo });
    const b = ws.addWorkspace({ path: repo, name: "  Backend   API " });
    expect(b.id).toBe(a.id);
    expect(ws.listWorkspaces()[0]!.name).toBe("Backend API");
  });

  test("a local path that is not a folder is refused", () => {
    expect(() => ws.addWorkspace({ path: join(dir, "missing") })).toThrow("is not a folder");
    writeFileSync(join(dir, "plain.txt"), "x");
    expect(() => ws.addWorkspace({ path: join(dir, "plain.txt") })).toThrow("is not a folder");
    expect(() => ws.addWorkspace({ path: "" })).toThrow("needs a folder");
    expect(() => ws.addWorkspace({ path: "a\0b" })).toThrow("invalid path");
  });

  test("a remote workspace needs a known host and keeps the path as typed", () => {
    expect(() => ws.addWorkspace({ path: "~/srv", hostId: "h1" }, () => false)).toThrow("unknown remote host");
    const r = ws.addWorkspace({ path: "~/srv/", hostId: "h1", name: "prod" }, (id) => id === "h1");
    expect(r.path).toBe("~/srv");
    expect(r.hostId).toBe("h1");
    // the same path locally is another workspace
    mkdirSync(join(dir, "srv"), { recursive: true });
    const local = ws.addWorkspace({ path: join(dir, "srv") });
    expect(local.id).not.toBe(r.id);
  });

  test("rename and remove", () => {
    const repo = join(dir, "repo-c");
    mkdirSync(repo, { recursive: true });
    const a = ws.addWorkspace({ path: repo });
    expect(ws.renameWorkspace(a.id, "C").name).toBe("C");
    expect(() => ws.renameWorkspace(a.id, " ")).toThrow("name is required");
    expect(() => ws.renameWorkspace("nope", "x")).toThrow("no such workspace");
    expect(ws.removeWorkspace(a.id)).toBe(true);
    expect(ws.removeWorkspace(a.id)).toBe(false);
    expect(ws.listWorkspaces()).toEqual([]);
  });

  test("a broken file reads as no workspaces", () => {
    writeFileSync(file, "{nope");
    expect(ws.listWorkspaces()).toEqual([]);
    writeFileSync(file, JSON.stringify({ workspaces: [{ id: 1 }, { id: "w1", name: "ok", path: "/tmp" }] }));
    expect(ws.listWorkspaces().map((w) => w.id)).toEqual(["w1"]);
  });

  test("a session belongs to the deepest workspace containing its cwd, on the same host", () => {
    const list = [
      { id: "root", name: "root", path: "/home/u/code", createdAt: 0, updatedAt: 0 },
      { id: "deep", name: "deep", path: "/home/u/code/api", createdAt: 0, updatedAt: 0 },
      { id: "remote", name: "remote", path: "/home/u/code", hostId: "h1", createdAt: 0, updatedAt: 0 },
    ];
    expect(ws.workspaceForCwd(list, "/home/u/code/api/src")?.id).toBe("deep");
    expect(ws.workspaceForCwd(list, "/home/u/code/web")?.id).toBe("root");
    expect(ws.workspaceForCwd(list, "/home/u/code")?.id).toBe("root");
    expect(ws.workspaceForCwd(list, "/home/u/codex")).toBeUndefined();
    expect(ws.workspaceForCwd(list, "/home/u/code/api", "h1")?.id).toBe("remote");
  });
});
