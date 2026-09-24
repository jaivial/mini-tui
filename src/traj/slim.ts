/**
 * What the TUI keeps of each raw trajectory message once it has become UI events.
 *
 * The agent's messages carry heavy extras nothing downstream needs: `extra.response` (the full
 * API reply, ~35 % of a trajectory) and `extra.raw_output` (a second copy of every tool
 * output, already rendered into events). Kept in memory they dominated the live TUI's growth,
 * and every transcript save stringified them again. `mini --resume` only reads the protocol
 * keys plus `extra.actions`/`interrupt_type`/`exit_status`/`submission`, which all stay. The
 * trajectory files on disk remain complete.
 */
import type { RunEvent, TrajectoryMessage } from "./schema";

const HEAVY_EXTRA = new Set(["response", "raw_output"]);

export function slimMessage(message: TrajectoryMessage): TrajectoryMessage {
  const extra = message.extra;
  if (!extra || typeof extra !== "object" || !Object.keys(extra).some((key) => HEAVY_EXTRA.has(key))) return message;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) if (!HEAVY_EXTRA.has(key)) kept[key] = value;
  return { ...message, extra: kept };
}

/**
 * Most of any text block the transcript can ever show: StepCard's expanded view is capped at
 * `OUTPUT_HEAD_LINES` lines / `OUTPUT_MAX_CHARS` chars, and its collapsed view shows the last
 * `OUTPUT_TAIL_LINES` lines. Anything beyond that was retained (and re-stringified on every
 * transcript save) for nothing: a single `cat` of a big file kept 20-30 MB alive per session.
 */
export const OUTPUT_HEAD_LINES = 500;
export const OUTPUT_TAIL_LINES = 12;
export const OUTPUT_MAX_CHARS = 40_000;

/**
 * Bound a text to what the UI can display: head lines (char-capped) + a marker + tail lines.
 * The result is always a fresh flat string, so it never pins the huge parsed original
 * (JSC substrings keep a reference to their base string).
 */
export function boundText(text: string): string {
  if (text.length <= OUTPUT_MAX_CHARS + 2_000) return text;
  const body = text.replace(/\n+$/, "");
  const lines = body.split("\n");
  let head: string;
  let tail: string[] = [];
  let dropped = 0;
  if (lines.length > OUTPUT_HEAD_LINES + OUTPUT_TAIL_LINES + 1) {
    dropped = lines.length - OUTPUT_HEAD_LINES - OUTPUT_TAIL_LINES;
    head = lines.slice(0, OUTPUT_HEAD_LINES).join("\n");
    tail = lines.slice(-OUTPUT_TAIL_LINES).map((line) => (line.length > 2_000 ? `${line.slice(0, 2_000)}…` : line));
  } else {
    head = body;
  }
  const parts: string[] = [];
  if (head.length > OUTPUT_MAX_CHARS) {
    parts.push(head.slice(0, OUTPUT_MAX_CHARS), `... ${(body.length / 1024).toFixed(0)} KB output truncated ...`);
  } else {
    parts.push(head);
    if (dropped) parts.push(`... ${dropped} lines hidden ...`);
  }
  parts.push(...tail);
  // join copies into a new buffer; the round-trip through a Buffer guarantees a flat string
  return Buffer.from(parts.join("\n"), "utf8").toString("utf8");
}

/** Bound an event restored from disk (transcripts saved before outputs were bounded). */
export function boundEvent(event: RunEvent): RunEvent {
  if (event?.type !== "observation") return event;
  const output = typeof event.output === "string" ? boundText(event.output) : "";
  const exceptionInfo = typeof event.exceptionInfo === "string" ? boundText(event.exceptionInfo) : "";
  return output === event.output && exceptionInfo === event.exceptionInfo ? event : { ...event, output, exceptionInfo };
}
