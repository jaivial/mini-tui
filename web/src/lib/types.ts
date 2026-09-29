/**
 * Wire types. They mirror the terminal UI's contract (src/traj/schema.ts and
 * src/sessions.ts) exactly, so the same parser drives both front ends.
 */
import type { RunEvent, RunInfo, TrajectoryMessage } from "../../../src/traj/schema";

export type { RunEvent, RunInfo, TrajectoryMessage };

export type SessionStatus = "idle" | "running" | "done" | "error" | "interrupted";

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
