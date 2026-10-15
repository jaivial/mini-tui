/**
 * v6-C: what kind of work is this, before any model is asked.
 *
 * Two signals decide almost every routing question, and both are cheap and
 * deterministic:
 *
 * - **How hard is it** (trivial → hard). A one-line rename and a distributed
 *   race condition do not want the same model, and the operator can tell them
 *   apart long before a 421M encoder reads them.
 * - **How long is the context**. A model whose context tier is below the task's
 *   estimate cannot take the task at all — that is a hard filter, not a penalty,
 *   and it is the cheapest way to avoid the one failure the router cannot retry.
 *
 * These are *heuristics over the task text*, deliberately kept in this file so
 * they can be unit-tested without a Laya service and so the audit can print the
 * evidence that produced the class. They are never used as a ranking on their
 * own: the ranking lives in `decide.ts` and the audit records both.
 */
import type { TrajectoryMessage } from "../traj/schema";

/** The three levels the house already uses for verification and routing. */
export type Complexity = "trivial" | "standard" | "hard";

export interface TaskProfile {
  complexity: Complexity;
  /** 0..1, how much reasoning the text implies. The router's task-complexity variable. */
  score: number;
  /** Rough prompt-size estimate in tokens, for the context filter. */
  estimatedTokens: number;
  /** The words that drove the class — printed in the audit so a decision can be argued with. */
  signals: string[];
  /** A one-line task description, safe to hand to a classifier. */
  summary: string;
}

/**
 * Signals per class. These are the words this house actually uses when it asks
 * for hard work — "race condition", "migrate", "architect" — versus the words it
 * uses for chores ("rename", "list", "typo"). Deliberately English-only: the
 * Laya checkpoint does the multilingual half, and a Spanish "renombrar" must not
 * be read as a "no signal" when it plainly is one.
 */
const TRIVIAL = /\b(typo|rename|renombrar|bump|whitespace|comment out|lint|format|prettier|add (a )?(comment|docstring)|list (the )?files?|read the file|show me|count|version bump|changelog)\b/gi;
const STANDARD = /\b(fix|bug|test|add|implement|refactor|update|handle|parse|validate|migrate data|endpoint|api|pull request|integration)\b/gi;
const HARD = /\b(architect|architecture|race condition|deadlock|concurrency|distributed|consensus|algorithm|performance (regression|profil)|memory leak|root cause|security (vulnerab|audit)|crypto|cryptograph|refactor .{0,20}(across|module|layer)|end-to-end|design (a|the)|redesign|rewrite|migration (plan|strategy)|interview|production (outage|incident))\b/gi;

const COUNTS = [
  { re: TRIVIAL, complexity: "trivial" as const, weight: 2.0 },
  { re: STANDARD, complexity: "standard" as const, weight: 1.0 },
  { re: HARD, complexity: "hard" as const, weight: 2.5 },
];

/** ~4 characters per token is the usual English ratio; only the magnitude matters here. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** The first meaningful line, clipped — the agent's own one-line brief. */
export function summarize(task: string, max = 400): string {
  const line = (task ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

/**
 * Classify a task. Deterministic, side-effect free and cheap enough for the hot path.
 */
export function profileTask(task: string): TaskProfile {
  const text = task ?? "";
  const signals: string[] = [];
  const scores: Record<Complexity, number> = { trivial: 0, standard: 0, hard: 0 };
  for (const { re, complexity, weight } of COUNTS) {
    const hits = new Set<string>();
    for (const match of text.matchAll(new RegExp(re.source, re.flags))) hits.add(match[0].toLowerCase());
    if (hits.size) {
      // Saturating: the tenth "fix" is not ten times harder than the first.
      scores[complexity] += weight * (1 - Math.exp(-hits.size));
      signals.push(`${complexity}:${[...hits].slice(0, 4).join(",")}`);
    }
  }
  // A long task is long however it is worded: a 40 KB prompt is not a chore.
  const tokens = estimateTokens(text);
  if (tokens > 4_000) {
    scores.hard += 1.0;
    signals.push("long-context");
  } else if (tokens > 1_500) {
    scores.standard += 0.5;
    signals.push("medium-context");
  }
  const complexity: Complexity =
    scores.hard > scores.standard && scores.hard > scores.trivial ? "hard" : scores.trivial > scores.standard && scores.trivial > scores.hard ? "trivial" : "standard";
  const spread = scores.trivial + scores.standard + scores.hard;
  // How much of the evidence points at the winning class, in 0..1. This is the
  // signal a reader can act on: a task whose words all say "hard" scores near 1,
  // a task that says hard and standard equally scores near 0.33, and a task with
  // no signal at all scores 0 — ambiguous, which the routing then treats as the
  // middle of the ladder rather than as "easy".
  const score = spread > 0 ? Number((scores[complexity] / spread).toFixed(3)) : 0;
  return {
    complexity,
    score: Math.min(1, Math.max(0, Number(score.toFixed(3)))),
    estimatedTokens: tokens,
    signals,
    summary: summarize(text),
  };
}

/** How a run's conversation looks right now — the level-3 (sub-task) signal. */
export interface SubTaskProfile extends TaskProfile {
  /** Index of the message the profile was taken at, for the audit. */
  atMessage: number;
  /** What the agent appears to be doing, in one line. */
  phase: string;
}

/**
 * The sub-task an agent is on *between* steps, from the tail of its journal.
 *
 * The turn's own plan/subtask record is used first when the run writes one
 * (`extra.task` / `info.subtask`), because the agent stating "now I am writing
 * tests" is better evidence than anything inferred. Otherwise the last user task
 * plus the recent tool calls stand in, which is what a level-3 decision has to
 * work with in practice.
 */
export function profileSubTask(messages: readonly TrajectoryMessage[]): SubTaskProfile {
  const base = profileTask("");
  if (!messages.length) return { ...base, atMessage: 0, phase: "starting" };
  // The newest assistant message with a plan is the best statement of intent.
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 4); i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const extra = (message.extra ?? {}) as Record<string, unknown>;
    const stated = typeof extra.task === "string" ? extra.task : typeof extra.subtask === "string" ? extra.subtask : "";
    if (stated.trim()) {
      const profile = profileTask(stated);
      return { ...profile, atMessage: i, phase: "declared" };
    }
  }
  // Otherwise: the newest user task, plus what has been done since, as one text.
  let task = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      const content = messages[i]!.content;
      task = typeof content === "string" ? content : JSON.stringify(content ?? "");
      break;
    }
  }
  const recent = messages
    .slice(-6)
    .flatMap((message) => {
      const extra = (message.extra ?? {}) as Record<string, unknown>;
      const actions = Array.isArray(extra.actions) ? extra.actions : [];
      return actions.map((action) => (typeof action === "object" && action ? String((action as Record<string, unknown>).command ?? "") : ""));
    })
    .join("\n");
  const profile = profileTask(`${task}\n${recent}`);
  return { ...profile, atMessage: messages.length, phase: "inferred" };
}