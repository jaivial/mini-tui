/**
 * The width of the right panel (Tasks, Browser), apart from any UI.
 *
 * No upper limit: a drag may take the panel as wide as the window, and past the snap zone at the
 * left edge it becomes full screen (the chat is then hidden, not squeezed to a useless strip).
 * Pure functions, so the arithmetic of a drag is testable without a browser.
 */

/** Below this the panel stops being readable. */
export const PANEL_MIN = 280;
/** A chat narrower than this is useless: a drag that would leave less snaps to full screen. */
export const SNAP_CHAT = 200;
/** The width when nothing was chosen: what `min(26rem, 38%)` used to give. */
export const PANEL_DEFAULT = 416;
/** Arrow-key step on the separator, and its Shift step. */
export const KEY_STEP = 24;
export const KEY_STEP_BIG = 120;

export interface PanelSize {
  /** Pixels; null = the default. */
  width: number | null;
  full: boolean;
}

/** A kept width (or junk from an older save) made safe: below the minimum comes back up. */
export function clampPanelWidth(px: unknown): number | null {
  if (typeof px !== "number" || !Number.isFinite(px)) return null;
  return Math.max(PANEL_MIN, Math.round(px));
}

/**
 * The size a drag asks for. The pointer is `x` pixels from the container's left edge and the
 * container is `total` pixels wide (both in the same, zoom-corrected, pixels).
 */
export function dragSize(x: number, total: number): PanelSize {
  const width = total - x;
  if (total - width < SNAP_CHAT) return { width: null, full: true };
  return { width: Math.max(PANEL_MIN, Math.round(width)), full: false };
}

/** What the panel is drawn at: full screen, the kept width (never wider than the room), or the default. */
export function effectiveWidth(size: PanelSize, total: number): number {
  if (size.full) return total;
  const want = size.width ?? Math.min(PANEL_DEFAULT, Math.round(total * 0.38));
  return Math.min(total, Math.max(Math.min(PANEL_MIN, total), want));
}

/** Keyboard on the separator: ←/→ grow and shrink, Home = full screen, End = the minimum. */
export function keySize(key: string, shift: boolean, size: PanelSize, total: number): PanelSize | null {
  const current = effectiveWidth(size, total);
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  if (key === "ArrowLeft") return dragSize(total - (current + step), total);
  if (key === "ArrowRight") return size.full ? { width: Math.max(PANEL_MIN, total - SNAP_CHAT - step), full: false } : { width: Math.max(PANEL_MIN, current - step), full: false };
  if (key === "Home") return { width: size.width, full: true };
  if (key === "End") return { width: PANEL_MIN, full: false };
  return null;
}

const KEY = "mini.panel.size";

export function loadPanelSize(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): PanelSize {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<PanelSize> | null;
    return { width: clampPanelWidth(raw?.width), full: raw?.full === true };
  } catch {
    return { width: null, full: false };
  }
}

export function savePanelSize(size: PanelSize, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(size));
  } catch {
    // private mode / quota: the size is just not kept
  }
}
