/**
 * v6-B: durable per-call model usage — tokens, cost, latency, ok/error, by provider
 * and model. This is the store the router reads to know what a provider has cost
 * (tokens, money, failures) over a window, so a row here is measurement, never a
 * guess: `cost_usd` is NULL when no price was known, which reads as "unknown"
 * downstream and is never rounded to a fabricated 0.
 *
 * Storage follows the rest of the house: `~/.local/share/mini-tui/usage.sqlite`
 * at 0600 (the file holds spend, so it is the operator's alone), WAL, and a
 * `PRAGMA user_version` migration so a store written by an older build widens
 * instead of being replaced.
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One model call as measured. `costUsd === null` means no price was known. */
export interface UsageCall {
  /** Stable dedupe key (`<session>:<message seq>`): a replayed journal cannot double-count. */
  callKey: string;
  /** Epoch ms the call was journalled. */
  at: number;
  session: string;
  /** Queue task / channel turn that caused the call, when there was one. */
  task: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Wall time of the model call itself (ms), or null when the run carried no timing. */
  latencyMs: number | null;
  costUsd: number | null;
  /** Where the cost came from: the v6-A catalog, the agent's own price table, or nothing. */
  costSource: CostSource;
  ok: boolean;
  error: string;
}

export type CostSource = "catalog" | "agent" | "unknown";

/** One aggregate row: a provider, a model, or the whole window. */
export interface UsageTotals {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the calls whose cost is known. Null when none of them had a price. */
  costUsd: number | null;
  /** Calls in this row with no known price — why `costUsd` is not the whole spend. */
  unknownCostCalls: number;
  errors: number;
  /** Mean latency over the calls that reported one. Null when no call did. */
  avgLatencyMs: number | null;
  /** Epoch ms of the most recent call in this row (what "last used" means to the router). */
  lastUsedAt: number | null;
}

export interface UsageWindow {
  /** Inclusive lower bound in epoch ms. */
  since?: number;
  /** Exclusive upper bound in epoch ms. */
  until?: number;
}

export interface UsageSummary {
  /** Echo of the resolved window, so the panel labels what it is showing. */
  since: number | null;
  until: number | null;
  totals: UsageTotals;
  byProvider: UsageTotals[];
  byModel: UsageTotals[];
  /** Per-provider last use + window spend, the router's fallback signal. */
  providers: Array<{ provider: string; lastUsedAt: number | null; tokens: number; costUsd: number | null; unknownCostCalls: number; errors: number }>;
  /** True when every call in the window had a known price. */
  costComplete: boolean;
}

const SCHEMA_VERSION = 2;

export function usageDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINITUI_USAGE_DB ?? join(homedir(), ".local/share/mini-tui/usage.sqlite");
}

/** Bounded strings only: these come from model config and channel routes, never trusted. */
function text(value: string, max = 256): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10) / 10 : null;
}

export class UsageStore {
  readonly db: Database;
  readonly path: string;

  constructor(path: string = usageDbPath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.migrate();
  }

  /**
   * `user_version` is the migration clock. CREATE TABLE IF NOT EXISTS alone never
   * widens an existing table, so every later step is an explicit additive ALTER —
   * an old store is upgraded in place, never dropped.
   */
  private migrate(): void {
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    const row = this.db.query("PRAGMA user_version").get() as { user_version?: number } | undefined;
    const from = Number(row?.user_version ?? 0);
    if (from > SCHEMA_VERSION) {
      // A newer build wrote this file. Leave it alone rather than downgrading its schema.
      this.db.exec(`CREATE TABLE IF NOT EXISTS usage_calls(
        call_key TEXT PRIMARY KEY, at INTEGER NOT NULL, session TEXT NOT NULL DEFAULT '',
        task TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER, cost_usd REAL, cost_source TEXT NOT NULL DEFAULT 'unknown',
        ok INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '')`);
      return;
    }
    if (from < 1) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS usage_calls(
        call_key TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        session TEXT NOT NULL DEFAULT '',
        task TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        cost_usd REAL,
        cost_source TEXT NOT NULL DEFAULT 'unknown',
        ok INTEGER NOT NULL DEFAULT 1,
        error TEXT NOT NULL DEFAULT '')`);
      this.db.exec("CREATE INDEX IF NOT EXISTS usage_calls_at ON usage_calls(at)");
      this.db.exec("CREATE INDEX IF NOT EXISTS usage_calls_provider_at ON usage_calls(provider, at)");
    }
    if (from < 2) {
      // v2: the per-task breakdown the channel/queue turns need to attribute spend.
      const columns = (this.db.query("PRAGMA table_info(usage_calls)").all() as Array<{ name: string }>).map((c) => c.name);
      if (!columns.includes("task")) this.db.exec("ALTER TABLE usage_calls ADD COLUMN task TEXT NOT NULL DEFAULT ''");
      this.db.exec("CREATE INDEX IF NOT EXISTS usage_calls_session_at ON usage_calls(session, at)");
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Record one call. INSERT OR IGNORE on the call key: the same journal line can
   * be re-read (a resumed session, a restore, a second watcher) and must never
   * inflate the window the router budgets from.
   */
  record(call: UsageCall): boolean {
    const statement = this.db.query(`INSERT OR IGNORE INTO usage_calls(
      call_key,at,session,task,provider,model,input_tokens,output_tokens,cache_read_tokens,
      cache_write_tokens,latency_ms,cost_usd,cost_source,ok,error
    ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`);
    const result = statement.run(
      text(call.callKey, 400),
      Number.isFinite(call.at) ? Math.round(call.at) : Date.now(),
      text(call.session),
      text(call.task),
      text(call.provider, 128),
      text(call.model, 200),
      Math.max(0, Math.round(call.inputTokens)),
      Math.max(0, Math.round(call.outputTokens)),
      Math.max(0, Math.round(call.cacheReadTokens)),
      Math.max(0, Math.round(call.cacheWriteTokens)),
      call.latencyMs === null || !Number.isFinite(call.latencyMs) ? null : Math.max(0, Math.round(call.latencyMs)),
      call.costUsd === null || !Number.isFinite(call.costUsd) ? null : Math.max(0, call.costUsd),
      call.costSource,
      call.ok ? 1 : 0,
      text(call.error, 500),
    );
    return Number(result.changes) > 0;
  }

  /** Rows inside a window, newest first. Bounded: the panel never pages through a store. */
  recent(window: UsageWindow = {}, limit = 200): UsageCall[] {
    const rows = this.db.query(`SELECT * FROM usage_calls WHERE at >= ?1 AND at < ?2 ORDER BY at DESC LIMIT ?3`)
      .all(window.since ?? 0, window.until ?? Number.MAX_SAFE_INTEGER, Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, unknown>>;
    return rows.map(rowToCall);
  }

  /**
   * Aggregates for a window: totals, per provider and per model. `SUM(cost_usd)`
   * skips NULLs on purpose — a run whose price was unknown must lower the sum it
   * can vouch for, never add a zero to it.
   */
  summarize(window: UsageWindow = {}): UsageSummary {
    const since = window.since ?? 0;
    const until = window.until ?? Number.MAX_SAFE_INTEGER;
    const where = "WHERE at >= ?1 AND at < ?2";
    const args: SQLQueryBindings[] = [since, until];
    const rows = this.group(where, args, "", "");
    const byProvider = this.group(where, args, "provider", "provider");
    // The model column already holds `provider/id`, so the per-model key is the model
// itself — prefixing the provider again would produce `deepseek/deepseek/x`.
const byModel = this.group(where, args, "model", "model");
    const totals = rows[0] ?? emptyTotals("total");
    return {
      since: Number.isFinite(since) && since > 0 ? since : null,
      until: Number.isFinite(until) && until < Number.MAX_SAFE_INTEGER ? until : null,
      totals: totals ?? emptyTotals("total"),
      byProvider,
      byModel,
      providers: byProvider.map((row) => ({
        provider: row.key,
        lastUsedAt: row.lastUsedAt,
        tokens: row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
        costUsd: row.costUsd,
        unknownCostCalls: row.unknownCostCalls,
        errors: row.errors,
      })),
      // "Complete" means every call in the window carried a price, so the cost
      // figure can be read as the whole spend rather than a known part of it.
      costComplete: totals.calls === 0 || totals.unknownCostCalls === 0,
    };
  }

  private group(where: string, args: SQLQueryBindings[], keyExpr: string, labelExpr: string): UsageTotals[] {
    const select = keyExpr
      ? `SELECT ${keyExpr} AS k, ${labelExpr} AS label, COUNT(*) AS calls,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cost_usd) AS cost_sum, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
           SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors,
           AVG(latency_ms) AS avg_latency, MAX(at) AS last_used`
      : `SELECT '' AS k, '' AS label, COUNT(*) AS calls,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cost_usd) AS cost_sum, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
           SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors,
           AVG(latency_ms) AS avg_latency, MAX(at) AS last_used`;
    const groupBy = keyExpr ? `GROUP BY ${keyExpr} ORDER BY calls DESC, last_used DESC` : "";
    const rows = this.db.query(`${select} FROM usage_calls ${where} ${groupBy}`).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const unknown = Number(row.unknown_cost ?? 0);
      const cost = row.cost_sum === null ? null : Math.round(Number(row.cost_sum) * 1e6) / 1e6;
      return {
        key: String(row.k ?? ""),
        label: String(row.label ?? ""),
        calls: Number(row.calls ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
        // A cost sum of exactly 0 with unknown calls means "priced at zero" only when
        // every call had a price; with unknowns it stays null so nothing reads as free.
        costUsd: unknown > 0 && (cost === null || cost === 0) ? null : cost,
        unknownCostCalls: unknown,
        errors: Number(row.errors ?? 0),
        avgLatencyMs: row.avg_latency === null ? null : ratio(Number(row.avg_latency), 1),
        lastUsedAt: row.last_used === null ? null : Number(row.last_used),
      } satisfies UsageTotals;
    });
  }

  /** Forget calls older than `before` — retention, so the store does not grow forever. */
  prune(before: number): number {
    const result = this.db.query("DELETE FROM usage_calls WHERE at < ?1").run(before);
    return Number(result.changes);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

function emptyTotals(key: string): UsageTotals {
  return {
    key,
    label: "",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    unknownCostCalls: 0,
    errors: 0,
    avgLatencyMs: null,
    lastUsedAt: null,
  };
}

function rowToCall(row: Record<string, unknown>): UsageCall {
  return {
    callKey: String(row.call_key ?? ""),
    at: Number(row.at ?? 0),
    session: String(row.session ?? ""),
    task: String(row.task ?? ""),
    provider: String(row.provider ?? ""),
    model: String(row.model ?? ""),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    costSource: (row.cost_source as CostSource) ?? "unknown",
    ok: Number(row.ok ?? 1) === 1,
    error: String(row.error ?? ""),
  };
}

/** Resolve a window name the panel and the router share (`1h`, `24h`, `7d`, `30d`, `all`). */
export function windowMs(name: string | null, now = Date.now()): number {
  const match = /^(\d{1,4})([hdwm])$/.exec((name ?? "").trim());
  if (!match) return 0;
  const value = Number(match[1]) * ({ h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000 }[match[2]] ?? 0);
  // Bounded: a typo is a clamped window, not an unbounded table scan of a year.
  return Math.min(Math.max(value, 60_000), 400 * 86_400_000);
}

export function windowFromQuery(param: string | null, now = Date.now()): UsageWindow {
  const span = windowMs(param, now);
  if (!span) return { since: 0, until: Number.MAX_SAFE_INTEGER };
  return { since: now - span, until: now + 60_000 };
}