import { spawn } from "node:child_process";
import { join } from "node:path";

import { PYTHON_BIN } from "./helpers";
import { rustAgent } from "./mini/spawn";
import { fallbackTitle } from "./sessions";

const SCRIPT = join(import.meta.dir, "..", "scripts", "gen_title.py");
const TIMEOUT_MS = 20_000;

/**
 * Ask the model for a session title (async, best-effort). Resolves to the generated
 * Calls back when ready; callers retain `fallbackTitle(task)` on failure.
 * The returned handle cancels cosmetic work when its owning run has already ended.
 */
export function generateTitle(task: string, model: string, onTitle: (title: string) => void, onDone?: () => void): { cancel(): void } {
  // With the Rust agent (the default when its binary is there), `mini-agent-rs title` is the same helper.
  const rust = rustAgent();
  const child = rust
    ? spawn(rust, ["title", task, model], { stdio: ["ignore", "pipe", "ignore"] })
    : spawn(PYTHON_BIN, [SCRIPT, task, model], { stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  let out = "";
  let cancelled = false;
  let settled = false;
  const done = () => { if (!settled) { settled = true; onDone?.(); } };
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.on("close", () => {
    clearTimeout(timer);
    try {
      const title = JSON.parse(out.trim() || '""');
      if (!cancelled && typeof title === "string" && title.trim()) onTitle(title.trim());
    } catch {
      // generation failed: the caller already stored the fallback title
    }
    done();
  });
  child.on("error", () => {
    cancelled = true;
    clearTimeout(timer);
    done();
  });
  return {
    cancel() {
      if (settled) return;
      cancelled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      done();
    },
  };
}

export { fallbackTitle };

/** A session title is AT MOST this many words (Jaime's v5-A spec). */
export const TITLE_MAX_WORDS = 4;

/** Clamp a generated title to the spec: one line, MAX 4 words, and never
 * longer than the fallback cap — a model that ignores the prompt (or an old
 * binary still asking for 8) cannot produce an oversized title. */
export function clampTitle(title: string): string {
  const firstLine = title.split(/\r?\n/)[0] ?? "";
  const four = firstLine.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, TITLE_MAX_WORDS).join(" ");
  return fallbackTitle(four);
}

/** `generateTitle` as a promise: the clamped title, or `null` on any failure
 * (the caller keeps its fallback — that is what the fallback is for). */
export function aiTitle(task: string, model: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (title: string | null) => {
      if (!settled) {
        settled = true;
        resolve(title);
      }
    };
    generateTitle(
      task,
      model,
      (title) => {
        const clamped = clampTitle(title);
        if (clamped) finish(clamped);
      },
      () => finish(null),
    );
  });
}
