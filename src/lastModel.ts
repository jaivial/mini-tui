import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The model most recently picked in *any* mini-tui session (`/model`), remembered across
 * launches. It is read once at startup only, so it becomes the default of fresh terminals
 * while TUIs that are already open keep the model they started with / picked themselves.
 *
 * Kept out of `settings.json` on purpose: every open TUI rewrites that file whole from its
 * in-memory copy, so a stale window would clobber the value.
 */
const LAST_MODEL_PATH = join(homedir(), ".config", "mini-tui", "last-model.json");

/** Overridable so tests never read or write the user's real file (hermetic runs). */
export function lastModelPath(): string {
  return process.env.MINITUI_LAST_MODEL_PATH ?? LAST_MODEL_PATH;
}

export function loadLastModel(path: string = lastModelPath()): string {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const model = data?.model;
    return typeof model === "string" ? model.trim() : "";
  } catch {
    return ""; // missing or broken file: mini's own default applies
  }
}

export function saveLastModel(model: string, path: string = lastModelPath()): void {
  const clean = model.trim();
  if (!clean) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // write + rename: another TUI launching at the same moment never reads half a file
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ model: clean, savedAt: Date.now() })}\n`);
    renameSync(tmp, path);
  } catch {
    // best-effort, like every other preference
  }
}
