/**
 * Per-session transcript feed.
 *
 * Each open session gets its own subscriber list, and every browser socket
 * subscribes to exactly one session. A subscriber is sent
 *   - a `snapshot` when it connects (and whenever it can no longer be trusted), then
 *   - `delta` frames carrying only the events appended since its last frame.
 *
 * Nothing here knows about sockets: a subscriber is a `send` function, so the
 * isolation and ordering rules are testable without a network.
 */
import type { RunEvent } from "../traj/schema";
import type { LiveSession } from "./sessions";

/** A session without its transcript: cheap enough to broadcast on every change. */
export type SessionMeta = Omit<LiveSession, "events" | "messages" | "partial">;
/** The transcript as the browser sees it. `messages` (raw model I/O) never leaves the server. */
export type WireSession = Omit<LiveSession, "messages">;

export function summarize(session: LiveSession): SessionMeta {
  const { events: _events, messages: _messages, partial: _partial, ...meta } = session;
  return meta;
}

export function toWire(session: LiveSession): WireSession {
  const { messages: _messages, ...rest } = session;
  return rest;
}

export type Frame =
  | { t: "snapshot"; id: string; session: WireSession }
  | { t: "delta"; id: string; from: number; events: RunEvent[]; meta: SessionMeta; partial: LiveSession["partial"] | null }
  | { t: "gone"; id: string }
  | { t: "pong"; id: string };

/** Return false when the frame could not be delivered (socket dropped it). */
export type Send = (frame: Frame) => boolean;

interface Sub {
  send: Send;
  session: LiveSession;
  /** How many events this subscriber has been sent. */
  sent: number;
  /** The events array it was sent from: a replaced array means a rewrite, so resnapshot. */
  ref: RunEvent[];
  resync: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class SessionFeed {
  #subs = new Map<string, Set<Sub>>();
  /** Frames within this window are merged into one (0 = send every change immediately). */
  readonly #delay: number;

  constructor(delay = 33) {
    this.#delay = delay;
  }

  count(id: string): number {
    return this.#subs.get(id)?.size ?? 0;
  }

  subscribe(session: LiveSession, send: Send): { unsubscribe: () => void; resync: () => void; ping: () => void } {
    const sub: Sub = { send, session, sent: 0, ref: session.events, resync: true, timer: undefined };
    let set = this.#subs.get(session.id);
    if (!set) this.#subs.set(session.id, (set = new Set()));
    set.add(sub);
    this.#flush(sub); // the snapshot goes out before anything else can
    return {
      unsubscribe: () => this.#remove(session.id, sub),
      resync: () => {
        sub.resync = true;
        this.#flush(sub);
      },
      ping: () => void send({ t: "pong", id: session.id }),
    };
  }

  /** The session changed: bring its subscribers (and only its subscribers) up to date. */
  publish(session: LiveSession): void {
    const set = this.#subs.get(session.id);
    if (!set) return;
    for (const sub of set) {
      sub.session = session;
      this.#schedule(sub, this.#delay);
    }
  }

  /** The session was closed: tell its subscribers and forget them. */
  gone(id: string): void {
    const set = this.#subs.get(id);
    if (!set) return;
    for (const sub of set) {
      if (sub.timer) clearTimeout(sub.timer);
      sub.send({ t: "gone", id });
    }
    this.#subs.delete(id);
  }

  #remove(id: string, sub: Sub): void {
    if (sub.timer) clearTimeout(sub.timer);
    const set = this.#subs.get(id);
    set?.delete(sub);
    if (set && !set.size) this.#subs.delete(id);
  }

  #schedule(sub: Sub, delay: number): void {
    if (delay <= 0) return this.#flush(sub);
    // A frame is already queued; it will read the session's current state when it fires.
    if (sub.timer) return;
    sub.timer = setTimeout(() => this.#flush(sub), delay);
  }

  #flush(sub: Sub): void {
    if (sub.timer) clearTimeout(sub.timer);
    sub.timer = undefined;
    const { session } = sub;
    const events = session.events;
    let ok: boolean;
    if (sub.resync || events !== sub.ref || events.length < sub.sent) {
      ok = sub.send({ t: "snapshot", id: session.id, session: toWire(session) });
    } else {
      ok = sub.send({
        t: "delta",
        id: session.id,
        from: sub.sent,
        events: events.slice(sub.sent),
        meta: summarize(session),
        partial: session.partial ?? null,
      });
    }
    if (!ok) {
      // A delta the socket dropped would leave a hole in the client's transcript:
      // never send another delta on top of it, resnapshot instead.
      sub.resync = true;
      sub.timer = setTimeout(() => this.#flush(sub), 250);
      return;
    }
    sub.resync = false;
    sub.ref = events;
    sub.sent = events.length;
  }
}

/**
 * Cross-site WebSocket hijacking guard. A browser always sends `Origin` on a
 * WebSocket handshake, and a page on another site cannot forge it, so it must
 * name this same host. Loopback pairs are allowed for the Vite dev proxy,
 * which rewrites `Host` but not `Origin`.
 */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true; // not a browser (curl, tests): nothing to hijack
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = [headers.get("host"), headers.get("x-forwarded-host")].filter(Boolean) as string[];
  if (allowed.includes(host)) return true;
  const loopback = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h);
  return loopback(host) && allowed.some(loopback);
}
