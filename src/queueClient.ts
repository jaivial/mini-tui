/**
 * The terminal UI's client of the web server's work queue (dispatcher chat mode).
 *
 * The web server owns the queue: the dispatcher chat, the durable task list and the worker
 * sessions (src/web/queueHost.ts, docs/work-queue.md). The terminal talks to it over the same
 * loopback HTTP API the web app uses, so both UIs show one queue:
 *   - discovery: `MINITUI_WEB_URL`, else `http://127.0.0.1:${MINITUI_WEB_PORT ?? 4317}`;
 *   - when nothing answers at the default address, a server is started as a child on a free
 *     port and stopped when this process exits (the queue is durable: queued and running tasks
 *     pause until a server runs again);
 *   - queue changes: the shared SSE stream `/api/stream` (`queue` frames, deltas merged by id),
 *     with a 2 s poll of `GET /api/queue` while the stream is down;
 *   - one session's transcript: the per-session socket `/api/sessions/:id/socket` (a snapshot,
 *     then deltas), which also carries the notices the server injects into the chat.
 *
 * Manual mode uses the same client for a workspace on a remote host: the server owns the SSH
 * runs, so the terminal creates the session there (`POST /api/sessions`), follows it over its
 * socket and sends follow-ups to it. Files go up with `POST /api/attachments` first; only the
 * returned refs travel with a prompt.
 */
import { mkdirSync, openSync, closeSync } from "node:fs";
import { basename, join } from "node:path";

import { RUNS_DIR } from "./config";
import type { RunEvent } from "./traj/schema";

export type QueueTaskStatus = "queued" | "running" | "done" | "error" | "cancelled";

/** A task as the server sends it (`wireTask` in src/web/serve.ts; result and brief are cut). */
export interface QueueTaskView {
  id: string;
  seq?: number;
  title: string;
  description: string;
  prompt?: string;
  workspace: string;
  cwd: string;
  model?: string;
  status: QueueTaskStatus;
  sessionId: string;
  result: string;
  createdAt: number;
  startedAt: number;
  finishedAt: number;
  updatedAt: number;
  browser?: { tab: string; message: string; since: number };
}

export interface QueueState {
  tasks: QueueTaskView[];
  /** The dispatcher chat's session id ("" = no chat yet: the next prompt creates it). */
  main: string;
  concurrency: number;
}

export const EMPTY_QUEUE: QueueState = { tasks: [], main: "", concurrency: 0 };

/** What the server says about a session without its transcript. */
export interface SessionMetaView {
  id: string;
  title?: string;
  model?: string;
  cwd?: string;
  status?: string;
  cost?: number;
  apiCalls?: number;
  startedAt?: number;
  exitStatus?: string;
  role?: "dispatcher" | "worker";
}

export interface SessionView extends SessionMetaView {
  events: RunEvent[];
}

/** A file the server stored (`POST /api/attachments`); a prompt carries these refs, never bytes. */
export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

/** A saved remote host as `GET /api/hosts` lists it (only what the terminal shows). */
export interface RemoteHostView {
  id: string;
  label?: string;
  host?: string;
  user?: string;
  workdir?: string;
  online?: boolean;
}

export interface CreateSessionInput {
  prompt: string;
  cwd?: string;
  model?: string;
  target: "local" | "remote";
  hostId?: string;
  attachments?: AttachmentRef[];
}

export interface QueueFrame {
  delta?: boolean;
  tasks?: QueueTaskView[];
  main?: string;
  concurrency?: number;
}

/** Merge one `queue` frame into the state: a delta replaces the tasks it names, a full frame replaces all. */
export function applyQueueFrame(state: QueueState, frame: QueueFrame): QueueState {
  const incoming = Array.isArray(frame.tasks) ? frame.tasks.filter((t) => t && typeof t.id === "string") : [];
  let tasks: QueueTaskView[];
  if (frame.delta) {
    const byId = new Map(state.tasks.map((t) => [t.id, t] as const));
    for (const task of incoming) byId.set(task.id, task);
    tasks = [...byId.values()];
  } else {
    tasks = incoming;
  }
  tasks.sort((a, b) => (a.seq ?? a.createdAt) - (b.seq ?? b.createdAt));
  return {
    tasks,
    main: typeof frame.main === "string" ? frame.main : state.main,
    concurrency: typeof frame.concurrency === "number" ? frame.concurrency : state.concurrency,
  };
}

export function queueCounts(tasks: QueueTaskView[]): Record<QueueTaskStatus, number> {
  const counts: Record<QueueTaskStatus, number> = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };
  for (const task of tasks) if (task.status in counts) counts[task.status]++;
  return counts;
}

/** The status-line strip: "3 running · 2 queued" (empty when nothing is in flight). */
export function queueBadge(tasks: QueueTaskView[]): string {
  const counts = queueCounts(tasks);
  const parts: string[] = [];
  if (counts.running) parts.push(`${counts.running} running`);
  if (counts.queued) parts.push(`${counts.queued} queued`);
  return parts.join(" · ");
}

const QUEUE_STATE = /\s*<queue_state>[\s\S]*?<\/queue_state>\s*$/;
const BROWSER_MARKER = /\s*\[\[browser(?::[A-Za-z0-9_-]+)?\]\]/g;

/**
 * What the human reads of a queue session (the same filter as web/src/App.svelte): the
 * `<queue_state>` block the server appends for the dispatcher is not what the human wrote, the
 * `[queue] Task …` result hand-offs are for the dispatcher (its reply is what the human reads),
 * and the `[[browser:<tab>]]` marker is for the web's browser panel.
 */
export function cleanQueueEvents(events: RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  for (const event of events) {
    if (event.type === "task") {
      if (event.text.startsWith("[queue] Task ")) continue;
      out.push(event.text.includes("<queue_state>") ? { ...event, text: event.text.replace(QUEUE_STATE, "") } : event);
      continue;
    }
    if (event.type === "notice" && event.text.includes("[[browser")) {
      out.push({ ...event, text: `${event.text.replace(BROWSER_MARKER, "")} (open the Browser panel in the web app)` });
      continue;
    }
    out.push(event);
  }
  return out;
}

/** Where the web server is expected: `MINITUI_WEB_URL`, else the loopback default port. */
export function defaultServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MINITUI_WEB_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `http://127.0.0.1:${env.MINITUI_WEB_PORT?.trim() || "4317"}`;
}

/** A mini-tui web server answers at `url` (`GET /api/health` → `{ok: true}`) within `timeoutMs`. */
export async function probeServer(url: string, timeoutMs = 800, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** A port nothing listens on right now (the OS picks it). */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port ?? 0;
}

export interface ConnectResult {
  url: string;
  /** This process started the server (it stops when the terminal UI exits). */
  started: boolean;
  logPath?: string;
}

export interface FollowHandlers {
  onSnapshot: (session: SessionView) => void;
  onDelta: (events: RunEvent[], meta: SessionMetaView) => void;
  /** The server closed the session (or does not know it); the follow has ended. */
  onGone?: (reason: string) => void;
}

export interface QueueSubscriber {
  onQueue: (state: QueueState) => void;
  /** A session's metadata changed (status, title, cost…). */
  onSession?: (meta: SessionMetaView) => void;
  /** The shared settings changed in another UI. */
  onSettings?: () => void;
  /** The stream is up (true) or down and the client is polling (false). */
  onLink?: (live: boolean) => void;
}

export interface ActionResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** What the terminal UI needs of the client (tests hand the App a fake with this shape). */
export interface QueueClientLike {
  readonly url: string;
  connect(): Promise<ConnectResult>;
  state(): QueueState;
  subscribe(subscriber: QueueSubscriber): () => void;
  follow(sessionId: string, handlers: FollowHandlers): () => void;
  prompt(prompt: string, model?: string, attachments?: AttachmentRef[]): Promise<{ id: string }>;
  newChat(): Promise<void>;
  cancel(taskId: string): Promise<ActionResult>;
  redirect(taskId: string, message: string): Promise<ActionResult>;
  interrupt(sessionId: string): Promise<void>;
  compact(sessionId: string): Promise<void>;
  /** Store one file on the server; the ref goes with the next prompt. */
  upload(file: { name: string; bytes: Uint8Array }): Promise<AttachmentRef>;
  /** Start a session the server runs (a remote host's when `target` is "remote"). */
  createSession(input: CreateSessionInput): Promise<SessionMetaView>;
  /** A follow-up prompt to a session the server runs. */
  send(sessionId: string, prompt: string, attachments?: AttachmentRef[]): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  /** The saved remote hosts; empty when no server answers (labels fall back to the id). */
  hosts(): Promise<RemoteHostView[]>;
  stop(): void;
}

export interface QueueClientOptions {
  /** Server address; default `defaultServerUrl()`. An explicit address is never auto-started. */
  url?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Start a server when none answers (default true for the default address). */
  autoStart?: boolean;
  /** Folder for the started server's log (default: the runs folder). */
  logDir?: string;
  /** The server entry point (default: src/web/serve.ts next to this file). */
  serverScript?: string;
  /** Port of a started server (default: one the OS says is free). */
  serverPort?: number;
  /** How long a started server gets to answer `/api/health` (ms). */
  startTimeoutMs?: number;
  /** Poll interval while the stream is down (ms). */
  pollMs?: number;
  /** Test hook: replaces the child process start. Returns the started server's URL. */
  startServer?: () => Promise<{ url: string; logPath?: string; stop: () => void }>;
}

function bunBinary(): string {
  const exec = process.execPath;
  if (/^bun(-debug)?(\.exe)?$/.test(basename(exec))) return exec;
  return Bun.which("bun") ?? exec;
}

export class QueueClient implements QueueClientLike {
  url: string;
  readonly #explicit: boolean;
  readonly #o: QueueClientOptions;
  readonly #fetch: typeof fetch;
  #connecting: Promise<ConnectResult> | null = null;
  #state: QueueState = { ...EMPTY_QUEUE };
  #subscribers = new Set<QueueSubscriber>();
  #streamAbort: AbortController | null = null;
  #streamRunning = false;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #stopServer: (() => void) | null = null;
  #closed = false;

  constructor(options: QueueClientOptions = {}) {
    this.#o = options;
    const env = options.env ?? process.env;
    this.#explicit = Boolean(options.url || env.MINITUI_WEB_URL?.trim());
    this.url = (options.url ?? defaultServerUrl(env)).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  connect(): Promise<ConnectResult> {
    this.#connecting ??= this.#connect().catch((error) => {
      this.#connecting = null; // a later attempt may succeed (e.g. the server came up)
      throw error;
    });
    return this.#connecting;
  }

  async #connect(): Promise<ConnectResult> {
    if (await probeServer(this.url, 800, this.#fetch)) return { url: this.url, started: false };
    const autoStart = this.#o.autoStart ?? !this.#explicit;
    if (!autoStart) throw new Error(`no mini-tui web server answers at ${this.url}`);
    const started = this.#o.startServer ? await this.#o.startServer() : await this.#spawnServer();
    this.url = started.url.replace(/\/+$/, "");
    this.#stopServer = started.stop;
    return { url: this.url, started: true, logPath: started.logPath };
  }

  async #spawnServer(): Promise<{ url: string; logPath: string; stop: () => void }> {
    const port = this.#o.serverPort ?? freePort();
    const url = `http://127.0.0.1:${port}`;
    const dir = this.#o.logDir ?? RUNS_DIR;
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `queue-server-${port}.log`);
    const fd = openSync(logPath, "a");
    const script = this.#o.serverScript ?? join(import.meta.dir, "web", "serve.ts");
    const child = Bun.spawn([bunBinary(), script, "--host", "127.0.0.1", "--port", String(port)], {
      env: { ...(this.#o.env ?? process.env) },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    closeSync(fd);
    let alive = true;
    void child.exited.then(() => {
      alive = false;
    });
    const stop = () => {
      if (!alive) return;
      alive = false;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    };
    // The server outlives nothing: it stops with this process however it ends.
    process.once("exit", stop);
    const deadline = Date.now() + (this.#o.startTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      if (!alive) throw new Error(`the queue server exited at startup (log: ${logPath})`);
      if (await probeServer(url, 500, this.#fetch)) return { url, logPath, stop };
      await Bun.sleep(150);
    }
    stop();
    throw new Error(`the queue server did not answer within ${Math.round((this.#o.startTimeoutMs ?? 20_000) / 1000)}s (log: ${logPath})`);
  }

  state(): QueueState {
    return this.#state;
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok && !(data && typeof data === "object" && "ok" in data)) {
      throw new Error(data?.error || `${method} ${path} → HTTP ${res.status}`);
    }
    return data;
  }

  async list(): Promise<QueueState> {
    const frame = await this.#json<QueueFrame>("GET", "/api/queue");
    this.#publish(applyQueueFrame(this.#state, { ...frame, delta: false }));
    return this.#state;
  }

  async prompt(prompt: string, model?: string, attachments?: AttachmentRef[]): Promise<{ id: string }> {
    const session = await this.#json<{ id?: string }>("POST", "/api/queue/prompt", { prompt, ...(model ? { model } : {}), ...(attachments?.length ? { attachments } : {}) });
    const id = typeof session.id === "string" ? session.id : "";
    if (id && id !== this.#state.main) this.#publish({ ...this.#state, main: id });
    return { id };
  }

  async newChat(): Promise<void> {
    await this.#json("POST", "/api/queue/new");
    this.#publish({ ...this.#state, main: "" });
  }

  cancel(taskId: string): Promise<ActionResult> {
    return this.#json<ActionResult>("POST", `/api/queue/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  redirect(taskId: string, message: string): Promise<ActionResult> {
    return this.#json<ActionResult>("POST", `/api/queue/tasks/${encodeURIComponent(taskId)}/redirect`, { message });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.#json("POST", `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`);
  }

  async compact(sessionId: string): Promise<void> {
    await this.#json("POST", `/api/sessions/${encodeURIComponent(sessionId)}/compact`);
  }

  async upload(file: { name: string; bytes: Uint8Array }): Promise<AttachmentRef> {
    const form = new FormData();
    form.append("file", new File([file.bytes as Uint8Array<ArrayBuffer>], file.name), file.name);
    // The server answers its own size/type verdict (413/400 with a reason): pass that on as is.
    const res = await this.#fetch(`${this.url}/api/attachments`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    const data = (await res.json().catch(() => ({}))) as Partial<AttachmentRef> & { error?: string };
    if (!res.ok || typeof data.id !== "string") throw new Error(`${file.name}: ${data.error || `HTTP ${res.status}`}`);
    return { id: data.id, name: data.name || file.name, mime: data.mime ?? "", size: data.size ?? file.bytes.length, url: data.url ?? `/api/attachments/${data.id}` };
  }

  async createSession(input: CreateSessionInput): Promise<SessionMetaView> {
    const { attachments, ...rest } = input;
    const session = await this.#json<SessionMetaView>("POST", "/api/sessions", { ...rest, ...(attachments?.length ? { attachments } : {}) });
    if (typeof session?.id !== "string" || !session.id) throw new Error("the server did not return a session");
    return session;
  }

  async send(sessionId: string, prompt: string, attachments?: AttachmentRef[]): Promise<void> {
    await this.#json("POST", `/api/sessions/${encodeURIComponent(sessionId)}/prompt`, { prompt, ...(attachments?.length ? { attachments } : {}) });
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    await this.#json("POST", `/api/sessions/${encodeURIComponent(sessionId)}/model`, { model });
  }

  async hosts(): Promise<RemoteHostView[]> {
    try {
      const res = await this.#fetch(`${this.url}/api/hosts`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return [];
      const list = (await res.json()) as unknown;
      return Array.isArray(list) ? list.filter((h): h is RemoteHostView => Boolean(h) && typeof (h as RemoteHostView).id === "string") : [];
    } catch {
      return [];
    }
  }

  #publish(next: QueueState): void {
    this.#state = next;
    for (const sub of [...this.#subscribers]) sub.onQueue(next);
  }

  subscribe(subscriber: QueueSubscriber): () => void {
    this.#subscribers.add(subscriber);
    if (!this.#streamRunning) void this.#streamLoop();
    return () => {
      this.#subscribers.delete(subscriber);
      if (!this.#subscribers.size) this.#stopStream();
    };
  }

  #stopStream(): void {
    this.#streamRunning = false;
    this.#streamAbort?.abort();
    this.#streamAbort = null;
    this.#stopPoll();
  }

  #startPoll(): void {
    if (this.#pollTimer) return;
    const tick = () => void this.list().catch(() => undefined);
    tick();
    this.#pollTimer = setInterval(tick, this.#o.pollMs ?? 2000);
  }

  #stopPoll(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  #link(live: boolean): void {
    for (const sub of [...this.#subscribers]) sub.onLink?.(live);
  }

  async #streamLoop(): Promise<void> {
    this.#streamRunning = true;
    let backoff = 500;
    while (this.#streamRunning && !this.#closed) {
      const abort = new AbortController();
      this.#streamAbort = abort;
      try {
        const res = await this.#fetch(`${this.url}/api/stream`, { signal: abort.signal, headers: { accept: "text/event-stream" } });
        if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);
        this.#stopPoll();
        this.#link(true);
        backoff = 500;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            this.#onStreamChunk(chunk);
          }
        }
      } catch {
        // dropped or refused: poll until it comes back
      }
      if (!this.#streamRunning || this.#closed) break;
      this.#link(false);
      this.#startPoll();
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 5000);
    }
  }

  #onStreamChunk(chunk: string): void {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === "queue") this.#publish(applyQueueFrame(this.#state, event as QueueFrame));
    else if (event.type === "session" && event.session && typeof event.session === "object") {
      const meta = event.session as SessionMetaView;
      for (const sub of [...this.#subscribers]) sub.onSession?.(meta);
    } else if (event.type === "settings") {
      for (const sub of [...this.#subscribers]) sub.onSettings?.();
    }
  }

  follow(sessionId: string, handlers: FollowHandlers): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let count = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (stopped || this.#closed) return;
      const url = `${this.url.replace(/^http/, "ws")}/api/sessions/${encodeURIComponent(sessionId)}/socket`;
      try {
        socket = new WebSocket(url);
      } catch {
        retry = setTimeout(open, 1000);
        return;
      }
      const ws = socket;
      ws.onmessage = (message) => {
        if (stopped || typeof message.data !== "string") return;
        let frame: { t?: string; id?: string; session?: SessionView; from?: number; events?: RunEvent[]; meta?: SessionMetaView };
        try {
          frame = JSON.parse(message.data);
        } catch {
          return;
        }
        if (frame.t === "snapshot" && frame.session) {
          const events = Array.isArray(frame.session.events) ? frame.session.events : [];
          count = events.length;
          handlers.onSnapshot({ ...frame.session, events });
        } else if (frame.t === "delta" && Array.isArray(frame.events)) {
          if (frame.from !== count) {
            // a hole in the transcript: ask for a fresh snapshot instead of appending
            ws.send(JSON.stringify({ t: "resync" }));
            return;
          }
          count += frame.events.length;
          handlers.onDelta(frame.events, frame.meta ?? { id: sessionId });
        } else if (frame.t === "gone") {
          stopped = true;
          ws.close();
          handlers.onGone?.("the session was closed");
        }
      };
      ws.onclose = (event) => {
        if (stopped || this.#closed) return;
        if (event.code === 4404) {
          stopped = true;
          handlers.onGone?.("the server does not know this session");
          return;
        }
        retry = setTimeout(open, 1000);
      };
      ws.onerror = () => {
        // onclose follows and schedules the retry
      };
    };
    open();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      try {
        socket?.close();
      } catch {
        // already closed
      }
    };
  }

  /** Close the streams; a server this client started is stopped too. */
  stop(): void {
    this.#closed = true;
    this.#subscribers.clear();
    this.#stopStream();
    this.#stopServer?.();
    this.#stopServer = null;
  }
}
