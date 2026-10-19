/**
 * The one reconnect policy, shared by every client that has to come back from a dead connection:
 * the per-session socket, the tab's hub socket, and the two SSE streams.
 *
 * The rule the copies used to disagree on (measured, E50): **a connection that OPENED is not proof
 * of life**. A server that accepts a handshake and drops it would reset the delay on every attempt,
 * so a sick server got hammered (33 attempts in 3 s from the hub copy, vs 6 with growing gaps of
 * 85 → 1315 ms from the copy that had the rule). Proof of life is therefore not something a client
 * can forget to check at `onopen`, because there is no API that resets from there: it is either a
 * message the app recognised as real (`delivered()`) or a connection that stayed up long enough to
 * have been working (`closing()`).
 *
 * The delay is jittered so tabs and sessions do not retry in lockstep (the SSE copy had no jitter
 * at all). Plain TypeScript, injectable clock noise, testable outside Svelte.
 */
export interface ReconnectOptions {
  /** First retry's ceiling, ms. */
  baseDelay?: number;
  /** The ceiling never grows past this, ms. */
  maxDelay?: number;
  /** A connection that lived at least this long was working: its close is not a failure. */
  stableMs?: number;
  /** Clock noise in [0, 1); injectable so tests are exact. */
  random?: () => number;
}

export class Reconnect {
  #attempts = 0;
  readonly #base: number;
  readonly #max: number;
  readonly #stable: number;
  readonly #random: () => number;

  constructor(options: ReconnectOptions = {}) {
    this.#base = Math.max(1, options.baseDelay ?? 500);
    this.#max = Math.max(this.#base, options.maxDelay ?? 15_000);
    this.#stable = Math.max(0, options.stableMs ?? this.#max);
    this.#random = options.random ?? Math.random;
  }

  /** Failures in a row. Not reset by a connection merely being accepted. */
  get attempts(): number {
    return this.#attempts;
  }

  /**
   * This attempt failed: when to try again, in ms (jittered exponential backoff, capped). The only
   * call that counts a failure — and the only way to get a delay, so a client cannot schedule a
   * retry without also counting it.
   */
  nextDelay(): number {
    this.#attempts++;
    const cap = Math.min(this.#max, this.#base * 2 ** (this.#attempts - 1));
    return Math.round(cap * (0.5 + this.#random() * 0.5));
  }

  /** The connection delivered something real: it works, so the next failure starts over. */
  delivered(): void {
    this.#attempts = 0;
  }

  /**
   * A connection is being replaced after living `ms`. One that stayed up was working even if it
   * never said anything (an SSE stream with nothing to announce must not accumulate backoff over
   * quiet hours), so a long life is proof too.
   */
  closing(ms: number): void {
    if (ms >= this.#stable) this.#attempts = 0;
  }
}
