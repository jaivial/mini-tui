/**
 * Wire types. They mirror the terminal UI's contract (src/traj/schema.ts and
 * src/sessions.ts) exactly, so the same parser drives both front ends.
 */
import type { RunEvent, RunInfo, TrajectoryMessage } from "../../../src/traj/schema";

export type { RunEvent, RunInfo, TrajectoryMessage };

export type SessionStatus = "idle" | "running" | "done" | "error" | "interrupted";

/** One saved session in the history list (`GET /api/history`): metadata only, no transcript. */
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
  /** The server already holds this session open. */
  open: boolean;
}

/** A session's notes, as the hub socket sends them (`/api/hub`). `updatedAt` is the version: 0 = nothing saved yet. */
export interface Note {
  id: string;
  body: string;
  updatedAt: number;
}

/** The to-dos of a session's task card, in their three buckets. */
export interface TaskTodos {
  /** Finished. */
  done: string[];
  /** Started but not finished. */
  pending: string[];
  /** What is left to do. */
  left: string[];
}

/** A session's task card, as the hub socket sends it: what its agents fill with `mini-tui tasks set`. */
export interface SessionTask {
  id: string;
  title: string;
  description: string;
  todos: TaskTodos;
  /** 0 when the session has no task card yet. */
  updatedAt: number;
}

/** One node of a session's DAG plan, as the hub socket sends it (subagents/plan.json). */
export interface PlanTask {
  id: string;
  title: string;
  /** pending | ready | running | review | done | failed | blocked */
  status: string;
  deps: string[];
  group: string;
  priority: number;
  result?: string;
  error?: string;
}

/** One session's whole plan: the DAG the task board draws when its session runs a plan. */
export interface SessionPlan {
  session: string;
  tasks: PlanTask[];
  updatedAt: number;
}

/** `GET /api/folders`: the subfolders of one folder, on this machine or a remote host. */
export interface FolderEntry {
  name: string;
  path: string;
  hidden: boolean;
  git: boolean;
}
export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  entries: FolderEntry[];
  truncated: boolean;
}

/** `GET /api/history/folders`: a folder with saved sessions. */
export interface FolderSummary {
  cwd: string;
  count: number;
  updatedAt: number;
}

export interface SessionSummary {
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
}

/** A live session the server is driving, plus its transcript so far. */
export interface SessionState extends SessionSummary {
  /** "local" runs in this browser's server; "remote" runs over SSH. */
  target: TargetKind;
  /** Which configured host a remote session runs on. */
  hostId?: string;
  status: SessionStatus;
  events: RunEvent[];
  /** The assistant message currently being generated, per channel. */
  partial?: { thinking: string; text: string };
  messages: TrajectoryMessage[];
  info: RunInfo;
  error?: string;
  startedAt: number;
  /** Subagents this session's agent started; each one is a session of its own. */
  subagents?: SubagentView[];
  /** The session that started this one as a subagent. */
  parentId?: string;
}

/** A subagent as its parent session lists it. */
export interface SubagentView {
  name: string;
  sessionId: string;
  /** starting, running, waiting (turn done, context kept), stopped, exited, dead (its process is
   * gone while the roster still claims it - the hub died before writing its final index) */
  state: string;
  exitStatus: string;
  steps: number;
  cost: number;
  task: string;
  lastCommand: string;
  /** Now, rolling mean and peak of the child's memory (MiB): the fan-out budget it is spending. */
  memRss: number;
  memAvg: number;
  memPeak: number;
}

export type TargetKind = "local" | "remote";

export interface RemoteHost {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  /** Where runs land on the remote box. */
  workdir: string;
  /** Identity file, if any (never the passphrase). */
  identity?: string;
  lastSeen?: number;
  lastError?: string;
  online?: boolean;
}

export interface CreateSessionBody {
  prompt: string;
  cwd?: string;
  model?: string;
  target: TargetKind;
  hostId?: string;
}

export interface CommandInfo {
  name: string;
  insert: string;
  detail: string;
  args?: string;
  kind: "client" | "prompt";
}

export interface SkillInfo {
  name: string;
  description: string;
}

export type OutputMode = "collapsed" | "trim" | "expanded";

export interface SettingsView {
  outputMode: OutputMode;
  theme?: string;
  /** The model a fresh chat starts on (last one picked anywhere). */
  lastModel: string;
  outputModes: { value: OutputMode; name: string; description: string }[];
}

export interface ProviderView {
  id: string;
  name: string;
  description: string;
  route: "native" | "openai-compat";
  baseUrl: string;
  connected: boolean;
  /** Masked: enough to recognise the key, never enough to use it. */
  keyHint: string;
  models: string[];
  defaultModel: string;
  addedAt: number;
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  description: string;
  route: "native" | "openai-compat";
  baseUrl: string;
  staticModels: string[];
}

export type ConnectResult = { ok: true; provider: ProviderView } | { ok: false; error: string };

/** A session without its transcript: what the shared stream carries for the sidebar. */
export type SessionMeta = Omit<SessionState, "events" | "messages" | "partial">;
/** The transcript as sent over a session's socket (raw model messages stay on the server). */
export type WireSession = Omit<SessionState, "messages">;

/** One frame on `/api/sessions/:id/socket`. */
export type Frame =
  | { t: "snapshot"; id: string; session: WireSession }
  | { t: "delta"; id: string; from: number; events: RunEvent[]; meta: SessionMeta; partial: SessionState["partial"] | null }
  | { t: "gone"; id: string }
  | { t: "pong"; id: string };

export interface ServerEvent {
  type: "hello" | "session" | "session-gone" | "hosts" | "pong";
  session?: SessionMeta;
  id?: string;
  hosts?: RemoteHost[];
}

/** One entry from `GET /api/models`. */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

/** Measured reuse of the inherited prefix: the first call's cached tokens, and the totals. */
export interface AgentCache {
  inherited_messages: number;
  first_prompt: number;
  first_cached: number;
  prompt_total: number;
  cached_total: number;
  warm: string;
}

/** One agent session in a session's agent tree (children = its own subagents). */
export interface AgentNode {
  name: string;
  path: string;
  sessionId: string;
  /** The agent definition it runs (`general`, `translator`...); empty for a plain spawn. */
  agent: string;
  /** `delegate`, `handoff`, or empty (a plain `agent spawn`). */
  origin: string;
  /** Who started it: `parent` or the agent that handed over. */
  from: string;
  state: string;
  exitStatus: string;
  model: string;
  task: string;
  steps: number;
  cost: number;
  lastCommand: string;
  awaiting: string;
  waitingChildren: string[];
  startedAt: number;
  lastActivity: number;
  cache?: AgentCache;
  children: AgentNode[];
}

export interface AgentEvent {
  at: number;
  /** delegate, handoff, message, reply, fanout, warmup, done, define, error */
  kind: string;
  from: string;
  to: string;
  text: string;
  /** The hub that logged it: "" = this session's own, else the path of the agent whose hub it is. */
  scope: string;
  model?: string;
  agent?: string;
  inherited?: number;
  status?: string;
  chain?: string[];
  seconds?: number;
}

export interface AgentDef {
  name: string;
  description: string;
  when_to_use: string;
  system_prompt: string;
  model: string;
  builtin: boolean;
  created_by?: string;
}

export interface AgentsView {
  sessionId: string;
  nodes: AgentNode[];
  events: AgentEvent[];
  defs: AgentDef[];
}
