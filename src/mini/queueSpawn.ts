/**
 * The ONE place a queue subcommand is spawned and read.
 *
 * It exists because E46 and E47 were the same fix applied twice — two launchers, each with its own
 * copy of "deadline + TERM→KILL + bounded read + cancelled readers" — and by E48 the copies had
 * already diverged in ways that were defects, measured against the deployed code (e2890ec):
 *
 * 1. **The web reader mixed the two streams into one buffer.** `runQueueRead` shared one `chunks`
 *    array (and one byte counter) between its stdout and its stderr collect, so each returned the
 *    concatenation of BOTH at its own finish time. A binary that printed one warning line on
 *    stderr before its JSON made `/task-graph` answer `bad-json` with the warning glued to the
 *    payload — while the chat bridge, whose copy kept per-stream buffers, read the same command
 *    fine (`output` parsed, `error` held the warning). Same binary, same subcommand, two answers.
 *
 * 2. **The web reader's cap did not cover stderr.** Its stderr collect ran `bounded: false`, and
 *    the shared counter was only CHECKED inside the stdout loop — a child that wrote its JSON
 *    first and then flooded stderr tripped no bound at all: measured 200 MB of stderr → **1 040
 *    MiB RSS in the parent**, from a reader whose whole point is a 4 MB cap. `/task-graph` runs
 *    this every 5 s in the web process.
 *
 * So the bound is what it always claimed to be: one byte budget for the run, counted across BOTH
 * streams and checked in both loops — the purpose of the cap is the parent's memory, and the
 * parent buffers stderr exactly like stdout. And the escalation lives in one place: TERM, then
 * SIGKILL after a grace, then cancel the readers (a SIGKILL does not close a pipe whose write end
 * a grandchild still holds — without the cancel the await outlives the kill).
 *
 * A third launcher cannot copy a broken half any more: `tests/queue-spawn.test.ts` reads the
 * source and refuses `Bun.spawn` outside this file's allowlist (the lesson of E41 — protection by
 * the type system where possible, by a source-reading test where not).
 */
/** 4 MiB TOTAL across stdout and stderr: 10 000 tasks with the trajectories they carry. */
export const QUEUE_SPAWN_MAX_BYTES = 4 * 1024 * 1024;
/** SIGTERM → SIGKILL after this. The queue binary ignores TERM, so the grace is what buys the KILL. */
export const KILL_GRACE_MS = 250;

export interface QueueSpawnOptions {
  /** Deadline for the whole run. `undefined` = no deadline (long-lived `run` owns its worker). */
  timeoutMs?: number;
  /** Total byte budget across both streams. Default {@link QUEUE_SPAWN_MAX_BYTES}. */
  maxBytes?: number;
  /** The world the child runs in. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Ends the wait like a deadline, but reports `aborted` so the caller can say which it was. */
  signal?: AbortSignal;
  /** Launch-only mode (`queue help` probes): streams go to the null device, nothing is buffered. */
  discardOutput?: boolean;
}

export interface QueueSpawnResult {
  /** Which bound stopped it, or `undefined` when the child exited on its own inside every bound. */
  reason?: "timeout" | "too-large" | "spawn-failed" | "aborted";
  /** Exit code when the kernel produced one (a SIGKILL'd child still reports -9 here). */
  code?: number;
  /** Whatever was collected before the run stopped. Empty on `too-large`: it is not a partial read. */
  stdout: string;
  stderr: string;
}

/**
 * Run one queue binary invocation under bounds that are actually enforced, and come back with its
 * two streams SEPARATE and named failures. Never throws: the caller's response is the only place
 * the operator sees what happened, and "which bound stopped it" is the question they need answered.
 */
export async function spawnQueue(argv: string[], opts: QueueSpawnOptions = {}): Promise<QueueSpawnResult> {
  const timeoutMs = opts.timeoutMs;
  const maxBytes = opts.maxBytes ?? QUEUE_SPAWN_MAX_BYTES;
  const ignore = opts.discardOutput === true;

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, ignore
      ? { stdout: "ignore", stderr: "ignore", env: opts.env }
      : { stdout: "pipe", stderr: "pipe", env: opts.env });
  } catch {
    return { reason: "spawn-failed", stdout: "", stderr: "" };
  }

  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let timedOut = false;
  let oversize = false;
  /**
   * Stop the child AND stop waiting on its pipes. The second half is what actually ends the wait:
   * with the readers left open, `await child.exited` is not the only thing being waited on, and a
   * grandchild holding the write end makes EOF unreachable even after a SIGKILL.
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
  const arm = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener("abort", stop, { once: true });
  }

  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  let bytes = 0;
  const collect = async (stream: number | ReadableStream<Uint8Array> | undefined, into: Uint8Array[]): Promise<void> => {
    // Bun types a piped stdout as `number | ReadableStream | undefined` (the `number` is the fd
    // form), so the pipe is narrowed here: an absent stream reads as empty instead of throwing.
    if (typeof stream !== "object" || stream === null) return;
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        // Checked in BOTH loops: stderr is buffered by the parent exactly like stdout, so it counts
        // against the same budget. This is the whole difference from the copies (E48).
        if (bytes > maxBytes) {
          oversize = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          for (const open of readers) {
            try { void open.cancel(); } catch { /* already closed */ }
          }
          break;
        }
        into.push(item.value);
      }
    } catch { /* a closed or cancelled pipe is the normal way this ends */ }
    finally { try { reader.releaseLock(); } catch { /* cancelled above */ } }
  };

  try {
    const [code] = await Promise.all([child.exited, collect(child.stdout, outChunks), collect(child.stderr, errChunks)]);
    const stdout = Buffer.concat(outChunks).toString("utf8");
    const stderr = Buffer.concat(errChunks).toString("utf8");
    if (oversize) return { reason: "too-large", code: code ?? undefined, stdout: "", stderr: "" };
    if (timedOut) return { reason: "timeout", code: code ?? undefined, stdout, stderr };
    if (opts.signal?.aborted) return { reason: "aborted", code: code ?? undefined, stdout, stderr };
    return { code: code ?? -1, stdout, stderr };
  } finally {
    if (arm) clearTimeout(arm);
    opts.signal?.removeEventListener("abort", stop);
  }
}
