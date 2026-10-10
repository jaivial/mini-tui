/**
 * The diff the verifier phase reviews: the work this session produced, not the whole repo.
 *
 * `git diff` against the branch point HEAD, with untracked files folded in, so a brand-new file
 * (the common case for a fresh module) is reviewed too. An empty diff is a legitimate answer —
 * the phase degrades with a reason instead of inventing a review.
 */

import { spawnSync } from "node:child_process";

function run(cwd: string, args: string[], timeout = 10_000): string {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
    return result.status === 0 ? (result.stdout ?? "") : "";
  } catch {
    return "";
  }
}

/** `git diff HEAD` plus the content of untracked files, as one patch-shaped string. */
export function gitDiff(cwd: string, maxBytes = 400_000): string {
  const tracked = run(cwd, ["diff", "HEAD", "--no-color"]);
  const names = run(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
  let patch = tracked;
  for (const name of names) {
    // A binary or huge file would drown the reader; its path alone is the signal.
    patch += `\n--- /dev/null\n+++ b/${name} (new file)\n${run(cwd, ["diff", "--no-index", "--no-color", "/dev/null", name]).split("\n").slice(5).join("\n")}`;
  }
  return patch.length > maxBytes ? `${patch.slice(0, maxBytes)}\n… (diff truncated)` : patch;
}