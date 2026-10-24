/**
 * The work queue behind the web app's one chat.
 *
 * The chat's agent is a DISPATCHER: it has no shell, it turns each request into a well-written
 * task and queues it (`task_create`), or redirects a task already in flight (`task_redirect`).
 * Each task runs as its own background mini session (a WORKER). At most `concurrency` workers run
 * at once (Settings; 1..300, default 300); the rest wait in FIFO order and start as slots free up.
 *
 * Tasks are rows in the sessions database (`queue_tasks`), so the queue survives a restart: a task
 * that was running when the server stopped goes back to the queue and continues its saved session.
 *
 * Relations: every task is compared with the others (TF-IDF cosine over title, description and
 * brief). A new request that is close to an active task is shown to the dispatcher as related, and
 * a `task_create` that duplicates an active task is refused with that task's id, so the dispatcher
 * redirects the existing worker instead of starting a near-copy. The edges (`related`,
 * `redirect`) are stored with the task: the graph the task panel and the RAG projection read.
 */
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type QueueStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface QueueNote {
  at: number;
  from: "worker" | "dispatcher" | "queue";
  text: string;
}

export interface QueueTask {
  id: string;
  seq: number;
  title: string;
  description: string;
  prompt: string;
  cwd: string;
  model: string;
  status: QueueStatus;
  sessionId: string;
  result: string;
  createdAt: number;
  startedAt: number;
  finishedAt: number;
  updatedAt: number;
  /** Redirect messages, in order (what the dispatcher added after the task was created). */
  redirects: string[];
  /** How many of `redirects` its worker has already been given (in its brief or as a message). */
  redirectsSeen: number;
  /** `redirects.length` when the current attempt started: the ones after it went by message. */
  redirectsAtStart: number;
  /** Tasks this one is close to (TF-IDF cosine), strongest first. */
  related: Array<{ id: string; score: number }>;
  notes: QueueNote[];
  /** How many times a worker was started for it (a redirect after it finished starts another). */
  attempts: number;
  /** Seconds the worker spent on it, summed over attempts. */
  workSeconds: number;
}

export const MAX_CONCURRENCY = 300;
export const DEFAULT_CONCURRENCY = 300;
/** At or above this similarity an ACTIVE task counts as the same work: create is refused. */
export const DUPLICATE_SCORE = 0.72;
/** At or above this a task is listed as related (a hint for the dispatcher, which decides). */
export const RELATED_SCORE = 0.15;
/** Relations look at the most recent tasks only: TF-IDF over the whole history is O(n) per request. */
const RELATED_WINDOW = 500;
const RESULT_MAX = 6000;
const PROMPT_MAX = 40_000;

export function clampConcurrency(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, n));
}

// ------------------------------------------------------------------ similarity

const STOP = new Set(
  "the and for with that this from into your you are was were will have has had not but all any can our out use using una uno unos unas los las del con por para que como esta este esto son ser sea hay sus mas pero sin sobre entre cada todo toda todos todas lo le les se su al el la de en y o a es un".split(" "),
);

export function terms(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function docOf(t: Pick<QueueTask, "title" | "description" | "prompt">): string {
  // The title and description say what the task IS; the brief adds detail.
  return `${t.title} ${t.description} ${t.prompt.slice(0, 4000)}`;
}

/** Cosine similarity of `query` against each document, TF-IDF weighted over the set. */
export function similarity(query: string, docs: string[]): number[] {
  const q = terms(query);
  const ds = docs.map(terms);
  const df = new Map<string, number>();
  for (const d of [q, ...ds]) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = ds.length + 1;
  const vec = (ts: string[]) => {
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, c] of tf) v.set(t, (1 + Math.log(c)) * Math.log(1 + n / (df.get(t) ?? 1)));
    return v;
  };
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
  const qv = vec(q);
  const qn = norm(qv);
  return ds.map((d) => {
    const dv = vec(d);
    let dot = 0;
    for (const [t, w] of qv) dot += w * (dv.get(t) ?? 0);
    return dot / (qn * norm(dv));
  });
}

// ------------------------------------------------------------------ storage

interface Row {
  id: string;
  seq: number;
  title: string;
  description: string;
  prompt: string;
  cwd: string;
  model: string;
  status: string;
  session_id: string;
  result: string;
  created_at: number;
  started_at: number;
  finished_at: number;
  updated_at: number;
  redirects: string;
  related: string;
  notes: string;
  attempts: number;
  work_seconds: number;
  redirects_seen: number;
  redirects_at_start: number;
}

function parseList<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function fromRow(r: Row): QueueTask {
  return {
    id: r.id,
    seq: r.seq,
    title: r.title,
    description: r.description,
    prompt: r.prompt,
    cwd: r.cwd,
    model: r.model,
    status: r.status as QueueStatus,
    sessionId: r.session_id,
    result: r.result,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
    redirects: parseList<string>(r.redirects),
    related: parseList<{ id: string; score: number }>(r.related),
    notes: parseList<QueueNote>(r.notes),
    attempts: r.attempts,
    workSeconds: r.work_seconds,
    redirectsSeen: r.redirects_seen ?? 0,
    redirectsAtStart: r.redirects_at_start ?? 0,
  };
}

export function ensureQueueSchema(db: Database): void {
  ensureTables(db);
  const cols = (db.query("PRAGMA table_info(queue_tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("redirects_seen")) db.exec("ALTER TABLE queue_tasks ADD COLUMN redirects_seen INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("redirects_at_start")) db.exec("ALTER TABLE queue_tasks ADD COLUMN redirects_at_start INTEGER NOT NULL DEFAULT 0");
}

function ensureTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_tasks (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      redirects TEXT NOT NULL DEFAULT '[]',
      related TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      work_seconds REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_tasks (status, seq);
    CREATE INDEX IF NOT EXISTS idx_queue_updated ON queue_tasks (updated_at);
    CREATE INDEX IF NOT EXISTS idx_queue_session ON queue_tasks (session_id);
    CREATE TABLE IF NOT EXISTS queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

// ------------------------------------------------------------------ the queue

/** What the queue needs from the session layer: start a worker, steer it, stop it. */
export interface WorkerHost {
  /** Start a worker session; returns its session id. */
  startWorker(task: QueueTask, prompt: string): Promise<string>;
  /** Continue an existing worker session with a message (a redirect, or a restart's resume). */
  continueWorker(sessionId: string, message: string): Promise<void>;
  /** Is the worker's agent process alive right now? */
  workerRunning(sessionId: string): boolean;
  /** Hand a message to a RUNNING worker (read before its next step). */
  messageWorker(sessionId: string, message: string): void;
  stopWorker(sessionId: string): void;
  /** The worker's final answer (or last words) once its run ended. */
  workerResult(sessionId: string): { text: string; ok: boolean };
  /** The task card the session itself shows (title + description). */
  saveCard(sessionId: string, title: string, description: string): void;
}

export interface TaskSpec {
  title?: unknown;
  description?: unknown;
  prompt?: unknown;
  /** One task without a prompt: short notes appended to the human's message. */
  notes?: unknown;
  cwd?: unknown;
}

export type CreateResult =
  | { ok: true; tasks: QueueTask[]; text: string }
  | { ok: false; text: string; duplicateOf?: string };

/** Text fields only: a number, object or array from a model is not coerced into "[object Object]". */
const clean = (v: unknown, max: number) => (typeof v === "string" ? v : "").replace(/\r\n/g, "\n").trim().slice(0, max);
const oneLine = (v: unknown, max: number) => clean(v, max * 2).replace(/\s+/g, " ").slice(0, max);

function expandCwd(raw: string, fallback: string): string {
  const p = raw.trim();
  if (!p) return fallback;
  const abs = p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
  } catch {
    // fall through
  }
  return fallback;
}

/**
 * The working directory a brief names, when the dispatcher left `cwd` empty: the first absolute
 * (or ~/) path in it that is an existing directory. A worker started in the right folder sees
 * its checker and its files at once instead of spending turns finding them.
 */
export function dirIn(text: string): string {
  for (const m of text.matchAll(/(?:^|[\s"'`(:=])((?:~|\/)[^\s"'`),;]*)/g)) {
    const p = m[1]!.replace(/[.:]+$/, "");
    const abs = p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
    try {
      if (abs.length > 1 && existsSync(abs) && statSync(abs).isDirectory()) return abs;
    } catch {
      // keep looking
    }
  }
  return "";
}

/**
 * Whether two working directories overlap (one is, or contains, the other). The home directory,
 * /tmp and / are where tasks land when nothing better was named: they overlap nothing.
 */
export function overlaps(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => (p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p);
  const x = norm(a), y = norm(b);
  // Broad defaults (where a task lands when no directory was named) never serialise anything:
  // otherwise every task without a directory would wait for every other one.
  const broad = (p: string) => p === "/" || p === norm(homedir()) || p === "/tmp";
  if (broad(x) || broad(y)) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

export class WorkQueue {
  #db: Database;
  #host: WorkerHost;
  #concurrency: () => number;
  #model: () => string;
  #defaultCwd: () => string;
  #onChange: () => void;
  /** Tasks being started right now (async spawn), so a burst of pumps never starts one twice. */
  #starting = new Set<string>();
  #pumping = false;
  #again = false;
  #exclusive: () => boolean;

  constructor(options: {
    db: Database;
    host: WorkerHost;
    concurrency: () => number;
    /** The model new workers run on: the chat's current model. */
    model: () => string;
    defaultCwd?: () => string;
    onChange?: () => void;
    /** One running task per directory tree (default on). */
    exclusiveDirs?: () => boolean;
  }) {
    this.#db = options.db;
    ensureQueueSchema(this.#db);
    this.#host = options.host;
    this.#concurrency = options.concurrency;
    this.#model = options.model;
    this.#defaultCwd = options.defaultCwd ?? (() => homedir());
    this.#onChange = options.onChange ?? (() => {});
    this.#exclusive = options.exclusiveDirs ?? (() => true);
  }

  // ---- reads

  list(): QueueTask[] {
    return (this.#db.query("SELECT * FROM queue_tasks ORDER BY seq DESC").all() as Row[]).map(fromRow);
  }

  /** Tasks updated at or after `since` (ms), oldest change first. Inclusive: a task saved in the
   * same millisecond as the last push is sent again rather than missed (merging is idempotent). */
  changedSince(since: number): QueueTask[] {
    return (this.#db.query("SELECT * FROM queue_tasks WHERE updated_at >= ? ORDER BY updated_at ASC").all(since) as Row[]).map(fromRow);
  }

  get(id: string): QueueTask | undefined {
    const row = this.#db.query("SELECT * FROM queue_tasks WHERE id = ?").get(id) as Row | null;
    return row ? fromRow(row) : undefined;
  }

  bySession(sessionId: string): QueueTask | undefined {
    if (!sessionId) return undefined;
    const row = this.#db.query("SELECT * FROM queue_tasks WHERE session_id = ?").get(sessionId) as Row | null;
    return row ? fromRow(row) : undefined;
  }

  counts(): Record<QueueStatus, number> {
    const out: Record<QueueStatus, number> = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };
    for (const r of this.#db.query("SELECT status, COUNT(*) AS n FROM queue_tasks GROUP BY status").all() as Array<{ status: QueueStatus; n: number }>) out[r.status] = r.n;
    return out;
  }

  meta(key: string): string {
    return (this.#db.query("SELECT value FROM queue_meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? "";
  }

  setMeta(key: string, value: string): void {
    this.#db.query("INSERT INTO queue_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- writes

  #save(t: QueueTask): void {
    t.updatedAt = Math.max(Date.now(), t.updatedAt + 1);
    this.#db
      .query(
        `INSERT INTO queue_tasks (id, seq, title, description, prompt, cwd, model, status, session_id, result, created_at, started_at, finished_at, updated_at, redirects, related, notes, attempts, work_seconds, redirects_seen, redirects_at_start)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, prompt=excluded.prompt, cwd=excluded.cwd, model=excluded.model,
           status=excluded.status, session_id=excluded.session_id, result=excluded.result, started_at=excluded.started_at, finished_at=excluded.finished_at,
           updated_at=excluded.updated_at, redirects=excluded.redirects, related=excluded.related, notes=excluded.notes, attempts=excluded.attempts, work_seconds=excluded.work_seconds, redirects_seen=excluded.redirects_seen, redirects_at_start=excluded.redirects_at_start`,
      )
      .run(
        t.id, t.seq, t.title, t.description, t.prompt, t.cwd, t.model, t.status, t.sessionId, t.result, t.createdAt, t.startedAt, t.finishedAt, t.updatedAt,
        JSON.stringify(t.redirects), JSON.stringify(t.related), JSON.stringify(t.notes.slice(-50)), t.attempts, t.workSeconds, t.redirectsSeen, t.redirectsAtStart,
      );
  }

  #nextSeq(): number {
    const row = this.#db.query("SELECT MAX(seq) AS m FROM queue_tasks").get() as { m: number | null };
    return (row.m ?? 0) + 1;
  }

  /** Active tasks related to `text`, strongest first (the dispatcher's hint, and the duplicate gate). */
  relatedTo(text: string, among: QueueTask[] = this.list()): Array<{ task: QueueTask; score: number }> {
    // Active tasks always count; past that, the most recent ones.
    if (among.length > RELATED_WINDOW) {
      const active = among.filter((t) => t.status === "queued" || t.status === "running");
      const recent = among.filter((t) => t.status !== "queued" && t.status !== "running").sort((a, b) => b.seq - a.seq).slice(0, Math.max(0, RELATED_WINDOW - active.length));
      among = active.concat(recent);
    }
    if (!among.length || !terms(text).length) return [];
    const scores = similarity(text, among.map(docOf));
    return among
      .map((task, i) => ({ task, score: Math.round(scores[i]! * 100) / 100 }))
      .filter((r) => r.score >= RELATED_SCORE)
      .sort((a, b) => b.score - a.score);
  }

  create(input: { spec?: TaskSpec & { tasks?: unknown; new_task?: unknown }; message?: string }): CreateResult {
    const spec = input.spec ?? {};
    const listed = Array.isArray(spec.tasks) ? spec.tasks : [];
    if (listed.some((t) => !t || typeof t !== "object" || Array.isArray(t))) return { ok: false, text: "every entry of `tasks` must be an object {title, description, prompt}" };
    const raw: TaskSpec[] = listed.length ? (listed as TaskSpec[]) : [spec];
    const force = spec.new_task === true;
    // `@MESSAGE` in a brief is the human's own message, pasted verbatim (the dispatcher need not copy it).
    const message = input.message ?? "";
    // One task without its own prompt: the human's message IS the brief, verbatim (every literal
    // intact, no output tokens spent copying it), plus the dispatcher's short notes.
    const single = raw.length === 1 && !!message.trim();
    const briefOf = (s: TaskSpec) => {
      const own = (typeof s.prompt === "string" ? s.prompt : "").trim().split("@MESSAGE").join(message);
      const notes = (typeof s.notes === "string" ? s.notes : "").trim();
      // A single task from a message: the message IS the brief. A prompt the dispatcher wrote
      // anyway is kept below it as its notes, never in place of the human's words.
      if (single) return [message, own && own !== message ? `Dispatcher notes:\n${own}` : "", notes].filter(Boolean).join("\n\n");
      return notes ? `${own}\n\n${notes}` : own;
    };
    const specs = raw.map((s) => ({
      title: oneLine(s.title, 80),
      description: oneLine(s.description, 400),
      prompt: clean(briefOf(s), PROMPT_MAX),
      cwd: typeof s.cwd === "string" ? s.cwd : "",
    }));
    const bad = specs.findIndex((s) => !s.prompt || !s.title);
    if (bad >= 0) return { ok: false, text: `task ${bad + 1} needs a title and a prompt (only a single task may omit its prompt)` };
    if (specs.length > 1 && raw.some((s) => !(typeof s.prompt === "string" ? s.prompt : "").trim())) return { ok: false, text: "with several tasks, each one needs its own prompt" };
    if (specs.length > 100) return { ok: false, text: "at most 100 tasks per call" };
    const existing = this.list();
    const active = existing.filter((t) => t.status === "queued" || t.status === "running");
    if (!force) {
      for (const s of specs) {
        const hit = this.relatedTo(`${s.title} ${s.description} ${s.prompt}`, active)[0];
        if (hit && hit.score >= DUPLICATE_SCORE) {
          return {
            ok: false,
            duplicateOf: hit.task.id,
            text: `Not created: "${s.title}" looks like active task ${hit.task.id} ("${hit.task.title}", ${hit.task.status}, similarity ${hit.score}). Use task_redirect on ${hit.task.id} to add this to it, or call task_create again with new_task: true if it is genuinely different work.`,
          };
        }
      }
    }
    const now = Date.now();
    const made: QueueTask[] = [];
    let seq = this.#nextSeq();
    for (const s of specs) {
      const related = this.relatedTo(`${s.title} ${s.description} ${s.prompt}`, existing.concat(made)).slice(0, 5).map((r) => ({ id: r.task.id, score: r.score }));
      const task: QueueTask = {
        id: `t${seq}`,
        seq,
        title: s.title,
        description: s.description,
        prompt: s.prompt,
        // Where the work happens: the dispatcher's cwd, else the brief's first real directory,
        // else (one task from one message) the human's own message's.
        cwd: expandCwd(s.cwd || dirIn(s.prompt) || (specs.length === 1 ? dirIn(message) : ""), this.#defaultCwd()),
        model: this.#model(),
        status: "queued",
        sessionId: "",
        result: "",
        createdAt: now,
        startedAt: 0,
        finishedAt: 0,
        updatedAt: now,
        redirects: [],
        related,
        notes: [],
        attempts: 0,
        workSeconds: 0,
        redirectsSeen: 0,
        redirectsAtStart: 0,
      };
      seq += 1;
      this.#save(task);
      made.push(task);
    }
    this.#changed();
    this.pump();
    const c = this.counts();
    const lines = made.map((t) => `${t.id} "${t.title}" ${this.get(t.id)?.status ?? "queued"}${t.related.length ? ` (related: ${t.related.map((r) => r.id).join(", ")})` : ""}`);
    return { ok: true, tasks: made, text: `${lines.join("\n")}\nQueue: ${c.running} running, ${c.queued} waiting (max ${this.#concurrency()} at once).` };
  }

  /** Add a correction or requirement to a task, wherever it is in its life. */
  async redirect(id: string, message: string): Promise<{ ok: boolean; text: string }> {
    const task = this.get(id.trim());
    const text = clean(message, 8000);
    if (!task) return { ok: false, text: `no task ${id}` };
    if (!text) return { ok: false, text: "a redirect needs a message" };
    task.redirects.push(text);
    task.notes.push({ at: Date.now(), from: "dispatcher", text: `redirected: ${text.slice(0, 300)}` });
    const note = `[redirect from the dispatcher] ${text}`;
    if (task.status === "queued") {
      // Not started: the brief simply grows.
      this.#save(task);
      this.#changed();
      return { ok: true, text: `${task.id} is still queued: the redirect is added to its brief.` };
    }
    if (task.status === "running" && task.sessionId && this.#host.workerRunning(task.sessionId)) {
      this.#host.messageWorker(task.sessionId, note);
      task.redirectsSeen = task.redirects.length;
      this.#save(task);
      this.#changed();
      return { ok: true, text: `${task.id} is running: its agent reads the redirect before its next step.` };
    }
    // Finished, failed, cancelled, or between runs: re-open it and queue it again. Its worker
    // continues its own session, so nothing it already did is redone.
    task.status = "queued";
    task.finishedAt = 0;
    this.#save(task);
    this.#changed();
    this.pump();
    return { ok: true, text: `${task.id} re-opened with the redirect and queued again.` };
  }

  cancel(id: string): { ok: boolean; text: string } {
    const task = this.get(id.trim());
    if (!task) return { ok: false, text: `no task ${id}` };
    if (task.status !== "queued" && task.status !== "running") return { ok: false, text: `${task.id} is already ${task.status}` };
    const wasRunning = task.status === "running";
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.notes.push({ at: Date.now(), from: "queue", text: "cancelled" });
    this.#save(task);
    if (wasRunning && task.sessionId) this.#host.stopWorker(task.sessionId);
    this.#changed();
    this.pump();
    return { ok: true, text: `${task.id} cancelled.` };
  }

  /** A worker's session was closed or deleted by hand: its active task is cancelled, saying why. */
  sessionGone(sessionId: string, why: string): void {
    const task = this.bySession(sessionId);
    if (!task || (task.status !== "running" && task.status !== "queued")) return;
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.result ||= `cancelled: ${why}`;
    task.notes.push({ at: Date.now(), from: "queue", text: `cancelled: ${why}` });
    this.#save(task);
    this.#changed();
    this.pump();
  }

  /** The worker's own card update: the description only (the title is the dispatcher's). */
  update(id: string, description: string): { ok: boolean; text: string } {
    const task = this.get(id);
    if (!task) return { ok: false, text: `no task ${id}` };
    const d = oneLine(description, 400);
    if (!d) return { ok: false, text: "description is empty" };
    task.description = d;
    this.#save(task);
    if (task.sessionId) this.#host.saveCard(task.sessionId, task.title, d);
    this.#changed();
    return { ok: true, text: "card updated" };
  }

  notify(id: string, message: string): { ok: boolean; text: string } {
    const task = this.get(id);
    if (!task) return { ok: false, text: `no task ${id}` };
    const text = clean(message, 2000);
    if (!text) return { ok: false, text: "message is empty" };
    task.notes.push({ at: Date.now(), from: "worker", text });
    this.#save(task);
    this.#changed();
    return { ok: true, text: "the dispatcher was notified" };
  }

  statusText(id?: string): string {
    if (id) {
      const t = this.get(id);
      if (!t) return `no task ${id}`;
      return [
        `${t.id} "${t.title}" — ${t.status}${t.attempts > 1 ? ` (run ${t.attempts})` : ""}`,
        `description: ${t.description}`,
        `cwd: ${t.cwd}`,
        t.redirects.length ? `redirects:\n${t.redirects.map((r) => `- ${r}`).join("\n")}` : "",
        t.notes.length ? `notes:\n${t.notes.slice(-8).map((n) => `- [${n.from}] ${n.text}`).join("\n")}` : "",
        t.result ? `result:\n${t.result}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    const all = this.list();
    if (!all.length) return "The queue is empty.";
    return all
      .slice(0, 60)
      .map((t) => `${t.id} [${t.status}] ${t.title} — ${t.description}${t.result ? ` | result: ${t.result.slice(0, 160).replace(/\s+/g, " ")}` : ""}`)
      .join("\n");
  }

  /**
   * The queue as the dispatcher sees it, appended to every message the human sends: active tasks,
   * what finished since its last turn, and which tasks the new message is close to.
   */
  queueState(message: string): string {
    const all = this.list();
    const since = Number(this.meta("dispatcher_seen") || 0);
    this.setMeta("dispatcher_seen", String(Date.now()));
    const active = all.filter((t) => t.status === "queued" || t.status === "running");
    const recent = all.filter((t) => t.finishedAt > since && (t.status === "done" || t.status === "error")).slice(0, 15);
    const notes = all.flatMap((t) => t.notes.filter((n) => n.from === "worker" && n.at > since).map((n) => `${t.id}: ${n.text.slice(0, 300)}`)).slice(0, 10);
    const related = this.relatedTo(message, all.filter((t) => t.status !== "cancelled")).slice(0, 5);
    const c = this.counts();
    const lines: string[] = [`concurrency ${this.#concurrency()} · running ${c.running} · queued ${c.queued} · done ${c.done} · error ${c.error}`];
    if (active.length) {
      lines.push("active:");
      const busy = active.filter((t) => t.status === "running");
      for (const t of active.slice(0, 40)) {
        const blocker = t.status === "queued" ? busy.find((b) => overlaps(b.cwd, t.cwd)) : undefined;
        lines.push(`- ${t.id} [${t.status}] ${t.title} — ${t.description} (in ${t.cwd})${blocker ? ` — waits for ${blocker.id} (same directory)` : ""}`);
      }
    }
    if (recent.length) {
      lines.push("finished since your last turn:");
      for (const t of recent) lines.push(`- ${t.id} [${t.status}] ${t.title} — ${t.result.slice(0, 200).replace(/\s+/g, " ")}`);
    }
    if (notes.length) lines.push("notes from workers:", ...notes.map((n) => `- ${n}`));
    if (related.length) {
      lines.push("closest tasks to this message (similarity):");
      for (const r of related) lines.push(`- ${r.task.id} [${r.task.status}] ${r.task.title} — in ${r.task.cwd} (${r.score})`);
    }
    return `\n\n<queue_state>\n${lines.join("\n")}\n</queue_state>`;
  }

  // ---- scheduling

  /** Start queued tasks while there is a free slot. Safe to call any time, from anywhere. */
  pump(): void {
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        let slots = this.#concurrency() - this.counts().running - this.#starting.size;
        if (slots <= 0) break;
        // Directories in use: two workers editing the same tree at once overwrite each other's
        // files (measured: two "rewrite calc.py" tasks, one clobbered the other and had to redo
        // its change). A task whose directory overlaps a running one waits; others go past it.
        const busy = (this.#db.query("SELECT cwd FROM queue_tasks WHERE status = 'running'").all() as Array<{ cwd: string }>).map((r) => r.cwd);
        const queued = this.#db.query("SELECT * FROM queue_tasks WHERE status = 'queued' ORDER BY seq ASC").all() as Row[];
        for (const row of queued) {
          if (slots <= 0) break;
          const task = fromRow(row);
          if (this.#starting.has(task.id)) continue;
          if (this.#exclusive() && busy.some((cwd) => overlaps(cwd, task.cwd))) continue;
          busy.push(task.cwd);
          slots -= 1;
          void this.#start(task);
        }
      } while (this.#again);
    } finally {
      this.#pumping = false;
    }
  }

  async #start(task: QueueTask): Promise<void> {
    // The row says `running` from here on, so `counts().running` already holds this slot:
    // `#starting` only guards against a second pump picking the same row before it is saved.
    this.#starting.add(task.id);
    task.status = "running";
    task.startedAt = Date.now();
    task.finishedAt = 0;
    task.attempts += 1;
    const unseenAtStart = task.redirects.slice(task.redirectsSeen);
    task.redirectsSeen = task.redirects.length;
    task.redirectsAtStart = task.redirects.length;
    this.#save(task);
    this.#starting.delete(task.id);
    this.#changed();
    let sessionId = task.sessionId;
    let failure = "";
    try {
      if (task.sessionId && task.attempts > 1) {
        // A re-opened task continues its own session: with the redirects it has not seen yet, or
        // (a restart cut it off) with a plain "carry on".
        const unseen = unseenAtStart;
        const message = unseen.length
          ? unseen.map((r) => `[redirect from the dispatcher] ${r}`).join("\n\n")
          : "[the server restarted while you worked] Continue the task where you left off and finish it.";
        await this.#host.continueWorker(task.sessionId, message);
      } else {
        const brief = task.redirects.length ? `${task.prompt}\n\nAdditional requirements added after the task was written:\n${task.redirects.map((r) => `- ${r}`).join("\n")}` : task.prompt;
        sessionId = await this.#host.startWorker(task, brief);
      }
    } catch (error) {
      failure = (error as Error).message;
    }
    // Re-read: while the worker was starting the task may have been cancelled or redirected, and
    // writing back the copy from before the await would undo that.
    const now = this.get(task.id);
    if (!now) return;
    if (failure) {
      if (now.status === "running") {
        now.status = "error";
        now.finishedAt = Date.now();
        now.result = `could not start the worker: ${failure}`;
        this.#save(now);
        this.#changed();
        this.pump(); // a failed start frees its slot at once
      }
      return;
    }
    if (sessionId && now.sessionId !== sessionId) {
      now.sessionId = sessionId;
      this.#save(now);
      this.#host.saveCard(sessionId, now.title, now.description);
    }
    if (now.status === "cancelled" && sessionId) {
      this.#host.stopWorker(sessionId); // cancelled while it was starting
    } else if (now.status === "running" && sessionId && !this.#host.workerRunning(sessionId)) {
      // The worker ended before its session id was on the row (a very fast run): settle it now.
      this.workerExited(sessionId, this.#host.workerResult(sessionId).ok ? "done" : "error");
    }
    this.#changed();
  }

  /** A worker's agent process ended: settle its task and hand the slot on. */
  workerExited(sessionId: string, status: "done" | "error" | "interrupted"): void {
    const task = this.bySession(sessionId);
    if (!task || task.status !== "running") return;
    const { text, ok } = this.#host.workerResult(sessionId);
    task.workSeconds += Math.max(0, (Date.now() - task.startedAt) / 1000);
    task.finishedAt = Date.now();
    task.result = text.slice(0, RESULT_MAX);
    task.status = status === "done" && ok ? "done" : "error";
    if (status === "interrupted") task.result ||= "interrupted";
    this.#save(task);
    this.#changed();
    this.pump();
  }

  /** Put a running task back in the queue (its worker continues its own session). */
  requeue(id: string, why: string): void {
    const task = this.get(id);
    if (!task) return;
    task.workSeconds += Math.max(0, (Date.now() - task.startedAt) / 1000);
    task.status = "queued";
    task.notes.push({ at: Date.now(), from: "queue", text: why });
    this.#save(task);
    this.#changed();
    this.pump();
  }

  /** On boot: work that was running when the server stopped goes back to the queue. */
  recover(): void {
    const stuck = this.#db.query("SELECT * FROM queue_tasks WHERE status = 'running'").all() as Row[];
    for (const row of stuck) {
      const task = fromRow(row);
      task.status = "queued";
      // Redirects handed to the dead worker's control file may never have been read: they are
      // given again with the resume (a worker reading one twice applies the same change twice,
      // which is harmless; one never read is a lost instruction).
      task.redirectsSeen = Math.min(task.redirectsSeen, task.redirectsAtStart);
      task.notes.push({ at: Date.now(), from: "queue", text: "the server restarted while this task ran: it continues its session" });
      this.#save(task);
    }
    this.pump();
  }

  /** Concurrency changed (Settings): more slots start more work at once. */
  resize(): void {
    this.pump();
  }

  #changed(): void {
    try {
      this.#onChange();
    } catch {
      // a listener's failure is not the queue's
    }
  }
}

/** The dispatcher config file (mini.yaml + dispatcher.yaml), found next to the bundled configs. */
export function configExists(dir: string, name: string): boolean {
  try {
    return existsSync(resolve(dir, name)) && readFileSync(resolve(dir, name), "utf8").length > 0;
  } catch {
    return false;
  }
}
