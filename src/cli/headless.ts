/**
 * `mini-tui -p "<prompt>"` — a headless session: no TUI, no alternate screen, no keyboard.
 * The same integrated agent runs one turn (tools, follow-up context, skills, providers and
 * the /resume history all work as in the TUI), the answer goes to stdout and the process
 * exits with the run's status — for scripts, CI and other agents (`claude -p`-style).
 *
 * Output formats:
 *   text         the final answer only; `--verbose` streams every step to stderr
 *   json         one JSON result object at the end (`--verbose` adds the event list)
 *   stream-json  one JSON object per line as the run happens (init, events, result)
 */

import { fstatSync } from "node:fs";

import type { Database } from "bun:sqlite";

import { DEFAULT_MODEL } from "../config";
import { loadLastModel } from "../lastModel";
import { runnerSupportsCompactOnly, spawnMini, tailLog, type MiniRun } from "../mini/spawn";
import { sessionRunEnv, sessionTrajectories } from "../mini/sessionEnv";
import { modelEnv } from "../providers";
import {
  createSession,
  rememberAgentRun,
  defaultDbPath,
  findSession,
  latestSession,
  openDb,
  saveTranscript,
  writeResumeFile,
  type SessionRecord,
} from "../sessions";
import { expandSkills } from "../skills";
import { generateTitle } from "../title";
import { createParseState, messagesToEvents, parseInfo, parseTrajectory } from "../traj/parse";
import type { RunEvent, RunInfo, Trajectory, TrajectoryMessage } from "../traj/schema";
import { boundEvent, boundText, slimMessage } from "../traj/slim";
import { readTrajectory, watchTrajectory } from "../traj/watch";
import { headlessSpecs, UsageError, type HeadlessArgs } from "./args";
import { recordUsage } from "../usage";
import { turnFailureCause } from "../turnFailure";

/** Exit codes: scripts can tell "the agent failed" from "you called me wrong". */
export const EXIT_OK = 0;
export const EXIT_RUN_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

export interface HeadlessIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Piped input, or null when stdin is a terminal / nothing was piped. */
  readStdin: () => Promise<string | null>;
  /** Colors on the stderr progress stream. */
  color: boolean;
}

export interface HeadlessResult {
  type: "result";
  subtype: "success" | "error" | "interrupted";
  is_error: boolean;
  result: string;
  exit_status: string;
  session_id: string | null;
  model: string;
  cwd: string;
  num_steps: number;
  api_calls: number;
  cost_usd: number;
  duration_ms: number;
  trajectory_path: string;
  log_path: string;
  error?: string;
  events?: RunEvent[];
}

async function readPipedStdin(): Promise<string | null> {
  try {
    // Only real pipes/files: a terminal, /dev/null or an idle CI socket must never block us.
    const stat = fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile()) return null;
  } catch {
    return null;
  }
  const text = await Bun.stdin.text();
  return text.trim() ? text : null;
}

export function defaultIO(): HeadlessIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: readPipedStdin,
    color: Boolean(process.stderr.isTTY) && !process.env.NO_COLOR,
  };
}

/** `prompt` + piped stdin (`cat log | mini-tui -p "why does this fail?"`). */
export function combinePrompt(prompt: string, stdin: string | null): string {
  const piped = stdin?.trim() ?? "";
  if (!piped) return prompt.trim();
  if (!prompt.trim()) return piped;
  return `${prompt.trim()}\n\n${piped}`;
}

/** The answer of a finished turn: the submission, else the last assistant text. */
export function finalAnswer(events: RunEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "exit" && event.submission.trim()) return event.submission.trim();
    if (event.type === "assistant" && event.text.trim()) return event.text.trim();
    if (event.type === "task") break; // never answer with a previous turn's reply
  }
  return "";
}

/**
 * Where this turn starts in a resumed trajectory: the first follow-up task at or after
 * `minIndex` (the replayed history's length — repairs only ever add messages). `-1` while the
 * new task has not reached the journal yet, so an older turn is never streamed again.
 */
export function turnStartIndex(messages: TrajectoryMessage[], minIndex = 0): number {
  for (let i = Math.max(0, minIndex); i < messages.length; i++) {
    const extra = messages[i]?.extra as Record<string, unknown> | undefined;
    if (messages[i]?.role === "user" && extra?.interrupt_type === "UserNewTask") return i;
  }
  return -1;
}

const ANSI = { dim: "\u001b[2m", bold: "\u001b[1m", red: "\u001b[31m", green: "\u001b[32m", cyan: "\u001b[36m", reset: "\u001b[0m" };

/** Human progress lines for `-p --verbose` (stderr), one block per event. */
export function formatEventText(event: RunEvent, color = false): string {
  const paint = (code: string, text: string) => (color ? `${code}${text}${ANSI.reset}` : text);
  const indent = (text: string) =>
    text
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  switch (event.type) {
    case "task":
      return `${paint(ANSI.bold, "> ")}${event.text}\n`;
    case "thinking":
      return paint(ANSI.dim, `· thought for ${event.seconds}s\n`);
    case "assistant":
      return `${event.text.trim()}\n`;
    case "tool_call":
      return `${paint(ANSI.cyan, "$ ")}${event.command.trim()}\n`;
    case "observation": {
      const output = boundText(event.output.replace(/\s+$/, "")) || "(no output)";
      const code = event.returncode === null ? "" : ` [exit ${event.returncode}]`;
      const body = paint(ANSI.dim, indent(output));
      return `${body}${event.returncode ? paint(ANSI.red, code) : paint(ANSI.dim, code)}\n${event.exceptionInfo ? paint(ANSI.red, indent(event.exceptionInfo)) + "\n" : ""}`;
    }
    case "notice":
      return paint(ANSI.dim, `! ${event.text.trim()}\n`);
    case "exit":
      return paint(event.exitStatus === "Submitted" ? ANSI.green : ANSI.red, `■ ${event.exitStatus || "exit"}\n`);
    case "error":
      return paint(ANSI.red, `${event.text}\n`);
    case "ui-component":
      // The TUI has no rich rendering for generated components (web-only): show
      // what it is so the headless stream stays honest about the turn's shape.
      return paint(ANSI.dim, `· ui-component: ${event.template}\n`);
    case "channel":
      // Espejo: a mirrored WhatsApp message (web-only projection). The headless
      // stream names it honestly instead of pretending it is a turn.
      return paint(ANSI.dim, `· [${event.channel}] ${event.sender}: ${event.text.trim()}\n`);
  }
}

/** A stream-json line for one event; the quiet stream drops thinking and bounds outputs. */
export function streamEvent(event: RunEvent, verbose: boolean): Record<string, unknown> | null {
  if (!verbose && event.type === "thinking") return null;
  return { ...(verbose ? event : boundEvent(event)) };
}

function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

interface Resolved {
  task: string;
  typed: string;
  model: string;
  cwd: string;
  resumed: SessionRecord | null;
}

async function resolveRun(args: HeadlessArgs, io: HeadlessIO, db: () => Database): Promise<Resolved> {
  const cwd = args.cwd ?? process.cwd();
  let resumed: SessionRecord | null = null;
  if (args.continueLast) {
    const latest = latestSession(db(), cwd);
    if (!latest) throw new UsageError(`no saved session in ${cwd} to --continue`);
    resumed = findSession(db(), latest.id);
  } else if (args.resumeId) {
    try {
      resumed = findSession(db(), args.resumeId);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    if (!resumed) throw new UsageError(`no session ${args.resumeId} (see \`mini-tui sessions --all\`)`);
  }
  const typed = args.compact ? "" : combinePrompt(args.prompt, await io.readStdin());
  if (!typed && !args.compact) throw new UsageError('-p needs a prompt: mini-tui -p "<prompt>" (or pipe it on stdin)');
  const expanded = typed ? expandSkills(typed) : { task: "", used: [], missing: [] };
  const model = args.model || DEFAULT_MODEL || resumed?.model || loadLastModel() || "";
  return { task: expanded.task, typed, model, cwd: resumed && !args.cwd ? resumed.cwd : cwd, resumed };
}

/** Run one headless turn. Returns the process exit code (never calls `process.exit`). */
export async function runHeadless(args: HeadlessArgs, io: HeadlessIO = defaultIO()): Promise<number> {
  const started = Date.now();
  let dbHandle: Database | undefined;
  // Resolved per call (not at import): an embedding process (the channel
  // consumer) may pass its own store or point MINITUI_DB_PATH after module load.
  const db = () => (dbHandle ??= openDb(args.dbPath ?? defaultDbPath()));
  const errorOut = (message: string) => {
    if (args.outputFormat === "text") io.stderr(`error: ${message}\n`);
    else io.stdout(`${JSON.stringify({ type: "result", subtype: "error", is_error: true, error: message })}\n`);
  };

  let resolved: Resolved;
  try {
    resolved = await resolveRun(args, io, db);
  } catch (error) {
    errorOut((error as Error).message);
    return EXIT_USAGE;
  }
  const { task, typed, model, cwd, resumed } = resolved;
  if (args.compact && !runnerSupportsCompactOnly()) {
    errorOut("--compact needs the integrated runner (the plain `mini` CLI cannot compact)");
    return EXIT_USAGE;
  }

  // Session bookkeeping: a new row (titled like the TUI does), or continue a saved one.
  const persist = !args.noSession;
  let sessionId: string | null = resumed?.id ?? null;
  let titleDone: Promise<void> = Promise.resolve();
  let titleJob: ReturnType<typeof generateTitle> | undefined;
  let resumePath: string | undefined;
  /** Messages the agent replays before this turn (exit markers are dropped on resume). */
  let historyLength = 0;
  if (resumed) {
    const history = JSON.parse(resumed.messages_json || "[]") as TrajectoryMessage[];
    historyLength = history.filter((message) => message.role !== "exit").length;
    if (history.length) resumePath = writeResumeFile(resumed.id, history);
    else if (args.compact) {
      errorOut(`session ${resumed.id} has no conversation to compact`);
      return EXIT_USAGE;
    }
  } else if (persist) {
    sessionId = newSessionId();
    try {
      createSession(db(), { id: sessionId, cwd, model, task: typed });
      if (process.env.MINITUI_NO_TITLE !== "1" && model) {
        const id = sessionId;
        titleDone = new Promise((resolve) =>
          titleJob = generateTitle(
            typed,
            model,
            (title) => {
              try {
                db().query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
              } catch {
                // best-effort
              }
            },
            resolve,
          ),
        );
      }
    } catch {
      sessionId = null; // persistence is best-effort, the run still happens
    }
  }

  let recovery: string[] = [];
  if (persist && resumed && sessionId) {
    try { recovery = sessionTrajectories(db(), sessionId); } catch { /* persistence is best effort */ }
  }
  let run: MiniRun;
  try {
    run = spawnMini({
      task,
      model: model || undefined,
      specs: headlessSpecs(args),
      cwd,
      resumePath,
      compactOnly: args.compact || undefined,
      // Caller-supplied run env (BYOK keys, the channel's `MINI_CHANNEL_SUBJECT`) wins over
      // the model-derived one: both are per-run facts the embedding process already decided.
      env: sessionRunEnv({ ...modelEnv(model), ...args.env }, persist ? sessionId : null, recovery),
      control: false,
    });
  } catch (error) {
    titleJob?.cancel();
    errorOut(`could not start the agent: ${(error as Error).message}`);
    return EXIT_RUN_FAILED;
  }

  if (persist && sessionId) {
    try { rememberAgentRun(db(), sessionId, run.session.trajPath); } catch { /* persistence is best effort */ }
  }

  const stream = args.outputFormat === "stream-json";
  const emitJson = (value: unknown) => io.stdout(`${JSON.stringify(value)}\n`);
  if (stream) {
    emitJson({
      type: "init",
      session_id: sessionId,
      resumed: Boolean(resumed),
      model,
      cwd,
      runner: run.runner,
      trajectory_path: run.session.trajPath,
      log_path: run.session.logPath,
    });
  } else if (args.verbose && args.outputFormat === "text") {
    io.stderr(formatEventText({ type: "notice", text: `mini-tui -p · ${model || "default model"} · ${cwd}${sessionId ? ` · ${sessionId}` : ""}` }, io.color));
  }

  // Incremental parse of the live journal, exactly like the TUI (append-only messages).
  const parseState = createParseState();
  let consumed = 0;
  // Resumed prompt: wait for the new task. Resumed compaction: everything after the history.
  let emitFrom: number | null = resumePath && !args.compact ? null : resumePath ? historyLength : 0;
  if (emitFrom) Object.assign(parseState, { taskSeen: true });
  consumed = emitFrom ?? 0;
  const turnEvents: RunEvent[] = [];
  let lastTraj: Trajectory | null = null;
  let sourceMessages: TrajectoryMessage[] | undefined;
  let retainedMessages: TrajectoryMessage[] = [];
  // v6-B: messages already billed to the usage ledger (see onSnapshot).
  let usageSeen = 0;
  const onSnapshot = (traj: Trajectory) => {
    const messages = traj.messages ?? [];
    // Journal snapshots reuse one append-only array, including partial-token updates.
    // Retain only its newly appended messages, not a full history copy on each delta.
    // A full JSON/final read or journal reset supplies a new array and rebuilds safely.
    if (messages !== sourceMessages || messages.length < retainedMessages.length) {
      sourceMessages = messages;
      retainedMessages = messages.map(slimMessage);
    } else {
      for (let i = retainedMessages.length; i < messages.length; i++) retainedMessages.push(slimMessage(messages[i]!));
    }
    lastTraj = { ...traj, messages: retainedMessages };
    if (messages.length < consumed) return; // a rewrite mid-flight: the final read settles it
    // v6-B: bill the model calls this run made, from the same journal the events
    // come from. Best-effort (never throws) and deduped per call, so the final
    // re-read below can hand the whole turn over again without double-counting.
    if (messages.length > usageSeen) {
      const runInfo = parseInfo(traj);
      recordUsage(messages, { session: sessionId ?? "cli", task: args.taskId ?? "", fallbackModel: runInfo.model ?? model, apiBase: runInfo.apiBase }, usageSeen);
      usageSeen = messages.length;
    }
    if (emitFrom === null) {
      // A resumed trajectory replays the saved history first: stream from the new task on.
      const at = turnStartIndex(messages, historyLength);
      if (at < 0) return;
      emitFrom = at;
      Object.assign(parseState, { taskSeen: true });
      consumed = at;
    }
    const fresh = messagesToEvents(messages, { showSystem: args.showSystem }, consumed, parseState);
    consumed = messages.length;
    for (const event of fresh) {
      if (args.compact && !(event.type === "notice" && event.interruptType === "context")) continue;
      turnEvents.push(event);
      if (stream) {
        const line = streamEvent(event, args.verbose);
        if (line) emitJson(line);
      } else if (args.verbose && args.outputFormat === "text") {
        io.stderr(formatEventText(event, io.color));
      }
    }
  };
  const watch = watchTrajectory(run.session.trajPath, onSnapshot);

  let interrupted = false;
  const onSignal = () => {
    if (interrupted) {
      run.kill();
      return;
    }
    interrupted = true;
    run.interrupt();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // v6-G (E2): the caller's own abort. An embedding process that has to stop
  // cannot rely on a signal IT did not receive — the consumer's `stop()` used to
  // reach nothing at all, so the turn ran to its own end (measured: 7945 ms of
  // an 8 s turn) and systemd SIGKILLed the control group at TimeoutStopSec. Same
  // teardown as the signal path, so the agent still writes its own session row.
  const onAbort = () => {
    if (args.signal?.aborted) onSignal();
  };
  if (args.signal) {
    if (args.signal.aborted) onAbort();
    else args.signal.addEventListener("abort", onAbort, { once: true });
  }
  let code: number | null;
  try {
    code = await run.exited;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    args.signal?.removeEventListener("abort", onAbort);
    watch.stop();
  }
  const final = readTrajectory(run.session.trajPath);
  if (final) onSnapshot(final);

  const traj: Trajectory = lastTraj ?? { messages: [] };
  const info: RunInfo = parseInfo(traj);
  const exitEvent = [...turnEvents].reverse().find((event) => event.type === "exit");
  const exitStatus = exitEvent?.type === "exit" ? exitEvent.exitStatus : info.exitStatus ?? "";
  const compactDone = args.compact && turnEvents.some((event) => event.type === "notice" && event.interruptType === "context");
  const answer = args.compact
    ? turnEvents.map((event) => (event.type === "notice" ? event.text : "")).filter(Boolean).join("\n")
    : finalAnswer(turnEvents);
  const ok = !interrupted && code === 0 && (args.compact ? compactDone : exitStatus === "Submitted");
  let errorText = "";
  if (!ok && !interrupted) {
    // The log tail is whatever the process left behind, and the agent mixes real failures with
    // operator diagnostics in it — the resume-collapse notice (`[turn] resumed session held N
    // unfinished copies...`) is the E4 fix working, but as the last line written it became the
    // whole error text and reached the user in place of the cause that preceded it. Diagnostics are
    // dropped here, at the point that mints `error`, so every consumer of the result (the channel
    // consumer, the queue bridge, the TUI) inherits the fix rather than each re-implementing it.
    errorText = turnFailureCause(tailLog(run.session.logPath));
    if (!errorText) errorText = exitStatus ? `the run ended with ${exitStatus}` : `the agent exited with code ${code}`;
  }

  // Persist like the TUI: the whole transcript (history + this turn) under the session id.
  if (persist && sessionId && (traj.messages?.length ?? 0) > 0) {
    try {
      const all = parseTrajectory(traj, { showSystem: args.showSystem });
      const events = all.events.map(boundEvent);
      if (errorText && !ok) events.push({ type: "error", text: errorText });
      saveTranscript(db(), sessionId, events, info, traj.messages ?? []);
      if (model) db().query("UPDATE sessions SET model = ? WHERE id = ?").run(model, sessionId);
    } catch {
      // persistence is best-effort
    }
  }
  // a title still being generated lands in the row before we close it (bounded wait)
  let titleDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([titleDone, new Promise<void>((resolve) => { titleDeadline = setTimeout(resolve, 3000); })]);
  } finally {
    if (titleDeadline) clearTimeout(titleDeadline);
    // A title is cosmetic: its child pipes/timer must not keep a finished task alive.
    titleJob?.cancel();
  }

  const steps = turnEvents.filter((event) => event.type === "tool_call").length;
  const result: HeadlessResult = {
    type: "result",
    subtype: ok ? "success" : interrupted ? "interrupted" : "error",
    is_error: !ok,
    result: answer,
    exit_status: interrupted ? "Interrupted" : exitStatus,
    session_id: persist ? sessionId : null,
    model: model || info.model || "",
    cwd,
    num_steps: steps,
    api_calls: info.apiCalls,
    cost_usd: info.cost,
    duration_ms: Date.now() - started,
    trajectory_path: run.session.trajPath,
    log_path: run.session.logPath,
    ...(errorText ? { error: errorText } : {}),
  };

  if (args.outputFormat === "text") {
    if (answer) io.stdout(`${answer}\n`);
    if (args.verbose) {
      const summary = `${result.subtype} · ${steps} step${steps === 1 ? "" : "s"} · ${info.apiCalls} calls · $${info.cost.toFixed(4)} · ${(result.duration_ms / 1000).toFixed(1)}s${result.session_id ? ` · session ${result.session_id}` : ""}`;
      io.stderr(formatEventText({ type: "notice", text: summary }, io.color));
    }
    if (!ok && !args.quiet) io.stderr(interrupted ? "interrupted\n" : `error: ${errorText}\n`);
  } else if (args.outputFormat === "json") {
    emitJson(args.verbose ? { ...result, events: turnEvents.map(boundEvent) } : result);
  } else {
    emitJson(result);
  }
  try {
    dbHandle?.close();
  } catch {
    // closing is best-effort
  }
  return ok ? EXIT_OK : interrupted ? EXIT_INTERRUPTED : EXIT_RUN_FAILED;
}
