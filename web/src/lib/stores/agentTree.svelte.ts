/**
 * The bots inside each open session, for the sidebar: every session's tree of delegated
 * agents (the hub writes it under the session's run dir; the server reads those files),
 * flattened to rows the nested sidebar list can render directly. Polled quietly — the
 * agent files change without any socket push, and a handful of open sessions cost a
 * handful of cheap cached reads per tick. The pure flattening (and the per-path dedupe
 * a resumed run needs) lives in `../agentTreeRows`, where the test harness can reach it,
 * and the poll's rules live in `../agentTreePoll` (one loop: a slow or hung read cannot
 * stretch or silence the others — measured, E54). This module is the wiring only.
 */
import { api } from "../api";
import { viewOf, type SessionBots } from "../agentTreeRows";
import { AgentTreePoll } from "../agentTreePoll";

export type { BotRow, SessionBots } from "../agentTreeRows";

const EMPTY: SessionBots = { rows: [], live: 0, total: 0 };

class AgentTreeStore {
  /** Per open session: its bots, or EMPTY before the first read lands. */
  trees = $state<Record<string, SessionBots>>({});
  #poll: AgentTreePoll = new AgentTreePoll({
    read: async (id, signal) => viewOf(await api.agentsBrief(id, { signal })),
    apply: (id, view) => {
      this.trees[id] = view as SessionBots;
    },
    hasLive: (): boolean => this.#poll.wanted.some((id: string) => this.trees[id]?.live),
    hidden: () => document.hidden,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  /** Track the sessions the sidebar shows; dropped ones stop being polled. */
  sync(ids: string[]) {
    const next = [...new Set(ids)].sort();
    for (const id of next) if (!this.trees[id]) this.trees[id] = EMPTY;
    this.#poll.sync(next);
  }

  /** The tab was seen again: poll at once instead of waiting out the suspended cadence. */
  resync() {
    this.#poll.resync();
  }
}

export const agentTree = new AgentTreeStore();

// A hidden tab's poll is suspended (E53's clock rule); coming back polls immediately. This is the
// only place the store may touch the page's visibility: `agentTreePoll` gets it injected.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) agentTree.resync();
});
