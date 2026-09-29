/**
 * The save logic of a note, apart from any UI: what state the editor is in and what to do next.
 *
 * Notes save themselves: 600 ms after the last keystroke, when the panel closes, and when the page
 * hides (a tab switch or a phone locking). Saves are serialised, one in flight per note, so an old save
 * can never land after a newer one. Each save names the version it started from; the server refuses
 * one whose base is stale (another tab or device saved in between), and that is surfaced as a
 * conflict to resolve, never resolved by throwing either side's text away.
 */
export type SaveState =
  | { kind: "loading" }
  | { kind: "saved"; at: number }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; theirs: string; theirsAt: number };

export const SAVE_DELAY = 600;

/** The words next to the editor. Every state has one: motion or colour is never the only signal. */
export function statusText(state: SaveState, now = Date.now()): string {
  switch (state.kind) {
    case "loading":
      return "Loading";
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving";
    case "error":
      return "Not saved";
    case "conflict":
      return "Changed somewhere else";
    case "saved": {
      if (!state.at) return "Nothing saved yet";
      const s = Math.round((now - state.at) / 1000);
      return s < 5 ? "Saved" : s < 60 ? `Saved ${s}s ago` : s < 3600 ? `Saved ${Math.round(s / 60)}m ago` : "Saved";
    }
  }
}

/** Words and characters, for the footer. Whitespace-only is zero words. */
export function counts(body: string): { words: number; chars: number } {
  const trimmed = body.trim();
  return { words: trimmed ? trimmed.split(/\s+/u).length : 0, chars: [...body].length };
}
