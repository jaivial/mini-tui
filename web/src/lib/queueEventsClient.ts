/**
 * Read-only queue subscription shared by board/main clients, with durable cursor dedup.
 * The stream's reconnect takes its backoff from `Reconnect` (E50): the flat 5 s it used to retry on
 * was the fourth copy of the same machinery in this client surface, and the one with no backoff.
 */
import { Reconnect, type ReconnectOptions } from "./reconnect";
export interface QueueEvent { seq: number; task: string; kind: string; goal_version: number; fence: number; status: string; created: number }
export interface QueueNode { id: string; project: string; goal: string; status: string; goal_version: number; fence: number; result: string | null; owner?: string | null; lease_until?: number | null; priority?: number; cwd?: string }
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
    // Lease fields are optional; when present they must be well-formed so the
    // panel never renders a heartbeat it cannot trust.
    if (node.owner !== undefined && node.owner !== null && typeof node.owner !== "string") return false;
    if (node.lease_until !== undefined && node.lease_until !== null && !Number.isSafeInteger(node.lease_until)) return false;
    if (node.priority !== undefined && !Number.isSafeInteger(node.priority)) return false;
    if (node.cwd !== undefined && node.cwd !== null && typeof node.cwd !== "string") return false;
    ids.add(node.id);
  }
  return view.edges.every(edge => edge && typeof edge.task === "string" && typeof edge.dependency === "string"
    && ids.has(edge.task) && ids.has(edge.dependency));
}

export class QueueEventsClient {
  #source: EventSource | null = null;
  #r: Reconnect;
  #openedAt = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<(view: QueueView, event?: QueueEvent) => void>();
  #cursor = 0;
  #generation = 0;
  #refreshRequest: AbortController | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #pending: QueueEvent | undefined;
  view: QueueView = { nodes: [], edges: [] };
  #snapshotError = "";
  #streamError = "";
  get error(): string { return [this.#snapshotError, this.#streamError].filter(Boolean).join("; "); }
  loaded = false;
  constructor(readonly base = "/api", reconnect: ReconnectOptions = {}) {
    this.#r = new Reconnect({ baseDelay: 5_000, maxDelay: 15_000, ...reconnect });
  }
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
  #notify(event?: QueueEvent) {
    for (const listener of this.#listeners) {
      try { listener(this.view,event); } catch { /* consumer owns its rendering error */ }
    }
  }
  #connect() {
    if (this.#source || !this.#listeners.size) return;
    const source = new EventSource(`${this.base}/task-events/stream?after=${this.#cursor}`);
    this.#source = source;
    this.#openedAt = Date.now();
    source.onopen = () => {
      if (this.#source !== source || !this.#listeners.size) return;
      this.#streamError = ""; this.#notify();
    };
    source.addEventListener("task",raw => {
      if (this.#source !== source || !this.#listeners.size) return;
      try {
        const event = JSON.parse((raw as MessageEvent).data) as QueueEvent;
        if (!Number.isSafeInteger(event.seq) || event.seq <= this.#cursor || typeof event.task !== "string" || typeof event.status !== "string") return;
        this.#r.delivered();
        this.#streamError = "";
        this.#cursor = event.seq;
        this.#pending = event;
        void this.#refresh();
      } catch { this.#streamError = "invalid queue event"; this.#notify(); }
    });
    const failed = () => {
      if (this.#source !== source) return;
      source.close(); this.#source = null;
      this.#r.closing(Date.now() - this.#openedAt);
      this.#streamError = "queue stream unavailable"; this.#notify();
      if (this.#listeners.size) this.#timer = setTimeout(() => { void this.#refresh(); this.#connect(); }, this.#r.nextDelay());
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
      this.view = view; this.loaded = true; this.#snapshotError = "";
      this.#notify(event);
    } catch (e) {
      failed = true;
      if (generation === this.#generation) {
        this.#snapshotError = (e as Error).message;
        this.#pending ??= event;
        this.#notify();
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
