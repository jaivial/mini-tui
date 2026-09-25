import { spawn } from "node:child_process";
import { join } from "node:path";

import { PYTHON_BIN } from "./helpers";
import { fallbackTitle } from "./sessions";

const SCRIPT = join(import.meta.dir, "..", "scripts", "gen_title.py");
const TIMEOUT_MS = 20_000;

/**
 * Ask the model for a session title (async, best-effort). Resolves to the generated
 * title or `null` — callers fall back to `fallbackTitle(task)`.
 */
export function generateTitle(task: string, model: string, onTitle: (title: string) => void, onDone?: () => void): void {
  const child = spawn(PYTHON_BIN, [SCRIPT, task, model], { stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  let out = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.on("close", () => {
    clearTimeout(timer);
    try {
      const title = JSON.parse(out.trim() || '""');
      if (typeof title === "string" && title.trim()) onTitle(title.trim());
    } catch {
      // generation failed: the caller already stored the fallback title
    }
    onDone?.();
  });
  child.on("error", () => {
    clearTimeout(timer);
    onDone?.();
  });
}

export { fallbackTitle };
