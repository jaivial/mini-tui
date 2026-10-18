/**
 * Whether a growing transcript keeps the reader pinned to the bottom, as a rule with no runes in it.
 *
 * The pane pinned unconditionally: every time `session.events` grew it assigned
 * `scroller.scrollTop = scroller.scrollHeight`, with no question of where the reader was. Measured
 * against the deployed build (Chrome 145, a 55-event session, `POST /api/sessions/<id>/model` as
 * the delta trigger): a reader who had scrolled to the top to read history was thrown back to
 * `scrollTop = scrollHeight - clientHeight` — 2027 px, exactly the bottom — by a single streamed
 * event, and the instrumented `scrollTop` setter caught four such assignments coming out of
 * `App-*.js` in one delta.
 *
 * That makes history unreadable during a run, and it makes the pane's own jump-to-latest button
 * unreachable: `ChatPane` only shows that button when `!atBottom`, and the pin sets `atBottom`
 * back to true through the scroll event it triggers.
 *
 * The rule is the obvious one and the reason it is written down is that it is easy to lose:
 * **follow the stream only while the reader is already following it.** Everything else — a new
 * session, a transcript that shrank (a resync replacing it), the reader jumping back down — must
 * still land at the bottom, so those are named here instead of being re-derived at the call site.
 */

/** How far from the end still counts as "at the bottom", in CSS px. Matches `ChatPane`'s probe. */
export const BOTTOM_SLOP_PX = 48;

/** The measurement `onScroll` takes, as plain numbers so a test needs no DOM. */
export interface ScrollGeometry {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** Is the viewport within {@link BOTTOM_SLOP_PX} of the end of the transcript? */
export function isAtBottom({ scrollHeight, scrollTop, clientHeight }: ScrollGeometry, slop = BOTTOM_SLOP_PX): boolean {
  return scrollHeight - scrollTop - clientHeight < slop;
}

export interface FollowInput {
  /**
   * Whether the reader is at the end **as measured right now**.
   *
   * Measure it, do not read a cached flag: the flag is written by the `scroll` event handler, which
   * Svelte applies asynchronously, so a delta that lands in the same task as the wheel is judged
   * against a stale `true`. Measured on the build that did exactly that: the wheel moved the reader
   * to 0 (the jump button appeared), the transcript grew at t=43 ms, and 360 ms later the reader
   * was back at the bottom anyway. The DOM is the truth about where the reader is.
   */
  atBottom: boolean;
  /** A different session is on screen: its transcript must open at its end, wherever the last one stood. */
  sessionChanged: boolean;
}

/**
 * Should this change scroll the transcript to the bottom?
 *
 * There is exactly ONE exception to "the reader decides", and it is the session changing: a new
 * session has no history the reader was reading, so wherever they were standing is meaningless.
 *
 * There used to be a second one — "the transcript shrank, so their offset is meaningless" — and it
 * was wrong in the way that only shows up in a browser. `scrollHeight` is not monotonic: a pane
 * passes through 715 px (the loading skeleton) and 3076 px (a layout mid-flight) before settling at
 * its real height, so the "previous" height was frequently from a different render than the current
 * one. Measured: `pinnedHeight` 3076 against a real 2865, i.e. "shrank", on a reader who was at the
 * top — which pinned them anyway and reproduced the exact defect the rule was written to remove.
 * A safety valve that fires on a transient measurement is not a valve.
 */
export function shouldFollowToBottom({ atBottom, sessionChanged }: FollowInput): boolean {
  return sessionChanged || atBottom;
}

/** The result of one pass: where the transcript ends up, and whether the follow flag changed. */
export interface FollowOutcome {
  /** Jump to the end. */
  follow: boolean;
  /** What `atBottom` should read afterwards, so the jump button appears or disappears. */
  atBottom: boolean;
}

/**
 * One pass of the pin effect, with the position it remembers.
 *
 * `prevSession` is the caller's memory of whose transcript it was following; `null` means "nothing
 * measured yet" and is never a switch on its own. Following sets `atBottom` true (the jump lands at
 * the end); not following leaves it exactly as it was, so a reader who scrolled up keeps the button
 * that offers to bring them back.
 */
export function followTranscript(
  geometry: ScrollGeometry,
  state: { atBottom: boolean; prevSession: string | null },
  session: string | null,
  switched?: boolean,
): FollowOutcome {
  // `switched` is passed in rather than derived: the caller knows about switches that happened
  // before the scroller bound, and a first reading must not be mistaken for one — that pins on the
  // FIRST delta of every session, the yank this rule removes, arriving through the back door.
  const sessionChanged = switched ?? (state.prevSession !== null && state.prevSession !== session);
  // Nothing measured yet means the pane has never shown this transcript to anybody, so there is no
  // reader position to respect: the first pass lands at the end, which is where a chat opens.
  // Measured without this: a restored session loaded showing its TOP with the jump button up,
  // because the first real measurement is taken while the rows are still being laid out.
  const firstPass = state.prevSession === null;
  const follow = firstPass || shouldFollowToBottom({ atBottom: state.atBottom, sessionChanged });
  return { follow, atBottom: follow ? true : state.atBottom };
}
