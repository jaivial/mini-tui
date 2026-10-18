/**
 * State helpers for the hosts panel's "Test" button.
 *
 * They exist because of two defects that only showed up in the browser, and neither
 * one is visible from the server.
 *
 * The first: the panel kept its probe verdicts in a plain `Record`, and clearing one went
 * through `new Map(record)`. That throws `TypeError: object is not iterable`, and it threw
 * BEFORE the `try`, so the `catch` never saw it: the button switched to "Testing" and no
 * request ever left the browser. Measured with CDP: zero network requests for the click.
 *
 * The second (this one): "which row is being tested" was a single `probing` id while the
 * in-flight requests were a Map. Probing host B therefore *un-probed* host A: A's row went
 * back to an enabled "Test" while A's own request was still running, clicking it again
 * started a SECOND probe for A, and `probes.set(host.id, controller)` dropped A's first
 * controller on the floor. Measured on the deployed build: probe A, probe B, probe A again,
 * then close the panel -> **3 requests, 2 aborted, 1 left running**. Closing the panel is
 * exactly the gesture E35 wired `request.signal` for, so the promise it made ("closing the
 * panel cancels them") silently stopped holding the moment two rows were involved.
 *
 * The rules live here, without Svelte, so a test can hold them.
 */

export type ProbeVerdict = { ok: boolean; message: string };
export type ProbeResults = Record<string, ProbeVerdict>;

/**
 * The probes in flight, as a plain Set of host ids.
 *
 * A Set and not one "current" id, because the bug above was exactly a single id doing a
 * job that needs one entry per host. Every rule that used to consult `probing === host.id`
 * now asks this instead, and a row stays busy for as long as its OWN probe is running.
 */
export type ProbeInFlight = ReadonlySet<string>;

/** A host row may only start a probe when that host has none in flight. */
export function canProbe(inFlight: ProbeInFlight, id: string): boolean {
  return !inFlight.has(id);
}

/** Register a probe, returning the new set. The old one is not mutated. */
export function startProbe(inFlight: ProbeInFlight, id: string): ProbeInFlight {
  return new Set(inFlight).add(id);
}

/**
 * Forget a probe, returning the new set.
 *
 * This is what the old code got wrong in a second way. The panel called it from the
 * `finally` of the probe that finished, so with two probes of the SAME host in flight the
 * first one to settle cleared the row while the second was still running -- the same lie,
 * arriving from the other direction. Clearing is now driven by the request that is actually
 * finishing, via `settleProbe`, which only removes the id it was given.
 */
export function settleProbe(inFlight: ProbeInFlight, id: string): ProbeInFlight {
  const next = new Set(inFlight);
  next.delete(id);
  return next;
}

/** Every in-flight host id, for `cancelAll`. */
export function probeIds(inFlight: ProbeInFlight): string[] {
  return [...inFlight];
}

/** Drop one host's verdict, so a row that is being re-tested cannot show the old answer. */
export function withoutVerdict(results: ProbeResults, id: string): ProbeResults {
  const { [id]: _dropped, ...rest } = results;
  return rest;
}

/** Record one host's verdict. */
export function withVerdict(results: ProbeResults, id: string, verdict: ProbeVerdict): ProbeResults {
  return { ...results, [id]: verdict };
}

/**
 * Whether a cancel is worth telling the user about. An `AbortError` is us cancelling, not a host
 * that failed, and painting it red would report a working host as broken.
 */
export function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
