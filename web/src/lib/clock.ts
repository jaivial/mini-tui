/**
 * The one clock behind every "how long ago" on screen (E53), and the reason none of them polls.
 *
 * A display registers the moment its words can change (`ago.nextChangeAt`); the clock keeps ONE
 * timer set to the earliest of those moments, wakes every display whose time came, and re-arms. So
 * the sidebar moves exactly at its minute boundary, the notes line exactly every second while it
 * names seconds, and **nothing ticks at all** when no age is on screen (the panel's old 15 s
 * `setInterval` ran forever, open or not).
 *
 * `now()` is SERVER time: the device clock translated by the offset learned from the `Date` header
 * of the server's own answers. Every timestamp the app shows comes from the server, so this is the
 * only subtraction that makes an age mean anything — a device 10 min ahead used to print
 * "Saved 10m ago" one second after saving (measured).
 */
import { type AgeId, nextChangeAt } from "./ago";

/** A registered display: given "now" (server time), the moment its words can change, or never. */
export type Wake = (now: number) => number | null;

type Timer = unknown;

export class AgeClock {
  #watchers = new Map<symbol, Wake>();
  #listeners = new Set<(now: number) => void>();
  #timer: Timer | undefined;
  #offset = 0;
  #offsetKnown = false;
  #suspended = false;
  #real: () => number;
  #setTimer: (fn: () => void, ms: number) => Timer;
  #clearTimer: (handle: Timer) => void;

  constructor(opts: { real?: () => number; setTimer?: (fn: () => void, ms: number) => Timer; clearTimer?: (handle: Timer) => void } = {}) {
    this.#real = opts.real ?? (() => Date.now());
    this.#setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as Timer);
    this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Server time: the device's clock translated into the clock every timestamp on screen lives in. */
  now(): number {
    return this.#real() + this.#offset;
  }

  /**
   * The server's own clock, from the `Date` header of an answer. Samples within 2 s of the running
   * offset are the header's one-second resolution and are dropped (they would make every age flap);
   * a real step of the device's clock is adopted at once.
   */
  learnServerTime(serverMs: number): void {
    if (!Number.isFinite(serverMs)) return;
    const off = serverMs - this.#real();
    if (this.#offsetKnown && Math.abs(off - this.#offset) <= 2000) return;
    this.#offset = off;
    this.#offsetKnown = true;
    // Not `resync()`: learning the time must not wake a HIDDEN tab back up (`#arm` stays asleep
    // while suspended — review R2).
    this.#emit();
    this.#arm();
  }

  /** Register a display. It is woken at its moment and again whenever that moment moves. */
  watch(wake: Wake): () => void {
    const key = Symbol();
    this.#watchers.set(key, wake);
    this.#arm();
    return () => {
      if (this.#watchers.delete(key)) this.#arm();
    };
  }

  /** Watch a timestamp in one vocabulary — the usual case. */
  watchAge(id: AgeId, ts: number): () => void {
    return this.watch((now) => nextChangeAt(id, ts, now));
  }

  /** Every rendered `now` follows this. */
  onChange(cb: (now: number) => void): () => void {
    this.#listeners.add(cb);
    return () => void this.#listeners.delete(cb);
  }

  /** The clock is back (the tab is visible again, or the device's own clock moved): tell everyone. */
  resync(): void {
    this.#suspended = false;
    this.#emit();
    this.#arm();
  }

  /** A hidden tab has nothing to draw: stop waking anything, keep the registrations. */
  suspend(): void {
    this.#suspended = true;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }

  #emit(): void {
    const now = this.now();
    for (const cb of [...this.#listeners]) cb(now);
  }

  #arm(): void {
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
    if (this.#suspended || !this.#watchers.size) return;
    const now = this.now();
    let next: number | null = null;
    for (const wake of this.#watchers.values()) {
      const at = wake(now);
      if (at !== null && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#emit();
      this.#arm();
    }, Math.max(0, next - now));
  }
}

/** The app's clock. One instance: two would be the bug all over again. */
export const ageClock = new AgeClock();
