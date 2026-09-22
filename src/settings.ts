import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OutputMode = "collapsed" | "trim" | "expanded";

export interface Settings {
  /** How bash outputs are displayed: collapsed, trimmed to 2 lines, or fully expanded. */
  outputMode: OutputMode;
}

export const OUTPUT_MODES: Array<{ value: OutputMode; name: string; description: string }> = [
  { value: "collapsed", name: "collapsed", description: "just a tool-call count line, expandable per block" },
  { value: "trim", name: "trimmed (2 lines)", description: "two lines of output, expandable per block" },
  { value: "expanded", name: "expanded", description: "show every output in full" },
];

export const DEFAULT_SETTINGS: Settings = { outputMode: "collapsed" };

const SETTINGS_PATH = join(homedir(), ".config", "mini-tui", "settings.json");

export function loadSettings(): Settings {
  try {
    const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    const mode = data?.outputMode;
    if (mode === "collapsed" || mode === "trim" || mode === "expanded") return { outputMode: mode };
  } catch {
    // missing or broken settings fall back to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings): void {
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    // settings persistence is best-effort
  }
}

export function indexForMode(mode: OutputMode): number {
  const index = OUTPUT_MODES.findIndex((option) => option.value === mode);
  return index >= 0 ? index : 0;
}
