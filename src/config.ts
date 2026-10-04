import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The `mini` executable (on PATH, overridable), read when it is needed rather than once at import: a
 * constant would freeze whatever the environment held the first time any module loaded this file.
 */
export function miniBin(): string {
  // An empty override means "unset": a variable left over from a parent process must not hide the
  // launcher (and with it the runner's console script, and the interpreter read from its shebang).
  return process.env.MINITUI_MINI_BIN || process.env.MINI_BIN || "mini";
}

/** @deprecated the value at import time; use `miniBin()`. */
export const MINI_BIN = miniBin();

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

/**
 * A NEW run directory, never an existing one. Timestamp + slug alone collided: runs started in the
 * same second whose tasks share a prefix (a `$skill` expansion puts the same text first in every
 * prompt) got the same folder, so parallel headless agents shared `traj.json`, `mini.log` and the
 * control file and read each other's trajectory. A random suffix makes the name unique, and the
 * non-recursive `mkdir` fails on a clash instead of silently reusing a folder.
 */
export function createSessionDir(task: string): SessionPaths {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(RUNS_DIR, { recursive: true });
  let dir = "";
  for (let attempt = 0; ; attempt++) {
    dir = join(RUNS_DIR, `${stamp}-${slugify(task)}-${randomBytes(3).toString("hex")}`);
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 4) throw err;
    }
  }
  return {
    dir,
    trajPath: join(dir, "traj.json"),
    logPath: join(dir, "mini.log"),
    pidPath: join(dir, "pid"),
    controlPath: join(dir, "control"),
  };
}
