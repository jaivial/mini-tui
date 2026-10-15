/** The generative chart's geometry: every mark inside the viewBox, and a label under its own mark.
 *
 *  Regression: positions were spread edge to edge (`i * (W-2*PAD)/(n-1)` — the right scale for a
 *  line) while bars were sized on an `n` divisor, so the first bar hung off the left edge and the
 *  last off the right; each was clipped by the viewBox. The label row was also a separate flex row
 *  wider than the plot, spread with space-between, so labels never lined up with their bars. */
import { describe, expect, test } from "bun:test";
import { chartPlot, CHART_W, CHART_H, CHART_PAD, CHART_LABEL_H } from "../web/src/lib/ui/chartGeometry";

describe("chartPlot", () => {
  test("bars stay inside the viewBox on both edges", () => {
    for (const values of [[10, 20, 30], [5], [1, 1, 1, 1, 1], [-3, 7, 2], [0, 0, 0]]) {
      const p = chartPlot(values);
      for (const pt of p.points) {
        expect(pt.x - p.barWidth / 2).toBeGreaterThanOrEqual(0);
        expect(pt.x + p.barWidth / 2).toBeLessThanOrEqual(CHART_W);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThanOrEqual(CHART_H - CHART_LABEL_H);
      }
    }
  });

  test("the first and last bars keep a visible margin instead of being cut off", () => {
    const p = chartPlot([10, 20, 30]);
    const first = p.points[0]!.x - p.barWidth / 2;
    const last = p.points[2]!.x + p.barWidth / 2;
    expect(first).toBeGreaterThan(CHART_PAD * 0.5);
    expect(CHART_W - last).toBeGreaterThan(CHART_PAD * 0.5);
  });

  test("each point sits at the centre of its own band, so labels align", () => {
    const values = [4, 8, 15, 16];
    const p = chartPlot(values);
    expect(p.points).toHaveLength(values.length);
    p.points.forEach((pt, i) => expect(pt.x).toBeCloseTo(CHART_PAD + p.band * (i + 0.5), 6));
  });

  test("points are ordered and evenly spaced", () => {
    const p = chartPlot([3, 1, 2, 9, 4]);
    for (let i = 1; i < p.points.length; i++) {
      expect(p.points[i]!.x - p.points[i - 1]!.x).toBeCloseTo(p.band, 6);
    }
  });

  test("the zero line sits inside the plot area and negatives fall below it", () => {
    const p = chartPlot([-5, 10]);
    expect(p.zeroY).toBeGreaterThanOrEqual(0);
    expect(p.zeroY).toBeLessThanOrEqual(CHART_H - CHART_LABEL_H);
    // SVG y grows downward, so a negative value draws BELOW the zero line.
    expect(p.points[0]!.y).toBeGreaterThan(p.zeroY);
    expect(p.points[1]!.y).toBeLessThan(p.zeroY);
  });

  test("a single value still gets a usable band and bar", () => {
    const p = chartPlot([7]);
    expect(p.points).toHaveLength(1);
    expect(p.barWidth).toBeGreaterThan(0);
    expect(Number.isFinite(p.points[0]!.y)).toBe(true);
  });

  test("an empty series does not divide by zero", () => {
    const p = chartPlot([]);
    expect(p.points).toHaveLength(0);
    expect(Number.isFinite(p.band)).toBe(true);
    expect(p.barWidth).toBeGreaterThanOrEqual(0);
  });

  test("all-equal values do not collapse to NaN", () => {
    for (const pt of chartPlot([5, 5, 5]).points) expect(Number.isFinite(pt.y)).toBe(true);
  });
});