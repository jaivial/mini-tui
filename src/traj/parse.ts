/**
 * Pure parser: trajectory messages → UI events.
 *
 * `getContentString` is a TypeScript port of `minisweagent.models.utils.content_string`
 * (the harness' own display extraction) so any message shape degrades to readable text
 * instead of throwing.
 */

import type { RunEvent, RunInfo, Trajectory, TrajectoryMessage } from "./schema";

export interface ParseOptions {
  /** Emit the (huge) system prompt as a notice instead of dropping it. */
  showSystem?: boolean;
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
  if (!text.startsWith(prefix)) return text.trim();
  const body = text.slice(prefix.length);
  let end = body.length;
  for (const anchor of ["\n\nYou can execute bash commands", "\n\n## Recommended Workflow", "\n\n<system-reminder>"]) {
    const index = body.indexOf(anchor);
    if (index >= 0 && index < end) end = index;
  }
  return body.slice(0, end).trim();
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
export function messagesToEvents(messages: TrajectoryMessage[], options: ParseOptions = {}, startIndex = 0): RunEvent[] {
  const events: RunEvent[] = [];
  const seenBefore = messages.slice(0, startIndex).some((m) => m.role === "user" && !hasInterruptType(m) && !hasActions(m));
  let taskSeen = seenBefore;

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
