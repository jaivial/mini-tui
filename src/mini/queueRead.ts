/**
 * One bounded read of the queue registry, shared by `/task-graph`, `/task-events` and the SSE
 * stream that polls the same reader every 5 s.
 *
 * Two things it exists to get right, both measured (E46):
 *
 * 1. **The kill actually kills.** `Bun.spawn(...).kill()` with no argument sends SIGTERM, and the
 *    queue binary's own SIGTERM handler (`stop_queue`) *only sets a flag* — it does not exit
 *    (`agent-rs/src/graph_queue.rs`). So a plain `setTimeout(() => child.kill(), 5000)` is a
 *    no-op against exactly the binary it was written for: the read ran to 11 s past a 5 s deadline
 *    and was only cut short when the OOM killer stepped in. TERM, then a short grace, then KILL —
 *    the escalation every other spawn site in this repo already does.
 *
 * 2. **The work is bounded, not just the answer.** The reader collects stdout while it arrives and
 *    gives up past `maxBytes`; it never `await`s a whole unbounded child into memory. On a
 *    60 000-task registry the same read allocated 1.3 GB in the child and 1.9 GB in the parent.
 */
import { queueBin } from "./queueBin";

/** A local sqlite read: 60 000 tasks take 6.4 s here, and the deadline is not the thing that saves you. */
export const QUEUE_READ_TIMEOUT_MS = 5_000;
/** SIGTERM → SIGKILL after this. The queue binary ignores TERM, so the grace is what buys the KILL. */
const KILL_GRACE_MS = 250;
/** 4 MiB: 10 000 tasks with the trajectories they carry. The client's own `validView` refuses more. */
export const QUEUE_READ_MAX_BYTES = 4 * 1024 * 1024;

export interface QueueReadResult {
  /** Parsed JSON, when the read succeeded and stayed inside every bound. */
  value?: unknown;
  /** Which bound stopped it. Named so the caller can say which one, not "read failed". */
  reason?: "timeout" | "too-large" | "exit" | "bad-json" | "no-binary";
  exit?: number;
  stderr?: string;
}

/**
 * Run one queue subcommand under a deadline that can actually be enforced, and return its JSON.
 * Never throws: every failure is a named `reason`, because the caller's response is the only
 * place the operator sees what happened.
 */
export async function runQueueRead(
  argv: string[],
  opts: { timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<QueueReadResult> {
  const bin = await queueBin(opts.env ?? process.env);
  if (!bin) return { reason: "no-binary" };
  const timeoutMs = opts.timeoutMs ?? QUEUE_READ_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? QUEUE_READ_MAX_BYTES;

  // The environment is the caller's own, not just the resolver's: a caller that runs this with a
  // specific env (a test, or a deployment that swaps the binary) must have the CHILD see that same
  // env, or the resolver and the read disagree about which world they are in.
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([bin, ...argv], { stdout: "pipe", stderr: "pipe", env: opts.env ?? process.env });
  } catch {
    return { reason: "no-binary" };
  }

  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let timedOut = false;
  let oversized = false;
  /**
   * Stop the child AND stop waiting on its pipes.
   *
   * The second half is not a detail: SIGKILL does not close a pipe whose write end a GRANDCHILD
   * still holds, and the queue binary spawns worker processes. Measured on the shape this models
   * (`sh` whose `trap "" TERM` runs `sleep 30`): killing the shell leaves `sleep` holding stdout, so
   * a reader awaiting EOF waits the full 30 s — the deadline fired, the child died, and the read
   * still did not return. Cancelling the reader is what actually ends the wait.
   */
  const stop = () => {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      for (const reader of readers) {
        try { void reader.cancel(); } catch { /* already closed */ }
      }
    }, KILL_GRACE_MS);
  };
  const arm = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  // Bun types a piped stdout as `number | ReadableStream | undefined` (the `number` is the fd form),
  // so the pipe is narrowed here rather than cast at the call site: an absent stream reads as empty
  // instead of throwing, and a real stream still goes through the bounded loop.
  const collect = async (stream: number | ReadableStream<Uint8Array> | undefined, bounded: boolean): Promise<string> => {
    if (typeof stream !== "object" || stream === null) return "";
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bounded && bytes > maxBytes) {
          oversized = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          for (const open of readers) {
            try { void open.cancel(); } catch { /* already closed */ }
          }
          break;
        }
        chunks.push(item.value);
      }
    } catch { /* a closed pipe is the normal way this ends */ }
    finally { try { reader.releaseLock(); } catch { /* cancelled above */ } }
    return Buffer.concat(chunks).toString("utf8");
  };

  try {
    const [out, err, code] = await Promise.all([collect(child.stdout, true), collect(child.stderr, false), child.exited]);
    if (timedOut) return { reason: "timeout", exit: code ?? undefined };
    if (oversized) return { reason: "too-large" };
    if (code !== 0) return { reason: "exit", exit: code ?? undefined, stderr: err.slice(0, 400) };
    try {
      return { value: JSON.parse(out) };
    } catch {
      return { reason: "bad-json", stderr: out.slice(0, 200) };
    }
  } finally {
    clearTimeout(arm);
  }
}
