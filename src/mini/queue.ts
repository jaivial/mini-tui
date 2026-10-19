/** Shared queue bridge for conversation clients. No shell expansion or model polling. */
import { homedir } from "node:os";
import { join } from "node:path";
import { queueBin } from "./queueBin";
import { spawnQueue } from "./queueSpawn";

export function taskGraphPath(): string {
  return process.env.MINITUI_TASK_GRAPH_DB ?? join(homedir(), ".local/share/mini-tui/task-graph.sqlite");
}
const ACTIONS = new Set(["put","amend","cancel","cancel-reconcile","graph","graph-read","events","events-read","search","claim","heartbeat","finish","retry","run","help"]);

/**
 * A mutation is intentionally one attempt: retrying after an uncertain response can duplicate work.
 *
 * E47, two things this used to get wrong and both were measured against the deployed code:
 *
 * 1. **The default resolver answered a different question.** `opts?.bin ?? rustAgentBin()` —
 *    "which binary runs an agent turn?" — whose answer is free to be a build WITHOUT the
 *    `task-graph` cargo feature, the one `queue …` lives behind (E46: the web served 503 for a
 *    whole deployment like that). This bridge only worked because `consumerMain` passes
 *    `MINITUI_QUEUE_BIN` by hand — protection by habit, the class E41 closed elsewhere — and the
 *    `mini-tui queue …` CLI, which passes nothing, was broken in production (the wrong binary
 *    prints `error: unknown option: --db` and exits 2). Now the default is the capability-aware
 *    chain of `queueBin()`: a candidate is a queue binary when `queue help` exits 0. An explicitly
 *    pinned binary stays pinned — the caller said so, and substituting behind its back could run a
 *    different build against the registry.
 *
 * 2. **The deadline could not kill, and the readers could hang past it.** `child.kill()` is
 *    SIGTERM and that handler does not exit, so a child that ignores TERM kept this promise
 *    pending forever (measured: still pending at 15 s on a 1 s deadline); and breaking out of the
 *    4 MB cap left the pipe unread, where a child blocked on write cannot exit at all.
 *
 * Both halves now live in `spawnQueue` (E48): this adapter owns the vocabulary of the bridge
 * (which subcommands exist, how big the arguments may be, what a failure is CALLED) and nothing
 * about processes. The web reader and this bridge were the same launcher copied twice and had
 * already drifted apart in ways that were defects — one launcher, one set of bounds.
 */
export async function queueCommand(args: string[], signal?: AbortSignal, opts?: { bin?: string; timeoutMs?: number }): Promise<{ code: number; output: string; error: string }> {
  const action = args[0] ?? "help";
  if (!ACTIONS.has(action)) throw new Error("unknown queue command");
  if (args.length > 64 || args.some(a => Buffer.byteLength(a) > 64_000 || a.includes("\0"))) throw new Error("queue arguments exceed bounds");
  const bin = opts?.bin ?? await queueBin();
  if (!bin) throw new Error("no binary answers `queue …` (build the agent with --features task-graph or set MINITUI_QUEUE_BIN)");
  if (signal?.aborted) throw new Error("queue command cancelled before launch");
  const argv = [bin,"queue",...args];
  if (!args.includes("--db")) argv.push("--db",taskGraphPath());
  // `run` owns its worker lifecycle and can be long; other calls are bounded local operations.
  const run = await spawnQueue(argv, {
    timeoutMs: action === "run" ? undefined : (opts?.timeoutMs ?? 10_000),
    signal,
  });
  if (run.reason === "too-large") throw new Error("queue output exceeded 4MB; narrow events/search rather than retry a mutation");
  if (run.reason === "timeout") throw new Error("queue command timed out; state may have changed, inspect before retrying");
  if (run.reason === "spawn-failed") throw new Error("queue command failed to launch; inspect the binary and its path");
  if (signal?.aborted) return { code: 130, output: run.stdout, error: run.stderr || "queue interrupted; inspect state before retrying\n" };
  return { code: run.code ?? -1, output: run.stdout, error: run.stderr };
}
