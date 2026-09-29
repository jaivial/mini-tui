/**
 * A server restart (a deploy) forgets every open session: they live in memory. A browser that still
 * shows them must get them back on its next socket or fetch, not a 404 that turns its panes into new
 * chats. A real server process, restarted between the two halves.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openDb, saveTranscript } from "../src/sessions";

const dir = mkdtempSync(join(tmpdir(), "minitui-restore-"));
const dbPath = join(dir, "sessions.db");
const PORT = 4950 + Math.floor(Math.random() * 40);
const base = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn> | undefined;

async function start() {
  proc = Bun.spawn({
    cmd: ["bun", "src/web/serve.ts", "--port", String(PORT)],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs"), MINITUI_WEB_TERMINAL: "0" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}
async function stop() {
  proc?.kill();
  await proc?.exited;
  proc = undefined;
}
function firstFrame(id: string): Promise<{ open: boolean; frame?: any; code?: number }> {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sessions/${id}/socket`);
    const t = setTimeout(() => res({ open: false }), 4000);
    ws.onmessage = (m) => {
      clearTimeout(t);
      res({ open: true, frame: JSON.parse(String(m.data)) });
      ws.close();
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      clearTimeout(t);
      res({ open: false, code: e.code });
    };
  });
}

beforeAll(async () => {
  const db = openDb(dbPath);
  createSession(db, { id: "s-saved", cwd: "/tmp", model: "m0", task: "saved task" });
  saveTranscript(db, "s-saved", [{ type: "task", text: "saved task" }, { type: "assistant", text: "the saved answer" }], { cost: 0, apiCalls: 1 }, []);
  db.close();
  await start();
});
afterAll(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

test("before and after a restart, a socket for a saved session gets its transcript", async () => {
  expect((await fetch(`${base}/api/history/s-saved`, { method: "POST" })).status).toBe(200);
  const before = await firstFrame("s-saved");
  expect(before.frame?.t).toBe("snapshot");

  await stop();
  await start();
  // The new process holds nothing yet...
  expect((await (await fetch(`${base}/api/sessions`)).json()).length).toBe(0);
  // ...and still the browser's socket (what a pane reconnects with) gets the session back.
  const after = await firstFrame("s-saved");
  expect(after.open).toBe(true);
  expect(after.frame?.t).toBe("snapshot");
  expect(JSON.stringify(after.frame.session.events)).toContain("the saved answer");
  // It is held again: it shows up in the session list for every tab.
  expect((await (await fetch(`${base}/api/sessions`)).json()).map((s: { id: string }) => s.id)).toContain("s-saved");
});

test("after a restart, GET /api/sessions/:id restores a saved session instead of a 404", async () => {
  await stop();
  await start();
  const res = await fetch(`${base}/api/sessions/s-saved`);
  expect(res.status).toBe(200);
  expect((await res.json()).id).toBe("s-saved");
});

test("an id that is nowhere, not even saved, is still a 404 (the pane really is gone)", async () => {
  expect((await fetch(`${base}/api/sessions/s-nowhere`)).status).toBe(404);
  const ws = await firstFrame("s-nowhere");
  expect(ws.open).toBe(false);
});
