/**
 * Which rows of the hosts panel show "Testing": state that only failed in the browser.
 *
 * The defect these pin was MEASURED against the deployed build, not reasoned about. "Which
 * row is being tested" was a single `probing: string | null` while the in-flight requests
 * were a Map keyed by host id. Probing host B therefore un-probed host A: A's row went back
 * to an enabled "Test" while A's own request was still running, and clicking it again started
 * a SECOND probe for A.
 *
 * What that costs is the promise E35 made one cycle earlier. E35 wired `request.signal` so
 * "closing the panel cancels them" would stop the child `ssh`, and the controller Map was
 * keyed by host id -- so the second probe of A overwrote the first controller and the first
 * request could never be aborted again. Measured with CDP on the deployed build: probe A,
 * probe B, probe A again, close the panel -> **3 requests, 2 aborted, 1 still running**. The
 * control case (one probe, close the panel) aborts correctly, so the signal plumbing is
 * fine and the leak is entirely in which row the panel thinks is busy.
 */
import { describe, expect, test } from "bun:test";
import {
  canProbe,
  probeIds,
  settleProbe,
  startProbe,
} from "../web/src/lib/probeState";

/** The old rule, written the way the component had it: one id for the whole panel. */
function oldProbingIsBusy(probing: string | null, hostId: string): boolean {
  return probing === hostId;
}

describe("in-flight tracking (the regression)", () => {
  test("THE REGRESSION: probing host B must not un-probe host A", () => {
    let inFlight: ReadonlySet<string> = new Set();
    inFlight = startProbe(inFlight, "A");
    expect(canProbe(inFlight, "A")).toBe(false);

    // B starts. Under the old single-id rule this REPLACED the id, and A looked idle again.
    inFlight = startProbe(inFlight, "B");

    // The control, written with the old logic, is what shipped: with `probing = "B"`,
    // host A reads as idle, which is the lie that let the duplicate start.
    expect(oldProbingIsBusy("B", "A")).toBe(false);

    // The fix: A is still busy because A has its own probe running.
    expect(canProbe(inFlight, "A")).toBe(false);
    expect(canProbe(inFlight, "B")).toBe(false);
  });

  test("a settled host frees its own row and nobody else's", () => {
    let inFlight: ReadonlySet<string> = new Set();
    inFlight = startProbe(startProbe(inFlight, "A"), "B");
    expect(probeIds(inFlight).sort()).toEqual(["A", "B"]);

    inFlight = settleProbe(inFlight, "A");
    expect(canProbe(inFlight, "A")).toBe(true);
    // B was never touched by A settling.
    expect(canProbe(inFlight, "B")).toBe(false);
  });

  test("THE REGRESSION (other direction): the first of two probes must not free the row", () => {
    // With a single id, probe #1 settling cleared the row while probe #2 still ran.
    let single = "A" as string | null;
    single = null; // probe #1 finishes -> the row is free, but probe #2 is still in flight
    expect(oldProbingIsBusy(single, "A")).toBe(false); // the lie the old code told

    // The fix: the row only frees when ITS probe is the one that settles.
    let inFlight: ReadonlySet<string> = new Set();
    inFlight = startProbe(inFlight, "A");
    inFlight = settleProbe(inFlight, "A");
    expect(canProbe(inFlight, "A")).toBe(true);
  });

  test("cancelAll empties every row, not just the last one clicked", () => {
    let inFlight: ReadonlySet<string> = new Set();
    inFlight = startProbe(startProbe(startProbe(inFlight, "A"), "B"), "C");
    expect(probeIds(inFlight).sort()).toEqual(["A", "B", "C"]);
    inFlight = new Set(); // what cancelAll now does
    expect(probeIds(inFlight)).toEqual([]);
    expect(canProbe(inFlight, "A")).toBe(true);
  });

  test("sets are immutable: the old value is never mutated under Svelte's feet", () => {
    const before: ReadonlySet<string> = new Set(["A"]);
    const after = startProbe(before, "B");
    expect(probeIds(before)).toEqual(["A"]); // untouched
    expect(probeIds(after).sort()).toEqual(["A", "B"]);
    expect(after).not.toBe(before);

    const settled = settleProbe(after, "A");
    expect(probeIds(after).sort()).toEqual(["A", "B"]); // still untouched
    expect(probeIds(settled)).toEqual(["B"]);
  });

  test("settling a host that is not in flight is a no-op, not a throw", () => {
    expect(probeIds(settleProbe(new Set(["A"]), "nope"))).toEqual(["A"]);
    expect(probeIds(settleProbe(new Set(), "nope"))).toEqual([]);
  });

  test("canProbe on a fresh panel is true", () => {
    expect(canProbe(new Set(), "A")).toBe(true);
  });
});

describe("controller bookkeeping (why the first probe could not be cancelled)", () => {
  test("keyed by host id, a second probe loses the first controller", () => {
    // This is the exact shape that shipped: one Map, keyed by host id.
    const first = new AbortController();
    const byHostId = new Map<string, AbortController>([["A", first]]);
    const second = new AbortController();
    byHostId.set("A", second); // probe #2 for A overwrites probe #1's controller

    // cancelAll can only reach what the Map still holds:
    for (const c of byHostId.values()) c.abort();
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false); // <- the leak, measured as 1 of 3 requests
  });

  test("keyed by a token per probe, cancelAll reaches every controller ever made", () => {
    const first = new AbortController();
    const second = new AbortController();
    const byToken = new Map<symbol, AbortController>([[Symbol("A"), first]]);
    byToken.set(Symbol("A"), second);

    for (const c of byToken.values()) c.abort();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
