/** Shared queue bridge for conversation clients. No shell expansion or model polling. */
import { homedir } from "node:os";
import { join } from "node:path";
import { rustAgentBin } from "./spawn";

export function taskGraphPath(): string {
  return process.env.MINITUI_TASK_GRAPH_DB ?? join(homedir(), ".local/share/mini-tui/task-graph.sqlite");
}
const ACTIONS = new Set(["put","amend","cancel","cancel-reconcile","graph","graph-read","events","events-read","search","claim","heartbeat","finish","retry","run","help"]);

/** A mutation is intentionally one attempt: retrying after an uncertain response can duplicate work. */
export async function queueCommand(args: string[], signal?: AbortSignal): Promise<{ code: number; output: string; error: string }> {
  const action = args[0] ?? "help";
  if (!ACTIONS.has(action)) throw new Error("unknown queue command");
  if (args.length > 64 || args.some(a => Buffer.byteLength(a) > 64_000 || a.includes("\0"))) throw new Error("queue arguments exceed bounds");
  const bin = rustAgentBin();
  if (!bin) throw new Error("Rust queue binary unavailable; build with task-graph feature");
  if (signal?.aborted) throw new Error("queue command cancelled before launch");
  const argv = [bin,"queue",...args];
  if (!args.includes("--db")) argv.push("--db",taskGraphPath());
  const child = Bun.spawn(argv,{ stdout: "pipe", stderr: "pipe" });
  let exceeded = false;
  let timedOut = false;
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 4 * 1024 * 1024) { exceeded = true; child.kill(); break; }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const stop = () => child.kill("SIGTERM");
  signal?.addEventListener("abort",stop,{ once: true });
  // run owns its worker lifecycle and can be long; other calls are bounded local operations.
  const timer = action === "run" ? undefined : setTimeout(() => { timedOut = true; stop(); },10_000);
  try {
    const [output,error,code] = await Promise.all([read(child.stdout),read(child.stderr),child.exited]);
    if (exceeded) throw new Error("queue output exceeded4MB; narrow events/search rather than retry a mutation");
    if (timedOut) throw new Error("queue command timed out; state may have changed, inspect before retrying");
    if (signal?.aborted) return { code: 130, output, error: error || "queue interrupted; inspect state before retrying\n" };
    return {code,output,error};
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort",stop); }
}
