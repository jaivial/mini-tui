/**
 * Resolving the binary that answers `queue …`.
 *
 * `rustAgentBin()` answers a DIFFERENT question: "which binary runs an agent turn?" It resolves
 * `MINITUI_AGENT_BIN`, the repo build, then the installed copy — and every one of those is free
 * to be a build WITHOUT the `task-graph` cargo feature, which is what the queue subcommand
 * lives behind (E46: measured in production, `/task-graph` answered 503 for the whole deployment
 * while the consumer, which reads `MINITUI_QUEUE_BIN`, worked). A missing feature is not a path
 * problem, so `existsSync` cannot see it: the binary is there, it runs, it prints a usage error
 * and exits 2.
 *
 * So the queue reader asks the binary itself, once per process, and caches the verdict: a
 * candidate is accepted only if `queue help` exits 0. That is the same "make the question
 * answerable" rule as E8's build stamp — a resolver that cannot tell a queue binary from a
 * non-queue one is decoration.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { rustAgentBin } from "./spawn";

/** How long the probe may take before the candidate counts as "does not answer". */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * Candidates in the order they are trusted: the declared one first, then the agent chain.
 *
 * The homedir fallbacks read `env.HOME` before the real home (E47): the caller's env is the world
 * it runs in — the same rule `runQueueRead` applies to the child — and a test must be able to close
 * that world instead of inheriting whatever this machine has installed. The last candidate is the
 * installed QUEUE build (`mini-agent-rs-taskgraph`, where A3/A3c/E46 deploy it): without it the
 * chain only finds a queue binary when `MINITUI_QUEUE_BIN` is set, which is exactly the habit
 * E47 removed — the capability is a fact of the binary, so the chain has to reach every binary
 * that could have it.
 */
function candidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const declared = env.MINITUI_QUEUE_BIN;
  if (declared) out.push(declared);
  const agent = rustAgentBin(env);
  if (agent) out.push(agent);
  const built = new URL("../../agent-rs/target/release/mini-agent-rs", import.meta.url).pathname;
  if (existsSync(built)) out.push(built);
  const home = env.HOME ?? homedir();
  const lib = join(home, ".local", "lib", "mini-tui");
  const installed = join(lib, "mini-agent-rs");
  if (existsSync(installed)) out.push(installed);
  const installedQueue = join(lib, "mini-agent-rs-taskgraph");
  if (existsSync(installedQueue)) out.push(installedQueue);
  return [...new Set(out)];
}

/**
 * Ask one binary whether it speaks `queue`. Spawned for its exit code only: a usage error is the
 * answer we are looking for, so stdout and stderr are discarded. The probe is killed with
 * SIGKILL, never a bare TERM — a candidate that hangs must not become the answer.
 */
async function speaksQueue(bin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([bin, "queue", "help"], { stdout: "ignore", stderr: "ignore", env });
  } catch {
    return false;
  }
  const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, PROBE_TIMEOUT_MS);
  try {
    return (await child.exited) === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(killer);
  }
}

/**
 * The binary that answers `queue …`, or `undefined` when none of the candidates does.
 *
 * Verdicts are cached per candidate LIST, failures included — a deployment whose agent binary has
 * no queue feature is asked once, not once per request. The key is the list itself and not a
 * single global slot, because a global slot would hand the first caller's answer to a later caller
 * that passed a different environment: the cache would then be a second, quieter version of the
 * bug it exists to prevent.
 */
const verdicts = new Map<string, string | undefined>();

export async function queueBin(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const list = candidates(env);
  const key = list.join("\0");
  const cached = verdicts.get(key);
  if (cached !== undefined || verdicts.has(key)) return cached;
  let found: string | undefined;
  for (const bin of list) {
    if (!existsSync(bin)) continue;
    if (await speaksQueue(bin, env)) { found = bin; break; }
  }
  verdicts.set(key, found);
  return found;
}

/** Test seam: forget every cached verdict. */
export function resetQueueBinCache(): void {
  verdicts.clear();
}
