/**
 * End to end: a real server process, real WebSockets. Two sessions are restored from a temp
 * history database (no agent is spawned), then one is changed and the other must stay silent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSession, openDb, saveTranscript } from "../src/sessions";

const dir = mkdtempSync(join(tmpdir(), "minitui-ws-"));
const dbPath = join(dir, "sessions.db");
const PORT = 4600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  const db: Database = openDb(dbPath);
  for (const id of ["s-alpha", "s-beta"]) {
    createSession(db, { id, cwd: "/tmp", model: "m0", task: `task ${id}` });
    saveTranscript(db, id, [{ type: "task", text: `task ${id}` }, { type: "assistant", text: `hello from ${id}` }], { cost: 0, apiCalls: 1 }, []);
  }
  db.close();
  proc = Bun.spawn({
    cmd: ["bun", "src/web/serve.ts", "--port", String(PORT)],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  for (const id of ["s-alpha", "s-beta"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });
});
afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

type F = { t: string; id: string; [k: string]: any };
function open(id: string, headers?: Record<string, string>) {
  const frames: F[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/sessions/${id}/socket`, { headers } as never);
  ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
  const ready = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("socket error"));
  });
  return { ws, frames, ready };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(20);
  return cond();
};

describe("one socket per session", () => {
  test("each socket opens with a snapshot of its own session only", async () => {
    const a = open("s-alpha");
    const b = open("s-beta");
    await Promise.all([a.ready, b.ready]);
    expect(await until(() => a.frames.length > 0 && b.frames.length > 0)).toBe(true);
    expect(a.frames[0]).toMatchObject({ t: "snapshot", id: "s-alpha" });
    expect(JSON.stringify(a.frames[0])).toContain("hello from s-alpha");
    expect(JSON.stringify(a.frames[0])).not.toContain("hello from s-beta");
    expect("messages" in a.frames[0]!.session).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  test("a change to one session is streamed to its socket and never to the other", async () => {
    const a = open("s-alpha");
    const b = open("s-beta");
    await Promise.all([a.ready, b.ready]);
    await until(() => a.frames.length > 0 && b.frames.length > 0);
    const beforeB = b.frames.length;
    const res = await fetch(`${base}/api/sessions/s-alpha/model`, { method: "POST", body: JSON.stringify({ model: "xiaomi/mimo-v2.6-pro" }) });
    expect(res.ok).toBe(true);
    expect(await until(() => a.frames.some((f) => f.t === "delta"))).toBe(true);
    const delta = a.frames.find((f) => f.t === "delta")!;
    expect(delta.id).toBe("s-alpha");
    expect(delta.from).toBe(2);
    expect(JSON.stringify(delta.events)).toContain("xiaomi/mimo-v2.6-pro");
    expect(delta.meta.model).toBe("xiaomi/mimo-v2.6-pro");
    await Bun.sleep(150);
    expect(b.frames.length).toBe(beforeB);
    a.ws.close();
    b.ws.close();
  });

  test("two tabs on the same session both stay current", async () => {
    const t1 = open("s-beta");
    const t2 = open("s-beta");
    await Promise.all([t1.ready, t2.ready]);
    await until(() => t1.frames.length > 0 && t2.frames.length > 0);
    await fetch(`${base}/api/sessions/s-beta/model`, { method: "POST", body: JSON.stringify({ model: "deepseek/deepseek-chat" }) });
    expect(await until(() => [t1, t2].every((t) => t.frames.some((f) => f.t === "delta")))).toBe(true);
    t1.ws.close();
    t2.ws.close();
  });

  test("resync replays the full transcript on request", async () => {
    const a = open("s-alpha");
    await a.ready;
    await until(() => a.frames.length > 0);
    a.ws.send(JSON.stringify({ t: "resync" }));
    expect(await until(() => a.frames.filter((f) => f.t === "snapshot").length === 2)).toBe(true);
    expect(a.frames.at(-1)!.session.events.length).toBeGreaterThanOrEqual(3);
    a.ws.close();
  });

  test("closing a session tells its socket, and only its socket", async () => {
    const a = open("s-alpha");
    const b = open("s-beta");
    await Promise.all([a.ready, b.ready]);
    await until(() => a.frames.length > 0 && b.frames.length > 0);
    const beforeB = b.frames.length;
    await fetch(`${base}/api/sessions/s-alpha`, { method: "DELETE" });
    expect(await until(() => a.frames.some((f) => f.t === "gone"))).toBe(true);
    await Bun.sleep(100);
    expect(b.frames.length).toBe(beforeB);
    b.ws.close();
  });
});

describe("the socket endpoint refuses what it should", () => {
  test("an unknown session is a 404, not an open socket", async () => {
    const res = await fetch(`${base}/api/sessions/s-nope/socket`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
  test("a plain GET without an upgrade is refused", async () => {
    expect((await fetch(`${base}/api/sessions/s-beta/socket`)).status).toBe(426);
  });
  test("a cross-site page cannot open it", async () => {
    const res = await fetch(`${base}/api/sessions/s-beta/socket`, { headers: { upgrade: "websocket", origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
  test("the session list is metadata only", async () => {
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as any[];
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect("events" in s).toBe(false);
      expect("messages" in s).toBe(false);
    }
  });
});

describe("settings, providers, commands and skills over HTTP", () => {
  const json = (path: string, init?: RequestInit) => fetch(`${base}/api${path}`, init);

  test("commands and skills lists are served", async () => {
    const commands = (await (await json("/commands")).json()) as any[];
    expect(commands.map((c) => c.name)).toContain("new");
    expect(Array.isArray(await (await json("/skills")).json())).toBe(true);
  });

  test("settings round-trip, and junk is ignored", async () => {
    const put = await json("/settings", { method: "PATCH", body: JSON.stringify({ outputMode: "expanded", evil: 1 }) });
    expect(((await put.json()) as any).outputMode).toBe("expanded");
    const got = (await (await json("/settings")).json()) as any;
    expect(got.outputMode).toBe("expanded");
    expect("evil" in got).toBe(false);
  });

  test("the provider list never contains a key", async () => {
    const body = await (await json("/providers")).text();
    expect(body).not.toMatch(/"key"\s*:/);
    expect((JSON.parse(body) as any).catalog.length).toBeGreaterThan(5);
  });

  test("connecting with an empty or malformed key is a 400 with no network call", async () => {
    for (const key of ["", "two words"]) {
      const res = await json("/providers/connect", { method: "POST", body: JSON.stringify({ providerId: "deepseek", key }) });
      expect(res.status).toBe(400);
    }
    expect((await json("/providers/connect", { method: "POST", body: JSON.stringify({ providerId: "nope", key: "sk-x-aaaaaaaaaaaa" }) })).status).toBe(400);
  });

  test("disconnecting something that is not connected is a 404", async () => {
    expect((await json("/providers/deepseek", { method: "DELETE" })).status).toBe(404);
  });

  test("a page on another site cannot change anything (cross-origin writes are refused)", async () => {
    const evil = { origin: "https://evil.example" };
    for (const [path, method, body] of [
      ["/settings", "PATCH", { outputMode: "trim" }],
      ["/providers/connect", "POST", { providerId: "deepseek", key: "sk-x-aaaaaaaaaaaa" }],
      ["/sessions", "POST", { prompt: "rm -rf", target: "local" }],
      ["/sessions/s-beta/model", "POST", { model: "x/y" }],
    ] as const) {
      const res = await json(path, { method, headers: evil, body: JSON.stringify(body) });
      expect(res.status).toBe(403);
    }
    // ...and nothing changed
    expect(((await (await json("/settings")).json()) as any).outputMode).toBe("expanded");
  });

  test("compaction is refused (409) when there is no live run", async () => {
    const res = await json("/sessions/s-beta/compact", { method: "POST" });
    expect(res.status).toBe(409);
  });
});
