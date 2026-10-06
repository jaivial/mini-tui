import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RunEvent, RunInfo, TrajectoryMessage } from "./traj/schema";

export interface SessionRecord {
  id: string;
  title: string;
  cwd: string;
  model: string;
  task: string;
  created_at: number;
  updated_at: number;
  api_calls: number;
  cost: number;
  exit_status: string;
  events_json: string;
  info_json: string;
  messages_json: string;
  /** The session whose agent started this one as a subagent ('' for a top-level session). */
  parent_id?: string;
}

export const DEFAULT_DB_PATH = process.env.MINITUI_DB_PATH ?? join(homedir(), ".config", "mini-tui", "sessions.db");
/** Same path, resolved at call time (see `settingsPath`): a manager built after the env changed must follow it. */
export function defaultDbPath(): string {
  return process.env.MINITUI_DB_PATH ?? join(homedir(), ".config", "mini-tui", "sessions.db");
}
export const PAGE_SIZE = 8;
/** Fallback title: the first prompt, trimmed to this many characters. */
export const TITLE_MAX_CHARS = 48;

export function fallbackTitle(task: string): string {
  const clean = task.replace(/\s+/g, " ").trim();
  return clean.length <= TITLE_MAX_CHARS ? clean : `${clean.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

export function openDb(path: string = DEFAULT_DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  configureConcurrency(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      api_calls INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      exit_status TEXT NOT NULL DEFAULT '',
      events_json TEXT NOT NULL DEFAULT '[]',
      info_json TEXT NOT NULL DEFAULT '{}',
      messages_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions (cwd, updated_at DESC);
    -- Free-form notes the web app keeps beside a session. A table of its own, not a column: a session
    -- listing never reads them, and a remote session (which has no row until it finishes) can have some.
    CREATE TABLE IF NOT EXISTS notes (
      session_id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- The task card agents fill for every session they run in: a title, an
    -- AI-written description and the to-dos sorted into done / pending / what is left. Its own table
    -- for the same reason as notes: a session listing never reads it, and a remote session can have
    -- one before it has a row here.
    CREATE TABLE IF NOT EXISTS session_tasks (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      todos TEXT NOT NULL DEFAULT '{"done":[],"pending":[],"left":[]}',
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]'");
  } catch {
    // column already exists (databases created before --resume support)
  }
  try {
    // A subagent's session points at the session whose agent started it.
    db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT NOT NULL DEFAULT ''");
  } catch {
    // column already exists
  }
  // The agent each UI is running for a session right now, so another UI (the web app, a second
  // terminal) can follow that same agent and talk to it instead of forking the conversation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_runs (
      session_id TEXT PRIMARY KEY,
      traj_path TEXT NOT NULL,
      control_path TEXT NOT NULL,
      pid INTEGER NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL
    );
  `);
  return db;
}

/**
 * Several processes share this file: every terminal UI, the web server, headless runs. A TUI saves
 * a multi-MB transcript every few seconds, and in the default rollback-journal mode that write
 * locks the whole file, so any other process reading at that moment failed at once with
 * "database is locked" (the web app answered 500 and dropped the session it was opening). In WAL
 * mode readers never wait for a writer; the busy timeout covers two writers meeting.
 */
function configureConcurrency(db: Database): void {
  try {
    db.exec("PRAGMA busy_timeout = 5000");
  } catch {
    // best-effort
  }
  try {
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
    if (row?.journal_mode !== "wal") db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // another process holds the file right now: the next open switches it
  }
}

export function createSession(
  db: Database,
  record: { id: string; cwd: string; model: string; task: string; title?: string },
): SessionRecord {
  const now = Date.now();
  const title = record.title ?? fallbackTitle(record.task);
  db.query(
    `INSERT OR REPLACE INTO sessions (id, title, cwd, model, task, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(record.id, title, record.cwd, record.model, record.task, now, now);
  return getSession(db, record.id) as SessionRecord;
}

export function updateSession(db: Database, id: string, patch: Partial<SessionRecord>): void {
  const fields: Array<[string, unknown]> = [];
  if (patch.title !== undefined) fields.push(["title", patch.title]);
  if (patch.model !== undefined) fields.push(["model", patch.model]);
  if (patch.api_calls !== undefined) fields.push(["api_calls", patch.api_calls]);
  if (patch.cost !== undefined) fields.push(["cost", patch.cost]);
  if (patch.exit_status !== undefined) fields.push(["exit_status", patch.exit_status]);
  if (patch.events_json !== undefined) fields.push(["events_json", patch.events_json]);
  if (patch.info_json !== undefined) fields.push(["info_json", patch.info_json]);
  if (patch.messages_json !== undefined) fields.push(["messages_json", patch.messages_json]);
  if (fields.length === 0) return;
  fields.push(["updated_at", Date.now()]);
  const sets = fields.map(([name]) => `${name} = ?`).join(", ");
  const values: Array<string | number> = fields.map(([, value]) => value as string | number);
  values.push(id);
  db.query(`UPDATE sessions SET ${sets} WHERE id = ?`).run(...(values as [string | number, ...Array<string | number>]));
}

export function saveTranscript(
  db: Database,
  id: string,
  events: RunEvent[],
  info: RunInfo,
  messages: TrajectoryMessage[] = [],
): void {
  updateSession(db, id, {
    events_json: JSON.stringify(events),
    info_json: JSON.stringify(info),
    messages_json: JSON.stringify(messages),
    api_calls: info.apiCalls,
    cost: info.cost,
    exit_status: info.exitStatus ?? "",
  });
}

/**
 * Write the raw conversation so `mini --resume <path>` can reload it as context.
 * Returns the file path (stable per session, rewritten on every save).
 */
export function writeResumeFile(id: string, messages: TrajectoryMessage[]): string {
  const dir = process.env.MINITUI_RESUME_DIR ?? join(homedir(), ".config", "mini-tui", "resume");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify({ messages })}\n`);
  return path;
}

export function getSession(db: Database, id: string): SessionRecord | null {
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | undefined) ?? null;
}

/** An agent process some UI is running for a session (see `live_runs`). */
export interface LiveRunRecord {
  session_id: string;
  traj_path: string;
  control_path: string;
  pid: number;
  /** Who started it ("tui", "web"): informational. */
  owner: string;
  started_at: number;
}

/** Record the agent now running for a session (replacing any earlier one). */
export function registerLiveRun(db: Database, run: Omit<LiveRunRecord, "started_at"> & { started_at?: number }): void {
  db.query(
    `INSERT OR REPLACE INTO live_runs (session_id, traj_path, control_path, pid, owner, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(run.session_id, run.traj_path, run.control_path, run.pid, run.owner, run.started_at ?? Date.now());
}

/** Forget a session's live run, only if it is still this one (a newer run may have replaced it). */
export function clearLiveRun(db: Database, sessionId: string, trajPath: string): void {
  db.query("DELETE FROM live_runs WHERE session_id = ? AND traj_path = ?").run(sessionId, trajPath);
}

export function getLiveRun(db: Database, sessionId: string): LiveRunRecord | null {
  return (db.query("SELECT * FROM live_runs WHERE session_id = ?").get(sessionId) as LiveRunRecord | undefined) ?? null;
}

/**
 * The session whose agent owns this control file. It is how `mini-tui tasks set` finds out which
 * session it is filling a card for when nothing named one: every agent runs with its control file
 * in the environment (`MSWEA_CONTROL_FILE`), and every UI registers it here while the agent lives.
 */
export function findLiveRunByControl(db: Database, controlPath: string): LiveRunRecord | null {
  return (db.query("SELECT * FROM live_runs WHERE control_path = ?").get(controlPath) as LiveRunRecord | undefined) ?? null;
}

/**
 * Record a subagent as a session of its own, under its parent: same history, `/resume` and web
 * sidebar as any other session. Idempotent (the id is derived from the parent and the name).
 */
export function upsertSubagentSession(
  db: Database,
  record: { id: string; parentId: string; title: string; cwd: string; model: string; task: string },
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO sessions (id, title, cwd, model, task, created_at, updated_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET model = excluded.model, parent_id = excluded.parent_id`,
  ).run(record.id, record.title, record.cwd, record.model, record.task, now, now, record.parentId);
}

/** The subagent sessions a session started, oldest first. */
export function listSubagentSessions(db: Database, parentId: string): Array<{ id: string; title: string; exit_status: string; cost: number }> {
  return db
    .query("SELECT id, title, exit_status, cost FROM sessions WHERE parent_id = ? ORDER BY created_at")
    .all(parentId) as Array<{ id: string; title: string; exit_status: string; cost: number }>;
}

/** `updated_at` of each listed session: a cheap way to notice another process saved one. */
export function sessionStamps(db: Database, ids: string[]): Map<string, number> {
  const stamps = new Map<string, number>();
  if (!ids.length) return stamps;
  const rows = db
    .query(`SELECT id, updated_at FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as Array<{ id: string; updated_at: number }>;
  for (const row of rows) stamps.set(row.id, row.updated_at);
  return stamps;
}

/** The light columns: a listing never needs the (possibly 100+ MB) transcript blobs. */
const META_COLUMNS = "id, title, cwd, model, task, created_at, updated_at, api_calls, cost, exit_status";

/** One session for the read-only preview: everything but the raw `messages_json`. */
export function getSessionPreview(db: Database, id: string): SessionRecord | null {
  const row = db.query(`SELECT ${META_COLUMNS}, events_json, info_json FROM sessions WHERE id = ?`).get(id) as
    | Omit<SessionRecord, "messages_json">
    | undefined;
  return row ? { ...row, messages_json: "[]" } : null;
}

export function countSessions(db: Database, cwd: string, query: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM sessions WHERE cwd = ? AND (? = '' OR title LIKE ?)")
    .get(cwd, query, `%${query}%`) as { n: number };
  return row.n;
}

/**
 * Sessions started in `cwd`, title matching `query`, newest first, one page. Metadata only:
 * `events_json`/`info_json`/`messages_json` come back empty (`getSession`/`getSessionPreview`
 * load one row's transcript on demand) — `SELECT *` pulled every listed transcript into RAM.
 */
export function listSessions(db: Database, cwd: string, query: string, page: number): SessionRecord[] {
  const rows = db
    .query(
      `SELECT ${META_COLUMNS} FROM sessions
       WHERE cwd = ? AND (? = '' OR title LIKE ?)
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(cwd, query, `%${query}%`, PAGE_SIZE, page * PAGE_SIZE) as Array<Omit<SessionRecord, "events_json" | "info_json" | "messages_json">>;
  return rows.map((row) => ({ ...row, events_json: "[]", info_json: "{}", messages_json: "[]" }));
}

/** Newest session started in `cwd` (metadata only), for `mini-tui -p --continue`. */
export function latestSession(db: Database, cwd: string): SessionRecord | null {
  return listSessions(db, cwd, "", 0)[0] ?? null;
}

/**
 * Session by full id or unique id prefix (any folder). `null` when nothing matches;
 * throws when a prefix is ambiguous, so a script never continues the wrong conversation.
 */
export function findSession(db: Database, idOrPrefix: string): SessionRecord | null {
  const exact = getSession(db, idOrPrefix);
  if (exact) return exact;
  const rows = db
    .query("SELECT id FROM sessions WHERE id LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 2")
    .all(`${idOrPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as Array<{ id: string }>;
  if (rows.length > 1) throw new Error(`session id prefix "${idOrPrefix}" is ambiguous`);
  return rows[0] ? getSession(db, rows[0].id) : null;
}

/** `%` and `_` in a search box are characters, not wildcards: escape them for `LIKE ... ESCAPE '\\'`. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export type HistoryRow = Omit<SessionRecord, "events_json" | "info_json" | "messages_json"> & {
  /** Whether a conversation was saved that a follow-up can continue from. */
  resumable: boolean;
};

/**
 * The history for the web app's "Resume": every folder, newest first, one light query.
 *
 * `resumable` says whether a saved conversation exists to continue from. Testing `messages_json` itself
 * reads every multi-megabyte blob (about 50 ms for a page of 50 on a 170-session database), so it is
 * inferred from cheap columns instead: a session that made a model call has messages; a session with
 * none is decided by whether it recorded any events, a column that is small and only read for the rare
 * zero-call row. Checked against all 171 real rows: it agrees with `messages_json != '[]'` on every one,
 * in 0.4 ms. (`api_calls > 0` alone was wrong for two sessions that saved a task but no call count.)
 */
export function listHistory(db: Database, options: { query?: string; limit?: number; cwd?: string } = {}): HistoryRow[] {
  const query = (options.query ?? "").trim();
  // An exact folder (not a search): the sessions of one project, as the sidebar's folder groups show.
  const cwd = options.cwd ?? null;
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 50) || 50));
  const rows = db
    .query(
      `SELECT ${META_COLUMNS},
         CASE WHEN api_calls > 0 THEN 1 ELSE length(CAST(events_json AS BLOB)) > 2 END AS resumable FROM sessions
       WHERE (? = '' OR title LIKE ? ESCAPE '\\' OR task LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')
         AND (? IS NULL OR cwd = ?)
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(query, likePattern(query), likePattern(query), likePattern(query), cwd, cwd, limit) as Array<Omit<HistoryRow, "resumable"> & { resumable: number }>;
  return rows.map((r) => ({ ...r, resumable: r.resumable === 1 }));
}

export interface FolderSummary {
  cwd: string;
  /** Saved sessions in this folder. */
  count: number;
  /** When the newest of them was last updated. */
  updatedAt: number;
}

/**
 * Every folder that has saved sessions, most recently active first, with how many each holds. Read
 * from the `(cwd, updated_at)` index alone: no row is touched, so it stays instant however large the
 * history grows (0.1 ms for 180 sessions).
 */
export function listFolders(db: Database, limit = 200): FolderSummary[] {
  const n = Math.min(1000, Math.max(1, Math.floor(limit) || 200));
  return db
    .query(`SELECT cwd, count(*) AS count, max(updated_at) AS updatedAt FROM sessions GROUP BY cwd ORDER BY updatedAt DESC LIMIT ?`)
    .all(n) as FolderSummary[];
}

/** Sessions of every folder (or one), newest first, metadata only (`mini-tui sessions --all`). */
export function listAllSessions(db: Database, options: { cwd?: string; query?: string; limit?: number } = {}): SessionRecord[] {
  const query = options.query ?? "";
  const rows = db
    .query(
      `SELECT ${META_COLUMNS} FROM sessions
       WHERE (? IS NULL OR cwd = ?) AND (? = '' OR title LIKE ?)
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(options.cwd ?? null, options.cwd ?? null, query, `%${query}%`, options.limit && options.limit > 0 ? options.limit : -1) as Array<
    Omit<SessionRecord, "events_json" | "info_json" | "messages_json">
  >;
  return rows.map((row) => ({ ...row, events_json: "[]", info_json: "{}", messages_json: "[]" }));
}

/** Delete one session (and its resume file). Returns whether a row was removed. */
export function deleteSession(db: Database, id: string): boolean {
  const result = db.query("DELETE FROM sessions WHERE id = ?").run(id);
  db.query("DELETE FROM notes WHERE session_id = ?").run(id); // a deleted session leaves no orphaned notes
  db.query("DELETE FROM session_tasks WHERE session_id = ?").run(id); // nor a task card
  try {
    const dir = process.env.MINITUI_RESUME_DIR ?? join(homedir(), ".config", "mini-tui", "resume");
    rmSync(join(dir, `${id}.json`), { force: true });
  } catch {
    // the resume file is a cache
  }
  return result.changes > 0;
}

// ------------------------------------------------------------------ notes

/** The longest note accepted (characters). Generous for notes, small enough that no request pins memory. */
export const NOTE_MAX = 200_000;

export interface Note {
  id: string;
  body: string;
  /** 0 when the session has no note yet. */
  updatedAt: number;
}

export function getNote(db: Database, id: string): Note {
  const row = db.query("SELECT body, updated_at FROM notes WHERE session_id = ?").get(id) as { body: string; updated_at: number } | null;
  return { id, body: row?.body ?? "", updatedAt: row?.updated_at ?? 0 };
}

export type SaveNoteResult = { ok: true; note: Note } | { ok: false; conflict: Note };

/**
 * Save a note, refusing to overwrite a newer one. `baseUpdatedAt` is the version the editor started from:
 * if the stored note has changed since (another tab or device saved it), nothing is written and the
 * current note is returned so the user can choose. Omit it to overwrite unconditionally.
 *
 * `updated_at` always moves forward, even for two saves in the same millisecond, so equal timestamps can
 * never hide a change. An empty body deletes the row: "no note" and "an empty note" are the same thing.
 */
export function saveNote(db: Database, id: string, body: string, baseUpdatedAt?: number): SaveNoteResult {
  return db.transaction((): SaveNoteResult => {
    const current = getNote(db, id);
    if (baseUpdatedAt !== undefined && current.updatedAt !== baseUpdatedAt) return { ok: false, conflict: current };
    if (!body) {
      db.query("DELETE FROM notes WHERE session_id = ?").run(id);
      return { ok: true, note: { id, body: "", updatedAt: 0 } };
    }
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
    db.query(
      "INSERT INTO notes (session_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
    ).run(id, body, updatedAt);
    return { ok: true, note: { id, body, updatedAt } };
  })();
}

// ------------------------------------------------------------ session tasks

/**
 * The task card an agent fills for the session it runs in : what the task is,
 * what was done (an AI-written description) and the to-dos in their three buckets — done, pending
 * and what is left. The web app shows one per session; the panes change sessions, the card does not.
 *
 * A card is always replaced whole, never merged: the agent re-states all three buckets every time,
 * so the card can never hold two views of the same work. `listTasks` is the board the hub pushes.
 */
export interface TaskTodos {
  done: string[];
  pending: string[];
  left: string[];
}

export interface SessionTask {
  id: string;
  title: string;
  description: string;
  todos: TaskTodos;
  /** 0 when the session has no task card yet. */
  updatedAt: number;
}

/** How much a card may hold: enough for a session's story, small enough that the board stays cheap. */
export const TASK_LIMITS = {
  title: 200,
  description: 4000,
  item: 300,
  items: 50,
} as const;

const EMPTY_TODOS: TaskTodos = { done: [], pending: [], left: [] };

/** The three buckets of a card, from whatever the caller passed: junk entries dropped, the rest trimmed. */
export function normalizeTodos(value: unknown): TaskTodos {
  const todos = value as Partial<Record<keyof TaskTodos, unknown>> | null;
  const list = (key: keyof TaskTodos): string[] => {
    const raw = Array.isArray(todos?.[key]) ? (todos![key] as unknown[]) : [];
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const text = item.replace(/\s+/g, " ").trim().slice(0, TASK_LIMITS.item);
      if (text && out.length < TASK_LIMITS.items) out.push(text);
    }
    return out;
  };
  return { done: list("done"), pending: list("pending"), left: list("left") };
}

function rowToTask(row: { session_id: string; title: string; description: string; todos: string; updated_at: number } | null): SessionTask {
  let todos: TaskTodos = EMPTY_TODOS;
  try {
    if (row) todos = normalizeTodos(JSON.parse(row.todos));
  } catch {
    // an unreadable card is an empty one, never a broken board
  }
  return {
    id: row?.session_id ?? "",
    title: row?.title ?? "",
    description: row?.description ?? "",
    todos,
    updatedAt: row?.updated_at ?? 0,
  };
}

export function getTask(db: Database, id: string): SessionTask {
  const row = db.query("SELECT session_id, title, description, todos, updated_at FROM session_tasks WHERE session_id = ?").get(id) as Parameters<typeof rowToTask>[0];
  return { ...rowToTask(row), id };
}

/** Every session that has a task card, most recently updated first: the board the web app shows. */
export function listTasks(db: Database): SessionTask[] {
  const rows = db.query("SELECT session_id, title, description, todos, updated_at FROM session_tasks ORDER BY updated_at DESC").all() as Parameters<typeof rowToTask>[0][];
  return rows.map((row) => rowToTask(row));
}

/**
 * Replace a session's whole task card. `updated_at` always moves forward (like a note's), so two
 * writes in the same millisecond can never hide a change from the hub's push.
 */
export function saveTask(db: Database, id: string, card: { title: string; description: string; todos: unknown }): SessionTask {
  return db.transaction((): SessionTask => {
    const current = getTask(db, id);
    const task: SessionTask = {
      id,
      title: String(card.title ?? "").replace(/\s+/g, " ").trim().slice(0, TASK_LIMITS.title),
      description: String(card.description ?? "").trim().slice(0, TASK_LIMITS.description),
      todos: normalizeTodos(card.todos),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    db.query(
      "INSERT INTO session_tasks (session_id, title, description, todos, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, description = excluded.description, todos = excluded.todos, updated_at = excluded.updated_at",
    ).run(id, task.title, task.description, JSON.stringify(task.todos), task.updatedAt);
    return task;
  })();
}

export function deleteTask(db: Database, id: string): void {
  db.query("DELETE FROM session_tasks WHERE session_id = ?").run(id);
}
