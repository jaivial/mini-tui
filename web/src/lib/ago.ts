/**
 * Every "how long ago" on screen, in one place (E53).
 *
 * Before this module the same question — *how long ago was this?* — had six copies across the
 * client: `format.relativeTime`, the notes panel's "Saved …" line, `format.duration` on the running
 * turn's counter, `AgentsPanel`'s own `ago()`, `usageClient.formatWhen`, and the Resume list's day
 * buckets. Each had its own arithmetic and its own idea of when to ask again: one polled every
 * 15 s (and understated the age by up to 15 s), one never asked again at all (a label frozen at
 * render: "just now" still on screen 80 s later), one moved only when new data arrived. A label
 * like "3m ago" is a CLAIM about the clock, and a claim that stays on screen has to keep being
 * true.
 *
 * So this module owns three things and nothing else does: the arithmetic, the words of every
 * vocabulary, and the **exact moment each vocabulary's words can change** (`nextChangeAt`) — which
 * is what lets `lib/clock.ts` wake a display exactly then and never poll. The vocabularies keep
 * their own words (the sidebar's coarse "3m ago" and the notes line's "Saved 3m ago" are different
 * sentences on purpose); what they may not have is their own clock maths.
 *
 * The timestamps on screen all come from the server. `AgeClock.now()` is *server* time (the
 * device's clock translated by the offset learned from the server's own `Date` header), so a
 * device with a wrong clock cannot turn into a wrong age — measured: a browser 10 min ahead said
 * "Saved 10m ago" one second after saving.
 */

export type AgeId = "relative" | "saved" | "elapsed" | "compact" | "when";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/**
 * When each vocabulary's words can change, in one table. `every` is the smallest step at which the
 * string moves inside that range ("just now" is constant for a whole minute; "Saved 5s ago" moves
 * every second); `until` is where the range ends. `Infinity` as `every` means the words never
 * change again — a display that says "Saved" for a save older than an hour has nothing left to
 * claim, and the clock will not wake it.
 */
type Step = { until: number; every: number };

const STEPS: Record<AgeId, Step[]> = {
  relative: [
    { until: MINUTE, every: MINUTE },
    { until: HOUR, every: MINUTE },
    { until: DAY, every: HOUR },
    { until: Infinity, every: DAY },
  ],
  saved: [
    { until: 5 * SECOND, every: 5 * SECOND },
    { until: MINUTE, every: SECOND },
    { until: HOUR, every: MINUTE },
    { until: Infinity, every: Infinity },
  ],
  elapsed: [
    { until: MINUTE, every: SECOND },
    { until: HOUR, every: SECOND },
    { until: Infinity, every: MINUTE },
  ],
  compact: [
    { until: MINUTE, every: SECOND },
    { until: HOUR, every: MINUTE },
    { until: Infinity, every: HOUR },
  ],
  when: [
    { until: MINUTE, every: MINUTE },
    { until: HOUR, every: MINUTE },
    { until: DAY, every: HOUR },
    // The oldest bucket prints the DATE of the moment (`new Date(ts)`), a string that never moves:
    // the clock must not wake a display that cannot change (the day buckets of the Resume list are
    // a different question — those move at midnight and watch `nextMidnight` directly).
    { until: Infinity, every: Infinity },
  ],
};

/** How long ago `ts` was, in whole seconds. A time in the future (a clock that moved) is "now". */
export function ageSeconds(ts: number, now: number): number {
  return Math.floor(Math.max(0, now - ts) / SECOND);
}

/**
 * The words of each vocabulary for an age of `s` seconds. `ts` is only needed by `when`, whose
 * oldest bucket prints the date itself. The words are pinned by tests: they are the contract.
 */
export function ageWords(id: AgeId, s: number, ts = 0): string {
  switch (id) {
    case "relative":
      return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
    case "saved":
      return s < 5 ? "Saved" : s < 60 ? `Saved ${s}s ago` : s < 3600 ? `Saved ${Math.floor(s / 60)}m ago` : "Saved";
    case "elapsed":
      return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    case "compact":
      return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
    case "when":
      return s < 60 ? "hace un momento" : s < 3600 ? `hace ${Math.floor(s / 60)} min` : s < 86_400 ? `hace ${Math.floor(s / 3600)} h` : new Date(ts).toLocaleDateString();
  }
}

/**
 * The next whole second after `now` — what a countdown ("Caduca en 45 s", a lease that "renews for
 * 12s") registers so its number moves exactly with the second and never on a private interval.
 */
export function nextSecond(now: number): number {
  return Math.floor(now / SECOND) * SECOND + SECOND;
}

/** The next local midnight after `now` — when "Today" becomes "Yesterday" and a date string moves. */
export function nextMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * The moment (ms epoch) at which `ageWords(id, …)` can first say something different from what it
 * says now, or `null` when it never will. Derived from the same table as the words, so a
 * vocabulary cannot have words that move and a scheduler that sleeps through it (or the reverse:
 * a `setInterval` that re-renders a string that cannot change).
 */
export function nextChangeAt(id: AgeId, ts: number, now: number): number | null {
  const age = Math.max(0, now - ts);
  const step = STEPS[id].find((s) => age < s.until) ?? STEPS[id][STEPS[id].length - 1];
  if (!Number.isFinite(step.every)) return null;
  return ts + (Math.floor(age / step.every) + 1) * step.every;
}
