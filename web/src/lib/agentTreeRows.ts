/**
 * The pure half of the sidebar's agent tree: the server's agent tree flattened to the
 * rows the nested sidebar list renders. Kept free of runes so the bun-test harness can
 * import it directly (`tests/web-agent-tree-rows.test.ts`); the polled store lives in
 * `stores/agentTree.svelte.ts`.
 */
import type { AgentNode } from "./types";

/** One bot in a session's tree, flattened for the sidebar (children after their parent). */
export interface BotRow {
  /** Stable id: the agent's own session id, so its avatar face never drifts. */
  id: string;
  /** The names from the session's first delegate down to this one (`login/backend`). */
  path: string;
  name: string;
  /** The agent definition it runs (`general`, `translator`...); empty for a plain spawn. */
  agent: string;
  /** Short state in words: working, done, failed, waiting on N, starting… */
  label: string;
  tone: "live" | "ok" | "err" | "wait" | "warn" | "idle";
  task: string;
  /** 0 for a delegate of the session itself, 1 for that delegate's own delegate… */
  depth: number;
}

export interface SessionBots {
  rows: BotRow[];
  /** Agents working right now (the sidebar's pulsing count on the window row). */
  live: number;
  total: number;
}

/** The same words the agents panel uses, so the two never disagree about a state. */
function rowOf(n: AgentNode, depth: number): BotRow {
  let label: string;
  let tone: BotRow["tone"];
  if (n.waitingChildren.length) {
    label = `waiting on ${n.waitingChildren.length}`;
    tone = "wait";
  } else if (n.awaiting) {
    label = "waiting";
    tone = "wait";
  } else if (n.state === "running" || n.state === "starting") {
    label = n.state === "starting" ? "starting" : "working";
    tone = "live";
  } else if (n.state === "dead") {
    label = "dead";
    tone = "err";
  } else if (n.state === "waiting") {
    label = n.exitStatus && n.exitStatus !== "Submitted" ? n.exitStatus : "done";
    tone = label === "done" ? "ok" : "warn";
  } else if (n.state === "exited" && n.exitStatus && n.exitStatus !== "Submitted") {
    label = "failed";
    tone = "err";
  } else if (n.state === "stopped") {
    label = "stopped";
    tone = "idle";
  } else {
    label = n.exitStatus === "Submitted" ? "done" : n.state || "idle";
    tone = n.exitStatus === "Submitted" ? "ok" : "idle";
  }
  return { id: n.sessionId, path: n.path, name: n.name, agent: n.agent, label, tone, task: n.task, depth };
}

function flatten(nodes: AgentNode[], depth = 0, out: BotRow[] = []): BotRow[] {
  for (const n of nodes) {
    out.push(rowOf(n, depth));
    flatten(n.children, depth + 1, out);
  }
  return out;
}

/** The sidebar's `{#each tree.rows as r (r.path)}` keys on path, and a resumed run can
 *  briefly list the same delegate twice: keep the first row per path, or duplicate
 *  keys would warn (`each_key_duplicate`) and render the bot double. */
export function viewOf(v: { nodes: AgentNode[] }): SessionBots {
  const seen = new Set<string>();
  const rows: BotRow[] = [];
  for (const r of flatten(v.nodes)) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    rows.push(r);
  }
  return { rows, live: rows.filter((r) => r.tone === "live").length, total: rows.length };
}
