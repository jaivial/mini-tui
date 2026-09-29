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

import { spawnMini, type MiniRun } from "../mini/spawn";
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
  getSession,
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
}

export class SessionManager {
  #live = new Map<string, Internal>();
  #db: ReturnType<typeof openDb> | null = null;
  #onChange: (session: LiveSession) => void;

  constructor(onChange: (session: LiveSession) => void) {
    this.#onChange = onChange;
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
      env: modelEnv(effective),
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

    try {
      createSession(this.db(), { id, title, cwd, model: effective, task: prompt });
    } catch {
      // the /resume history is best-effort
    }

    entry.watch = watchTrajectory(run.session.trajPath, (traj) => this.#ingest(entry, traj));

    void run.exited.then(async (code) => {
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
    }
  }

  /** Follow-up: continues the same conversation through the control channel. */
  send(id: string, prompt: string): void {
    const entry = this.#live.get(id);
    if (!entry) throw new Error("unknown session");
    const text = prompt.trim();
    if (!text) return;
    const running = !!entry.run && !entry.exited;
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
      env: modelEnv(model),
      cwd,
      resumePath,
      control: true,
    });
    entry.run = run;
    entry.exited = false;
    entry.trajPath = run.session.trajPath;
    // The new trajectory replays the saved messages first, so `consumed` starts at their count and only
    // what the agent adds is parsed. The parse state is rebuilt from the same prefix.
    entry.consumed = history.length;
    entry.parseState = createParseState(history, history.length);
    entry.watch?.stop();
    entry.watch = watchTrajectory(run.session.trajPath, (traj) => this.#ingest(entry, traj));

    void run.exited.then((code) => {
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
   * `/compact`: ask the running agent to summarize its context before its next model call. Only a
   * live local run has a control channel; a remote turn is one-shot, so there is nothing to ask.
   */
  compact(id: string): void {
    const entry = this.#live.get(id);
    if (!entry) throw new Error("unknown session");
    if (!entry.run || entry.session.status !== "running") {
      throw new Error("compaction needs a live local run: send a message first");
    }
    entry.run.requestCompact();
    entry.session.events.push({ type: "notice", text: "compacting the conversation before the next step", interruptType: "context" });
    this.#emit(entry);
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
  openHistory(id: string): LiveSession {
    const held = this.#live.get(id);
    if (held) return held.session;
    const row = getSession(this.db(), id);
    if (!row) throw new Error("unknown session");
    const events = row.events_json ? (JSON.parse(row.events_json) as RunEvent[]) : [];
    const messages = row.messages_json ? (JSON.parse(row.messages_json) as TrajectoryMessage[]) : [];
    const info = row.info_json ? (JSON.parse(row.info_json) as RunInfo) : { cost: 0, apiCalls: 0 };
    const session: LiveSession = {
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      model: row.model,
      task: row.task,
      target: "local",
      status: row.exit_status === "Submitted" ? "done" : row.exit_status ? "error" : "idle",
      events,
      messages,
      info,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.updated_at,
      apiCalls: row.api_calls,
      cost: row.cost,
      exitStatus: row.exit_status,
    };
    this.#live.set(row.id, { session, consumed: messages.length, parseState: createParseState(messages) });
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
