/** Read-only queue subscription shared by board/main clients, with durable cursor dedup. */
export interface QueueEvent { seq: number; task: string; kind: string; goal_version: number; fence: number; status: string; created: number }
export interface QueueNode { id: string; project: string; goal: string; status: string; goal_version: number; fence: number; result: string | null }
export interface QueueView { nodes: QueueNode[]; edges: Array<{ task: string; dependency: string }> }

export class QueueEventsClient {
  #source: EventSource | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<(view: QueueView, event?: QueueEvent) => void>();
  #cursor = 0;
  #generation = 0;
  #refreshing = false;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #pending: QueueEvent | undefined;
  view: QueueView = { nodes: [], edges: [] };
  error = "";
  constructor(readonly base = "/api") {}
  watch(listener: (view: QueueView,event?: QueueEvent) => void): () => void {
    this.#listeners.add(listener); listener(this.view);
    if (this.#listeners.size === 1) { void this.#refresh(); this.#connect(); }
    let released = false;
    return () => {
      if (released) return; released = true;
      this.#listeners.delete(listener);
      if (!this.#listeners.size) {
        this.#generation++; this.#source?.close(); this.#source = null;
        clearTimeout(this.#timer); this.#timer = undefined;
        clearTimeout(this.#refreshTimer); this.#refreshTimer = undefined;
      }
    };
  }
  #connect() {
    if (this.#source || !this.#listeners.size) return;
    const source = new EventSource(`${this.base}/task-events/stream?after=${this.#cursor}`);
    this.#source = source;
    source.addEventListener("task",raw => {
      try {
        const event = JSON.parse((raw as MessageEvent).data) as QueueEvent;
        if (!Number.isSafeInteger(event.seq) || event.seq <= this.#cursor || typeof event.task !== "string" || typeof event.status !== "string") return;
        this.#cursor = event.seq;
        this.#pending = event;
        void this.#refresh();
      } catch { this.error = "invalid queue event"; }
    });
    const failed = () => {
      if (this.#source !== source) return;
      source.close(); this.#source = null;
      this.error = "queue stream unavailable; reconnecting";
      if (this.#listeners.size) this.#timer = setTimeout(() => { void this.#refresh(); this.#connect(); },5000);
    };
    source.addEventListener("queue-error",failed);
    source.onerror = failed;
  }
  async #refresh() {
    if (this.#refreshing || !this.#listeners.size) return;
    clearTimeout(this.#refreshTimer); this.#refreshTimer = undefined;
    this.#refreshing = true;
    const generation = this.#generation;
    const event = this.#pending; this.#pending = undefined;
    let failed = false;
    try {
      const res = await fetch(`${this.base}/task-graph`,{ signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`queue snapshot failed (${res.status})`);
      const view = await res.json() as QueueView;
      if (!Array.isArray(view.nodes) || !Array.isArray(view.edges)) throw new Error("invalid queue snapshot");
      if (generation !== this.#generation || !this.#listeners.size) return;
      this.view = view; this.error = "";
      for (const listener of this.#listeners) listener(view,event);
    } catch (e) {
      failed = true;
      if (generation === this.#generation) {
        this.error = (e as Error).message;
        this.#pending ??= event;
      }
    }
    finally {
      this.#refreshing = false;
      if (this.#listeners.size) {
        if (failed) this.#refreshTimer = setTimeout(() => { void this.#refresh(); },5000);
        else if (this.#pending) void this.#refresh();
      }
    }
  }
}
