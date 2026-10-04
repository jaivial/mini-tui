/**
 * `/compact` with no live agent: the `--compact-only` resumed run.
 *
 * The terminal UI starts one when the agent has already left; the web app must do the same instead
 * of refusing. The console-script runner is stubbed, so the test can assert on the argv it is
 * handed and on the transcript the compaction produces.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-compact2-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_RUNS_DIR = join(dir, "runs");
process.env.MINITUI_SETTINGS_PATH = join(dir, "settings.json");
process.env.MINITUI_CONFIG_DIR = dir;
process.env.MINITUI_LAST_MODEL_PATH = join(dir, "last-model.json");
process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
// `mini` and the console script it sits beside, both stubbed: the runner looks for the console
// script next to `mini`, and it is the one that accepts `--compact-only`.
const mini = join(dir, "mini");
const runner = join(dir, "mini-swe-agent-tui");
process.env.MINITUI_MINI_BIN = mini;
for (const target of [mini, runner]) {
  copyFileSync(new URL("./fixtures/compact_runner.py", import.meta.url), target);
  chmodSync(target, 0o755);
}
const log = join(dir, "argv.log");
process.env.STUB_LOG = log;
// Everything this file sets is undone afterwards: these leak into other files otherwise (bun runs
// them in one process), which would send real runs to the stub.
const savedEnv: Record<string, string | undefined> = {};
for (const k of ["MINITUI_MINI_BIN", "STUB_LOG", "MINITUI_EMBEDDED_AGENT", "MSWEA_MINI_CONFIG_PATH"]) {
  savedEnv[k] = process.env[k];
}

const spawn = await import("../src/mini/spawn");
// The run must reach the stub even though `mini` itself is one, so the runner kind is forced to
// the console-script entry point (the one that accepts `--compact-only`).
spawn.setRunnerSupport("argv");

const { SessionManager } = await import("../src/web/sessions");
const manager = new SessionManager(() => {});

afterAll(async () => {
  for (const s of manager.list()) await manager.close(s.id);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  spawn.resetRunnerSupport();
  rmSync(dir, { recursive: true, force: true });
});

describe("/compact with no live agent", () => {
  test("starts a --compact-only run over the saved conversation", async () => {
    const session = await manager.create({ prompt: "first turn", cwd: dir, target: "local" });
    for (let i = 0; i < 300 && (manager.get(session.id) as any).messages.length === 0; i++) {
      await Bun.sleep(100);
    }
    const live = manager.get(session.id) as any;
    expect(live.messages.length).toBeGreaterThan(0);
    // The agent has left: close the session and reopen it from the saved history, which is the
    // state "a session nothing is running for" comes back in.
    const saved = live.messages.length;
    manager.close(session.id);
    const reopened = (manager as any).openHistory(session.id) as any;
    expect(reopened.messages.length).toBe(saved);
    manager.compact(session.id);
    for (let i = 0; i < 200; i++) {
      await Bun.sleep(100);
      const events = (manager.get(session.id) as any).events;
      if (events.some((e: any) => e.type === "notice" && String(e.text).startsWith("compacted"))) break;
    }
    const argv = (await Bun.file(log).text()).trim().split("\n");
    expect(argv.length).toBe(2);
    const compact = argv[1].split(" ");
    expect(compact).toContain("--compact-only");
    expect(compact).toContain("--resume");
    expect(compact.indexOf("-t")).toBe(-1);
    // The transcript shows the command was accepted and the summary landed.
    const events = (manager.get(session.id) as any).events;
    expect(events.some((e: any) => e.type === "notice" && String(e.text).includes("compacting"))).toBe(true);
    expect(events.some((e: any) => e.type === "notice" && String(e.text).startsWith("compacted"))).toBe(true);
  });

  test("a second /compact goes to the held run, and interrupt stops it", async () => {
    const session = (manager as any).list()[0];
    (manager as any).close(session.id);
    const reopened = (manager as any).openHistory(session.id);
    (manager as any).compact(reopened.id);
    // The compaction run holds the control file, so it looks live: a second command is handed to
    // that run instead of starting another agent on top of it.
    const before = (await Bun.file(log).text()).trim().split("\n").length;
    (manager as any).compact(reopened.id);
    expect((await Bun.file(log).text()).trim().split("\n").length).toBe(before);
    (manager as any).interrupt(reopened.id);
    expect((manager as any).get(reopened.id).status).toBe("interrupted");
  });

  test("refuses honestly when only the plain CLI is installed", () => {
    spawn.setRunnerSupport("cli");
    const session = (manager as any).list()[0];
    expect((session as any).messages.length).toBeGreaterThan(2);
    // Nothing is running for it now (the previous test interrupted its compaction run): with only
    // the plain CLI there is no way to compact between turns, and the refusal says so.
    (manager as any).close(session.id);
    const reopened = (manager as any).openHistory(session.id);
    expect(() => (manager as any).compact(reopened.id)).toThrow("integrated runner");
    spawn.setRunnerSupport("argv");
  });
});
