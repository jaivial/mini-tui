import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { MINI_BIN } from "./config";

/**
 * Interpreter that can `import minisweagent` — the one behind the `mini` launcher.
 * Falls back to `python3`; override with MINITUI_PYTHON.
 */
export const PYTHON_BIN: string = resolvePython();

function resolvePython(): string {
  if (process.env.MINITUI_PYTHON) return process.env.MINITUI_PYTHON;
  try {
    const shebang = readFileSync(MINI_BIN, "utf8").split("\n")[0];
    const match = /^#!\s*(\S*python\S*)/.exec(shebang);
    if (match) return match[1];
  } catch {
    // fall through to python3
  }
  return "python3";
}

/** Run one of the helper scripts with mini's interpreter. */
export function runHelperScript(script: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [script, ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });
}
