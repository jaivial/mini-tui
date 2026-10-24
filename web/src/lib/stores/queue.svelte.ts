/**
 * The work queue as the app shows it: the chat's session and every task, kept live by the
 * `queue` pushes on the shared stream (and one fetch on load / reconnect).
 */
import { api } from "../api";
import { store } from "./sessions.svelte";
import type { QueueStatus, QueueTask, QueueView } from "../types";

export type QueueFilter = "all" | "running" | "queued" | "done" | "error";

export const FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "running", label: "Working" },
  { id: "queued", label: "Queued" },
  { id: "done", label: "Completed" },
  { id: "error", label: "Error" },
];

export function matches(status: QueueStatus, filter: QueueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "error") return status === "error" || status === "cancelled";
  return status === filter;
}

class QueueStore {
  tasks = $state<QueueTask[]>([]);
  main = $state("");
  concurrency = $state(0);
  loaded = $state(false);
  #off: (() => void) | null = null;

  get counts(): Record<QueueFilter, number> {
    const c: Record<QueueFilter, number> = { all: this.tasks.length, running: 0, queued: 0, done: 0, error: 0 };
    for (const t of this.tasks) for (const f of ["running", "queued", "done", "error"] as const) if (matches(t.status, f)) c[f] += 1;
    return c;
  }

  apply(view: QueueView) {
    this.tasks = view.tasks;
    this.main = view.main;
    if (view.concurrency) this.concurrency = view.concurrency;
    this.loaded = true;
  }

  async load() {
    this.#off ??= store.onQueue((view) => this.apply(view));
    this.apply(await api.queue());
  }
}

export const queue = new QueueStore();
