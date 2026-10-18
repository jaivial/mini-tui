/**
 * Ordering rules for the Channels panel's reads.
 *
 * They exist because of a defect that only shows up in the browser. `ChannelsSection`
 * polled the inbox and `WhatsAppConnect` polled the connection state on a 10 s timer,
 * both with no way to tell which response was the current one:
 *
 *     async function load() {
 *       try { view = await client.inbox(); error = ""; }        // <- assigns whatever lands
 *       catch (e) { error = (e as Error).message; }              // <- and so does the failure
 *     }
 *
 * Measured against the deployed build with CDP: holding the FIRST poll's response of
 * each endpoint, letting polls #2 and #3 land normally, and then failing the held one.
 * The held response was stale -- its data predated what was already on screen -- and its
 * result arrived LAST, so it won: the panel switched to "Reintentando..." and the WhatsApp
 * block to "Estado de conexion no disponible", hiding a connection state that the two
 * newer polls had already proven. Nothing was wrong on the server; it had answered every
 * later request correctly. Same class of lie as E35/E36/E37, and for the same reason:
 * state held in the client, which no server-side test can see.
 *
 * Three rules, so "may this result paint?" is never answered by "it got here last":
 *
 * - every read takes a **generation**; a result may only paint while it is still the
 *   newest one, so an out-of-order arrival -- success OR failure -- is dropped.
 * - every read takes an **AbortController**; superseding one really aborts the request it
 *   replaced, and closing the panel aborts whatever is in flight. Measured: with four
 *   requests held open, closing the panel settled NONE of them -- they were still pending
 *   22 s later -- and the poll kept adding one pair every 10 s on top.
 * - a poll does not stack: while a read is in flight the next tick is skipped rather than
 *   opening a second one. Measured against the deployed build with the endpoint silent,
 *   the old code opened 5 inbox requests in 46 s and they all stayed open.
 *
 * No Svelte in here, so a test can hold the rules down.
 */

/** One read's claim on the panel: which generation it is, and how to cancel it. */
export interface ReadToken {
  /** Monotonic. A result whose generation is not the newest may not paint. */
  generation: number;
  /** Cancelled when this read is superseded or the panel closes. */
  readonly controller: AbortController;
  /** What this read was for. Kept for assertions and diagnostics. */
  readonly what: string;
}

/** A surface's read bookkeeping. Plain and mutable on purpose: nothing here renders. */
export interface ReadState {
  /** The newest generation handed out so far. */
  generation: number;
  /** The read allowed to paint, or null when nothing is in flight. */
  current: ReadToken | null;
}

export function createReadState(): ReadState {
  return { generation: 0, current: null };
}

/**
 * Begin a read for `what` and return its token, aborting whatever it replaces.
 *
 * Aborting the previous read is what makes the panel's promise true in fact and not just
 * in intent: the old request is dead, so it cannot arrive late and overwrite what the
 * operator is looking at now.
 */
export function startRead(state: ReadState, what: string): ReadToken {
  state.current?.controller.abort();
  state.generation += 1;
  const token: ReadToken = { generation: state.generation, controller: new AbortController(), what };
  state.current = token;
  return token;
}

/** Start a read only if none is in flight. Used by the poll, which must not stack. */
export function startReadIfIdle(state: ReadState, what: string): ReadToken | null {
  if (state.current) return null;
  return startRead(state, what);
}

/**
 * Whether `token` is still the read the panel is waiting for.
 *
 * A result from a superseded read answers a question the operator has moved on from, so it
 * must not paint -- and must not be able to paint later either, which is why this asks
 * about the token itself rather than reading whatever the component currently holds.
 */
export function isLatest(state: ReadState, token: ReadToken): boolean {
  return state.current === token && token.generation === state.generation && !token.controller.signal.aborted;
}

/** Mark `token` as finished. Only the read that is current may clear the slot. */
export function settleRead(state: ReadState, token: ReadToken): void {
  if (state.current === token) state.current = null;
}

/** Abort whatever is in flight, for when the panel closes. */
export function cancelRead(state: ReadState): void {
  state.current?.controller.abort();
  state.current = null;
}

/**
 * Whether a failed read is worth reporting.
 *
 * An abort is us changing our mind, not the channel ledger failing, and painting it would
 * tell the operator their WhatsApp is unreachable at the exact moment they closed the panel
 * -- the lie this file exists to prevent.
 */
export function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
