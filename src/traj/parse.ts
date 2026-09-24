/**
 * Pure parser: trajectory messages → UI events.
 *
 * `getContentString` is a TypeScript port of `minisweagent.models.utils.content_string`
 * (the harness' own display extraction) so any message shape degrades to readable text
 * instead of throwing.
 */

import type { RunEvent, RunInfo, Trajectory, TrajectoryMessage } from "./schema";
import { collapseSkillPrompt } from "../skills";

export interface ParseOptions {
  /** Emit the (huge) system prompt as a notice instead of dropping it. */
  showSystem?: boolean;
}

/** Incremental parser state carried across append-only trajectory snapshots. */
export interface ParseState {
  /** Whether the initial user task has already been emitted. */
  taskSeen: boolean;
}

export function createParseState(messages: TrajectoryMessage[] = [], startIndex = 0): ParseState {
  for (let i = 0; i < startIndex && i < messages.length; i++) {
    const prior = messages[i] ?? {};
    if (prior.role === "user" && !hasInterruptType(prior) && !hasActions(prior)) return { taskSeen: true };
  }
  return { taskSeen: false };
}

function formatToolCall(argsStr: unknown): string {
  try {
    const args = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
    if (args && typeof args === "object" && "command" in args) {
      return "```\n" + String((args as Record<string, unknown>).command) + "\n```";
    }
  } catch {
    // fall through to the raw dump below
  }
  return "```\n" + String(argsStr) + "\n```";
}

function formatObservation(content: string): string {
  try {
    const data = JSON.parse(content);
    if (data && typeof data === "object" && "returncode" in data) {
      return Object.entries(data)
        .map(([key, value]) => `<${key}>\n${String(value)}`)
        .join("\n");
    }
    return content;
  } catch {
    return content;
  }
}

/** Port of `minisweagent.models.utils.content_string.get_content_string`. */
export function getContentString(message: TrajectoryMessage): string {
  const texts: string[] = [];

  const content = message.content;
  if (typeof content === "string") {
    texts.push(formatObservation(content));
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (block.type === "tool_use") {
        texts.push(formatToolCall(JSON.stringify(block.input ?? {})));
      } else if (block.type === "tool_result" && typeof block.content === "string") {
        texts.push(formatObservation(block.content));
      } else if (typeof block.text === "string" && block.text) {
        texts.push(block.text);
      }
    }
  }

  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const func = tc && typeof tc === "object" ? tc.function : undefined;
      if (func) texts.push(formatToolCall(func.arguments ?? "{}"));
    }
  }

  const output = (message as Record<string, unknown>).output;
  if (typeof output === "string") {
    texts.push(formatObservation(output));
  } else if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (entry.type === "message" && Array.isArray(entry.content)) {
        for (const c of entry.content as Record<string, unknown>[]) {
          if (c && typeof c.text === "string" && c.text) texts.push(c.text);
        }
      } else if (entry.type === "function_call") {
        texts.push(formatToolCall(entry.arguments ?? "{}"));
      }
    }
  }

  return texts.filter(Boolean).join("\n\n");
}

/** Just the `content` text of a message (tool calls become separate events). */
export function getContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const block = item as Record<string, unknown>;
      if (typeof block.text === "string" && block.text) texts.push(block.text);
      else if (block.type === "image_url" || block.type === "image") texts.push("<image>");
    }
    return texts.join("\n");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extraOf(message: TrajectoryMessage): Record<string, unknown> {
  return isRecord(message.extra) ? message.extra : {};
}

function commandFromArguments(args: unknown): string {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    if (isRecord(parsed) && typeof parsed.command === "string") return parsed.command;
  } catch {
    // fall through
  }
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

interface ActionLike {
  command?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

function actionsOf(message: TrajectoryMessage): ActionLike[] {
  const actions = extraOf(message).actions;
  return Array.isArray(actions) ? (actions.filter(isRecord) as ActionLike[]) : [];
}

/** Command for one tool call: `extra.actions` wins over `function.arguments`. */
export function commandFor(message: TrajectoryMessage, toolCallId: string | undefined, fallbackArguments: unknown): string {
  for (const action of actionsOf(message)) {
    if (typeof action.command === "string" && (!toolCallId || action.tool_call_id === toolCallId)) {
      return action.command;
    }
  }
  return commandFromArguments(fallbackArguments);
}

/** Strip the harness' task template wrapper — the UI shows only the prompt the user sent. */
export function cleanTaskText(text: string): string {
  const prefix = "Please solve this issue: ";
  if (!text.startsWith(prefix)) return collapseSkillPrompt(text.trim());
  const body = text.slice(prefix.length);
  let end = body.length;
  for (const anchor of ["\n\nYou can execute bash commands", "\n\n## Recommended Workflow", "\n\n<system-reminder>"]) {
    const index = body.indexOf(anchor);
    if (index >= 0 && index < end) end = index;
  }
  return collapseSkillPrompt(body.slice(0, end).trim());
}

/**
 * Chain-of-thought captured for one model call, whatever shape the provider uses:
 * `reasoning_content`/`reasoning` on chat messages (DeepSeek, Qwen, …), Anthropic
 * `thinking` blocks replayed in the content, or `reasoning` summary items on the
 * Responses API. Empty string when the message carries thinking markers without text.
 */
export function thinkingTextOf(message: TrajectoryMessage): { text: string; present: boolean } {
  const raw = message as Record<string, unknown>;
  for (const key of ["reasoning_content", "reasoning"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) return { text: raw[key] as string, present: true };
  }
  const content = message.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let present = false;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        present = true;
        if (block.thinking.trim()) parts.push(block.thinking);
      } else if (block.type === "redacted_thinking") {
        present = true;
        parts.push("(redacted thinking)");
      }
    }
    if (present) return { text: parts.join("\n\n"), present: true };
  }
  const output = raw.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    let present = false;
    for (const item of output) {
      if (!isRecord(item) || item.type !== "reasoning") continue;
      present = true;
      const summary = item.summary;
      if (Array.isArray(summary)) {
        for (const entry of summary) {
          if (isRecord(entry) && typeof entry.text === "string" && entry.text.trim()) parts.push(entry.text);
        }
      }
    }
    if (present) return { text: parts.join("\n\n"), present: true };
  }
  return { text: "", present: false };
}

/** One-line description of an automatic context compaction (see agent `compaction.py`). */
export function compactionNotice(info: unknown): string {
  const c = (info && typeof info === "object" ? info : {}) as Record<string, unknown>;
  const k = (n: unknown) => (typeof n === "number" && n > 0 ? `${Math.round(n / 1000)}k` : "?");
  const reason = c.reason === "overflow" ? "context overflow" : c.reason === "manual" ? "requested" : "auto";
  const summarized = typeof c.summarized_messages === "number" ? `${c.summarized_messages} messages summarized` : "summarized";
  return `compacted (${reason}): ${k(c.tokens_before)} tokens of ${k(c.context_window)} window, ${summarized}`;
}

function hasInterruptType(message: TrajectoryMessage): string | undefined {
  const interruptType = extraOf(message).interrupt_type;
  return typeof interruptType === "string" ? interruptType : undefined;
}

function hasActions(message: TrajectoryMessage): boolean {
  return actionsOf(message).length > 0;
}

function toolEvent(message: TrajectoryMessage): RunEvent {
  const extra = extraOf(message);
  const rawOutput = typeof extra.raw_output === "string" ? extra.raw_output : undefined;
  const extraReturncode = typeof extra.returncode === "number" ? extra.returncode : undefined;
  const extraException = typeof extra.exception_info === "string" ? extra.exception_info : undefined;

  let output = rawOutput;
  let returncode = extraReturncode;
  let exceptionInfo = extraException;

  if (output === undefined || returncode === undefined || exceptionInfo === undefined) {
    // Fallbacks: the rendered `content` (a JSON dump like {"returncode":0,"output":"..."}).
    let parsed: Record<string, unknown> | null = null;
    const content = message.content;
    if (typeof content === "string") {
      try {
        const data = JSON.parse(content);
        if (isRecord(data)) parsed = data;
      } catch {
        parsed = null;
      }
    } else if (isRecord(content)) {
      parsed = content;
    }
    if (parsed) {
      if (output === undefined) output = typeof parsed.output === "string" ? parsed.output : String(parsed.output ?? "");
      if (returncode === undefined && typeof parsed.returncode === "number") returncode = parsed.returncode;
      if (exceptionInfo === undefined && typeof parsed.exception_info === "string") exceptionInfo = parsed.exception_info;
    } else {
      if (output === undefined) output = getContentString(message);
    }
  }

  return {
    type: "observation",
    toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : null,
    returncode: returncode ?? null,
    output: output ?? "",
    exceptionInfo: exceptionInfo ?? "",
  };
}

/**
 * Convert `messages[startIndex:]` into UI events. Messages are append-only in the
 * trajectory, so callers can keep a `consumed` index and parse only new messages.
 */
export function messagesToEvents(
  messages: TrajectoryMessage[],
  options: ParseOptions = {},
  startIndex = 0,
  state?: ParseState,
): RunEvent[] {
  const events: RunEvent[] = [];
  // A live TUI carries `state` across snapshots, so the old prefix is never
  // rescanned. The fallback preserves the pure one-shot API for callers that
  // pass only a startIndex (and for trajectories without retained parser state).
  let taskSeen = state?.taskSeen ?? false;
  if (!state) {
    for (let i = 0; i < startIndex && i < messages.length; i++) {
      const prior = messages[i] ?? {};
      if (prior.role === "user" && !hasInterruptType(prior) && !hasActions(prior)) {
        taskSeen = true;
        break;
      }
    }
  }

  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i] ?? {};
    try {
      const role = message.role;
      if (role === "system") {
        if (options.showSystem) events.push({ type: "notice", text: getContentString(message), interruptType: "system" });
      } else if (role === "user") {
        const interruptType = hasInterruptType(message);
        const actions = actionsOf(message);
        if (interruptType === "UserNewTask") {
          // A follow-up prompt (initial tasks have no interrupt_type).
          const text = getContentString(message).replace(/^The user added a new task:\s*/s, "");
          events.push({ type: "task", text: cleanTaskText(text) });
        } else if (interruptType === "CompactionSkipped") {
          events.push({ type: "notice", text: "nothing to compact yet: the conversation is too short", interruptType: "context" });
        } else if (interruptType === "Compaction") {
          events.push({ type: "notice", text: compactionNotice(extraOf(message).compaction), interruptType: "context" });
        } else if (interruptType) {
          events.push({ type: "notice", text: getContentString(message), interruptType });
        } else if (actions.length > 0) {
          for (const action of actions) {
            events.push({
              type: "tool_call",
              id: typeof action.tool_call_id === "string" ? action.tool_call_id : "",
              name: typeof action.name === "string" ? action.name : "bash",
              command: typeof action.command === "string" ? action.command : commandFromArguments(action),
            });
          }
        } else if (!taskSeen) {
          taskSeen = true;
          events.push({ type: "task", text: cleanTaskText(getContentString(message)) });
        } else {
          events.push({ type: "notice", text: getContentString(message) });
        }
      } else if (role === "assistant") {
        const thinking = thinkingTextOf(message);
        if (thinking.present) {
          const thinkSeconds = extraOf(message).thinking_seconds;
          events.push({
            type: "thinking",
            text: thinking.text,
            seconds: typeof thinkSeconds === "number" ? thinkSeconds : 0,
          });
        }
        const text = getContentText(message.content);
        const cost = extraOf(message).cost;
        if (text.trim()) {
          events.push({ type: "assistant", text, cost: typeof cost === "number" ? cost : undefined });
        }
        for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          const id = typeof tc?.id === "string" ? tc.id : "";
          const name = typeof tc?.function?.name === "string" ? tc.function.name : "bash";
          events.push({ type: "tool_call", id, name, command: commandFor(message, id, tc?.function?.arguments) });
        }
      } else if (role === "tool") {
        events.push(toolEvent(message));
      } else if (role === "exit") {
        const extra = extraOf(message);
        events.push({
          type: "exit",
          exitStatus: typeof extra.exit_status === "string" ? extra.exit_status : "",
          submission: typeof extra.submission === "string" ? extra.submission : "",
        });
      } else {
        events.push({ type: "notice", text: getContentString(message) });
      }
    } catch {
      // A weird message must never break the transcript.
      events.push({ type: "notice", text: "[mini-tui] unparseable message" });
    }
  }
  if (state) state.taskSeen = taskSeen;
  return events;
}

export function parseInfo(traj: Trajectory): RunInfo {
  const info = traj.info ?? {};
  const stats = info.model_stats ?? {};
  return {
    model: info.config?.model?.model_name,
    cost: typeof stats.instance_cost === "number" ? stats.instance_cost : 0,
    apiCalls: typeof stats.api_calls === "number" ? stats.api_calls : 0,
    exitStatus: info.exit_status,
    submission: info.submission,
    trajectoryFormat: traj.trajectory_format,
  };
}

export interface ParsedRun {
  events: RunEvent[];
  info: RunInfo;
}

export function parseTrajectory(traj: Trajectory, options: ParseOptions = {}): ParsedRun {
  return {
    events: messagesToEvents(traj.messages ?? [], options, 0),
    info: parseInfo(traj),
  };
}
