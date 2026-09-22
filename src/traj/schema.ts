/**
 * Types mirroring the `mini` trajectory file (`trajectory_format: "mini-swe-agent-1.1"`).
 *
 * The harness writes this JSON via `DefaultAgent.save()` after every step, so it is the
 * read-only integration surface mini-tui consumes. See `mini-swe-agent` sources for the
 * producing side (`src/minisweagent/agents/default.py`, `models/utils/actions_toolcall.py`).
 */

export interface TrajectoryInfo {
  model_stats?: { instance_cost?: number; api_calls?: number };
  exit_status?: string;
  submission?: string;
  config?: { model?: { model_name?: string }; [key: string]: unknown };
  mini_version?: string;
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
}

/** One UI-level event derived from trajectory messages (the parser output contract). */
export type RunEvent =
  | { type: "task"; text: string }
  | { type: "assistant"; text: string; cost?: number }
  | { type: "tool_call"; id: string; name: string; command: string }
  | {
      type: "observation";
      toolCallId: string | null;
      returncode: number | null;
      output: string;
      exceptionInfo: string;
    }
  | { type: "notice"; text: string; interruptType?: string }
  | { type: "exit"; exitStatus: string; submission: string };

/** Header-level facts extracted from `trajectory.info`. */
export interface RunInfo {
  model?: string;
  cost: number;
  apiCalls: number;
  exitStatus?: string;
  submission?: string;
  trajectoryFormat?: string;
}
