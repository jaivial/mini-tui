/** Prompt-field sizing: one line empty, whole-line steps, a cap of five, then scroll. */
import { describe, expect, test } from "bun:test";
import { MAX_LINES, fitHeight } from "../web/src/lib/grow";

const LINE = 26;
const PAD = 18;
const at = (lines: number) => lines * LINE + PAD; // what the mirror measures for `lines` lines of text

describe("fitHeight", () => {
  test("empty is exactly one line", () => {
    expect(fitHeight(at(1), LINE, PAD)).toEqual({ height: 44, lines: 1, scrolls: false });
  });
  test("grows one whole line at a time", () => {
    expect([1, 2, 3, 4, 5].map((n) => fitHeight(at(n), LINE, PAD).height)).toEqual([44, 70, 96, 122, 148]);
  });
  test("five lines is the cap and still does not scroll", () => {
    expect(fitHeight(at(5), LINE, PAD)).toEqual({ height: 148, lines: 5, scrolls: false });
  });
  test("past five lines the height stays put and the field scrolls", () => {
    for (const n of [6, 7, 40]) {
      const fit = fitHeight(at(n), LINE, PAD);
      expect(fit.height).toBe(148);
      expect(fit.scrolls).toBe(true);
      expect(fit.lines).toBe(n);
    }
  });
  test("a few px of measurement noise never changes the line count", () => {
    expect(fitHeight(at(3) + 4, LINE, PAD).lines).toBe(3);
    expect(fitHeight(at(3) - 4, LINE, PAD).lines).toBe(3);
  });
  test("it can shrink as well as grow", () => {
    expect(fitHeight(at(4), LINE, PAD).height).toBeGreaterThan(fitHeight(at(2), LINE, PAD).height);
  });
  test("nonsense measurements fall back to one line instead of NaN or zero", () => {
    for (const bad of [NaN, -50, 0, Infinity]) {
      const fit = fitHeight(bad, LINE, PAD);
      expect(Number.isFinite(fit.height)).toBe(true);
      expect(fit.lines).toBeGreaterThanOrEqual(1);
    }
    expect(fitHeight(at(2), NaN, PAD).height).toBeGreaterThan(0);
    expect(fitHeight(at(2), 0, PAD).height).toBeGreaterThan(0);
  });
  test("the cap is a parameter, and the default is five", () => {
    expect(MAX_LINES).toBe(5);
    expect(fitHeight(at(9), LINE, PAD, 3).height).toBe(3 * LINE + PAD);
  });
});
