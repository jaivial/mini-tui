/**
 * The small amount of maths the benchmark charts need: a linear scale, tick steps and the two number
 * formats used in the tooltips. Pure and dependency-free, so the prerender and the unit tests can
 * import it without a browser.
 */

/** Maps a value from [d0, d1] to the pixel range [r0, r1] (inverted: bigger value, smaller y). */
export function scale(v: number, d0: number, d1: number, r0: number, r1: number): number {
  if (d1 === d0) return r0;
  return r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** The longest label above the longest bar, so the plot never runs into the right edge. */
export function maxLabel(values: number[], suffix = " s"): string {
  return String(Math.max(...values)) + suffix;
}

/** A line of text for a tooltip: one emphasised value and its label. */
export interface TipLine {
  label: string;
  value: string;
  /** Draw the swatch in the series colour of this line. */
  color?: "mini" | "pi" | "muted";
}

export const sec = (v: number): string => `${v.toFixed(1)} s`;
export const times = (v: number): string => `${v.toFixed(2).replace(/0$/, "")}x`;