/** The right panel's width: unbounded drags, the snap to full screen, keys and persistence. */
import { describe, expect, test } from "bun:test";
import { KEY_STEP, PANEL_DEFAULT, PANEL_MIN, SNAP_CHAT, clampPanelWidth, dragSize, effectiveWidth, keySize, loadPanelSize, savePanelSize } from "../web/src/lib/panelWidth";

describe("dragSize", () => {
  test("the width is the container's right edge minus the pointer, with no upper limit", () => {
    expect(dragSize(1000, 1600)).toEqual({ width: 600, full: false });
    expect(dragSize(300, 1600)).toEqual({ width: 1300, full: false }); // far past the old 640 cap
  });
  test("leaving the chat less than the snap zone becomes full screen", () => {
    expect(dragSize(SNAP_CHAT - 1, 1600)).toEqual({ width: null, full: true });
    expect(dragSize(0, 1600).full).toBe(true);
    expect(dragSize(SNAP_CHAT, 1600).full).toBe(false);
  });
  test("dragging to the right stops at the minimum", () => {
    expect(dragSize(1590, 1600)).toEqual({ width: PANEL_MIN, full: false });
  });
});

describe("effectiveWidth", () => {
  test("full screen is the whole container", () => {
    expect(effectiveWidth({ width: 500, full: true }, 1400)).toBe(1400);
  });
  test("a kept width wider than the window is drawn at the window", () => {
    expect(effectiveWidth({ width: 1800, full: false }, 1200)).toBe(1200);
  });
  test("nothing kept is the old default (26rem, or 38% when narrower)", () => {
    expect(effectiveWidth({ width: null, full: false }, 2000)).toBe(PANEL_DEFAULT);
    expect(effectiveWidth({ width: null, full: false }, 1000)).toBe(380);
    expect(effectiveWidth({ width: null, full: false }, 600)).toBe(PANEL_MIN); // 38% would be 228 < min
  });
});

describe("keySize", () => {
  test("← grows, → shrinks, Home is full screen, End is the minimum", () => {
    const s = { width: 600, full: false };
    expect(keySize("ArrowLeft", false, s, 1600)).toEqual({ width: 600 + KEY_STEP, full: false });
    expect(keySize("ArrowRight", false, s, 1600)).toEqual({ width: 600 - KEY_STEP, full: false });
    expect(keySize("Home", false, s, 1600)).toEqual({ width: 600, full: true });
    expect(keySize("End", false, s, 1600)).toEqual({ width: PANEL_MIN, full: false });
    expect(keySize("a", false, s, 1600)).toBeNull();
  });
  test("growing into the snap zone goes full screen; shrinking out of it comes back", () => {
    const near = { width: 1600 - SNAP_CHAT - 5, full: false };
    expect(keySize("ArrowLeft", false, near, 1600)?.full).toBe(true);
    const back = keySize("ArrowRight", false, { width: null, full: true }, 1600)!;
    expect(back.full).toBe(false);
    expect(back.width).toBeLessThan(1600 - SNAP_CHAT);
  });
});

describe("persistence", () => {
  test("round-trips, and junk falls back to the default", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    savePanelSize({ width: 900, full: true }, storage);
    expect(loadPanelSize(storage)).toEqual({ width: 900, full: true });
    mem.set("mini.panel.size", "{not json");
    expect(loadPanelSize(storage)).toEqual({ width: null, full: false });
    expect(clampPanelWidth(10)).toBe(PANEL_MIN);
    expect(clampPanelWidth("x")).toBeNull();
  });
});
