/** The width of a pane's side panel: the clamp, the drag, and what a kept width comes back as. */
import { describe, expect, test } from "bun:test";
import { CHAT_MIN, SIDE_MAX, SIDE_MIN, clampSideWidth, sideWidthAt, sideWidthStyle } from "../web/src/lib/sidePanel";

describe("clampSideWidth", () => {
  test("a width inside the limits comes back as it is, rounded to a pixel", () => {
    expect(clampSideWidth(320)).toBe(320);
    expect(clampSideWidth(320.4)).toBe(320);
    expect(clampSideWidth(320.6)).toBe(321);
  });
  test("a drag can ask for less or more than the limits allow: both ends hold", () => {
    expect(clampSideWidth(40)).toBe(SIDE_MIN);
    expect(clampSideWidth(4000)).toBe(SIDE_MAX);
  });
  test("junk from an older save means no width kept, not a broken panel", () => {
    for (const junk of [undefined, null, "", "320", Number.NaN, Infinity, {}]) expect(clampSideWidth(junk as never)).toBeNull();
  });
});

describe("sideWidthAt", () => {
  // A pane from 100 to 700: 600 px wide. Its panel's right edge sits at 700.
  const paneLeft = 100;
  const right = 700;
  test("the width is the panel's right edge minus the pointer", () => {
    expect(sideWidthAt(380, right, paneLeft)).toBe(320);
  });
  test("dragging past the limits stops at them", () => {
    expect(sideWidthAt(690, right, paneLeft)).toBe(SIDE_MIN);
    expect(sideWidthAt(0, right, paneLeft)).toBe(Math.min(SIDE_MAX, 600 - CHAT_MIN));
  });
  test("a narrow pane keeps something for the chat: the panel never takes the whole pane", () => {
    // A 500px pane: the panel takes what is left after the chat keeps its share.
    const narrow = sideWidthAt(0, 600, 100)!;
    expect(narrow).toBe(500 - CHAT_MIN);
    expect(narrow).toBeLessThanOrEqual(SIDE_MAX);
  });
  test("a pane too small for panel and chat alike says so, and the width is left as it was", () => {
    expect(sideWidthAt(300, 500, 100)).toBeNull(); // 400 - 256 < 200
    expect(sideWidthAt(300, CHAT_MIN + SIDE_MIN + 100, 100)).toBe(SIDE_MIN); // exactly enough
  });
  test("the drag measures in the pane's own zoomed pixels on both sides, so it is exact", () => {
    // At 140% interface size the rect and clientX are both in those pixels: the widths are in them too.
    const left = 100, wide = 1200;
    expect(sideWidthAt(left + (wide - 500), left + wide, left)).toBe(500);
    // The same pane and the same drag at 140%: every measure is in the zoomed pixel, so the width is too.
    expect(sideWidthAt((left + wide - 500 * 1.4) / 1.4, (left + wide) / 1.4, left / 1.4)).toBeCloseTo(500, 5);
  });
});

describe("sideWidthStyle", () => {
  test("a kept width becomes the variable the panel's width is set from", () => {
    expect(sideWidthStyle(320)).toBe("--side-w: 320px");
  });
  test("nothing kept (or junk) leaves the panel's own default in place", () => {
    expect(sideWidthStyle(null)).toBe("");
    expect(sideWidthStyle("wide" as never)).toBe("");
  });
  test("a kept width outside the limits is brought back inside them", () => {
    expect(sideWidthStyle(99)).toBe(`--side-w: ${SIDE_MIN}px`);
  });
  test("the least a panel may be, and what a pane must keep for its chat, stay in step", () => {
    expect(CHAT_MIN).toBeGreaterThan(0);
    expect(SIDE_MIN).toBeLessThan(SIDE_MAX);
  });
});
