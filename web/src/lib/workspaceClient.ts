/**
 * The shared workspace over the socket hub: the windows, their panes, which session each pane shows,
 * and the sidebar's preferences. It is the same on every device, browser and tab. Nothing is polled:
 * the tab watches it once (and again on every reconnect, which re-sends the current value), and every
 * change made anywhere else is pushed.
 *
 * Saves are optimistic and versioned. A save names the version it started from. When another tab got
 * there first, the server answers with the newer value and this client adopts it (`onRemote`) instead
 * of overwriting it. Edits made while offline are kept and sent, in order, on reconnect.
 *
 * It knows nothing about Svelte or the shape of the document; the hub is injectable for tests.
 */
export interface WorkspaceDoc {
  windows?: unknown;
  panes?: unknown;
  sidebar?: unknown;
}

interface HubLike {
  send(msg: { t: string; [k: string]: unknown }): void;
  on(listener: (msg: { t: string; [k: string]: unknown }) => void): () => void;
  onConnect(fn: () => void): () => void;
}

export class WorkspaceClient {
  #hub: HubLike;
  #version = 0;
  /** What the server holds, as last told (or as we last saved successfully). */
  #doc: WorkspaceDoc | null = null;
  /** True once the server has answered the first watch: until then nothing is saved. */
  #ready = false;
  #waiters: Array<() => void> = [];
  #req = 0;
  /** The save on the wire, and what to save next once it is answered (only the latest matters). */
  #inflight: number | null = null;
  #next: WorkspaceDoc | null = null;
  #scheduled = false;
  #remote = new Set<(doc: WorkspaceDoc) => void>();

  constructor(hub: HubLike) {
    this.#hub = hub;
    this.#hub.onConnect(() => this.#hub.send({ t: "ws.watch" }));
    this.#hub.on((msg) => {
      if (msg.t === "ws") this.#adopt(msg.workspace as { version: number; doc: unknown });
      else if (msg.t === "ws.saved" && msg.req === this.#inflight) {
        this.#version = msg.version as number;
        this.#inflight = null;
        this.#flush();
      } else if (msg.t === "ws.conflict" && msg.req === this.#inflight) {
        // Someone else saved first: theirs wins, and what we were about to send is dropped. Our tab
        // shows their layout, which is what "the same everywhere" means.
        this.#inflight = null;
        this.#next = null;
        this.#adopt(msg.current as { version: number; doc: unknown });
      } else if (msg.t === "error" && msg.req === this.#inflight) {
        this.#inflight = null;
        this.#flush();
      }
    });
    this.#hub.send({ t: "ws.watch" });
  }

  get ready(): boolean {
    return this.#ready;
  }
  get version(): number {
    return this.#version;
  }
  /** What the server holds (null before the first answer, or when nothing was ever saved). */
  get doc(): WorkspaceDoc | null {
    return this.#doc;
  }

  /** Resolves once the server's value is known (at most `timeout` ms: offline, the app still starts). */
  whenReady(timeout = 2500): Promise<void> {
    if (this.#ready) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeout);
      this.#waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Another tab or device changed it: called with the new document. */
  onRemote(fn: (doc: WorkspaceDoc) => void): () => void {
    this.#remote.add(fn);
    return () => this.#remote.delete(fn);
  }

  /** Save one part of the document (`windows`, `panes` or `sidebar`), merged into the rest. */
  save(part: keyof WorkspaceDoc, value: unknown) {
    this.saveParts({ [part]: value });
  }

  /**
   * Save several parts as one version, so no other tab ever sees one without the other (a new window
   * and its first pane). Changes made in the same tick go out together. Saves made before the first
   * answer are held: the server's value wins over them, except for parts it does not have yet.
   */
  saveParts(parts: WorkspaceDoc) {
    const current = this.#next ?? this.#doc ?? {};
    const changed = (Object.keys(parts) as (keyof WorkspaceDoc)[]).filter((k) => JSON.stringify(parts[k]) !== JSON.stringify(current[k]));
    if (!changed.length) return;
    this.#next = { ...current, ...Object.fromEntries(changed.map((k) => [k, parts[k]])) };
    if (!this.#ready || this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }

  #flush() {
    if (this.#inflight !== null || !this.#next) return;
    const doc = this.#next;
    this.#next = null;
    this.#inflight = ++this.#req;
    this.#doc = doc;
    this.#hub.send({ t: "ws.save", doc, base: this.#version, req: this.#inflight });
  }

  #adopt(w: { version: number; doc: unknown }) {
    const first = !this.#ready;
    // An answer about a version we already passed (a late push of our own save) changes nothing.
    if (!first && w.version <= this.#version) return;
    this.#version = w.version;
    const doc = (w.doc && typeof w.doc === "object" ? w.doc : null) as WorkspaceDoc | null;
    this.#ready = true;
    if (first) {
      this.#doc = doc;
      // What this tab changed while it waited only seeds parts the server does not have yet: a device
      // that opens the app adopts the saved workspace, it never overwrites it with its own.
      if (this.#next) {
        const seed = (Object.keys(this.#next) as (keyof WorkspaceDoc)[]).filter((k) => doc?.[k] === undefined);
        this.#next = seed.length ? { ...(doc ?? {}), ...Object.fromEntries(seed.map((k) => [k, this.#next![k]])) } : null;
      }
      for (const fn of this.#waiters.splice(0)) fn();
      // Anyone who started without it (an offline start that timed out) adopts it now.
      if (doc) for (const fn of this.#remote) fn(doc);
      this.#flush();
      return;
    }
    this.#doc = doc;
    if (doc) for (const fn of this.#remote) fn(doc);
  }
}
