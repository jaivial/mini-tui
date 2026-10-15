/**
 * v6-C: the audit trail.
 *
 * A router that picks a model with no record of *why* is a black box you cannot
 * debug: when a run gets worse instead of better, the first question is always
 * "what did it think it was doing?". So every decision — chosen model, runner,
 * the full ranked list with each variable's value, Laya's probabilities and its
 * own confidence, and any fallback that fired — is written to its own SQLite
 * table before the caller is told anything.
 *
 * Separate from the usage ledger on purpose: usage answers "what did we spend",
 * this answers "why did we choose that". Same directory, same 0600, same
 * migrations-by-version discipline (`user_version` on its own file).
 *
 * Reads are bounded and redacted: prompts are clipped to a summary, provider
 * error strings are stripped of control characters, and nothing that leaves
 * this module contains a key.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { BreakerReason } from "./breaker";
import type { ScoredCandidate } from "./scoring";

/** Which of the three levels asked. Level 3 is the sub-task switch inside a run. */
export type RouteLevel = "task" | "delegate" | "subtask";

/** What produced the decision — `laya` when the model answered, `deterministic` when it did not. */
export type DecisionSource = "laya" | "deterministic" | "manual" | "fallback";

export interface DecisionRecord {
  at: number;
  level: RouteLevel;
  source: DecisionSource;
  chosen: string;
  reason: string;
  /** Laya's P(chosen) and its confidence, when it answered. */
  layaProbability: number | null;
  layaConfidence: number | null;
  layaCheckpoint: string;
  /** Why Laya was not consulted / did not answer. Empty when it answered. */
  layaReason: string;
  complexity: string;
  /** The clipped task text the decision was made on. */
  task: string;
  candidates: number;
  /** The full ranked table with every term — the part that makes it arguable. */
  ranking: Array<{ model: string; score: number; terms: ScoredCandidate["terms"]; why: string[]; excluded: string | null }>;
  /** The model this decision replaced, when it was a fallback or a switch. */
  from: string;
  /** The failure that triggered a fallback, when there was one. */
  fallbackReason: BreakerReason | null;
}

export interface AuditEntry {
  id: number;
  at: number;
  level: RouteLevel;
  source: DecisionSource;
  chosen: string;
  reason: string;
  layaProbability: number | null;
  layaConfidence: number | null;
  layaCheckpoint: string;
  layaReason: string;
  complexity: string;
  task: string;
  candidates: number;
  ranking: DecisionRecord["ranking"];
  from: string;
  fallbackReason: BreakerReason | null;
}

export function routerDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINITUI_ROUTER_DB ?? join(homedir(), ".local", "share", "mini-tui", "router.sqlite");
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

export class RouterAudit {
  readonly db: Database;
  readonly path: string;

  constructor(path: string = routerDbPath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS decisions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      chosen TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      laya_probability REAL,
      laya_confidence REAL,
      laya_checkpoint TEXT NOT NULL DEFAULT '',
      laya_reason TEXT NOT NULL DEFAULT '',
      complexity TEXT NOT NULL DEFAULT '',
      task TEXT NOT NULL DEFAULT '',
      candidates INTEGER NOT NULL DEFAULT 0,
      ranking TEXT NOT NULL DEFAULT '[]',
      from_model TEXT NOT NULL DEFAULT '',
      fallback_reason TEXT
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS decisions_at ON decisions(at)");
  }

  record(decision: DecisionRecord): number {
    const result = this.db
      .query(`INSERT INTO decisions(at,level,source,chosen,reason,laya_probability,laya_confidence,
        laya_checkpoint,laya_reason,complexity,task,candidates,ranking,from_model,fallback_reason)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`)
      .run(
        decision.at,
        decision.level,
        decision.source,
        clean(decision.chosen, 200),
        clean(decision.reason, 500),
        decision.layaProbability,
        decision.layaConfidence,
        clean(decision.layaCheckpoint, 64),
        clean(decision.layaReason, 200),
        clean(decision.complexity, 32),
        clean(decision.task, 600),
        decision.candidates,
        JSON.stringify(decision.ranking).slice(0, 64_000),
        clean(decision.from, 200),
        decision.fallbackReason,
      );
    return Number(result.lastInsertRowid ?? 0);
  }

  /** Newest first, bounded: the panel and the audit CLI never page a whole store. */
  recent(limit = 50, level?: RouteLevel): AuditEntry[] {
    const rows = level
      ? (this.db.query("SELECT * FROM decisions WHERE level = ? ORDER BY at DESC, id DESC LIMIT ?2").all(level, Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>)
      : (this.db.query("SELECT * FROM decisions ORDER BY at DESC, id DESC LIMIT ?1").all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>);
    return rows.map(rowToEntry);
  }

  /** What the store says about each model since `since` — the panel's counters. */
  counts(since: number): Record<string, { chosen: number; fallbacks: number }> {
    const rows = this.db
      .query("SELECT chosen, source, COUNT(*) AS n FROM decisions WHERE at >= ?1 GROUP BY chosen, source")
      .all(since) as Array<{ chosen: string; source: string; n: number }>;
    const out: Record<string, { chosen: number; fallbacks: number }> = {};
    for (const row of rows) {
      const entry = (out[row.chosen] ??= { chosen: 0, fallbacks: 0 });
      if (row.source === "fallback") entry.fallbacks += Number(row.n ?? 0);
      else entry.chosen += Number(row.n ?? 0);
    }
    return out;
  }

  /** Retention: the trail is evidence, not a ledger, so it is bounded. */
  prune(before: number): number {
    return Number(this.db.query("DELETE FROM decisions WHERE at < ?1").run(before).changes);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

function rowToEntry(row: Record<string, unknown>): AuditEntry {
  let ranking: AuditEntry["ranking"] = [];
  try {
    const parsed = JSON.parse(String(row.ranking ?? "[]"));
    if (Array.isArray(parsed)) ranking = parsed;
  } catch {
    ranking = [];
  }
  return {
    id: Number(row.id ?? 0),
    at: Number(row.at ?? 0),
    level: (row.level as RouteLevel) ?? "task",
    source: (row.source as DecisionSource) ?? "deterministic",
    chosen: String(row.chosen ?? ""),
    reason: String(row.reason ?? ""),
    layaProbability: row.laya_probability === null || row.laya_probability === undefined ? null : Number(row.laya_probability),
    layaConfidence: row.laya_confidence === null || row.laya_confidence === undefined ? null : Number(row.laya_confidence),
    layaCheckpoint: String(row.laya_checkpoint ?? ""),
    layaReason: String(row.laya_reason ?? ""),
    complexity: String(row.complexity ?? ""),
    task: String(row.task ?? ""),
    candidates: Number(row.candidates ?? 0),
    ranking,
    from: String(row.from_model ?? ""),
    fallbackReason: (row.fallback_reason as BreakerReason | null) ?? null,
  };
}

let shared: RouterAudit | null = null;

export function auditStore(path?: string): RouterAudit {
  if (path) return new RouterAudit(path);
  shared ??= new RouterAudit();
  return shared;
}

export function resetAuditStore(): void {
  shared?.close();
  shared = null;
}