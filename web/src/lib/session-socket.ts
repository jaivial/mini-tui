/**
 * One WebSocket for one session.
 *
 * The server streams a session's transcript on `/api/sessions/:id/socket`
 * (snapshot first, then deltas). This class owns everything that can go wrong
 * with that connection so the store never has to:
 *
 *  - reconnects with jittered exponential backoff, and immediately when the tab
 *    becomes visible or the network returns (mobile browsers freeze sockets);
 *  - a heartbeat, because a half-open TCP connection on a phone never fires
 *    `close`: if nothing arrives for `stale` ms the socket is recycled;
 *  - stops for good on `gone` (session closed) or close code 4404 (unknown).
 *
 * It knows nothing about Svelte; the socket implementation is injectable.
 */
/// <reference lib="dom" />
import type { Frame } from "./types";

export type SocketState = "idle" | "connecting" | "live" | "reconnecting" | "gone";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface SocketOptions {
  url?: (id: string) => string;
  make?: (url: string) => SocketLike;
  baseDelay?: number;
  maxDelay?: number;
  /** How often to ping, ms. */
  heartbeat?: number;
  /** Recycle the socket when nothing has arrived for this long, ms. */
  stale?: number;
  /**
   * A refused handshake (HTTP 404) surfaces in browsers as a generic close, not a code we can
   * read. Before retrying a connection that never delivered a snapshot, ask whether the session
   * still exists: `false` = gone (stop), `true`/`null` = keep trying (`null` = could not tell).
   */
  exists?: (id: string) => Promise<boolean | null>;
}

export interface SocketHandlers {
  frame(frame: Frame): void;
  /** `attempts` is how many reconnects have failed in a row. */
  state(state: SocketState, attempts: number): void;
}

const OPEN = 1;

export function defaultUrl(id: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/sessions/${encodeURIComponent(id)}/socket`;
}

export class SessionSocket {
  readonly id: string;
  #h: SocketHandlers;
  #o: Required<SocketOptions>;
  #ws: SocketLike | null = null;
  #wanted = false;
  #attempts = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #beat: ReturnType<typeof setInterval> | undefined;
  #lastSeen = 0;
  #gotSnapshot = false;
  #state: SocketState = "idle";
  /** The tab-wide wake hooks, shared by every socket: identical listeners, added at most once. */
  static #waking = new Set<SessionSocket>();
  /** The one listener pair on `window`/`document`, kept so it can be taken off again. */
  static #lastWake: (() => void) | null = null;
  static #listening = false;
  #wake = () => {
    if (typeof document !== "undefined" && document?.visibilityState === "hidden") return;
    this.#poke();
  };

  constructor(id: string, handlers: SocketHandlers, options: SocketOptions = {}) {
    this.id = id;
    this.#h = handlers;
    this.#o = {
      url: options.url ?? defaultUrl,
      make: options.make ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      baseDelay: options.baseDelay ?? 500,
      maxDelay: options.maxDelay ?? 15_000,
      heartbeat: options.heartbeat ?? 20_000,
      stale: options.stale ?? 50_000,
      exists: options.exists ?? (async () => null),
    };
  }

  get state(): SocketState {
    return this.#state;
  }

  open(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#listen(true);
    this.#connect();
  }

  close(): void {
    this.#wanted = false;
    this.#teardown();
    clearTimeout(this.#retry);
    this.#listen(false);
    this.#set("idle");
  }

  /** Ask the server for a fresh snapshot (the client noticed a gap). */
  resync(): void {
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify({ t: "resync" }));
  }

  /**
   * Wake-up hooks (network back, tab visible). Every socket wants the same two listeners, so they
   * are added once for the class and fan out to the sockets that are open, rather than the page
   * piling up hundreds of them (one pair per socket, again on every reconnect).
   */
  #listen(on: boolean): void {
    const w = typeof window !== "undefined" ? window : undefined;
    const d = typeof document !== "undefined" ? document : undefined;
    if (on) {
      SessionSocket.#waking.add(this);
      if (SessionSocket.#listening || typeof w === "undefined") return;
      SessionSocket.#listening = true;
      const wake = (SessionSocket.#lastWake = () => {
        for (const socket of SessionSocket.#waking) socket.#wake();
      });
      if (typeof w.addEventListener === "function") w.addEventListener("online", wake);
      if (typeof d?.addEventListener === "function") d.addEventListener("visibilitychange", wake);
      return;
    }
    SessionSocket.#waking.delete(this);
    const wake = SessionSocket.#lastWake;
    if (!SessionSocket.#waking.size && SessionSocket.#listening && wake) {
      SessionSocket.#listening = false;
      SessionSocket.#lastWake = null;
      if (typeof w?.removeEventListener === "function") w.removeEventListener("online", wake);
      if (typeof d?.removeEventListener === "function") d.removeEventListener("visibilitychange", wake);
    }
  }

  #set(state: SocketState): void {
    this.#state = state;
    this.#h.state(state, this.#attempts);
  }

  #connect(): void {
    if (!this.#wanted) return;
    clearTimeout(this.#retry);
    this.#teardown();
    this.#set(this.#attempts ? "reconnecting" : "connecting");
    let ws: SocketLike;
    try {
      ws = this.#o.make(this.#o.url(this.id));
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#ws = ws;
    this.#gotSnapshot = false;
    this.#lastSeen = Date.now();
    ws.onopen = () => {
      this.#lastSeen = Date.now();
      this.#beat = setInterval(() => this.#tick(), this.#o.heartbeat);
    };
    ws.onmessage = (ev) => {
      this.#lastSeen = Date.now();
      let frame: Frame;
      try {
        frame = JSON.parse(String(ev.data)) as Frame;
      } catch {
        return;
      }
      if (frame.t === "pong") return;
      if (frame.t === "snapshot") {
        // Only a real snapshot proves the connection works: an accepted-then-dropped
        // socket must keep backing off rather than reset the delay every time.
        this.#attempts = 0;
        this.#gotSnapshot = true;
        if (this.#state !== "live") this.#set("live");
      }
      if (frame.t === "gone") {
        this.#wanted = false;
        this.#teardown();
        this.#set("gone");
      }
      this.#h.frame(frame);
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return; // a socket we already replaced
      this.#teardown();
      if (!this.#wanted) return;
      if (ev.code === 4404) {
        this.#wanted = false;
        this.#set("gone");
        return;
      }
      if (this.#gotSnapshot) return this.#scheduleRetry();
      // Never delivered anything: was the handshake refused because the session is gone?
      void this.#o.exists(this.id).then(
        (alive) => {
          if (!this.#wanted) return;
          if (alive === false) {
            this.#wanted = false;
            this.#set("gone");
            this.#h.frame({ t: "gone", id: this.id });
          } else this.#scheduleRetry();
        },
        () => this.#scheduleRetry(),
      );
    };
    ws.onerror = () => {
      /* `close` always follows; reconnect logic lives there */
    };
  }

  #tick(): void {
    if (Date.now() - this.#lastSeen > this.#o.stale) {
      // Half-open: the OS thinks it is connected but nothing is arriving.
      const ws = this.#ws;
      this.#teardown();
      ws?.close();
      this.#scheduleRetry();
      return;
    }
    if (this.#ws?.readyState === OPEN) this.#ws.send(JSON.stringify({ t: "ping" }));
  }

  #scheduleRetry(): void {
    if (!this.#wanted) return;
    this.#attempts++;
    this.#set("reconnecting");
    const cap = Math.min(this.#o.maxDelay, this.#o.baseDelay * 2 ** (this.#attempts - 1));
    const delay = cap * (0.5 + Math.random() * 0.5);
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.#connect(), delay);
  }

  /** Tab visible again / network back: don't wait out the backoff. */
  #poke(): void {
    if (!this.#wanted) return;
    if (this.#ws && this.#ws.readyState === OPEN) {
      this.#ws.send(JSON.stringify({ t: "ping" }));
      return;
    }
    this.#connect();
  }

  #teardown(): void {
    clearInterval(this.#beat);
    this.#beat = undefined;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }
}
