import type { RunEvent } from "../traj/schema";
import { buildItems } from "./items";
import { clipText } from "./components/StepCard";

/**
 * Read-only transcript preview for the /resume browser: a saved session's events turned
 * into small plain-text blocks. Every block is clipped and the block count is capped, so a
 * preview stays cheap however long the session was (no markdown, no expandable cards).
 */
export type PreviewBlock =
  | { kind: "task"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; command: string; badge: string; ok: boolean | null; output: string }
  | { kind: "notice"; text: string }
  | { kind: "exit"; status: string; ok: boolean; text: string }
  | { kind: "error"; text: string }
  | { kind: "more"; text: string };

export const PREVIEW_MAX_BLOCKS = 300;

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export function previewBlocks(events: RunEvent[], maxBlocks = PREVIEW_MAX_BLOCKS): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  const items = buildItems(events);
  let shown = 0;
  for (const item of items) {
    if (shown >= maxBlocks) break;
    shown++;
    if (item.kind === "pair") {
      const tool = events[item.toolIndex];
      const obs = item.observationIndex !== null ? events[item.observationIndex] : undefined;
      const rc = obs?.type === "observation" ? obs.returncode : null;
      blocks.push({
        kind: "tool",
        name: tool?.type === "tool_call" ? tool.name || "bash" : "bash",
        command: tool?.type === "tool_call" ? clipText(tool.command, 3, 0, 600).text : "",
        badge: !obs ? "no output" : rc === null ? "rc=?" : `rc=${rc}`,
        ok: rc === null ? null : rc === 0,
        output: obs?.type === "observation" ? clipText(obs.output, 2, 0, 400).text : "",
      });
      continue;
    }
    const event = events[item.index];
    if (!event) continue;
    switch (event.type) {
      case "task":
        blocks.push({ kind: "task", text: clipText(event.text, 12, 2, 2_000).text });
        break;
      case "assistant":
        if (event.text.trim()) blocks.push({ kind: "assistant", text: clipText(event.text, 20, 4, 4_000).text });
        break;
      case "thinking": {
        const seconds = Math.max(1, Math.round(event.seconds));
        blocks.push({ kind: "thinking", text: `Thought for ${seconds} second${seconds === 1 ? "" : "s"}` });
        break;
      }
      case "notice":
        blocks.push({ kind: "notice", text: oneLine(event.text) });
        break;
      case "exit": {
        const ok = !event.exitStatus || ["Submitted", "Complete", "Finished"].includes(event.exitStatus);
        blocks.push({ kind: "exit", status: event.exitStatus || "finished", ok, text: clipText(event.submission, 6, 0, 1_000).text });
        break;
      }
      case "error":
        blocks.push({ kind: "error", text: clipText(event.text, 4, 0, 800).text });
        break;
      case "observation": // an unpaired output
        blocks.push({ kind: "tool", name: "output", command: "", badge: event.returncode === null ? "rc=?" : `rc=${event.returncode}`, ok: event.returncode === null ? null : event.returncode === 0, output: clipText(event.output, 2, 0, 400).text });
        break;
      default:
        break;
    }
  }
  const rest = items.length - shown;
  if (rest > 0) blocks.push({ kind: "more", text: `… ${rest} more entr${rest === 1 ? "y" : "ies"} · Enter opens the full session` });
  return blocks;
}

/** Parse a saved `events_json`; broken rows preview as a notice instead of throwing. */
export function parseSavedEvents(json: string): RunEvent[] {
  try {
    const events = JSON.parse(json);
    return Array.isArray(events) ? (events as RunEvent[]) : [];
  } catch {
    return [{ type: "notice", text: "could not read this session's transcript" }];
  }
}
