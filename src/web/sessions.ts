/**
 * Live sessions for the web app.
 *
 * Each session owns one agent process and one transcript, and works
 * identically whether it runs here or on a remote box over SSH — the only
 * difference is who spawns the process and where the trajectory lands.
 * Both paths feed the TUI's own parser, so the web app renders exactly what
 * the terminal UI would.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { expandLocal } from "./folders";
import { homedir } from "node:os";
import { join } from "node:path";

import { attachMini, foreignRunAlive, runnerSupportsCompactOnly, spawnMini, type MiniRun } from "../mini/spawn";
import { modelEnv } from "../providers";
import { DEFAULT_MODEL } from "../config";
import { loadLastModel, saveLastModel } from "../lastModel";
import { expandSkills } from "../skills";
import {
  defaultDbPath,
  createSession,
  listHistory,
  listFolders,
  type FolderSummary,
  deleteSession,
  clearLiveRun,
  getLiveRun,
  rememberAgentRun,
  agentRuns,
  getSession,
  registerLiveRun,
  sessionStamps,
  type SessionRecord,
  openDb,
  saveTranscript,
  updateSession,
  writeResumeFile,
} from "../sessions";
import { createParseState, messagesToEvents, parseInfo, parseTrajectory } from "../traj/parse";
import { boundEvent, slimMessage } from "../traj/slim";
import { readTrajectory, watchTrajectory, type WatchHandle } from "../traj/watch";
import type { RunEvent, RunInfo, Trajectory, TrajectoryMessage } from "../traj/schema";
import { probeHost, startRemoteRun, type RemoteRun, type SshTarget } from "./ssh";
import { readPlan, type SessionPlan } from "../mini/plans";
import { SubagentSync, readSubagentIndex, subagentIndexFresh, type SubagentView } from "../mini/subagents";

/** One saved session in the history list: metadata only, no transcript. */
export interface HistoryItem {
  id: string;
  title: string;
  cwd: string;
  model: string;
  task: string;
  createdAt: number;
  updatedAt: number;
  apiCalls: number;
  cost: number;
  exitStatus: string;
  /** A saved conversation exists to continue from. */
  resumable: boolean;
  /** This server already holds it open. */
  open: boolean;
}

export type SessionStatus = "idle" | "running" | "done" | "error" | "interrupted";

export interface LiveSession {
  id: string;
  title: string;
  cwd: string;
  model: string;
  task: string;
  target: "local" | "remote";
  hostId?: string;
  status: SessionStatus;
  events: RunEvent[];
  /** The assistant message currently being generated, per channel. Cleared when it lands. */
  partial?: { thinking: string; text: string };
  messages: TrajectoryMessage[];
  info: RunInfo;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  apiCalls: number;
  cost: number;
  exitStatus: string;
  /** Subagents this session's agent started (`mini-agent-rs agent spawn`), each a session of its own. */
  subagents?: SubagentView[];
  /** The session that started this one as a subagent. */
  parentId?: string;
}

export interface RemoteHostRecord {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  workdir: string;
  identity?: string;
  lastSeen?: number;
  lastError?: string;
  online?: boolean;
}

const CONFIG_DIR = process.env.MINITUI_CONFIG_DIR ?? join(homedir(), ".config", "mini-tui");
const HOSTS_PATH = join(CONFIG_DIR, "web-hosts.json");

function newId(): string {
  // Same shape as the TUI's session ids: short, sortable, human-typeable.
  return `s-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

function titleFor(task: string): string {
  const clean = task.replace(/\s+/g, " ").trim();
  return clean.length <= 48 ? clean : `${clean.slice(0, 47)}…`;
}

export function loadHosts(): RemoteHostRecord[] {
  try {
    const data = JSON.parse(readFileSync(HOSTS_PATH, "utf8"));
    return Array.isArray(data) ? (data as RemoteHostRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveHosts(hosts: RemoteHostRecord[]): void {
  try {
    // The config dir may not exist yet (first run): create it, or every save
    // fails silently and hosts vanish on reload.
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(HOSTS_PATH, `${JSON.stringify(hosts, null, 2)}\n`);
  } catch (error) {
    console.error(`mini-tui web: could not save hosts to ${HOSTS_PATH}: ${(error as Error).message}`);
  }
}

interface Internal {
  session: LiveSession;
  run?: MiniRun;
  remote?: RemoteRun;
  watch?: WatchHandle;
  /**
   * Prompts echoed into the transcript at send time, awaiting the journal's own copy of them. The agent
   * records each follow-up as a `UserNewTask` message; without this the same prompt would show twice.
   */
  pendingTasks?: string[];
  /** The local agent process has exited (a resumed session has none until a follow-up starts one). */
  exited?: boolean;
  /** Trajectory path on the local box (local runs only). */
  trajPath?: string;
  consumed: number;
  parseState: ReturnType<typeof createParseState>;
  /** A liveness probe for this entry is in flight (never two for one entry at once). */
  probing?: boolean;
  /** Newest `updated_at` of the saved row this copy already reflects (ours or another UI's save). */
  syncedAt?: number;
  /** The next trajectory snapshot rebuilds the transcript (just attached to another UI's agent). */
  rebuild?: boolean;
  /** Transcript counts at the last mid-run save: a running session persists at most every PERSIST_MS. */
  persistedCount?: number;
  persistedAt?: number;
}

/** How often held sessions are checked for agents and saves made by other UIs (a terminal). */
const SYNC_MS = Number(process.env.MINITUI_WEB_SYNC_MS ?? 1000);
/** How often a running session's transcript is saved mid-run, so a restart or crash keeps it. */
const PERSIST_MS = Number(process.env.MINITUI_WEB_PERSIST_MS ?? 15000);

/** The agent answered and holds at its exit (only compaction notes may follow the `exit`). */
function waitingAtExit(messages: TrajectoryMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "exit") return true;
    const itype = (message.extra as Record<string, unknown> | undefined)?.interrupt_type;
    if (itype !== "Compaction" && itype !== "CompactionSkipped") return false;
  }
  return false;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

/** Whether the subagent strip the UI shows would change: same length, and every shown field equal. */
function viewsChanged(before: SubagentView[] | undefined, after: SubagentView[]): boolean {
  const prev = before ?? [];
  if (prev.length !== after.length) return true;
  for (let i = 0; i < after.length; i++) {
    const a = prev[i]!, b = after[i]!;
    if (a.sessionId !== b.sessionId || a.state !== b.state || a.exitStatus !== b.exitStatus) return true;
    if (a.steps !== b.steps || a.cost !== b.cost || a.memRss !== b.memRss || a.memAvg !== b.memAvg) return true;
    if (a.lastCommand !== b.lastCommand || a.task !== b.task) return true;
  }
  return false;
}

import { log } from "./log";

export class SessionManager {
  #live = new Map<string, Internal>();
  /** Last logged plan status per session and task, for transition-only logging. */
  #planStatus = new Map<string, Map<string, string>>();
  #db: ReturnType<typeof openDb> | null = null;
  #onChange: (session: LiveSession) => void;

  #closed = false;
  /** The pass in flight, so a caller that needs the result (a test) can wait for it. */
  #pass?: Promise<void>;
  #syncTimer?: ReturnType<typeof setTimeout>;
  #syncEvery = 0;
  #syncing = false;
  #subagents = new SubagentSync(() => this.db());

  constructor(onChange: (session: LiveSession) => void, options: { syncMs?: number } = {}) {
    this.#onChange = onChange;
    this.#syncEvery = options.syncMs ?? SYNC_MS;
    this.#scheduleSync();
  }

  /**
   * Arm the next tick, and only then run it.
   *
   * `setInterval` fires every `every` ms no matter what the last tick did: one slow tick (a
   * synchronous reload of a hundred held sessions, a database busy with another UI's save) delays
   * the whole event loop and the next tick queues behind it, so ticks pile up and each one is
   * slower than the last. Scheduling the next pass from the end of this one keeps at most one tick
   * alive, and its latency is paid once per pass instead of once per overlapping interval.
   */
  #scheduleSync(): void {
    if (this.#syncEvery <= 0 || this.#syncTimer) return;
    this.#syncTimer = setTimeout(() => {
      this.#syncTimer = undefined;
      // A pass that rejects must not take the timer (or the process, on an unhandled rejection)
      // with it: the next one is scheduled either way.
      void this.syncExternal().catch(() => {});
      this.#scheduleSync();
    }, this.#syncEvery);
    (this.#syncTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Children of the sessions this server follows: saved as sessions under their parent, their live
   * agents announced so they can be opened and messaged, and listed on the parent for the UI.
   */
  #syncSubagents(): void {
    for (const entry of this.#live.values()) {
      const traj = entry.trajPath;
      if (!traj) continue;
      // The roster of a run this server drives itself is current: its watcher already read the
      // journal this tick, so re-reading the index would only repeat what just happened.
      const internal = entry.run && !entry.exited && !entry.run.attached;
      if (internal && subagentIndexFresh(traj)) continue;
      let views: SubagentView[] = entry.session.subagents ?? [];
      try {
        const next = this.#subagents.sync(entry.session.id, traj);
        if (internal && !next.length && !views.length) continue;
        views = next;
      } catch {
        continue;
      }
      if (!views.length && !entry.session.subagents?.length) continue;
      // Compare by the fields the UI actually shows, without serializing the whole array twice
      // per session per tick: at 100 children that was the largest cost of an idle tick.
      if (!viewsChanged(entry.session.subagents, views)) continue;
      entry.session.subagents = views;
      log("session.subagents", { id: entry.session.id, children: views.map((v) => `${v.name}:${v.state}`).join(",") });
      this.#emit(entry);
    }
  }

  /** The DAG plans of the sessions this server follows (their hubs write them next to their runs). */
  plans(): SessionPlan[] {
    const out: SessionPlan[] = [];
    for (const entry of this.#live.values()) {
      const traj = entry.trajPath;
      if (!traj) continue;
      try {
        const doc = readPlan(entry.session.id, traj);
        if (doc) {
          this.#logPlanTransitions(entry.session.id, doc);
          out.push(doc);
        }
      } catch {
        // a busy disk is checked again on the next poll
      }
    }
    return out;
  }

  /** One log line per plan-task status change: the orchestration path at a glance. */
  #logPlanTransitions(id: string, doc: SessionPlan): void {
    const prev = this.#planStatus.get(id) ?? new Map<string, string>();
    const next = new Map<string, string>();
    for (const t of doc.tasks) {
      next.set(t.id, t.status);
      const before = prev.get(t.id);
      if (before !== t.status) log("plan.task", { session: id, task: t.id, title: t.title.slice(0, 80), from: before ?? "new", to: t.status });
    }
    this.#planStatus.set(id, next);
  }

  /** Stop the background sync (tests, shutdown). */
  dispose(): void {
    this.#closed = true;
    if (this.#syncTimer) clearTimeout(this.#syncTimer);
    this.#syncTimer = undefined;
    this.#syncEvery = 0;
  }

  /**
   * Keep held sessions in step with the other UIs that share the database.
   *
   * - An agent another UI runs for a held session (a terminal continued it) is followed: its
   *   trajectory streams here as it is written, and prompts sent from here reach it.
   * - A save another UI made since we last looked (a turn that ran while nothing was attached
   *   here) replaces the stale copy, so the next message continues the real conversation.
   */
  syncExternal(): Promise<void> {
    // A pass re-entered while it is still running (the timer fired, or a change callback poked the
    // manager) would redo the whole pass against half-updated entries: let the one in flight finish.
    if (this.#syncing) return this.#pass ?? Promise.resolve();
    this.#syncing = true;
    const pass = this.#syncExternal().finally(() => {
      this.#syncing = false;
      this.#pass = undefined;
    });
    this.#pass = pass;
    return pass;
  }

  /**
   * One pass over the held sessions.
   *
   * Asynchronous, and bounded in what it reads per pass: entries whose liveness probe is still in
   * flight are left for the next pass, so a tick cannot stretch into a long blocking burst however
   * many sessions this server holds.
   */
  async #syncExternal(): Promise<void> {
    this.#syncSubagents();
    this.#persistDirty();
    const idle = [...this.#live.values()].filter(
      (entry) =>
        entry.session.target === "local" && !(entry.run && !entry.exited) && entry.session.status !== "running" && !entry.probing,
    );
    if (!idle.length) return;
    let stamps: Map<string, number>;
    try {
      // One query for the whole batch: `updated_at` is the cheap "did another UI save it" signal,
      // and only the sessions whose stamp moved are read back in full below.
      stamps = sessionStamps(this.db(), idle.map((entry) => entry.session.id));
    } catch {
      return; // the database is busy: try again on the next tick
    }
    const settled = await Promise.all(idle.map((entry) => this.#attachExternal(entry)));
    // An attach decides the session's content from the agent's own trajectory; a reload would
    // overwrite it with an older copy, so only the ones that did not attach are refreshed.
    for (let i = 0; i < idle.length; i++) {
      if (settled[i]) continue;
      const stamp = stamps.get(idle[i]!.session.id);
      if (stamp === undefined || stamp <= (idle[i]!.syncedAt ?? 0)) continue;
      this.#reloadFromDb(idle[i]!);
      // Hand the event loop back between rows: a transcript some other UI saved can be tens of MB
      // of JSON to read and parse, and yielding here keeps that burst from ever becoming one
      // unbroken stall (every socket, timer and request waits for it) however many rows moved.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  db() {
    this.#db ??= openDb(defaultDbPath());
    return this.#db;
  }

  list(): LiveSession[] {
    return [...this.#live.values()]
      .map((entry) => entry.session)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * The trajectory a session's agent journals into, when this server knows it: its own run or an
   * attached one, the live run another UI announced, or -- for an agent session -- its entry in its
   * parent's roster (`<parent>~<name>`). The agents panel reads the tree from there.
   */
  trajOf(id: string): string | undefined {
    return this.trajsOf(id)[0];
  }

  /**
   * Every run folder of a session, newest first: a session continued after a restart journals into
   * a new folder, and the agents its earlier runs started stay under the earlier one.
   */
  trajsOf(id: string): string[] {
    const out: string[] = [];
    const add = (p: string | undefined) => {
      if (p && !out.includes(p)) out.push(p);
    };
    add(this.#live.get(id)?.trajPath);
    try {
      add(getLiveRun(this.db(), id)?.traj_path);
      for (const p of agentRuns(this.db(), id)) add(p);
    } catch {
      // busy database: the next poll asks again
    }
    if (out.length) return out;
    const cut = id.lastIndexOf("~");
    if (cut > 0) {
      const parentTraj = this.trajsOf(id.slice(0, cut))[0];
      if (parentTraj) {
        const name = id.slice(cut + 1);
        const child = readSubagentIndex(parentTraj).find((e) => e.name === name);
        if (child?.traj_path) return [child.traj_path];
      }
    }
    return [];
  }

  get(id: string): LiveSession | undefined {
    return this.#live.get(id)?.session;
  }

  #emit(entry: Internal): void {
    entry.session.updatedAt = Date.now();
    this.#onChange(entry.session);
  }

  /** Parse new messages and append the resulting events. */
  #ingest(entry: Internal, traj: Trajectory, showSystem = false): void {
    const messages = traj.messages ?? [];
    if (entry.rebuild && messages.length) {
      // Attached to another UI's agent: its trajectory replaces the saved copy shown meanwhile.
      entry.rebuild = false;
      entry.consumed = 0;
      entry.parseState = createParseState();
      entry.session.events = entry.session.events.filter((event) => event.type === "notice" && event.interruptType === "attach");
      entry.pendingTasks = [];
    }
    if (messages.length < entry.consumed) {
      // A rewrite from scratch: replay the whole thing.
      entry.consumed = 0;
      entry.parseState = createParseState();
      entry.session.events = [];
      entry.pendingTasks = [];
    }
    // The in-flight message: streamed fragments arrive here long before the message that
    // carries them, so they are the only thing the UI can show while the model is writing.
    const partial = traj.partial;
    entry.session.partial = partial && (partial.thinking || partial.text) ? partial : undefined;

    if (messages.length === entry.consumed) {
      const info = parseInfo(traj);
      entry.session.info = info;
      entry.session.apiCalls = info.apiCalls;
      entry.session.cost = info.cost;
      if (info.exitStatus) entry.session.exitStatus = info.exitStatus;
      this.#emit(entry);
      return;
    }
    let fresh = messagesToEvents(messages, { showSystem }, entry.consumed, entry.parseState);
    entry.consumed = messages.length;
    if (entry.pendingTasks?.length) {
      // The prompt was echoed when it was sent; drop the journal's copy so it shows exactly once.
      const pending = [...entry.pendingTasks];
      fresh = fresh.filter((event) => {
        if (event.type !== "task") return true;
        const at = pending.indexOf(event.text);
        if (at === -1) return true;
        pending.splice(at, 1);
        return false;
      });
      entry.pendingTasks = pending;
    }
    if (fresh.length) entry.session.events.push(...fresh.map(boundEvent));

    const info = parseInfo(traj);
    entry.session.info = info;
    entry.session.apiCalls = info.apiCalls;
    entry.session.cost = info.cost;
    if (info.exitStatus) entry.session.exitStatus = info.exitStatus;

    const exit = [...fresh].reverse().find((event) => event.type === "exit");
    // A turn this server did not start (a prompt typed in the terminal that owns the agent): its
    // task arriving with no exit after it means the agent is working again.
    if (!exit && entry.run && !entry.exited && entry.session.status !== "running" && entry.session.status !== "interrupted" && fresh.some((event) => event.type === "task")) {
      entry.session.status = "running";
      entry.session.startedAt = Date.now();
    }
    // A stop the user asked for stays a stop: the exit the agent journals as it winds down must not
    // turn "interrupted" back into "done" (or "error").
    if (exit && exit.type === "exit" && entry.session.status !== "interrupted") {
      entry.session.exitStatus = exit.exitStatus;
      entry.session.status = exit.exitStatus === "Submitted" ? "done" : "error";
    }
    // Keep the retained copy slim: the journal-backed watcher re-slims after
    // the callback, and a long run otherwise holds every raw API response.
    entry.session.messages = messages.map(slimMessage);
    this.#emit(entry);
  }

  async create(options: {
    prompt: string;
    cwd?: string;
    model?: string;
    target: "local" | "remote";
    hostId?: string;
  }): Promise<LiveSession> {
    const id = newId();
    const title = titleFor(options.prompt);
    if (options.model?.trim()) saveLastModel(options.model.trim());
    const model = options.model || "";

    if (options.target === "remote") {
      if (!options.hostId) throw new Error("a remote session needs a host");
      const host = loadHosts().find((h) => h.id === options.hostId);
      if (!host) throw new Error("unknown remote host");
      // A remote folder is the host's path, never resolved against this machine.
      return this.#createRemote(id, title, options.cwd?.trim() || "", model, options.prompt, host);
    }
    // A local folder must exist here, or the agent would silently start somewhere else.
    const cwd = options.cwd?.trim() ? expandLocal(options.cwd) : process.cwd();
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`${cwd} is not a folder on this machine`);
    return this.#createLocal(id, title, cwd, model, options.prompt);
  }

  #createLocal(
    id: string,
    title: string,
    cwd: string,
    model: string,
    prompt: string,
  ): LiveSession {
    // A connected provider's key is injected only for a model that belongs to it, exactly as the
    // terminal UI does; without this a BYOK model has no credentials in a web session.
    const effective = model || DEFAULT_MODEL || loadLastModel();
    const expanded = expandSkills(prompt);
    const run = spawnMini({
      task: expanded.task,
      model: effective || undefined,
      // The agent fills this session's task card (`mini-tui tasks set`): it must know which session
      // it is, and this is the one place that knows.
      env: { ...modelEnv(effective), MINITUI_SESSION_ID: id },
      cwd,
      // The control channel stays on: follow-ups continue the same conversation.
      control: true,
    });

    const session: LiveSession = {
      id,
      title,
      cwd,
      model: effective,
      task: prompt,
      target: "local",
      status: "running",
      events: [],
      messages: [],
      info: { cost: 0, apiCalls: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      apiCalls: 0,
      cost: 0,
      exitStatus: "",
    };
    const entry: Internal = {
      session,
      run,
      trajPath: run.session.trajPath,
      consumed: 0,
      parseState: createParseState(),
    };
    this.#live.set(id, entry);
    log("session.created", { id, pid: run.pid, model: effective, cwd, target: "local", task: prompt.slice(0, 120) });

    try {
      createSession(this.db(), { id, title, cwd, model: effective, task: prompt });
    } catch {
      // the /resume history is best-effort
    }
    this.#announce(entry, run);

    entry.watch = watchTrajectory(run.session.trajPath, (traj) => this.#ingest(entry, traj));

    void run.exited.then(async (code) => {
      this.#retire(entry, run);
      if (entry.run !== run) return;
      entry.exited = true;
      entry.watch?.stop();
      const final = readTrajectory(run.session.trajPath);
      if (final) this.#ingest(entry, final);
      // An interrupt() already decided the outcome; a non-zero exit code here
      // is the consequence of that signal, not a failure.
      const interrupted = session.status === "interrupted";
      session.partial = undefined; // nothing is in flight once the process is gone
      this.#finish(entry, interrupted ? "interrupted" : code === 0 ? "done" : "error", code);
    });

    this.#emit(entry);
    return session;
  }

  /**
   * Remote: the agent runs headless on the server. `mini-tui -p -o stream-json`
   * emits one JSON object per event, so we drive the UI straight from that
   * stream and keep the journal tail for a final catch-up.
   */
  async #createRemote(
    id: string,
    title: string,
    cwd: string,
    model: string,
    prompt: string,
    host: RemoteHostRecord,
  ): Promise<LiveSession> {
    // The folder picked for this chat, else the host's default folder.
    const workdir = cwd || host.workdir;
    const target: SshTarget = {
      host: host.host,
      port: host.port,
      user: host.user,
      identity: host.identity,
      workdir,
      model: model || undefined,
    };

    const session: LiveSession = {
      id,
      title,
      cwd: workdir,
      model,
      task: prompt,
      target: "remote",
      hostId: host.id,
      status: "running",
      events: [],
      messages: [],
      info: { cost: 0, apiCalls: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      apiCalls: 0,
      cost: 0,
      exitStatus: "",
    };
    const entry: Internal = { session, consumed: 0, parseState: createParseState() };
    this.#live.set(id, entry);
    log("session.created", { id, host: host.id, model, cwd: workdir, target: "remote", task: prompt.slice(0, 120) });
    // A remote chat is saved like a local one. Every later save is an UPDATE of this row; without it they
    // all updated nothing, so remote chats never reached the history (nor the sidebar's folders).
    try {
      createSession(this.db(), { id, title, cwd: workdir, model, task: prompt });
    } catch {
      // persistence is best-effort
    }

    // Echo the prompt immediately, exactly like the TUI does on submit.
    session.events.push({ type: "task", text: prompt });
    this.#emit(entry);

    const remote = startRemoteRun(target, expandSkills(prompt).task, (stderr) => {
      const text = stderr.trim();
      if (!text) return;
      session.events.push({ type: "notice", text });
      this.#emit(entry);
    });
    entry.remote = remote;

    let buffer = "";
    remote.onData((chunk) => {
      buffer += chunk;
      // stream-json lines arrive one per event; keep the partial tail for the
      // next chunk so a line split across reads is never dropped.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text || text.startsWith("\u0000")) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(text);
        } catch {
          continue; // not an event line (agent log noise)
        }
        // The prompt was already echoed above when the session was created;
        // the agent's own `task` line would render it a second time.
        if (payload.type !== "task") {
          const event = remoteEventToRunEvent(payload);
          if (event) {
            session.events.push(event);
            this.#emit(entry);
          }
        }
        if (payload.type === "result") {
          const result = payload as { subtype?: string; num_steps?: number; api_calls?: number; cost_usd?: number; exit_status?: string };
          session.apiCalls = result.api_calls ?? session.apiCalls;
          session.cost = result.cost_usd ?? session.cost;
          session.exitStatus = result.exit_status ?? session.exitStatus;
          if (!session.events.some((e) => e.type === "exit")) {
            session.events.push({
              type: "exit",
              exitStatus: session.exitStatus || (result.subtype === "success" ? "Submitted" : "error"),
              submission: String(payload.result ?? ""),
            });
          }
        }
      }
    });

    void remote.exited.then((code) => {
      const interrupted = session.status === "interrupted";
      if (!session.events.some((e) => e.type === "exit")) {
        session.events.push({
          type: "exit",
          exitStatus: interrupted ? "Interrupted" : code === 0 ? "Submitted" : "Error",
          submission: "",
        });
      }
      this.#finish(entry, interrupted ? "interrupted" : code === 0 ? "done" : "error", code);
    });

    return session;
  }

  #finish(entry: Internal, status: SessionStatus, code: number | null): void {
    const session = entry.session;
    log("session.finish", { id: session.id, status, code, cost: session.cost, apiCalls: session.apiCalls });
    if (status === "interrupted") session.exitStatus = session.exitStatus || "Interrupted";
    session.status = status;
    session.info = { ...session.info, exitStatus: session.exitStatus };

    // A run the user stopped is not a failure: no error card, no log tail.
    if (status === "error" && !session.events.some((e) => e.type === "error")) {
      const tail = entry.run ? readLogTail(entry.run.session.logPath) : "";
      const explained = explainFailure(tail);
      if (explained) session.events.push({ type: "error", text: explained });
      else if (tail) session.events.push({ type: "error", text: tail });
    }
    this.#persist(entry);
    this.#emit(entry);
  }

  /** Save to the same /resume history the TUI reads. */
  #persist(entry: Internal): void {
    const session = entry.session;
    // An agent another UI owns is saved by that UI: two writers of one row would only fight.
    if (entry.run?.attached && !entry.exited) return;
    try {
      if (session.messages.length) {
        saveTranscript(this.db(), session.id, session.events, session.info, session.messages);
        writeResumeFile(session.id, session.messages);
      } else {
        updateSession(this.db(), session.id, {
          exit_status: session.exitStatus,
          api_calls: session.apiCalls,
          cost: session.cost,
          // Events are kept even with no messages: a transcript worth reading is not thrown away
          // because the agent never journalled a message.
          events_json: JSON.stringify(session.events),
        });
      }
    } catch {
      // persistence is best-effort
    } finally {
      // Even a failed save means this copy is the newest: an older row must not replace it later.
      entry.syncedAt = Date.now();
    }
  }

  /**
   * Mid-run saves: until this only `#finish` persisted, so a restart (a deploy) took a running
   * session's whole conversation with it. Own local runs only; another UI's agent is saved by it.
   */
  #persistDirty(): void {
    const now = Date.now();
    for (const entry of this.#live.values()) {
      if (entry.session.target !== "local" || entry.exited || entry.run?.attached) continue;
      const count = entry.session.messages.length + entry.session.events.length;
      if (!count || count === entry.persistedCount) continue;
      if (now - (entry.persistedAt ?? 0) < PERSIST_MS) continue;
      this.#persist(entry);
      entry.persistedCount = count;
      entry.persistedAt = now;
    }
  }

  /** Save every held session now: a deploy or Ctrl+C keeps even mid-run conversations. */
  persistAll(): void {
    for (const entry of this.#live.values()) this.#persist(entry);
  }

  /** Tell the other UIs which agent runs this session, so they follow it instead of forking it. */
  #announce(entry: Internal, run: MiniRun): void {
    if (run.attached || !run.pid) return;
    try {
      rememberAgentRun(this.db(), entry.session.id, run.session.trajPath);
    } catch {
      // best-effort: the agents panel falls back to the live entry
    }
    try {
      registerLiveRun(this.db(), {
        session_id: entry.session.id,
        traj_path: run.session.trajPath,
        control_path: run.session.controlPath,
        pid: run.pid,
        owner: "web",
      });
    } catch {
      // best-effort: without it a terminal shows the saved transcript instead of the live one
    }
  }

  #retire(entry: Internal, run: MiniRun): void {
    if (run.attached) return;
    try {
      clearLiveRun(this.db(), entry.session.id, run.session.trajPath);
    } catch {
      // a stale row is harmless: its pid no longer runs that trajectory
    }
  }

  /**
   * Follow the agent another UI (a terminal) is running for this session, if there is one.
   * Returns true when the session is now attached to it.
   *
   * Asynchronous on purpose: the liveness probe reads `/proc/<pid>/cmdline` off the event loop, and
   * a tick that checks a hundred announced runs would otherwise read them back to back and block
   * the server for the whole stretch. Two calls for one entry never overlap, so an entry a slow
   * probe is still deciding about is left for the next tick instead of being attached twice.
   */
  async #attachExternal(entry: Internal): Promise<boolean> {
    if (entry.session.target !== "local") return false;
    if (entry.run && !entry.exited) return entry.run.attached === true;
    let record;
    try {
      record = getLiveRun(this.db(), entry.session.id);
    } catch {
      return false;
    }
    if (!record || this.#ownsTraj(record.traj_path)) return false;
    if (entry.probing) return false;
    const foreign = { trajPath: record.traj_path, controlPath: record.control_path, pid: record.pid };
    entry.probing = true;
    let alive: boolean;
    try {
      alive = await foreignRunAlive(foreign);
    } finally {
      entry.probing = false;
    }
    // The tick that asked for the probe has moved on (or the session was closed, or its own agent
    // started) while we were reading: this pass must not attach over it.
    if (!alive || entry.session.target !== "local" || (entry.run && !entry.exited) || this.#closed) {
      if (!alive) this.#retireGhost(entry, record);
      return false;
    }

    const run = attachMini(foreign);
    entry.run = run;
    entry.exited = false;
    entry.trajPath = foreign.trajPath;
    entry.pendingTasks = [];
    entry.watch?.stop();
    // The agent's own trajectory is the freshest copy of the conversation (the owner saves its
    // transcript only every few seconds): the transcript is rebuilt from it. Until it has messages
    // (the agent just started) the saved copy stays on screen.
    const where = record.owner === "web" ? "another mini-tui web server" : record.owner === "subagent" ? "its parent session (subagent)" : "a terminal";
    entry.session.events = entry.session.events.filter((event) => !(event.type === "notice" && event.interruptType === "attach"));
    entry.session.events.push({ type: "notice", text: `following the agent running in ${where}`, interruptType: "attach" });
    entry.rebuild = true;
    entry.consumed = 0;
    entry.parseState = createParseState();
    const traj = readTrajectory(foreign.trajPath);
    if (traj) this.#ingest(entry, traj);
    if (traj && waitingAtExit(traj.messages ?? [])) {
      // Its turn is over and it holds for the next prompt: done (or the error its exit says).
      if (entry.session.status === "running" || entry.session.status === "idle") entry.session.status = "done";
    } else {
      entry.session.status = "running";
      entry.session.startedAt = Date.now();
    }
    entry.watch = watchTrajectory(foreign.trajPath, (snapshot) => this.#ingest(entry, snapshot));

    void run.exited.then(() => {
      if (entry.run !== run) return;
      entry.exited = true;
      entry.watch?.stop();
      const final = readTrajectory(foreign.trajPath);
      if (final) this.#ingest(entry, final);
      entry.session.partial = undefined;
      const status: SessionStatus =
        entry.session.status === "interrupted" ? "interrupted" : entry.session.status === "error" ? "error" : "done";
      entry.session.status = status;
      entry.syncedAt = 0; // the owner's final save is the truth: pick it up on the next sync
      this.#emit(entry);
    });
    this.#emit(entry);
    return true;
  }

  /**
   * The announced run for this session is not alive any more (its process left without retiring
   * itself, or a recycled pid answered for it): forget it, or every later reopen and every tick
   * would probe the same ghost for ever.
   */
  #retireGhost(entry: Internal, record: { session_id: string; traj_path: string }): void {
    try {
      clearLiveRun(this.db(), record.session_id, record.traj_path);
    } catch {
      // a stale row is harmless
    }
    if (entry.trajPath === record.traj_path) entry.trajPath = undefined;
  }

  #ownsTraj(trajPath: string): boolean {
    for (const entry of this.#live.values()) if (entry.run && !entry.run.attached && entry.run.session.trajPath === trajPath) return true;
    return false;
  }

  /** Replace a held, idle session with its saved row (another UI saved a newer one). */
  #reloadFromDb(entry: Internal): void {
    let row: SessionRecord | null;
    try {
      row = getSession(this.db(), entry.session.id);
    } catch {
      return;
    }
    if (!row) return;
    const restored = restoreFromRow(row);
    entry.syncedAt = row.updated_at;
    if (restored.messages.length === entry.session.messages.length && restored.events.length === entry.session.events.length) return;
    Object.assign(entry.session, {
      title: restored.title,
      model: restored.model || entry.session.model,
      events: restored.events,
      messages: restored.messages,
      info: restored.info,
      apiCalls: restored.apiCalls,
      cost: restored.cost,
      exitStatus: restored.exitStatus,
      status: restored.status,
    });
    entry.consumed = restored.messages.length;
    entry.parseState = createParseState(restored.messages);
    entry.pendingTasks = [];
    this.#emit(entry);
  }

  /** Follow-up: continues the same conversation through the control channel. */
  async send(id: string, prompt: string): Promise<void> {
    const entry = this.#live.get(id);
    if (!entry) throw new Error("unknown session");
    const text = prompt.trim();
    if (!text) return;
    // A terminal may be running (or may have just continued) this conversation: talk to its agent,
    // or at least continue from its latest save, never from a stale copy that would fork it.
    if (!(entry.run && !entry.exited) && entry.session.target === "local") {
      if (!(await this.#attachExternal(entry))) this.#refreshIfStale(entry);
    }
    const running = !!entry.run && !entry.exited;
    log("session.send", { id, len: text.length, running, target: entry.session.target });
    if (!running && entry.session.target === "local" && entry.session.messages.length === 0) {
      // Nothing was saved to continue from (the session never made a model call). Say so instead of
      // starting an agent with no context that would answer as if the conversation had never happened.
      throw new Error("this session has no saved conversation and cannot be continued: start a new chat");
    }
    // The agent gets each referenced skill's instructions ahead of the prompt; the transcript
    // shows the prompt as typed (the parser collapses the block again on replay).
    const expanded = expandSkills(text);
    entry.session.events.push({ type: "task", text });
    (entry.pendingTasks ??= []).push(text);
    if (expanded.missing.length) {
      entry.session.events.push({
        type: "notice",
        text: `unknown skill${expanded.missing.length > 1 ? "s" : ""} sent as plain text: ${expanded.missing.map((n) => `$${n}`).join(", ")}`,
      });
    }
    entry.session.status = "running";
    // `startedAt` is when the current turn began, so the UI elapsed timer restarts per turn.
    entry.session.startedAt = Date.now();
    this.#emit(entry);

    if (entry.run && !entry.exited) {
      // The agent is holding at its control file: it picks the message up
      // before the next model call.
      entry.run.sendUserMessage(expanded.task);
      entry.watch ??= watchTrajectory(entry.run.session.trajPath, (traj) => this.#ingest(entry, traj));
    } else if (entry.session.target === "remote") {
      // A remote headless run already exited: start a fresh turn that resumes
      // the same conversation from the saved messages.
      void this.#continueRemote(entry, expanded.task);
    } else {
      // A local session nothing is running for: one restored from history, or one whose agent has
      // exited. Start an agent on the saved conversation, exactly as the terminal's /resume does.
      this.#resumeLocal(entry, expanded.task);
    }
  }

  /**
   * `/compact` between turns: the agent is gone (it exited instead of holding the control file),
   * so a fresh `--compact-only` run summarizes the saved conversation and holds at its exit for
   * the next prompt. The terminal UI does exactly this.
   */
  #compactOnly(entry: Internal): void {
    const session = entry.session;
    const history = session.messages;
    let resumePath: string;
    try {
      resumePath = writeResumeFile(session.id, history);
    } catch (error) {
      this.#fail(entry, `could not prepare the saved conversation: ${(error as Error).message}`);
      return;
    }
    const cwd = existsSync(session.cwd) ? session.cwd : process.cwd();
    const model = session.model || DEFAULT_MODEL || loadLastModel();
    const run = spawnMini({
      task: "",
      model: model || undefined,
      env: { ...modelEnv(model), MINITUI_SESSION_ID: session.id },
      cwd,
      resumePath,
      compactOnly: true,
      control: true,
    });
    log("session.compact_spawn", { id: session.id, pid: run.pid, model, cwd });
    entry.run = run;
    entry.exited = false;
    entry.trajPath = run.session.trajPath;
    this.#announce(entry, run);
    entry.consumed = history.length;
    entry.parseState = createParseState(history, history.length);
    entry.watch?.stop();
    // The compaction has to reach the saved conversation while it happens: the agent holds at its
    // exit afterwards, which may be a long time, and `/resume` must not serve the un-compacted one.
    entry.watch = watchTrajectory(run.session.trajPath, (traj) => {
      this.#ingest(entry, traj);
      this.#persist(entry);
    });

    void run.exited.then((code) => {
      this.#retire(entry, run);
      if (entry.run !== run) return;
      entry.exited = true;
      entry.watch?.stop();
      const final = readTrajectory(run.session.trajPath);
      if (final) this.#ingest(entry, final);
      const interrupted = session.status === "interrupted";
      session.partial = undefined;
      this.#finish(entry, interrupted ? "interrupted" : code === 0 ? "done" : "error", code);
    });
    this.#emit(entry);
  }

  /**
   * Continue a local session from its saved messages: a new agent process with `--resume <file>`, in the
   * session's own folder and on its own model, journalling into a fresh trajectory that this session then
   * follows. The old turns are already in `session.events`; only the new ones are appended.
   */
  #resumeLocal(entry: Internal, task: string): void {
    const session = entry.session;
    const history = entry.session.messages;
    let resumePath: string;
    try {
      resumePath = writeResumeFile(session.id, history);
    } catch (error) {
      this.#fail(entry, `could not prepare the saved conversation: ${(error as Error).message}`);
      return;
    }
    // The saved folder may not exist on this machine (a session from another checkout): running in the
    // server's own folder beats failing to start, and the notice says so.
    const cwd = existsSync(session.cwd) ? session.cwd : process.cwd();
    if (cwd !== session.cwd) {
      session.events.push({ type: "notice", text: `${session.cwd} is not on this machine: continuing in ${cwd}` });
    }
    const model = session.model || DEFAULT_MODEL || loadLastModel();
    const run = spawnMini({
      task,
      model: model || undefined,
      env: { ...modelEnv(model), MINITUI_SESSION_ID: session.id },
      cwd,
      resumePath,
      control: true,
    });
    log("session.resumed", { id: session.id, pid: run.pid, model, cwd });
    entry.run = run;
    entry.exited = false;
    entry.trajPath = run.session.trajPath;
    this.#announce(entry, run);
    // The new trajectory replays the saved messages first, so `consumed` starts at their count and only
    // what the agent adds is parsed. The parse state is rebuilt from the same prefix.
    entry.consumed = history.length;
    entry.parseState = createParseState(history, history.length);
    entry.watch?.stop();
    entry.watch = watchTrajectory(run.session.trajPath, (traj) => this.#ingest(entry, traj));

    void run.exited.then((code) => {
      this.#retire(entry, run);
      // A newer run may have replaced this one (the user sent again): only the current run may settle.
      if (entry.run !== run) return;
      entry.exited = true;
      entry.watch?.stop();
      const final = readTrajectory(run.session.trajPath);
      if (final) this.#ingest(entry, final);
      const interrupted = session.status === "interrupted";
      session.partial = undefined;
      this.#finish(entry, interrupted ? "interrupted" : code === 0 ? "done" : "error", code);
    });
    this.#emit(entry);
  }

  #refreshIfStale(entry: Internal): void {
    try {
      const stamp = sessionStamps(this.db(), [entry.session.id]).get(entry.session.id);
      if (stamp !== undefined && stamp > (entry.syncedAt ?? 0)) this.#reloadFromDb(entry);
    } catch {
      // keep what we have
    }
  }

  #fail(entry: Internal, message: string): void {
    entry.session.status = "error";
    entry.session.events.push({ type: "error", text: message });
    this.#emit(entry);
  }

  /**
   * Switch the model of an open session.
   *
   * A live local run picks the change up from its control file before the next
   * model call, so the switch lands mid-conversation without losing context.
   * A remote run is a one-shot `ssh` process with no control channel, so the
   * choice is recorded and applied to the next turn. Either way the stored
   * model is updated, so a later resume or history open starts on it.
   */
  setModel(id: string, model: string): void {
    const entry = this.#live.get(id);
    if (!entry) throw new Error("unknown session");
    const name = model.trim();
    if (!name) throw new Error("a model name is required");

    entry.session.model = name;
    log("session.model", { id, model: name });
    saveLastModel(name);

    // A model change is only a model change: it never starts, resumes or wakes a run, and it never
    // changes the session's status. A run in progress takes it from its next step; otherwise the next
    // message you send runs on it. (A finished agent may still hold its control channel open, so
    // "has a run" is not "is running".)
    const working = !!entry.run && !entry.exited && entry.session.status === "running";
    if (entry.run && !entry.exited) entry.run.switchModel(name);
    if (working) {
      entry.session.events.push({
        type: "notice",
        text: `model \u2192 ${name} (from next step)`,
        interruptType: "model",
      });
    } else {
      entry.session.events.push({
        type: "notice",
        text: `model \u2192 ${name} (from your next message)`,
        interruptType: "model",
      });
    }
    // Keep the row in sync so /resume and the sidebar agree with what is running.
    try {
      this.db()
        .query("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?")
        .run(name, Date.now(), id);
    } catch {
      // persistence is best-effort
    }
    this.#persist(entry);
    this.#emit(entry);
  }

  /**
   * `/compact`: summarize the conversation now.
   *
   * A live agent (one that holds its control file, whether it is mid-turn or waiting at its
   * exit) gets `COMPACT` on that file and summarizes before its next model call. An agent that
   * already left gets a `--compact-only` run over the saved conversation, exactly like the
   * terminal UI. Only a remote turn is out of reach: it is a one-shot `ssh` with no channel.
   */
  compact(id: string): void {
    const entry = this.#live.get(id);
    if (!entry) throw new Error("unknown session");
    log("session.compact", { id });
    if (entry.run && !entry.exited) {
      entry.run.requestCompact();
      entry.session.events.push({ type: "notice", text: "compacting the conversation before the next step", interruptType: "context" });
      this.#emit(entry);
      return;
    }
    if (entry.session.target === "remote") {
      throw new Error("compaction needs a live local run: a remote turn is one-shot");
    }
    if (entry.session.messages.length < 3) {
      throw new Error("nothing to compact yet: send a message first");
    }
    if (!runnerSupportsCompactOnly()) {
      throw new Error("/compact between turns needs the integrated runner (pip install -e ./agent); it still works while a run is live");
    }
    entry.session.events.push({ type: "notice", text: "compacting the saved conversation", interruptType: "context" });
    entry.session.status = "running";
    entry.session.startedAt = Date.now();
    this.#compactOnly(entry);
  }

  async #continueRemote(entry: Internal, prompt: string): Promise<void> {
    const host = loadHosts().find((h) => h.id === entry.session.hostId);
    if (!host) {
      entry.session.status = "error";
      entry.session.events.push({ type: "error", text: "the remote host is no longer configured" });
      this.#emit(entry);
      return;
    }
    entry.session.status = "running";
    entry.session.startedAt = Date.now();
    entry.session.events.push({ type: "notice", text: "starting a new turn on the remote host…" });
    this.#emit(entry);

    const remote = startRemoteRun(
      {
        host: host.host,
        port: host.port,
        user: host.user,
        identity: host.identity,
        workdir: entry.session.cwd || host.workdir,
        model: entry.session.model || undefined,
      },
      prompt,
    );
    entry.remote = remote;
    this.#consumeRemote(entry, remote);
    void remote.exited.then((code) => {
      if (entry.session.status === "running") {
        entry.session.status = code === 0 ? "done" : "error";
      }
      this.#persist(entry);
      this.#emit(entry);
    });
  }

  #consumeRemote(entry: Internal, remote: RemoteRun): void {
    let buffer = "";
    remote.onData((chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text || text.startsWith("\u0000")) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(text);
        } catch {
          continue;
        }
        if (payload.type !== "task") {
          const event = remoteEventToRunEvent(payload);
          if (event) {
            entry.session.events.push(event);
            this.#emit(entry);
          }
        }
        if (payload.type === "result") {
          const result = payload as { subtype?: string; exit_status?: string; result?: string };
          entry.session.exitStatus = result.exit_status ?? entry.session.exitStatus;
          if (!entry.session.events.some((e) => e.type === "exit")) {
            entry.session.events.push({
              type: "exit",
              exitStatus: entry.session.exitStatus || (result.subtype === "success" ? "Submitted" : "error"),
              submission: String(result.result ?? ""),
            });
          }
          this.#emit(entry);
        }
      }
    });
  }

  interrupt(id: string): void {
    const entry = this.#live.get(id);
    if (!entry) throw new Error("unknown session");
    log("session.interrupt", { id });
    entry.session.status = "interrupted";
    entry.session.exitStatus = "Interrupted";
    if (entry.run) entry.run.interrupt();
    else entry.remote?.stop();
    this.#emit(entry);
  }

  /**
   * Stop a session and drop it from the open list. It stays in the history: closing is "put it away",
   * and "Resume" is how it comes back. (This used to delete the row, so every closed session was gone
   * for good and there was nothing left to resume.) Anything the session has not saved yet is saved now.
   */
  close(id: string): void {
    const entry = this.#live.get(id);
    if (!entry) return;
    log("session.close", { id });
    entry.watch?.stop();
    entry.run?.kill();
    entry.remote?.stop();
    if (entry.session.status === "running") entry.session.status = "interrupted";
    this.#persist(entry);
    this.#live.delete(id);
  }

  /**
   * Remove a session from the history for good. Works on an open session (stopped first) and on one that
   * was never opened in this server; `false` when there was no such session. Deleting is a separate,
   * deliberate action from closing.
   */
  deleteHistory(id: string): boolean {
    log("session.delete", { id });
    const entry = this.#live.get(id);
    if (entry) {
      entry.watch?.stop();
      entry.run?.kill();
      entry.remote?.stop();
      this.#live.delete(id);
    }
    try {
      return deleteSession(this.db(), id);
    } catch {
      return false;
    }
  }

  /**
   * Restore a finished session from the shared /resume history.
   *
   * Idempotent: a session this server already holds is returned as it is. Building a second copy from
   * the database would replace a live one (possibly mid-run, with events the database has not seen yet)
   * and leave two owners of one id.
   */
  async openHistory(id: string): Promise<LiveSession> {
    const held = this.#live.get(id);
    if (held) {
      // Held but idle: a terminal may have moved on since (a newer save, or its agent is live now).
      if (!(held.run && !held.run.attached && !held.exited) && held.session.target === "local") {
        if (!(await this.#attachExternal(held))) this.#refreshIfStale(held);
      }
      return held.session;
    }
    const row = getSession(this.db(), id);
    if (!row) throw new Error("unknown session");
    const session = restoreFromRow(row);
    // A session the server lost mid-run (a deploy before its first save) has an empty row but a
    // complete journal on disk: rebuild its transcript from there instead of showing nothing.
    if (!session.messages.length) {
      for (const trajPath of this.trajsOf(id)) {
        try {
          const traj = readTrajectory(trajPath);
          if (traj?.messages?.length) {
            session.messages = traj.messages;
            session.info = { ...session.info, ...parseInfo(traj) };
            session.events = messagesToEvents(session.messages, { showSystem: false }, 0, createParseState());
            break;
          }
        } catch {
          // an unreadable journal does not block the restore
        }
      }
    }
    const entry: Internal = {
      session,
      consumed: session.messages.length,
      parseState: createParseState(session.messages),
      syncedAt: row.updated_at,
    };
    this.#live.set(row.id, entry);
    // Opened while a terminal is running it: follow that agent live instead of a frozen copy.
    await this.#attachExternal(entry);
    return session;
  }

  /**
   * The saved sessions for "Resume": newest first, searchable, metadata only (a listing must never read
   * a transcript). `open` marks the ones this server already holds, so the UI offers each once.
   */
  /** Folders with saved sessions, for the sidebar's per-folder view. Instant (index only). */
  folders(limit?: number): FolderSummary[] {
    return listFolders(this.db(), limit);
  }

  history(options: { query?: string; limit?: number; cwd?: string } = {}): HistoryItem[] {
    return listHistory(this.db(), options).map((row) => ({
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      model: row.model,
      task: row.task,
      // camelCase like every other payload this server sends, not the database's column names
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      apiCalls: row.api_calls,
      cost: row.cost,
      exitStatus: row.exit_status,
      resumable: row.resumable,
      open: this.#live.has(row.id),
    }));
  }
}

/**
 * Build a session from its saved row. Rows come from every UI (and every version of it), so nothing
 * is trusted: unreadable JSON, missing fields and oversized outputs all degrade to something the
 * browser can render instead of failing the open.
 */
export function restoreFromRow(row: SessionRecord): LiveSession {
  const rawEvents = parseJson<unknown>(row.events_json, []);
  const events = (Array.isArray(rawEvents) ? rawEvents : [])
    .filter((event): event is RunEvent => !!event && typeof event === "object" && typeof (event as RunEvent).type === "string")
    .map(boundEvent);
  const rawMessages = parseJson<unknown>(row.messages_json, []);
  const messages = (Array.isArray(rawMessages) ? rawMessages : []).filter(
    (message): message is TrajectoryMessage => !!message && typeof message === "object",
  );
  const rawInfo = parseJson<Partial<RunInfo>>(row.info_json, {});
  const info: RunInfo = {
    ...(rawInfo && typeof rawInfo === "object" ? rawInfo : {}),
    cost: Number(rawInfo?.cost ?? row.cost ?? 0) || 0,
    apiCalls: Number(rawInfo?.apiCalls ?? row.api_calls ?? 0) || 0,
  };
  const exitStatus = row.exit_status ?? "";
  return {
    id: row.id,
    title: row.title || titleFor(row.task ?? "") || row.id,
    cwd: row.cwd ?? "",
    model: row.model ?? "",
    task: row.task ?? "",
    target: "local",
    status: exitStatus === "Submitted" ? "done" : exitStatus ? "error" : "idle",
    events,
    messages,
    info,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.updated_at,
    apiCalls: Number(row.api_calls) || 0,
    cost: Number(row.cost) || 0,
    exitStatus,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
  };
}

/**
 * Turn a failed run's log into something a person can act on.
 *
 * The agent writes a Python traceback, and its last lines are the only part
 * that says why. Showing the tail dumps 25 lines of `File "...", line N` that
 * say nothing, so the real cause is pulled out and the traceback dropped.
 * Returns "" when the log has no recognisable cause, so the caller can fall
 * back to the raw tail rather than showing nothing.
 */
export function explainFailure(logTail: string): string {
  const cause = logTail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_][\w.]*(Error|Exception|Abort|Timeout)\b:/.test(line))
    .pop();
  if (!cause) return "";

  // `module.Class: message` -> `Class: message`, dropping the import path.
  const [type, ...rest] = cause.split(": ");
  const short = (type ?? "").split(".").pop() ?? "";
  const detail = rest.join(": ").replace(/\s*\(request_id:[^)]*\)/, "").trim();
  const friendly = `${short}: ${detail}`;

  if (/\bHTTP 402\b/.test(friendly)) {
    return `${friendly}\n\nThe provider account is out of credit. Retrying will not help until it is topped up.`;
  }
  if (/\bHTTP (?:401|403)\b/.test(friendly)) {
    return `${friendly}\n\nThe provider rejected the API key. Check the key configured for this model.`;
  }
  if (/\bHTTP 429\b/.test(friendly)) {
    return `${friendly}\n\nRate limited by the provider. Wait a moment, or switch to another model.`;
  }
  if (/context (?:length|window)|too many tokens|maximum context/i.test(friendly)) {
    return `${friendly}\n\nThe conversation outgrew the model's context window. Start a new session.`;
  }
  return friendly;
}

function readLogTail(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.split("\n").slice(-25).join("\n").trim();
  } catch {
    return "";
  }
}

/** Map one `stream-json` line onto the shared RunEvent contract. */
export function remoteEventToRunEvent(payload: Record<string, unknown>): RunEvent | null {
  switch (payload.type) {
    case "task":
      return { type: "task", text: String(payload.text ?? payload.task ?? "") };
    case "assistant":
      return { type: "assistant", text: String(payload.text ?? "") };
    case "thinking":
      return { type: "thinking", text: String(payload.text ?? ""), seconds: Number(payload.seconds ?? 0) };
    case "tool_call":
      return {
        type: "tool_call",
        id: String(payload.id ?? ""),
        name: String(payload.name ?? "bash"),
        command: String(payload.command ?? ""),
      };
    case "observation":
      return {
        type: "observation",
        toolCallId: payload.tool_call_id ? String(payload.tool_call_id) : null,
        returncode: payload.returncode === null || payload.returncode === undefined ? null : Number(payload.returncode),
        output: String(payload.output ?? ""),
        exceptionInfo: String(payload.exception_info ?? ""),
      };
    case "notice":
      return { type: "notice", text: String(payload.text ?? "") };
    case "exit":
      return {
        type: "exit",
        exitStatus: String(payload.exit_status ?? "Submitted"),
        submission: String(payload.submission ?? payload.result ?? ""),
      };
    case "error":
      return { type: "error", text: String(payload.text ?? payload.error ?? "") };
    default:
      return null;
  }
}

export { probeHost };
