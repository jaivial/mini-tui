/**
 * The phone drawer, as a modal, in pure rules.
 *
 * On a narrow window the bots list is not a rail beside the chat, it IS the screen: it covers
 * everything, and nothing of the chat shows behind it. That makes it a modal surface, and a modal
 * has three jobs the markup alone does not do for you:
 *
 *  - **Escape closes it.** A full-screen sheet with no keyboard way out is a trap for anyone
 *    driving it from a keyboard or a switch device, and the header's X is only reachable if you
 *    already know it is there.
 *  - **Focus stays inside it.** Tab has to walk the drawer's own controls and come back round, not
 *    wander into the chat that is painted over — those stops are invisible but still focusable, so
 *    the keyboard cursor disappears off-screen and Enter presses things nobody can see.
 *  - **The page behind is inert.** Not just unpainted: a screen reader that walks past the drawer
 *    reads the whole conversation the drawer is covering, and the pointer still lands on it.
 *
 * The DOM helpers are written against the standard (`inert`, `HTMLElement.inert`) so the browser
 * does the containing and the blocking, and so the same thing happens for a screen reader without
 * this file having to guess at roles. What lives here is the DECISION, kept apart from the component
 * so it can be tested without a browser.
 */

/** How many focusable stops the drawer's keyboard loop walks. Below this a Tab cannot wrap. */
export const MIN_DRAWER_STOPS = 2;

/** Selectors that make an element a Tab stop, matching what the drawer actually renders. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Whether an element takes focus right now. `inert` and `hidden` take an element out of the tab
 * order in every engine, so a walk that ignored them would land on something invisible — the exact
 * bug this module exists to stop.
 */
export function isFocusable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (!el.matches(FOCUSABLE)) return false;
  if (el.hidden || el.closest("[inert]")) return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  if (style && (style.visibility === "hidden" || style.display === "none")) return false;
  return el.getClientRects().length > 0;
}

/**
 * The drawer's Tab stops, in DOM order, skipping anything the browser itself would skip.
 *
 * `root` is walked rather than the whole document on purpose: the walk is the containment. Asking
 * for the stops inside one subtree is what makes "Tab stays in the drawer" true by construction
 * instead of by remembering to check a flag on every element behind it.
 */
export function focusableWithin(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isFocusable);
}

/**
 * Where Tab should land next inside the drawer, or `null` when there is nowhere to go.
 *
 * `active` is whatever has focus right now; `shift` is a backwards Tab. Wrapping is the whole
 * point: without it the walk runs off the end of the drawer and the next stop is behind the sheet.
 * A drawer with fewer stops than {@link MIN_DRAWER_STOPS} holds still instead of spinning, because
 * there is no cycle to make and a user pressing Tab in a one-button sheet means "leave".
 */
export function nextStop(stops: HTMLElement[], active: Element | null, shift = false): HTMLElement | null {
  if (stops.length === 0) return null;
  const at = active ? stops.indexOf(active as HTMLElement) : -1;
  if (at === -1) return shift ? stops[stops.length - 1] : stops[0];
  if (stops.length < MIN_DRAWER_STOPS) return null;
  const step = shift ? -1 : 1;
  return stops[(at + step + stops.length) % stops.length];
}

/**
 * The element that opens the drawer, to hand focus back to on close.
 *
 * Only the header's own toggle counts: a control with this exact accessible name is the one the
 * user pressed to get here. Returning focus to whatever happened to be focused before would land on
 * the chat — behind the drawer again — which is the state this module exists to end.
 */
export function findToggle(root: ParentNode, label = "Toggle bots list"): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>("button")].find((b) => b.getAttribute("aria-label") === label) ?? null;
}
