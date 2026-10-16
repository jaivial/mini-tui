/**
 * The ANSI 16 of a terminal, derived from the app's own palette so a shell
 * prompt is as readable as the chat around it.
 *
 * xterm.js ships a stock ANSI palette tuned for a dark background and applies
 * it verbatim when the theme does not name a colour. Those values are legible
 * on #1b1a17 and unusable on ours: measured against the light ladder,
 * brightYellow (33/93) read 1.20:1, brightWhite 1.12:1 and brightGreen 1.56:1 —
 * an `ls --color` or a git status line is literally invisible. TerminalPanel's
 * `theme()` set six fields and let the other sixteen fall through, so the
 * terminal looked themed (background matched) while its colours did not.
 *
 * Two rules, and they are the whole point:
 *
 *  1. Every slot clears AA (4.5:1) on EVERY surface it can land on — canvas,
 *     surface, raised and overlay, in the mode it belongs to. A colour that
 *     passes on the panel background and fails on the row behind it is still
 *     a bug, so the numbers are checked against the worst surface, not the
 *     prettiest one.
 *  2. `black`/`brightBlack` are ink, and `white`/`brightWhite` are the far end
 *     of the ink ramp, NOT literal black and white. Terminals are read as
 *     "dark ink, coloured accents"; a literal #ffffff slot on a white canvas
 *     is a 1.03:1 ghost and a literal #000000 slot on a near-black canvas is
 *     the same defect mirrored.
 *
 * The values are measured, not eyeballed: `contrastOk()` is exported and the
 * tests assert the ratios, so a future palette edit cannot quietly drop one
 * below AA the way this one did.
 */

export type AnsiSlot =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow"
  | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

export type AnsiPalette = Record<AnsiSlot, string>;

export type AnsiMode = "light" | "dark";

/**
 * The surfaces a glyph can land on inside the terminal panel. TerminalPanel
 * paints `bg-surface`, but a selection, an inline image or a stack that
 * overflows onto the overlay all resolve to one of these, so AA is measured
 * against the whole ladder rather than a single token.
 */
export const LIGHT_SURFACES = {
  canvas: "#ffffff",
  surface: "#fbfbfd",
  raised: "#f2f2f6",
  overlay: "#ffffff",
} as const;

export const DARK_SURFACES = {
  canvas: "#121319",
  surface: "#181a21",
  raised: "#21242d",
  overlay: "#262a34",
} as const;

export const SURFACES: Record<AnsiMode, Record<keyof typeof LIGHT_SURFACES, string>> = {
  light: LIGHT_SURFACES,
  dark: DARK_SURFACES,
};

/**
 * Light: the ink ramp inverted. `black` is the faint ink step (still 4.58:1 on
 * the raised surface) and `white` is the full-strength ink, because a literal
 * white slot on a white canvas is unreadable in both directions.
 */
export const LIGHT_PALETTE: AnsiPalette = {
  black: "#6d6d78",
  red: "#c22e57",
  green: "#157c4e",
  yellow: "#8a5508",
  blue: "#1f5fd0",
  magenta: "#8e2f8e",
  cyan: "#0a6b73",
  white: "#1a1a21",
  brightBlack: "#5d5d68",
  brightRed: "#a81e46",
  brightGreen: "#0d6540",
  brightYellow: "#70440a",
  brightBlue: "#1647a8",
  brightMagenta: "#702470",
  brightCyan: "#07545a",
  brightWhite: "#1a1a21",
};

/**
 * Dark: the bright end of the same ramp. Every slot is at least 4.67:1 on the
 * overlay, which is the lightest surface the panel can sit on.
 */
export const DARK_PALETTE: AnsiPalette = {
  black: "#8c93a6",
  red: "#ff6b8a",
  green: "#46c99a",
  yellow: "#e0a03c",
  blue: "#6fa8dc",
  magenta: "#d18ad1",
  cyan: "#4fd6d6",
  white: "#cbd0d4",
  brightBlack: "#a7acbc",
  brightRed: "#ff8ba3",
  brightGreen: "#6fd8b0",
  brightYellow: "#f0bd63",
  brightBlue: "#8fc0ee",
  brightMagenta: "#e0a4e0",
  brightCyan: "#7ee3e3",
  brightWhite: "#f3f4f8",
};

/** AA for normal text. Big/bold terminal text is monospaced 12.5px, so 4.5 is the bar. */
export const AA = 4.5;

function parse(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = parse(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** The worst contrast a slot gets across every surface of its mode. */
export function worstContrast(palette: AnsiPalette, mode: AnsiMode): { slot: AnsiSlot; ratio: number; on: string } {
  const surfaces = SURFACES[mode];
  let worst = { slot: "black" as AnsiSlot, ratio: Infinity, on: "canvas" };
  for (const slot of Object.keys(palette) as AnsiSlot[]) {
    for (const [name, surface] of Object.entries(surfaces)) {
      const ratio = contrast(palette[slot], surface);
      if (ratio < worst.ratio) worst = { slot, ratio, on: name };
    }
  }
  return worst;
}

export function contrastOk(palette: AnsiPalette, mode: AnsiMode, bar = AA): boolean {
  return worstContrast(palette, mode).ratio >= bar;
}

export function paletteFor(mode: AnsiMode): AnsiPalette {
  return mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

export const ANSI_SLOTS: AnsiSlot[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

/**
 * Turns a palette into the shape xterm's `ITheme` expects. The six fields the
 * caller already set (background, foreground, cursor…) are merged on top by
 * the panel, so this only contributes the sixteen.
 */
export function ansiTheme(palette: AnsiPalette): AnsiPalette {
  return { ...palette };
}
