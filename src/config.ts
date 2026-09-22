import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `mini` executable (on PATH, overridable). */
export const MINI_BIN = process.env.MINITUI_MINI_BIN ?? process.env.MINI_BIN ?? "mini";

/** Where run artifacts go: `~/.config/mini-tui/runs/<timestamp>-<slug>/`. */
export const RUNS_DIR = process.env.MINITUI_RUNS_DIR ?? join(homedir(), ".config", "mini-tui", "runs");

/** Default model override (empty means "whatever mini defaults to"). */
export const DEFAULT_MODEL = process.env.MINITUI_MODEL ?? "";

/** Trajectory polling interval (the harness rewrites the file once per step). */
export const POLL_MS = 200;

export function slugify(text: string, max = 24): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "run";
}

export interface SessionPaths {
  dir: string;
  trajPath: string;
  logPath: string;
  pidPath: string;
  controlPath: string;
}

export function createSessionDir(task: string): SessionPaths {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(RUNS_DIR, `${stamp}-${slugify(task)}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    trajPath: join(dir, "traj.json"),
    logPath: join(dir, "mini.log"),
    pidPath: join(dir, "pid"),
    controlPath: join(dir, "control"),
  };
}
