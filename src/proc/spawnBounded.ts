/**
 * The ONE place a child process is spawned AND read under bounds that are actually enforced.
 *
 * It started as `mini/queueSpawn.ts` (E48) because the queue had two launchers with their own copies of
 * "deadline + TERM→KILL + bounded read + cancelled readers". Then `web/folders.ts` turned out to be the
 * LAST copy of the same pattern — the remote folder listing — and measured against the deployed code
 * (`7f4df26`) it was missing every bound the queue copies had learned:
 *
 * 1. **No byte budget at all.** It read `new Response(proc.stdout).text()` straight into memory, so a
 *    remote host that answered 200 MiB of anything grew the web process from 19 MiB to **628 MiB RSS**
 *    and then reported a 502. The remote host is another server: its output is untrusted by default.
 * 2. **The deadline was SIGTERM and nothing else.** `proc.kill()` is TERM, so a child that ignores it
 *    left the promise **pending forever** (measured: still pending at 15 s on a 500 ms deadline) and the
 *    child alive. E47 measured exactly this in the queue bridge; the copy that survived was this one.
 * 3. **The streams could not be told apart.** One caller's failure was another's data.
 *
 * So the bounds live here, generic, and the queue adapter (`mini/queueSpawn.ts`) and the remote folder
 * listing (`web/folders.ts`) are both callers of it. A fourth launcher cannot copy a broken half: the
 * test that guards `Bun.spawn` (`tests/queue-spawn.test.ts`) allowlists the sites that may spawn, and
 * each of those sites now has to come through here.
 */

/** Default total budget for one run: 4 MiB across both streams. */
export const SPAWN_MAX_BYTES = 4 * 1024 * 1024;
/** SIGTERM → SIGKILL after this. A child that ignores TERM must not be able to outlive the deadline. */
export const KILL_GRACE_MS = 250;

export type SpawnReason = "timeout" | "too-large" | "spawn-failed" | "aborted";

export interface BoundedSpawnOptions {
  /** Deadline for the whole run. `undefined` = no deadline (long-lived children own their workers). */
  timeoutMs?: number;
  /** Total byte budget across BOTH streams. Default {@link SPAWN_MAX_BYTES}. */
  maxBytes?: number;
  /** The world the child runs in. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Ends the wait like a deadline, but reports `aborted` so the caller can say which it was. */
  signal?: AbortSignal;
  /** Launch-only mode (a capability probe): streams go to the null device, nothing is buffered. */
  discardOutput?: boolean;
  /**
   * Written to the child's stdin, which is then closed. This is what lets a caller hand a program to a
   * shell over one channel (`ssh … bash -s`, E49) without becoming a second launcher to do it.
   */
  stdin?: string | Uint8Array;
}

export interface BoundedSpawnResult {
  /** Which bound stopped it, or `undefined` when the child exited on its own inside every bound. */
  reason?: SpawnReason;
  /** Exit code when the kernel produced one (a SIGKILL'd child still reports -9 here). */
  code?: number;
  /** Whatever was collected before the run stopped. Empty on `too-large`: it is not a partial read. */
  stdout: string;
  stderr: string;
}

/**
 * Run one child under bounds that are enforced, and come back with its two streams SEPARATE and every
 * failure named. Never throws: the caller's response is the only place the operator sees what happened,
 * and "which bound stopped it" is the question they need answered.
 */
export async function spawnBounded(argv: string[], opts: BoundedSpawnOptions = {}): Promise<BoundedSpawnResult> {
  const timeoutMs = opts.timeoutMs;
  const maxBytes = opts.maxBytes ?? SPAWN_MAX_BYTES;
  const ignore = opts.discardOutput === true;

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      // The program on stdin and the streams it answers on are independent: a probe that only needs an
      // exit code may still have something to say before it exits.
      stdin: opts.stdin === undefined ? "ignore" : "pipe",
      stdout: ignore ? "ignore" : "pipe",
      stderr: ignore ? "ignore" : "pipe",
      env: opts.env,
    });
  } catch {
    return { reason: "spawn-failed", stdout: "", stderr: "" };
  }

  // Bun types a piped stdin as `number | FileSink | undefined` (the `number` is the fd form), so the
  // pipe is narrowed here: only the sink can be written to.
  const sink = child.stdin;
  if (opts.stdin !== undefined && typeof sink === "object" && sink !== null) {
    // A child that dies before reading its program answers with EPIPE, and Bun's sink reports it ASYN-
    // CHRONOUSLY: the write is accepted, and the rejection arrives after this function has returned. An
    // unhandled rejection kills the process (measured: exit 1), so the promise is caught HERE. The types
    // say `write` returns a number, but under backpressure Bun returns a promise — both are handled.
    try {
      const written = sink.write(opts.stdin) as unknown as { catch?: (fn: () => void) => unknown } | number;
      if (written && typeof (written as { catch?: unknown }).catch === "function") {
        (written as unknown as Promise<number>).catch(() => {});
      }
      const ended = sink.end() as unknown as { catch?: (fn: () => void) => unknown } | undefined;
      if (ended && typeof ended.catch === "function") ended.catch(() => {});
    } catch { /* the child never wanted the program */ }
  }

  // Teardown only needs cancellation, shared by Bun and Node web-stream readers.
  type PipeReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel">;
  const readers: PipeReader[] = [];
  /**
   * Cancel a reader WITHOUT letting its rejection reach the process. `cancel()` on a reader that was
   * already released (its stream hit EOF and `releaseLock()` ran) returns a REJECTED promise, and an
   * unhandled rejection kills a Bun process with exit 1 — measured: the web server died on every
   * deadline whose child happened to die on the TERM. So the rejection is swallowed here, on purpose.
   */
  const cancelReader = (reader: PipeReader): void => {
    try {
      const pending = reader.cancel() as unknown as { catch?: (fn: () => void) => unknown } | undefined;
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch { /* already closed or released */ }
  };
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
      for (const reader of readers) cancelReader(reader);
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
          for (const open of readers) cancelReader(open);
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
