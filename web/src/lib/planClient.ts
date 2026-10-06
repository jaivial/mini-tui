/**
 * The DAG plans, through the socket hub only: one watch for every session's plan, answered at
 * once and then pushed whenever a hub updates its plan.json. Nothing is polled here and nothing
 * is saved: the Rust hubs own the plans, this side only reads and draws them.
 *
 * Mirrors `tasksClient.ts`: several readers share one watch, it is dropped when the last holder
 * lets go, and it is re-sent on reconnect so a plan changed while the tab was offline is caught up.
 * Plain TypeScript so it is testable outside Svelte; `stores/plans.svelte.ts` adds the reactivity.
 */
import type { HubConnection } from "./hub";
import type { SessionPlan } from "./types";

export class PlanClient {
  #hub: HubConnection;
  /** Every session's plan as the server last sent it. */
  plans: SessionPlan[] = [];
  live = false;
  #refs = 0;
  #listeners = new Set<(plans: SessionPlan[]) => void>();

  constructor(connection: HubConnection) {
    this.#hub = connection;
    this.#hub.onState((s) => (this.live = s === "live"));
    this.#hub.onConnect(() => {
      if (this.#refs > 0) this.#hub.send({ t: "plan.watch" });
    });
    this.#hub.on((msg) => {
      if (msg.t !== "plan") return;
      this.plans = msg.plans as SessionPlan[];
      for (const l of this.#listeners) l(this.plans);
    });
  }

  /**
   * Watch the plans: `onchange` gets them now (from the server) and on every later change.
   * Returns the release; the watch ends when every holder has released it.
   */
  watch(onchange: (plans: SessionPlan[]) => void): () => void {
    this.#listeners.add(onchange);
    if (++this.#refs === 1) this.#hub.send({ t: "plan.watch" });
    else onchange(this.plans);
    return () => {
      this.#listeners.delete(onchange);
      if (--this.#refs > 0) return;
      this.plans = [];
      this.#hub.send({ t: "plan.unwatch" });
    };
  }
}
