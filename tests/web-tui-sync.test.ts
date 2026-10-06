/**
 * The web app and a terminal UI working on one session.
 *
 * A terminal runs an agent for a session and announces it (`live_runs`). The web server opening that
 * session must follow the same agent live, deliver prompts to it through its control file, and must
 * never fail the open because a terminal is holding the shared database.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-sync-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_CONFIG_DIR = dir;

const { createSession, openDb, saveTranscript, registerLiveRun, getLiveRun } = await import("../src/sessions");
const { SessionManager, restoreFromRow } = await import("../src/web/sessions");

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

/**
 * A stand-in for an agent a terminal started: journals a first turn, holds at exit, and answers
 * every `MESSAGE` on its control file with another turn, like the real one.
 */
function startTerminalAgent(runDir: string) {
  mkdirSync(runDir, { recursive: true });
  const traj = join(runDir, "traj.json");
  const control = join(runDir, "control");
  writeFileSync(control, "");
  const script = join(runDir, "agent.ts");
  writeFileSync(
    script,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const journal = ${JSON.stringify(join(runDir, "traj.jsonl"))};
const control = ${JSON.stringify(control)};
const line = (o) => JSON.stringify(o) + "\\n";
writeFileSync(journal, line({ t: "meta", trajectory_format: "mini-swe-agent-1.1" }));
const msg = (m) => appendFileSync(journal, line({ t: "msg", m }));
msg({ role: "system", content: "system" });
msg({ role: "user", content: "first task from the terminal" });
msg({ role: "assistant", content: "first answer" });
msg({ role: "exit", content: "", extra: { exit_status: "Submitted", submission: "" } });
for (;;) {
  const raw = readFileSync(control, "utf8");
  if (raw.trim()) {
    writeFileSync(control, "");
    for (const l of raw.split("\\n")) {
      if (!l.startsWith("MESSAGE ")) continue;
      const text = JSON.parse(l.slice(8));
      msg({ role: "user", content: "The user added a new task: " + text, extra: { interrupt_type: "UserNewTask" } });
      await Bun.sleep(150);
      msg({ role: "assistant", content: "answer to: " + text });
      msg({ role: "exit", content: "", extra: { exit_status: "Submitted", submission: "" } });
    }
  }
  await Bun.sleep(50);
}
`,
  );
  // `-o <traj>` on the command line, like the real agent: that is how a live pid is recognised.
  const proc = Bun.spawn({ cmd: [process.execPath, script, "-o", traj], stdout: "ignore", stderr: "ignore" });
  return { proc, traj, control };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

let agent: ReturnType<typeof startTerminalAgent>;
beforeAll(() => {
  const db = openDb(process.env.MINITUI_DB_PATH);
  createSession(db, { id: "s-tui", cwd: dir, model: "m", task: "first task from the terminal", title: "TUI session" });
  // What the terminal saved before its throttled save caught up: only the first prompt.
  saveTranscript(db, "s-tui", [{ type: "task", text: "first task from the terminal" }], { cost: 0, apiCalls: 0 }, []);
  agent = startTerminalAgent(join(dir, "run-tui"));
  registerLiveRun(db, { session_id: "s-tui", traj_path: agent.traj, control_path: agent.control, pid: agent.proc.pid, owner: "tui" });
  // A row a terminal wrote that has never seen the web app: empty info, nothing else.
  createSession(db, { id: "s-bare", cwd: dir, model: "", task: "", title: "" });
  db.query("UPDATE sessions SET info_json = '{}', events_json = 'not json' WHERE id = 's-bare'").run();
  db.close();
});
afterAll(() => {
  agent?.proc.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("a session a terminal is running", () => {
  test("opening it in the web app follows the terminal's agent live", async () => {
    const changes: string[] = [];
    const manager = new SessionManager((s) => changes.push(s.id), { syncMs: 0 });
    const session = await manager.openHistory("s-tui");
    await until(() => session.events.some((e) => e.type === "assistant" && e.text === "first answer"));
    expect(session.status).toBe("done"); // the agent holds at its exit, waiting for a prompt
    expect(session.events.some((e) => e.type === "notice" && /following the agent/.test(e.text))).toBe(true);

    // A prompt from the browser reaches the very same agent: no second agent, no fork.
    manager.send("s-tui", "second task from the web");
    expect(session.status).toBe("running");
    await until(() => session.events.some((e) => e.type === "assistant" && e.text === "answer to: second task from the web"));
    await until(() => session.status === "done");
    // The prompt shows once: the echo and the journal's copy are the same event.
    expect(session.events.filter((e) => e.type === "task" && /second task/.test(e.text)).length).toBe(1);

    // A prompt typed in the terminal streams to the web app too, and marks the session working.
    appendFileSync(agent.control, `MESSAGE ${JSON.stringify("third task typed in the terminal")}\n`);
    await until(() => session.events.some((e) => e.type === "task" && /third task/.test(e.text)));
    await until(() => session.events.some((e) => e.type === "assistant" && /third task/.test(e.text)));
    await until(() => session.status === "done");

    // Closing the web view lets go of the agent; the terminal keeps it.
    manager.close("s-tui");
    await Bun.sleep(100);
    expect(agent.proc.exitCode).toBeNull();
    const db = openDb(process.env.MINITUI_DB_PATH);
    expect(getLiveRun(db, "s-tui")?.pid).toBe(agent.proc.pid);
    db.close();
    manager.dispose();
  });

  test("the agent ending in the terminal ends the web session's turn", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    const session = await manager.openHistory("s-tui");
    await until(() => session.events.some((e) => e.type === "assistant"));
    agent.proc.kill();
    await agent.proc.exited;
    await until(() => session.status === "done", 3000);
    manager.dispose();
  });
});

describe("rows written by other UIs never fail an open", () => {
  test("broken or empty JSON columns restore as an empty, usable session", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    const session = await manager.openHistory("s-bare");
    expect(session.events).toEqual([]);
    expect(session.info).toEqual({ cost: 0, apiCalls: 0 });
    expect(session.title).toBe("s-bare");
    manager.dispose();
  });

  test("restoreFromRow bounds huge outputs and drops non-events", () => {
    const big = "x\n".repeat(200_000);
    const session = restoreFromRow({
      id: "s-x", title: "t", cwd: "/", model: "", task: "", created_at: 1, updated_at: 2, api_calls: 1, cost: 0, exit_status: "Submitted",
      events_json: JSON.stringify([null, 3, { type: "observation", toolCallId: null, returncode: 0, output: big, exceptionInfo: "" }]),
      info_json: "null", messages_json: "{}",
    });
    expect(session.events.length).toBe(1);
    expect((session.events[0] as { output: string }).output.length).toBeLessThan(60_000);
    expect(session.messages).toEqual([]);
    expect(session.status).toBe("done");
  });

  test("a terminal holding the database does not fail the web app's open", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    manager.db();
    const writer = new Database(process.env.MINITUI_DB_PATH!);
    writer.exec("BEGIN IMMEDIATE");
    writer.query("UPDATE sessions SET title = title WHERE id = 's-bare'").run();
    // WAL: readers are never blocked by a writer, so the open succeeds mid-save.
    manager.close("s-bare");
    await expect(manager.openHistory("s-bare")).resolves.toBeDefined();
    expect(() => manager.history({ limit: 5 })).not.toThrow();
    writer.exec("COMMIT");
    writer.close();
    manager.dispose();
  });
});

describe("a terminal continuing a session the web app holds", () => {
  test("its newer save replaces the web app's stale copy before the next prompt", async () => {
    const db = openDb(process.env.MINITUI_DB_PATH);
    createSession(db, { id: "s-shared", cwd: dir, model: "m", task: "a", title: "shared" });
    saveTranscript(db, "s-shared", [{ type: "task", text: "a" }, { type: "assistant", text: "A" }], { cost: 0, apiCalls: 1, exitStatus: "Submitted" },
      [{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "assistant", content: "A" }]);
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    const session = await manager.openHistory("s-shared");
    expect(session.events.length).toBe(2);
    await Bun.sleep(5);
    // The terminal ran another turn and saved it (no agent left running).
    saveTranscript(db, "s-shared", [{ type: "task", text: "a" }, { type: "assistant", text: "A" }, { type: "task", text: "b" }, { type: "assistant", text: "B" }],
      { cost: 0, apiCalls: 2, exitStatus: "Submitted" },
      [{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "assistant", content: "A" }, { role: "user", content: "b" }, { role: "assistant", content: "B" }]);
    await manager.syncExternal();
    expect(session.events.map((e) => (e as { text?: string }).text)).toEqual(["a", "A", "b", "B"]);
    expect(session.messages.length).toBe(5);
    db.close();
    manager.dispose();
  });
});
