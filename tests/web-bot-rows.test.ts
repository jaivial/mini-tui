import { describe, expect, test } from "bun:test";
import { botProgress, progressLabel, runningLabel } from "../web/src/lib/botRows";
import type { SessionTask } from "../web/src/lib/types";

const card = (done: string[], pending: string[], left: string[]): SessionTask => ({
  id: "s-1",
  title: "Ship the sidebar",
  description: "",
  todos: { done, pending, left },
  updatedAt: 1,
});

describe("botProgress", () => {
  test("counts every to-do on the card, ticked or not", () => {
    expect(botProgress(card(["a", "b"], ["c"], ["d", "e"]))).toEqual({ done: 2, total: 5, running: 0 });
  });

  test("a bot with no card reports no progress at all, not 0/0", () => {
    expect(botProgress(null)).toEqual({ done: 0, total: 0, running: 0 });
    expect(botProgress(undefined, 2)).toEqual({ done: 0, total: 0, running: 2 });
  });

  test("the delegate count comes in beside the card's numbers", () => {
    expect(botProgress(card(["a"], [], []), 3)).toEqual({ done: 1, total: 1, running: 3 });
  });
});

describe("progressLabel", () => {
  test("reads done over total", () => {
    expect(progressLabel(botProgress(card(["a", "b", "c"], ["d"], [])))).toBe("3/4");
  });

  test("is empty with no card, so the row carries no hollow 0/0", () => {
    expect(progressLabel(botProgress(null))).toBe("");
    expect(progressLabel(botProgress(card([], [], [])))).toBe("");
  });
});

describe("runningLabel", () => {
  test("plural-aware, and empty when nothing is working", () => {
    expect(runningLabel(botProgress(null, 1))).toBe("1 running");
    expect(runningLabel(botProgress(null, 2))).toBe("2 running");
    expect(runningLabel(botProgress(null, 0))).toBe("");
  });
});