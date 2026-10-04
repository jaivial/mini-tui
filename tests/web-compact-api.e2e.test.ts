/**
 * `/compact` over the HTTP API, end to end.
 *
 * The production failure: a session whose turn had finished (and whose agent had left) refused the
 * command with "compaction needs a live local run: send a message first". Between turns the web app
 * now starts a `--compact-only` run over the saved conversation, like the terminal UI, and the
 * refusals name which of the three cases actually applies.
 *
 * The runner is the real Python console script with the deterministic (scripted, keyless) model, so
 * the compaction actually runs and the transcript really gains a summary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSession, openDb, saveTranscript } from "../src/sessions";

const dir = mkdtempSync(join(tmpdir(), "minitui-compact-api-"));
const dbPath = join(dir, "sessions.db");
const PORT = 4900 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn>;

// A scripted model: the first reply is the summarizer's, the second submits. No network, no key.
const config = join(dir, "script.yaml");
const SUMMARY =
  "SUMMARY: the user asked one question, it was answered in the previous turn, and nothing else is pending but a final confirmation. This summary is deliberately longer than two hundred characters so the agent keeps it verbatim instead of falling back to a truncated transcript of the conversation so far, which would lose the shape of the request.";
writeFileSync(
  config,
  `agent:
  system_template: "system prompt"
  instance_template: "{{task}}"
  next_step_template: "{{observation}}"
model:
  model_class: minisweagent.models.test_models.DeterministicToolcallModel
  model_name: deterministic
  outputs:
    - role: assistant
      content: ${JSON.stringify(SUMMARY)}
      extra: {}
    - role: assistant
      content: "done"
      extra: {submission: "done"}
`,
);

beforeAll(async () => {
  // Another file in this run may have left the runner kind cached as "plain CLI": probe again, with
  // the environment this server actually gets.
  const { resetRunnerSupport } = await import("../src/mini/spawn");
  delete process.env.MINITUI_MINI_BIN;
  delete process.env.MINITUI_EMBEDDED_AGENT;
  resetRunnerSupport();
  const db: Database = openDb(dbPath);
  createSession(db, { id: "s-gone", cwd: dir, model: "", task: "a finished session" });
  // The saved conversation: system, task, answer. Three messages is what `/compact` asks for.
  saveTranscript(
    db,
    "s-gone",
    [
      { type: "task", text: "a finished session" },
      { type: "assistant", text: "the answer, long enough to be worth compacting around" },
    ],
    { cost: 0, apiCalls: 1, exitStatus: "Submitted" },
    [
      { role: "system", content: `system prompt ${"context ".repeat(400)}` },
      { role: "user", content: "a finished session" },
      { role: "assistant", content: `the findings: ${"detail ".repeat(1200)}` },
      { role: "user", content: `and the second request: ${"more ".repeat(1200)}` },
      { role: "assistant", content: "the answer, long enough to be worth compacting around" },
    ] as any,
  );
  db.close();
  proc = Bun.spawn({
    cmd: ["bun", "src/web/serve.ts", "--port", String(PORT)],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      MINITUI_DB_PATH: dbPath,
      MINITUI_CONFIG_DIR: dir,
      MINITUI_RESUME_DIR: join(dir, "resume"),
      MINITUI_RUNS_DIR: join(dir, "runs"),
      MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"),
      MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"),
      MINITUI_SETTINGS_PATH: join(dir, "settings.json"),
      MINITUI_SKILLS_DIR: join(dir, "skills"),
      MSWEA_MINI_CONFIG_PATH: config,
      MINITUI_AGENT: "python", // the integrated (Python) runner, not the Rust agent
      // Other files in this run may have left a stub `mini` (or a deleted one) in the environment:
      // unset it, so the runner is probed from the bundled module instead of a missing script.
      MINITUI_MINI_BIN: "",
      MSWEA_COST_TRACKING: "ignore_errors",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  const opened = await fetch(`${base}/api/history/s-gone`, { method: "POST" });
  if (!opened.ok) throw new Error(`open failed: ${opened.status} ${await opened.text()}`);
});

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (ok: () => boolean | Promise<boolean>, ms = 20000) => {
  for (let t = 0; t < ms / 100; t++) {
    try {
      if (await ok()) return true;
    } catch {}
    await Bun.sleep(100);
  }
  return false;
};

describe("POST /api/sessions/:id/compact", () => {
  test("between turns: a --compact-only run over the saved conversation", async () => {
    const res = await fetch(`${base}/api/sessions/s-gone/compact`, { method: "POST" });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    // A failure names its case; this assertion is what prints it when it does.
    expect(`${res.status} ${body.error ?? ""}`).toBe("200 ");
    // The compaction is visible in the transcript (events) and the run finished cleanly.
    expect(
      await until(async () => {
        const session = (await fetch(`${base}/api/sessions/s-gone`).then((r) => r.json())) as any;
        return session.events.some((e: any) => e.type === "notice" && String(e.text).startsWith("compacted"));
      }),
    ).toBe(true);
    // Like the TUI's compaction between runs, the agent then holds at its exit for the next prompt.
    const session = (await fetch(`${base}/api/sessions/s-gone`).then((r) => r.json())) as any;
    expect(session.status).toBe("running");
    // The saved conversation gained the summary, marked the way every compaction is.
    const row = new Database(dbPath).query("SELECT messages_json FROM sessions WHERE id = ?").get("s-gone") as any;
    const messages = JSON.parse(row.messages_json);
    const summary = messages.find((m: any) => m.extra?.compaction?.reason === "manual");
    expect(String(summary?.content)).toContain("SUMMARY:");
  }, 30000);

  test("an unknown session is 404, not a compaction error", async () => {
    const res = await fetch(`${base}/api/sessions/s-nope/compact`, { method: "POST" });
    const body = (await res.json()) as { error?: string };
    expect(res.status).toBe(404);
    expect(body.error).toContain("unknown session");
  });
});
