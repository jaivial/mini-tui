/**
 * The side panel's focus handoff, as a rule with no runes in it.
 *
 * Notes and Agents are code-split (E28): their chunks are fetched the first time the panel is
 * opened, so the component that owns the focusable element **does not exist yet** at the moment
 * the click asks for focus. `tick()` only flushes what is already there — the panel arrives a
 * network round trip later — so a caller that does `await tick(); notes?.focus()` silently drops
 * the request and focus falls back to the prompt bar. Measured: 5 samples up to 3.5 s, focus on
 * the composer on every one of them, while the panel itself was open and usable.
 *
 * So a request is **kept until something can take it**. `deliverSideFocus` is the whole rule: it
 * delivers when the panel is mounted and returns the request untouched when it is not, which is
 * what lets the caller retry when the `{#await}` block finally binds its component.
 *
 * NotesPanel has its own version of this inside it (`wantFocus`, for a textarea that is not
 * mounted yet); this is the layer above it — the panel not being mounted *at all*.
 */

/** The right side panel's tabs. Mirrors `SideTab` in `stores/panes.svelte.ts`. */
export type SideTab = "notes" | "agents" | "terminal";

/** What a mounted side panel has to offer: a way to take the focus. */
export interface SidePanelHandle {
  focus: () => void;
}

/** The outcome of one delivery attempt. */
export interface SideFocusResult {
  /** The request still waiting, or null once somebody took it. */
  request: SideTab | null;
  /** Whether this call is the one that moved the focus. */
  focused: boolean;
}

/**
 * Try to hand `request` to its panel. A panel that is not mounted yet keeps the request: the
 * caller runs this again when the lazy chunk lands, and only then is it spent.
 */
export function deliverSideFocus(
  request: SideTab | null,
  panels: Partial<Record<SideTab, SidePanelHandle | null | undefined>>,
): SideFocusResult {
  if (request === null) return { request: null, focused: false };
  const panel = panels[request];
  if (!panel) return { request, focused: false };
  panel.focus();
  return { request: null, focused: true };
}
