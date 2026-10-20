/**
 * "¿Existe esta sesión?" is a QUESTION. The route that used to answer it (`GET /sessions/:id`)
 * answered by OPENING the session: `held()` is `openHistory`, which rehydrates a LiveSession, puts
 * the id back on the durable open list (`web_open_sessions`, durable since #345) and announces it to
 * every tab. So a client that merely wondered whether a session was still there — the socket's
 * "was that handshake refused because the session is gone?" — brought a CLOSED session back to life,
 * and the next deploy kept it open for good.
 *
 * `GET /sessions/:id/exists` answers the same question with a read and no write. These tests pin
 * that: the read-only route leaves the database and the live list untouched, while the routes that
 * are supposed to OPEN (the explicit `POST /history/:id`, and the old restoring GET) still do.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSession, openDb, saveTranscript } from "../src/sessions";

const dir = mkdtempSync(join(tmpdir(), "minitui-exists-"));
const dbPath = join(dir, "sessions.db");
// A quiet band: dev boxes are full of services around 4300-6500, and a taken port fails opaquely.
const PORT = 7900 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn> | undefined;

async function start() {
  proc = Bun.spawn({
    cmd: ["bun", "src/web/serve.ts", "--port", String(PORT)],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"),
      MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"),
      MINITUI_SETTINGS_PATH: join(dir, "settings.json"),
      MINITUI_SKILLS_DIR: join(dir, "skills"),
      MINITUI_DB_PATH: dbPath,
      MINITUI_CONFIG_DIR: dir,
      MINITUI_RESUME_DIR: join(dir, "resume"),
      MINITUI_RUNS_DIR: join(dir, "runs"),
      MINITUI_WEB_TERMINAL: "0",
    },
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

/** The durable open list, read straight from the file the server writes. */
function openMarkers(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT session_id FROM web_open_sessions").all() as Array<{ session_id: string }>).map((r) => r.session_id);
  } finally {
    db.close();
  }
}
/** The sessions the server holds RIGHT NOW (its live list). */
async function liveSessions(): Promise<string[]> {
  return ((await (await fetch(`${base}/api/sessions`)).json()) as Array<{ id: string }>).map((s) => s.id);
}

beforeAll(async () => {
  const db = openDb(dbPath);
  createSession(db, { id: "s-closed", cwd: "/tmp", model: "m0", task: "closed task", title: "Closed" });
  saveTranscript(db, "s-closed", [{ type: "task", text: "closed task" }, { type: "assistant", text: "the answer" }], { cost: 0, apiCalls: 1 }, []);
  db.close();
  await start();
  // Open it once so it has been live, then close it: closing KEEPS the row (that is how "Resume"
  // finds it) but drops it from the live list and from the durable open list.
  expect((await fetch(`${base}/api/history/s-closed`, { method: "POST" })).status).toBe(200);
  expect((await fetch(`${base}/api/sessions/s-closed`, { method: "DELETE" })).status).toBe(200);
});
afterAll(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a closed session is closed: no live session, no open marker", async () => {
  expect(await liveSessions()).not.toContain("s-closed");
  expect(openMarkers()).not.toContain("s-closed");
});

test("asking whether it exists does not open it", async () => {
  const res = await fetch(`${base}/api/sessions/s-closed/exists`);
  expect(res.status).toBe(200);
  expect((await res.json()).exists).toBe(true);
  // The whole point: the answer cost nothing. No LiveSession was rehydrated and no durable open
  // marker was written, so the next deploy will not bring it back either.
  expect(await liveSessions()).not.toContain("s-closed");
  expect(openMarkers()).not.toContain("s-closed");
});

test("a session that is deleted AFTER being asked about stops existing (no stale cache)", async () => {
  // The browser revalidates a JSON read with the ETag the server gave it. Two sessions that both
  // answer `{exists:true}` share the same body, so the verdict must come from the DATABASE every
  // time, never from a cached body: a session deleted between two questions must read as gone.
  const first = await fetch(`${base}/api/sessions/s-closed/exists`);
  expect(first.status).toBe(200);
  const etag = first.headers.get("etag");
  expect(etag).toBeTruthy();
  // Delete it for good: the row is gone, so the id is nowhere.
  expect((await fetch(`${base}/api/history/s-closed`, { method: "DELETE" })).status).toBe(200);
  // The same question, now carrying the validator the browser kept.
  const second = await fetch(`${base}/api/sessions/s-closed/exists`, { headers: { "if-none-match": etag! } });
  expect(second.status).toBe(200);
  expect((await second.json()).exists).toBe(false);
  // Put it back for the tests that follow.
  const db = openDb(dbPath);
  createSession(db, { id: "s-closed", cwd: "/tmp", model: "m0", task: "closed task", title: "Closed" });
  saveTranscript(db, "s-closed", [{ type: "task", text: "closed task" }, { type: "assistant", text: "the answer" }], { cost: 0, apiCalls: 1 }, []);
  db.close();
});

test("the existence route answers only a question (no other method acts on it)", async () => {
  // A `POST` to the question is not a question: it must not open anything, and it must not answer
  // with a body that says "yes, it exists" either.
  const res = await fetch(`${base}/api/sessions/s-closed/exists`, { method: "POST" });
  expect(res.status).toBe(404);
  expect(await liveSessions()).not.toContain("s-closed");
  expect(openMarkers()).not.toContain("s-closed");
});

test("DELETE on the existence route does not close the session (it is not that route)", async () => {
  // `DELETE /api/sessions/:id` closes a session. `DELETE /api/sessions/:id/exists` is not that
  // route: it must not close anything, or a typo would put a session away.
  expect((await fetch(`${base}/api/history/s-closed`, { method: "POST" })).status).toBe(200);
  expect(await liveSessions()).toContain("s-closed");
  const res = await fetch(`${base}/api/sessions/s-closed/exists`, { method: "DELETE" });
  expect(res.status).toBe(404);
  expect(await liveSessions()).toContain("s-closed");
  expect((await fetch(`${base}/api/sessions/s-closed`, { method: "DELETE" })).status).toBe(200);
});

test("an id that is nowhere says so in the body (the pane really is gone)", async () => {
  const res = await fetch(`${base}/api/sessions/s-nowhere/exists`);
  expect(res.status).toBe(200);
  expect((await res.json()).exists).toBe(false);
});

test("the verdict rides in the BODY, so a routing 404 can never be read as an answer", async () => {
  // A bundle NEWER than its server asks a route the server does not have, and the server's
  // catch-all answers 404 {"error":"not found"}. If the verdict rode in the STATUS, that 404 would
  // be read as "the session is nowhere" and the browser would wipe a LIVE pane -- the E52 symptom
  // through the other door. The route answers 200 with the verdict in the body, so the only 404
  // this client can meet is a routing miss, which it reads as "could not tell" (keep trying).
  const res = await fetch(`${base}/api/sessions/s-nowhere/exists`);
  expect(res.status).toBe(200);
  // The body is the ONLY place the verdict lives, and it is a boolean, never an error string.
  const body = (await res.json()) as { exists?: unknown; error?: unknown };
  expect(body.exists).toBe(false);
  expect(body.error).toBeUndefined();
});

test("the explicit opening still opens it, and only that one does", async () => {
  expect((await fetch(`${base}/api/history/s-closed`, { method: "POST" })).status).toBe(200);
  expect(await liveSessions()).toContain("s-closed");
  expect(openMarkers()).toContain("s-closed");
  // Close it again so the file ends where it started.
  expect((await fetch(`${base}/api/sessions/s-closed`, { method: "DELETE" })).status).toBe(200);
  expect(await liveSessions()).not.toContain("s-closed");
  expect(openMarkers()).not.toContain("s-closed");
});

test("the old restoring GET still restores (its own contract, unchanged)", async () => {
  const res = await fetch(`${base}/api/sessions/s-closed`);
  expect(res.status).toBe(200);
  expect((await res.json()).id).toBe("s-closed");
  // It restores, so it is live and marked open again: that is what distinguishes it from the
  // read-only question, and it is why the existence check needed a route of its own.
  expect(await liveSessions()).toContain("s-closed");
  expect(openMarkers()).toContain("s-closed");
});
