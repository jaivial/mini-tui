/** Small shared formatters, kept identical in spirit to the TUI's. */
import { ageSeconds, ageWords } from "./ago";

export function boundedText(text: string, maxLines: number, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.split("\n", maxLines).join("\n");
  return `${head}\n… ${text.length - head.length} chars hidden`;
}

export function cost(value: number): string {
  if (!value) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * How long a turn has been running. The words live in `lib/ago.ts` (E53: every "how long ago" in
 * one place) and the caller hands the clock's `now` — this file no longer has a clock of its own.
 */
export function duration(ms: number): string {
  return ageWords("elapsed", Math.floor(Math.max(0, ms) / 1000));
}

export function relativeTime(ts: number, now: number): string {
  return ageWords("relative", ageSeconds(ts, now), ts);
}
