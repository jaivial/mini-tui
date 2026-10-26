/**
 * Wire types. They mirror the terminal UI's contract (src/traj/schema.ts and
 * src/sessions.ts) exactly, so the same parser drives both front ends.
 */
import type { RunEvent, RunInfo, TrajectoryMessage } from "../../../src/traj/schema";
import type { AttachmentRef } from "./attachments";
import type { EffortCapability, EffortLevel } from "../../../src/effort";

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
  /** Work-queue role: the chat (`dispatcher`) or a background task (`worker`). */
  role?: "dispatcher" | "worker";
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
  /** Already-uploaded files (POST /attachments): only ids travel the wire. */
  attachments?: AttachmentRef[];
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
  /**
   * v6-C. `false`/absent means the router is not consulted at all and the manual
   * model selector is the only thing that picks a model — the behaviour that
   * existed before the router, which is why the flag is optional here.
   */
  modelRouterEnabled?: boolean;
  /** Work queue: background tasks at once (1..maxQueueConcurrency). */
  queueConcurrency?: number;
  maxQueueConcurrency?: number;
  /** Models in order of preference for the fallback chain (see docs/work-queue.md). */
  modelFallbacks?: string[];
  /** Reasoning effort per fully-qualified model id. */
  modelEfforts?: Record<string, EffortLevel>;
  /** The live cu screen. Operator config only: the client cannot change it. */
  liveScreen?: { enabled: boolean; origin: string | null; viewerUrl: string | null; loginUrl: string | null; controlUrl?: string | null };
}

// ------------------------------------------------------------------ v6-C router

export type RouteLevel = "task" | "delegate" | "subtask";

export interface BreakerStatusView {
  model: string;
  state: "closed" | "open" | "half-open";
  blocked: boolean;
  reason: string;
  detail: string;
  failures: number;
  /** Epoch ms the circuit reopens, or 0 when it is not time-blocked. */
  retryAt: number;
}

export interface RouterDecisionView {
  id: number;
  at: number;
  level: RouteLevel;
  source: "laya" | "deterministic" | "fallback" | "manual";
  chosen: string;
  reason: string;
  layaProbability: number | null;
  layaConfidence: number | null;
  layaCheckpoint: string;
  layaReason: string;
  complexity: string;
  task: string;
  from: string;
  fallbackReason: string | null;
  ranking: {
    model: string;
    score: number;
    why: string[];
    excluded: string | null;
    terms: Record<string, number | null>;
  }[];
}

export interface RouterStatusView {
  enabled: boolean;
  candidates: number;
  connected: number;
  layaUrl: string;
  layaCheckpoint: string;
  catalogLoaded: boolean;
  catalogModels: number;
  /** How many catalogued models have no sourced intelligence index. */
  catalogUnknownIndex: number;
  breakers: BreakerStatusView[];
  decisions24h: number;
  fallbacks24h: number;
  laya: { reachable: boolean; detail: string };
  decisions: RouterDecisionView[];
}

/** The `/router/preview` answer: one real decision, with the ranking that made it. */
export interface RouterPreview {
  model: string;
  source: RouterDecisionView["source"];
  reason: string;
  laya: { probability: number | null; confidence: number | null; checkpoint: string; reason: string };
  complexity: { complexity: string; score: number; estimatedTokens: number; signals: string[]; summary: string };
  ranking: RouterDecisionView["ranking"];
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

/** One task of the work queue (see src/web/workQueue.ts). */
export type QueueStatus = "queued" | "running" | "done" | "error" | "cancelled";
export interface QueueTask {
  id: string;
  seq: number;
  title: string;
  description: string;
  prompt: string;
  /** Dispatcher-assigned project/workspace label for grouping worker sessions. */
  workspace: string;
  cwd: string;
  model: string;
  status: QueueStatus;
  sessionId: string;
  result: string;
  createdAt: number;
  startedAt: number;
  finishedAt: number;
  updatedAt: number;
  redirects: string[];
  related: Array<{ id: string; score: number }>;
  notes: Array<{ at: number; from: "worker" | "dispatcher" | "queue"; text: string }>;
  attempts: number;
  workSeconds: number;
  /** The worker is waiting for the human in its browser tab. */
  browser?: { tab: string; message: string; since: number };
}
/** One tab of the agents' persistent cu browser. */
export interface CuTab {
  id: string;
  url: string;
  title: string;
  default: boolean;
}

export interface QueueView {
  tasks: QueueTask[];
  /** The chat's session id ("" before the first message). */
  main: string;
  concurrency: number;
  /** A push with only the tasks that changed (merged by id), not the whole list. */
  delta?: boolean;
}

export interface ServerEvent {
  type: "hello" | "session" | "session-gone" | "hosts" | "pong" | "queue";
  session?: SessionMeta;
  id?: string;
  hosts?: RemoteHost[];
}

/** One entry from `GET /api/models`. */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  /** Absent only when talking to an older server; the picker then shows Auto. */
  effort?: EffortCapability;
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

/** `?brief=1`: the rows only. What the sidebar polls — it renders `nodes` and drops the rest. */
export interface AgentsBrief {
  sessionId: string;
  nodes: AgentNode[];
}

/** An installed MCP server (`GET /api/mcp`). Never carries a token or a header value. Mirrors `serverView` in src/mcp/index.ts. */
export interface McpServerView {
  id: string;
  name: string;
  url: string;
  preset?: string;
  addedAt: number;
  disabled: boolean;
  oauth: boolean;
  loggedIn: boolean;
  expiresAt?: number;
  headerNames: string[];
  tokenFile?: string;
  state: "connected" | "needs-login" | "expired" | "disabled" | "ready";
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  url: string;
  auth: "oauth" | "none" | "header" | "local";
  /** No dynamic registration: installing asks for an OAuth client id/secret. */
  needsClient?: boolean;
  docs?: string;
}

/** An OAuth login in flight (`LoginView` in src/mcp/flow.ts). */
export interface McpLogin {
  id: string;
  serverId: string;
  serverName: string;
  url: string;
  redirectUri: string;
  status: "pending" | "exchanging" | "done" | "error";
  error?: string;
  toolCount?: number;
  startedAt: number;
  expiresAt: number;
}
