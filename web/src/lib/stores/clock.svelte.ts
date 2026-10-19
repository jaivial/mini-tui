/**
 * The shared clock in reactive form (E53): `now` is server time and moves exactly when some age on
 * screen can change its words. The logic lives in `lib/clock.ts` (plain, tested); this file is the
 * thin runes wiring, the only one, so no component can grow a private `setInterval` again.
 */
import { type AgeId } from "../ago";
import { ageClock } from "../clock";

class ClockStore {
  now = $state(ageClock.now());

  constructor() {
    ageClock.onChange((t) => (this.now = t));
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) ageClock.suspend();
        else ageClock.resync();
      });
    }
  }

  /** A timestamp shown in one vocabulary: it wakes exactly when its words can change. */
  watchAge(id: AgeId, ts: number): () => void {
    return ageClock.watchAge(id, ts);
  }

  /** A display with its own moment rule (the Resume list's day buckets: local midnight). */
  watch(wake: (now: number) => number | null): () => void {
    return ageClock.watch(wake);
  }
}

export const clock = new ClockStore();
