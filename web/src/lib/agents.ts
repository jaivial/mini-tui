/**
 * The agents and their bots, as the sidebar's accordion shows them: pure shapes and rules, so the
 * grouping, the moods and the subagent tree are testable without a browser (see
 * tests/web-agents-accordion.test.ts).
 *
 * A "bot" is a pane of the agent (what `panes.svelte.ts` keeps per window); a bot's session may have
 * started subagents of its own, which each are sessions too — the tree below walks them as deep as
 * the data goes.
 */
import type { PetMood } from "./mascot";
import type { SessionState, SubagentView } from "./types";

/** The agent's own pose, from its bots' states: one mascot speaks for the whole agent. */
export function agentMood(bots: { status: SessionState["status"] | null }[]): PetMood {
  const real = bots.filter((b) => b.status !== null);
  if (!real.length) return "idle";
  if (real.some((b) => b.status === "running")) return "thinking";
  if (real.some((b) => b.status === "error" || b.status === "interrupted")) return "break";
  if (real.every((b) => b.status === "done")) return "happy";
  return "idle";
}

/** One row of the subagent tree under a bot: the bot's session and everyone it spawned. */
export interface SubRow {
  key: string;
  /** Set when the subagent is a live session this server has open (its row can open it). */
  sessionId: string | null;
  name: string;
  /** starting, running, waiting, stopped, exited, dead — straight from the roster. */
  state: string;
  steps: number;
  cost: number;
  task: string;
  /** 0 for the bot's own session's direct subagents, 1 for theirs, and so on. */
  depth: number;
}

/**
 * The subagent tree of one bot's session, depth first. Children resolve through `sessionOf`: a
 * subagent this server has open contributes its own roster line AND its children (the hierarchy is
 * read from the sessions, which the live socket keeps fresh); one that is not open is a leaf with
 * what the parent's roster says about it. Cycles (a roster naming an ancestor) and very deep trees
 * (past `maxDepth`) stop there.
 */
export function subagentRows(
  sessionOf: (id: string) => Pick<SessionState, "subagents"> | undefined,
  rootSessionId: string | null | undefined,
  maxDepth = 4,
): SubRow[] {
  const rows: SubRow[] = [];
  const seen = new Set<string>(rootSessionId ? [rootSessionId] : []);
  const walk = (views: SubagentView[] | undefined, depth: number) => {
    if (!views || depth > maxDepth) return;
    for (const v of views) {
      if (!v || typeof v.sessionId !== "string") continue;
      const listed = seen.has(v.sessionId);
      rows.push({ key: `${v.sessionId}@${depth}:${rows.length}`, sessionId: v.sessionId, name: v.name || v.sessionId, state: v.state, steps: v.steps, cost: v.cost, task: v.task, depth });
      if (listed) continue; // already walked from an ancestor: do not loop
      seen.add(v.sessionId);
      walk(sessionOf(v.sessionId)?.subagents, depth + 1);
    }
  };
  walk(rootSessionId ? sessionOf(rootSessionId)?.subagents : undefined, 0);
  return rows;
}

/** The one line a subagent row reads: what it is, in the same voice as SubagentStrip's tooltips. */
export function subRowLabel(row: SubRow): string {
  const status = row.state === "dead" ? "dead (its process is gone)" : row.state;
  return `Subagent ${row.name}: ${status}, ${row.steps} steps${row.task ? ` — ${row.task}` : ""}`;
}
