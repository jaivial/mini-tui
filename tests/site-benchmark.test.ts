/** The benchmark charts: the maths behind them, and the figures they draw, checked against the report. */
import { describe, expect, test } from "bun:test";
import { scale } from "../site/src/lib/chart";
import { AB, AB_TOTAL, REPS, ROUNDS, TASKS, TASKS_WON } from "../site/src/lib/benchmark-data";

describe("scale", () => {
  test("maps a value linearly onto a pixel range, inverted for y", () => {
    expect(scale(0, 0, 100, 0, 250)).toBe(0);
    expect(scale(50, 0, 100, 0, 250)).toBe(125);
    expect(scale(100, 0, 100, 0, 250)).toBe(250);
    expect(scale(1, 0.4, 4.6, 212, 0)).toBeCloseTo(181.7, 1);
    expect(scale(0.98, 0.4, 4.6, 212, 0)).toBeCloseTo(182.7, 1);
  });
  test("a flat domain does not divide by zero", () => {
    expect(scale(5, 3, 3, 10, 90)).toBe(10);
  });
});

describe("the per-task medians", () => {
  test("ten tasks, every ratio consistent with its own two numbers", () => {
    expect(TASKS).toHaveLength(10);
    for (const t of TASKS) {
      expect(t.ratio).toBeCloseTo(Math.round((t.mini / t.pi) * 100) / 100, 1);
    }
  });
  test("the page's claim of a tie holds: as many tasks won as lost", () => {
    expect(TASKS_WON).toBe(5);
    expect(TASKS.filter((t) => t.ratio >= 1)).toHaveLength(5);
  });
  test("the ranges are the ones printed in the report", () => {
    const t10 = TASKS.find((t) => t.id === "t10")!;
    expect(t10.miniRange).toBe("12.0 – 94.2");
    expect(t10.piRange).toBe("22.7 – 67.4");
  });
});

describe("the rounds", () => {
  test("R1 is the 3.65x slow start and R6 the 0.98x median", () => {
    expect(ROUNDS[0].ratio).toBe(3.65);
    expect(ROUNDS.at(-1)!.ratio).toBe(0.98);
    expect(ROUNDS.at(-1)!.current).toBe(true);
  });
  test("R5 is flagged as the single run the reps did not reproduce", () => {
    const r5 = ROUNDS.find((r) => r.round === "R5")!;
    expect(r5.ratio).toBe(0.69);
    expect(r5.variance).toBe(true);
  });
  test("the three fresh reps are the range behind R6, and their median is R6", () => {
    expect(REPS.map((r) => r.ratio)).toEqual([1.13, 0.98, 0.93]);
    const med = [...REPS.map((r) => r.ratio)].sort((a, b) => a - b)[1];
    expect(med).toBe(ROUNDS.at(-1)!.ratio);
  });
});

describe("the prompt-clause A/B", () => {
  test("every ratio matches its own two medians", () => {
    for (const r of AB) expect(r.ratio).toBeCloseTo(Math.round((r.c / r.a) * 100) / 100, 1);
  });
  test("the two tasks that dominated the losses are the two biggest wins", () => {
    const sorted = [...AB].sort((a, b) => a.ratio - b.ratio);
    expect(sorted[0].id).toBe("t10");
    expect(sorted[0].ratio).toBe(0.39);
    expect(sorted[0].paired).toBe("5/5");
    expect(sorted[1].id).toBe("t7");
    expect(sorted[1].ratio).toBe(0.61);
    expect(sorted[1].paired).toBe("3/3");
  });
  test("the A/B is not a clean sweep: t5 and t9 are a wash or worse", () => {
    expect(AB.find((r) => r.id === "t5")!.ratio).toBe(1.18);
    expect(AB.find((r) => r.id === "t5")!.paired).toBe("0/4");
    expect(AB.find((r) => r.id === "t9")!.ratio).toBe(1.07);
  });
  test("the totals add up to the row in the report", () => {
    const a = AB.reduce((s, r) => s + r.a, 0);
    const c = AB.reduce((s, r) => s + r.c, 0);
    expect(a).toBeCloseTo(AB_TOTAL.a, 1);
    // The report's 121.3 s is the sum it printed; the per-task medians re-summed are 121.2 s.
    expect(c).toBeCloseTo(121.2, 1);
    expect(Math.abs(c - AB_TOTAL.c)).toBeLessThan(0.15);
    expect(c / a).toBeCloseTo(AB_TOTAL.ratio, 2);
    expect(AB.reduce((s, r) => s + r.reps, 0)).toBe(24);
  });
});