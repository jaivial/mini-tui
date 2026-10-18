/**
 * A small in-memory rate limiter for the expensive routes: an agent spawn
 * (POST /sessions), a model turn (…/prompt), a real provider key test
 * (providers/connect), an ssh probe (hosts/probe), a folder walk that can go
 * over ssh (/folders) and attachment uploads (disk + memory). Nothing here is
 * a security boundary by itself — the server is loopback and same-origin
 * gated — it stops one client (or a compromised page) from spinning spawns,
 * ssh dials and disk fills at wire speed.
 *
 * Fixed window per key: cheap, exact enough, and a burst just waits for the
 * next window. Keys come from the peer IP (`srv.requestIP`), so every browser
 * tab and every local tool shares one budget — deliberate: the budget exists
 * to protect the machine, not to ration users.
 */

export interface TakeResult {
  ok: boolean;
  /** Seconds until the oldest hit in the window leaves it (for Retry-After). */
  retryAfter: number;
}

export class RateLimiter {
  readonly max: number;
  readonly windowMs: number;
  #hits = new Map<string, number[]>();

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  take(key: string, now = Date.now()): TakeResult {
    const windowStart = now - this.windowMs;
    if (this.#hits.size > 1024) this.sweep(now);
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > windowStart);
    if (hits.length >= this.max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((hits[0]! - windowStart) / 1000)) };
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return { ok: true, retryAfter: 0 };
  }

  /**
   * Give one hit back.
   *
   * A token is taken BEFORE the work it protects (the body read, the model
   * turn), so a request that then turns out never to have happened has spent a
   * token on nothing: the client opened the connection and stopped. Measured
   * (E40): 20 half-open uploads, zero bytes of body between them, and a real
   * complete upload was refused 429 for the rest of the minute.
   *
   * The newest hit for the key is the one to drop — `take` appends, so that is
   * this request's own. An unknown or already-expired key is a no-op: there is
   * nothing of ours to give back.
   */
  give(key: string, now = Date.now()): void {
    const hits = this.#hits.get(key);
    if (!hits?.length) return;
    hits.pop();
    if (hits.length) this.#hits.set(key, hits);
    else this.#hits.delete(key);
  }

  /** Drop every key whose window has fully elapsed (bounded memory). */
  sweep(now = Date.now()): void {
    const windowStart = now - this.windowMs;
    for (const [key, hits] of this.#hits) {
      const live = hits.filter((t) => t > windowStart);
      if (live.length) this.#hits.set(key, live);
      else this.#hits.delete(key);
    }
  }

  get tracked(): number {
    return this.#hits.size;
  }
}
