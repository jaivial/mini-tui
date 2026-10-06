/**
 * End to end: a real server process, a real hub WebSocket, and the real `mini-tui tasks` command
 * writing cards the way an agent does — straight to the database, from another process. The board
 * must arrive over the socket at once and keep arriving as the agents keep writing. Own port and
 * own temp database: the running mini-tui-web service is never involved.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openDb, saveTranscript } from "../src/sessions";

const dir = mkdtempSync(join(tmpdir(), "minitui-wstasks-"));
const dbPath = join(dir, "sessions.db");
// A quiet range: 4600–4899 is web-socket.e2e, 5900+ is the browser e2e scripts, 5000–5200 is often busy dev boxes.
const PORT = 5600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;
const root = join(import.meta.dir, "..");
let proc: ReturnType<typeof Bun.spawn>;

const childEnv = {
  ...process.env,
  MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"),
  MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"),
  MINITUI_SETTINGS_PATH: join(dir, "settings.json"),
  MINITUI_SKILLS_DIR: join(dir, "skills"),
  MINITUI_DB_PATH: dbPath,
  MINITUI_CONFIG_DIR: dir,
  MINITUI_RESUME_DIR: join(dir, "resume"),
  MINITUI_RUNS_DIR: join(dir, "runs"),
  MINITUI_WEB_SYNC_MS: "100",
};

beforeAll(async () => {
  const db = openDb(dbPath);
  for (const id of ["s-alpha", "s-beta"]) {
    createSession(db, { id, cwd: "/tmp", model: "m0", task: `task ${id}` });
    saveTranscript(db, id, [{ type: "task", text: `task ${id}` }, { type: "assistant", text: `hello from ${id}` }], { cost: 0, apiCalls: 1 }, []);
  }
  db.close();
  proc = Bun.spawn({ cmd: ["bun", "src/web/serve.ts", "--port", String(PORT)], cwd: root, env: childEnv, stdout: "ignore", stderr: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch {}
    if (!up) await Bun.sleep(100);
  }
  // Fail where the problem is (the server never started, e.g. the port was taken), not three
  // timeout-riddled tests later.
  if (!up) throw new Error(`the test server never came up on ${base} (port ${PORT})`);
});
afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** The agent's side of the feature: the real command, a process of its own. */
async function agent(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = Bun.spawn({ cmd: ["bun", "src/index.ts", "tasks", ...argv], cwd: root, env: childEnv, stdout: "pipe", stderr: "pipe" });
  return { code: await r.exited, out: await new Response(r.stdout).text(), err: await new Response(r.stderr).text() };
}

type Msg = { t: string; tasks?: { id: string; title: string }[]; [k: string]: unknown };
function hub(): { ws: WebSocket; frames: Msg[]; ready: Promise<void>; close: () => void } {
  const frames: Msg[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/hub`);
  ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
  const ready = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("hub socket failed"));
  });
  return { ws, frames, ready, close: () => ws.close() };
}
const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(cond()) && Date.now() < end) await Bun.sleep(50);
  return cond();
};

describe("task cards reach the hub live", () => {
  test("a card an agent writes lands in the board of a watching tab", async () => {
    const socket = hub();
    await socket.ready;
    socket.ws.send(JSON.stringify({ t: "tasks.watch" }));
    expect(await until(() => socket.frames.some((f) => f.t === "tasks"))).toBe(true);

    const wrote = await agent("set", "--session", "s-alpha", "--title", "Fix login", "--description", "Reworked auth", "--done", "parse", "--left", "tests");
    expect(wrote.code).toBe(0);

    expect(
      await until(() => socket.frames.some((f) => f.t === "tasks" && f.tasks?.some((t) => t.id === "s-alpha" && t.title === "Fix login"))),
    ).toBe(true);
    socket.close();
  });

  test("a second card replaces the first in the pushed board", async () => {
    const socket = hub();
    await socket.ready;
    socket.ws.send(JSON.stringify({ t: "tasks.watch" }));
    expect(await until(() => socket.frames.some((f) => f.t === "tasks"))).toBe(true);

    await agent("set", "--session", "s-beta", "--title", "Second", "--pending", "wire UI");
    expect(await until(() => socket.frames.some((f) => f.t === "tasks" && f.tasks?.some((t) => t.id === "s-beta" && t.title === "Second")))).toBe(true);

    const n = socket.frames.length;
    await agent("set", "--session", "s-beta", "--title", "Second (updated)", "--done", "wire UI");
    expect(await until(() => socket.frames.slice(n).some((f) => f.tasks?.some((t) => t.title === "Second (updated)")))).toBe(true);
    socket.close();
  });

  test("the board also speaks to a tab that watches only now", async () => {
    await agent("set", "--session", "s-alpha", "--title", "Already written", "--done", "x");
    const socket = hub();
    await socket.ready;
    socket.ws.send(JSON.stringify({ t: "tasks.watch" }));
    expect(await until(() => socket.frames.some((f) => f.t === "tasks" && f.tasks?.some((t) => t.title === "Already written")))).toBe(true);
    socket.close();
  });

  test("deleting a session takes its card out of the pushed board", async () => {
    await agent("set", "--session", "s-beta", "--title", "Doomed card", "--done", "x");
    const socket = hub();
    await socket.ready;
    socket.ws.send(JSON.stringify({ t: "tasks.watch" }));
    expect(await until(() => socket.frames.some((f) => f.tasks?.some((t) => t.title === "Doomed card")))).toBe(true);

    const deleted = await fetch(`${base}/api/history/s-beta`, { method: "DELETE" });
    expect(deleted.ok).toBe(true);
    expect(await until(() => socket.frames.some((f) => f.t === "tasks" && !f.tasks?.some((t) => t.id === "s-beta")))).toBe(true);
    socket.close();
  });

  test("the command finds its session by environment alone (what a spawned agent has)", async () => {
    const wrote = await agent("set", "--title", "From env", "--left", "tests");
    // No --session and no MINITUI_SESSION_ID / MSWEA_CONTROL_FILE in `childEnv`: refused, loudly.
    expect(wrote.code).toBe(2);
    expect(wrote.err).toContain("cannot tell which session");

    const named = Bun.spawn({ cmd: ["bun", "src/index.ts", "tasks", "set", "--title", "From env", "--done", "x"], cwd: root, env: { ...childEnv, MINITUI_SESSION_ID: "s-alpha" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(named.stdout).text();
    expect(await named.exited).toBe(0);
    expect(out).toContain("task card saved for s-alpha");
  });
});
