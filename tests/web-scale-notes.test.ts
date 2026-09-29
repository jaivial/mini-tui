/** Size steps and the notes editor's status words. */
import { describe, expect, test } from "bun:test";
import { TEXT_SCALES, UI_SCALES, percent, snap, stepScale } from "../web/src/lib/scale";
import { counts, statusText } from "../web/src/lib/notes";

describe("scale", () => {
  test("a stored value snaps to the nearest step; junk is the default", () => {
    expect(snap(1.24, UI_SCALES)).toBe(1.25);
    expect(snap("1.1", UI_SCALES)).toBe(1.1);
    expect(snap(7, UI_SCALES)).toBe(1.4);
    expect(snap(0.1, UI_SCALES)).toBe(0.85);
    for (const junk of [undefined, null, "", "big", Number.NaN, -1, 0, {}]) expect(snap(junk, UI_SCALES)).toBe(1);
  });
  test("stepping stops at both ends", () => {
    expect(stepScale(1, 1, UI_SCALES)).toBe(1.1);
    expect(stepScale(1, -1, UI_SCALES)).toBe(0.9);
    expect(stepScale(1.4, 1, UI_SCALES)).toBe(1.4);
    expect(stepScale(0.85, -1, UI_SCALES)).toBe(0.85);
    expect(stepScale(1.5, 1, TEXT_SCALES)).toBe(1.5);
  });
  test("both scales include 100%, and are ordered", () => {
    for (const steps of [UI_SCALES, TEXT_SCALES]) {
      expect(steps).toContain(1);
      expect([...steps].sort((a, b) => a - b)).toEqual([...steps]);
    }
    expect(percent(1.125)).toBe("113%");
    expect(percent(0.85)).toBe("85%");
  });
});

describe("notes status", () => {
  const now = 1_000_000;
  test("every state has words", () => {
    expect(statusText({ kind: "loading" })).toBe("Loading");
    expect(statusText({ kind: "dirty" })).toBe("Unsaved changes");
    expect(statusText({ kind: "saving" })).toBe("Saving");
    expect(statusText({ kind: "error", message: "offline" })).toBe("Not saved");
    expect(statusText({ kind: "conflict", theirs: "x", theirsAt: 1 })).toBe("Changed somewhere else");
    expect(statusText({ kind: "saved", at: 0 }, now)).toBe("Nothing saved yet");
  });
  test("saved says how long ago, coarsely", () => {
    expect(statusText({ kind: "saved", at: now - 1000 }, now)).toBe("Saved");
    expect(statusText({ kind: "saved", at: now - 30_000 }, now)).toBe("Saved 30s ago");
    expect(statusText({ kind: "saved", at: now - 5 * 60_000 }, now)).toBe("Saved 5m ago");
  });
  test("counts words and characters (emoji count once)", () => {
    expect(counts("")).toEqual({ words: 0, chars: 0 });
    expect(counts("   \n\t ")).toEqual({ words: 0, chars: 6 });
    expect(counts("fix the  retry\nthen ship 🚀")).toEqual({ words: 6, chars: 26 });
  });
});

describe("touch floor", () => {
  test("a touch screen never zooms the interface below 100%; a mouse gets the full choice", async () => {
    const { effectiveUiScale } = await import("../web/src/lib/scale");
    expect(effectiveUiScale(0.85, true)).toBe(1);
    expect(effectiveUiScale(1.25, true)).toBe(1.25);
    expect(effectiveUiScale(0.85, false)).toBe(0.85);
  });
});
