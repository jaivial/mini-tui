/**
 * The bots inside each open session, for the sidebar: every session's tree of delegated
 * agents (the hub writes it under the session's run dir; the server reads those files),
 * flattened to rows the nested sidebar list can render directly. Polled quietly — the
 * agent files change without any socket push, and a handful of open sessions cost a
 * handful of cheap cached reads per tick. The pure flattening (and the per-path dedupe
 * a resumed run needs) lives in `../agentTreeRows`, where the test harness can reach it.
 */
import { api } from "../api";
import { viewOf, type SessionBots } from "../agentTreeRows";

export type { BotRow, SessionBots } from "../agentTreeRows";

const EMPTY: SessionBots = { rows: [], live: 0, total: 0 };

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
