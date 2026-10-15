/**
 * The bots inside each open session, for the sidebar: every session's tree of delegated
 * agents (the hub writes it under the session's run dir; the server reads those files),
 * flattened to rows the nested sidebar list can render directly. Polled quietly — the
 * agent files change without any socket push, and a handful of open sessions cost a
 * handful of cheap cached reads per tick.
 */
import { api } from "../api";
import type { AgentNode } from "../types";

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

const EMPTY: SessionBots = { rows: [], live: 0, total: 0 };

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

function viewOf(v: { nodes: AgentNode[] }): SessionBots {
  const rows = flatten(v.nodes);
  return { rows, live: rows.filter((r) => r.tone === "live").length, total: rows.length };
}

class AgentTreeStore {
  /** Per open session: its bots, or EMPTY before the first read lands. */
  trees = $state<Record<string, SessionBots>>({});
  #wanted: string[] = [];
  #sleeping = false;

  /** Track the sessions the sidebar shows; dropped ones stop being polled. */
  sync(ids: string[]) {
    const next = [...new Set(ids)].sort();
    const old = this.#wanted;
    if (old.length === next.length && old.every((id, i) => id === next[i])) return;
    this.#wanted = next;
    for (const id of next) if (!this.trees[id]) this.trees[id] = EMPTY;
    this.#wake();
  }

  /** One loop for the whole sidebar, however many sessions are open. */
  async #wake() {
    if (this.#sleeping) return;
    this.#sleeping = true;
    while (this.#wanted.length) {
      const ids = this.#wanted;
      await Promise.all(
        ids.map(async (id) => {
          try {
            const v = viewOf(await api.agents(id));
            // A session that closed mid-tick: drop it rather than remember a ghost.
            if (!this.#wanted.includes(id)) return;
            this.trees[id] = v;
          } catch {
            // Keep the last good tree; the next tick tries again.
          }
        }),
      );
      const pace = this.#wanted.some((id) => this.trees[id]?.live) ? 3000 : 5000;
      await new Promise((r) => setTimeout(r, document.hidden ? pace * 2 : pace));
    }
    this.#sleeping = false;
  }
}

export const agentTree = new AgentTreeStore();
