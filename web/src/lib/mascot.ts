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
  idle: "/mascots/float.webp",
  thinking: "/mascots/laptop.webp",
  speaking: "/mascots/headset.webp",
  offline: "/mascots/sleep.webp",
  happy: "/mascots/celebrate.webp",
  break: "/mascots/coffee.webp",
  wave: "/mascots/wave.webp",
  point: "/mascots/point.webp",
} as const satisfies Record<PetMood, string>;

export const petSrc = (mood: PetMood): string => MOODS[mood];

/** A session's pose: the pose IS the status, colour only backs it up. */
export const statusMood = (status: SessionStatus): PetMood =>
  status === "running" ? "thinking" : status === "done" ? "happy" : status === "error" || status === "interrupted" ? "break" : "idle";

/** The sidebar's status line, in words (the pose and dot carry it too). */
export const statusLine = (status: SessionStatus): string =>
  status === "running" ? "Working…" : status === "done" ? "Finished" : status === "error" ? "Hit a snag" : status === "interrupted" ? "Interrupted" : "Online";
