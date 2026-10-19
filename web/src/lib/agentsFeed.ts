/**
 * One session's live agents view for a watcher: the SSE stream while it works, a paced bridge
 * while it does not. This was the THIRD copy of "poll the agents tree" (the sidebar's loop fixed
 * two of them, E54) and the copy that still carried every rule that one had learned:
 *
 *   - **one drop downgraded the watcher for ever.** The deployed panel closed the EventSource on
 *     its first error and polled at 1.5 s / 4 s until the session closed — measured: 0 further
 *     stream attempts after the first drop (a server restart or one lost packet became permanent),
 *     and each of those polls pulled the full 34 kB view for the rest of the session.
 *   - **a hidden tab polled for ever** (4 s), while the clock and the sidebar suspend (E53/E54).
 *   - **its poll had no deadline**: one read that never answered stopped the chain (`poll()` was
 *     re-armed only after the await), and the tree changing on disk never reached the screen — the
 *     sidebar's measured defect, in its third copy.
 *
 * So the bridge IS `AgentTreePoll` (the sidebar's own loop: pace measured from the tick's start,
 * one read in flight per session, its own deadline, hidden tabs suspended and resynced on sight),
 * and the stream comes back through the shared `Reconnect` policy (E50 — a connection that merely
 * opened is not proof of life). One loop, one policy, no third copy.
 */
import { api } from "./api";
import { AgentTreePoll } from "./agentTreePoll";
import { Reconnect, type ReconnectOptions } from "./reconnect";

export interface StreamHandlers {
  /** The connection was accepted. Not proof of life (E50): only a delivered view is. */
  onOpen(): void;
  onMessage(view: unknown): void;
  /** The stream is gone (dropped or refused). The feed closes it and comes back later. */
  onDown(): void;
}

/** Open a session's live stream; the returned function closes it (idempotent). */
export type OpenStream = (id: string, handlers: StreamHandlers) => () => void;

/** The browser's own EventSource, the default stream for `AgentsFeed`. */
export const openEventSourceStream: OpenStream = (id, handlers) => {
  const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/agents/stream`);
  let closed = false;
  const close = () => {
    closed = true;
    es.close();
  };
  es.onopen = () => {
    if (!closed) handlers.onOpen();
  };
  es.onmessage = (m) => {
    if (closed) return;
    try {
      handlers.onMessage(JSON.parse(m.data));
    } catch {
      // A partial frame is not a verdict: keep the last good view and wait for the next one.
    }
  };
  es.onerror = () => {
    if (closed) return;
    close();
    handlers.onDown();
  };
  return close;
};

export interface AgentsFeedDeps {
  /** Read one session's view. Aborted when the bridge drops or outlives its deadline. */
  fetchView?(id: string, signal: AbortSignal): Promise<unknown>;
  openStream?: OpenStream;
  /** The view that landed (stream or bridge). */
  apply(view: unknown): void;
  /** What a failed bridge read means for the banner ("" when a read lands). */
  onError?(message: string): void;
  /** Is any agent working right now? — the bridge's pace hint (the sidebar's vocabulary). */
  hasLive?(): boolean;
  hidden?(): boolean;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  reconnect?: ReconnectOptions;
}

export class AgentsFeed {
  readonly #deps: AgentsFeedDeps;
  readonly #r: Reconnect;
  readonly #poll: AgentTreePoll;
  #id: string | null = null;
  #closeStream: (() => void) | null = null;
  #retry: unknown = null;
  #openedAt = 0;
  #streamDown = true;
  #stopped = true;

  constructor(deps: AgentsFeedDeps) {
    this.#deps = deps;
    this.#r = new Reconnect({ baseDelay: 1_000, maxDelay: 15_000, ...deps.reconnect });
    this.#poll = new AgentTreePoll({
      read: async (id, signal) => {
        try {
          const view = await (deps.fetchView ?? ((sid, sig) => api.agents(sid, { signal: sig })))(id, signal);
          deps.onError?.("");
          return view;
        } catch (e) {
          deps.onError?.((e as Error).message);
          throw e;
        }
      },
      apply: (_id, view) => deps.apply(view),
      hasLive: () => deps.hasLive?.() ?? false,
      hidden: () => deps.hidden?.() ?? false,
      now: () => deps.now?.() ?? Date.now(),
      setTimer: (fn, ms) => (deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms),
      clearTimer: (h) => (deps.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h),
    });
  }

  /** Is the live stream working right now (the bridge is what runs when it is not)? */
  get live(): boolean {
    return !this.#streamDown;
  }

  /** The clock, injectable so tests are exact (the house rule: a module takes its time). */
  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  start(id: string): void {
    this.stop();
    this.#id = id;
    this.#stopped = false;
    this.#streamDown = true;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    this.#id = null;
    this.#closeStream?.();
    this.#closeStream = null;
    if (this.#retry !== null) {
      (this.#deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.#retry);
      this.#retry = null;
    }
    this.#poll.sync([]);
  }

  /**
   * Something outside changed that makes a fresh look worth having (the tab became seen). Never
   * fires while hidden: a tab that draws nothing must not be woken by its own poll (E53's R2 —
   * pinned in the sidebar loop and here).
   */
  resync(): void {
    if (this.#stopped || (this.#deps.hidden?.() ?? false)) return;
    this.#poll.resync();
    // A stream that is down is retried at once now: the backoff timed an outage, and the tab is
    // here to see the answer.
    if (this.#streamDown && this.#retry !== null) {
      (this.#deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.#retry);
      this.#retry = null;
      this.#open();
    }
  }

  #open(): void {
    if (this.#stopped || !this.#id) return;
    const id = this.#id;
    this.#closeStream?.();
    this.#openedAt = this.#now();
    this.#closeStream = (this.#deps.openStream ?? openEventSourceStream)(id, {
      onOpen: () => {
        if (!this.#stopped) this.#openedAt = this.#now();
      },
      onMessage: (view) => {
        if (this.#stopped) return;
        // The first real frame is the snapshot the server pushes on connect: proof of life.
        this.#r.delivered();
        this.#streamDown = false;
        this.#retryLater(null);
        this.#poll.sync([]); // the bridge stands down: the stream is what the watcher watches
        this.#deps.onError?.("");
        this.#deps.apply(view);
      },
      onDown: () => {
        if (this.#stopped) return;
        this.#closeStream?.();
        this.#closeStream = null;
        // A stream that stayed up was working even if it announced nothing (its answer is only
        // "something changed"): a long life is proof too (the shared policy's own rule).
        if (this.#openedAt) this.#r.closing(this.#now() - this.#openedAt);
        this.#streamDown = true;
        this.#poll.sync([id]); // the bridge covers the gap, on the sidebar's loop and rules
        this.#retryLater(this.#r.nextDelay());
      },
    });
  }

  #retryLater(delay: number | null): void {
    const clear = this.#deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.#retry !== null) {
      clear(this.#retry);
      this.#retry = null;
    }
    if (delay === null || this.#stopped) return;
    const set = this.#deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#retry = set(() => {
      this.#retry = null;
      this.#open();
    }, delay);
  }
}
