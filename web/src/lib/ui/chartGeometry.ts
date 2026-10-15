/**
 * The geometry of a generative bar/line chart, as plain numbers: no DOM, no runes, so `bun test`
 * can assert that every mark stays inside the viewBox (the browser half is
 * `components/ui/UiChart.svelte`, which only draws what this returns).
 *
 * Positions live on a BAND GRID: the plot is divided into one equal band per value and a mark
 * sits at the middle of its band. Positions used to be spread edge to edge (`i * (W-2*PAD)/(n-1)`,
 * the right scale for a line) while the bars were sized on an `n` divisor — so the first bar hung
 * half off the left edge and the last off the right, and both were clipped by the viewBox. The
 * same band grid is what the label row centres each label on, so a label always sits under its mark.
 */
export const CHART_W = 320;
export const CHART_H = 140;
export const CHART_PAD = 6;
/** Room the label row takes under the plot, inside the same viewBox. */
export const CHART_LABEL_H = 14;
/** Gap between neighbouring bars, as a fraction of a band. */
export const CHART_BAR_GAP = 0.28;

export interface ChartPoint {
  value: number;
  /** Centre of this value's band, in viewBox units. */
  x: number;
  y: number;
}

export interface ChartPlot {
  points: ChartPoint[];
  /** y of the zero line: bars grow up from it and down to it. */
  zeroY: number;
  /** Width of one bar: a band's width less the gap on both sides. */
  barWidth: number;
  band: number;
  plotH: number;
}

export function chartPlot(values: number[]): ChartPlot {
  const plotH = CHART_H - CHART_PAD - CHART_LABEL_H;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const band = (CHART_W - CHART_PAD * 2) / Math.max(1, values.length);
  const y = (v: number) => CHART_PAD + (1 - (v - min) / span) * plotH;
  const points = values.map((v, i) => ({ value: v, x: CHART_PAD + band * (i + 0.5), y: y(v) }));
  return { points, zeroY: y(0), barWidth: Math.max(2, band * (1 - CHART_BAR_GAP)), band, plotH };
}