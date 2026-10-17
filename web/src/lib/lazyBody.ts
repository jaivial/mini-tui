/**
 * The lazy mount/unmount of a collapsible body (the tool card's monospace
 * blocks, and anything else that must not cost DOM while it is closed).
 *
 * A chat transcript holds hundreds of tool cards, so a collapsed body has to
 * leave the DOM — not for tidiness but because a few hundred `<pre>` blocks of
 * tool output is megabytes of live nodes.
 *
 * WHY THIS IS NOT AN EVENT: the obvious implementation unmounts on
 * `transitionend`, so the content stays for the closing animation and then goes.
 * That makes the release depend on a transition ACTUALLY RUNNING, and a
 * transition does not run for every element:
 *
 *   - `content-visibility: auto` (what the transcript rows use, see
 *     `Transcript.svelte`'s `.cv-row`) SKIPS RENDERING for content outside the
 *     viewport. A skipped element has no running transition, so no
 *     `transitionend` ever arrives and the body stays mounted forever.
 *
 * Measured in Chrome 145 against the built app: collapsing 30 tool cards whose
 * rows had left the render set left **29 of 30 collapsed cards still holding
 * their full `<pre>` body** (DOM 220 KB -> 345 KB), and forcing
 * `content-visibility: visible` at runtime dropped the same run to **0**. The
 * release is therefore not "after the closing animation", it is "after the
 * closing animation OR the duration, whichever comes first".
 *
 * So the timer is the release and the event is only an optimisation: when the
 * transition does run, `transitionEnded()` frees the body early and the user
 * gets the animation. When it does not, the timer still frees it. Reduced
 * motion (`--duration-base: 0ms`) is handled by the same rule: the duration is
 * read from the token, so a 0ms duration releases on the next tick.
 */

/** The CSS transition property the collapsible body animates. */
export const BODY_TRANSITION_PROPERTY = "grid-template-rows";

/**
 * Grace added on top of the transition duration before releasing anyway. A
 * transition that IS running finishes at the duration; this covers the frame
 * the browser needs to deliver `transitionend`, and the scheduler jitter under
 * load. Without it, the timer could beat a transition that was about to end and
 * cut the closing animation short.
 */
export const RELEASE_GRACE_MS = 60;

/**
 * A CSS time value in milliseconds. `getComputedStyle` normalises durations to
 * SECONDS (`--duration-base: 180ms` reads back as `0.18s`), so a bare
 * `parseFloat` is wrong twice over: it turns `180ms` into 180 (right by luck)
 * and `0.18s` into 0.18 ms — a 1000x error that would cut the closing animation
 * short and release the body before it has finished collapsing. Measured on the
 * deployed build before this was caught: the body left the DOM at 61 ms while
 * the transition itself ran to 189 ms.
 */
export function parseCssTime(value: string): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const m = /^(-?[\d.]+)(ms|s)?$/.exec(raw);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, m[2] === "s" ? n * 1000 : n);
}

export interface LazyBodyOptions {
  /** The closing transition's duration, in ms (0 under reduced motion). */
  durationMs: number;
  /**
   * Called whenever `mounted` actually changes — including from the release
   * TIMER, which runs outside any reactive context, so the owner cannot learn
   * about it by reading `mounted` after the fact.
   */
  onChange?: (mounted: boolean) => void;
  /** Injected so the tests drive a real clock instead of a fake timer. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface LazyBody {
  /** Whether the body should be in the DOM right now. */
  readonly mounted: boolean;
  /** Open it: the body is mounted (and stays until it is closed again). */
  open(): void;
  /**
   * Close it. The body stays mounted for the closing transition and is then
   * released by the timer — whether or not the transition ever runs.
   */
  close(): void;
  /**
   * The transition ended: release now so the DOM is free as early as it can
   * be. A transition on any OTHER property (or one that ends while the body is
   * open) is ignored.
   */
  transitionEnded(propertyName: string): void;
  /** Drop any pending release (component teardown). */
  dispose(): void;
}

export function createLazyBody(options: LazyBodyOptions): LazyBody {
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const releaseAfter = Math.max(0, options.durationMs) + RELEASE_GRACE_MS;

  let mounted = false;
  let pending: unknown = null;
  /** True between a close and its release: only then is a transitionend ours. */
  let closing = false;

  const announce = options.onChange ?? (() => {});

  function release() {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    closing = false;
    if (!mounted) return;
    mounted = false;
    announce(false);
  }

  return {
    get mounted() {
      return mounted;
    },
    open() {
      // A pending release must not fire against a body the user just re-opened.
      if (pending !== null) {
        cancel(pending);
        pending = null;
      }
      closing = false;
      if (mounted) return;
      mounted = true;
      announce(true);
    },
    close() {
      if (!mounted) return;
      closing = true;
      if (pending !== null) return; // a release is already on its way
      pending = schedule(release, releaseAfter);
    },
    transitionEnded(propertyName) {
      if (propertyName !== BODY_TRANSITION_PROPERTY) return;
      // An OPENING transition ends on this same property. Only a transition
      // inside a close window is the one we are waiting for.
      if (!closing) return;
      release();
    },
    dispose() {
      if (pending !== null) cancel(pending);
      pending = null;
      closing = false;
      mounted = false;
    },
  };
}
