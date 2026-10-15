/**
 * Live arrival bookkeeping for transcript events.
 *
 * The wire events carry no clocks, so the client keeps its own: the moment a
 * delta frame lands (only deltas — a snapshot is history, and history has no
 * honest duration to show), each tool call is stamped when it starts and when
 * its observation arrives. Message events keep their arrival wall-clock so the
 * transcript can show a quiet timestamp at the top of each group.
 *
 * Everything is keyed weakly by the event object itself: the store pushes each
 * event once and never recreates it, so entries die with the session's
 * transcript and the registry needs no invalidation.
 */

const calls = new WeakMap<object, { start: number; end?: number }>();

/** First sight of a tool call: the clock starts. */
export function markCallStart(call: object) {
  if (!calls.has(call)) calls.set(call, { start: performance.now() });
}

/** Its observation landed: the clock stops (once). */
export function markCallEnd(call: object) {
  const entry = calls.get(call);
  if (entry && entry.end === undefined) entry.end = performance.now();
}

/** Measured duration in ms, or undefined while the call has no result yet. */
export function callDuration(call: object): number | undefined {
  const entry = calls.get(call);
  return entry?.end === undefined ? undefined : entry.end - entry.start;
}

/** True when this exact call arrived live and still has no observation. */
export function callIsRunning(call: object): boolean {
  const entry = calls.get(call);
  return entry !== undefined && entry.end === undefined;
}

const arrivals = new WeakMap<object, number>();

/** Wall-clock (epoch ms) at which a live delta delivered this event. */
export function markArrival(event: object) {
  if (!arrivals.has(event)) arrivals.set(event, Date.now());
}

/** The event's arrival time, or undefined when it came from a snapshot (history). */
export function arrivalOf(event: object): number | undefined {
  return arrivals.get(event);
}

/** "843 ms" / "2.4 s" for a header chip. */
export function formatDuration(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
