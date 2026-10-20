/** Session identity and recovery metadata shared by terminal, headless and web launches.
 * This does not select models, change admission limits, or resume a worker by itself.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { agentRuns, getLiveRun } from "../sessions";

export function sessionTrajectories(db: Database, id: string, current?: string): string[] {
  const paths = [current, getLiveRun(db, id)?.traj_path, ...agentRuns(db, id)];
  return [...new Set(paths.filter((p): p is string => Boolean(p)))];
}

export function sessionRunEnv(base: Record<string, string>, id?: string | null, paths: string[] = []): Record<string, string> {
  const env = { ...base };
  if (id) env.MINITUI_SESSION_ID = id;
  env.MINI_AGENT_ORCHESTRATOR ??= process.env.MINI_AGENT_ORCHESTRATOR ?? "1";
  // Web default, but an explicit operator setting always wins.
  env.MINI_AGENT_MAX_DEPTH ??= process.env.MINI_AGENT_MAX_DEPTH ?? "10";
  if (paths.length) {
    env.MINI_AGENT_RECOVERY_TRAJECTORIES = JSON.stringify(paths);
    const root = paths.find(p => existsSync(join(dirname(p), "context", "contracts.md")))
      ?? paths.find(p => existsSync(join(dirname(p), "context")));
    if (root && !env.MINI_AGENT_CONTEXT_DIR && !process.env.MINI_AGENT_CONTEXT_DIR) env.MINI_AGENT_CONTEXT_DIR = join(dirname(root), "context");
  }
  return env;
}
