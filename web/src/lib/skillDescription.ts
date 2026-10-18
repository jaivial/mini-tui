/**
 * How a skill's description is shown, and how much of it is actually reachable.
 *
 * The server sends every description whole (60 skills, 33 664 characters, 93% of `/api/skills`).
 * The Settings list clamps them to two lines, which of a 561-character average reads as the whole
 * text — the E22/E23 failure, a clipped surface presented as a complete one. So a description gets
 * a `more` button, but only when it is long enough that two lines CANNOT hold it: a button on a
 * one-line description is noise, and one that never expands is worse than none.
 */

/** Lines the Settings list shows before the user asks for the rest. */
export const SKILL_LINES = 2;

/**
 * Whether a description needs a `more` affordance. A pure length rule: `bun test` can hold it,
 * and it never claims "nothing is hidden" for text that a real font would wrap. The threshold is
 * deliberately low (four lines' worth at ~70 characters per line) because the *rendered* wrap
 * depends on the pane width, which no test can know — so this can only say "could be cut", never
 * "is definitely cut". `SKILL_MIN_CUT` is exported for that reason.
 */
export const SKILL_MIN_CUT = SKILL_LINES * 70;

/** Characters at or above which a description may be clipped, and so offers `more`. */
export function skillIsCut(description: string | undefined): boolean {
  return (description ?? "").trim().length > SKILL_MIN_CUT;
}
