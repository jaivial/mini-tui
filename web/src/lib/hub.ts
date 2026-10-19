/**
 * The client end of the socket hub (`/api/hub`): one WebSocket for the whole tab, shared by every
 * pane's right sidebar. It survives what the per-session sockets survive, with the same rules —
 * jittered backoff, an immediate retry when the tab is shown or the network returns, and a heartbeat
 * that recycles a half-open socket — because both take those rules from `Reconnect`, which is also
 * where the one they used to disagree on lives: a connection that merely OPENED is not proof of
 * life (E50 measured the hub copy resetting on open and hammering an accepting-but-dropping server
 * 33 times in 3 s). Everything it knows is re-sent on reconnect (the watch list), so a dropped
 * connection loses no updates: the server answers each watch with the current value.
 *
 * Messages sent while offline wait in a queue and go out, in order, once connected. A queued message
 * can be **withdrawn** (`send` returns a token), so a caller that reports a failure can guarantee the
 * message never lands afterwards — and a message the reconnect re-sends is marked as such in the
 * queue (`subscription`) instead of being recognised by its text on the way out.
 *
 * It knows nothing about Svelte; the socket is injectable for tests.
 */
import { Reconnect } from "./reconnect";
import type { SocketLike } from "./session-socket";

export type HubState = "connecting" | "live" | "reconnecting";

export interface HubOptions {
  url?: () => string;
  make?: (url: string) => SocketLike;
  baseDelay?: number;
  maxDelay?: number;
  heartbeat?: number;
  stale?: number;
  /** Injectable clock noise for the backoff, see `Reconnect`. */
  random?: () => number;
}

/** What `send` hands back: the message's fate, for callers that must not lie about it. */
export interface SendToken {
  /** True once the message has been given to the socket: from then on it cannot be withdrawn. */
  readonly sent: boolean;
  /** Withdraw a message that has not gone out. True if it was withdrawn — it will never be sent. */
  cancel(): boolean;
}

type Out = { t: string; [k: string]: unknown };
type In = { t: string; [k: string]: unknown };
type Queued = { raw: string; subscription: boolean; sent: boolean; cancelled: boolean };

const OPEN = 1;

export function hubUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/hub`;
}

export class HubConnection {
  #o: Required<Omit<HubOptions, "random">>;
  #ws: SocketLike | null = null;
  #queue: Queued[] = [];
  #listeners = new Set<(msg: In) => void>();
  #stateListeners = new Set<(s: HubState) => void>();
  #onOpen = new Set<() => void>();
  #r: Reconnect;
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
    this.#r = new Reconnect({
      baseDelay: this.#o.baseDelay,
      maxDelay: this.#o.maxDelay,
      random: options.random,
    });
  }

  /** Connect on first use. Every tab uses it now (the shared workspace), so in practice at load. */
  #ensure() {
    if (this.#started) return;
    this.#started = true;
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("online", this.#wake);
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.addEventListener("visibilitychange", this.#wake);
    this.#connect();
  }

  /**
   * Queue or send one message. `subscription` says "this message DECLARES state that the connect
   * hooks re-declare on every (re)connect" — a watch, an unwatch, an open. A queued copy must not
   * also go out at flush: the hooks already said the current state, and the old code recognised
   * these by sniffing the JSON text (and had already missed two of the five kinds: a queued
   * `ws.watch` and a `term.open` went out twice — two `term.open` is two shells).
   */
  send(msg: Out, opts: { subscription?: boolean } = {}): SendToken {
    this.#ensure();
    const entry: Queued = { raw: JSON.stringify(msg), subscription: opts.subscription === true, sent: false, cancelled: false };
    const token: SendToken = {
      get sent() {
        return entry.sent;
      },
      cancel: () => {
        if (entry.sent) return false;
        entry.cancelled = true;
        const at = this.#queue.indexOf(entry);
        if (at >= 0) this.#queue.splice(at, 1);
        return true;
      },
    };
    if (this.#ws?.readyState === OPEN) {
      entry.sent = true;
      this.#ws.send(entry.raw);
    } else this.#queue.push(entry);
    return token;
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

  /** Stop for good: no socket, no timers, no page hooks (tests; a page just goes away). */
  stop(): void {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    const w = typeof window !== "undefined" ? window : undefined;
    const d = typeof document !== "undefined" ? document : undefined;
    if (typeof w?.removeEventListener === "function") w.removeEventListener("online", this.#wake);
    if (typeof d?.removeEventListener === "function") d.removeEventListener("visibilitychange", this.#wake);
    this.#teardown();
    this.#queue = [];
  }

  #set(s: HubState) {
    this.state = s;
    for (const l of this.#stateListeners) l(s);
  }

  #connect() {
    this.#teardown();
    this.#set(this.#r.attempts ? "reconnecting" : "connecting");
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
      // Not proof of life (see `Reconnect`): an accepted-then-dropped socket would reset the
      // backoff on every attempt and hammer a server that is already sick. The server greets
      // with `hello`, and that message is the proof.
      this.#set("live");
      // Subscriptions first (the server answers each watch with the current value), then what queued.
      // One throwing hook or one failing send must not take the rest of the batch down with it.
      const queued = this.#queue;
      this.#queue = [];
      for (const fn of this.#onOpen) {
        try {
          fn();
        } catch {
          /* the hook owns its error; the others still run */
        }
      }
      for (const entry of queued) {
        if (entry.cancelled || entry.subscription) continue;
        entry.sent = true;
        try {
          ws.send(entry.raw);
        } catch {
          /* a socket already closing: the message is lost, the next reconnect re-sends what it can */
        }
      }
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
      this.#r.delivered(); // something real arrived: this connection works
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
    this.#set("reconnecting");
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.#connect(), this.#r.nextDelay());
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
