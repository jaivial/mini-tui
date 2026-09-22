/**
 * MINITUI_PROFILE=1 (or MINITUI_PROFILE=<path>): sample RSS/CPU every 5 s into a log file, so
 * capacity work (docs/PLAN-ram-reduction.md) can be validated on real sessions. Off by default
 * and free when disabled.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function startProfiling(): void {
  const flag = process.env.MINITUI_PROFILE;
  if (!flag) return;
  const logPath = flag === "1" || flag === "true" ? join(homedir(), ".config", "mini-tui", "profile.log") : flag;
  const t0 = Date.now();
  setInterval(() => {
    const m = process.memoryUsage();
    const c = process.cpuUsage();
    const mb = (n: number) => (n / 1048576).toFixed(0);
    try {
      appendFileSync(
        logPath,
        `${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} cpu=${((c.user + c.system) / 1000).toFixed(0)}ms\n`,
      );
    } catch {
      // profiling is best-effort
    }
  }, 5000).unref?.();
}
