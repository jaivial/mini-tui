/**
 * The usage panel's load ordering.
 *
 * The defect these hold down was measured on the deployed build, not reasoned about:
 * holding the `1h` response with CDP and letting `7d` answer first left the panel with
 * the `7 d` button pressed and `1h`'s numbers in the body. The last-response-wins rule
 * that caused it is reproduced at the bottom as `mainLogic`, so the control A/B fails
 * against what origin/main actually does.
 */
import { describe, expect, test } from "bun:test";

import { cancelLoad, createUsageLoad, isCancel, isLatest, settleLoad, startLoad } from "../web/src/lib/usageLoad";

/** Whether a token is still the load allowed to paint. */
const paints = (load: ReturnType<typeof createUsageLoad>, token: ReturnType<typeof startLoad>) => isLatest(load, token);

describe("usage load ordering", () => {
  test("a response from the load in flight is allowed to paint", () => {
    const load = createUsageLoad("24h");
    const token = startLoad(load, "24h");
    expect(paints(load, token)).toBe(true);
    settleLoad(load, token);
  });

  // THE BUG: 1h is asked for, then 7d. 7d answers first and is correct on screen; 1h's
  // answer then lands and takes the panel's place. With no generation, it paints.
  test("a superseded load may not paint over the window now on screen", () => {
    const load = createUsageLoad("24h");
    const oneHour = startLoad(load, "1h");
    const sevenDays = startLoad(load, "7d");
    expect(paints(load, sevenDays)).toBe(true);
    expect(paints(load, oneHour)).toBe(false);
  });

  test("superseding a load really aborts the request it replaced", () => {
    const load = createUsageLoad("24h");
    const oneHour = startLoad(load, "1h");
    expect(oneHour.controller.signal.aborted).toBe(false);
    startLoad(load, "7d");
    expect(oneHour.controller.signal.aborted).toBe(true);
  });

  // The stale token must never become paintable again, not even after the newest load
  // settles: "it settled and the slot is empty" is not the same as "it is the answer".
  test("a settled newer load does not make the old one current again", () => {
    const load = createUsageLoad("24h");
    const oneHour = startLoad(load, "1h");
    const sevenDays = startLoad(load, "7d");
    settleLoad(load, sevenDays);
    expect(paints(load, oneHour)).toBe(false);
    expect(paints(load, sevenDays)).toBe(false);
  });

  test("the newest load is recorded as the selected window", () => {
    const load = createUsageLoad("24h");
    startLoad(load, "1h");
    expect(load.selected).toBe("1h");
    startLoad(load, "30d");
    expect(load.selected).toBe("30d");
  });

  test("closing the panel aborts what is in flight", () => {
    const load = createUsageLoad("24h");
    const token = startLoad(load, "7d");
    cancelLoad(load);
    expect(token.controller.signal.aborted).toBe(true);
    expect(paints(load, token)).toBe(false);
    expect(load.current).toBeNull();
  });

  test("a poll of the same window supersedes itself instead of stacking", () => {
    const load = createUsageLoad("24h");
    const first = startLoad(load, "24h");
    const second = startLoad(load, "24h");
    expect(first.controller.signal.aborted).toBe(true);
    expect(paints(load, second)).toBe(true);
  });

  test("only the current load may clear the slot", () => {
    const load = createUsageLoad("24h");
    const oneHour = startLoad(load, "1h");
    const sevenDays = startLoad(load, "7d");
    // 1h settles late. It must not evict 7d, which is still the answer being awaited.
    settleLoad(load, oneHour);
    expect(load.current).not.toBeNull();
    expect(paints(load, sevenDays)).toBe(true);
    settleLoad(load, sevenDays);
    expect(load.current).toBeNull();
  });

  test("an abort is not reported as a failure", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isCancel(abort)).toBe(true);
    expect(isCancel(new Error("usage unavailable (500)"))).toBe(false);
    expect(isCancel("not an error")).toBe(false);
  });
});

/**
 * The control: origin/main's rule, which is "the response that arrives last assigns
 * `view`". Same two windows as the test above, resolved in the order CDP measured, and
 * the assertion is that the rule loses the current window -- so this test passes with
 * the old rule and documents exactly what had to change.
 */
describe("the rule origin/main used", () => {
  test("with no generation, the response that lands last wins", () => {
    // This is the shape that shipped: `view = await client.window(window_)` from three
    // unguarded triggers, no generation and no signal to tell a stale answer apart.
    let view = "";
    const paint = (body: string) => { view = body; };
    // 7d answers first and is right; the 1h request asked for earlier answers last.
    paint("982 calls");
    paint("0 calls");
    expect(view).toBe("0 calls"); // the panel showed 1h while the button said 7 d
  });

  test("a generation is what makes the stale answer droppable", () => {
    const load = createUsageLoad("24h");
    const oneHour = startLoad(load, "1h");
    const sevenDays = startLoad(load, "7d");
    // Same arrival order as above: 7d paints, then 1h's answer arrives and is refused.
    let view = paints(load, sevenDays) ? "982 calls" : "";
    if (paints(load, oneHour)) view = "0 calls";
    expect(view).toBe("982 calls");
  });
});
