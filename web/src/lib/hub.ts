/**
 * The client end of the socket hub (`/api/hub`): one WebSocket for the whole tab, shared by every
 * pane's right sidebar. It survives what the per-session sockets survive, with the same rules:
 * jittered backoff, an immediate retry when the tab is shown or the network returns, and a heartbeat
 * that recycles a half-open socket. Everything it knows is re-sent on reconnect (the watch list), so a
 * dropped connection loses no updates: the server answers each watch with the current value.
 *
 * Messages sent while offline wait in a queue and go out, in order, once connected.
 * It knows nothing about Svelte; the socket is injectable for tests.
 */
import type { SocketLike } from "./session-socket";

export type HubState = "connecting" | "live" | "reconnecting";

export interface HubOptions {
  url?: () => string;
  make?: (url: string) => SocketLike;
  baseDelay?: number;
  maxDelay?: number;
  heartbeat?: number;
  stale?: number;
}

type Out = { t: string; [k: string]: unknown };
type In = { t: string; [k: string]: unknown };

const OPEN = 1;

export function hubUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/hub`;
}

export class HubConnection {
  #o: Required<HubOptions>;
  #ws: SocketLike | null = null;
  #queue: string[] = [];
  #listeners = new Set<(msg: In) => void>();
  #stateListeners = new Set<(s: HubState) => void>();
  #onOpen = new Set<() => void>();
  #attempts = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #beat: ReturnType<typeof setInterval> | undefined;
  #lastSeen = 0;
  #started = false;
  state: HubState = "connecting";
  #wake = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify({ t: "ping" }));
    else {
      clearTimeout(this.#retry);
      this.#connect();
    }
  };

  constructor(options: HubOptions = {}) {
    this.#o = {
      url: options.url ?? hubUrl,
      make: options.make ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      baseDelay: options.baseDelay ?? 500,
      maxDelay: options.maxDelay ?? 15_000,
      heartbeat: options.heartbeat ?? 20_000,
      stale: options.stale ?? 50_000,
    };
  }

  /** Connect on first use. Every tab uses it now (the shared workspace), so in practice at load. */
  #ensure() {
    if (this.#started) return;
    this.#started = true;
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("online", this.#wake);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.addEventListener("visibilitychange", this.#wake);
    this.#connect();
  }

  send(msg: Out) {
    this.#ensure();
    const raw = JSON.stringify(msg);
    if (this.#ws?.readyState === OPEN) this.#ws.send(raw);
    else this.#queue.push(raw);
  }

  /** Every message from the server. Returns the unsubscribe. */
  on(listener: (msg: In) => void): () => void {
    // Listening does not connect: only sending does, so a tab that never opens notes holds no hub.
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onState(listener: (s: HubState) => void): () => void {
    this.#stateListeners.add(listener);
    listener(this.state);
    return () => this.#stateListeners.delete(listener);
  }
  /** Runs on every (re)connect, before the queue is flushed: re-send subscriptions here. */
  onConnect(fn: () => void): () => void {
    this.#onOpen.add(fn);
    return () => this.#onOpen.delete(fn);
  }

  #set(s: HubState) {
    this.state = s;
    for (const l of this.#stateListeners) l(s);
  }

  #connect() {
    this.#teardown();
    this.#set(this.#attempts ? "reconnecting" : "connecting");
    let ws: SocketLike;
    try {
      ws = this.#o.make(this.#o.url());
    } catch {
      return this.#scheduleRetry();
    }
    this.#ws = ws;
    this.#lastSeen = Date.now();
    ws.onopen = () => {
      this.#lastSeen = Date.now();
      this.#attempts = 0;
      this.#set("live");
      // Subscriptions first (the server answers each watch with the current value), then what queued.
      const queued = this.#queue;
      this.#queue = [];
      for (const fn of this.#onOpen) fn();
      for (const raw of queued) if (!raw.includes('"t":"note.watch"')) ws.send(raw);
      this.#beat = setInterval(() => this.#tick(), this.#o.heartbeat);
    };
    ws.onmessage = (ev) => {
      this.#lastSeen = Date.now();
      let msg: In;
      try {
        msg = JSON.parse(String(ev.data)) as In;
      } catch {
        return;
      }
      if (msg.t === "pong") return;
      for (const l of this.#listeners) l(msg);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#teardown();
      this.#scheduleRetry();
    };
    ws.onerror = () => {
      /* close follows */
    };
  }

  #tick() {
    if (Date.now() - this.#lastSeen > this.#o.stale) {
      const ws = this.#ws;
      this.#teardown();
      ws?.close();
      return this.#scheduleRetry();
    }
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify({ t: "ping" }));
  }

  #scheduleRetry() {
    this.#attempts++;
    this.#set("reconnecting");
    const cap = Math.min(this.#o.maxDelay, this.#o.baseDelay * 2 ** (this.#attempts - 1));
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.#connect(), cap * (0.5 + Math.random() * 0.5));
  }

  #teardown() {
    clearInterval(this.#beat);
    this.#beat = undefined;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (ws.readyState <= OPEN) {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    }
  }
}

export const hub = new HubConnection();
