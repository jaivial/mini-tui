/**
 * The one poll loop for the sidebar's agent trees, and the rules they used to disagree about
 * (measured, E54). The store wires it; the policy lives here, plain and injectable, so the bun
 * harness can drive the real loop instead of a hand-written model of it (E51's lesson).
 *
 * What the measurements said about a flat `sleep(pace)` after `await Promise.all(reads)`:
 *
 *   - **The period was `slowest read + pace`, not `pace`.** One sibling with an 8 s read stretched
 *     every session's updates to 11 s (measured). A clock that paces work has to measure the work
 *     it covers (E43): the next tick is scheduled at `tick start + pace`, and a read still in
 *     flight is skipped, never awaited — so one slow read cannot become everyone's period.
 *   - **A read that never answers silenced the whole sidebar for ever.** The loop awaited the
 *     slowest read before sleeping: with one hung read, the other sessions got **0 reads in 25 s**
 *     (measured) and their rows stayed frozen until a reload. Each read now carries its own
 *     deadline (abandoned and retried), and a hung one blocks only its own session.
 *   - **A hidden tab kept polling at 2x pace for ever** (12 reads in 25 s measured) while the clock
 *     (E53) suspends. Same rule as the clock: no reads while hidden, and becoming visible polls
 *     AT ONCE (measured: the deployed loop answered the next scheduled tick, 6 s later).
 *
 * One loop for the whole sidebar, however many sessions are open; at most one read in flight per
 * session (a slow one is skipped, never stacked).
 */
export interface AgentTreePollDeps {
  /** Read one session's tree. `signal` is aborted when the read is dropped or out of deadline. */
  read(id: string, signal: AbortSignal): Promise<unknown>;
  /** A read landed for a session still wanted: this is its new tree. */
  apply(id: string, view: unknown): void;
  /** Is any wanted session showing live work? (fast pace) / all quiet (slow pace). */
  hasLive(): boolean;
  /** Is the tab hidden? Hidden tabs do not poll and are not woken. */
  hidden(): boolean;
  /** The clock, injectable so tests are exact. */
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** How long a single read may take before it is abandoned and retried (default 10 s). */
  deadlineMs?: number;
}

/** Pace while a delegate is live / when everything is quiet (the sidebar's own vocabulary). */
export const PACE_LIVE_MS = 3000;
export const PACE_QUIET_MS = 5000;

export class AgentTreePoll {
  readonly #deps: AgentTreePollDeps;
  readonly #deadlineMs: number;
  #wanted: string[] = [];
  readonly #inflight = new Map<string, AbortController>();
  #timer: unknown = null;

  constructor(deps: AgentTreePollDeps) {
    this.#deps = deps;
    this.#deadlineMs = Math.max(1, deps.deadlineMs ?? 10_000);
  }

  /** The sessions being polled (the store's pace hint reads this). */
  get wanted(): readonly string[] {
    return this.#wanted;
  }

  /**
   * Track the sessions the sidebar shows; dropped ones stop being polled (and abort mid-read).
   * Who is polled is this call's; WHEN is the loop's alone — a set that changes does not reset the
   * cadence (the sidebar's effect re-runs on every list churn). A newly shown session gets its
   * first read at once, so its rows fill instead of sitting empty until the next tick.
   */
  sync(ids: string[]): void {
    const next = [...new Set(ids)].sort();
    const old = this.#wanted;
    if (old.length === next.length && old.every((id, i) => id === next[i])) return;
    this.#wanted = next;
    for (const id of old) {
      if (!next.includes(id)) {
        // Stop the read too: a dropped session's answer is discarded anyway, so its bytes and its
        // slot are both freed. The last good tree it showed STAYS (a filtered sidebar must not
        // flash empty when the filter clears).
        this.#inflight.get(id)?.abort();
        this.#inflight.delete(id);
      }
    }
    if (!this.#deps.hidden()) {
      for (const id of next) if (!old.includes(id)) this.#read(id);
      // Arm only when the loop is not already running (first set, or a set that arrived while
      // the loop slept): a change must not reset a cadence already underway.
      if (next.length && this.#timer === null) this.#arm(this.#deps.hasLive() ? PACE_LIVE_MS : PACE_QUIET_MS);
    }
  }

  /**
   * Something outside changed that makes a fresh read worth having (the tab became visible).
   * Never fires while hidden: a tab that draws nothing must not be woken by its own poll (E53's
   * R2, pinned here too).
   */
  resync(): void {
    if (!this.#wanted.length || this.#deps.hidden()) return;
    this.#arm(0);
  }

  #arm(ms: number): void {
    if (this.#timer !== null) this.#deps.clearTimer(this.#timer);
    this.#timer = this.#deps.setTimer(() => {
      this.#timer = null;
      this.#tick();
    }, Math.max(0, ms));
  }

  /** One session's read, with its own deadline. At most one in flight per session. */
  #read(id: string): void {
    if (this.#inflight.has(id)) return; // a slow one is skipped, never stacked
    const ac = new AbortController();
    this.#inflight.set(id, ac);
    const deadline = this.#deps.setTimer(() => ac.abort(), this.#deadlineMs);
    const done = () => {
      this.#deps.clearTimer(deadline);
      if (this.#inflight.get(id) === ac) this.#inflight.delete(id);
    };
    // A read that THROWS synchronously is a crash in a timer callback nobody watches (E49: an
    // unhandled rejection is a crash): the same "keep the last good tree" verdict either way.
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(this.#deps.read(id, ac.signal));
    } catch {
      done();
      return;
    }
    started.then(
      (view) => {
        // A session that closed mid-read: drop the answer rather than remember a ghost.
        if (this.#wanted.includes(id)) this.#deps.apply(id, view);
      },
      () => {
        // Deadline, network error or dropped: the last good tree stays and the next tick retries.
        // A failed poll is not a verdict about the tree (E51/E52).
      },
    ).then(done, done);
  }

  #tick(): void {
    if (!this.#wanted.length) return;
    // Suspended until the tab is seen again; `resync()` re-arms it the moment it is.
    if (this.#deps.hidden()) return;
    const start = this.#deps.now();
    for (const id of this.#wanted) this.#read(id);
    const pace = this.#deps.hasLive() ? PACE_LIVE_MS : PACE_QUIET_MS;
    // The pace measures the WORK it covers: the next read starts `pace` after this tick started,
    // whatever the reads took. A flat sleep-after-completion made the period `slowest + pace`.
    this.#arm(Math.max(0, start + pace - this.#deps.now()));
  }
}
