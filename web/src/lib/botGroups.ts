/**
 * How the sidebar splits the open sessions into its three quiet groups, and how the team map words
 * a pet's state. Pure rules, kept free of runes so the bun-test harness can import them directly.
 */
import type { SessionState, SessionStatus } from "./types";

export interface BotGroups {
  /** Working now, oldest started first so a live row never reshuffles. */
  live: SessionState[];
  /** Open and waiting: new chats and idle sessions. */
  idle: SessionState[];
  /** Turn over: finished, or stopped on an error or an interrupt. */
  done: SessionState[];
}

const FINISHED: ReadonlySet<string> = new Set<SessionStatus>(["done", "error", "interrupted"]);

/** The bucket a status belongs to. Exactly one, so the three groups never overlap. */
export function bucketOf(status: SessionStatus): "live" | "done" | "idle" {
  if (status === "running") return "live";
  return FINISHED.has(status) ? "done" : "idle";
}

/**
 * Split the visible sessions into working / idle / finished. Every input lands in exactly one
 * group.
 *
 * The sidebar used to filter each group independently: `idle` excluded only "running" and "done",
 * so `error` and `interrupted` matched BOTH `idle` and `done`. Each of those sessions then rendered
 * twice and the keyed row below threw `each_key_duplicate` on every page load. Assign each status
 * to exactly one bucket here instead.
 */
export function partitionBots(
  visible: SessionState[],
  byStart: (a: SessionState, b: SessionState) => number,
): BotGroups {
  const groups: BotGroups = { live: [], idle: [], done: [] };
  for (const s of visible) groups[bucketOf(s.status)].push(s);
  groups.live.sort(byStart);
  return groups;
}

/**
 * How the team map words a pet's state, in ONE place for both kinds of node.
 *
 * A session node used to render the RAW status (`interrupted`, `error`) while the delegate rows
 * beside it said `working`/`done`, so the same map spoke two languages and a stopped session read
 * as an unknown one. The delegate rows come from `agentTreeRows.viewOf`; these two say it for the
 * session nodes, and the tones match the delegate tones so one dot palette covers both.
 */
export type MapTone = "live" | "ok" | "err" | "warn" | "idle";

export function mapLabel(status: SessionStatus): string {
  switch (status) {
    case "running":
      return "working";
    case "done":
      return "done";
    case "error":
      return "failed";
    case "interrupted":
      return "stopped";
    default:
      return "idle";
  }
}

export function mapTone(status: SessionStatus): MapTone {
  switch (status) {
    case "running":
      return "live";
    case "done":
      return "ok";
    case "error":
      return "err";
    case "interrupted":
      return "warn";
    default:
      return "idle";
  }
}