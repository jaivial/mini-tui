/**
 * The mini-tui web server: a small JSON + SSE API the Svelte app talks to.
 *
 * It reuses the TUI's own pieces (spawnMini, the trajectory parser, the
 * sessions database), so a session started in the browser lands in the same
 * /resume history and is visible to the terminal UI.
 *
 *   bun src/web/serve.ts [--port 4317] [--host 127.0.0.1]
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

import { SessionManager, loadHosts, saveHosts, probeHost, type RemoteHostRecord } from "./sessions";
import { SessionFeed, sameOrigin, summarize, toWire } from "./feed";
import { NOTE_MAX, getNote, listTasks, saveNote } from "../sessions";
import { FolderError, listLocal, listRemote } from "./folders";
import { Hub, type HubClient } from "./hub";
import { Terminals } from "./terminals";
import { agentsView } from "./agents";
import { listAgentDefs } from "../mini/agentDefs";
import { WORKSPACE_MAX, WorkspaceStore } from "./workspace";
import { homedir } from "node:os";
import { rustAgentBin } from "../mini/spawn";
import { ChannelInbox } from "../channels/inbox";
import { evoReceiver } from "../channels/evoReceiver";
import { sshArgs } from "./ssh";
import { log } from "./log";
import { syncAllSkills } from "../skills";
import {
  COMMANDS,
  connectProvider,
  connectedProviders,
  disconnectProvider,
  modelCatalog,
  patchSettings,
  providerCatalog,
  settingsView,
  skillList,
} from "./config";
import type { RemoteHost } from "../../web/src/lib/types";
import {
  COOKIE_TTL,
  RENEW_THRESHOLD,
  clearCookieHeader,
  cookieHeader,
  initAuth,
  isSecure,
  loginPage,
  nonce,
  verifyHtpasswd,
  type Auth,
} from "./auth";

// Shared modules (spawn, sessions) log only when this says they serve the web app
// (src/web/log.ts): the terminal UI must not get their stderr noise.
process.env.MINITUI_WEB ??= "1";

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
}
const PORT = Number(flag("port", process.env.MINITUI_WEB_PORT ?? "4317"));
const HOST = flag("host", process.env.MINITUI_WEB_HOST ?? "127.0.0.1");

// Channel receivers (src/channels) are inbound webhooks from external
// providers. The Evo receiver exists only when the operator configured it in
// the service environment, never in the repo: EVO_RECEIVER_ACCOUNT (the bound
// account; the webhook body cannot select one) and a 32+ byte
// EVO_WEBHOOK_SECRET. Without both, the route below answers 404 like any
// unknown path. The inbox database defaults to the shared channel store;
// EVO_INBOX_DB overrides it for an isolated deployment. The secret is never
// logged here; evoReceiver answers counts only.
let evoHandler: ((request: Request) => Promise<Response>) | null | undefined;
function evoRoute(): ((request: Request) => Promise<Response>) | null {
  if (evoHandler !== undefined) return evoHandler;
  const account = process.env.EVO_RECEIVER_ACCOUNT ?? "";
  const webhookSecret = process.env.EVO_WEBHOOK_SECRET ?? "";
  if (!account || !webhookSecret) return (evoHandler = null);
  try {
    const inbox = new ChannelInbox(process.env.EVO_INBOX_DB ?? join(homedir(), ".local/share/mini-tui/channels.sqlite"));
    evoHandler = evoReceiver(inbox, { account, webhookSecret });
  } catch (error) {
    log(`evo receiver disabled: ${error instanceof Error ? error.message : "invalid configuration"}`);
    evoHandler = null;
  }
  return evoHandler;
}

type Listener = (event: { type: string; [key: string]: unknown }) => void;

// ---- sign-in (cookie session auth, src/web/auth.ts) ---------------------------------------------------------------

/**
 * The gate. MINITUI_WEB_NO_AUTH=1 turns it off (local development behind nothing); a missing
 * htpasswd file does the same rather than locking every legitimate visitor out. The Evo
 * webhook and /health keep their own contracts (shared secret, monitoring) and stay outside.
 */
const auth: Auth | null = process.env.MINITUI_WEB_NO_AUTH === "1" ? null : initAuth();

const html = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
const redirect = (location: string, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });

/** Sign a visitor in: a fresh nonce, a 30-day cookie, and the nonce on file so logout can find it. */
function signIn(request: Request, secret: Buffer): string {
  const id = nonce();
  auth?.sessions.add(id, Math.floor(Date.now() / 1000) + COOKIE_TTL);
  return cookieHeader(secret, id, COOKIE_TTL, isSecure(request));
}

/**
 * The gate's answer for one request: a Response to send back (login page, redirect, 401), or
 * null to let the request through. `claims` rides out for the sliding renewal on the shell.
 */
async function gate(request: Request, url: URL, pathname: string): Promise<{ claims: ReturnType<Auth["claimsOf"]> } | Response> {
  if (!auth || auth.disabled) return { claims: null };
  // The inbound webhook carries its own secret; health is for monitoring. The browser fetches
  // the manifest, the service worker script and the favicon WITHOUT credentials (the manifest
  // request carries no cookies), so a signed-in gate would keep the app un-installable — they
  // are public static files and carry no data.
  if (pathname === "/channels/evo" || pathname === "/health") return { claims: null };
  if (url.pathname === "/manifest.webmanifest" || url.pathname === "/sw.js" || url.pathname === "/favicon.ico" || url.pathname.startsWith("/icons/")) return { claims: null };

  const claims = auth.claimsOf(request);
  if (url.pathname === "/login") {
    if (request.method === "GET") return claims ? redirect("/") : html(loginPage());
    return json({ error: "method not allowed" }, 405);
  }
  if (url.pathname === "/api/login") {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const fail = (message: string) =>
      /form/.test(request.headers.get("content-type") ?? "")
        ? html(loginPage(message === "bad credentials" ? "Wrong user or password." : message), 401)
        : json({ error: message }, 401);
    let user = "";
    let password = "";
    try {
      const type = request.headers.get("content-type") ?? "";
      if (type.includes("json")) {
        const body = (await request.json()) as { user?: unknown; password?: unknown };
        user = typeof body.user === "string" ? body.user : "";
        password = typeof body.password === "string" ? body.password : "";
      } else {
        const form = await request.formData();
        user = String(form.get("user") ?? "");
        password = String(form.get("password") ?? "");
      }
    } catch {
      return fail("bad request");
    }
    if (!user || !password) return fail("bad request");
    if (!verifyHtpasswd(auth.htpasswd, user, password)) return fail("bad credentials");
    return redirect("/", { "set-cookie": signIn(request, auth.secret) });
  }
  if (url.pathname === "/api/logout") {
    if (claims) auth.sessions.revoke(claims.nonce); // the signed cookie stops working, not just the browser's copy
    return redirect("/login", { "set-cookie": clearCookieHeader() });
  }
  if (claims) return { claims };
  // Not signed in: a navigation sees the login page, the app's fetches see a plain 401.
  if (request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html")) return redirect("/login");
  return json({ error: "sign in at /login" }, 401);
}

/** A fresh cookie when the session is past its half-life: every app load slides the 30 days forward. */
function renewedCookie(request: Request, claims: ReturnType<Auth["claimsOf"]>): Record<string, string> {
  if (!auth || !claims || claims.exp - Date.now() / 1000 >= RENEW_THRESHOLD) return {};
  return { "set-cookie": cookieHeader(auth.secret, claims.nonce, COOKIE_TTL, isSecure(request)) };
}

/** Providers with a connection test in flight (a test is a real model call: one at a time). */
const connecting = new Set<string>();

/** A per-session transcript socket, or the one hub socket of a tab. */
type SocketData =
  | { kind: "session"; id: string; sub?: { unsubscribe: () => void; resync: () => void; ping: () => void } }
  | { kind: "hub"; client?: HubClient };
const listeners = new Set<Listener>();

// Queue event readers do not launch workers, migrate schemas or call models.
let queueEventStreams = 0;
async function queueEvents(after: number, limit = 100): Promise<{ events: Array<{ seq: number; [key: string]: unknown }>; cursor: number }> {
  const bin = rustAgentBin();
  const db = process.env.MINITUI_TASK_GRAPH_DB ?? join(homedir(), ".local/share/mini-tui/task-graph.sqlite");
  if (!existsSync(db)) return { events: [], cursor: after };
  if (!bin) throw new Error("task_graph_binary_unavailable");
  const child = Bun.spawn([bin, "queue", "events-read", "--db", db, "--after", String(after), "--limit", String(limit)], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error("task_events_read_failed");
    const data = JSON.parse(out);
    if (!Array.isArray(data.events) || !Number.isSafeInteger(data.cursor) || data.cursor < after || data.events.length > limit
      || data.events.some((e: { seq?: unknown }) => typeof e?.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq <= after)) throw new Error("invalid_queue_events");
    return data;
  } finally { clearTimeout(timer); }
}

function broadcast(event: { type: string; [key: string]: unknown }): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      listeners.delete(listener);
    }
  }
}

// One feed per open session: each browser socket subscribes to exactly one, so a busy
// session never spends another session's bandwidth. The shared SSE stream below only
// carries the light metadata (title, status, cost) the sidebar needs.
const feed = new SessionFeed();
// The right sidebar's socket hub (one socket per tab). Notes are read and written only through it.
let hub: Hub;
const sessions = new SessionManager((session) => {
  broadcast({ type: "session", session: summarize(session) });
  feed.publish(session);
});

// Terminals start where the session works: its folder on this machine, or an ssh shell on its host.
const terminals = new Terminals();
hub = new Hub({ get: (id) => getNote(sessions.db(), id), save: (id, body, base) => saveNote(sessions.db(), id, body, base) }, NOTE_MAX, {
  manager: terminals,
  spec: (sessionId) => {
    const s = sessionId ? sessions.get(sessionId) : undefined;
    if (s?.target === "remote") {
      const host = loadHosts().find((h) => h.id === s.hostId);
      if (!host) throw new Error("this session's remote host is no longer configured");
      return { remote: { args: sshArgs({ host: host.host, port: host.port, user: host.user, identity: host.identity, workdir: "" }), workdir: s.cwd || host.workdir, label: host.label } };
    }
    return { cwd: s?.cwd };
  },
});
// The shared workspace (windows, panes, sidebar): one file, so every device shows the same layout.
const workspace = new WorkspaceStore(join(process.env.MINITUI_CONFIG_DIR ?? join(homedir(), ".config", "mini-tui"), "web-workspace.json"));
hub.workspace = { get: () => workspace.get(), save: (doc, base) => workspace.save(doc, base), max: WORKSPACE_MAX };
// The task board (one card per session, filled by the agents): watched over the same hub, pushed
// as it changes. Cards are written straight to the database (`mini-tui tasks set` runs in agent
// processes this server does not own), so a light poll — only while someone is watching — is what
// notices those writes and turns them into pushes.
hub.tasks = { list: () => listTasks(sessions.db()) };
// The DAG of every session running a plan (the hub writes subagents/plan.json; the board draws it).
hub.plans = { plans: () => sessions.plans() };
// `MINITUI_WEB_SYNC_MS` <= 0 means "no background sync" (the session sync's rule), never a spin.
const tasksSyncMs = Number(process.env.MINITUI_WEB_SYNC_MS ?? 1000);
if (tasksSyncMs > 0) {
  const tasksTimer = setInterval(() => {
    if (hub.taskWatchers) hub.tasksChanged();
    if (hub.planWatchers) hub.plansChanged();
  }, tasksSyncMs);
  (tasksTimer as { unref?: () => void }).unref?.();
}
// No shell outlives the server (a restart, a deploy, Ctrl+C in a dev shell).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.once(sig, () => {
    sessions.persistAll();
    terminals.killAll();
    process.exit(0);
  });

/** Put a session away everywhere (its socket subscribers and the shared stream). It stays in the history. */
/**
 * The session with this id, restoring it from the saved history when the server no longer holds it.
 * Sessions live in memory, so a restart (a deploy) forgets every open one; a browser that still shows
 * them must get them back on its next socket or fetch, not a 404 that turns its panes into new chats.
 * Undefined only when the id is nowhere, not even in the database.
 */
async function held(id: string) {
  const live = sessions.get(id);
  if (live) return live;
  try {
    const restored = await sessions.openHistory(id);
    broadcast({ type: "session", session: summarize(restored) });
    return restored;
  } catch (error) {
    // Only an id that is nowhere is "unknown". Anything else (the database busy with a terminal's
    // save, an unreadable row) is a failure to report: answering 404 made the browser conclude the
    // session was deleted and turn its pane into a new chat.
    if (/unknown session/.test((error as Error).message)) return undefined;
    throw error;
  }
}

/** 404 for an id that is nowhere, 503 (retry) for anything else that stopped us reading it. */
async function heldOrError(id: string): Promise<{ session: Awaited<ReturnType<typeof held>>; error?: Response }> {
  try {
    const session = await held(id);
    return session ? { session } : { session, error: json({ error: "unknown session" }, 404) };
  } catch (error) {
    return { session: undefined, error: json({ error: `could not open the session: ${(error as Error).message}` }, 503) };
  }
}

function dropSession(id: string): void {
  sessions.close(id);
  feed.gone(id);
  broadcast({ type: "session-gone", id });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hostToApi(host: RemoteHostRecord): RemoteHost {
  return {
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    user: host.user,
    workdir: host.workdir,
    identity: host.identity,
    lastSeen: host.lastSeen,
    lastError: host.lastError,
    online: host.online,
  };
}

/** CORS, so `vite dev` (4318) can reach this server directly if proxied. */
/** Built Svelte app, served from the same process when present. */
const STATIC_DIR = resolve(import.meta.dir, "..", "..", "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};

// Bundled skills (e.g. $e2e) and new ~/.claude skills, as the terminal UI does at startup.
try {
  syncAllSkills();
} catch {
  // a broken skills folder must never block the server
}


// Gzip hashed assets once and keep the result: the files are immutable, so this costs one pass per file.
const gzipMemo = new Map<string, Promise<Uint8Array>>();
function gzipCached(file: string, body: ReturnType<typeof Bun.file>): Promise<Uint8Array> {
  let hit = gzipMemo.get(file);
  if (!hit) {
    hit = body.arrayBuffer().then((buf) => Bun.gzipSync(new Uint8Array(buf)));
    gzipMemo.set(file, hit);
  }
  return hit;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  websocket: {
    // The ceiling only stops a client from pinning memory. The largest legal frame is a note save:
    // NOTE_MAX characters, up to 4 UTF-8 bytes each once JSON-escaped (an emoji is 4; a quote or a
    // newline escapes to 2), plus the envelope. Anything bigger is not a message this app sends, and
    // Bun closes the socket on it. (It was 64 KB, which dropped the hub on any note past ~16 000 emoji.)
    maxPayloadLength: NOTE_MAX * 6 + 4096,
    idleTimeout: 120,
    sendPings: true,
    async open(ws: import("bun").ServerWebSocket<SocketData>) {
      if (ws.data.kind === "hub") {
        const client: HubClient = { send: (msg) => ws.send(JSON.stringify(msg)) !== 0 };
        ws.data.client = client;
        hub.join(client);
        return;
      }
      let session;
      try {
        session = await held(ws.data.id);
      } catch {
        ws.close(1013, "try again"); // transient: the client reconnects
        return;
      }
      if (!session) {
        ws.close(4404, "unknown session");
        return;
      }
      // `send` returns 0 when the message was dropped and -1 under backpressure (queued,
      // not lost); only a drop means the client missed a frame.
      const sub = feed.subscribe(session, (frame) => ws.send(JSON.stringify(frame)) !== 0);
      ws.data.sub = sub;
    },
    message(ws: import("bun").ServerWebSocket<SocketData>, raw) {
      if (typeof raw !== "string") return;
      if (ws.data.kind === "hub") {
        if (ws.data.client) hub.handle(ws.data.client, raw);
        return;
      }
      let msg: { t?: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.t === "resync") ws.data.sub?.resync();
      else if (msg.t === "ping") ws.data.sub?.ping();
    },
    close(ws: import("bun").ServerWebSocket<SocketData>) {
      if (ws.data.kind === "hub") {
        if (ws.data.client) hub.leave(ws.data.client);
        return;
      }
      ws.data.sub?.unsubscribe();
    },
  },
  async fetch(request, srv) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    // A page on another site must not be able to drive this server (start agents, write
    // provider keys) just because it is reachable: state-changing requests have to come from
    // this app's own origin. Non-browser clients send no Origin and are unaffected.
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request.headers)) {
      return json({ error: "cross-origin request refused" }, 403);
    }
    // Sign-in: everything below needs a live session cookie (or no gate at all).
    const gated = await gate(request, url, path);
    if (gated instanceof Response) return gated;
    const claims = gated.claims;

    try {
      // Inbound provider webhook. Account and secret come from the service
      // environment; an unconfigured host answers 404, a configured one
      // delegates every check (method, secret, size, JSON) to evoReceiver.
      if (path === "/channels/evo") {
        const handler = evoRoute();
        if (!handler) return json({ error: "not found" }, 404);
        return handler(request);
      }
      // Read-only projection of the local task registry. No worker launch, model
      // call, schema creation or browser-selected filesystem path.
      if (path === "/task-graph" && request.method === "GET") {
        if (!sameOrigin(request.headers)) return json({ error: "cross-origin request refused" }, 403);
        const bin = rustAgentBin();
        const db = process.env.MINITUI_TASK_GRAPH_DB ?? join(homedir(), ".local/share/mini-tui/task-graph.sqlite");
        if (!bin) return json({ error: "task_graph_binary_unavailable" }, 503);
        if (!existsSync(db)) return json({ nodes: [], edges: [], configured: false });
        const child = Bun.spawn([bin, "queue", "graph-read", "--db", db], { stdout: "pipe", stderr: "pipe" });
        const timeout = setTimeout(() => child.kill(), 5000);
        try {
          const [out, _err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          if (code !== 0) return json({ error: "task_graph_read_failed", detail: "Queue feature unavailable or registry could not be read" }, 503);
          return json(JSON.parse(out));
        } finally { clearTimeout(timeout); }
      }
      if ((path === "/task-events" || path === "/task-events/stream") && request.method === "GET") {
        if (!sameOrigin(request.headers)) return json({ error: "cross-origin request refused" }, 403);
        const raw = url.searchParams.get("after") ?? request.headers.get("last-event-id") ?? "0";
        if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) return json({ error: "invalid_event_cursor" }, 400);
        let cursor = Number(raw);
        if (path === "/task-events") {
          try { return json(await queueEvents(cursor)); }
          catch { return json({ error: "task_events_unavailable" }, 503); }
        }
        if (queueEventStreams >= 16) return json({ error: "too_many_queue_streams" }, 429);
        queueEventStreams++;
        const encoder = new TextEncoder();
        let closed = false;
        let busy = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          request.signal.removeEventListener("abort", close);
          queueEventStreams--;
        };
        const stream = new ReadableStream({
          start(controller) {
            const tick = async () => {
              if (closed || busy) return;
              busy = true;
              try {
                const data = await queueEvents(cursor);
                if (closed) return;
                for (const event of data.events) {
                  if (event.seq <= cursor) continue;
                  controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: task\ndata: ${JSON.stringify(event)}\n\n`));
                  cursor = event.seq;
                }
                if (!data.events.length) controller.enqueue(encoder.encode(": ping\n\n"));
              } catch {
                if (!closed) {
                  try { controller.enqueue(encoder.encode('event: queue-error\ndata: {"error":"task_events_unavailable"}\n\n')); } catch {}
                  finally { close(); try { controller.close(); } catch {} }
                }
              } finally { busy = false; }
            };
            timer = setInterval(() => { void tick(); }, 5000);
            request.signal.addEventListener("abort", close, { once: true });
            if (request.signal.aborted) { close(); controller.close(); return; }
            void tick();
          },
          cancel() { close(); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", ...CORS } });
      }
      // ---------------------------------------------------------- stream
      if (path === "/stream" && request.method === "GET") {
        const encoder = new TextEncoder();
        let cleanup = () => {};
        const stream = new ReadableStream({
          start(controller) {
            const send = (event: { type: string } & Record<string, unknown>) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {
                cleanup();
              }
            };
            send({ type: "hello" });
            send({ type: "hosts", hosts: loadHosts().map(hostToApi) });
            for (const session of sessions.list()) send({ type: "session", session: summarize(session) });
            const listener: Listener = send;
            listeners.add(listener);
            // Comment frames keep proxies from closing an idle connection.
            const ping = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: ping\n\n`));
              } catch {
                cleanup();
              }
            }, 25_000);
            cleanup = () => {
              clearInterval(ping);
              listeners.delete(listener);
            };
            request.signal.addEventListener("abort", cleanup);
          },
          cancel() {
            cleanup();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            // SSE through nginx: without this, a buffering proxy holds the first
            // agent view back and the panel sits on "Loading agents".
            "x-accel-buffering": "no",
            ...CORS,
          },
        });
      }

      // ------------------------------------------------------------- hub
      // The one socket a tab keeps for the right sidebar (notes): watch, live pushes, saves. See hub.ts.
      if (path === "/hub" && request.method === "GET") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a websocket upgrade" }, 426);
        if (!sameOrigin(request.headers)) return json({ error: "cross-origin websocket refused" }, 403);
        if (srv.upgrade(request, { data: { kind: "hub" } satisfies SocketData })) return undefined as unknown as Response;
        return json({ error: "websocket upgrade failed" }, 400);
      }

      // -------------------------------------------------------- sessions
      // One socket per session: /api/sessions/:id/socket streams that session's transcript.
      const socketMatch = path.match(/^\/sessions\/([^/]+)\/socket$/);
      if (socketMatch && request.method === "GET") {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a websocket upgrade" }, 426);
        if (!sameOrigin(request.headers)) return json({ error: "cross-origin websocket refused" }, 403);
        const id = decodeURIComponent(socketMatch[1] as string);
        const found = await heldOrError(id);
        if (found.error) return found.error;
        if (srv.upgrade(request, { data: { kind: "session", id } satisfies SocketData })) return undefined as unknown as Response;
        return json({ error: "websocket upgrade failed" }, 400);
      }

      if (path === "/sessions" && request.method === "GET") return json(sessions.list().map(summarize));
      if (path === "/sessions" && request.method === "POST") {
        const body = await readJson(request);
        log("api.session.create", { cwd: body.cwd ?? "", model: body.model ?? "", target: body.target ?? "local" });
        let session;
        try {
          session = await sessions.create({
          prompt: String(body.prompt ?? "").trim(),
          cwd: body.cwd ? String(body.cwd) : undefined,
          model: body.model ? String(body.model) : undefined,
          target: body.target === "remote" ? "remote" : "local",
          hostId: body.hostId ? String(body.hostId) : undefined,
          });
        } catch (error) {
          // A bad folder or an unknown host is the request's fault: say which, and keep the prompt client-side.
          return json({ error: (error as Error).message }, 400);
        }
        return json(toWire(session), 201);
      }
      // ---------------------------------------------------------- agents
      // The agent tree of a session (every agent session it started, recursively), their state,
      // measured cache reuse and the messages between them. Polled by the Agents panel.
      const agentsMatch = path.match(/^\/sessions\/([^/]+)\/agents$/);
      if (agentsMatch && request.method === "GET") {
        const id = decodeURIComponent(agentsMatch[1] as string);
        return json(agentsView(id, sessions.trajsOf(id)));
      }
      if (path === "/agents" && request.method === "GET") return json(listAgentDefs());
      // Live agents view: snapshot, then a push whenever the tree or its events change. The
      // state lives on disk (each agent hub writes its own files), so a light poll while someone
      // watches is what notices it.
      const agentsStreamMatch = path.match(/^\/sessions\/([^/]+)\/agents\/stream$/);
      if (agentsStreamMatch && request.method === "GET") {
        const streamId = decodeURIComponent(agentsStreamMatch[1] as string);
        const encoder = new TextEncoder();
        let cleanup = () => {};
        const stream = new ReadableStream({
          start(controller) {
            let last = "";
            const push = () => {
              try {
                const payload = JSON.stringify(agentsView(streamId, sessions.trajsOf(streamId)));
                if (payload === last) return;
                last = payload;
                controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
              } catch {
                cleanup();
              }
            };
            push();
            const poll = setInterval(push, 2000);
            const ping = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: ping\n\n`));
              } catch {
                cleanup();
              }
            }, 25_000);
            cleanup = () => {
              clearInterval(poll);
              clearInterval(ping);
            };
            request.signal.addEventListener("abort", cleanup);
          },
          cancel() {
            cleanup();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            // SSE through nginx: without this, a buffering proxy holds the first
            // agent view back and the panel sits on "Loading agents".
            "x-accel-buffering": "no",
            ...CORS,
          },
        });
      }
      const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/prompt|\/model|\/interrupt|\/compact)?$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1] as string);
        const action = sessionMatch[2];
        if (action === "/prompt" && request.method === "POST") {
          const body = await readJson(request);
          log("api.session.prompt", { id, len: String(body.prompt ?? "").length });
          try {
            await sessions.send(id, String(body.prompt ?? ""));
          } catch (error) {
            // e.g. a saved session with no conversation to continue from: the reason is the answer.
            return json({ error: (error as Error).message }, /unknown session/.test((error as Error).message) ? 404 : 409);
          }
          return json({ ok: true });
        }
        if (action === "/model" && request.method === "POST") {
          const body = await readJson(request);
          const model = String(body.model ?? "").trim();
          if (!model) return json({ error: "a model name is required" }, 400);
          if (!sessions.get(id)) return json({ error: "unknown session" }, 404);
          log("api.session.model", { id, model });
          sessions.setModel(id, model);
          return json({ ok: true });
        }
        if (action === "/compact" && request.method === "POST") {
          if (!sessions.get(id)) return json({ error: "unknown session" }, 404);
          try {
            log("api.session.compact", { id });
            sessions.compact(id);
            return json({ ok: true });
          } catch (error) {
            return json({ error: (error as Error).message }, 409);
          }
        }
        if (action === "/interrupt" && request.method === "POST") {
          log("api.session.interrupt", { id });
          sessions.interrupt(id);
          return json({ ok: true });
        }
        if (!action && request.method === "DELETE") {
          dropSession(id);
          return json({ ok: true });
        }
        if (!action && request.method === "GET") {
          const found = await heldOrError(id);
          return found.error ?? json(toWire(found.session!));
        }
      }

      // --------------------------------------------------------- history
      if (path === "/history" && request.method === "GET") {
        // ?q= searches title, task and folder; ?limit= caps the page. Metadata only: no transcript is read.
        const limit = Number(url.searchParams.get("limit") ?? "");
        const cwd = url.searchParams.get("cwd");
        return json(sessions.history({ query: url.searchParams.get("q") ?? "", limit: Number.isFinite(limit) && limit > 0 ? limit : undefined, cwd: cwd ?? undefined }));
      }
      if (path === "/history/folders" && request.method === "GET") {
        // Every folder with saved sessions and its count, newest first: the sidebar's per-folder view.
        return json(sessions.folders());
      }
      const historyMatch = path.match(/^\/history\/([^/]+)$/);
      if (historyMatch) {
        const id = decodeURIComponent(historyMatch[1] as string);
        if (request.method === "POST") {
          try {
            return json(toWire(await sessions.openHistory(id)));
          } catch (error) {
            return json({ error: (error as Error).message }, /unknown session/.test((error as Error).message) ? 404 : 503);
          }
        }
        if (request.method === "DELETE") {
          // Deleting is permanent and separate from closing: it removes the saved conversation.
          const existed = sessions.deleteHistory(id);
          feed.gone(id);
          // Its note went with it: anyone watching it sees it empty, instead of keeping stale text.
          hub.noteChanged({ id, body: "", updatedAt: 0 });
          // So did its task card (deleteSession drops the row): the board loses that session now.
          hub.tasksChanged();
          broadcast({ type: "session-gone", id });
          return existed ? json({ ok: true }) : json({ error: "unknown session" }, 404);
        }
      }

      // Notes have no REST endpoint: reading, live updates and saves all go through the hub socket.

      // ----------------------------------------------------------- folders
      // `GET /folders?path=` (this machine) or `?hostId=&path=` (a saved remote host, over ssh): the
      // subfolders of a folder, for the "where should this chat run" picker. Names only, never contents.
      if (path === "/folders" && request.method === "GET") {
        const hostId = url.searchParams.get("hostId") ?? "";
        const asked = url.searchParams.get("path") ?? "";
        if (asked.length > 4096 || asked.includes("\0")) return json({ error: "invalid path" }, 400);
        try {
          if (!hostId || hostId === "local") return json(listLocal(asked));
          const host = loadHosts().find((h) => h.id === hostId);
          if (!host) return json({ error: "unknown remote host" }, 404);
          return json(await listRemote({ host: host.host, port: host.port, user: host.user, identity: host.identity }, asked || host.workdir || "~"));
        } catch (error) {
          if (error instanceof FolderError) return json({ error: error.message }, error.status);
          throw error;
        }
      }

      // ----------------------------------------------------------- hosts
      if (path === "/hosts" && request.method === "GET") return json(loadHosts().map(hostToApi));
      if (path === "/hosts/probe" && request.method === "POST") {
        const body = await readJson(request);
        const result = await probeHost({
          host: String(body.host ?? ""),
          port: Number(body.port ?? 22),
          user: String(body.user ?? ""),
          identity: body.identity ? String(body.identity) : undefined,
          workdir: String(body.workdir ?? "~"),
        });
        return json(result);
      }
      if (path === "/hosts" && request.method === "PUT") {
        const body = (await readJson(request)) as unknown as RemoteHostRecord;
        if (!body.id) return json({ error: "id is required" }, 400);
        const hosts = loadHosts();
        const next: RemoteHostRecord = {
          id: body.id,
          label: body.label || body.host,
          host: body.host ?? "",
          port: Number(body.port ?? 22),
          user: body.user ?? "",
          workdir: body.workdir || "~",
          identity: body.identity || undefined,
        };
        const index = hosts.findIndex((h) => h.id === body.id);
        if (index >= 0) hosts[index] = next;
        else hosts.push(next);
        saveHosts(hosts);
        broadcast({ type: "hosts", hosts: hosts.map(hostToApi) });
        return json(hostToApi(next));
      }
      const hostMatch = path.match(/^\/hosts\/([^/]+)$/);
      if (hostMatch && request.method === "DELETE") {
        const id = decodeURIComponent(hostMatch[1] as string);
        saveHosts(loadHosts().filter((h) => h.id !== id));
        const hosts = loadHosts();
        broadcast({ type: "hosts", hosts: hosts.map(hostToApi) });
        return json({ ok: true });
      }

      // ----------------------------------------------------------- misc
      if (path === "/models" && request.method === "GET") return json(modelCatalog());

      // ---------------------------------------------- commands, skills, settings
      if (path === "/commands" && request.method === "GET") return json(COMMANDS);
      if (path === "/skills" && request.method === "GET") return json(skillList());
      if (path === "/settings" && request.method === "GET") return json(settingsView());
      if (path === "/settings" && request.method === "PATCH") return json(patchSettings(await readJson(request)));

      // ------------------------------------------------------------ providers
      // Keys go in through /providers/connect and never come back out: reads are masked.
      if (path === "/providers" && request.method === "GET") return json({ connected: connectedProviders(), catalog: providerCatalog() });
      if (path === "/providers/connect" && request.method === "POST") {
        const body = await readJson(request);
        const providerId = String(body.providerId ?? "");
        if (connecting.has(providerId)) return json({ error: "already connecting this provider" }, 409);
        connecting.add(providerId);
        try {
          const result = await connectProvider({ providerId, key: String(body.key ?? ""), model: body.model ? String(body.model) : undefined });
          return json(result, result.ok ? 200 : 400);
        } finally {
          connecting.delete(providerId);
        }
      }
      const providerMatch = path.match(/^\/providers\/([\w-]+)$/);
      if (providerMatch && request.method === "DELETE") {
        return disconnectProvider(providerMatch[1] as string) ? json({ ok: true }) : json({ error: "not connected" }, 404);
      }
      if (path === "/health") return json({ ok: true, sessions: sessions.list().length, hubClients: hub.clients });

      // ------------------------------------------------- static (built UI)
      // Serve web/dist when it exists, so one process runs the whole app.
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const dist = STATIC_DIR;
        if (existsSync(dist)) {
          const rel = normalize(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
          // Never escape the dist directory.
          const file = resolve(dist, rel);
          // Containment check: never serve anything outside dist (../ traversal).
          if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
            const isShell = extname(file) === ".html";
            const body = Bun.file(file);
            const gz = !isShell && /gzip/.test(request.headers.get("accept-encoding") ?? "") && [".js", ".css", ".svg", ".json"].includes(extname(file));
            // The gzip copy is bytes and the plain copy a BunFile: both are a body, whatever the types say.
            return new Response((gz ? await gzipCached(file, body) : body) as BodyInit, {
              headers: {
                ...(gz ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
                "content-type": MIME[extname(file)] ?? "application/octet-stream",
                // The app shell must always be revalidated: it names the current hashed bundles, and a
                // stale copy asks for files a rebuild has deleted. Hashed assets never change.
                "cache-control": isShell
                  ? "no-cache, no-store, must-revalidate"
                  : rel.startsWith("assets/")
                    ? "public, max-age=31536000, immutable"
                    : "no-cache",
                // Sliding session: loading the app past the cookie's half-life renews it.
                ...(isShell ? renewedCookie(request, claims) : {}),
              },
            });
          }
          // A missing asset (anything under /assets/ or with a file extension) is a real 404. Answering
          // it with index.html made browsers reject it ("MIME type text/html") after a rebuild.
          if (rel.startsWith("assets/") || extname(rel) !== "") {
            return new Response("not found", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            });
          }
          // SPA fallback: any other unknown path renders the app shell.
          return new Response(Bun.file(join(dist, "index.html")), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-cache, no-store, must-revalidate",
              ...renewedCookie(request, claims),
            },
          });
        }
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: (error as Error).message }, 500);
    }
  },
});

console.log(`mini-tui web server on http://${server.hostname}:${server.port}`);
console.log(existsSync(STATIC_DIR) ? `serving the web app from ${STATIC_DIR}` : "web/dist not built - run `bun run build` in web/ (API only for now)");
