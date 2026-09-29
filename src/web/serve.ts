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
import { NOTE_MAX, getNote, saveNote } from "../sessions";
import { FolderError, listLocal, listRemote } from "./folders";
import { Hub, type HubClient } from "./hub";
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

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
}
const PORT = Number(flag("port", process.env.MINITUI_WEB_PORT ?? "4317"));
const HOST = flag("host", process.env.MINITUI_WEB_HOST ?? "127.0.0.1");

type Listener = (event: { type: string; [key: string]: unknown }) => void;

/** Providers with a connection test in flight (a test is a real model call: one at a time). */
const connecting = new Set<string>();

/** A per-session transcript socket, or the one hub socket of a tab. */
type SocketData =
  | { kind: "session"; id: string; sub?: { unsubscribe: () => void; resync: () => void; ping: () => void } }
  | { kind: "hub"; client?: HubClient };
const listeners = new Set<Listener>();

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

hub = new Hub({ get: (id) => getNote(sessions.db(), id), save: (id, body, base) => saveNote(sessions.db(), id, body, base) }, NOTE_MAX);

/** Put a session away everywhere (its socket subscribers and the shared stream). It stays in the history. */
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
    open(ws: import("bun").ServerWebSocket<SocketData>) {
      if (ws.data.kind === "hub") {
        const client: HubClient = { send: (msg) => ws.send(JSON.stringify(msg)) !== 0 };
        ws.data.client = client;
        hub.join(client);
        return;
      }
      const session = sessions.get(ws.data.id);
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

    try {
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
        if (!sessions.get(id)) return json({ error: "unknown session" }, 404);
        if (srv.upgrade(request, { data: { kind: "session", id } satisfies SocketData })) return undefined as unknown as Response;
        return json({ error: "websocket upgrade failed" }, 400);
      }

      if (path === "/sessions" && request.method === "GET") return json(sessions.list().map(summarize));
      if (path === "/sessions" && request.method === "POST") {
        const body = await readJson(request);
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
      const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/prompt|\/model|\/interrupt|\/compact)?$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1] as string);
        const action = sessionMatch[2];
        if (action === "/prompt" && request.method === "POST") {
          const body = await readJson(request);
          try {
            sessions.send(id, String(body.prompt ?? ""));
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
          sessions.setModel(id, model);
          return json({ ok: true });
        }
        if (action === "/compact" && request.method === "POST") {
          try {
            sessions.compact(id);
            return json({ ok: true });
          } catch (error) {
            return json({ error: (error as Error).message }, 409);
          }
        }
        if (action === "/interrupt" && request.method === "POST") {
          sessions.interrupt(id);
          return json({ ok: true });
        }
        if (!action && request.method === "DELETE") {
          dropSession(id);
          return json({ ok: true });
        }
        if (!action && request.method === "GET") {
          const session = sessions.get(id);
          return session ? json(toWire(session)) : json({ error: "unknown session" }, 404);
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
            return json(toWire(sessions.openHistory(id)));
          } catch (error) {
            return json({ error: (error as Error).message }, /unknown session/.test((error as Error).message) ? 404 : 500);
          }
        }
        if (request.method === "DELETE") {
          // Deleting is permanent and separate from closing: it removes the saved conversation.
          const existed = sessions.deleteHistory(id);
          feed.gone(id);
          // Its note went with it: anyone watching it sees it empty, instead of keeping stale text.
          hub.noteChanged({ id, body: "", updatedAt: 0 });
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
            return new Response(readFileSync(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
          }
          // SPA fallback: any unknown path renders the app shell.
          return new Response(readFileSync(join(dist, "index.html")), {
            headers: { "content-type": "text/html; charset=utf-8" },
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
