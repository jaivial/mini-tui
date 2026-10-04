/**
 * `/compact` in the web app.
 *
 * Reproduces the production failure: a session whose turn has finished (status `done`, the
 * agent still holding its control file) refused `/compact` with "compaction needs a live
 * local run: send a message first". The terminal UI gates on process liveness instead, so
 * the same click works there — the web app must behave the same way.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-compact-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_RUNS_DIR = join(dir, "runs");
process.env.MINITUI_SETTINGS_PATH = join(dir, "settings.json");
process.env.MINITUI_CONFIG_DIR = dir;
process.env.MINITUI_LAST_MODEL_PATH = join(dir, "last-model.json");
process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
// The stub holds the control channel open (a live run sitting at its exit) and writes a small
// trajectory, so the session has a saved conversation and a finished turn: exactly the shape
// the production session was in when `/compact` was refused.
const stub = join(dir, "mini-stub");
process.env.MINITUI_MINI_BIN = stub;
const stubScript = [
  "#!/bin/sh",
  "trap 'exit 0' TERM INT",
  'for a in "$@"; do case "$prev" in -o) TRAJ="$a";; esac; prev="$a"; done',
  "cat > \"$TRAJ\" <<JSON",
  '{"info":{"model_stats":{"instance_cost":0.01,"api_calls":2},"exit_status":"Submitted"},"messages":[',
  '{"role":"system","content":"system prompt"},',
  '{"role":"user","content":"first turn"},',
  '{"role":"assistant","content":"the first answer, long enough to be worth keeping in the transcript"},',
  '{"role":"exit","content":"the first answer","extra":{"exit_status":"Submitted","submission":"the first answer"}}',
  '],"trajectory_format":"mini-swe-agent-1.1"}',
  "JSON",
  "while :; do sleep 0.2; done",
].join("\n");
writeFileSync(stub, stubScript);
chmodSync(stub, 0o755);
process.env.MINITUI_EMBEDDED_AGENT = "0";

const { SessionManager } = await import("../src/web/sessions");

const manager = new SessionManager(() => {});

afterAll(async () => {
  for (const s of manager.list()) await manager.close(s.id);
  rmSync(dir, { recursive: true, force: true });
});

describe("the web /compact command", () => {
  test("compacts a session whose turn has finished", async () => {
    const session = await manager.create({ prompt: "first turn", cwd: dir, target: "local" });
    for (let i = 0; i < 40 && manager.get(session.id)!.messages.length === 0; i++) await Bun.sleep(100);
    const live = manager.get(session.id)!;
    expect(live.messages.length).toBeGreaterThan(0);
    // The turn is over (the watcher saw a trailing exit), the process still holds the channel.
    live.events.push({ type: "exit", exitStatus: "Submitted", submission: "ok" });
    live.status = "done";
    manager.compact(session.id);
    const notice = live.events.filter((e) => e.type === "notice").at(-1) as any;
    expect(notice.text).toContain("compacting");
  });

  test("still refuses when nothing runs and there is nothing to continue", () => {
    expect(() => manager.compact("s-nope")).toThrow("unknown session");
  });
});
