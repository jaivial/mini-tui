/**
 * The width of a pane's side panel (the notes, or the terminal), apart from any UI.
 *
 * A panel has a size that reads well without anybody reaching for it; a width the user chose is kept
 * for that pane and wins over it while it still fits. Pure functions, so the clamp and the arithmetic
 * of a drag are testable without a browser.
 */

/** Below this the panel stops being a panel: a few words to a line are not notes. */
export const SIDE_MIN = 200;
/** Past this a column of prose becomes a line of prose. */
export const SIDE_MAX = 640;
/** What the drag must leave for the chat beside the panel (16rem, as the CSS caps it). */
export const CHAT_MIN = 256;

/** A kept width, or junk from an older save, made safe to use. Null stays null (nothing kept). */
export function clampSideWidth(px: unknown): number | null {
  if (typeof px !== "number" || !Number.isFinite(px)) return null;
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(px)));
}

/**
 * The width a drag asks for. The pointer is `x` viewport pixels from the window's left, the panel's
 * right edge is at `right` and the pane's left edge at `paneLeft`, all in the same pixels (the pane's
 * own zoom included on both sides), so the width comes out exact at any interface size.
 *
 * Null when the pane is too small to give the panel its least: the caller keeps the width it had, and
 * the panel lays itself over the chat instead (the chat is still one drag away).
 */
export function sideWidthAt(x: number, right: number, paneLeft: number): number | null {
  const widest = Math.min(SIDE_MAX, right - paneLeft - CHAT_MIN);
  if (widest < SIDE_MIN) return null;
  return Math.min(widest, Math.max(SIDE_MIN, right - x));
}

/** The inline value the panel's width is set from: the width kept, else the panel's own default. */
export function sideWidthStyle(px: number | null): string {
  const w = clampSideWidth(px);
  return w ? `--side-w: ${w}px` : "";
}
