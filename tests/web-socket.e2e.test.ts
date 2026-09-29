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


describe("history over HTTP: list, search, open, close, delete", () => {
  const api = (path: string, init?: RequestInit) => fetch(`${base}/api${path}`, init);

  test("the list is light: no transcript, a resumable flag, and an open flag", async () => {
    const rows = (await (await api("/history")).json()) as any[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect("events_json" in r || "messages_json" in r).toBe(false);
      expect(typeof r.resumable).toBe("boolean");
      expect(typeof r.open).toBe("boolean");
    }
  });

  test("?q= searches, and a % is a character rather than a wildcard", async () => {
    expect(((await (await api("/history?q=task%20s-beta")).json()) as any[]).map((r) => r.id)).toContain("s-beta");
    expect(await (await api("/history?q=%25")).json()).toEqual([]);
    expect(await (await api("/history?q=zzz-nothing-matches")).json()).toEqual([]);
  });

  test("?limit= caps the page; nonsense falls back to the default", async () => {
    expect(((await (await api("/history?limit=1")).json()) as any[]).length).toBe(1);
    expect(((await (await api("/history?limit=abc")).json()) as any[]).length).toBeGreaterThan(0);
  });

  test("opening an unknown id is a 404, and opening a real one returns its transcript", async () => {
    expect((await api("/history/s-nope", { method: "POST" })).status).toBe(404);
    const res = await api("/history/s-beta", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("s-beta");
    expect(body.events.length).toBeGreaterThan(0);
    expect("messages" in body).toBe(false); // raw model messages never leave the server
  });

  test("closing an open session keeps it in the history; deleting it does not", async () => {
    await api("/history/s-beta", { method: "POST" });
    expect((await api("/sessions/s-beta", { method: "DELETE" })).status).toBe(200);
    const after = (await (await api("/history")).json()) as any[];
    expect(after.find((r) => r.id === "s-beta")).toMatchObject({ open: false });
    expect((await api("/history/s-beta", { method: "DELETE" })).status).toBe(200);
    expect(((await (await api("/history")).json()) as any[]).some((r) => r.id === "s-beta")).toBe(false);
    expect((await api("/history/s-beta", { method: "DELETE" })).status).toBe(404);
  });

  test("a cross-site page cannot open, delete or search-scrape the history", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await api("/history/s-alpha", { method: "POST", headers: evil })).status).toBe(403);
    expect((await api("/history/s-alpha", { method: "DELETE", headers: evil })).status).toBe(403);
  });

  test("sending to a session that cannot be continued is a 409 with the reason", async () => {
    // s-alpha was deleted above by an earlier test in this file; recreate a message-less one through the DB
    const { openDb: open, createSession: create } = await import("../src/sessions");
    const db = open(dbPath);
    create(db, { id: "s-empty", cwd: "/tmp", model: "m", task: "never ran" });
    db.close();
    await api("/history/s-empty", { method: "POST" });
    const res = await api("/sessions/s-empty/prompt", { method: "POST", body: JSON.stringify({ prompt: "hello?" }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/no saved conversation/);
  });
});

describe("notes: the hub socket only", () => {
  const wsBase = base.replace(/^http/, "ws");
  /** A hub client: collects every message, and waits for the next one matching `pred`. */
  async function client(origin?: string) {
    const ws = new WebSocket(`${wsBase}/api/hub`, origin ? ({ headers: { origin } } as never) : undefined);
    const got: any[] = [];
    const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      got.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    };
    const opened = await new Promise<boolean>((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); ws.onclose = () => res(false); });
    const next = (pred: (m: any) => boolean, ms = 3000) =>
      new Promise<any>((resolve, reject) => {
        const found = got.find(pred);
        if (found) { got.splice(got.indexOf(found), 1); return resolve(found); }
        const t = setTimeout(() => reject(new Error("timed out waiting for a hub message")), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); got.splice(got.indexOf(m), 1); resolve(m); } });
      });
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    return { ws, got, next, send, opened };
  }

  test("there is no REST endpoint for notes any more", async () => {
    expect((await fetch(`${base}/api/notes/s-x`)).status).toBe(404);
    expect((await fetch(`${base}/api/notes/s-x`, { method: "PUT", body: JSON.stringify({ body: "x" }) })).status).toBe(404);
  });

  test("the hub greets, a watch returns the current note at once", async () => {
    const a = await client();
    expect((await a.next((m) => m.t === "hello")).limits.noteMax).toBe(200_000);
    a.send({ t: "note.watch", id: "s-hub-1" });
    expect(await a.next((m) => m.t === "note")).toEqual({ t: "note", note: { id: "s-hub-1", body: "", updatedAt: 0 } });
    a.ws.close();
  });

  test("two tabs: a save in one is pushed live to the other; a stale save is a conflict", async () => {
    const a = await client(), b = await client();
    for (const c of [a, b]) {
      c.send({ t: "note.watch", id: "s-hub-2" });
      await c.next((m) => m.t === "note");
    }
    a.send({ t: "note.save", id: "s-hub-2", body: "from tab A", base: 0, req: 1 });
    const saved = await a.next((m) => m.t === "note.saved" && m.req === 1);
    expect(saved.note.body).toBe("from tab A");
    const pushed = await b.next((m) => m.t === "note");
    expect(pushed.note).toEqual(saved.note); // B heard it without asking
    b.send({ t: "note.save", id: "s-hub-2", body: "stale from B", base: 0, req: 9 });
    const c = await b.next((m) => m.t === "note.conflict" && m.req === 9);
    expect(c.current.body).toBe("from tab A");
    await Bun.sleep(150);
    expect(a.got.filter((m) => m.t === "note")).toEqual([]); // nothing was pushed for the refused save
    a.ws.close();
    b.ws.close();
  });

  test("a new watcher after a reconnect gets the latest value (nothing is missed while away)", async () => {
    const a = await client();
    a.send({ t: "note.save", id: "s-hub-3", body: "written while you were away", base: 0, req: 1 });
    await a.next((m) => m.t === "note.saved");
    a.ws.close();
    const b = await client();
    b.send({ t: "note.watch", id: "s-hub-3" });
    expect((await b.next((m) => m.t === "note")).note.body).toBe("written while you were away");
    b.ws.close();
  });

  test("the longest note allowed saves over the socket, emoji and all", async () => {
    const a = await client();
    const body = "🦤".repeat(100_000); // 100 000 characters, 400 KB of UTF-8
    a.send({ t: "note.save", id: "s-hub-big", body, base: 0, req: 1 });
    const saved = await a.next((m) => m.t === "note.saved", 5000);
    expect(saved.note.body.length).toBe(body.length);
    const full = "x".repeat(199_990) + '\n"\\\t';
    a.send({ t: "note.save", id: "s-hub-big2", body: full.slice(0, 200_000), base: 0, req: 2 });
    expect((await a.next((m) => m.t === "note.saved" && m.req === 2, 5000)).note.body.length).toBe(Math.min(full.length, 200_000));
    a.ws.close();
  });

  test("bad saves are answered, not dropped: too long, bad id", async () => {
    const a = await client();
    a.send({ t: "note.save", id: "s-hub-4", body: "x".repeat(200_001), req: 5 });
    expect((await a.next((m) => m.t === "error" && m.req === 5)).error).toMatch(/at most/);
    a.send({ t: "note.watch", id: "../../etc/passwd" });
    expect((await a.next((m) => m.t === "error")).error).toBe("invalid note id");
    a.ws.close();
  });

  test("another site cannot open the hub", async () => {
    const evil = await client("https://evil.example");
    expect(evil.opened).toBe(false);
    const res = await fetch(`${base}/api/hub`, { headers: { upgrade: "websocket", connection: "Upgrade", origin: "https://evil.example", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    expect(res.status).toBe(403);
  });

  test("deleting a saved session empties its note for everyone watching", async () => {
    await fetch(`${base}/api/history/s-alpha`, { method: "POST" });
    const a = await client();
    a.send({ t: "note.save", id: "s-alpha", body: "alpha notes", base: 0, req: 1 });
    await a.next((m) => m.t === "note.saved");
    a.send({ t: "note.watch", id: "s-alpha" });
    await a.next((m) => m.t === "note" && m.note.body === "alpha notes");
    expect((await fetch(`${base}/api/history/s-alpha`, { method: "DELETE" })).status).toBe(200);
    expect((await a.next((m) => m.t === "note")).note).toEqual({ id: "s-alpha", body: "", updatedAt: 0 });
    a.ws.close();
  });
});

describe("terminals: over the same hub socket", () => {
  const wsBase = base.replace(/^http/, "ws");
  async function client() {
    const ws = new WebSocket(`${wsBase}/api/hub`);
    const got: any[] = [];
    ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
    await new Promise((r) => (ws.onopen = r));
    const text = (id: string) => got.filter((m) => m.t === "term.data" && m.id === id).map((m) => m.data).join("");
    const until = async (ok: () => boolean, ms = 5000) => { for (let i = 0; i < ms / 25 && !ok(); i++) await Bun.sleep(25); return ok(); };
    return { ws, got, text, until, send: (m: unknown) => ws.send(JSON.stringify(m)) };
  }
  test("open, type a command, see its output; the shell starts in the session's folder", async () => {
    // Its own session (earlier tests in this file delete the seeded ones), in a folder of its own.
    const { openDb: open, createSession: create } = await import("../src/sessions");
    const { mkdirSync: mk, realpathSync: real } = await import("node:fs");
    const folder = join(dir, "term-folder");
    mk(folder, { recursive: true });
    const db = open(dbPath);
    create(db, { id: "s-term", cwd: folder, model: "m", task: "terminal here" });
    db.close();
    expect((await fetch(`${base}/api/history/s-term`, { method: "POST" })).status).toBe(200);
    const c = await client();
    c.send({ t: "term.open", id: "tt-1", session: "s-term", cols: 100, rows: 30 });
    expect(await c.until(() => c.got.some((m) => m.t === "term.opened"))).toBe(true);
    expect(real(c.got.find((m) => m.t === "term.opened").cwd)).toBe(real(folder));
    c.send({ t: "term.input", id: "tt-1", data: "echo HUB-$((20+22)); stty size\r" });
    expect(await c.until(() => c.text("tt-1").includes("HUB-42") && c.text("tt-1").includes("30 100"))).toBe(true);
    c.send({ t: "term.close", id: "tt-1" });
    c.ws.close();
  });
  test("a reload reattaches to the same shell and replays it", async () => {
    const a = await client();
    a.send({ t: "term.open", id: "tt-2", cols: 80, rows: 24 });
    a.send({ t: "term.input", id: "tt-2", data: "export X=same-shell; echo BEFORE-RELOAD\r" });
    expect(await a.until(() => a.text("tt-2").includes("BEFORE-RELOAD"))).toBe(true);
    a.ws.close();
    await Bun.sleep(200);
    const b = await client();
    b.send({ t: "term.open", id: "tt-2", cols: 80, rows: 24 });
    expect(await b.until(() => b.got.some((m) => m.t === "term.opened"))).toBe(true);
    expect(b.got.find((m) => m.t === "term.opened").replay).toContain("BEFORE-RELOAD");
    b.send({ t: "term.input", id: "tt-2", data: "echo X=$X\r" });
    expect(await b.until(() => b.text("tt-2").includes("X=same-shell"))).toBe(true);
    b.send({ t: "term.close", id: "tt-2" });
    b.ws.close();
  });
  test("a terminal's output never reaches a client that does not watch it", async () => {
    const a = await client(), b = await client();
    a.send({ t: "term.open", id: "tt-3", cols: 80, rows: 24 });
    a.send({ t: "term.input", id: "tt-3", data: "echo PRIVATE-TO-A\r" });
    expect(await a.until(() => a.text("tt-3").includes("PRIVATE-TO-A"))).toBe(true);
    await Bun.sleep(150);
    expect(b.got.some((m) => m.t?.startsWith("term."))).toBe(false);
    a.send({ t: "term.close", id: "tt-3" });
    a.ws.close();
    b.ws.close();
  });
  test("bad terminal messages are answered with a reason", async () => {
    const c = await client();
    c.send({ t: "term.open", id: "../../x", cols: 80, rows: 24 });
    expect(await c.until(() => c.got.some((m) => m.t === "error" && /invalid terminal id/.test(m.error)))).toBe(true);
    c.ws.close();
  });
});
