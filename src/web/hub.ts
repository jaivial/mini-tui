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
import type { SessionPlan } from "../mini/plans";
import type { Note, SaveNoteResult, SessionTask } from "../sessions";
import type { OpenSpec, TermOut, Terminals } from "./terminals";
import type { SaveWorkspaceResult, Workspace } from "./workspace";

export type HubIn =
  | { t: "ping" }
  | { t: "note.watch"; id: string }
  | { t: "note.unwatch"; id: string }
  | { t: "note.save"; id: string; body: string; base?: number; req: number }
  /** The task board (every session's task card, filled by the agents): watch it for live pushes. */
  | { t: "tasks.watch" }
  | { t: "tasks.unwatch" }
  /** The DAG of every session running a plan (`subagents/plan.json`): watch it for live pushes. */
  | { t: "plan.watch" }
  | { t: "plan.unwatch" }
  /** The shared workspace (windows, panes, sidebar): watch it, or save a new version of it. */
  | { t: "ws.watch" }
  | { t: "ws.save"; doc: unknown; base: number; req: number }
  /** Attach to (or start) terminal `id` for `session`, at the viewer's size. */
  | { t: "term.open"; id: string; session?: string; cols: number; rows: number }
  | { t: "term.input"; id: string; data: string }
  | { t: "term.resize"; id: string; cols: number; rows: number }
  /** Stop watching (the shell keeps running for a while, so a reload finds it). */
  | { t: "term.detach"; id: string }
  /** End the shell now. */
  | { t: "term.close"; id: string };

export type HubOut =
  | { t: "pong" }
  | { t: "hello"; limits: { noteMax: number } }
  /** A watched note's value: sent on watch, and whenever it changes elsewhere. */
  | { t: "note"; note: Note }
  | { t: "note.saved"; req: number; note: Note }
  | { t: "note.conflict"; req: number; current: Note }
  /** The whole task board: sent on watch, and whenever an agent writes a card anywhere. */
  | { t: "tasks"; tasks: SessionTask[] }
  /** Every session's DAG plan: sent on watch, and whenever a hub updates its plan.json. */
  | { t: "plan"; plans: SessionPlan[] }
  /** The workspace's value: sent on watch, and whenever another tab or device changes it. */
  | { t: "ws"; workspace: Workspace }
  | { t: "ws.saved"; req: number; version: number }
  | { t: "ws.conflict"; req: number; current: Workspace }
  | { t: "error"; req?: number; id?: string; error: string }
  | TermOut;

export interface HubClient {
  /** False when the message could not be delivered. */
  send(msg: HubOut): boolean;
}

export interface NoteStore {
  get(id: string): Note;
  save(id: string, body: string, base?: number): SaveNoteResult;
}

export interface TaskSource {
  /** Every session that has a task card, newest first. */
  list(): SessionTask[];
}

export interface PlanSource {
  /** Every session whose hub has a plan right now. */
  plans(): SessionPlan[];
}

export interface WorkspaceSource {
  get(): Workspace;
  save(doc: unknown, base: number): SaveWorkspaceResult;
  max: number;
}

const NOTE_ID = /^[\w.-]{1,128}$/;

export class Hub {
  #watch = new Map<string, Set<HubClient>>();
  #of = new Map<HubClient, Set<string>>();
  /** Clients watching the shared workspace. */
  #ws = new Set<HubClient>();
  /** Where the shared workspace is kept; absent in tests that only exercise notes. */
  workspace?: WorkspaceSource;
  /** Clients watching the task board, and the board they were last sent (a push carries changes only). */
  #taskWatch = new Set<HubClient>();
  #taskSent = "";
  /** Where the task board is kept; absent in tests that only exercise notes. */
  tasks?: TaskSource;
  /** Clients watching the DAG plans, and what they were last sent (a push carries changes only). */
  #planWatch = new Set<HubClient>();
  #planSent = "";
  /** Where the DAG plans are kept; absent where nothing plans. */
  plans?: PlanSource;

  constructor(
    private readonly notes: NoteStore,
    private readonly noteMax: number,
    /** Where a session's terminal starts: its folder here, or an ssh session to its host. */
    private readonly terminals?: { manager: Terminals; spec: (session: string | undefined) => Omit<OpenSpec, "cols" | "rows"> },
  ) {}

  /** A client connected: tell it the limits it must respect. */
  join(client: HubClient): void {
    this.#of.set(client, new Set());
    client.send({ t: "hello", limits: { noteMax: this.noteMax } });
  }

  /** A client went away: forget every watch it held. */
  leave(client: HubClient): void {
    this.terminals?.manager.detach(client as never);
    this.#ws.delete(client);
    this.#taskWatch.delete(client);
    this.#planWatch.delete(client);
    for (const id of this.#of.get(client) ?? []) this.#unwatch(client, id);
    this.#of.delete(client);
  }

  /** Connected clients (the health endpoint reports it). */
  get clients(): number {
    return this.#of.size;
  }

  /** How many clients watch the task board (the server only polls the cards while anyone does). */
  get taskWatchers(): number {
    return this.#taskWatch.size;
  }

  /** How many clients watch the DAG plans (the server only reads plan.json while anyone does). */
  get planWatchers(): number {
    return this.#planWatch.size;
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
    if (typeof msg.t === "string" && msg.t.startsWith("term.")) return this.#term(client, msg);
    if (msg.t === "ws.watch" || msg.t === "ws.save") return this.#workspace(client, msg);
    if (msg.t === "tasks.watch" || msg.t === "tasks.unwatch") return this.#taskBoard(client, msg.t === "tasks.watch");
    if (msg.t === "plan.watch" || msg.t === "plan.unwatch") return this.#planBoard(client, msg.t === "plan.watch");
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

  /**
   * The task board changed outside the hub (an agent ran `mini-tui tasks set`, a session was
   * deleted): push it to whoever is watching. The board is small and whole: every push carries
   * all of it, and an unchanged board is not re-sent (the poll that noticed decides that).
   */
  tasksChanged(): void {
    const source = this.tasks;
    if (!source || !this.#taskWatch.size) return;
    let tasks: SessionTask[];
    try {
      tasks = source.list();
    } catch {
      return; // a busy database is checked again on the next poll
    }
    const wire = JSON.stringify(tasks);
    if (wire === this.#taskSent) return;
    this.#taskSent = wire;
    for (const c of this.#taskWatch) c.send({ t: "tasks", tasks });
  }

  /**
   * The DAG plans changed outside the hub (a hub wrote its plan.json): push them to whoever is
   * watching. Like the task board, the list is small and whole, and an unchanged one is not
   * re-sent (the poll that noticed decides that).
   */
  plansChanged(): void {
    const source = this.plans;
    if (!source || !this.#planWatch.size) return;
    let plans: SessionPlan[];
    try {
      plans = source.plans();
    } catch {
      return; // a busy disk is checked again on the next poll
    }
    const wire = JSON.stringify(plans);
    if (wire === this.#planSent) return;
    this.#planSent = wire;
    for (const c of this.#planWatch) c.send({ t: "plan", plans });
  }

  #planBoard(client: HubClient, watch: boolean): void {
    const source = this.plans;
    if (!source) return void client.send({ t: "error", error: "no server session runs a plan" });
    if (!watch) return void this.#planWatch.delete(client);
    this.#planWatch.add(client);
    try {
      const plans = source.plans();
      this.#planSent = JSON.stringify(plans);
      client.send({ t: "plan", plans });
    } catch (error) {
      client.send({ t: "error", error: `could not read the plans: ${(error as Error).message}` });
    }
  }

  #taskBoard(client: HubClient, watch: boolean): void {
    const source = this.tasks;
    if (!source) return void client.send({ t: "error", error: "the task board is not available on this server" });
    if (!watch) return void this.#taskWatch.delete(client);
    this.#taskWatch.add(client);
    try {
      const tasks = source.list();
      this.#taskSent = JSON.stringify(tasks);
      client.send({ t: "tasks", tasks });
    } catch (error) {
      client.send({ t: "error", error: `could not read the task board: ${(error as Error).message}` });
    }
  }

  #workspace(client: HubClient, msg: Extract<HubIn, { t: "ws.watch" | "ws.save" }>): void {
    const ws = this.workspace;
    if (!ws) return void client.send({ t: "error", error: "the shared workspace is not available on this server" });
    if (msg.t === "ws.watch") {
      this.#ws.add(client);
      return void client.send({ t: "ws", workspace: ws.get() });
    }
    const req = Number.isInteger(msg.req) ? msg.req : undefined;
    if (req === undefined) return void client.send({ t: "error", error: "a save needs a request number" });
    if (typeof msg.base !== "number" || msg.doc === undefined) return void client.send({ t: "error", req, error: "a save needs a doc and its base version" });
    if (JSON.stringify(msg.doc).length > ws.max) return void client.send({ t: "error", req, error: "the workspace is too large" });
    let result: SaveWorkspaceResult;
    try {
      result = ws.save(msg.doc, msg.base);
    } catch (error) {
      return void client.send({ t: "error", req, error: `could not save the workspace: ${(error as Error).message}` });
    }
    if (!result.ok) return void client.send({ t: "ws.conflict", req, current: result.current });
    client.send({ t: "ws.saved", req, version: result.workspace.version });
    // Everyone else watching gets the new layout now; the sender already has it.
    for (const c of this.#ws) if (c !== client) c.send({ t: "ws", workspace: result.workspace });
  }

  #term(client: HubClient, msg: HubIn): void {
    const tm = this.terminals;
    const id = (msg as { id?: unknown }).id;
    if (!tm) return void client.send({ t: "error", error: "terminals are not available on this server" });
    if (typeof id !== "string" || !/^[\w.-]{1,128}$/.test(id)) return void client.send({ t: "error", error: "invalid terminal id" });
    const viewer = client as never;
    if (msg.t === "term.open") {
      const session = typeof msg.session === "string" ? msg.session : undefined;
      let spec: Omit<OpenSpec, "cols" | "rows">;
      try {
        spec = tm.spec(session);
      } catch (error) {
        return void client.send({ t: "error", id, error: (error as Error).message });
      }
      tm.manager.open(viewer, id, { ...spec, cols: Number(msg.cols), rows: Number(msg.rows) });
    } else if (msg.t === "term.input") tm.manager.input(id, msg.data);
    else if (msg.t === "term.resize") tm.manager.resize(id, Number(msg.cols), Number(msg.rows));
    else if (msg.t === "term.detach") tm.manager.detach(viewer, id);
    else if (msg.t === "term.close") tm.manager.kill(id);
    else client.send({ t: "error", id, error: `unknown message ${String(msg.t)}` });
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
