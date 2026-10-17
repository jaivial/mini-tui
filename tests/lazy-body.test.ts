/**
 * E14: a collapsed tool card kept its whole body in the DOM forever.
 *
 * `StepCard` mounted the monospace blocks lazily and unmounted them on
 * `transitionend`. That makes the release depend on a transition actually
 * RUNNING, and the transcript rows carry `content-visibility: auto`, which
 * SKIPS RENDERING for content outside the viewport. A skipped element has no
 * running transition, so the event never arrives and the body is stranded.
 *
 * Measured in Chrome 145 against the built app (session `xfh-probe`, 60 tool
 * cards): collapsing 30 cards whose rows had left the render set left 29 of 30
 * still holding their full `<pre>` body — DOM 220 KB -> 345 KB. Forcing
 * `content-visibility: visible` on the same rows dropped the identical run to 0,
 * which is what pins the cause to the skip and not to the click.
 *
 * The clock below is a REAL one (the same shape `wait.ts` in E13 used): a fake
 * timer would pass here for the wrong reason, since the defect is precisely
 * that an event never arrives.
 */
import { describe, expect, test } from "bun:test";
import { BODY_TRANSITION_PROPERTY, RELEASE_GRACE_MS, createLazyBody } from "../web/src/lib/lazyBody";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The card's closing transition in the shipped tokens. */
const DURATION = 180;

describe("lazy body: the release must not depend on the transition arriving", () => {
  test("a close whose transition NEVER runs still releases the body", async () => {
    // This is the browser fact the defect stood on: a row outside the viewport
    // under `content-visibility: auto` is not rendered, so it has no running
    // transition and therefore no `transitionend`. Nothing calls it here.
    const seen: boolean[] = [];
    const body = createLazyBody({ durationMs: DURATION, onChange: (m) => seen.push(m) });

    body.open();
    expect(body.mounted).toBe(true);
    body.close();
    expect(body.mounted).toBe(true); // still up: it lingers through the close

    await sleep(DURATION + RELEASE_GRACE_MS + 120);
    expect(body.mounted).toBe(false); // released anyway
    expect(seen).toEqual([true, false]);
  });

  test("the body survives the closing animation it is meant to show", async () => {
    const body = createLazyBody({ durationMs: DURATION });
    body.open();
    body.close();
    // Mid-transition the body MUST still be there, or the collapse would snap.
    await sleep(Math.floor(DURATION / 2));
    expect(body.mounted).toBe(true);
    await sleep(DURATION + RELEASE_GRACE_MS + 120);
    expect(body.mounted).toBe(false);
  });

  test("a transition that does run releases the body early", async () => {
    const body = createLazyBody({ durationMs: DURATION });
    body.open();
    body.close();
    // The event arrives at the end of a real transition: free the DOM now
    // instead of holding it for the rest of the grace window.
    body.transitionEnded(BODY_TRANSITION_PROPERTY);
    expect(body.mounted).toBe(false);
  });

  test("re-opening inside the close window cancels the pending release", async () => {
    const body = createLazyBody({ durationMs: DURATION });
    body.open();
    body.close();
    body.open(); // impatient double toggle
    await sleep(DURATION + RELEASE_GRACE_MS + 120);
    // The stale release must not fire against a body the user re-opened.
    expect(body.mounted).toBe(true);
  });

  test("reduced motion (0ms) still releases, and an opening transition never unmounts", async () => {
    const rm = createLazyBody({ durationMs: 0 });
    rm.open();
    rm.close();
    // An OPENING transition also ends on the same property; it must not release.
    rm.open();
    rm.transitionEnded(BODY_TRANSITION_PROPERTY);
    expect(rm.mounted).toBe(true);
    rm.close();
    await sleep(RELEASE_GRACE_MS + 120);
    expect(rm.mounted).toBe(false);
  });

  test("a transition on another property is not this body's business", async () => {
    const body = createLazyBody({ durationMs: DURATION });
    body.open();
    body.close();
    body.transitionEnded("transform"); // the chevron rotating, say
    expect(body.mounted).toBe(true);
    await sleep(DURATION + RELEASE_GRACE_MS + 120);
    expect(body.mounted).toBe(false);
  });

  test("close on a never-opened body is a no-op (no timer, no churn)", async () => {
    let scheduled = 0;
    const body = createLazyBody({
      durationMs: DURATION,
      schedule: (fn, ms) => {
        scheduled++;
        return setTimeout(fn, ms);
      },
    });
    body.close();
    expect(scheduled).toBe(0);
    expect(body.mounted).toBe(false);
  });

  test("dispose drops the pending release without reporting a change", async () => {
    const seen: boolean[] = [];
    const body = createLazyBody({ durationMs: DURATION, onChange: (m) => seen.push(m) });
    body.open();
    body.close();
    body.dispose();
    await sleep(DURATION + RELEASE_GRACE_MS + 120);
    // Teardown is not a state change the owner needs to hear about.
    expect(seen).toEqual([true]);
  });
});
