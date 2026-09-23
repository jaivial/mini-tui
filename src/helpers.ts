import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MINI_BIN } from "./config";

/**
 * Interpreter that can `import minisweagent` — the one behind the `mini` launcher.
 * Falls back to `python3`; override with MINITUI_PYTHON.
 *
 * `MINI_BIN` is usually just the command name ("mini"), so it must be resolved through
 * PATH before its shebang can be read — reading "mini" as a relative path always failed
 * and silently fell back to whatever `python3` is first on PATH (often one without
 * minisweagent, failing every helper script).
 */
export const PYTHON_BIN: string = resolvePython();

/** The interpreter to run helper scripts with. Pure enough to test. */
export function resolvePython(miniBin: string = MINI_BIN, env: NodeJS.ProcessEnv = process.env): string {
  if (env.MINITUI_PYTHON) return env.MINITUI_PYTHON;
  try {
    const shebang = readFileSync(resolveCommand(miniBin, env), "utf8").split("\n")[0];
    if (shebang.startsWith("#!")) {
      const parts = shebang.slice(2).trim().split(/\s+/);
      // `#!/usr/bin/python3.10` → itself; `#!/usr/bin/env python3.10` → python3.10
      const hit = parts.find((part) => part.includes("python")) ?? (parts[0]?.endsWith("/env") ? parts[1] : undefined);
      if (hit) return hit;
    }
  } catch {
    // fall through to python3
  }
  return "python3";
}

/** Absolute path of a (possibly bare) command name, searched on PATH. */
export function resolveCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (cmd.includes("/")) return cmd;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  }
  return cmd;
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

/**
 * Hold the first content paint until terminal input goes quiet.
 *
 * The startup capability probes are answered *after* the renderer is up (terminals and
 * tmux reply within a round-trip), and every reply re-invalidates the frame — so the UI
 * painted once and then fully repainted identical content ~15 ms later: the visible
 * "full-screen re-render" flash at open. Mounting the UI after the reply storm settles
 * absorbs those invalidations into blank frames and paints the content exactly once.
 */
export function waitForQuietInput(
  quietFor: () => number,
  opts: { minMs?: number; quietMs?: number; maxMs?: number } = {},
): Promise<void> {
  const minMs = opts.minMs ?? 120;
  const quietMs = opts.quietMs ?? 60;
  const maxMs = opts.maxMs ?? 800;
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const elapsed = Date.now() - start;
      if (elapsed >= maxMs || (elapsed >= minMs && quietFor() >= quietMs)) return resolve();
      setTimeout(tick, 25);
    };
    setTimeout(tick, 25);
  });
}
