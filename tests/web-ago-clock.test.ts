/**
 * The app's on-screen clock (E53): every "how long ago" is a claim about the clock, and these are
 * the rules that keep the claims true —
 *
 *   1. the words of every vocabulary, pinned (they are the contract with the reader);
 *   2. `nextChangeAt` agrees with those words: the words are constant until it says, and different
 *      after (a scheduler that sleeps through a change — or polls a string that cannot change —
 *      is exactly the bug this replaced: a panel ticking every 15 s while the line it drew was
 *      up to 15 s stale, and sidebar labels frozen at render);
 *   3. `AgeClock` wakes one display exactly at its moment, keeps ONE timer for all of them, and
 *      keeps none when nothing is on screen;
 *   4. `now` is SERVER time, learned from the server's `Date` header, so a device with a wrong
 *      clock cannot print a wrong age (measured: a browser 10 min ahead said "Saved 10m ago" one
 *      second after saving);
 *   5. the copies stay gone (source guard): no component may keep a clock of its own, and the
 *      words may not be re-spelled anywhere else.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AgeId, ageSeconds, ageWords, nextChangeAt, nextMidnight, nextSecond } from "../web/src/lib/ago";
import { AgeClock } from "../web/src/lib/clock";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STYLES: AgeId[] = ["relative", "saved", "elapsed", "compact", "when"];
const words = (id: AgeId, ageMs: number, ts = 0) => ageWords(id, Math.floor(ageMs / 1000), ts);

describe("the words of every vocabulary (the contract)", () => {
  test("relative: the sidebar's coarse age", () => {
    expect(words("relative", 0)).toBe("just now");
    expect(words("relative", 59_999)).toBe("just now");
    expect(words("relative", MINUTE)).toBe("1m ago");
    expect(words("relative", 2 * MINUTE - 1)).toBe("1m ago");
    expect(words("relative", 2 * MINUTE)).toBe("2m ago");
    expect(words("relative", HOUR - 1)).toBe("59m ago");
    expect(words("relative", HOUR)).toBe("1h ago");
    expect(words("relative", DAY - 1)).toBe("23h ago");
    expect(words("relative", DAY)).toBe("1d ago");
    expect(words("relative", 3 * DAY + 5 * HOUR)).toBe("3d ago");
  });

  test("saved: the notes line names the seconds, then the minutes, then stops claiming", () => {
    expect(words("saved", 0)).toBe("Saved");
    expect(words("saved", 4999)).toBe("Saved");
    expect(words("saved", 5000)).toBe("Saved 5s ago");
    expect(words("saved", 59_000)).toBe("Saved 59s ago");
    expect(words("saved", MINUTE)).toBe("Saved 1m ago");
    // Minutes are floors: 90 s is "1m ago", never the rounded-up "2m ago" the old copy printed.
    expect(words("saved", 90_000)).toBe("Saved 1m ago");
    expect(words("saved", HOUR - 1)).toBe("Saved 59m ago");
    // Older than an hour the line says "Saved" and never changes again: it names no age it could
    // get wrong, and the clock must not wake it (pinned below).
    expect(words("saved", HOUR)).toBe("Saved");
    expect(words("saved", 10 * DAY)).toBe("Saved");
  });

  test("elapsed: the running turn's counter", () => {
    expect(words("elapsed", 5000)).toBe("5s");
    expect(words("elapsed", 59_000)).toBe("59s");
    expect(words("elapsed", MINUTE)).toBe("1m 0s");
    expect(words("elapsed", 90_000)).toBe("1m 30s");
    expect(words("elapsed", HOUR - 1000)).toBe("59m 59s");
    expect(words("elapsed", HOUR)).toBe("1h 0m");
    expect(words("elapsed", 3 * HOUR + 25 * MINUTE)).toBe("3h 25m");
  });

  test("compact: the agents panel's activity age", () => {
    expect(words("compact", 5000)).toBe("5s ago");
    expect(words("compact", 59_000)).toBe("59s ago");
    expect(words("compact", MINUTE)).toBe("1m ago");
    expect(words("compact", HOUR)).toBe("1h ago");
  });

  test("when: the usage panel's 'hace …' (and its date at a day old)", () => {
    expect(words("when", 5000)).toBe("hace un momento");
    expect(words("when", 59_000)).toBe("hace un momento");
    expect(words("when", 2 * MINUTE)).toBe("hace 2 min");
    expect(words("when", 3 * HOUR)).toBe("hace 3 h");
    const at = Date.UTC(2026, 9, 19, 12, 0, 0);
    expect(words("when", 2 * DAY, at)).toBe(new Date(at).toLocaleDateString());
  });

  test("a timestamp in the future (a clock that moved) is 'now', never a negative age", () => {
    for (const id of STYLES) {
      expect(ageSeconds(2000, 1000)).toBe(0);
      expect(words(id, 0)).toBe(words(id, 0));
    }
    expect(ageSeconds(1000, 5000)).toBe(4);
  });
});

describe("the wake-ups agree with the words", () => {
  // The property that makes polling unnecessary: until `nextChangeAt` the words cannot move, and at
  // it they must. Sampled across the boundaries of every vocabulary.
  const AGES = [0, 1, 4999, 5000, 5500, 59_000, 59_500, 60_000, 61_000, 89_999, 90_000, 3599_000, 3_599_999, 3_600_000, 7_200_000, 86_399_000, 86_400_000, 3 * DAY];

  test("words are constant until nextChangeAt, and different at it", () => {
    for (const id of STYLES) {
      for (const age of AGES) {
        const ts = 1_000_000_000_000;
        const now = ts + age;
        const nowWords = words(id, age, ts);
        const next = nextChangeAt(id, ts, now);
        if (next === null) continue;
        expect(next).toBeGreaterThan(now);
        expect({ id, age, words: words(id, next - 1 - ts, ts) }).toEqual({ id, age, words: nowWords });
        expect({ id, age, words: words(id, next - ts, ts) }).not.toEqual({ id, age, words: nowWords });
      }
    }
  });

  test("a display whose words cannot change again is never woken", () => {
    const ts = 1_000_000_000_000;
    expect(nextChangeAt("saved", ts, ts + HOUR)).toBeNull();
    expect(nextChangeAt("saved", ts, ts + 10 * DAY)).toBeNull();
    // `when`'s oldest bucket prints the moment's own date: a string that never moves.
    expect(nextChangeAt("when", ts, ts + 2 * DAY)).toBeNull();
  });

  test("the first wake is exactly the boundary, not a poll", () => {
    const ts = 1_000_000_000_000;
    expect(nextChangeAt("saved", ts, ts)).toBe(ts + 5000); // "Saved" -> "Saved 5s ago"
    expect(nextChangeAt("saved", ts, ts + 20_000)).toBe(ts + 21_000); // the next second
    expect(nextChangeAt("relative", ts, ts + 30_000)).toBe(ts + 60_000); // "just now" -> "1m ago"
    expect(nextChangeAt("relative", ts, ts + 10 * MINUTE)).toBe(ts + 11 * MINUTE);
    expect(nextChangeAt("elapsed", ts, ts + 90_000)).toBe(ts + 91_000); // "1m 30s" moves each second
  });

  test("countdowns register the second, and midnight is when 'Today' becomes 'Yesterday'", () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0, 0);
    expect(nextSecond(now)).toBe(now + 1000);
    expect(nextSecond(now + 1500)).toBe(now + 2000);
    expect(nextMidnight(now)).toBe(Date.UTC(2026, 9, 20, 0, 0, 0, 0));
  });
});

describe("one clock, one timer", () => {
  function fake() {
    let now = 1_000_000_000_000;
    let seq = 1;
    let armed = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock = new AgeClock({
      real: () => now,
      setTimer: (fn, ms) => {
        const id = seq++;
        timers.set(id, { at: now + ms, fn });
        armed++;
        return id;
      },
      clearTimer: (h) => void timers.delete(h as number),
    });
    return {
      clock,
      timers,
      armed: () => armed,
      at: () => now,
      advance(ms: number) {
        now += ms;
        for (const [id, t] of [...timers]) {
          if (t.at <= now) {
            timers.delete(id);
            t.fn();
          }
        }
      },
    };
  }

  test("it wakes at the boundary and re-arms at the next one", () => {
    const f = fake();
    const seen: number[] = [];
    f.clock.onChange((t) => seen.push(t));
    const ts = f.at() - 4000; // 4 s old: "Saved" until 5 s
    f.clock.watchAge("saved", ts);
    expect(f.timers.size).toBe(1);
    f.advance(999);
    expect(seen).toEqual([]);
    f.advance(1);
    expect(seen).toEqual([f.at()]); // exactly at 5 s
    expect(f.timers.size).toBe(1); // re-armed
    f.advance(999);
    expect(seen).toEqual([f.at() - 999]);
    f.advance(1);
    expect(seen.length).toBe(2); // the next second
  });

  test("one timer for many displays: the earliest moment wins", () => {
    const f = fake();
    const ts = f.at();
    f.clock.watchAge("relative", ts); // moves in 60 s
    f.clock.watchAge("saved", ts - 30_000); // moves in 30 s ("Saved 30s ago" -> 31s)
    f.clock.watchAge("elapsed", ts - 5 * MINUTE); // moves every second
    expect(f.timers.size).toBe(1); // never one timer per display
    expect(Math.min(...[...f.timers.values()].map((t) => t.at - f.at()))).toBe(1000);
  });

  test("nothing on screen, nothing ticking", () => {
    const f = fake();
    expect(f.timers.size).toBe(0);
    const off = f.clock.watchAge("saved", f.at());
    expect(f.timers.size).toBe(1);
    off();
    expect(f.timers.size).toBe(0);
    expect(f.armed()).toBe(1); // armed once and taken down: no loop left behind
  });

  test("a hidden tab stops waking (and says where it left off when it comes back)", () => {
    const f = fake();
    const seen: number[] = [];
    f.clock.onChange((t) => seen.push(t));
    f.clock.watchAge("saved", f.at() - 4000);
    f.clock.suspend();
    expect(f.timers.size).toBe(0);
    f.advance(30_000);
    expect(seen).toEqual([]); // nothing drawn, nothing woken
    f.clock.resync();
    expect(seen).toEqual([f.at()]); // everyone told at once, on the way back
    expect(f.timers.size).toBe(1);
  });

  test("learning the server's time does not wake a hidden tab back up (review R2)", () => {
    const f = fake();
    const seen: number[] = [];
    f.clock.onChange((t) => seen.push(t));
    f.clock.watchAge("saved", f.at() - 4000);
    f.clock.suspend();
    f.clock.learnServerTime(f.at() + 5 * MINUTE);
    expect(f.timers.size).toBe(0); // still asleep: only the numbers it would show moved
    const after = seen.length;
    f.advance(60_000);
    expect(seen.length).toBe(after);
    f.clock.resync();
    expect(f.timers.size).toBe(1); // and it comes back when the tab does
  });

  test("a display whose words never change again leaves no timer", () => {
    const f = fake();
    f.clock.watchAge("saved", f.at() - HOUR);
    expect(f.timers.size).toBe(0);
  });

  test("the clock is the server's: a wrong device clock cannot print a wrong age", () => {
    const f = fake();
    const device = f.at();
    const ts = device + 10 * MINUTE; // the SERVER's stamp of a save that just landed (device 10 min behind)
    f.clock.learnServerTime(ts);
    expect(f.clock.now()).toBe(ts);
    expect(ageSeconds(ts, f.clock.now())).toBe(0); // "Saved", not "Saved 10m ago"
    // The `Date` header has one-second resolution: jitter must not make every age flap.
    f.clock.learnServerTime(ts + 1500);
    expect(f.clock.now()).toBe(ts);
    // A real step of the device's own clock is adopted at once.
    f.clock.learnServerTime(device + 20 * MINUTE);
    expect(f.clock.now()).toBe(device + 20 * MINUTE);
    // Non-samples (a header that failed to parse) change nothing.
    f.clock.learnServerTime(NaN);
    expect(f.clock.now()).toBe(device + 20 * MINUTE);
  });
});

describe("the copies stay gone (source guard)", () => {
  const web = join(import.meta.dir, "..", "web", "src");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : statSync(join(dir, e.name)).isFile() ? [join(dir, e.name)] : []));
  const rel = (p: string) => p.split("/web/src/lib/")[1] ?? p.split("/web/src/")[1];
  const files = walk(web).filter((f) => /\.(ts|svelte)$/.test(f));
  /** Guards read CODE: prose about the old bug must not count as a copy of it. */
  const code = (f: string) =>
    readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

  test("no component keeps a clock of its own", () => {
    // `Date.now()` in a component means a display that reads the device clock and freezes there
    // (or lies under skew). One exception, an identifier, not a clock.
    const allowed = new Set(["components/RemoteHostsModal.svelte"]); // an identifier, not a clock
    const offenders = files.filter((f) => rel(f).startsWith("components/") && code(f).includes("Date.now(") && !allowed.has(rel(f)));
    expect(offenders.map(rel).sort()).toEqual([]);
  });

  test("the intervals that remain are only data polling and socket heartbeats", () => {
    const withInterval = files.filter((f) => code(f).includes("setInterval(")).map(rel).sort();
    expect(withInterval).toEqual([
      "components/ChannelsSection.svelte",
      "components/KanbanSection.svelte",
      "components/UsageSection.svelte",
      "components/WhatsAppConnect.svelte",
      "hub.ts",
      "session-socket.ts",
    ]);
  });

  test("the age words are spelled in one file only", () => {
    // The unit forms ("3m ago") are the vocabulary; a sentence that merely ends in "ago" (the
    // queue's "lease expired … ago") is prose and stays where it is.
    const probes = ["just now", "s ago`", "m ago`", "h ago`", "d ago`", "Saved ${", "hace ${", "hace un momento"];
    const offenders = files.filter((f) => rel(f) !== "ago.ts" && probes.some((p) => code(f).includes(p)));
    expect(offenders.map(rel).sort()).toEqual([]);
  });

  test("the formatters take the clock, they do not find one", () => {
    for (const f of ["format.ts", "notes.ts", "usageClient.ts", "resume.ts"]) {
      expect({ f, has: code(join(web, "lib", f)).includes("Date.now(") }).toEqual({ f, has: false });
    }
  });
});
