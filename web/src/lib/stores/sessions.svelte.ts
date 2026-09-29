/**
 * Session state for the whole app.
 *
 * Two channels, on purpose:
 *  - one shared SSE stream carries only the light metadata every session's sidebar row needs
 *    (title, status, cost), so a busy transcript never costs the idle ones anything;
 *  - one WebSocket per session carries that session's transcript (snapshot, then deltas).
 *
 * A socket is held for the active session and for every running one, so switching to a session
 * that has been working in the background shows a transcript that is already current.
 */
import { api } from "../api";
import { SessionSocket, type SocketState } from "../session-socket";
import type { Frame, RemoteHost, SessionMeta, SessionState, WireSession } from "../types";

export type Link = "idle" | "connecting" | "live" | "reconnecting" | "gone";

const emptyTranscript = { events: [] as SessionState["events"], messages: [] as SessionState["messages"], partial: undefined };

class SessionStore {
  sessions = $state<Record<string, SessionState>>({});
  hosts = $state<RemoteHost[]>([]);
  activeId = $state<string | null>(null);
  /** The shared metadata stream. */
  connected = $state(false);
  error = $state<string | null>(null);
  /** Per-session socket state, so the UI can say "reconnecting" for the session you are looking at. */
  links = $state<Record<string, Link>>({});
  /** True until the first snapshot of a session has landed (drives its loading skeleton). */
  hydrated = $state<Record<string, boolean>>({});

  #source: EventSource | null = null;
  #retry = 0;
  #sockets = new Map<string, SessionSocket>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  get list(): SessionState[] {
    return Object.values(this.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get active(): SessionState | null {
    return this.activeId ? (this.sessions[this.activeId] ?? null) : null;
  }

  get open(): SessionState[] {
    return this.list.filter((s) => s.status === "running" || s.status === "idle");
  }

  /** Link state of the session being looked at. */
  get activeLink(): Link {
    return this.activeId ? (this.links[this.activeId] ?? "idle") : "idle";
  }

  async load() {
    const [sessions, hosts] = await Promise.all([api.sessions(), api.hosts()]);
    const map: Record<string, SessionState> = {};
    for (const meta of sessions) map[meta.id] = this.#merge(this.sessions[meta.id], meta);
    this.sessions = map;
    this.hosts = hosts;
    if (this.activeId && !map[this.activeId]) this.activeId = null;
    if (!this.activeId) this.activeId = sessions[0]?.id ?? null;
    this.#reconcile();
  }

  /** Metadata never carries a transcript, so it must not erase the one a socket delivered. */
  #merge(prev: SessionState | undefined, meta: SessionMeta): SessionState {
    return { ...emptyTranscript, ...(prev ? { events: prev.events, partial: prev.partial, messages: prev.messages } : {}), ...meta };
  }

  connect() {
    if (this.#source) return;
    const source = new EventSource("/api/stream");
    this.#source = source;

    source.onopen = () => {
      this.connected = true;
      this.#retry = 0;
      this.error = null;
    };
    source.onerror = () => {
      this.connected = false;
      // EventSource retries on its own, but not after the tab is closed;
      // back off so a dead server does not spin the network.
      source.close();
      this.#source = null;
      const delay = Math.min(1000 * 2 ** this.#retry++, 15000);
      setTimeout(() => this.connect(), delay);
    };
    source.onmessage = (message) => {
      let payload: { type: string; session?: SessionMeta; id?: string; hosts?: RemoteHost[] };
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      if (payload.type === "session" && payload.session) {
        this.sessions[payload.session.id] = this.#merge(this.sessions[payload.session.id], payload.session);
        this.#reconcileSoon();
      } else if (payload.type === "session-gone" && payload.id) {
        this.#drop(payload.id);
      } else if (payload.type === "hosts" && payload.hosts) {
        this.hosts = payload.hosts;
      }
    };
  }

  /** Adopt a session the UI just created or opened (its transcript is included). */
  adopt(session: WireSession) {
    this.sessions[session.id] = { messages: [], ...session };
    this.hydrated[session.id] = true;
    this.#reconcile();
  }

  setActive(id: string | null) {
    this.activeId = id;
    this.#reconcile();
  }

  /** Forget a session locally (the server side is closed by the caller). */
  remove(id: string) {
    this.#drop(id);
  }

  // ------------------------------------------------------------ per-session sockets

  #wanted(): Set<string> {
    const ids = new Set<string>();
    if (this.activeId && this.sessions[this.activeId]) ids.add(this.activeId);
    for (const s of Object.values(this.sessions)) if (s.status === "running") ids.add(s.id);
    return ids;
  }

  /** Metadata arrives in bursts while a run streams: settle sockets once per tick, not per event. */
  #reconcileSoon() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#reconcile();
    }, 0);
  }

  #reconcile() {
    const wanted = this.#wanted();
    for (const id of wanted) if (!this.#sockets.has(id)) this.#openSocket(id);
    for (const [id, socket] of this.#sockets) {
      if (wanted.has(id)) continue;
      socket.close();
      this.#sockets.delete(id);
      this.links[id] = "idle";
    }
  }

  #openSocket(id: string) {
    const socket = new SessionSocket(
      id,
      {
        frame: (frame) => this.#onFrame(frame),
        state: (state: SocketState) => {
          this.links[id] = state;
        },
      },
      {
        // Was a refused handshake a deleted session, or just a dead network?
        exists: async (sid) => {
          try {
            await api.session(sid);
            return true;
          } catch (error) {
            return /unknown session|404/i.test((error as Error).message) ? false : null;
          }
        },
      },
    );
    this.#sockets.set(id, socket);
    socket.open();
  }

  #onFrame(frame: Frame) {
    if (frame.t === "snapshot") {
      const prev = this.sessions[frame.id];
      this.sessions[frame.id] = { ...emptyTranscript, ...frame.session, messages: prev?.messages ?? [] };
      this.hydrated[frame.id] = true;
    } else if (frame.t === "delta") {
      const session = this.sessions[frame.id];
      if (!session) return;
      if (frame.from !== session.events.length) {
        // A frame we cannot place: never guess, ask for the whole transcript again.
        this.#sockets.get(frame.id)?.resync();
        return;
      }
      if (frame.events.length) session.events.push(...frame.events);
      session.partial = frame.partial ?? undefined;
      Object.assign(session, frame.meta);
    } else if (frame.t === "gone") {
      this.#drop(frame.id);
    }
  }

  #drop(id: string) {
    this.#sockets.get(id)?.close();
    this.#sockets.delete(id);
    delete this.sessions[id];
    delete this.links[id];
    delete this.hydrated[id];
    if (this.activeId === id) this.activeId = this.list[0]?.id ?? null;
    this.#reconcile();
  }

  close() {
    this.#source?.close();
    this.#source = null;
    for (const socket of this.#sockets.values()) socket.close();
    this.#sockets.clear();
  }
}

export const store = new SessionStore();
