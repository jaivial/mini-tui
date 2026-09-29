/**
 * Two independent size controls, as in a browser: "interface" scales everything (chrome, spacing,
 * icons, text) like page zoom; "text" scales only reading text (transcript, notes, the prompt), so a
 * dense layout can keep its size while the words get larger. Both are fixed steps, not free sliders:
 * every step was checked on phone, tablet and desktop, and a stored value that is not a step snaps to one.
 */
export const UI_SCALES = [0.85, 0.9, 1, 1.1, 1.25, 1.4] as const;
export const TEXT_SCALES = [0.9, 1, 1.125, 1.25, 1.5] as const;

export function snap(value: unknown, steps: readonly number[], fallback = 1): number {
  const v = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return steps.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), steps[0]!);
}

/** One step up or down, stopping at the ends. */
export function stepScale(current: number, dir: 1 | -1, steps: readonly number[]): number {
  const i = steps.indexOf(snap(current, steps));
  return steps[Math.min(steps.length - 1, Math.max(0, i + dir))]!;
}

/**
 * The interface size actually applied. Under a finger every control is sized to 44px, and zooming
 * out would shrink that below what a fingertip can hit, so a touch screen never goes below 100%. The
 * choice is kept: the same setting on a laptop with a mouse still applies in full.
 */
export function effectiveUiScale(chosen: number, coarsePointer: boolean): number {
  return coarsePointer ? Math.max(1, chosen) : chosen;
}

export const percent = (v: number) => `${Math.round(v * 100)}%`;
