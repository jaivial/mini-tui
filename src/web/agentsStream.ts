/**
 * The live agents stream, with ONE poller per session instead of one per open stream. The
 * deployed handler gave every `/agents/stream` its own `setInterval(push, 2000)`, so N tabs on
 * the same tree rebuilt and serialized the same 34 kB view N times every 2 s — and every rebuild
 * was thrown away unless it differed from that one stream's last (measured on the deployed
 * surface: 3 streams = 3 rebuilds per tick on one quiet tree). Here the tick is shared and the
 * payload comes from `AgentsViewCache` (a few `stat`s while nothing moves), each subscriber is
 * diffed against what IT last received (a stream that connects mid-quiet still gets the current
 * payload at once), and the timer dies with the last subscriber.
 */

export interface AgentsStreamHubDeps {
  /** The session's current payload. Cheap while the inputs have not moved (fingerprint-gated). */
  payload(id: string): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Tick period, ms (the deployed per-stream interval was 2 000). */
  everyMs?: number;
}

interface Sub {
  send: (payload: string) => void;
  sent: string;
}

export class AgentsStreamHub {
  readonly #deps: AgentsStreamHubDeps;
  readonly #everyMs: number;
  readonly #streams = new Map<string, { subs: Set<Sub>; timer: unknown }>();
  /** Honest counters for the tests: ticks shared per session, pushes only on change. */
  readonly stats = { ticks: 0, pushes: 0 };

  constructor(deps: AgentsStreamHubDeps) {
    this.#deps = deps;
    this.#everyMs = Math.max(1, deps.everyMs ?? 2000);
  }

  /** Sessions with at least one open stream (a probe or a test can see the poller set). */
  get sessions(): string[] {
    return [...this.#streams.keys()];
  }

  /**
   * Watch a session. The subscriber gets the current payload immediately (the deployed handler
   * pushed on connect), then only what differs from what it last saw. The returned function stops
   * the watch; the last one out turns the poller off.
   */
  subscribe(id: string, send: (payload: string) => void): () => void {
    let entry = this.#streams.get(id);
    if (!entry) {
      entry = { subs: new Set(), timer: null };
      this.#streams.set(id, entry);
    }
    const sub: Sub = { send, sent: "" };
    entry.subs.add(sub);
    // A send that throws is a dead controller (the client went away between frames): drop the
    // subscriber here too — an uncaught throw in `start()` would kill the whole request.
    this.#deliver(id, entry, sub);
    // (The first frame can kill this very subscriber: arm only if the entry still stands.)
    const current = this.#streams.get(id);
    if (current && current.timer === null) {
      current.timer = this.#deps.setTimer(() => this.#tick(id), this.#everyMs);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#streams.get(id);
      if (!current) return;
      current.subs.delete(sub);
      if (current.subs.size) return;
      this.#deps.clearTimer(current.timer);
      this.#streams.delete(id);
    };
  }

  #tick(id: string): void {
    const entry = this.#streams.get(id);
    if (!entry) return;
    this.stats.ticks++;
    entry.timer = this.#deps.setTimer(() => this.#tick(id), this.#everyMs);
    let payload: string;
    try {
      payload = this.#deps.payload(id);
    } catch {
      // A tree that cannot be read right now keeps the last good push (the client's own rule).
      return;
    }
    for (const sub of [...entry.subs]) this.#deliver(id, entry, sub, payload);
  }

  #deliver(id: string, entry: { subs: Set<Sub>; timer: unknown }, sub: Sub, payload?: string): void {
    let frame: string;
    try {
      frame = payload ?? this.#deps.payload(id);
    } catch {
      return;
    }
    if (sub.sent === frame) return;
    try {
      sub.send(frame);
      sub.sent = frame;
      this.stats.pushes++;
    } catch {
      // Dead controller: the subscriber is dropped, the poller goes on for the others.
      entry.subs.delete(sub);
      if (!entry.subs.size) {
        this.#deps.clearTimer(entry.timer);
        this.#streams.delete(id);
      }
    }
  }
}
