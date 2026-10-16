/**
 * The terminal's ANSI sixteen, as RULES.
 *
 * Measured on the deployed build before the fix (CDP, terminal panel open, all
 * sixteen painted by a shell loop and read off the real spans):
 *
 *   light   brightYellow 1.20:1   brightWhite 1.12:1   brightGreen 1.56:1
 *           brightCyan   1.55:1   white       1.41:1   yellow     2.43:1
 *           green        3.42:1   brightBlue  2.68:1   magenta    4.44:1
 *   dark    black        1.37:1   brightBlack 2.38:1   magenta    2.64:1
 *           blue         2.93:1   red         3.38:1   brightRed  4.15:1
 *
 * Those are xterm.js's own stock values: the panel themed six fields and let the
 * other sixteen fall through, so a themed-looking terminal (its background DID
 * match) carried colours tuned for a different background entirely. Eleven of
 * the sixteen were below AA in light mode.
 *
 * These tests pin the rules so the numbers cannot drift back. `web-terminal-ansi-markup.test.ts`
 * pins that the panel actually applies them.
 */
import { describe, expect, test } from "bun:test";
import {
  AA,
  ANSI_SLOTS,
  DARK_PALETTE,
  LIGHT_PALETTE,
  SURFACES,
  ansiTheme,
  contrast,
  contrastOk,
  paletteFor,
  worstContrast,
} from "../web/src/lib/terminalPalette";

describe("the ANSI sixteen clear AA on every surface they can land on", () => {
  test("light mode: all sixteen on canvas, surface, raised and overlay", () => {
    const failures = ANSI_SLOTS.flatMap((slot) =>
      Object.entries(SURFACES.light)
        .map(([name, bg]) => [slot, bg as string, name, contrast(LIGHT_PALETTE[slot], bg as string)] as const)
        .filter(([, , , ratio]) => ratio < AA)
        .map(([slot, bg, name, ratio]) => `${slot} on ${name} ${bg}: ${ratio.toFixed(2)}:1`),
    );
    expect(failures).toEqual([]);
    expect(worstContrast(LIGHT_PALETTE, "light").ratio).toBeGreaterThanOrEqual(AA);
  });

  test("dark mode: all sixteen on canvas, surface, raised and overlay", () => {
    const failures = ANSI_SLOTS.flatMap((slot) =>
      Object.entries(SURFACES.dark)
        .map(([name, bg]) => [slot, bg as string, name, contrast(DARK_PALETTE[slot], bg as string)] as const)
        .filter(([, , , ratio]) => ratio < AA)
        .map(([slot, bg, name, ratio]) => `${slot} on ${name} ${bg}: ${ratio.toFixed(2)}:1`),
    );
    expect(failures).toEqual([]);
    expect(worstContrast(DARK_PALETTE, "dark").ratio).toBeGreaterThanOrEqual(AA);
  });

  test("the specific slots that were the worst offenders", () => {
    // These are the measured readings from the deployed build, asserted from the
    // other side: the new values must be far above what they replaced.
    expect(contrast(LIGHT_PALETTE.brightYellow, SURFACES.light.raised)).toBeGreaterThanOrEqual(AA);
    expect(contrast(LIGHT_PALETTE.brightWhite, SURFACES.light.surface)).toBeGreaterThanOrEqual(AA);
    expect(contrast(LIGHT_PALETTE.brightGreen, SURFACES.light.surface)).toBeGreaterThanOrEqual(AA);
    expect(contrast(DARK_PALETTE.black, SURFACES.dark.raised)).toBeGreaterThanOrEqual(AA);
    expect(contrast(DARK_PALETTE.brightBlack, SURFACES.dark.overlay)).toBeGreaterThanOrEqual(AA);
  });

  test("black/white are ink, never literal #000 and #fff", () => {
    // A literal white slot on a white canvas is a 1.03:1 ghost; a literal black
    // slot on a near-black canvas is the same defect mirrored. Terminals are read
    // as dark ink plus coloured accents, so the ends of the ramp are ink steps.
    for (const mode of ["light", "dark"] as const) {
      const palette = paletteFor(mode);
      expect(palette.white).not.toBe("#ffffff");
      expect(palette.brightWhite).not.toBe("#ffffff");
      expect(palette.black).not.toBe("#000000");
      expect(contrast(palette.white, SURFACES[mode].surface)).toBeGreaterThanOrEqual(AA);
      expect(contrast(palette.black, SURFACES[mode].surface)).toBeGreaterThanOrEqual(AA);
    }
  });

  test("paletteFor returns the mode it is asked for, and the two differ", () => {
    expect(paletteFor("dark")).toBe(DARK_PALETTE);
    expect(paletteFor("light")).toBe(LIGHT_PALETTE);
    // If the palettes were the same object, switching mode would be a no-op.
    expect(paletteFor("dark")).not.toBe(paletteFor("light"));
  });
});

describe("the palette is complete and well-formed", () => {
  test("all sixteen slots are present in both palettes", () => {
    expect(ANSI_SLOTS).toHaveLength(16);
    for (const slot of ANSI_SLOTS) {
      expect(LIGHT_PALETTE[slot]).toMatch(/^#[0-9a-f]{6}$/);
      expect(DARK_PALETTE[slot]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("no slot is a duplicate of another within its mode", () => {
    // Two slots sharing a hex is legal in a terminal palette (nothing to tell
    // apart is fine), but a wholesale copy of one colour across the ramp would
    // mean the accents were never really addressed.
    for (const mode of ["light", "dark"] as const) {
      const palette = paletteFor(mode);
      const unique = new Set(ANSI_SLOTS.map((slot) => palette[slot]));
      expect(unique.size).toBeGreaterThanOrEqual(12);
    }
  });

  test("accent slots keep their hue between modes — they get lighter, not different", () => {
    // A dark-mode palette that quietly turned red into orange would read as a
    // different program. Same hue family, different end of the ramp.
    for (const slot of ["red", "green", "yellow", "blue", "magenta", "cyan"] as const) {
      const light = LIGHT_PALETTE[slot];
      const dark = DARK_PALETTE[slot];
      expect(light.slice(1, 3)).not.toBe(dark.slice(1, 3));
    }
  });

  test("contrastOk() and ansiTheme() report what they claim", () => {
    expect(contrastOk(LIGHT_PALETTE, "light")).toBe(true);
    expect(contrastOk(DARK_PALETTE, "dark")).toBe(true);
    // A deliberately broken palette must be rejected, or the helper is decoration.
    const broken = { ...LIGHT_PALETTE, brightYellow: "#ffff00" };
    expect(contrastOk(broken, "light")).toBe(false);
    // ansiTheme hands xterm exactly the sixteen, unmodified.
    expect(ansiTheme(LIGHT_PALETTE)).toEqual(LIGHT_PALETTE);
    expect(Object.keys(ansiTheme(DARK_PALETTE))).toHaveLength(16);
  });

  test("the measured worst cases are recorded, not just bounded", () => {
    // Light's tightest slot is `black` on the raised surface; dark's is the same
    // slot on the overlay. Pinning the numbers keeps a later "small tweak" from
    // quietly spending the margin.
    const light = worstContrast(LIGHT_PALETTE, "light");
    expect(light.slot).toBe("black");
    expect(light.on).toBe("raised");
    expect(light.ratio).toBeCloseTo(4.58, 1);

    const dark = worstContrast(DARK_PALETTE, "dark");
    expect(dark.slot).toBe("black");
    expect(dark.on).toBe("overlay");
    expect(dark.ratio).toBeCloseTo(4.67, 1);
  });
});
