/**
 * Mascot states. Every assistant in the sidebar and every chat header shows the
 * same bizbots pet character (web/public/mascots, AI-generated — see the
 * CREDITS.md next to the assets), and its pose is the state:
 *
 *   idle      the pet floats, waiting                → float
 *   thinking  a turn is generating (socket is live)  → laptop
 *   speaking  the assistant is talking to you        → headset
 *   offline   a saved/closed conversation            → sleep
 *   happy     the turn finished well                 → celebrate
 *   break     error or interrupted: a breather       → coffee
 *   wave      greeting (opens every chat)            → wave
 *   point     pointing at something                  → point
 */
export type PetMood = "idle" | "thinking" | "speaking" | "offline" | "happy" | "break" | "wave" | "point";

import type { SessionStatus } from "./types";

const MOODS = {
  idle: "float",
  thinking: "laptop",
  speaking: "headset",
  offline: "sleep",
  happy: "celebrate",
  break: "coffee",
  wave: "wave",
  point: "point",
} as const satisfies Record<PetMood, string>;

/**
 * The one size the app paints the pet at (`Mascot.svelte` takes it as a prop and
 * the sidebar asks for 56). E29 measured that the 560px masters were being shipped
 * whole for this: a 593x560 image decoded to cover 56 CSS px, which made the pet the
 * third-largest file of a first visit (30 774 B, 11.8% of the wire) for a decoration.
 * The renditions are square — padding is what `object-contain` computes anyway, so the
 * fill costs nothing (measured: max per-pixel delta 0) — and there is one per density.
 */
export const PET_SIZE = 56;

/** The pixel widths shipped per mood: 1x, 2x and 3x of `PET_SIZE`. */
export const PET_WIDTHS: readonly number[] = [1, 2, 3].map((d) => d * PET_SIZE);

/**
 * Every rendition of a mood, densest last, for `srcset`.
 *
 * The descriptors are WIDTHS, not densities (`1x`/`2x`/`3x`): the box is a fixed
 * number of CSS pixels, not a fraction of the viewport, so width descriptors are
 * what the browser resolves against the device pixel ratio, and `sizes` can name the
 * box exactly instead of approximating it.
 */
export const petSrcset = (mood: PetMood): string =>
  PET_WIDTHS.map((w) => `/mascots/${MOODS[mood]}-${w}.webp ${w}w`).join(", ");

/**
 * The fallback `src`: the largest rendition, so a browser that reads `src` but ignores
 * `srcset` (or a crawler that reads neither) still gets a sharp image rather than the
 * 1x one blown up.
 */
export const petSrc = (mood: PetMood): string => `/mascots/${MOODS[mood]}-${PET_WIDTHS[PET_WIDTHS.length - 1]}.webp`;

/** A session's pose: the pose IS the status, colour only backs it up. */
export const statusMood = (status: SessionStatus): PetMood =>
  status === "running" ? "thinking" : status === "done" ? "happy" : status === "error" || status === "interrupted" ? "break" : "idle";

/** The sidebar's status line, in words (the pose and dot carry it too). */
export const statusLine = (status: SessionStatus): string =>
  status === "running" ? "Working…" : status === "done" ? "Finished" : status === "error" ? "Hit a snag" : status === "interrupted" ? "Interrupted" : "Online";
