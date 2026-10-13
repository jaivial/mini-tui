/** Read-only queue subscription shared by board/main clients, with durable cursor dedup. */
export interface QueueEvent { seq: number; task: string; kind: string; goal_version: number; fence: number; status: string; created: number }
export interface QueueNode { id: string; project: string; goal: string; status: string; goal_version: number; fence: number; result: string | null }
export interface QueueView { nodes: QueueNode[]; edges: Array<{ task: string; dependency: string }> }

/** Fail closed before exposing a malformed projection to a board or main client. */
function validView(value: unknown): value is QueueView {
  if (!value || typeof value !== "object") return false;
  const view = value as QueueView;
  if (!Array.isArray(view.nodes) || !Array.isArray(view.edges) || view.nodes.length > 10_000 || view.edges.length > 50_000) return false;
  const ids = new Set<string>();
  for (const node of view.nodes) {
    if (!node || typeof node.id !== "string" || !node.id || ids.has(node.id)
      || typeof node.project !== "string" || typeof node.goal !== "string" || typeof node.status !== "string"
      || !Number.isSafeInteger(node.goal_version) || node.goal_version < 1
      || !Number.isSafeInteger(node.fence) || node.fence < 0
      || (node.result !== null && typeof node.result !== "string")) return false;
    ids.add(node.id);
  }
  return view.edges.every(edge => edge && typeof edge.task === "string" && typeof edge.dependency === "string"
    && ids.has(edge.task) && ids.has(edge.dependency));
}

export class QueueEventsClient {
  #source: EventSource | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<(view: QueueView, event?: QueueEvent) => void>();
  #cursor = 0;
  #generation = 0;
  #refreshRequest: AbortController | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #pending: QueueEvent | undefined;
  view: QueueView = { nodes: [], edges: [] };
  error = "";
  constructor(readonly base = "/api") {}
  watch(listener: (view: QueueView,event?: QueueEvent) => void): () => void {
    this.#listeners.add(listener);
    try { listener(this.view); } catch { /* consumer owns its rendering error */ }
    if (this.#listeners.size === 1) { void this.#refresh(); this.#connect(); }
    let released = false;
    return () => {
      if (released) return; released = true;
      this.#listeners.delete(listener);
      if (!this.#listeners.size) {
        this.#generation++; this.#source?.close(); this.#source = null;
        this.#refreshRequest?.abort(); this.#refreshRequest = null;
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
      if (this.#source !== source || !this.#listeners.size) return;
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
    if (this.#refreshRequest || !this.#listeners.size) return;
    clearTimeout(this.#refreshTimer); this.#refreshTimer = undefined;
    const request = new AbortController();
    this.#refreshRequest = request;
    const timeout = setTimeout(() => request.abort(),10_000);
    const generation = this.#generation;
    const event = this.#pending; this.#pending = undefined;
    let failed = false;
    try {
      const res = await fetch(`${this.base}/task-graph`,{ signal: request.signal });
      if (!res.ok) throw new Error(`queue snapshot failed (${res.status})`);
      const view = await res.json() as QueueView;
      if (!validView(view)) throw new Error("invalid queue snapshot");
      if (generation !== this.#generation || !this.#listeners.size) return;
      this.view = view; this.error = "";
      for (const listener of this.#listeners) {
        // One view callback must not break subscription delivery to the others.
        try { listener(view,event); } catch { /* consumer owns its rendering error */ }
      }
    } catch (e) {
      failed = true;
      if (generation === this.#generation) {
        this.error = (e as Error).message;
        this.#pending ??= event;
      }
    }
    finally {
      clearTimeout(timeout);
      if (this.#refreshRequest === request) this.#refreshRequest = null;
      if (generation === this.#generation && this.#listeners.size) {
        if (failed) this.#refreshTimer = setTimeout(() => { void this.#refresh(); },5000);
        else if (this.#pending) void this.#refresh();
      }
    }
  }
}
