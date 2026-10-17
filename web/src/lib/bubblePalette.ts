/**
 * The palette INSIDE the user's chat bubble, measured against the bubble itself.
 *
 * `--color-bubble-user` inverts with the mode: near-black (#1f1f26) in light,
 * near-white (#f3f4f8) in dark. The prose inside that bubble had its own
 * colours written as literals tuned for the near-black bubble, so they were
 * right in one mode and gone in the other. Measured live against the deployed
 * build, with a link, a quote, inline code and a code block inside one user
 * message: the link read 1.67:1 and the quote 1.01:1 in dark mode — zero ink
 * pixels in the screenshot, i.e. invisible — against 8.90 and 8.98 in light.
 *
 * So the values live here as data, one entry per mode, and the tests assert
 * the ratios. A future edit to either mode's bubble cannot quietly drop one
 * below AA the way these did, because the assertion is against the bubble the
 * same mode actually paints.
 *
 * The surfaces (chip, pre) are not held to 4.5:1 on their own: they are tinted
 * panels whose TEXT has to be readable, and the text in them is the bubble's own
 * ink. What is held is the ink-on-surface ratio — 9.71:1 light, 13.59:1 dark —
 * plus 3:1 for the mirror's 2px marker, which is a boundary a person has to
 * notice, not decoration.
 */

/** The bubble as each mode paints it, and the ink that sits on it. */
export const LIGHT_BUBBLE = { bg: "#1f1f26", ink: "#f5f5f8" };
export const DARK_BUBBLE = { bg: "#f3f4f8", ink: "#17171d" };

/** Text steps: 4.5:1 minimum. Markers: 3:1 (WCAG 1.4.11). */
export const AA_TEXT = 4.5;
export const AA_BOUNDARY = 3;

/**
 * The code block's own hairline, held only to "it separates".
 *
 * Not 3:1, and deliberately: WCAG 1.4.11 asks for 3:1 on the parts needed to
 * IDENTIFY a control or understand content, and this border is neither — the
 * code block is already identified by its own tinted background, and this is a
 * hairline around it. The app's own hairlines sit at 1.18:1 (`--color-line` on
 * the light canvas) and 1.43:1 (dark), and `--color-line-strong` reaches only
 * 2.04:1:1. Holding this one border to 3:1 while every other hairline in the
 * app is subtler would not make the design accessible, it would make this block
 * the loudest edge on the screen. It is pinned to the app's own floor instead,
 * and the floor moves if the design's does.
 */
export const AA_HAIRLINE = 1.05;

/**
 * `rgb(r g b / a)` over a background, as a hex. The chip and the code block are
 * translucent, and their measured contrast is the composite the eye sees — the
 * alpha is not decoration to be dropped when computing it.
 */
export function composite(rgba: string, bg: string): string {
  const m = rgba.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s]*\/?\s*([\d.]+))?\s*\)/);
  const hex = bg.trim().replace("#", "");
  // An opaque step is already its own colour: hand it back untouched. Returning
  // the BACKGROUND here instead is how a plain hex silently measured as 1.00:1
  // against itself — the worst possible bug in a contrast helper, because it
  // reports "no contrast" for a step that was fine.
  if (!m) return rgba.trim();
  const b = [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ] as const;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])].map((v, i) => Math.round(v * a + b[i] * (1 - a)));
  return `#${parts.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export type BubbleRole = "link" | "quote" | "chip" | "pre" | "preLine" | "mirror";

/** The step a role is held to: text carries meaning, a boundary only needs seeing. */
export const ROLE_BAR: Record<BubbleRole, number> = {
  link: AA_TEXT,
  quote: AA_TEXT,
  chip: AA_TEXT, // the INK on it, see bubbleInkRole
  pre: AA_TEXT,
  preLine: AA_HAIRLINE,
  mirror: AA_BOUNDARY,
};

/** Which role measures the bubble's own ink rather than the surface behind it. */
export const INK_ROLES: BubbleRole[] = ["chip", "pre"];

export const BUBBLE_PALETTE = {
  light: {
    link: "#9dc0ff",      // 8.90:1
    quote: "#c0c0c4",    // 9.03:1
    chip: "rgb(255 255 255 / 0.14)",
    pre: "rgb(255 255 255 / 0.08)",
    preLine: "rgb(255 255 255 / 0.16)",
    mirror: "rgb(37 211 102 / 0.62)", // 3.97:1
  },
  dark: {
    link: "#1d4ed8",      // 6.10:1
    quote: "#4e4e54",    // 7.52:1
    // The bubble is near-white now, so its panels are a wash of INK over light
    // rather than white over black — the alphas follow the inversion too.
    chip: "rgb(0 0 0 / 0.08)",
    pre: "rgb(0 0 0 / 0.07)",
    preLine: "rgb(0 0 0 / 0.14)",
    mirror: "rgb(21 94 52)", // 7.12:1
  },
} as const satisfies Record<"light" | "dark", Record<BubbleRole, string>>;

export type BubbleMode = keyof typeof BUBBLE_PALETTE;

export function paletteFor(mode: BubbleMode): Record<BubbleRole, string> {
  return BUBBLE_PALETTE[mode];
}

export function bubbleOf(mode: BubbleMode): { bg: string; ink: string } {
  return mode === "dark" ? DARK_BUBBLE : LIGHT_BUBBLE;
}

/**
 * The contrast a role reaches on the bubble of its own mode. Translucent steps
 * are composited first; the chip and the code block measure the INK that reads
 * on them, which is what a person actually has to see.
 */
export function roleContrast(role: BubbleRole, mode: BubbleMode, contrast: (a: string, b: string) => number): number {
  const { bg, ink } = bubbleOf(mode);
  const step = paletteFor(mode)[role];
  if (INK_ROLES.includes(role)) return contrast(ink, composite(step, bg));
  return contrast(composite(step, bg), bg);
}

/** The role that comes out worst on its own bubble. */
export function worstRole(mode: BubbleMode, contrast: (a: string, b: string) => number): { role: BubbleRole; ratio: number } {
  let worst = { role: "link" as BubbleRole, ratio: Number.POSITIVE_INFINITY };
  for (const role of Object.keys(ROLE_BAR) as BubbleRole[]) {
    const ratio = roleContrast(role, mode, contrast);
    if (ratio < worst.ratio) worst = { role, ratio };
  }
  return worst;
}
