/**
 * The palette inside the user's chat bubble, held to the bubble each mode paints.
 *
 * The defect these exist for was measured live against the deployed build, in
 * dark mode, with a link, a quote, inline code and a code block inside one user
 * message: the link read 1.67:1 and the quote 1.01:1 — zero ink pixels in the
 * screenshot, so not "low contrast" but literally invisible. `--color-bubble-user`
 * inverts with the mode (near-black in light, near-white in dark) and the prose
 * inside it carried literals written for the near-black bubble.
 *
 * Every number below is asserted, not eyeballed, so an edit to either mode's
 * bubble cannot quietly drop a step below its bar.
 */
import { describe, expect, test } from "bun:test";
import { contrast } from "../web/src/lib/terminalPalette";
import {
  AA_BOUNDARY,
  AA_HAIRLINE,
  AA_TEXT,
  BUBBLE_PALETTE,
  DARK_BUBBLE,
  INK_ROLES,
  LIGHT_BUBBLE,
  ROLE_BAR,
  bubbleOf,
  composite,
  paletteFor,
  roleContrast,
  worstRole,
} from "../web/src/lib/bubblePalette";

describe("every step inside the bubble clears its bar, in BOTH modes", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const [role, bar] of Object.entries(ROLE_BAR)) {
      test(`${mode}/${role} reaches ${bar}:1`, () => {
        const ratio = roleContrast(role as never, mode, contrast);
        expect(ratio).toBeGreaterThanOrEqual(bar);
      });
    }
  }
});

describe("the defect: dark mode was invisible", () => {
  // The measured numbers, pinned so a regression to them is caught even if a
  // future bar were loosened. These are what the deployed build rendered.
  test("the link on the light bubble clears AA by a wide margin", () => {
    expect(roleContrast("link", "light", contrast)).toBeCloseTo(8.9, 1);
  });

  test("the quote on the light bubble clears AA", () => {
    expect(roleContrast("quote", "light", contrast)).toBeCloseTo(9.03, 1);
  });

  test("the dark link is the DEEP blue, not the light one", () => {
    // 1.67:1 was the light blue on the now-near-white bubble. The dark step is
    // a different colour, not the same one at another alpha.
    expect(BUBBLE_PALETTE.dark.link).not.toBe(BUBBLE_PALETTE.light.link);
    expect(roleContrast("link", "dark", contrast)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test("the dark quote is not the light quote either", () => {
    expect(BUBBLE_PALETTE.dark.quote).not.toBe(BUBBLE_PALETTE.light.quote);
    expect(roleContrast("quote", "dark", contrast)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test("the code chip's TEXT is readable on it in both modes", () => {
    // The chip is a translucent panel; what a person reads is the bubble's own
    // ink on top of it, so that is the pair that has to clear AA.
    for (const mode of ["light", "dark"] as const) {
      const chip = composite(paletteFor(mode).chip, bubbleOf(mode).bg);
      expect(contrast(bubbleOf(mode).ink, chip)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  test("the mirror marker clears the 3:1 a 2px boundary needs, in both modes", () => {
    // Before: 0.45 alpha of the same green on both. 2.70:1 on the light bubble
    // and 1.35:1 on the dark one — under the bar in BOTH modes, so this one was
    // never right and the queue had simply never looked.
    expect(roleContrast("mirror", "light", contrast)).toBeGreaterThanOrEqual(AA_BOUNDARY);
    expect(roleContrast("mirror", "dark", contrast)).toBeGreaterThanOrEqual(AA_BOUNDARY);
  });
});

describe("the panels follow the bubble instead of assuming one", () => {
  test("the chip is a wash of ink over the bubble, and it inverts", () => {
    // Light bubble + white overlay -> LIGHTER than the bubble. Dark bubble +
    // ink overlay -> DARKER. A single literal cannot do both, which is the
    // whole cause.
    expect(composite(paletteFor("light").chip, LIGHT_BUBBLE.bg) !== LIGHT_BUBBLE.bg).toBe(true);
    const lightChip = composite(paletteFor("light").chip, LIGHT_BUBBLE.bg);
    const darkChip = composite(paletteFor("dark").chip, DARK_BUBBLE.bg);
    expect(contrast(lightChip, LIGHT_BUBBLE.bg)).toBeGreaterThan(1);
    expect(contrast(darkChip, DARK_BUBBLE.bg)).toBeGreaterThan(1);
  });

  test("the bubbles themselves are opposites, which is why one value cannot serve both", () => {
    // Each mode's bubble is legible against its own ink (both carry text at
    // well over 10:1), and the two modes are exact opposites: light mode is a
    // near-black bubble with near-white ink, dark mode the reverse. A single
    // literal for a step inside the bubble can therefore only ever be right in
    // one of them.
    expect(contrast(LIGHT_BUBBLE.bg, LIGHT_BUBBLE.ink)).toBeGreaterThan(10);
    expect(contrast(DARK_BUBBLE.bg, DARK_BUBBLE.ink)).toBeGreaterThan(10);
    expect(LIGHT_BUBBLE.bg === DARK_BUBBLE.bg).toBe(false);
    expect(LIGHT_BUBBLE.ink === DARK_BUBBLE.ink).toBe(false);
    // Ink lighter than bubble in light mode, darker than it in dark mode.
    expect(LIGHT_BUBBLE.ink > LIGHT_BUBBLE.bg).toBe(true);
    expect(DARK_BUBBLE.ink < DARK_BUBBLE.bg).toBe(true);
  });

  test("a translucent step is measured composited, alpha included", () => {
    // 50% white over black is grey, not white. Dropping the alpha would report
    // a contrast nobody's eyes ever get.
    expect(composite("rgb(255 255 255 / 0.5)", "#000000")).toBe("#808080");
    expect(composite("rgb(255 255 255 / 1)", "#000000")).toBe("#ffffff");
    expect(composite("rgb(0 0 0 / 0)", "#1f1f26")).toBe("#1f1f26");
    // Not a colour at all: hand it back untouched rather than emit NaN hex or,
    // worse, silently measure the BACKGROUND against itself (which reported a
    // perfect 1.00:1 for every plain hex before this was caught).
    expect(composite("var(--algo)", "#1f1f26")).toBe("var(--algo)");
    expect(composite("#9dc0ff", "#1f1f26")).toBe("#9dc0ff");
  });

  test("only the tinted panels measure their ink; a link measures its own colour", () => {
    expect(INK_ROLES).toEqual(["chip", "pre"]);
    // The code block's hairline is decoration, not a boundary that identifies
    // anything: the app's own --color-line reads 1.18:1 and --color-line-strong
    // 2.04:1, so 3:1 here would make this one edge the loudest on the screen.
    expect(ROLE_BAR.preLine).toBeLessThan(AA_BOUNDARY);
    expect(ROLE_BAR.preLine).toBe(AA_HAIRLINE);
    expect(ROLE_BAR.link).toBe(AA_TEXT);
  });
});

describe("worstRole names the step that comes out tightest", () => {
  test("it reports a real role and a ratio under 21", () => {
    for (const mode of ["light", "dark"] as const) {
      const worst = worstRole(mode, contrast);
      expect(Object.keys(ROLE_BAR)).toContain(worst.role);
      expect(worst.ratio).toBeLessThan(21);
      expect(worst.ratio).toBeGreaterThanOrEqual(ROLE_BAR[worst.role]);
    }
  });
});
