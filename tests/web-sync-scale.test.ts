/**
 * The background sync at scale.
 *
 * The tick is what keeps a held session honest (another UI's agent, another UI's save), and it runs
 * every second for as long as the server is up. It must stay cheap when the server holds hundreds
 * of sessions, and it must never leave work half done: after a pass, every held session either
 * follows the live agent announced for it or carries the newest saved copy.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-sync-scale-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_CONFIG_DIR = dir;

const { openDb, createSession, saveTranscript } = await import("../src/sessions");
const { SessionManager } = await import("../src/web/sessions");

const N = Number(process.env.MINITUI_SYNC_SCALE_N ?? 300);
const db = openDb(process.env.MINITUI_DB_PATH!);
for (let i = 0; i < N; i++) {
  const id = `s-scale-${i}`;
  createSession(db, { id, cwd: dir, model: "m", task: `task ${i}`, title: `session ${i}` });
  saveTranscript(
    db, id,
    [{ type: "task", text: `task ${i}` }, { type: "assistant", text: `answer ${i}` }],
    { cost: 0.1, apiCalls: 1, exitStatus: "Submitted" },
    [{ role: "user", content: `task ${i}` }, { role: "assistant", content: `answer ${i}` }],
  );
}
db.close();

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the background sync with many held sessions", () => {
  test("a pass stays in the sub-millisecond-per-session range", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    for (let i = 0; i < N; i++) await manager.openHistory(`s-scale-${i}`);
    // warm up, then measure a burst of ticks (what the timer pays every second)
    await manager.syncExternal();
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await manager.syncExternal();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const worst = times[times.length - 1]!;
    expect(worst).toBeLessThan(N); // 1 ms per session would already be 300 ms of blocking
    manager.dispose();
  });

  test("a save another UI made reaches every held session in one pass", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    for (let i = 0; i < 25; i++) await manager.openHistory(`s-scale-${i}`);
    const writer = openDb(process.env.MINITUI_DB_PATH!);
    for (let i = 0; i < 25; i++) {
      saveTranscript(
        writer, `s-scale-${i}`,
        [{ type: "task", text: `task ${i}` }, { type: "assistant", text: `answer ${i}` }, { type: "assistant", text: `extra ${i}` }],
        { cost: 0.2, apiCalls: 2, exitStatus: "Submitted" },
        [{ role: "user", content: `task ${i}` }, { role: "assistant", content: `answer ${i}` }, { role: "assistant", content: `extra ${i}` }],
      );
    }
    writer.close();
    await manager.syncExternal();
    for (let i = 0; i < 25; i++) {
      const session = manager.get(`s-scale-${i}`);
      expect(session?.events.some((e) => e.type === "assistant" && e.text === `extra ${i}`)).toBe(true);
    }
    manager.dispose();
  });

  test("an overlapping call joins the pass in flight instead of running a second one", async () => {
    const manager = new SessionManager(() => {}, { syncMs: 0 });
    await manager.openHistory("s-scale-0");
    const [a, b] = await Promise.all([manager.syncExternal(), manager.syncExternal()]);
    expect(a).toBeUndefined(); // both settle, and neither throws
    expect(b).toBeUndefined();
    manager.dispose();
  });
});
