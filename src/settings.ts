import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type OutputMode = "collapsed" | "trim" | "expanded";

export interface Settings {
  /** How bash outputs are displayed: collapsed, trimmed to 2 lines, or fully expanded. */
  outputMode: OutputMode;
  /** UI theme id (see `THEMES` in ui/theme.ts). */
  theme?: string;
  /**
   * Toggle 1 — Jev (TypeSafe System One) on/off. Independent of the verifier phase: this is the
   * decision service itself (its key, its checks); turning it on does not start a verifier run.
   */
  jevEnabled?: boolean;
  /**
   * Toggle 2 — the post-code verifier phase (cheap LLM reader + Jev). Independent of `jevEnabled`:
   * it may be on while Jev is off (the phase then degrades to reader-only) and off while Jev is on.
   */
  jevVerifierEnabled?: boolean;
}

export const OUTPUT_MODES: Array<{ value: OutputMode; name: string; description: string }> = [
  { value: "collapsed", name: "collapsed", description: "just a tool-call count line, expandable per block" },
  { value: "trim", name: "trimmed (2 lines)", description: "two lines of output, expandable per block" },
  { value: "expanded", name: "expanded", description: "show every output in full" },
];

export const DEFAULT_SETTINGS: Settings = {
  outputMode: "collapsed",
  theme: "shadcn",
  // Both Jev pieces ship OFF: they cost money per call and the user must opt in, one at a time.
  jevEnabled: false,
  jevVerifierEnabled: false,
};

/** Read on every call, not once at import: tests (and embedders) set the env var after modules load. */
function settingsPath(): string {
  return process.env.MINITUI_SETTINGS_PATH ?? join(homedir(), ".config", "mini-tui", "settings.json");
}

/** A toggle is off unless the file says on: absent (an old settings.json) must not enable it. */
function enabled(value: unknown): boolean {
  return value === true;
}

export function loadSettings(): Settings {
  try {
    const data = JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown> | null;
    const mode = data?.outputMode;
    const theme = data?.theme;
    const jev = enabled(data?.jevEnabled);
    const verifier = enabled(data?.jevVerifierEnabled);
    if (mode === "collapsed" || mode === "trim" || mode === "expanded") {
      return {
        outputMode: mode,
        theme: typeof theme === "string" ? theme : DEFAULT_SETTINGS.theme,
        jevEnabled: jev,
        jevVerifierEnabled: verifier,
      };
    }
  } catch {
    // missing or broken settings fall back to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings): void {
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  } catch {
    // settings persistence is best-effort
  }
}

export function indexForMode(mode: OutputMode): number {
  const index = OUTPUT_MODES.findIndex((option) => option.value === mode);
  return index >= 0 ? index : 0;
}
