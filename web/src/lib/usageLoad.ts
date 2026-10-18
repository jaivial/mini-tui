/**
 * Ordering rules for the usage panel's window loads.
 *
 * They exist because of a defect that only shows up in the browser: the panel loaded
 * from three independent triggers with no way to tell which response was the current
 * one, so a slow earlier window could overwrite the window the operator had already
 * moved to. Measured on the deployed build with CDP, holding the `1h` response and
 * letting `7d` answer first: the panel ended up with the `7 d` button pressed and the
 * `1h` numbers in the body (982 calls replaced by "Sin llamadas en esta ventana").
 * The button said one thing and the table said another -- the same class of lie E35
 * and E36 closed on the hosts panel, and for the same reason: the server answered
 * correctly every time, and no server-side test can see it.
 *
 * Two rules, so "may this response paint?" is never answered by "it got here last":
 *
 * - every load takes a **generation**; a response may only paint while it is still the
 *   newest generation, so an out-of-order arrival is dropped instead of winning.
 * - every load also takes an **AbortController**; superseding one really aborts the
 *   request it replaced, so the work stops instead of being merely ignored, and closing
 *   the panel aborts whatever is in flight. Without it the panel keeps a dead request
 *   reading the ledger for a window nobody is looking at any more.
 *
 * No Svelte in here, so a test can hold the rules down.
 */

/** One load's claim on the panel: which generation it is, and how to cancel it. */
export interface LoadToken {
  /** Monotonic. A response whose generation is not the newest may not paint. */
  generation: number;
  /** Cancelled when this load is superseded or the panel closes. */
  readonly controller: AbortController;
  /** The window this load was for. Kept for assertions and diagnostics. */
  readonly window: string;
}

/** The panel's load bookkeeping. Plain and mutable on purpose: nothing here renders. */
export interface UsageLoad {
  /** The newest generation handed out so far. */
  generation: number;
  /** The window the panel is asking about right now. */
  selected: string;
  /** The load allowed to paint, or null when nothing is in flight. */
  current: LoadToken | null;
}

export function createUsageLoad(selected: string): UsageLoad {
  return { generation: 0, selected, current: null };
}

/**
 * Begin a load for `selected` and return its token, aborting whatever it replaces.
 *
 * Aborting the previous load is what makes the panel's promise ("the window you picked
 * is the one on screen") true in fact and not just in intent: the old request is dead,
 * so it cannot arrive late and overwrite the new window's numbers.
 */
export function startLoad(load: UsageLoad, selected: string): LoadToken {
  load.current?.controller.abort();
  load.generation += 1;
  load.selected = selected;
  const token: LoadToken = { generation: load.generation, controller: new AbortController(), window: selected };
  load.current = token;
  return token;
}

/**
 * Whether `token` is still the load the panel is waiting for.
 *
 * A response from a superseded load answers a question the operator has moved on from,
 * so it must not paint -- and must not be able to paint later either, which is why this
 * asks about the token itself rather than reading whatever the component currently holds.
 */
export function isLatest(load: UsageLoad, token: LoadToken): boolean {
  return load.current === token && token.generation === load.generation && !token.controller.signal.aborted;
}

/** Mark `token` as finished. Only the load that is current may clear the slot. */
export function settleLoad(load: UsageLoad, token: LoadToken): void {
  if (load.current === token) load.current = null;
}

/** Abort whatever is in flight, for when the panel closes. */
export function cancelLoad(load: UsageLoad): void {
  load.current?.controller.abort();
  load.current = null;
}

/**
 * Whether a failed load is worth reporting.
 *
 * An abort is us changing our mind, not the ledger failing, and painting it would tell
 * the operator their usage data is broken at the exact moment they closed the panel or
 * picked another window.
 */
export function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
