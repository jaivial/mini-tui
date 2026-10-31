import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QueueClient,
  applyQueueFrame,
  cleanQueueEvents,
  defaultServerUrl,
  probeServer,
  queueBadge,
  type QueueState,
  type QueueTaskView,
} from "../src/queueClient";
import { completeFolder, completePath } from "../src/ui/pathComplete";
import type { RunEvent } from "../src/traj/schema";

function task(id: string, status: QueueTaskView["status"], extra: Partial<QueueTaskView> = {}): QueueTaskView {
  return { id, seq: Number(id.slice(1)), title: `title ${id}`, description: "", workspace: "ws", cwd: "/tmp", status, sessionId: "", result: "", createdAt: 1, startedAt: 0, finishedAt: 0, updatedAt: 1, ...extra };
}

interface Fake {
  url: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  uploads: Array<{ name: string; bytes: number; type: string }>;
  streams: Array<ReadableStreamDefaultController<Uint8Array>>;
  sockets: Array<{ send: (data: string) => void; received: string[] }>;
  stop: () => void;
}

/** A stand-in for the web server: just the routes the client calls. */
function fakeServer(opts: { stream?: "ok" | "fail"; healthy?: boolean } = {}): Fake {
  const fake: Fake = { url: "", requests: [], uploads: [], streams: [], sockets: [], stop: () => {} };
  const enc = new TextEncoder();
  let state = { tasks: [task("t1", "running", { sessionId: "s-w1" })], main: "s-main", concurrency: 5 };
  const server = Bun.serve<{ id: string; received: string[] }>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/api/attachments" && request.method === "POST") {
        const form = await request.formData().catch(() => null);
        const file = form?.get("file");
        if (!file || typeof file === "string") return Response.json({ error: "expected multipart/form-data with a `file` field" }, { status: 400 });
        if (file.name.endsWith(".exe")) return Response.json({ error: "tipo de archivo no aceptado (.exe)" }, { status: 400 });
        fake.uploads.push({ name: file.name, bytes: file.size, type: request.headers.get("content-type") ?? "" });
        const id = String(fake.uploads.length).padStart(16, "0");
        return Response.json({ id, name: file.name, mime: "text/markdown", size: file.size, path: `/store/${id}.md`, url: `/api/attachments/${id}` }, { status: 201 });
      }
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      fake.requests.push({ method: request.method, path: url.pathname, body });
      if (url.pathname === "/api/health") return opts.healthy === false ? new Response("no", { status: 500 }) : Response.json({ ok: true });
      if (url.pathname === "/api/queue") return Response.json(state);
      if (url.pathname === "/api/queue/prompt") {
        state = { ...state, main: "s-new" };
        return Response.json({ id: "s-new", status: "running", events: [] });
      }
      if (url.pathname === "/api/queue/new") return Response.json({ ok: true });
      if (url.pathname === "/api/hosts") return Response.json([{ id: "h1", label: "build box", host: "10.0.0.9", user: "ci", workdir: "~", online: true }]);
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        const b = body as { hostId?: string; target?: string };
        if (b?.target === "remote" && b.hostId !== "h1") return Response.json({ error: "unknown remote host" }, { status: 400 });
        return Response.json({ id: "s-remote", status: "running", target: b?.target, hostId: b?.hostId, events: [] }, { status: 201 });
      }
      if (/^\/api\/sessions\/[^/]+\/(prompt|model)$/.test(url.pathname)) return Response.json({ ok: true });
      const m = url.pathname.match(/^\/api\/queue\/tasks\/([\w-]+)\/(cancel|redirect)$/);
      if (m) return m[1] === "t404" ? Response.json({ ok: false, text: "no such task" }, { status: 409 }) : Response.json({ ok: true, text: `${m[2]} ${m[1]}` });
      if (url.pathname.endsWith("/interrupt") || url.pathname.endsWith("/compact")) return Response.json({ ok: true });
      if (url.pathname === "/api/stream") {
        if (opts.stream === "fail") return new Response("down", { status: 503 });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            fake.streams.push(controller);
            controller.enqueue(enc.encode(`data: {"type":"hello"}\n\n`));
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "queue", ...state })}\n\n`));
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      const socket = url.pathname.match(/^\/api\/sessions\/([^/]+)\/socket$/);
      if (socket) {
        if (srv.upgrade(request, { data: { id: decodeURIComponent(socket[1]!), received: [] } })) return undefined as unknown as Response;
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.id === "s-unknown") return ws.close(4404, "unknown session");
        const entry = { send: (data: string) => void ws.send(data), received: ws.data.received };
        fake.sockets.push(entry);
        ws.send(JSON.stringify({ t: "snapshot", id: ws.data.id, session: { id: ws.data.id, status: "idle", model: "m", events: [{ type: "task", text: "hi\n\n<queue_state>secret</queue_state>" }] } }));
      },
      message(ws, raw) {
        ws.data.received.push(String(raw));
      },
    },
  });
  fake.url = `http://127.0.0.1:${server.port}`;
  fake.stop = () => server.stop(true);
  return fake;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition not met in time");
}

describe("queue state helpers", () => {
  test("a delta frame replaces the tasks it names; a full frame replaces all", () => {
    let state: QueueState = { tasks: [], main: "", concurrency: 0 };
    state = applyQueueFrame(state, { tasks: [task("t1", "queued"), task("t2", "queued")], main: "s-1", concurrency: 3 });
    expect(state.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    state = applyQueueFrame(state, { delta: true, tasks: [task("t2", "running"), task("t3", "queued")], main: "s-1", concurrency: 3 });
    expect(state.tasks.map((t) => `${t.id}:${t.status}`)).toEqual(["t1:queued", "t2:running", "t3:queued"]);
    state = applyQueueFrame(state, { tasks: [task("t9", "done")], main: "" });
    expect(state.tasks.map((t) => t.id)).toEqual(["t9"]);
    expect(state.main).toBe("");
    expect(state.concurrency).toBe(3);
  });

  test("the badge counts what is in flight", () => {
    expect(queueBadge([task("t1", "running"), task("t2", "running"), task("t3", "queued"), task("t4", "done")])).toBe("2 running · 1 queued");
    expect(queueBadge([task("t4", "done")])).toBe("");
  });

  test("queue plumbing is hidden from the transcript", () => {
    const events: RunEvent[] = [
      { type: "task", text: "fix the build\n\n<queue_state>\nactive: t1\n</queue_state>" },
      { type: "task", text: '[queue] Task t1 "x" in workspace "w" finished with status done.' },
      { type: "assistant", text: "t1 is done" },
      { type: "notice", text: "🖥 t2 · login needs you in the browser [[browser:abcd1234]]" },
    ];
    const shown = cleanQueueEvents(events);
    expect(shown).toHaveLength(3);
    expect(shown[0]).toEqual({ type: "task", text: "fix the build" });
    expect(shown[1]).toEqual({ type: "assistant", text: "t1 is done" });
    expect(shown[2]!.type === "notice" && shown[2]!.text).not.toContain("[[browser");
  });

  test("the server address comes from the environment", () => {
    expect(defaultServerUrl({})).toBe("http://127.0.0.1:4317");
    expect(defaultServerUrl({ MINITUI_WEB_PORT: "7911" })).toBe("http://127.0.0.1:7911");
    expect(defaultServerUrl({ MINITUI_WEB_URL: "http://10.0.0.2:9000/" })).toBe("http://10.0.0.2:9000");
  });
});

describe("QueueClient against a fake server", () => {
  test("discovery: a reachable server is used and nothing is started", async () => {
    const fake = fakeServer();
    cleanups.push(fake.stop);
    let starts = 0;
    const client = new QueueClient({ url: fake.url, autoStart: true, startServer: async () => (starts++, { url: "http://127.0.0.1:1", stop: () => {} }) });
    cleanups.push(() => client.stop());
    expect(await probeServer(fake.url)).toBe(true);
    const result = await client.connect();
    expect(result).toEqual({ url: fake.url, started: false });
    expect(starts).toBe(0);
  });

  test("discovery: nothing answers → a server is started (and stopped with the client)", async () => {
    const fake = fakeServer();
    cleanups.push(fake.stop);
    let stopped = 0;
    const dead = `http://127.0.0.1:${fakePortNobodyUses()}`;
    const client = new QueueClient({ url: dead, autoStart: true, startServer: async () => ({ url: fake.url, logPath: "/tmp/x.log", stop: () => void stopped++ }) });
    const result = await client.connect();
    expect(result).toEqual({ url: fake.url, started: true, logPath: "/tmp/x.log" });
    expect(client.url).toBe(fake.url);
    client.stop();
    expect(stopped).toBe(1);
  });

  test("an explicit address that does not answer is an error, not a new server", async () => {
    const client = new QueueClient({ url: `http://127.0.0.1:${fakePortNobodyUses()}` });
    await expect(client.connect()).rejects.toThrow(/no mini-tui web server/);
  });

  test("prompt, new chat, redirect, cancel, interrupt and compact hit the queue API", async () => {
    const fake = fakeServer();
    cleanups.push(fake.stop);
    const client = new QueueClient({ url: fake.url });
    cleanups.push(() => client.stop());
    await client.connect();
    const seen: string[] = [];
    client.subscribe({ onQueue: (state) => seen.push(state.main) });
    expect(await client.prompt("CREATE 1", "openai/gpt-mock")).toEqual({ id: "s-new" });
    expect(fake.requests.find((r) => r.path === "/api/queue/prompt")?.body).toEqual({ prompt: "CREATE 1", model: "openai/gpt-mock" });
    expect(client.state().main).toBe("s-new");
    expect(await client.redirect("t1", "also add tests")).toEqual({ ok: true, text: "redirect t1" });
    expect(fake.requests.find((r) => r.path === "/api/queue/tasks/t1/redirect")?.body).toEqual({ message: "also add tests" });
    expect(await client.cancel("t1")).toEqual({ ok: true, text: "cancel t1" });
    expect(await client.cancel("t404")).toEqual({ ok: false, text: "no such task" });
    await client.interrupt("s-main");
    await client.compact("s-main");
    expect(fake.requests.some((r) => r.path === "/api/sessions/s-main/interrupt")).toBe(true);
    expect(fake.requests.some((r) => r.path === "/api/sessions/s-main/compact")).toBe(true);
    await client.newChat();
    expect(client.state().main).toBe("");
    expect(seen).toContain("s-new");
  });

  test("SSE: the first frame is the full list, deltas merge by id", async () => {
    const fake = fakeServer();
    cleanups.push(fake.stop);
    const client = new QueueClient({ url: fake.url });
    cleanups.push(() => client.stop());
    const states: QueueState[] = [];
    const links: boolean[] = [];
    let settings = 0;
    client.subscribe({ onQueue: (s) => states.push(s), onLink: (up) => links.push(up), onSettings: () => settings++ });
    await until(() => states.length >= 1);
    expect(states.at(-1)!.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(states.at(-1)!.main).toBe("s-main");
    expect(links).toEqual([true]);
    const enc = new TextEncoder();
    // a frame split across two chunks still parses
    const frame = `data: ${JSON.stringify({ type: "queue", delta: true, tasks: [task("t1", "done"), task("t2", "queued")], main: "s-main", concurrency: 5 })}\n\n`;
    fake.streams[0]!.enqueue(enc.encode(frame.slice(0, 20)));
    fake.streams[0]!.enqueue(enc.encode(frame.slice(20)));
    fake.streams[0]!.enqueue(enc.encode(`: ping\n\ndata: {"type":"settings"}\n\n`));
    await until(() => states.length >= 2 && settings === 1);
    expect(states.at(-1)!.tasks.map((t) => `${t.id}:${t.status}`)).toEqual(["t1:done", "t2:queued"]);
  });

  test("SSE down: the client polls GET /api/queue instead", async () => {
    const fake = fakeServer({ stream: "fail" });
    cleanups.push(fake.stop);
    const client = new QueueClient({ url: fake.url, pollMs: 50 });
    cleanups.push(() => client.stop());
    const states: QueueState[] = [];
    const links: boolean[] = [];
    client.subscribe({ onQueue: (s) => states.push(s), onLink: (up) => links.push(up) });
    await until(() => states.length >= 2);
    expect(links[0]).toBe(false);
    expect(states.at(-1)!.tasks[0]!.id).toBe("t1");
    expect(fake.requests.filter((r) => r.path === "/api/queue").length).toBeGreaterThanOrEqual(2);
  });

  test("follow: a snapshot, then deltas; a hole asks for a resync; an unknown session ends it", async () => {
    const fake = fakeServer();
    cleanups.push(fake.stop);
    const client = new QueueClient({ url: fake.url });
    cleanups.push(() => client.stop());
    const snapshots: RunEvent[][] = [];
    const deltas: RunEvent[][] = [];
    const stop = client.follow("s-main", { onSnapshot: (s) => snapshots.push(s.events), onDelta: (events) => deltas.push(events) });
    cleanups.push(stop);
    await until(() => snapshots.length === 1 && fake.sockets.length === 1);
    expect(snapshots[0]![0]!.type).toBe("task");
    const socket = fake.sockets[0]!;
    socket.send(JSON.stringify({ t: "delta", id: "s-main", from: 1, events: [{ type: "assistant", text: "ok" }], meta: { id: "s-main", status: "done" } }));
    await until(() => deltas.length === 1);
    expect(deltas[0]).toEqual([{ type: "assistant", text: "ok" }]);
    socket.send(JSON.stringify({ t: "delta", id: "s-main", from: 7, events: [{ type: "assistant", text: "lost" }], meta: { id: "s-main" } }));
    await until(() => socket.received.length === 1);
    expect(JSON.parse(socket.received[0]!)).toEqual({ t: "resync" });
    expect(deltas).toHaveLength(1);

    let gone = "";
    client.follow("s-unknown", { onSnapshot: () => {}, onDelta: () => {}, onGone: (why) => (gone = why) });
    await until(() => gone !== "");
    expect(gone).toContain("does not know");
  });
});

describe("server sessions and attachments", () => {
  test("upload is multipart with one `file` field; its ref rides with a queue prompt", async () => {
    const fake = fakeServer();
    cleanups.push(fake.stop);
    const client = new QueueClient({ url: fake.url });
    cleanups.push(() => client.stop());
    await client.connect();
    const ref = await client.upload({ name: "notes.md", bytes: new TextEncoder().encode("# hi\n") });
    expect(ref).toEqual({ id: "0000000000000001", name: "notes.md", mime: "text/markdown", size: 5, url: "/api/attachments/0000000000000001" });
    expect(fake.uploads).toEqual([{ name: "notes.md", bytes: 5, type: expect.stringContaining("multipart/form-data") }]);
    await client.prompt("read the notes", undefined, [ref]);
    expect(fake.requests.find((r) => r.path === "/api/queue/prompt")?.body).toEqual({ prompt: "read the notes", attachments: [ref] });
    // the server's verdict comes back as the error, with the file's name
    await expect(client.upload({ name: "tool.exe", bytes: new Uint8Array([1]) })).rejects.toThrow("tool.exe: tipo de archivo no aceptado (.exe)");
  });

  test("a remote session is created with its host, followed, continued, and its model switched", async () => {
    const fake = fakeServer();
    cleanups.push(fake.stop);
    const client = new QueueClient({ url: fake.url });
    cleanups.push(() => client.stop());
    await client.connect();
    expect(await client.hosts()).toEqual([{ id: "h1", label: "build box", host: "10.0.0.9", user: "ci", workdir: "~", online: true }]);
    const ref = await client.upload({ name: "spec.md", bytes: new TextEncoder().encode("spec") });
    const session = await client.createSession({ prompt: "deploy", cwd: "~/app", model: "openai/gpt-mock", target: "remote", hostId: "h1", attachments: [ref] });
    expect(session.id).toBe("s-remote");
    expect(fake.requests.find((r) => r.path === "/api/sessions")?.body).toEqual({ prompt: "deploy", cwd: "~/app", model: "openai/gpt-mock", target: "remote", hostId: "h1", attachments: [ref] });
    const snapshots: string[] = [];
    cleanups.push(client.follow(session.id, { onSnapshot: (s) => snapshots.push(s.id), onDelta: () => {} }));
    await until(() => snapshots.length === 1);
    expect(snapshots).toEqual(["s-remote"]);
    await client.send(session.id, "and the docs");
    expect(fake.requests.find((r) => r.path === "/api/sessions/s-remote/prompt")?.body).toEqual({ prompt: "and the docs" });
    await client.setModel(session.id, "openai/gpt-other");
    expect(fake.requests.find((r) => r.path === "/api/sessions/s-remote/model")?.body).toEqual({ model: "openai/gpt-other" });
    await expect(client.createSession({ prompt: "x", target: "remote", hostId: "nope" })).rejects.toThrow("unknown remote host");
  });

  test("hosts() is empty when no server answers (labels fall back to ids)", async () => {
    const client = new QueueClient({ url: `http://127.0.0.1:${fakePortNobodyUses()}` });
    expect(await client.hosts()).toEqual([]);
  });
});

describe("folder completion", () => {
  test("Tab completes a unique folder and lists several", () => {
    const home = mkdtempSync(join(tmpdir(), "minitui-complete-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, "projects", "alpha"), { recursive: true });
    mkdirSync(join(home, "projects", "beta"), { recursive: true });
    mkdirSync(join(home, "photos"));
    expect(completeFolder("~/pro", home)).toEqual({ text: "~/projects/", matches: [] });
    expect(completeFolder("~/p", home)).toEqual({ text: "~/p", matches: ["photos", "projects"] });
    expect(completeFolder("~/projects/", home).matches).toEqual(["alpha", "beta"]);
    expect(completeFolder(`${home}/projects/al`, home).text).toBe(`${home}/projects/alpha/`);
    expect(completeFolder("~/nothing-here", home)).toEqual({ text: "~/nothing-here", matches: [] });
  });

  test("file completion: relative to a base folder, files included, folders marked", () => {
    const home = mkdtempSync(join(tmpdir(), "minitui-complete-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const work = join(home, "work");
    mkdirSync(join(work, "shots"), { recursive: true });
    writeFileSync(join(work, "shot one.png"), "x");
    writeFileSync(join(work, "notes.md"), "x");
    writeFileSync(join(work, "shots", "a.png"), "x");
    expect(completePath("no", { base: work, files: true, home })).toEqual({ text: "notes.md", matches: [] });
    expect(completePath("sho", { base: work, files: true, home })).toEqual({ text: "shot", matches: ["shot one.png", "shots/"] });
    expect(completePath("shots", { base: work, files: true, home })).toEqual({ text: "shots/", matches: [] });
    expect(completePath("shots/", { base: work, files: true, home })).toEqual({ text: "shots/a.png", matches: [] });
    expect(completePath("", { base: work, files: true, home }).matches).toEqual(["notes.md", "shot one.png", "shots/"]);
    expect(completePath("~/wo", { base: work, files: true, home })).toEqual({ text: "~/work/", matches: [] });
    // folders only (the workspace picker) never offers a file
    expect(completePath("no", { base: work, home })).toEqual({ text: "no", matches: [] });
  });
});

function fakePortNobodyUses(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port!;
  server.stop(true);
  return port;
}
