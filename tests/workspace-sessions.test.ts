/**
 * The saved sessions each manual-mode workspace lists: its folder and every subfolder, on its own
 * host, minus what a deeper saved workspace claims (the rule `workspaceForCwd` applies to live ones).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-wssessions-"));
const savedResume = process.env.MINITUI_RESUME_DIR;
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
const { countWorkspaceSessions, createSession, getSession, listHistory, listWorkspaceSessions, openDb, upsertSubagentSession } = await import("../src/sessions");
const { workspaceForCwd } = await import("../src/workspaces");
afterAll(() => {
  if (savedResume === undefined) delete process.env.MINITUI_RESUME_DIR;
  else process.env.MINITUI_RESUME_DIR = savedResume;
  rmSync(dir, { recursive: true, force: true });
});

const fresh = () => openDb(join(dir, `${crypto.randomUUID()}.db`));
const ws = (id: string, path: string, hostId?: string) => ({ id, name: id, path, ...(hostId ? { hostId } : {}), createdAt: 1, updatedAt: 1 });
let clock = 1_000;
/** A row with a known, increasing `updated_at`, so the order is the insertion order. */
function add(db: Database, id: string, cwd: string, hostId?: string) {
  createSession(db, { id, cwd, model: "m", task: id, hostId });
  db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(++clock, id);
}
const ids = (db: Database, list: ReturnType<typeof ws>[], limit?: number) =>
  Object.fromEntries(Object.entries(listWorkspaceSessions(db, list, limit)).map(([k, rows]) => [k, rows.map((r) => r.id)]));

describe("listWorkspaceSessions", () => {
  test("a workspace lists its folder and its subfolders, never a sibling that shares a prefix", () => {
    const db = fresh();
    add(db, "top", "/work/proj");
    add(db, "sub", "/work/proj/api");
    add(db, "deep", "/work/proj/api/src/x");
    add(db, "slash", "/work/proj/web/");
    add(db, "sibling", "/work/proj-old");
    add(db, "dotted", "/work/proj.bak");
    add(db, "parent", "/work");
    expect(ids(db, [ws("p", "/work/proj")])).toEqual({ p: ["slash", "deep", "sub", "top"] });
    // A saved path with a trailing slash means the same folder.
    expect(ids(db, [ws("p", "/work/proj/")])).toEqual({ p: ["slash", "deep", "sub", "top"] });
  });

  test("LIKE wildcards in a folder name are plain characters", () => {
    const db = fresh();
    add(db, "pct", "/w/100%/a");
    add(db, "other", "/w/100x/a");
    add(db, "under", "/w/a_b");
    add(db, "notunder", "/w/aXb");
    expect(ids(db, [ws("p", "/w/100%"), ws("u", "/w/a_b")])).toEqual({ p: ["pct"], u: ["under"] });
  });

  test("a nested workspace keeps its sessions, and never starves the parent's page", () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) add(db, `parent-${i}`, i % 2 ? "/repo" : "/repo/docs");
    // Newer than every parent row, and more than a page: a fixed page filtered afterwards would
    // leave the parent empty.
    for (let i = 0; i < 40; i++) add(db, `child-${i}`, i % 2 ? "/repo/api" : "/repo/api/src");
    const list = [ws("repo", "/repo"), ws("api", "/repo/api")];
    const got = ids(db, list, 30);
    expect(got.repo).toEqual(["parent-4", "parent-3", "parent-2", "parent-1", "parent-0"]);
    expect(got.api!.length).toBe(30);
    expect(got.api![0]).toBe("child-39");
    expect(countWorkspaceSessions(db, list)).toEqual({ repo: 5, api: 40 });
  });

  test("a local workspace lists local rows only, a remote one its host's rows only", () => {
    const db = fresh();
    add(db, "local", "/srv/app");
    add(db, "h1", "/srv/app/sub", "host-1");
    add(db, "h2", "/srv/app", "host-2");
    add(db, "tilde", "~/code/x", "host-1");
    const list = [ws("loc", "/srv/app"), ws("r1", "/srv/app", "host-1"), ws("r2", "/srv/app", "host-2"), ws("t", "~/code", "host-1")];
    expect(ids(db, list)).toEqual({ loc: ["local"], r1: ["h1"], r2: ["h2"], t: ["tilde"] });
    expect(getSession(db, "h1")?.host_id).toBe("host-1");
    expect(getSession(db, "local")?.host_id).toBe("");
  });

  test("the root folder holds every absolute path on its host", () => {
    const db = fresh();
    add(db, "root", "/");
    add(db, "a", "/a");
    add(db, "nested", "/home/me/p");
    add(db, "remote", "/a", "h");
    const list = [ws("root", "/"), ws("home", "/home/me")];
    expect(ids(db, list)).toEqual({ root: ["a", "root"], home: ["nested"] });
  });

  test("subagent sessions are not listed; a duplicate workspace gets nothing", () => {
    const db = fresh();
    add(db, "chat", "/x");
    upsertSubagentSession(db, { id: "chat-sub", parentId: "chat", title: "s", cwd: "/x", model: "m", task: "t" });
    expect(ids(db, [ws("a", "/x"), ws("b", "/x/")])).toEqual({ a: ["chat"], b: [] });
    expect(countWorkspaceSessions(db, [ws("a", "/x"), ws("b", "/x/")])).toEqual({ a: 1, b: 0 });
  });

  test("agrees with workspaceForCwd for every row", () => {
    const db = fresh();
    const cwds: Array<[string, string?]> = [["/"], ["/a"], ["/a/b"], ["/a/b/c"], ["/a/bc"], ["/a/b/c/d/"], ["/z"], ["/a/b", "h"], ["/a", "h"], ["/q", "h"]];
    cwds.forEach(([cwd, host], i) => add(db, `s${i}`, cwd, host));
    const list = [ws("a", "/a"), ws("ab", "/a/b"), ws("abc", "/a/b/c/"), ws("root", "/"), ws("ha", "/a", "h")];
    const got = ids(db, list);
    cwds.forEach(([cwd, host], i) => {
      const owner = workspaceForCwd(list, cwd, host)?.id;
      for (const w of list) expect([w.id, got[w.id]!.includes(`s${i}`)]).toEqual([w.id, w.id === owner]);
    });
  });
});

describe("the host column", () => {
  test("a database from before it gains it, its rows read as local, and an old-style insert still works", () => {
    const path = join(dir, "old.db");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, api_calls INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, exit_status TEXT NOT NULL DEFAULT '',
      events_json TEXT NOT NULL DEFAULT '[]', info_json TEXT NOT NULL DEFAULT '{}')`);
    old.query("INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('before', 't', '/p/sub', 1, 1)").run();
    old.close();
    const db = openDb(path);
    expect(getSession(db, "before")?.host_id).toBe("");
    // What a build that does not know the column writes.
    db.query("INSERT OR REPLACE INTO sessions (id, title, cwd, model, task, created_at, updated_at) VALUES ('older-build', 't', '/p', '', '', 2, 2)").run();
    expect(ids(db, [ws("p", "/p"), ws("r", "/p", "h")])).toEqual({ p: ["older-build", "before"], r: [] });
    // Opening it again is a no-op, and `listHistory ?cwd=` still means that folder exactly.
    openDb(path).close();
    expect(listHistory(db, { cwd: "/p" }).map((r) => r.id)).toEqual(["older-build"]);
  });
});
