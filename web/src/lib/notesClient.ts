/**
 * Notes, through the socket hub only. There is no REST call and no polling here: a note is *watched*
 * (the hub answers at once with its value and then pushes every change made anywhere), and saved with
 * a message that names the version it started from.
 *
 * Several panes may show the same note: they share one watch, and the watch is dropped when the last
 * of them lets go. On reconnect every watched note is re-watched, which re-sends its current value, so
 * a note edited on another device while this one was offline is caught up without asking.
 *
 * Plain TypeScript so it is testable outside Svelte; `stores/notes.svelte.ts` adds the reactivity.
 */
import type { HubConnection, SendToken } from "./hub";
import type { Note } from "./types";

export type NoteSave = { ok: true; note: Note } | { ok: false; conflict: Note };

export class NotesClient {
  #hub: HubConnection;
  /** The latest value the server told us, per watched note. */
  values: Record<string, Note> = {};
  live = false;
  #refs = new Map<string, number>();
  #listeners = new Map<string, Set<(n: Note) => void>>();
  #pending = new Map<number, { resolve: (r: NoteSave) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; token: SendToken }>();
  #req = 0;
  noteMax = 200_000;
  /**
   * The versions OUR saves established, including the ones whose answer arrived after the app had
   * given up on them. A save the app never observed still moves the note on server-side, and the
   * next save must name that version or it is refused as a conflict for a change that is its own.
   */
  ourVersions: Record<string, number> = {};

  constructor(connection: HubConnection) {
    this.#hub = connection;
    this.#hub.onState((s) => (this.live = s === "live"));
    this.#hub.onConnect(() => {
      for (const id of this.#refs.keys()) this.#hub.send({ t: "note.watch", id }, { rewatch: true });
    });
    this.#hub.on((msg) => {
      if (msg.t === "hello") this.noteMax = (msg.limits as { noteMax: number }).noteMax;
      else if (msg.t === "note") this.#value(msg.note as Note);
      else if (msg.t === "note.saved") {
        this.#value(msg.note as Note, true);
        // An answer for a save the app already gave up on still establishes a version (see
        // `ourVersions`): the write landed, and the next save must not be refused for it.
        this.#settle(msg.req as number, { ok: true, note: msg.note as Note });
      } else if (msg.t === "note.conflict") this.#settle(msg.req as number, { ok: false, conflict: msg.current as Note });
      else if (msg.t === "error" && typeof msg.req === "number") this.#fail(msg.req, String(msg.error));
    });
  }

  /**
   * Watch a note: `onchange` gets its value now (from the server) and every later change made
   * elsewhere. Returns the release; the watch ends when every holder has released it.
   */
  watch(id: string, onchange: (note: Note) => void): () => void {
    let set = this.#listeners.get(id);
    if (!set) this.#listeners.set(id, (set = new Set()));
    set.add(onchange);
    const n = (this.#refs.get(id) ?? 0) + 1;
    this.#refs.set(id, n);
    if (n === 1) this.#hub.send({ t: "note.watch", id }, { rewatch: true });
    else if (this.values[id]) onchange(this.values[id]!);
    return () => {
      set!.delete(onchange);
      const left = (this.#refs.get(id) ?? 1) - 1;
      if (left > 0) return this.#refs.set(id, left);
      this.#refs.delete(id);
      this.#listeners.delete(id);
      delete this.values[id];
      this.#hub.send({ t: "note.unwatch", id });
    };
  }

  /**
   * Save over the socket. Resolves with the saved note or the newer one it conflicted with.
   *
   * The deadline has two verdicts and only one of them is final (E50). A message still **queued**
   * is withdrawn, so a save reported as failed can never land afterwards — measured before the fix:
   * the promise was rejected at 600 ms with "no answer from the server" and the `note.save` went out
   * right after, so the panel said *error* while the server took the write. A message already **out**
   * cannot be taken back, and the app says that instead of claiming a failure it cannot prove.
   */
  save(id: string, body: string, base: number, timeoutMs = saveDeadlineMs(body.length)): Promise<NoteSave> {
    const req = ++this.#req;
    return new Promise<NoteSave>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.#pending.get(req);
        if (!p) return;
        if (p.token.cancel()) {
          this.#pending.delete(req);
          reject(new Error("never sent: the app is not connected to the server"));
          return;
        }
        this.#pending.delete(req);
        reject(new Error("no answer from the server (the save may still be applied)"));
      }, timeoutMs);
      const token = this.#hub.send({ t: "note.save", id, body, base, req });
      this.#pending.set(req, { resolve, reject, timer, token });
    });
  }

  #value(note: Note, own = false) {
    this.values[note.id] = note;
    // The sender already has its answer through save(); only pushes from elsewhere notify listeners.
    if (own) return;
    for (const l of this.#listeners.get(note.id) ?? []) l(note);
  }
  #settle(req: number, result: NoteSave) {
    if (result.ok) this.ourVersions[result.note.id] = result.note.updatedAt;
    const p = this.#pending.get(req);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(req);
    p.resolve(result);
  }
  #fail(req: number, error: string) {
    const p = this.#pending.get(req);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(req);
    p.reject(new Error(error));
  }
}


/**
 * How long a save may take, from the size it carries: a deadline must outlast the work it measures
 * (the rule E43 wrote for uploads, applied here). The flat 15 s could fire while a big note was
 * still leaving this machine — `noteMax` is 200 000 characters, and pushed over the slowest link
 * that still counts as work (12.5 KiB/s, E43) that is ~62 s of send alone — reporting "no answer"
 * for a save that then landed. Worst-case UTF-8 is 4 bytes a character.
 */
export function saveDeadlineMs(chars: number, roundTripMs = 15_000): number {
  const SLOWEST_BYTES_PER_S = 12_800;
  const BYTES_PER_CHAR = 4;
  return roundTripMs + Math.ceil((Math.max(0, chars) * BYTES_PER_CHAR * 1000) / SLOWEST_BYTES_PER_S);
}
