/**
 * The save logic of a note, apart from any UI: what state the editor is in and what to do next.
 *
 * Notes save themselves: 600 ms after the last keystroke, when the panel closes, and when the page
 * hides (a tab switch or a phone locking). Saves are serialised, one in flight per note, so an old save
 * can never land after a newer one. Each save names the version it started from; the server refuses
 * one whose base is stale (another tab or device saved in between), and that is surfaced as a
 * conflict to resolve, never resolved by throwing either side's text away.
 */
import { ageSeconds, ageWords } from "./ago";

export type SaveState =
  | { kind: "loading" }
  | { kind: "saved"; at: number }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; theirs: string; theirsAt: number };

export const SAVE_DELAY = 600;

/** The words next to the editor. Every state has one: motion or colour is never the only signal. */
export function statusText(state: SaveState, now: number): string {
  switch (state.kind) {
    case "loading":
      return "Loading";
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving";
    case "error":
      // The message names what happened, and only one of those verdicts is final: a save that never
      // left this device is "not saved", one whose answer never came may still be in the database
      // (E50 measured it landing). The panel shows this line, so it is the honest one.
      return state.message || "Not saved";
    case "conflict":
      return "Changed somewhere else";
    case "saved": {
      // The age's words live with every other "how long ago" in `lib/ago.ts` (E53): one arithmetic,
      // one table of when the words change. `now` is the shared clock's — server time.
      if (!state.at) return "Nothing saved yet";
      return ageWords("saved", ageSeconds(state.at, now), state.at);
    }
  }
}

/** Words and characters, for the footer. Whitespace-only is zero words. */
export function counts(body: string): { words: number; chars: number } {
  const trimmed = body.trim();
  return { words: trimmed ? trimmed.split(/\s+/u).length : 0, chars: [...body].length };
}
