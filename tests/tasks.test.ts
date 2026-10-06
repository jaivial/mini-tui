/**
 * The task cards agents fill for their sessions (`mini-tui tasks set`): the table's rules (a card is
 * replaced whole, timestamps only move forward, a deleted session leaves no card) and the command's
 * (how it finds out which session it is filling, and what it refuses to write).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-tasks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { openDb, createSession, deleteSession, getTask, saveTask, listTasks, deleteTask, normalizeTodos, TASK_LIMITS, findLiveRunByControl, registerLiveRun } = await import("../src/sessions");
const { resolveTaskSession, tasksCommand } = await import("../src/cli/commands");
const { parseArgs } = await import("../src/cli/args");

let dbSeq = 0;
function setup() {
  const db = openDb(join(dir, `t${dbSeq++}.db`));
  createSession(db, { id: "s-1", cwd: "/tmp", model: "m", task: "the task" });
  return db;
}

describe("task cards in the database", () => {
  test("a card is stored whole and read back whole", () => {
    const db = setup();
    const saved = saveTask(db, "s-1", { title: "Fix login", description: "Reworked auth", todos: { done: ["parse tokens"], pending: ["wire UI"], left: ["tests"] } });
    expect(saved.title).toBe("Fix login");
    expect(getTask(db, "s-1")).toEqual({
      id: "s-1",
      title: "Fix login",
      description: "Reworked auth",
      todos: { done: ["parse tokens"], pending: ["wire UI"], left: ["tests"] },
      updatedAt: saved.updatedAt,
    });
    db.close();
  });

  test("a session with no card reads as an empty one, not a missing one", () => {
    const db = setup();
    expect(getTask(db, "s-1")).toEqual({ id: "s-1", title: "", description: "", todos: { done: [], pending: [], left: [] }, updatedAt: 0 });
    db.close();
  });

  test("each save replaces the whole card: buckets dropped in a save are gone", () => {
    const db = setup();
    saveTask(db, "s-1", { title: "one", description: "first", todos: { done: ["a"], pending: [], left: [] } });
    const second = saveTask(db, "s-1", { title: "two", description: "", todos: { done: [], pending: [], left: ["b"] } });
    const card = getTask(db, "s-1");
    expect(card.title).toBe("two");
    expect(card.description).toBe("");
    expect(card.todos).toEqual({ done: [], pending: [], left: ["b"] });
    expect(second.updatedAt).toBeGreaterThan(0);
    db.close();
  });

  test("updated_at always moves forward, even for two saves in the same instant", () => {
    const db = setup();
    const a = saveTask(db, "s-1", { title: "a", description: "", todos: { done: [], pending: [], left: [] } });
    const b = saveTask(db, "s-1", { title: "b", description: "", todos: { done: [], pending: [], left: [] } });
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt);
    db.close();
  });

  test("the board lists only sessions with a card, newest first", async () => {
    const db = setup();
    createSession(db, { id: "s-2", cwd: "/tmp", model: "m", task: "another" });
    expect(listTasks(db)).toEqual([]);
    saveTask(db, "s-1", { title: "older", description: "", todos: { done: [], pending: [], left: [] } });
    await Bun.sleep(5); // "newest first" is by timestamp: two saves in one millisecond have no order
    const newer = saveTask(db, "s-2", { title: "newer", description: "", todos: { done: [], pending: [], left: [] } });
    expect(listTasks(db).map((t) => t.id)).toEqual(["s-2", "s-1"]);
    expect(listTasks(db)[0]!.updatedAt).toBe(newer.updatedAt);
    db.close();
  });

  test("a deleted session leaves no card behind", () => {
    const db = setup();
    saveTask(db, "s-1", { title: "t", description: "", todos: { done: [], pending: [], left: [] } });
    deleteSession(db, "s-1");
    expect(listTasks(db)).toEqual([]);
    db.close();
  });

  test("clearing a card leaves the session without one", () => {
    const db = setup();
    saveTask(db, "s-1", { title: "t", description: "", todos: { done: [], pending: [], left: [] } });
    deleteTask(db, "s-1");
    expect(getTask(db, "s-1").updatedAt).toBe(0);
    db.close();
  });

  test("to-dos are trimmed, junk is dropped, and the buckets never overflow", () => {
    const todos = normalizeTodos({ done: ["  a  b  ", "", 7, null], pending: "nope", left: Array.from({ length: TASK_LIMITS.items + 5 }, (_, i) => `item ${i}`) });
    expect(todos.done).toEqual(["a b"]); // runs of whitespace collapse, non-strings go
    expect(todos.pending).toEqual([]); // not an array: no to-dos
    expect(todos.left.length).toBe(TASK_LIMITS.items);
    const long = normalizeTodos({ done: [`${"x".repeat(TASK_LIMITS.item + 50)}`], pending: [], left: [] });
    expect(long.done[0]!.length).toBe(TASK_LIMITS.item);
  });

  test("a card written straight into the table with broken JSON reads as an empty card", () => {
    const db = setup();
    saveTask(db, "s-1", { title: "t", description: "", todos: { done: [], pending: [], left: [] } });
    db.query("UPDATE session_tasks SET todos = ? WHERE session_id = ?").run("{not json", "s-1");
    expect(getTask(db, "s-1").todos).toEqual({ done: [], pending: [], left: [] });
    db.close();
  });
});

describe("which session a call fills", () => {
  test("--session wins over everything", () => {
    expect(resolveTaskSession("s-x", { MINITUI_SESSION_ID: "s-env" })).toBe("s-x");
  });
  test("then the session the spawner named", () => {
    expect(resolveTaskSession(undefined, { MINITUI_SESSION_ID: "s-env", MSWEA_CONTROL_FILE: "/run/control" })).toBe("s-env");
  });
  test("then the session whose agent owns this control file", () => {
    const db = setup();
    registerLiveRun(db, { session_id: "s-1", traj_path: "/run/traj.json", control_path: "/run/control", pid: 1, owner: "web" });
    const byControl = (control: string) => findLiveRunByControl(db, control)?.session_id ?? null;
    expect(resolveTaskSession(undefined, { MSWEA_CONTROL_FILE: "/run/control" }, byControl)).toBe("s-1");
    expect(resolveTaskSession(undefined, { MSWEA_CONTROL_FILE: "/elsewhere/control" }, byControl)).toBeNull();
    db.close();
  });
  test("with nothing to go on, there is no session to fill", () => {
    expect(resolveTaskSession(undefined, {})).toBeNull();
    expect(resolveTaskSession("   ", {})).toBeNull();
  });
});

/** A database with one session in it, for one test's `tasks` calls to share. */
function freshDb(): string {
  const dbPath = join(dir, `cmd${dbSeq++}.db`);
  createSessionInDb(dbPath);
  return dbPath;
}

/** Run `tasks` against `dbPath` with its own environment, capturing what it printed. */
function run(argv: string[], env: NodeJS.ProcessEnv = {}, dbPath: string): { code: number; out: string; err: string } {
  const args = parseArgs(["tasks", ...argv]) as never;
  let out = "";
  let err = "";
  const savedEnv = { ...process.env };
  for (const key of ["MINITUI_SESSION_ID", "MSWEA_CONTROL_FILE"]) delete process.env[key];
  Object.assign(process.env, env);
  let code: number;
  try {
    code = tasksCommand(args, { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) }, dbPath);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
  return { code, out, err };
}
function createSessionInDb(dbPath: string) {
  const db = openDb(dbPath);
  createSession(db, { id: "s-1", cwd: "/tmp", model: "m", task: "the task" });
  db.close();
}

describe("mini-tui tasks", () => {
  test("set writes the whole card and says so", () => {
    const dbPath = freshDb();
    const r = run(["set", "--session", "s-1", "--title", "Fix login", "--description", "Reworked auth", "--done", "a", "--pending", "b", "--left", "c", "--left", "d"], {}, dbPath);
    expect(r.code).toBe(0);
    expect(r.out).toContain("task card saved for s-1: Fix login (1 done, 1 pending, 2 left)");
    const shown = run(["show", "s-1", "--json"], {}, dbPath);
    expect(JSON.parse(shown.out)).toMatchObject({ id: "s-1", title: "Fix login", todos: { done: ["a"], pending: ["b"], left: ["c", "d"] } });
  });

  test("the session can come from the environment (what a spawned agent has)", () => {
    const dbPath = freshDb();
    const r = run(["set", "--title", "From env", "--done", "x"], { MINITUI_SESSION_ID: "s-1" }, dbPath);
    expect(r.code).toBe(0);
    expect(r.out).toContain("task card saved for s-1");
  });

  test("with no session anywhere, the call fails and writes nothing", () => {
    const dbPath = freshDb();
    const r = run(["set", "--title", "Lost"], {}, dbPath);
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot tell which session");
    expect(run(["show", "s-1", "--json"], {}, dbPath).out).toContain('"updatedAt": 0');
  });

  test("set refuses a card that is all empty, and one that is too big", () => {
    const dbPath = freshDb();
    const empty = run(["set", "--session", "s-1"], {}, dbPath);
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("needs something");
    const big = run(["set", "--session", "s-1", "--title", "x".repeat(TASK_LIMITS.title + 1)], {}, dbPath);
    expect(big.code).toBe(2);
    expect(big.err).toContain(`longer than ${TASK_LIMITS.title}`);
    const many = run(["set", "--session", "s-1", "--title", "ok", ...Array.from({ length: TASK_LIMITS.items + 1 }, (_, i) => ["--done", `i${i}`]).flat()], {}, dbPath);
    expect(many.code).toBe(2);
    expect(many.err).toContain(`more than ${TASK_LIMITS.items}`);
  });

  test("show prints the card, and says when there is none", () => {
    const dbPath = freshDb();
    run(["set", "--session", "s-1", "--title", "Fix login", "--done", "a", "--left", "c"], {}, dbPath);
    const r = run(["show", "s-1"], {}, dbPath);
    expect(r.out).toContain("s-1  Fix login");
    expect(r.out).toContain("done     a");
    expect(r.out).toContain("left     c");
    const none = run(["show", "unknown-session"], {}, dbPath);
    expect(none.out).toContain("no task card");
  });

  test("clear removes the card", () => {
    const dbPath = freshDb();
    run(["set", "--session", "s-1", "--title", "Fix login"], {}, dbPath);
    expect(run(["clear", "s-1"], {}, dbPath).out).toContain("cleared for s-1");
    expect(run(["show", "s-1"], {}, dbPath).out).toContain("no task card");
  });

  test("fields are only accepted for set", () => {
    const parsed = (() => {
      try {
        parseArgs(["tasks", "show", "--title", "x"]);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(parsed).toContain("only written by");
  });
});
