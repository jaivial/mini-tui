/**
 * How tall the prompt field should be: whole lines, at least one, at most `max`, then it scrolls.
 * Pure, so the rule is testable without a browser; the component supplies the measurements.
 *
 * `contentHeight` is the height of the text *including* the field's vertical padding, as measured on
 * the mirror. Snapping to whole lines keeps the box from ending a few pixels short of a line and
 * clipping its descenders, and makes every step exactly one line tall.
 */
export const MAX_LINES = 5;
const FALLBACK_LINE = 26;

export interface Fit {
  /** Box height in px (padding included). */
  height: number;
  /** Lines the text needs, uncapped. */
  lines: number;
  /** The text needs more than `max` lines, so the field scrolls. */
  scrolls: boolean;
}

export function fitHeight(contentHeight: number, line: number, pad: number, max: number = MAX_LINES): Fit {
  const lh = Number.isFinite(line) && line > 0 ? line : FALLBACK_LINE;
  const p = Number.isFinite(pad) && pad > 0 ? pad : 0;
  const raw = Number.isFinite(contentHeight) ? (contentHeight - p) / lh : 1;
  const lines = Math.max(1, Math.round(raw));
  return { height: Math.min(lines, max) * lh + p, lines, scrolls: lines > max };
}
