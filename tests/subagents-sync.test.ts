/**
 * Subagents of a Rust session as mini-tui sessions: the agent's `subagents/index.json` becomes one
 * session per child (`parent_id` = the parent), its transcript is saved, its live agent announced so
 * the web app can follow it, and the parent lists it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-subagents-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");

const { openDb, createSession, getSession, getLiveRun, listSubagentSessions, registerLiveRun } = await import("../src/sessions");
const { SubagentSync, subagentSessionId } = await import("../src/mini/subagents");
const { SessionManager } = await import("../src/web/sessions");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

function writeChild(runDir: string, name: string, state: string, pid: number) {
  const childDir = join(runDir, "subagents", name);
  mkdirSync(childDir, { recursive: true });
  const traj = join(childDir, "traj.json");
  writeFileSync(
    join(childDir, "traj.jsonl"),
    line({ t: "meta", trajectory_format: "mini-swe-agent-1.1" }) +
      line({ t: "msg", m: { role: "system", content: "s" } }) +
      line({ t: "msg", m: { role: "user", content: `task of ${name}` } }) +
      line({ t: "msg", m: { role: "assistant", content: `answer of ${name}` } }) +
      line({ t: "info", i: { model_stats: { instance_cost: 0.25, api_calls: 1 }, exit_status: "Submitted", submission: `answer of ${name}` } }),
  );
  return { name, state, exit_status: "Submitted", task: `task of ${name}`, cwd: dir, model: "m", steps: 1, cost: 0.25, turns: 1, pid, traj_path: traj, control_path: join(childDir, "control"), idle_s: 0, last_command: "", mem_rss: 412, mem_avg: 380, mem_peak: 460 };
}

describe("subagents as sessions", () => {
  test("the index becomes child sessions with transcripts, listed under the parent", () => {
    const db = openDb(process.env.MINITUI_DB_PATH);
    createSession(db, { id: "s-parent", cwd: dir, model: "m", task: "orchestrate", title: "Parent" });
    const runDir = join(dir, "run");
    mkdirSync(join(runDir, "subagents"), { recursive: true });
    const children = [writeChild(runDir, "api", "waiting", 0), writeChild(runDir, "web", "exited", 0)];
    writeFileSync(join(runDir, "subagents", "index.json"), JSON.stringify({ children }));

    const sync = new SubagentSync(() => db);
    const views = sync.sync("s-parent", join(runDir, "traj.json"));
    expect(views.map((v) => v.name)).toEqual(["api", "web"]);
    expect(views[0]!.sessionId).toBe(subagentSessionId("s-parent", "api"));

    const listed = listSubagentSessions(db, "s-parent");
    expect(listed.map((r) => r.id)).toEqual(["s-parent~api", "s-parent~web"]);
    const row = getSession(db, "s-parent~api")!;
    expect(row.parent_id).toBe("s-parent");
    expect(row.title).toContain("api");
    expect(JSON.parse(row.events_json).some((e: { type: string; text?: string }) => e.type === "assistant" && e.text === "answer of api")).toBe(true);
    expect(row.cost).toBe(0.25);
    // a second sync of an unchanged journal changes nothing (and never duplicates the child)
    sync.sync("s-parent", join(runDir, "traj.json"));
    expect(listSubagentSessions(db, "s-parent").length).toBe(2);
    db.close();
  });

  test("a running child is announced so any UI can attach to it; a finished one is not", () => {
    const db = openDb(process.env.MINITUI_DB_PATH);
    const runDir = join(dir, "run-live");
    mkdirSync(join(runDir, "subagents"), { recursive: true });
    const live = writeChild(runDir, "live", "running", process.pid);
    writeFileSync(join(runDir, "subagents", "index.json"), JSON.stringify({ children: [live] }));
    const sync = new SubagentSync(() => db);
    sync.sync("s-parent", join(runDir, "traj.json"));
    expect(getLiveRun(db, "s-parent~live")?.owner).toBe("subagent");
    // it finishes and its process leaves: the announcement goes with it
    writeFileSync(join(runDir, "subagents", "index.json"), JSON.stringify({ children: [{ ...live, state: "exited" }] }));
    sync.sync("s-parent", join(runDir, "traj.json"));
    expect(getLiveRun(db, "s-parent~live")).toBeNull();
    db.close();
  });

  test("the web server lists a held session's subagents and opens one with its parent link", async () => {
    const db = openDb(process.env.MINITUI_DB_PATH);
    createSession(db, { id: "s-orch", cwd: dir, model: "m", task: "orchestrate", title: "Orchestrator" });
    // The parent's agent is a terminal's: the web app attaches to it (the path a held session's
    // children are synced from).
    const runDir = join(dir, "run-web");
    mkdirSync(join(runDir, "subagents"), { recursive: true });
    const traj = join(runDir, "traj.json");
    writeFileSync(join(runDir, "traj.jsonl"), line({ t: "meta", trajectory_format: "mini-swe-agent-1.1" }) + line({ t: "msg", m: { role: "system", content: "s" } }) + line({ t: "msg", m: { role: "user", content: "orchestrate" } }));
    writeFileSync(join(runDir, "subagents", "index.json"), JSON.stringify({ children: [writeChild(runDir, "docs", "waiting", 0)] }));
    // A process whose command line names the trajectory, like the agent's `-o <traj>`.
    const script = join(runDir, "hold.ts");
    writeFileSync(script, "await Bun.sleep(30000);\n");
    const holder = Bun.spawn({ cmd: [process.execPath, script, "-o", traj], stdout: "ignore" });
    await Bun.sleep(150);
    registerLiveRun(db, { session_id: "s-orch", traj_path: traj, control_path: join(runDir, "control"), pid: holder.pid, owner: "tui" });
    db.close();

    const manager = new SessionManager(() => {}, { syncMs: 0 });
    try {
      const parent = manager.openHistory("s-orch");
      manager.syncExternal();
      expect(parent.subagents?.map((s) => s.name)).toEqual(["docs"]);
      const child = manager.openHistory(parent.subagents![0]!.sessionId);
      expect(child.parentId).toBe("s-orch");
      expect(child.events.some((e) => e.type === "assistant" && e.text === "answer of docs")).toBe(true);
    } finally {
      manager.dispose();
      holder.kill();
    }
  });
});
