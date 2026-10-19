/** Shared queue bridge for conversation clients. No shell expansion or model polling. */
import { homedir } from "node:os";
import { join } from "node:path";
import { queueBin } from "./queueBin";

export function taskGraphPath(): string {
  return process.env.MINITUI_TASK_GRAPH_DB ?? join(homedir(), ".local/share/mini-tui/task-graph.sqlite");
}
const ACTIONS = new Set(["put","amend","cancel","cancel-reconcile","graph","graph-read","events","events-read","search","claim","heartbeat","finish","retry","run","help"]);

/** SIGTERM -> SIGKILL after this. The queue binary's SIGTERM handler only sets a flag (E46). */
const KILL_GRACE_MS = 250;

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
 *    4 MB cap left the pipe unread, where a child blocked on write cannot exit at all. Same two
 *    halves as E46's reader: TERM -> KILL after a grace, and cancel the readers — a SIGKILL does
 *    not close a pipe whose write end a grandchild still holds.
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
  const child = Bun.spawn(argv,{ stdout: "pipe", stderr: "pipe" });
  let exceeded = false;
  let timedOut = false;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  /**
   * Stop the child AND stop waiting on its pipes. The second half is what actually ends the wait:
   * with the readers left open, `await child.exited` is not the only thing being waited on, and a
   * grandchild holding the write end makes the EOF unreachable even after a SIGKILL.
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
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = stream.getReader();
    readers.push(reader);
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 4 * 1024 * 1024) {
          exceeded = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          for (const open of readers) {
            try { void open.cancel(); } catch { /* already closed */ }
          }
          break;
        }
        chunks.push(item.value);
      }
    } catch { /* a cancelled pipe is the normal way this ends */ }
    finally { try { reader.releaseLock(); } catch { /* cancelled above */ } }
    return Buffer.concat(chunks).toString("utf8");
  };
  signal?.addEventListener("abort",stop,{ once: true });
  // run owns its worker lifecycle and can be long; other calls are bounded local operations.
  const timer = action === "run" ? undefined : setTimeout(() => { timedOut = true; stop(); }, opts?.timeoutMs ?? 10_000);
  try {
    const [output,error,code] = await Promise.all([read(child.stdout),read(child.stderr),child.exited]);
    if (exceeded) throw new Error("queue output exceeded 4MB; narrow events/search rather than retry a mutation");
    if (timedOut) throw new Error("queue command timed out; state may have changed, inspect before retrying");
    if (signal?.aborted) return { code: 130, output, error: error || "queue interrupted; inspect state before retrying\n" };
    return {code,output,error};
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort",stop); }
}
