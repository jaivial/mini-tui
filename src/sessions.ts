import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
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
}

export const DEFAULT_DB_PATH = join(homedir(), ".config", "mini-tui", "sessions.db");
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
  `);
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]'");
  } catch {
    // column already exists (databases created before --resume support)
  }
  return db;
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
  const dir = join(homedir(), ".config", "mini-tui", "resume");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify({ messages })}\n`);
  return path;
}

export function getSession(db: Database, id: string): SessionRecord | null {
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | undefined) ?? null;
}

export function countSessions(db: Database, cwd: string, query: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM sessions WHERE cwd = ? AND (? = '' OR title LIKE ?)")
    .get(cwd, query, `%${query}%`) as { n: number };
  return row.n;
}

/** Sessions started in `cwd`, title matching `query`, newest first, one page. */
export function listSessions(db: Database, cwd: string, query: string, page: number): SessionRecord[] {
  return db
    .query(
      `SELECT * FROM sessions
       WHERE cwd = ? AND (? = '' OR title LIKE ?)
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(cwd, query, `%${query}%`, PAGE_SIZE, page * PAGE_SIZE) as SessionRecord[];
}
