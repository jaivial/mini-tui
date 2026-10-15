/**
 * What one bot row shows under its name: how far its task card has got and how many delegates are
 * working under it right now. Pure, so the counts are testable without a browser
 * (see tests/web-bot-rows.test.ts).
 */
import type { SessionTask } from "./types";

export interface BotProgress {
  /** To-dos ticked off on the bot's own task card. */
  done: number;
  /** Every to-do on that card, ticked or not. 0 when the bot has no card yet. */
  total: number;
  /** Delegates working anywhere under this bot. */
  running: number;
}

/** A bot's progress from its task card (when it has one) and its live delegate count. */
export function botProgress(task: SessionTask | null | undefined, running = 0): BotProgress {
  const todos = task?.todos;
  const done = todos?.done.length ?? 0;
  const pending = todos?.pending.length ?? 0;
  const left = todos?.left.length ?? 0;
  return { done, total: done + pending + left, running };
}

/**
 * The trailing task count, "3/7". Empty when the bot has no card, so the row shows no
 * progress at all rather than a hollow "0/0".
 */
export function progressLabel(progress: BotProgress): string {
  return progress.total ? `${progress.done}/${progress.total}` : "";
}

/** "2 running", or empty when nothing is working (the row then shows no chip at all). */
export function runningLabel(progress: BotProgress): string {
  return progress.running ? `${progress.running} running` : "";
}