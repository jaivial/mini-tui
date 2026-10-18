/**
 * The transcript's follow-the-stream rule, as it is actually written.
 *
 * WHAT WAS MEASURED, in Chrome 145 against the DEPLOYED build (`App-BaPuQIxY.js`), on a
 * 55-event session, with a real delta delivered by `POST /api/sessions/<id>/model`:
 *
 *   - a reader who scrolled to the top to read history (`scrollTop: 0`, jump button
 *     visible) was thrown to `scrollTop: 2027` = `scrollHeight - clientHeight` — the
 *     exact bottom — by ONE streamed event. Repeated at `scrollTop: 250`, same result.
 *   - instrumenting the `scrollTop` setter caught FOUR unguarded
 *     `scrollTop = scrollHeight` assignments per delta, all from `App-*.js`.
 *
 * So during a run — the only time the transcript grows — history was unreadable. And it
 * made the pane's own jump-to-latest button unreachable: `ChatPane` renders that button
 * only when `!atBottom`, and the pin set `atBottom` back to true through the scroll event
 * it triggered. The affordance and the rule contradicted each other, in the shipped build.
 *
 * The rule assertions cover the decision; the source assertions pin the WIRING, because a
 * correct `threadScroll.ts` that `ChatPane` does not call would pass every test above and
 * ship the same defect (the mistake E28's own test notes).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BOTTOM_SLOP_PX, followTranscript, isAtBottom, shouldFollowToBottom } from "../web/src/lib/threadScroll";

/** Comments stripped: matching raw text would test the prose, not the code. */
function read(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const pane = read("web", "src", "lib", "components", "ChatPane.svelte");
const geometry = (scrollTop: number, scrollHeight = 2865, clientHeight = 838) => ({ scrollHeight, scrollTop, clientHeight });

describe("is the reader at the bottom", () => {
  test("the last pixel counts as the bottom, and the slop is generous enough to be usable", () => {
    expect(isAtBottom(geometry(2027))).toBe(true);
    expect(isAtBottom(geometry(2865 - 838 - BOTTOM_SLOP_PX + 1))).toBe(true);
    expect(isAtBottom(geometry(2865 - 838 - BOTTOM_SLOP_PX - 1))).toBe(false);
  });

  test("a transcript shorter than the viewport is at the bottom (nothing to scroll)", () => {
    expect(isAtBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 838 })).toBe(true);
  });
});

describe("the rule that was missing", () => {
  test("a reader scrolled up is NOT dragged to the bottom by a growing transcript", () => {
    // The defect, as measured: atBottom false, and the pin did not care.
    expect(shouldFollowToBottom({ atBottom: false, sessionChanged: false, shrank: false })).toBe(false);
  });

  test("a reader at the bottom keeps following the stream", () => {
    expect(shouldFollowToBottom({ atBottom: true, sessionChanged: false, shrank: false })).toBe(true);
  });

  test("a different session opens at ITS end, wherever the previous one stood", () => {
    // Otherwise switching chats lands you in the middle of a transcript nobody chose.
    expect(shouldFollowToBottom({ atBottom: false, sessionChanged: true, shrank: false })).toBe(true);
  });

  test("a transcript that merely got SHORTER does not override the reader", () => {
    // It used to: `scrollHeight` is not monotonic (a pane passes through the 715 px skeleton and a
    // mid-flight 3076 px before settling), so "shorter than last time" fired on a transient reading
    // and pinned a reader at the top anyway — measured, the exact defect this rule removes.
    expect(shouldFollowToBottom({ atBottom: false, sessionChanged: false })).toBe(false);
  });
});

describe("one pass of the pin effect", () => {
  test("scrolled up + a delta => no follow, and the jump button stays offered", () => {
    const out = followTranscript(geometry(0), { atBottom: false, prevSession: "s1" }, "s1");
    expect(out.follow).toBe(false);
    expect(out.atBottom).toBe(false);
  });

  test("at the bottom + a delta => follow, and the button goes away", () => {
    const out = followTranscript(geometry(2027), { atBottom: true, prevSession: "s1" }, "s1");
    expect(out.follow).toBe(true);
    expect(out.atBottom).toBe(true);
  });

  test("the very first pass opens the transcript at its end", () => {
    // No reader has been here yet, so there is no position to respect. Without this a restored
    // session loaded showing its TOP with the jump button up, because the first real measurement is
    // taken while the rows are still being laid out. Measured on the build that had it wrong.
    const out = followTranscript(geometry(0, 2865, 838), { atBottom: false, prevSession: null }, "s1");
    expect(out.follow).toBe(true);
    expect(out.atBottom).toBe(true);
  });

  test("...but only the first: the next pass is judged on the reader again", () => {
    // The distinction that matters. Treating "not yet measured" as "at the bottom" forever would
    // reinstate the yank; treating it as a switch only on the first pass keeps both behaviours.
    // The caller's memory: `prevSession` is the id it last recorded, which the first pass SET.
    let prevSession: string | null = null;
    let atBottom = false;
    const first = followTranscript(geometry(0, 2865, 838), { atBottom, prevSession }, "s1");
    prevSession = "s1";
    atBottom = first.atBottom;
    expect(first.follow).toBe(true);
    // Second pass, reader scrolled up: judged on the reader, not on "we have measured before".
    const second = followTranscript(geometry(0, 2943, 838), { atBottom: isAtBottom(geometry(0, 2943, 838)), prevSession }, "s1");
    expect(second.follow).toBe(false);
  });

  test("...but a session the pane really did switch away from still pins", () => {
    // prevSession recorded, id different: that IS a switch.
    const out = followTranscript(geometry(0), { atBottom: false, prevSession: "s1" }, "s2");
    expect(out.follow).toBe(true);
  });

  test("an explicit switch wins even when nothing was recorded", () => {
    // The caller knows about switches that happened before the scroller bound; it says so.
    const out = followTranscript(geometry(0), { atBottom: false, prevSession: "s1" }, "s2", true);
    expect(out.follow).toBe(true);
  });

  test("an explicit 'not switched' wins over a stale recorded id", () => {
    const out = followTranscript(geometry(0), { atBottom: false, prevSession: "s1" }, "s1", false);
    expect(out.follow).toBe(false);
  });

  test("switching sessions mid-stream follows the new one", () => {
    const out = followTranscript(geometry(0), { atBottom: false, prevSession: "s1" }, "s2");
    expect(out.follow).toBe(true);
  });

  test("going back to the SAME session does not count as a switch", () => {
    const out = followTranscript(geometry(0), { atBottom: false, prevSession: "s1" }, "s1");
    expect(out.follow).toBe(false);
  });

  test("a reader at the bottom stays followed across many deltas (the normal live case)", () => {
    let state = { atBottom: true, prevSession: "s1" };
    for (let i = 0; i < 5; i++) {
      const out = followTranscript(geometry(2865 - 838 - i * 10, 2865 + i * 40), state, "s1");
      expect(out.follow).toBe(true);
      state = { atBottom: out.atBottom, prevHeight: 2865 + i * 40, prevSession: "s1" };
    }
  });

  test("a reader who scrolls up mid-stream stays put for every later delta", () => {
    let state = { atBottom: true, prevSession: "s1" };
    state = { ...state, atBottom: false };
    for (let i = 0; i < 5; i++) {
      const out = followTranscript(geometry(120, 2865 + i * 40), state, "s1");
      expect(out.follow).toBe(false);
      expect(out.atBottom).toBe(false);
      state = { atBottom: out.atBottom, prevHeight: 2865 + i * 40, prevSession: "s1" };
    }
  });
});

describe("ChatPane actually calls the rule (a rule nothing uses ships the same defect)", () => {
  test("the pin effect no longer assigns scrollTop unconditionally", () => {
    // The defect, verbatim: `session?.events.length; if (scroller) scroller.scrollTop = scroller.scrollHeight;`
    expect(pane).not.toMatch(/\$effect\(\(\)\s*=>\s*\{\s*session\?\.events\.length;\s*if \(scroller\) scroller\.scrollTop = scroller\.scrollHeight;\s*\}\)/);
    // Every pin now goes through the guarded call.
    expect(pane).not.toMatch(/scroller\.scrollTop = scroller\.scrollHeight;\s*\}\);/);
  });

  test("the pin consults the reader's position", () => {
    expect(pane).toContain("followTranscript(");
    // The guard is the whole point: the follow decision reads the reader's position.
    // MEASURED from the scroller, not the cached flag: `onScroll` writes that flag through Svelte
    // asynchronously, so a delta in the same task as the wheel read a stale `true` and pinned.
    expect(pane).toMatch(/\{ atBottom: isAtBottom\(geometry\), prevSession: pinnedSession \}/);
    expect(pane).not.toMatch(/atBottom: untrack\(\(\) => atBottom\)/);
  });

  test("the geometry is measured from the scroller, once, and reused", () => {
    expect(pane).toMatch(/const geometry = \{ scrollHeight: scroller\.scrollHeight, scrollTop: scroller\.scrollTop, clientHeight: scroller\.clientHeight \};/);
  });

  test("nothing keys the follow off a remembered height (the valve that fired on a skeleton)", () => {
    expect(pane).not.toContain("pinnedHeight");
  });

  test("onScroll uses the same threshold as the rule, not a second literal 48", () => {
    expect(pane).toContain("isAtBottom(");
    expect(pane).not.toMatch(/clientHeight < 48/);
  });

  test("jumpToLatest re-arms following, so the button does not become dead code", () => {
    const jump = pane.slice(pane.indexOf("function jumpToLatest()"), pane.indexOf("function jumpToLatest()") + 400);
    expect(jump).toMatch(/atBottom = true/);
    expect(jump).toMatch(/pinnedSession = session\?\.id \?\? null/);
  });

  test("the jump button still hangs off the same flag the rule maintains", () => {
    expect(pane).toContain("{#if !atBottom && session.events.length}");
  });

  test("the pass runs AFTER the DOM is flushed, or it measures geometry that is not on screen", () => {
    // The load-bearing line. `$effect` fires when events.length changes, which is BEFORE the new
    // rows are laid out: the pass measured the reader still at the bottom and pinned anyway
    // (measured: wheel to 0, transcript grown at t=1560, dragged back 414 ms later).
    expect(pane).toMatch(/session\?\.events\.length;\s*if \(!ready\) return;\s*void tick\(\)\.then\(\(\) => pinPass\(\)\);/);
  });

  test("the pass waits for the snapshot, or it pins to the loading skeleton", () => {
    // Measured: the first pass fired at t=96 ms against the 715 px skeleton, pinned to nothing, and
    // `events.length` never changed again — so the transcript stayed at its top for the whole run.
    expect(pane).toMatch(/const ready = session \? store\.hydrated\[session\.id\] \|\| session\.events\.length > 0 : true;/);
  });

  test("a pass that could not measure does NOT consume the first pass", () => {
    // Both halves of this were wrong in turn, and each looked right. Recording the session inside the
    // `!scroller` branch made the first pass disappear before anything could be measured, so a
    // restored session opened at its TOP. Not recording it made the next delta read `null` as a
    // session switch and pin. The guard must return WITHOUT recording.
    const body = pane.slice(pane.indexOf("const switched = pinnedSession"), pane.indexOf("const switched = pinnedSession") + 700);
    const guardAt = body.indexOf("if (!scroller)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(body.slice(guardAt, guardAt + 80)).toMatch(/if \(!scroller\) return;/);
    // `pinnedSession = id` happens only AFTER the measurement, on the path that measured something.
    const recordAt = body.indexOf("pinnedSession = id;");
    expect(recordAt).toBeGreaterThan(guardAt + 80);
  });

  test("the decision reads no $state at all: nothing a scroll could race with", () => {
    // Every input is either the DOM or the pane's own memory, so there is no cached flag to be stale
    // when a delta lands in the same task as the wheel.
    expect(pane).not.toContain("untrack(() => atBottom)");
  });
});
