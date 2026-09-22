import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

/** Checked-out branch of the git repo at `cwd` (or `@<sha>` detached, null if not a repo). */
export function gitBranch(cwd: string): string | null {
  try {
    const branch = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 2000,
    });
    const name = (branch.stdout ?? "").trim();
    if (branch.status === 0 && name && name !== "HEAD") return name;
    if (branch.status !== 0) return null; // not a git repo
    const sha = spawnSync("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 2000 });
    const short = (sha.stdout ?? "").trim();
    return short ? `@${short}` : null;
  } catch {
    return null;
  }
}

/** Shorten the home directory to `~` for compact display. */
export function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
