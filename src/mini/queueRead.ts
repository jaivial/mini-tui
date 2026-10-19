/**
 * One bounded read of the queue registry, shared by `/task-graph`, `/task-events` and the SSE
 * stream that polls the same reader every 5 s.
 *
 * The process handling — deadline that can kill, TERM→SIGKILL escalation, bounded read of BOTH
 * streams, cancelled readers — lives in `queueSpawn.ts`, the single launcher (E48). This adapter
 * owns only the two things that are specific to a READ: which binary answers `queue …`
 * (`queueBin`, E46/E47), and what the answer means (JSON, or a named reason).
 *
 * E46 measured why the launcher is not a detail: the old one could not kill (the queue binary's
 * SIGTERM handler only sets a flag) and buffered a 60 000-task read whole (1.9 GB RSS). E48
 * measured what the copy had drifted into: stdout and stderr shared one buffer, so a warning on
 * stderr made a valid read answer `bad-json`, and the stderr leg was outside the 4 MB cap (200 MB
 * of stderr → 1 040 MiB RSS).
 */
import { queueBin } from "./queueBin";
import { QUEUE_SPAWN_MAX_BYTES, spawnQueue } from "./queueSpawn";

/** A local sqlite read: 60 000 tasks take 6.4 s here, and the deadline is not the thing that saves you. */
export const QUEUE_READ_TIMEOUT_MS = 5_000;
/** 4 MiB total across both streams (E48): the client's own `validView` refuses more than this. */
export const QUEUE_READ_MAX_BYTES = QUEUE_SPAWN_MAX_BYTES;

export interface QueueReadResult {
  /** Parsed JSON, when the read succeeded and stayed inside every bound. */
  value?: unknown;
  /** Which bound stopped it. Named so the caller can say which one, not "read failed". */
  reason?: "timeout" | "too-large" | "exit" | "bad-json" | "no-binary";
  exit?: number;
  stderr?: string;
}

/**
 * Run one queue subcommand under bounds that hold, and return its JSON. Never throws: every
 * failure is a named `reason`, because the caller's response is the only place the operator sees
 * what happened.
 */
export async function runQueueRead(
  argv: string[],
  opts: { timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<QueueReadResult> {
  // The environment is the caller's own, not just the resolver's: a caller that runs this with a
  // specific env (a test, or a deployment that swaps the binary) must have the CHILD see that same
  // env, or the resolver and the read disagree about which world they are in.
  const bin = await queueBin(opts.env ?? process.env);
  if (!bin) return { reason: "no-binary" };

  const run = await spawnQueue([bin, ...argv], {
    timeoutMs: opts.timeoutMs ?? QUEUE_READ_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? QUEUE_READ_MAX_BYTES,
    env: opts.env ?? process.env,
  });
  if (run.reason === "spawn-failed") return { reason: "no-binary" };
  if (run.reason === "timeout") return { reason: "timeout", exit: run.code ?? undefined };
  if (run.reason === "too-large") return { reason: "too-large" };
  if (run.reason === "aborted" || run.code !== 0) {
    return { reason: "exit", exit: run.code ?? undefined, stderr: run.stderr.slice(0, 400) };
  }
  try {
    return { value: JSON.parse(run.stdout) };
  } catch {
    return { reason: "bad-json", stderr: run.stdout.slice(0, 200) };
  }
}
