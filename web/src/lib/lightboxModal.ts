/**
 * The image lightbox, as a modal, in pure rules.
 *
 * Clicking an image in the transcript paints a sheet over the whole app: nothing of the
 * conversation shows behind it, and the only way out is the X, a backdrop click, or Escape.
 * That makes it a modal surface, and a modal has three jobs the markup alone does not do:
 *
 *  - **Focus stays inside it.** Tab has to walk the four viewer controls and come back round,
 *    not wander into the chat painted over. Measured on the deployed build: 6 of the first 12
 *    Tab stops landed on controls with zero visible pixels — the keyboard cursor disappears
 *    off-screen and Enter presses something nobody can see.
 *  - **The page behind is inert.** Not just unpainted: a screen reader that walks past the
 *    image reads the whole conversation the viewer is covering, and the pointer still lands on it.
 *  - **The key belongs to whoever has it.** `+`/`-` zoom the image. Bound to the window they
 *    also fire while someone is typing: measured, "2+2" into the prompt became "22" with the
 *    image at 125 %. A viewer must not edit the conversation behind it.
 *
 * The browser does the containing and the blocking (`<dialog>` + `showModal()` owns the top
 * layer, focus containment, inertness and Escape), so what lives here is the DECISION, kept
 * apart from the component so it can be tested without a browser.
 */

/** What the lightbox does with a key, or `null` when the key is none of its business. */
export type LightboxAction = "close" | "zoom-in" | "zoom-out";

/** What the component knows about the keyboard when a key arrives. */
export interface KeyContext {
  /** The viewer is on screen. */
  open: boolean;
  /** Focus is inside the viewer's own subtree. */
  insideDialog: boolean;
  /** A modifier the browser or the OS owns the combination with. */
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * What the lightbox claims from one key press.
 *
 * `insideDialog` is the load-bearing check, and it is what the window-level handler got wrong:
 * without it the zoom keys fire no matter who has focus, so typing "+" into the prompt zooms
 * the image instead of typing a plus sign. A closed viewer and an unfocused one claim nothing.
 *
 * Modified combinations are left alone on purpose: Ctrl/Cmd + "+"/"-" is the browser's own zoom
 * and Alt is the OS menu bar's. Claiming those would take a shortcut away from the user to
 * serve a feature they did not ask for.
 */
export function lightboxAction(key: string, ctx: KeyContext): LightboxAction | null {
  if (!ctx.open || !ctx.insideDialog) return null;
  if (ctx.ctrlKey || ctx.metaKey || ctx.altKey) return null;
  if (key === "Escape") return "close";
  // Shift is what produces "+" on most layouts, so it is deliberately NOT excluded here.
  if (key === "+" || key === "=") return "zoom-in";
  if (key === "-") return "zoom-out";
  return null;
}

/** The zoom limits the viewer offers, in the same numbers the toolbar buttons read. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

/** The step the buttons and the +/- keys apply. Kept here so the two cannot drift apart. */
export const ZOOM_IN = 1.25;
export const ZOOM_OUT = 0.8;

/**
 * The wheel is deliberately finer than a click: a wheel notch is a small adjustment, a click is a
 * jump, and the two used different factors. They are kept apart so sharing one constant between
 * them cannot quietly change how fast the wheel feels.
 */
export const ZOOM_WHEEL_IN = 1.12;
export const ZOOM_WHEEL_OUT = 0.9;

/** What a double-click on the image does: out to 1× from any zoom, or a jump in from 1×. */
export const ZOOM_TOGGLE_IN = 2.5;

/**
 * The zoom after one step, clamped and rounded.
 *
 * Rounded to two decimals on purpose: the percentage in the toolbar is `Math.round(zoom * 100)`,
 * and an unrounded float prints a value the viewer never actually reached (a run of `* 1.25` from
 * 1 lands on 3.8125, which reads as "381 %" while the image is at 381.25 %).
 */
export function zoomBy(zoom: number, factor: number): number {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
  return Math.round(next * 100) / 100;
}

/** The zoom one action lands on. */
export function applyZoomAction(zoom: number, action: LightboxAction): number {
  if (action === "close") return zoom;
  return zoomBy(zoom, action === "zoom-in" ? ZOOM_IN : ZOOM_OUT);
}

/**
 * The zoom a double-click on the image lands on.
 *
 * Out is an exact return to 1× rather than one step, because from an odd zoom like 1.56 a single
 * 0.8 step leaves 1.25 — still zoomed, and pressing again keeps creeping. The way out of a viewer
 * is "put it back how I found it".
 */
export function applyZoomToggle(zoom: number): number {
  return zoom > 1 ? ZOOM_MIN : zoomBy(zoom, ZOOM_TOGGLE_IN);
}
