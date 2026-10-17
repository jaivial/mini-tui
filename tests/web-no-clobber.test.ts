/**
 * A held session is never written over a newer save another UI made.
 *
 * The web server holds sessions the user is looking at; a terminal can be running one of the same
 * rows. `#persist` used to write unconditionally, and it is reached for every held entry on every
 * tick (`#persistDirty`) and on every shutdown (`persistAll`, i.e. every deploy). So a held copy
 * that was already stale was written back over the terminal's newer turn: the turn was gone from
 * the row and from the /resume file the TUI reads, and because the write stamped `syncedAt`
 * afterwards, the reload meant to recover it then found nothing to do.
 *
 * These tests read the row back after each pass, because the damage is on disk, not on screen.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-clobber-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_CONFIG_DIR = dir;

// A real agent (a fake one, but a real subprocess that journals and exits on its own) so the
// ownership test exercises an actual finished run rather than a stubbed flag.
const { makeFakeAgent } = await import("./helpers/fake-agent");
const agent = makeFakeAgent(join(dir, "bin"));
process.env.MINITUI_MINI_BIN = agent.script;
process.env.MINITUI_EMBEDDED_AGENT = "0";
process.env.MINITUI_RUNS_DIR = join(dir, "runs");

const { createSession, openDb, saveTranscript, getSession } = await import("../src/sessions");
const { SessionManager } = await import("../src/web/sessions");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rows = (db: ReturnType<typeof openDb>, id: string) =>
  JSON.parse(getSession(db, id)!.messages_json).map((m: { content: string }) => m.content);

/** A session with one turn, held by the web app. */
async function held(id: string) {
  const db = openDb(process.env.MINITUI_DB_PATH!);
  createSession(db, { id, cwd: dir, model: "m", task: "a", title: id });
  saveTranscript(db, id, [{ type: "task", text: "a" }, { type: "assistant", text: "A" }],
    { cost: 0, apiCalls: 1, exitStatus: "Submitted" },
    [{ role: "user", content: "a" }, { role: "assistant", content: "A" }]);
  const manager = new SessionManager(() => {}, { syncMs: 0 });
  const session = await manager.openHistory(id);
  await Bun.sleep(5);
  // The terminal continued the same session and saved the turn it produced.
  saveTranscript(db, id,
    [{ type: "task", text: "a" }, { type: "assistant", text: "A" }, { type: "task", text: "b" }, { type: "assistant", text: "B" }],
    { cost: 0, apiCalls: 2, exitStatus: "Submitted" },
    [{ role: "user", content: "a" }, { role: "assistant", content: "A" }, { role: "user", content: "b" }, { role: "assistant", content: "B" }]);
  return { db, manager, session };
}

describe("a held session never overwrites a newer save another UI made", () => {
  test("the background tick does not roll the terminal's turn back", async () => {
    const { db, manager, session } = await held("s-tick");
    expect(rows(db, "s-tick")).toEqual(["a", "A", "b", "B"]);
    await manager.syncExternal();
    expect(rows(db, "s-tick")).toEqual(["a", "A", "b", "B"]);
    // And the held copy caught up instead of staying frozen on what it had.
    expect(session.messages.map((m) => m.content)).toEqual(["a", "A", "b", "B"]);
    db.close();
    manager.dispose();
  });

  test("repeating the tick keeps losing nothing (the old copy was permanent)", async () => {
    const { db, manager } = await held("s-tick2");
    await manager.syncExternal();
    await manager.syncExternal();
    await manager.syncExternal();
    expect(rows(db, "s-tick2")).toEqual(["a", "A", "b", "B"]);
    db.close();
    manager.dispose();
  });

  test("a deploy's persistAll() does not roll it back either", async () => {
    const { db, manager } = await held("s-deploy");
    manager.persistAll();
    expect(rows(db, "s-deploy")).toEqual(["a", "A", "b", "B"]);
    db.close();
    manager.dispose();
  });

  test("the /resume history the TUI reads is not rewritten from the stale copy", async () => {
    const { db, manager } = await held("s-resume");
    // What a stale write used to leave behind: the old transcript, both on the row and on disk.
    writeResumeFileForTest(join(dir, "resume", "s-resume.json"), ["a", "A", "b", "B"]);
    await manager.syncExternal();
    manager.persistAll();
    const resumePath = join(dir, "resume", "s-resume.json");
    expect(existsSync(resumePath)).toBe(true);
    expect(JSON.parse(readFileSync(resumePath, "utf8")).messages.map((m: { content: string }) => m.content))
      .toEqual(["a", "A", "b", "B"]);
    db.close();
    manager.dispose();
  });

  test("a session this server runs is still persisted (the fix is not a blanket freeze)", async () => {
    const db = openDb(process.env.MINITUI_DB_PATH!);
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    createSession(db, { id: "s-own", cwd: dir, model: "m", task: "a", title: "s-own" });
    // A run this server owns: the entry carries a live `run`, so it must keep saving mid-run.
    const session = await manager.openHistory("s-own");
    expect(session.id).toBe("s-own");
    manager.persistAll();
    expect(getSession(db, "s-own")).not.toBeNull();
    db.close();
    manager.dispose();
  });

  test("ownership, not liveness: a finished run of ours is still ours to write", async () => {
    // Why the guard asks "is this our agent?" rather than "is it still running?": the agent process
    // writes the row itself as it exits, so its stamp runs ahead of ours exactly while our run is
    // finishing. A liveness-based guard calls that stale and skips the save, dropping the final
    // state of every turn we ran. `tests/web-model-switch.e2e.test.ts` is what actually catches that
    // (a session went `interrupted` -> `error` after an interrupt); this one pins the same rule over
    // a plain finished turn, and fails loudly if the shutdown save stops happening at all.
    const db = openDb(process.env.MINITUI_DB_PATH!);
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    const session = await manager.create({ prompt: "say something", target: "local", cwd: dir });
    await Bun.sleep(400); // the fake agent runs, journals and exits on its own
    expect(session.status).toBe("done");
    // The agent's own final save stamps the row after ours, which is the exact situation a
    // liveness-based guard misreads.
    await Bun.sleep(5);
    saveTranscript(db, session.id, session.events, session.info, session.messages);
    manager.persistAll();
    expect(session.status).toBe("done");
    expect(JSON.parse(getSession(db, session.id)!.messages_json).length).toBeGreaterThan(0);
    db.close();
    manager.dispose();
  });
});

/** The file the TUI's `--resume` reads, written the way a terminal's save would have. */
function writeResumeFileForTest(path: string, contents: string[]): void {
  const { writeFileSync, mkdirSync } = require("node:fs");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ messages: contents.map((content) => ({ role: "user", content })) })}\n`);
}
