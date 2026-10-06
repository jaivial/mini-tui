/**
 * The task board, through the socket hub only: one watch for the whole board, answered at once with
 * every session's task card and then pushed whenever an agent writes one (`mini-tui tasks set`,
 * from anywhere). Nothing is polled here and nothing is saved: the agents own the cards, this side
 * only reads them.
 *
 * The board is small and whole, so every push carries all of it. Several readers share one watch
 * (the panel and the button's hover glance), and it is dropped when the last of them lets go; on
 * reconnect it is re-sent, so a card written while this tab was offline is caught up without asking.
 *
 * Plain TypeScript so it is testable outside Svelte; `stores/tasks.svelte.ts` adds the reactivity.
 */
import type { HubConnection } from "./hub";
import type { SessionTask } from "./types";

export class TasksClient {
  #hub: HubConnection;
  /** The board as the server last sent it: every session that has a card, newest first. */
  list: SessionTask[] = [];
  live = false;
  #refs = 0;
  #listeners = new Set<(tasks: SessionTask[]) => void>();

  constructor(connection: HubConnection) {
    this.#hub = connection;
    this.#hub.onState((s) => (this.live = s === "live"));
    this.#hub.onConnect(() => {
      if (this.#refs > 0) this.#hub.send({ t: "tasks.watch" });
    });
    this.#hub.on((msg) => {
      if (msg.t !== "tasks") return;
      this.list = msg.tasks as SessionTask[];
      for (const l of this.#listeners) l(this.list);
    });
  }

  /**
   * Watch the board: `onchange` gets its value now (from the server) and every later change. Returns
   * the release; the watch ends when every holder has released it.
   */
  watch(onchange: (tasks: SessionTask[]) => void): () => void {
    this.#listeners.add(onchange);
    if (++this.#refs === 1) this.#hub.send({ t: "tasks.watch" });
    else onchange(this.list);
    return () => {
      this.#listeners.delete(onchange);
      if (--this.#refs > 0) return;
      this.list = [];
      this.#hub.send({ t: "tasks.unwatch" });
    };
  }
}
