/**
 * Resuming a saved session from the web app: listing history without loading transcripts, opening a
 * session that no process owns, and continuing the conversation with its full context.
 * The agent is a stub that records what it was asked, so nothing calls a model.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeAgent } from "./helpers/fake-agent";

const dir = mkdtempSync(join(tmpdir(), "minitui-resume-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_CONFIG_DIR = dir;
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_RUNS_DIR = join(dir, "runs");
process.env.MINITUI_LAST_MODEL_PATH = join(dir, "last-model.json");
process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
process.env.MINITUI_SETTINGS_PATH = join(dir, "settings.json");
process.env.MINITUI_SKILLS_DIR = join(dir, "skills");
const agent = makeFakeAgent(join(dir, "bin"));
// bun runs every test file in one process, so what this file sets is seen by the files that run after it.
// Remember the originals and put them back in afterAll (the fake agent's directory is deleted there).
const savedEnv = { bin: process.env.MINITUI_MINI_BIN, embedded: process.env.MINITUI_EMBEDDED_AGENT };
process.env.MINITUI_MINI_BIN = agent.script;
process.env.MINITUI_EMBEDDED_AGENT = "0";

const { createSession, openDb, saveTranscript, getSession } = await import("../src/sessions");
const { SessionManager } = await import("../src/web/sessions");

const OLD_MESSAGES = [
  { role: "system", content: "system" },
  { role: "user", content: "add a retry to upload()" },
  { role: "assistant", content: "Done: retries 3 times.", extra: { cost: 0.002 } },
];
const OLD_EVENTS = [
  { type: "task", text: "add a retry to upload()" },
  { type: "assistant", text: "Done: retries 3 times." },
];

beforeAll(() => {
  const db = openDb(process.env.MINITUI_DB_PATH!);
  const seed = (id: string, opts: { cwd: string; task: string; title?: string; model?: string; messages?: unknown[]; events?: unknown[]; calls?: number; exit?: string; at?: number }) => {
    createSession(db, { id, cwd: opts.cwd, model: opts.model ?? "deepseek/deepseek-chat", task: opts.task, title: opts.title });
    saveTranscript(db, id, (opts.events ?? OLD_EVENTS) as never, { cost: 0.01, apiCalls: opts.calls ?? 2, exitStatus: opts.exit ?? "Submitted" }, (opts.messages ?? OLD_MESSAGES) as never);
    if (opts.at) db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(opts.at, id);
  };
  seed("s-a", { cwd: "/work/api", task: "add a retry to upload()", title: "Add a retry to upload", at: 3000 });
  seed("s-b", { cwd: "/work/web", task: "fix the flaky reconnect test", title: "Fix flaky reconnect test", model: "xiaomi/mimo-v2.6-pro", at: 2000 });
  seed("s-c", {
    cwd: "/work/api", task: "write the README", title: "Write the README", at: 1000,
    events: [{ type: "task", text: "write the README" }, { type: "assistant", text: "Written." }],
    messages: [{ role: "system", content: "system" }, { role: "user", content: "write the README" }, { role: "assistant", content: "Written." }],
  });
  // What a real session that never got as far as a model call looks like: no calls, no events, no messages.
  // It can be read but not continued.
  seed("s-ro", { cwd: "/work/old", task: "ancient", title: "Ancient session", messages: [], events: [], calls: 0, exit: "", at: 500 });
  // The awkward one: the row claims model calls but saved no messages. The listing cannot know without
  // reading the blob, so it says resumable; sending must still refuse cleanly.
  seed("s-odd", { cwd: "/work/odd", task: "odd", title: "Odd session", messages: [], at: 400 });
  db.close();
});
afterAll(() => {
  if (savedEnv.bin === undefined) delete process.env.MINITUI_MINI_BIN;
  else process.env.MINITUI_MINI_BIN = savedEnv.bin;
  if (savedEnv.embedded === undefined) delete process.env.MINITUI_EMBEDDED_AGENT;
  else process.env.MINITUI_EMBEDDED_AGENT = savedEnv.embedded;
  rmSync(dir, { recursive: true, force: true });
});

const fresh = () => new SessionManager(() => {});

describe("history listing", () => {
  test("newest first, metadata only, and says which rows can be continued", () => {
    const rows = fresh().history();
    expect(rows.map((r) => r.id)).toEqual(["s-a", "s-b", "s-c", "s-ro", "s-odd"]); // updated_at 3000 > 2000 > 1000 > 500 > 400
    for (const r of rows) {
      expect("events_json" in r).toBe(false);
      expect("messages_json" in r).toBe(false);
      expect("updated_at" in r).toBe(false); // camelCase on the wire
      expect(typeof r.updatedAt).toBe("number");
    }
    expect(rows.find((r) => r.id === "s-ro")!.resumable).toBe(false);
    expect(rows.find((r) => r.id === "s-a")!.resumable).toBe(true);
  });
  test("search matches the title, the task and the folder", () => {
    const m = fresh();
    expect(m.history({ query: "reconnect" }).map((r) => r.id)).toEqual(["s-b"]);
    expect(m.history({ query: "README" }).map((r) => r.id)).toEqual(["s-c"]);
    expect(m.history({ query: "/work/api" }).map((r) => r.id).sort()).toEqual(["s-a", "s-c"]);
    expect(m.history({ query: "nothing like this" })).toEqual([]);
  });
  test("a query made of LIKE wildcards is a literal, not a match-everything", () => {
    const m = fresh();
    expect(m.history({ query: "%" })).toEqual([]);
    expect(m.history({ query: "_" })).toEqual([]);
    expect(m.history({ query: "a%b" })).toEqual([]);
  });
  test("a limit is honoured and clamped to something sane", () => {
    const m = fresh();
    expect(m.history({ limit: 2 })).toHaveLength(2);
    expect(m.history({ limit: 0 }).length).toBeGreaterThan(0);
    expect(m.history({ limit: 1e9 }).length).toBe(5);
  });
  test("sessions already open in this server are flagged, so the UI does not offer them twice", () => {
    const m = fresh();
    m.openHistory("s-b");
    const rows = m.history();
    expect(rows.find((r) => r.id === "s-b")!.open).toBe(true);
    expect(rows.find((r) => r.id === "s-a")!.open).toBe(false);
  });
});

describe("opening a saved session", () => {
  test("restores the transcript and settles as finished, without starting anything", () => {
    const before = agent.calls().length;
    const s = fresh().openHistory("s-a");
    expect(s.status).toBe("done");
    expect(s.events.map((e) => e.type)).toEqual(["task", "assistant"]);
    expect(s.model).toBe("deepseek/deepseek-chat");
    expect(s.cwd).toBe("/work/api");
    expect(agent.calls().length).toBe(before);
  });
  test("opening it twice returns the live copy instead of a second, diverging one", () => {
    const m = fresh();
    const a = m.openHistory("s-a");
    a.events.push({ type: "notice", text: "edited live" });
    const b = m.openHistory("s-a");
    expect(b.events.at(-1)).toMatchObject({ text: "edited live" });
    expect(m.list().filter((s) => s.id === "s-a")).toHaveLength(1);
  });
  test("an unknown id is an error, not an empty session", () => {
    expect(() => fresh().openHistory("s-nope")).toThrow(/unknown session/);
  });
});

describe("continuing a resumed session", () => {
  test("the follow-up runs locally with the whole saved conversation as context", async () => {
    const m = fresh();
    m.openHistory("s-a");
    const before = agent.calls().length;
    m.send("s-a", "now add a test for it");
    await Bun.sleep(600);
    const calls = agent.calls().slice(before);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.resume).toBeTruthy();
    expect(call.resumedMessages).toEqual(OLD_MESSAGES);
    expect(call.task).toBe("now add a test for it");
  });
  test("it runs in the session's own folder and on its own model", async () => {
    const m = fresh();
    m.openHistory("s-b");
    const before = agent.calls().length;
    m.send("s-b", "and the reconnect backoff?");
    await Bun.sleep(600);
    const call = agent.calls().slice(before)[0]!;
    expect(call.model).toBe("xiaomi/mimo-v2.6-pro");
    // the folder does not exist on this machine: it must fall back rather than crash the spawn
    expect(existsSync(call.cwd)).toBe(true);
  });
  test("the transcript shows the old turn, the new prompt once, and the new reply", async () => {
    const m = fresh();
    m.openHistory("s-c");
    m.send("s-c", "make it shorter");
    await Bun.sleep(700);
    const s = m.get("s-c")!;
    expect(s.events.filter((e) => e.type === "task").map((e: any) => e.text)).toEqual(["write the README", "make it shorter"]);
    expect(s.events.some((e: any) => e.type === "assistant" && /fake reply to/.test(e.text))).toBe(true);
    expect(s.events.some((e) => e.type === "error")).toBe(false);
  });
  test("no remote-host error for a local session (the bug this replaces)", async () => {
    const m = fresh();
    m.openHistory("s-a");
    m.send("s-a", "hello again");
    await Bun.sleep(500);
    expect(m.get("s-a")!.events.some((e: any) => /remote host/.test(e.text ?? ""))).toBe(false);
  });
  test("what finishes is saved back to the same history row, transcript included", async () => {
    const m = fresh();
    m.openHistory("s-a");
    m.send("s-a", "one more thing");
    await Bun.sleep(800);
    const db = openDb(process.env.MINITUI_DB_PATH!);
    const row = getSession(db, "s-a")!;
    db.close();
    const events = JSON.parse(row.events_json) as { type: string; text?: string }[];
    expect(events.filter((e) => e.type === "task").map((e) => e.text)).toContain("one more thing");
    expect(JSON.parse(row.messages_json).length).toBeGreaterThan(OLD_MESSAGES.length);
  });
  test("a row that claims calls but saved no messages is listed, and sending to it still refuses cleanly", () => {
    const m = fresh();
    expect(m.history().find((r) => r.id === "s-odd")!.resumable).toBe(true); // the inference cannot see the blob
    m.openHistory("s-odd");
    const before = m.get("s-odd")!.events.length;
    const calls = agent.calls().length;
    expect(() => m.send("s-odd", "continue?")).toThrow(/no saved conversation/);
    expect(m.get("s-odd")!.events.length).toBe(before); // nothing was echoed
    expect(m.get("s-odd")!.status).not.toBe("running");
    expect(agent.calls().length).toBe(calls); // and no agent was started
  });
  test("a session with no saved messages refuses to continue, and says why", () => {
    const m = fresh();
    m.openHistory("s-ro");
    expect(() => m.send("s-ro", "continue?")).toThrow(/no saved conversation|cannot be continued/i);
    expect(m.get("s-ro")!.status).not.toBe("running");
  });
});

describe("closing versus deleting", () => {
  const rowExists = (id: string) => {
    const db = openDb(process.env.MINITUI_DB_PATH!);
    const row = getSession(db, id);
    db.close();
    return !!row;
  };
  const seedOne = (id: string) => {
    const db = openDb(process.env.MINITUI_DB_PATH!);
    createSession(db, { id, cwd: "/work/tmp", model: "m", task: `task ${id}`, title: `Task ${id}` });
    saveTranscript(db, id, OLD_EVENTS as never, { cost: 0, apiCalls: 2, exitStatus: "Submitted" }, OLD_MESSAGES as never);
    db.close();
  };

  test("closing a session leaves it in the history, so it can be resumed later", () => {
    seedOne("s-close");
    const m = fresh();
    m.openHistory("s-close");
    m.close("s-close");
    expect(m.get("s-close")).toBeUndefined();
    expect(rowExists("s-close")).toBe(true);
    expect(m.history().find((r) => r.id === "s-close")).toMatchObject({ open: false, resumable: true });
    expect(m.openHistory("s-close").events).toHaveLength(2); // and it comes back whole
  });

  test("closing saves what the session has so far, so nothing since the last save is lost", async () => {
    seedOne("s-save");
    const m = fresh();
    m.openHistory("s-save");
    m.send("s-save", "a follow-up that is mid-flight");
    await Bun.sleep(600);
    m.close("s-save");
    const db = openDb(process.env.MINITUI_DB_PATH!);
    const events = JSON.parse(getSession(db, "s-save")!.events_json) as { type: string; text?: string }[];
    db.close();
    expect(events.some((e) => e.type === "task" && e.text === "a follow-up that is mid-flight")).toBe(true);
  });

  test("deleting removes the row for good, whether or not the session is open", () => {
    seedOne("s-del-open");
    seedOne("s-del-shut");
    const m = fresh();
    m.openHistory("s-del-open");
    expect(m.deleteHistory("s-del-open")).toBe(true); // open: stopped, dropped and deleted
    expect(m.get("s-del-open")).toBeUndefined();
    expect(rowExists("s-del-open")).toBe(false);
    expect(m.deleteHistory("s-del-shut")).toBe(true); // never opened: still deleted (it used to be a silent no-op)
    expect(rowExists("s-del-shut")).toBe(false);
  });

  test("deleting something that is not there reports it instead of pretending", () => {
    expect(fresh().deleteHistory("s-never-existed")).toBe(false);
  });
});

describe("starting a chat in a chosen folder", () => {
  test("a local chat starts in the folder picked, and records it", async () => {
    const m = fresh();
    const s = await m.create({ prompt: "work here", target: "local", cwd: dir });
    // The fake agent logs its call as it starts, a moment after create() returns.
    for (let i = 0; i < 50 && agent.calls().at(-1)?.task !== "work here"; i++) await Bun.sleep(20);
    const call = agent.calls().at(-1)!;
    expect(call.task).toBe("work here");
    expect(call.cwd).toBe(realpathSync(dir));
    expect(s.cwd).toBe(dir);
    m.close(s.id);
  });
  test("~ is this machine's home", async () => {
    const m = fresh();
    const s = await m.create({ prompt: "home", target: "local", cwd: "~" });
    expect(s.cwd).toBe(homedir());
    m.close(s.id);
  });
  test("a folder that does not exist is refused before anything starts", async () => {
    const m = fresh();
    const before = agent.calls().length;
    await expect(m.create({ prompt: "nowhere", target: "local", cwd: join(dir, "missing") })).rejects.toThrow(/not a folder on this machine/);
    expect(agent.calls().length).toBe(before);
  });
});

describe("sessions per folder", () => {
  test("folders come back newest first, each with its count, from the index alone", async () => {
    const { listFolders } = await import("../src/sessions");
    const db = openDb(process.env.MINITUI_DB_PATH!);
    const folders = listFolders(db);
    db.close();
    const byCwd = Object.fromEntries(folders.map((f) => [f.cwd, f]));
    expect(byCwd["/work/api"]?.count).toBe(2); // s-a (via seed) and s-c are both in /work/api
    for (let i = 1; i < folders.length; i++) expect(folders[i - 1]!.updatedAt).toBeGreaterThanOrEqual(folders[i]!.updatedAt);
    expect(new Set(folders.map((f) => f.cwd)).size).toBe(folders.length); // each folder once
  });
  test("history can be read for one exact folder: not a search, no neighbours", () => {
    const m = fresh();
    const rows = m.history({ cwd: "/work/api" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.cwd === "/work/api")).toBe(true);
    expect(m.history({ cwd: "/work" })).toEqual([]); // a prefix is not the folder
    expect(m.history({ cwd: "/work/%" })).toEqual([]); // and a wildcard is a character
  });
  test("folder and search combine", () => {
    const m = fresh();
    const all = m.history({ cwd: "/work/api" });
    const one = m.history({ cwd: "/work/api", query: all[0]!.title });
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((r) => r.cwd === "/work/api")).toBe(true);
  });
});
