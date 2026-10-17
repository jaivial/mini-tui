/**
 * Types mirroring the `mini` trajectory file (`trajectory_format: "mini-swe-agent-1.1"`).
 *
 * The vendored agent (`agent/`) appends every message to an `<traj>.jsonl` journal as it
 * happens and periodically exports this full JSON (atomically), so this is the read-only
 * integration surface mini-tui consumes — via the journal when present, else whole-file.
 * See `agent/src/minisweagent/agents/default.py` for the producing side.
 */

export interface TrajectoryInfo {
  model_stats?: { instance_cost?: number; api_calls?: number };
  exit_status?: string;
  submission?: string;
  config?: { model?: { model_name?: string; api_base?: string }; [key: string]: unknown };
  mini_version?: string;
  /** Set while the agent runs a compaction summary ("auto" | "overflow" | "manual"). */
  compacting?: string;
  [key: string]: unknown;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  [key: string]: unknown;
}

export interface TrajectoryMessage {
  role?: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Trajectory {
  info?: TrajectoryInfo;
  messages?: TrajectoryMessage[];
  trajectory_format?: string;
  /** The assistant message still being generated, per channel (live streaming only). */
  partial?: { thinking: string; text: string };
}

/** One UI-level event derived from trajectory messages (the parser output contract). */
export type RunEvent =
  | {
      type: "task";
      text: string;
      /** Files sent with this prompt, structured so the web can render a real
       * player for audio (the text still carries the markdown links the TUI
       * and a text-only client read). */
      attachments?: Array<{ id: string; kind: string; mime: string | null; url: string | null; name: string }>;
    }
  | { type: "assistant"; text: string; cost?: number }
  /** Chain-of-thought of one model call (reasoning content / thinking blocks). */
  | { type: "thinking"; text: string; seconds: number }
  | { type: "tool_call"; id: string; name: string; command: string }
  | {
      type: "observation";
      toolCallId: string | null;
      returncode: number | null;
      output: string;
      exceptionInfo: string;
    }
  | { type: "notice"; text: string; interruptType?: string }
  | { type: "exit"; exitStatus: string; submission: string }
  /** Generative UI: one component of the closed template set (src/web/uiComponents.ts). */
  | { type: "ui-component"; template: string; props: Record<string, unknown> }
  /** A crashed run's raw `mini.log` tail, posted into the thread at the failure point. */
  | { type: "error"; text: string }
  /** A mirrored channel message (espejo WhatsApp ↔ web): a message that lives
   * on the bound WhatsApp thread but never became an agent turn (a group
   * message that did not ask for the bot). Data for the transcript only —
   * never a prompt, never a turn. */
  | {
      type: "channel";
      channel: string;
      origin: "whatsapp";
      /** Stable jid. Identity. */
      sender: string;
      /** Display only: the name the sender chose, when the delivery carried
       * one. Never identity — the web shows it, nothing authorizes on it. */
      senderName?: string;
      text: string;
      ts: number;
      /** The mirror row it came from (dedupes against the saved transcript). */
      mirrorId: number;
      attachments: Array<{ id: string; kind: string; mime: string | null; url: string | null }>;
    };

/** Header-level facts extracted from `trajectory.info`. */
export interface RunInfo {
  model?: string;
  /** The endpoint the run talked to; identifies the provider behind a bare model id. */
  apiBase?: string;
  cost: number;
  apiCalls: number;
  exitStatus?: string;
  submission?: string;
  trajectoryFormat?: string;
}
