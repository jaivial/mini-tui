/**
 * The chat ↔ queue bridge (WA-3): turns conversational work-requests into
 * durable queue tasks and routes queue outcomes back to the originating thread.
 *
 * Contract (docs/chat-queue.md):
 *
 *  - Detection is model-proposed but bridge-validated: the session's reply may
 *    end with one machine-readable directive (`[[mini-queue: …]]`,
 *    `[[mini-followup: …]]`, `[[mini-status]]`). The bridge strips directives
 *    before the reply is ever sent — the chat stays conversational, and task
 *    creation never blocks the reply path: the durable intent is recorded in
 *    the shared channel DB before the inbox cursor advances, while the actual
 *    `queue put` (a background lane concern) runs in this bridge's sweep after
 *    the acknowledgement. A crash between ack and put is recovered by the sweep.
 *
 *  - Outcomes travel the other way on a second durable consumer: `queue events`
 *    is polled with its own cursor, every delivery intent is journalled in the
 *    outbox keyed by the event seq (dedupe across restarts), and an event is
 *    only delivered to the thread that created the task — a task with no chat
 *    mapping is never delivered anywhere. The cursor advances only past events
 *    that were skipped (unmapped) or provably delivered.
 *
 *  - Follow-up routing is deterministic code, never model discretion: an
 *    explicit task id wins; otherwise candidates are the open chat-created
 *    tasks of the binding's project, ranked by recency and vector similarity.
 *    One unambiguous candidate is amended (always via `queue amend
 *    --goal-version`); ambiguity asks in-thread; a follow-up pointing at
 *    another project is refused. Amending a running task relies on the queue's
 *    own fencing (the worker is interrupted), and the bridge retries it only
 *    after the runner reports the worker stopped.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { queueCommand, taskGraphPath } from "../mini/queue";
import type { Database } from "bun:sqlite";
import type { Inbound } from "./inbox";
import type { EvoSender } from "./evoSend";
import type { PendingRow } from "./consumer";

export type QueueDirectiveKind = "queue" | "followup" | "status";

export interface ParsedReply {
  text: string;
  queue?: string;
  followup?: string;
  status?: boolean;
}

/** `[[mini-queue: …]]` / `[[mini-followup: …]]` carry a value; `[[mini-status]]` may not. */
const DIRECTIVE = /\[\[mini-(queue|followup|status):?\s*([^\]]*)\]\]/g;
const MAX_DIRECTIVE_BYTES = 60_000;

/** Strip every directive; the last of each kind wins. Directives are data, and
 * a malformed or oversized one is dropped rather than sent to the chat. */
export function parseDirectives(replyText: string): ParsedReply {
  const out: ParsedReply = { text: "" };
  const chunks: string[] = [];
  let last = 0;
  for (const match of replyText.matchAll(DIRECTIVE)) {
    const kind = match[1] as QueueDirectiveKind;
    const value = (match[2] ?? "").trim();
    chunks.push(replyText.slice(last, match.index));
    last = match.index + match[0].length;
    if (Buffer.byteLength(value) > MAX_DIRECTIVE_BYTES) continue;
    if (kind === "status") out.status = true;
    else if (kind === "queue" && value) out.queue = value;
    else if (kind === "followup" && value) out.followup = value;
  }
  chunks.push(replyText.slice(last));
  out.text = chunks.join("").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

export interface QueueBridgeOptions {
  /** The shared channel store (same DB the inbox/ledger use). */
  db: Database;
  /** Single-account sender (WA-2). Absent when `senderFor` is given. */
  sender?: EvoSender;
  /** Per-account senders (WA-5): each note is delivered as the account that
   * owns its thread — never with another identity's instance token. */
  senderFor?: (account: string) => EvoSender | undefined;
  consumer: string;
  /** Optional read-only handle on the shared sessions store, for cwd lookup. */
  sessionsDb?: Database;
  /** Dedicated queue binary (task-graph feature); default is the resolved rust agent. */
  queueBin?: string;
  /** MiniLM directory for embeddings; absent → tasks stored without vectors. */
  embedDir?: string;
  sessionsDbPath?: string;
  /** Fallback working directory for queued tasks. */
  cwd?: string;
  pollMs?: number;
  /** Seconds to wait for an interrupted worker to report stopped before retry. */
  reconcileTimeoutS?: number;
  /** Milliseconds to hold after the interrupt event before retrying (the runner's
   * watchdog kills a fenced worker group within ~1 s; this is the settle margin). */
  reconcileSettleMs?: number;
  /** Milliseconds a claimable task may sit `pending` with no live worker anywhere
   * before the thread is told the truth about the lane. Defaults to 10 min: a live
   * idle lane claims within its restart interval, so silence this long is not a
   * busy queue, it is an absent one. */
  unclaimedAfterMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

interface TaskMapping {
  task: string;
  inbox_seq: number;
  channel: string;
  account: string;
  thread: string;
  session: string;
  project: string;
  cwd: string;
  goal: string;
  state: string;
  attempts: number;
}

interface OutboxRow {
  dedupe_key: string;
  task: string | null;
  thread: string;
  quoted_id: string | null;
  participant: string | null;
  /** Owning account ('' on pre-WA-5 rows): picks the sending identity. */
  account: string;
  text: string;
  state: string;
  attempts: number;
}

interface QueueEdge {
  task: string;
  dependency: string;
}

interface GraphNode {
  id: string;
  project: string;
  cwd: string;
  goal: string;
  status: string;
  owner: string | null;
  fence: number;
  lease_until: number | null;
  result: string | null;
  goal_version: number;
}

interface QueueEvent {
  seq: number;
  task: string;
  kind: string;
  goal_version: number;
  fence: number;
  status: string;
  created: number;
}

const OPEN_STATUSES = new Set(["pending", "running", "blocked", "interrupted"]);
/** Conservative unit-name shape: the value reaches an argv, never a shell. */
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/;

/** Real state of the lane unit, when the deployment names one. The watchdog never
 * infers supervision from this: it is a fact to put in the note, and a failed probe
 * is reported as unknown instead of guessed either way. */
async function laneUnitState(): Promise<{ unit: string; state: string }> {
  const unit = (process.env.MINITUI_QUEUE_LANE_UNIT ?? "mini-queue-lane").trim();
  if (!UNIT_NAME.test(unit)) return { unit: "mini-queue-lane", state: "unknown" };
  try {
    const child = Bun.spawn(["systemctl", "is-active", unit], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
    // `systemctl is-active` exits 0 when active and prints the state either way.
    const state = (await new Response(child.stdout).text()).trim();
    return { unit, state: /^[a-z]+$/.test(state) ? state : "unknown" };
  } catch {
    return { unit, state: "unknown" };
  }
}
/** Statuses whose change is worth telling the thread about. */
const REPORTED_STATUSES = new Set(["done", "blocked", "interrupted", "cancelled"]);
const EVENT_POLL_LIMIT = 100;
/** `chat-<seq>` ids sort by their numeric tail, never lexically. */
const taskRecency = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);

export class QueueBridge {
  private readonly db: Database;
  private readonly sender: EvoSender | undefined;
  private readonly senderFor: ((account: string) => EvoSender | undefined) | undefined;
  private readonly consumer: string;
  private readonly sessionsDb: Database | undefined;
  private readonly queueBin: string | undefined;
  private readonly embedDir: string | undefined;
  private readonly sessionsDbPath: string | undefined;
  private readonly fallbackCwd: string;
  private readonly pollMs: number;
  private readonly reconcileTimeoutS: number;
  private readonly reconcileSettleMs: number;
  private readonly unclaimedAfterMs: number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconciles = new Map<string, { startedAt: number; stoppedAt?: number }>();
  /** High-water mark for the reconciler's event scan: the tail, never a bounded head. */
  private reconcileSeq = 0;

  constructor(options: QueueBridgeOptions) {
    this.db = options.db;
    this.sender = options.sender;
    this.senderFor = options.senderFor;
    if (!this.sender && !this.senderFor) throw new Error("queue bridge needs a sender or senderFor");
    this.consumer = options.consumer;
    this.sessionsDb = options.sessionsDb;
    this.queueBin = options.queueBin;
    this.embedDir = options.embedDir;
    this.sessionsDbPath = options.sessionsDbPath;
    this.fallbackCwd = options.cwd ?? join(homedir(), "wa-assistant");
    this.pollMs = Math.max(1_000, options.pollMs ?? 5_000);
    this.reconcileTimeoutS = options.reconcileTimeoutS ?? 180;
    this.reconcileSettleMs = Math.max(0, options.reconcileSettleMs ?? 30_000);
    this.unclaimedAfterMs = Math.max(1_000, options.unclaimedAfterMs ?? 600_000);
    this.log = options.log ?? (() => {});
    this.db.exec(`CREATE TABLE IF NOT EXISTS channel_tasks(
      task TEXT PRIMARY KEY, inbox_seq INTEGER NOT NULL,
      channel TEXT NOT NULL, account TEXT NOT NULL, thread TEXT NOT NULL,
      session TEXT NOT NULL, project TEXT NOT NULL, cwd TEXT NOT NULL,
      goal TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_task_outbox(
      dedupe_key TEXT PRIMARY KEY, task TEXT, thread TEXT NOT NULL,
      quoted_id TEXT, participant TEXT, text TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_event_consumers(
      consumer TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0);`);
    // WA-5: the outbox remembers which account owns each note so delivery picks
    // that account's identity. Additive column on pre-existing stores.
    const outboxColumns = (this.db.query("PRAGMA table_info(channel_task_outbox)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!outboxColumns.includes("account")) this.db.exec(`ALTER TABLE channel_task_outbox ADD COLUMN account TEXT NOT NULL DEFAULT ''`);
    // One stall episode per task: set when the thread is told, cleared as soon as the
    // task leaves `pending`, so a later stall (claim → release → silent again) is a
    // NEW fact worth reporting rather than a repeat of the same one.
    const taskColumns = (this.db.query("PRAGMA table_info(channel_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!taskColumns.includes("stall_notified_at")) this.db.exec(`ALTER TABLE channel_tasks ADD COLUMN stall_notified_at INTEGER`);
  }

  // ── Reply planning (called synchronously inside the consumer turn path) ──

  /** Strip directives from the reply, append the immediate acknowledgement for
   * queued work, and return the deferred work to run after the cursor moves.
   * Nothing here talks to the network or the queue: planning stays cheap. */
  planReply(row: PendingRow, message: Inbound, replyText: string): { text: string; after?: () => Promise<void> } {
    const parsed = parseDirectives(replyText);
    const deferred: Array<() => void> = [];
    if (parsed.queue) {
      const task = `chat-${row.seq}`;
      // Durable intent BEFORE the reply is even sent: a crash after the ack
      // still leaves the sweep a row to recover.
      this.db.query(
        `INSERT INTO channel_tasks(task,inbox_seq,channel,account,thread,session,project,cwd,goal,state,attempts,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'creating',0,?10,?10)
         ON CONFLICT(task) DO NOTHING`,
      ).run(task, row.seq, row.channel, row.account, row.thread, row.session, row.project, this.cwdForSession(row.session), parsed.queue, Date.now());
      this.audit("plan_put", { seq: row.seq, session: row.session, project: row.project, thread: row.thread, task });
      parsed.text = `${parsed.text}\n\n(Apuntado en la cola como ${task}; te aviso aquí cuando termine.)`.trim();
      deferred.push(() => this.sweepCreatingTasks());
    }
    if (parsed.followup) {
      deferred.push(() => this.routeFollowup(row, message, parsed.followup as string));
    }
    if (parsed.status) {
      deferred.push(() => this.reportStatus(row, parsed.queue ? `chat-${row.seq}` : undefined));
    }
    return { text: parsed.text, after: deferred.length ? async () => { for (const step of deferred) await step(); } : undefined };
  }

  private cwdForSession(session: string): string {
    const source = this.sessionsDb ?? this.db;
    try {
      const row = source.query("SELECT cwd FROM sessions WHERE id=?1").get(session) as { cwd: string } | undefined;
      if (row?.cwd) return row.cwd;
    } catch {
      // Sessions store unreadable or empty: the consumer's working directory is the honest fallback.
    }
    return this.fallbackCwd;
  }

  // ── Task creation sweep (crash-safe `queue put`) ──

  /** Put every still-`creating` task; called after each planned reply and on
   * every poll tick, so an interrupted creation is retried until it lands.
   * The guard keeps the deferred-after-reply sweep and the poll tick from
   * double-putting the same intent concurrently. */
  private sweeping = false;
  async sweepCreatingTasks(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepCreatingTasksInner();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepCreatingTasksInner(): Promise<void> {
    const rows = this.db.query("SELECT * FROM channel_tasks WHERE state='creating' ORDER BY inbox_seq").all() as TaskMapping[];
    for (const mapping of rows) {
      try {
        await this.putTask(mapping);
        this.db.query("UPDATE channel_tasks SET state='queued',updated_at=?2 WHERE task=?1").run(mapping.task, Date.now());
        this.audit("put", { session: mapping.session, project: mapping.project, thread: mapping.thread, task: mapping.task });
      } catch (error) {
        this.db.query("UPDATE channel_tasks SET attempts=attempts+1,updated_at=?2 WHERE task=?1").run(mapping.task, Date.now());
        this.log("channel.queue.put_failed", { task: mapping.task, attempts: mapping.attempts + 1, error: String(error instanceof Error ? error.message : error).slice(0, 200) });
      }
    }
  }

  private async putTask(mapping: TaskMapping): Promise<void> {
    const dir = join(homedir(), ".local/share/mini-tui/queue-goals");
    mkdirSync(dir, { recursive: true });
    const goalFile = join(dir, `${mapping.task.replace(/[^A-Za-z0-9_.-]/g, "_")}.txt`);
    writeFileSync(goalFile, mapping.goal, { mode: 0o600 });
    const args = ["put", "--id", mapping.task, "--project", mapping.project, "--cwd", mapping.cwd, "--goal-file", goalFile];
    if (this.embedDir) args.push("--embed-dir", this.embedDir);
    // The embedding model may load cold: give put a wider window than the
    // default 10 s. Retrying after an uncertain put is safe here by
    // construction — this bridge is the only writer of `chat-*` ids and the
    // goal text is immutable for a given id.
    const result = await queueCommand(args, undefined, { bin: this.queueBin, timeoutMs: 120_000 });
    if (result.code !== 0) throw new Error(result.error.trim() || `queue put exit ${result.code}`);
  }

  // ── Follow-up routing (deterministic) ──

  private async routeFollowup(row: PendingRow, message: Inbound, note: string): Promise<void> {
    this.audit("followup_request", { seq: row.seq, session: row.session, project: row.project, thread: row.thread });
    let graph: GraphNode[];
    try {
      graph = await this.graph();
    } catch (error) {
      await this.enqueueChatNote(row, message, `followup-${row.seq}`, `No pude leer la cola para atender tu nota: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      return;
    }
    // 1. Explicit task id wins — but only ids that actually exist.
    const named = new Set<string>();
    for (const token of note.match(/[A-Za-z0-9_.:/-]+/g) ?? []) {
      if (graph.some((n) => n.id === token)) named.add(token);
    }
    if (named.size > 1) {
      await this.enqueueChatNote(row, message, `followup-${row.seq}`, `Mencionaste varias tareas (${[...named].join(", ")}). ¿A cuál añado tu nota?`);
      return;
    }
    if (named.size === 1) {
      const target = graph.find((n) => n.id === [...named][0]) as GraphNode;
      if (target.project !== row.project) {
        this.audit("followup_refused", { seq: row.seq, project: row.project, task: target.id, task_project: target.project, thread: row.thread });
        await this.enqueueChatNote(row, message, `followup-${row.seq}`, `La tarea ${target.id} pertenece al proyecto «${target.project}», no a «${row.project}». No la toco desde este chat; dímelo desde el chat de ese proyecto o pídeme cancelarla explícitamente.`);
        return;
      }
      await this.applyFollowup(row, message, target, note);
      return;
    }
    // 2. Candidates: open chat-created tasks of this binding's project,
    //    newest first (recency), then similarity when several remain.
    const mapped = new Set((this.db.query("SELECT task FROM channel_tasks").all() as Array<{ task: string }>).map((r) => r.task));
    const open = graph
      .filter((n) => n.project === row.project && mapped.has(n.id) && OPEN_STATUSES.has(n.status))
      .sort((a, b) => taskRecency(b.id) - taskRecency(a.id));
    if (open.length === 0) {
      await this.enqueueChatNote(row, message, `followup-${row.seq}`, `No hay tareas abiertas del proyecto «${row.project}» en la cola. Si es trabajo nuevo, pídemelo y lo encolo.`);
      return;
    }
    if (open.length === 1) {
      await this.applyFollowup(row, message, open[0] as GraphNode, note);
      return;
    }
    const ranked = await this.rankBySimilarity(note, open);
    const [top, second] = ranked;
    if (top && top.similarity >= 0.45 && (!second || top.similarity - second.similarity >= 0.05)) {
      await this.applyFollowup(row, message, top.node, note);
      return;
    }
    this.audit("followup_ambiguous", { seq: row.seq, project: row.project, candidates: ranked.length, thread: row.thread });
    const lines = ranked.slice(0, 5).map((c) => `• ${c.node.id} — ${c.node.goal.split("\n")[0].slice(0, 90)} (${c.node.status})`);
    await this.enqueueChatNote(row, message, `followup-${row.seq}`, `Tu nota podría encajar en varias tareas. ¿A cuál la añado?\n${lines.join("\n")}\nDime el identificador y la aplico.`);
  }

  /** Vector ranking when the open set alone cannot disambiguate. Never amends
   * on similarity alone: the caller still demands a clear margin. */
  private async rankBySimilarity(note: string, open: GraphNode[]): Promise<Array<{ node: GraphNode; similarity: number }>> {
    if (!this.embedDir) return open.map((node) => ({ node, similarity: -1 }));
    try {
      const dir = join(homedir(), ".local/share/mini-tui/queue-goals");
      mkdirSync(dir, { recursive: true });
      const queryFile = join(dir, `.followup-query-${Date.now()}.txt`);
      writeFileSync(queryFile, note, { mode: 0o600 });
      const result = await queueCommand(["search", "--query-file", queryFile, "--embed-dir", this.embedDir, "--limit", "100"], undefined, { bin: this.queueBin, timeoutMs: 120_000 });
      if (result.code !== 0) throw new Error(result.error.trim());
      const parsed = JSON.parse(result.output) as { results: Array<{ id: string; similarity: number }> };
      const byId = new Map(open.map((n) => [n.id, n]));
      const ranked: Array<{ node: GraphNode; similarity: number }> = [];
      for (const hit of parsed.results) {
        const node = byId.get(hit.id);
        if (node) ranked.push({ node, similarity: hit.similarity });
      }
      for (const node of open) if (!ranked.some((r) => r.node.id === node.id)) ranked.push({ node, similarity: -1 });
      return ranked;
    } catch (error) {
      this.log("channel.queue.search_failed", { error: String(error instanceof Error ? error.message : error).slice(0, 200) });
      // No similarity evidence → recency order only; the margin rule then asks instead of guessing.
      return open.map((node) => ({ node, similarity: -1 }));
    }
  }

  private async applyFollowup(row: PendingRow, message: Inbound, target: GraphNode, note: string): Promise<void> {
    const wasRunning = target.status === "running";
    const dir = join(homedir(), ".local/share/mini-tui/queue-goals");
    mkdirSync(dir, { recursive: true });
    const noteFile = join(dir, `.followup-${row.seq}.txt`);
    writeFileSync(noteFile, note, { mode: 0o600 });
    // Mutations are one attempt: an uncertain amend is surfaced, never blind-retried.
    const result = await queueCommand(["amend", "--id", target.id, "--goal-version", String(target.goal_version), "--goal-file", noteFile], undefined, { bin: this.queueBin });
    if (result.code !== 0) {
      this.audit("amend_refused", { seq: row.seq, project: row.project, task: target.id, thread: row.thread, error: result.error.trim().slice(0, 160) });
      await this.enqueueChatNote(row, message, `followup-${row.seq}`, `No pude actualizar ${target.id} (versión de objetivo desfasada o tarea cerrada). Su estado actual lo ves con «estado»; reintenta citándolo de nuevo.`);
      return;
    }
    this.audit("amend", { seq: row.seq, session: row.session, project: row.project, thread: row.thread, task: target.id, from_version: target.goal_version, was_running: wasRunning });
    if (wasRunning) {
      // The queue fenced the worker (interrupted, fence+1). Retry only after the
      // runner reports the old worker stopped — the reconciler polls for it.
      this.reconciles.set(target.id, { startedAt: Date.now() });
    }
    const v = target.goal_version + 1;
    await this.enqueueChatNote(
      row,
      message,
      `followup-${row.seq}`,
      `➕ Añadido a ${target.id} (objetivo v${v}): «${note.slice(0, 160)}»${wasRunning ? "\nEl worker estaba en marcha: lo interrumpo de forma controlada y relanzo con el objetivo actualizado." : ""}`,
    );
  }

  /** Fenced-interrupt reconciliation: wait for the runner's worker-stopped
   * event, then requeue. Gives up honestly into the thread after the timeout. */
  private async reconcileRunningAmendments(): Promise<void> {
    if (!this.reconciles.size) return;
    let events: QueueEvent[] = [];
    try {
      events = await this.readEvents(this.reconcileSeq, 200);
    } catch {
      return;
    }
    for (const event of events) this.reconcileSeq = Math.max(this.reconcileSeq, event.seq);
    for (const [task, state] of [...this.reconciles]) {
      // The store has no separate worker-stopped event: the amend's own
      // state_changed→interrupted is the signal, and the runner's watchdog
      // kills the fenced worker group within ~1 s of it. The settle window is
      // the honest margin before --reconciled yes attests the stop.
      const stopped = [...events].reverse().some((e) => e.task === task && e.kind === "state_changed" && (e.status === "blocked" || e.status === "interrupted"));
      if (stopped && state.stoppedAt === undefined) state.stoppedAt = Date.now();
      const settled = state.stoppedAt !== undefined && Date.now() - state.stoppedAt >= this.reconcileSettleMs;
      if (!settled && Date.now() - state.startedAt < this.reconcileTimeoutS * 1000) continue;
      this.reconciles.delete(task);
      if (!settled) {
        this.log("channel.queue.reconcile_timeout", { task });
        await this.deliverOperatorNote(task, `⏳ ${task}: el worker anterior no ha confirmado su parada en ${Math.round(this.reconcileTimeoutS / 60)} min. No lo relanzo automáticamente; requiere revisión manual.`);
        continue;
      }
      // The bridge only gets here after the runner's own worker-stopped event
      // was observed — that observation is exactly what --reconciled attests.
      const retry = await queueCommand(["retry", "--id", task, "--reconciled", "yes"], undefined, { bin: this.queueBin });
      this.audit("reconcile_retry", { task, ok: retry.code === 0 });
      if (retry.code !== 0) {
        await this.deliverOperatorNote(task, `⚠️ ${task}: el worker paró pero el relanzamiento falló: ${retry.error.trim().slice(0, 160)}`);
      }
    }
  }

  // ── Status reporting ──

  private async reportStatus(row: PendingRow, explicitTask: string | undefined): Promise<void> {
    let graph: GraphNode[];
    try {
      graph = await this.graph();
    } catch (error) {
      await this.enqueueChatNote(row, undefined, `status-${row.seq}`, `No pude leer la cola: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      return;
    }
    const nowS = Date.now() / 1000;
    const describe = (n: GraphNode): string => {
      const goal = n.goal.split("\n")[0].slice(0, 90);
      let line = `• ${n.id} [${n.status}] v${n.goal_version} — ${goal}`;
      if (n.status === "running" && n.owner) {
        // The store's clock is seconds-since-epoch (util::now), same as nowS.
        const fresh = n.lease_until !== null && n.lease_until > nowS;
        line += fresh ? ` (worker ${n.owner})` : ` (worker ${n.owner} — lease CADUCADA, worker presumiblemente muerto)`;
      }
      if (n.status === "done") line += " (con evidencia de cierre verificada)";
      if (n.status === "blocked" && n.result) line += ` — ${n.result.slice(0, 140)}`;
      return line;
    };
    let body: string;
    if (explicitTask) {
      const node = graph.find((n) => n.id === explicitTask);
      body = node ? describe(node) : `No conozco ninguna tarea «${explicitTask}».`;
    } else {
      const open = graph.filter((n) => OPEN_STATUSES.has(n.status));
      const recent = graph.filter((n) => !OPEN_STATUSES.has(n.status)).slice(-3);
      body = open.length ? open.map(describe).join("\n") : "No hay tareas abiertas en la cola.";
      if (recent.length) body += `\nRecientes:\n${recent.map(describe).join("\n")}`;
    }
    this.audit("status_report", { seq: row.seq, session: row.session, project: row.project, thread: row.thread, explicit: explicitTask });
    await this.enqueueChatNote(row, undefined, `status-${row.seq}`, body);
  }

  // ── Lane watchdog (A3b) ──

  /** A thread that was told "apuntado en la cola, te aviso cuando termine" must
   * learn the truth when the lane that was supposed to finish it is not there.
   *
   * The proof is the lease, not a guess about supervision: a lane holds a lease on
   * the task it is running, so "no task anywhere in the graph holds a fresh lease"
   * means no worker has been alive for the whole queue. A lane that is up and idle
   * claims a pending task within its restart interval (seconds), so a task this old
   * with nothing running anywhere is not a busy queue — it is an absent one.
   *
   * Deliberately NOT auto-starting the lane: those cards are real work with effects
   * off-box, and the lane burns quota. Say it in the thread and let Jaime decide. */
  private async watchStalledTasks(): Promise<void> {
    const cutoff = Date.now() - this.unclaimedAfterMs;
    const rows = this.db
      .query("SELECT task,updated_at,stall_notified_at FROM channel_tasks WHERE state='queued' AND updated_at<=?1")
      .all(cutoff) as Array<{ task: string; updated_at: number; stall_notified_at: number | null }>;
    if (!rows.length) return;
    let nodes: GraphNode[];
    let edges: QueueEdge[];
    try {
      ({ nodes, edges } = await this.graphWithEdges());
    } catch (error) {
      // An unreadable store is not evidence of a dead lane: stay quiet, retry next tick.
      this.log("channel.queue.lane_check_failed", { error: String(error instanceof Error ? error.message : error).slice(0, 200) });
      return;
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const nowS = Date.now() / 1000;
    const laneAlive = nodes.some((n) => n.status === "running" && n.lease_until !== null && n.lease_until > nowS);
    for (const row of rows) {
      const node = byId.get(row.task);
      // Left `pending` (claimed, blocked, done, cancelled): close the episode so a
      // later silence is reported once as the new fact it is.
      if (node && node.status !== "pending") {
        if (row.stall_notified_at !== null) this.db.query("UPDATE channel_tasks SET stall_notified_at=NULL WHERE task=?1").run(row.task);
        continue;
      }
      // Unknown to the store (put still in flight, or a store we cannot read yet):
      // silence here says nothing, so it proves nothing.
      if (!node || laneAlive || row.stall_notified_at !== null) continue;
      // Name the blocker, not its position: "waiting on chat-1 (blocked)" is
      // actionable in the thread, "waiting on the second dependency" is not.
      const waiting = edges
        .filter((e) => e.task === row.task)
        .map((e) => byId.get(e.dependency))
        .filter((dep): dep is GraphNode => !!dep && dep.status !== "done")
        .map((dep) => `${dep.id} (${dep.status})`);
      const mins = Math.max(1, Math.round((Date.now() - row.updated_at) / 60_000));
      const lane = await laneUnitState();
      const facts = [
        `⏳ ${row.task}: encolada hace ${mins} min y NADIE la ha reclamado.`,
        "No hay ningún worker vivo en la cola (ninguna tarea con lease activa), así que no va a terminar por sí sola.",
        waiting.length ? `Además espera por: ${waiting.join(", ")}.` : "",
        lane.state === "unknown" ? "" : `El carril ${lane.unit} está ${lane.state}.`,
        "Levántalo con: sudo systemctl start " + lane.unit,
        "No lo levanto yo: son tarjetas reales con efectos fuera de la caja y el carril consume cuota.",
      ].filter(Boolean);
      this.audit("lane_absent", { task: row.task, age_ms: Date.now() - row.updated_at, lane: lane.state });
      await this.deliverOperatorNote(row.task, facts.join("\n"));
      this.db.query("UPDATE channel_tasks SET stall_notified_at=?2 WHERE task=?1").run(row.task, Date.now());
    }
  }

  // ── Event consumer: queue outcomes back to the originating thread ──

  /** Re-arm fenced-interrupt reconciliation for mapped tasks the store still
   * shows interrupted (restart recovery); errors only delay the next tick. */
  private async rearmReconciles(): Promise<void> {
    try {
      const graph = await this.graph();
      const mapped = new Set(
        (this.db.query("SELECT task FROM channel_tasks WHERE channel='whatsapp'").all() as Array<{ task: string }>).map((r) => r.task),
      );
      for (const node of graph) {
        if (node.status === "interrupted" && mapped.has(node.id) && !this.reconciles.has(node.id)) {
          this.reconciles.set(node.id, { startedAt: Date.now() });
          this.log("channel.queue.reconcile_rearmed", { task: node.id });
        }
      }
    } catch {
      // The queue store may not exist yet; the next start/tick retries.
    }
  }

  start(): void {
    // A crash mid-reconcile loses the in-memory map: re-arm from the durable
    // mapping so an interrupted amendment is still retried after a restart.
    void this.rearmReconciles();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.sweepCreatingTasks();
      await this.deliverPendingOutbox();
      await this.consumeQueueEvents();
      await this.reconcileRunningAmendments();
      await this.watchStalledTasks();
    } catch (error) {
      this.log("channel.queue.tick_error", { error: String(error instanceof Error ? error.message : error).slice(0, 200) });
    }
    this.schedule();
  }

  private async consumeQueueEvents(): Promise<void> {
    const row = this.db.query("SELECT cursor FROM queue_event_consumers WHERE consumer=?1").get(this.consumer) as { cursor: number } | undefined;
    let cursor = row?.cursor ?? 0;
    // Results are read once per batch: `blocked` outcomes carry their reason.
    let results: Map<string, string> | null = null;
    try {
      for (;;) {
        const events = await this.readEvents(cursor, EVENT_POLL_LIMIT);
        if (!events.length) return;
        for (const event of events) {
          const mapping = this.db.query("SELECT * FROM channel_tasks WHERE task=?1").get(event.task) as TaskMapping | undefined;
          // No chat mapping → not this bridge's delivery: skip (cursor may pass).
          if (!mapping || mapping.channel !== "whatsapp") {
            cursor = event.seq;
            continue;
          }
          if (event.kind === "state_changed" && event.status === "blocked" && !results) {
            results = await this.resultMap();
          }
          const text = this.eventText(event, results);
          if (!text) {
            cursor = event.seq;
            continue;
          }
          const payload = this.inboxPayload(mapping.inbox_seq);
          const enqueued = this.enqueue({
            dedupe_key: `evt-${event.seq}`,
            task: event.task,
            thread: mapping.thread,
            quoted_id: payload?.messageId ?? null,
            participant: payload?.sender ?? null,
            account: mapping.account,
            text,
          });
          if (!enqueued) {
            // Already delivered and journalled: the cursor may pass.
            cursor = event.seq;
            continue;
          }
          const delivered = await this.deliverOutboxRow(`evt-${event.seq}`);
          if (!delivered) return; // cursor stays before this event; retried next tick
          cursor = event.seq;
        }
        if (events.length < EVENT_POLL_LIMIT) return;
      }
    } finally {
      // Persist however far we got: skipped, unmapped and delivered events are
      // all safely behind the cursor; the undelivered tail replays.
      this.db.query("INSERT INTO queue_event_consumers(consumer,cursor) VALUES(?1,?2) ON CONFLICT(consumer) DO UPDATE SET cursor=excluded.cursor").run(this.consumer, cursor);
    }
  }

  private async resultMap(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      for (const node of await this.graph()) {
        if (node.result) out.set(node.id, node.result.slice(0, 200));
      }
    } catch {
      // Result enrichment is best-effort; the status line still goes out.
    }
    return out;
  }

  private eventText(event: QueueEvent, results: Map<string, string> | null): string | null {
    if (event.kind === "goal_updated") return `✏️ ${event.task} actualizada a objetivo v${event.goal_version}.`;
    if (event.kind !== "state_changed" || !REPORTED_STATUSES.has(event.status)) return null;
    switch (event.status) {
      case "done":
        return `✅ ${event.task} terminada (con evidencia de cierre verificada).`;
      case "blocked": {
        const reason = results?.get(event.task) ?? null;
        return `⚠️ ${event.task} bloqueada${reason ? `: ${reason}` : "."}`;
      }
      case "interrupted":
        return `⏸️ ${event.task} interrumpida — worker detenido; se reconcilia antes de reintentar.`;
      default:
        return `🚫 ${event.task} cancelada.`;
    }
  }

  private inboxPayload(inboxSeq: number): { messageId: string; sender: string } | null {
    const row = this.db.query("SELECT payload FROM channel_inbox WHERE seq=?1").get(inboxSeq) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const message = JSON.parse(row.payload) as Inbound;
      return { messageId: message.messageId, sender: message.sender };
    } catch {
      return null;
    }
  }

  /** Journal a delivery intent; returns false when it already existed (dedupe by key). */
  private enqueue(row: { dedupe_key: string; task: string | null; thread: string; quoted_id: string | null; participant: string | null; account?: string; text: string }): boolean {
    try {
      this.db.query(
        `INSERT INTO channel_task_outbox(dedupe_key,task,thread,quoted_id,participant,account,text,state,attempts,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,'sending',0,?8)`,
      ).run(row.dedupe_key, row.task, row.thread, row.quoted_id, row.participant, row.account ?? "", row.text, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  /** Chat-originated notes (followup answers, status reports). Quoted to the
   * message that asked, or plain when the origin is unavailable. */
  private async enqueueChatNote(row: PendingRow, message: Inbound | undefined, key: string, text: string): Promise<void> {
    const dedupeKey = `msg-${row.seq}-${key}`;
    if (!this.enqueue({ dedupe_key: dedupeKey, task: null, thread: row.thread, quoted_id: message?.messageId ?? null, participant: message?.sender ?? null, account: row.account, text })) return;
    await this.deliverOutboxRow(dedupeKey);
  }

  private async deliverOperatorNote(task: string, text: string): Promise<void> {
    const mapping = this.db.query("SELECT * FROM channel_tasks WHERE task=?1").get(task) as TaskMapping | undefined;
    if (!mapping) return;
    const payload = this.inboxPayload(mapping.inbox_seq);
    const key = `op-${task}-${Date.now()}`;
    if (!this.enqueue({ dedupe_key: key, task, thread: mapping.thread, quoted_id: payload?.messageId ?? null, participant: payload?.sender ?? null, account: mapping.account, text })) return;
    await this.deliverOutboxRow(key);
  }

  /** Send every still-pending journalled message (restart recovery, retries). */
  private async deliverPendingOutbox(): Promise<void> {
    const rows = this.db.query("SELECT dedupe_key FROM channel_task_outbox WHERE state!='sent' ORDER BY updated_at LIMIT 20").all() as Array<{ dedupe_key: string }>;
    for (const { dedupe_key } of rows) await this.deliverOutboxRow(dedupe_key);
  }

  /** The identity that delivers this row: its owning account's sender, or the
   * single-account sender. An account with no configured sender fails loudly —
   * silent cross-identity delivery is exactly what WA-5 forbids. */
  private senderForRow(row: { account?: string }): EvoSender {
    if (this.senderFor) {
      const resolved = this.senderFor(row.account ?? "");
      if (!resolved) throw new Error(`no sender configured for account ${row.account || "(empty)"}`);
      return resolved;
    }
    return this.sender as EvoSender;
  }

  /** One delivery attempt with evidence-based uncertainty resolution, the same
   * discipline as the reply ledger: a non-201 never marks sent; text evidence
   * in the thread's recent outgoing history does. */
  private async deliverOutboxRow(dedupeKey: string): Promise<boolean> {
    const row = this.db.query("SELECT * FROM channel_task_outbox WHERE dedupe_key=?1").get(dedupeKey) as OutboxRow | undefined;
    if (!row || row.state === "sent") return true;
    const sender = this.senderForRow(row);
    if (row.attempts > 0) {
      // Second pass: settle, then look for the earlier attempt before resending.
      const delivered = await this.findDelivered(sender, row);
      if (delivered) return this.markSent(row, delivered);
    }
    const outcome = await sender.sendText({
      number: row.thread,
      text: row.text,
      ...(row.quoted_id ? { quoted: { id: row.quoted_id, remoteJid: row.thread, ...(row.participant ? { participant: row.participant } : {}) } } : {}),
    });
    if (outcome.kind === "sent") return this.markSent(row, outcome.replyId);
    this.db.query("UPDATE channel_task_outbox SET state='uncertain',attempts=attempts+1,updated_at=?2 WHERE dedupe_key=?1").run(dedupeKey, Date.now());
    this.log("channel.queue.deliver_uncertain", { key: dedupeKey, definitive: outcome.definitive || undefined, status: outcome.status, error: outcome.error.slice(0, 160) });
    return false;
  }

  private async findDelivered(sender: EvoSender, row: OutboxRow): Promise<string | null> {
    let recent: Array<{ id: string; text: string; ts: number | null }>;
    try {
      recent = await sender.recentOutgoing(row.thread, 50);
    } catch {
      return null; // history unreadable: assume nothing, keep retrying
    }
    if (recent.length >= 50 || recent.length === 0) return null;
    const nowS = Date.now() / 1000;
    for (const m of recent) {
      if (m.text === row.text && m.ts !== null && nowS - (m.ts > 1e12 ? m.ts / 1000 : m.ts) < 15 * 60) return m.id || null;
    }
    return null;
  }

  private markSent(row: OutboxRow, replyId: string): boolean {
    this.db.query("UPDATE channel_task_outbox SET state='sent',attempts=attempts+1,updated_at=?2 WHERE dedupe_key=?1").run(row.dedupe_key, Date.now());
    this.audit("deliver", { task: row.task ?? undefined, thread: row.thread, key: row.dedupe_key, replyId });
    return true;
  }

  // ── Queue reads ──

  private async graphWithEdges(): Promise<{ nodes: GraphNode[]; edges: QueueEdge[] }> {
    const result = await queueCommand(["graph-read"], undefined, { bin: this.queueBin });
    if (result.code !== 0) throw new Error(result.error.trim() || `graph-read exit ${result.code}`);
    const parsed = JSON.parse(result.output) as { nodes?: GraphNode[]; edges?: QueueEdge[] };
    return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
  }

  private async graph(): Promise<GraphNode[]> {
    return (await this.graphWithEdges()).nodes;
  }

  private async readEvents(after: number, limit: number): Promise<QueueEvent[]> {
    const result = await queueCommand(["events-read", "--after", String(after), "--limit", String(limit)], undefined, { bin: this.queueBin });
    if (result.code !== 0) throw new Error(result.error.trim() || `events-read exit ${result.code}`);
    return (JSON.parse(result.output) as { events: QueueEvent[] }).events;
  }

  private audit(action: string, fields: Record<string, unknown>): void {
    this.log("channel.queue.audit", { action, ...fields });
  }
}

/** Where the task graph lives (re-exported for the deployment tooling). */
export const defaultTaskGraphPath = taskGraphPath;
