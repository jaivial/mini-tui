/**
 * The app's socket hub: one WebSocket per browser tab (`/api/hub`) carrying everything the right
 * sidebar needs. Today that is session notes; the protocol is topic-based so more can join it.
 *
 * A client *watches* a note and is sent its current value at once, then every change to it, from any
 * tab or device, pushed as it happens. Nothing is polled. Saves go over the same socket, name the
 * version they started from, and are answered to the sender (`note.saved` or `note.conflict`); the
 * other watchers get the new value as a push. A stale save never overwrites a newer note.
 *
 * Nothing here knows about sockets: a client is a `send` function, so the rules are testable without
 * a network (see tests/web-hub.test.ts).
 */
import type { Note, SaveNoteResult } from "../sessions";

export type HubIn =
  | { t: "ping" }
  | { t: "note.watch"; id: string }
  | { t: "note.unwatch"; id: string }
  | { t: "note.save"; id: string; body: string; base?: number; req: number };

export type HubOut =
  | { t: "pong" }
  | { t: "hello"; limits: { noteMax: number } }
  /** A watched note's value: sent on watch, and whenever it changes elsewhere. */
  | { t: "note"; note: Note }
  | { t: "note.saved"; req: number; note: Note }
  | { t: "note.conflict"; req: number; current: Note }
  | { t: "error"; req?: number; id?: string; error: string };

export interface HubClient {
  /** False when the message could not be delivered. */
  send(msg: HubOut): boolean;
}

export interface NoteStore {
  get(id: string): Note;
  save(id: string, body: string, base?: number): SaveNoteResult;
}

const NOTE_ID = /^[\w.-]{1,128}$/;

export class Hub {
  #watch = new Map<string, Set<HubClient>>();
  #of = new Map<HubClient, Set<string>>();

  constructor(
    private readonly notes: NoteStore,
    private readonly noteMax: number,
  ) {}

  /** A client connected: tell it the limits it must respect. */
  join(client: HubClient): void {
    this.#of.set(client, new Set());
    client.send({ t: "hello", limits: { noteMax: this.noteMax } });
  }

  /** A client went away: forget every watch it held. */
  leave(client: HubClient): void {
    for (const id of this.#of.get(client) ?? []) this.#unwatch(client, id);
    this.#of.delete(client);
  }

  /** Connected clients (the health endpoint reports it). */
  get clients(): number {
    return this.#of.size;
  }

  /** How many clients watch a note (tests, diagnostics). */
  watchers(id: string): number {
    return this.#watch.get(id)?.size ?? 0;
  }

  handle(client: HubClient, raw: string): void {
    let msg: HubIn;
    try {
      msg = JSON.parse(raw) as HubIn;
    } catch {
      client.send({ t: "error", error: "not JSON" });
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "ping") {
      client.send({ t: "pong" });
      return;
    }
    if (msg.t === "note.watch" || msg.t === "note.unwatch" || msg.t === "note.save") {
      const req = msg.t === "note.save" && Number.isInteger(msg.req) ? msg.req : undefined;
      if (typeof msg.id !== "string" || !NOTE_ID.test(msg.id)) {
        client.send({ t: "error", req, id: typeof msg.id === "string" ? msg.id : undefined, error: "invalid note id" });
        return;
      }
      if (msg.t === "note.watch") return this.#watchNote(client, msg.id);
      if (msg.t === "note.unwatch") return this.#unwatch(client, msg.id);
      return this.#save(client, msg, req);
    }
    client.send({ t: "error", error: `unknown message ${String((msg as { t?: unknown }).t)}` });
  }

  /**
   * A note changed outside the hub (the REST endpoint, a deleted session): push it to its watchers.
   * `except` is the client that caused it, which already has its answer.
   */
  noteChanged(note: Note, except?: HubClient): void {
    for (const c of this.#watch.get(note.id) ?? []) if (c !== except) c.send({ t: "note", note });
  }

  #watchNote(client: HubClient, id: string): void {
    let set = this.#watch.get(id);
    if (!set) this.#watch.set(id, (set = new Set()));
    set.add(client);
    (this.#of.get(client) ?? this.#of.set(client, new Set()).get(client)!).add(id);
    try {
      client.send({ t: "note", note: this.notes.get(id) });
    } catch (error) {
      client.send({ t: "error", id, error: `could not read the note: ${(error as Error).message}` });
    }
  }

  #unwatch(client: HubClient, id: string): void {
    const set = this.#watch.get(id);
    set?.delete(client);
    if (set && !set.size) this.#watch.delete(id);
    this.#of.get(client)?.delete(id);
  }

  #save(client: HubClient, msg: Extract<HubIn, { t: "note.save" }>, req: number | undefined): void {
    if (req === undefined) {
      client.send({ t: "error", id: msg.id, error: "a save needs a request number" });
      return;
    }
    if (typeof msg.body !== "string") {
      client.send({ t: "error", req, id: msg.id, error: "body must be a string" });
      return;
    }
    if (msg.body.length > this.noteMax) {
      client.send({ t: "error", req, id: msg.id, error: `a note can hold at most ${this.noteMax.toLocaleString("en")} characters` });
      return;
    }
    let result: SaveNoteResult;
    try {
      result = this.notes.save(msg.id, msg.body, typeof msg.base === "number" ? msg.base : undefined);
    } catch (error) {
      client.send({ t: "error", req, id: msg.id, error: `could not save: ${(error as Error).message}` });
      return;
    }
    if (!result.ok) {
      client.send({ t: "note.conflict", req, current: result.conflict });
      return;
    }
    client.send({ t: "note.saved", req, note: result.note });
    this.noteChanged(result.note, client);
  }
}
