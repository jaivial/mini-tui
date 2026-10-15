/**
 * v6-B: the read-only usage projection behind `GET /api/usage`.
 *
 * Same contract as `channelsView()`: it opens the store read-only, answers a
 * bounded window, and never mutates. The store is the one written by the run
 * paths; this file only ever reads it, so a bug here cannot invent or erase spend.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { catalogExists, catalogPath, loadPriceCatalog } from "../usage/prices";
import { usageDbPath, windowFromQuery, type UsageSummary, type UsageWindow } from "../usage/store";

export interface UsageRowView {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  unknownCostCalls: number;
  errors: number;
  avgLatencyMs: number | null;
  lastUsedAt: number | null;
}

export interface UsageView {
  /** The resolved window, echoed so the panel can label itself. */
  window: { name: string; since: number | null; until: number | null };
  configured: boolean;
  totals: UsageRowView;
  byProvider: UsageRowView[];
  byModel: UsageRowView[];
  /** Whether the v6-A price catalog is present — "unknown cost" has a reason. */
  pricesConfigured: boolean;
  catalogPath: string;
  /** False when some call in the window had no price: the cost is a known part, not all. */
  costComplete: boolean;
  recent: Array<{ at: number; session: string; task: string; provider: string; model: string; inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs: number | null; ok: boolean }>;
}

const WINDOW_NAME = /^(all|\d{1,4}[hdwm])$/;

/** Latest calls, so the operator sees which turn spent, not only the totals. */
const RECENT_MAX = 50;

/**
 * Resolve `?window=` to a bounded span. An unrecognised value falls back to the
 * whole store rather than being rejected: a newer panel asking for a window this
 * build does not know about still gets numbers, clearly labelled.
 */
export function resolveWindow(param: string | null, now = Date.now()): { name: string; window: UsageWindow } {
  const name = (param ?? "").trim();
  if (!WINDOW_NAME.test(name)) return { name: "all", window: { since: 0, until: Number.MAX_SAFE_INTEGER } };
  if (name === "all") return { name, window: { since: 0, until: Number.MAX_SAFE_INTEGER } };
  return { name, window: windowFromQuery(name, now) };
}

/**
 * Build the panel's payload. A store that does not exist yet is "not configured",
 * not an error: a fresh host has no runs, so there is genuinely nothing measured.
 */
export function usageView(windowName: string | null, env: NodeJS.ProcessEnv = process.env): UsageView {
  const { name, window } = resolveWindow(windowName);
  const path = usageDbPath(env);
  const catalog = loadPriceCatalog(catalogPath(env));
  const empty = emptyView(name, window, catalog.loaded, catalogPath(env));
  if (!existsSync(path)) return empty;

  let db: Database | undefined;
  try {
    // Read-only: this endpoint must never create, migrate or write the ledger.
    db = new Database(path, { readonly: true, create: false });
    const summary = summarizeFrom(db, window);
    const recent = db
      .query(`SELECT at,session,task,provider,model,input_tokens,output_tokens,cost_usd,latency_ms,ok
        FROM usage_calls WHERE at >= ?1 AND at < ?2 ORDER BY at DESC LIMIT ?3`)
      .all(window.since ?? 0, window.until ?? Number.MAX_SAFE_INTEGER, RECENT_MAX) as Array<Record<string, unknown>>;
    return {
      window: { name, since: summary.since, until: summary.until },
      configured: true,
      totals: summary.totals,
      byProvider: summary.byProvider,
      byModel: summary.byModel,
      pricesConfigured: catalog.loaded,
      catalogPath: catalogPath(env),
      costComplete: summary.costComplete,
      recent: recent.map((row) => ({
        at: Number(row.at ?? 0),
        session: String(row.session ?? ""),
        task: String(row.task ?? ""),
        provider: String(row.provider ?? ""),
        model: String(row.model ?? ""),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
        latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
        ok: Number(row.ok ?? 1) === 1,
      })),
    };
  } catch {
    // A store written by a newer build, or an unreadable file: an empty panel beats a 500.
    return empty;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

export function catalogConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return catalogExists(catalogPath(env));
}

/**
 * The aggregate SQL, read straight off the connection. It mirrors
 * `UsageStore.summarize` on purpose: this path cannot open a writable store, so it
 * repeats the query instead of reusing the class.
 */
function summarizeFrom(db: Database, window: UsageWindow): UsageSummary {
  const since = window.since ?? 0;
  const until = window.until ?? Number.MAX_SAFE_INTEGER;
  const where = "WHERE at >= ?1 AND at < ?2";
  const rows = (keyExpr: string) =>
    db
      .query(`SELECT ${keyExpr} AS k, COUNT(*) AS calls,
          SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
          SUM(cost_usd) AS cost_sum, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
          SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors,
          AVG(latency_ms) AS avg_latency, MAX(at) AS last_used
        FROM usage_calls ${where} ${keyExpr ? `GROUP BY ${keyExpr} ORDER BY calls DESC, last_used DESC` : ""}`)
      .all(since, until) as Array<Record<string, unknown>>;

  const toRow = (row: Record<string, unknown>): UsageRowView => {
    const unknown = Number(row.unknown_cost ?? 0);
    const sum = row.cost_sum === null ? null : Math.round(Number(row.cost_sum) * 1e6) / 1e6;
    return {
      key: String(row.k ?? ""),
      label: String(row.k ?? ""),
      calls: Number(row.calls ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
      costUsd: unknown > 0 && (sum === null || sum === 0) ? null : sum,
      unknownCostCalls: unknown,
      errors: Number(row.errors ?? 0),
      avgLatencyMs: row.avg_latency === null ? null : Math.round(Number(row.avg_latency) * 10) / 10,
      lastUsedAt: row.last_used === null ? null : Number(row.last_used),
    };
  };

  const totalRow = rows("''")[0];
  const totals: UsageRowView = totalRow
    ? toRow(totalRow)
    : { ...emptyView("", window, true, "").totals };
  const byProvider = rows("provider").map((row) => toRow(row));
  // The model column already holds `provider/id`; prefixing would double the provider.
  const byModel = rows("model").map((row) => toRow(row));
  return {
    since: since > 0 ? since : null,
    until: until < Number.MAX_SAFE_INTEGER ? until : null,
    totals,
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
    costComplete: totals.calls === 0 || totals.unknownCostCalls === 0,
  };
}

function emptyView(name: string, window: UsageWindow, pricesConfigured: boolean, path: string): UsageView {
  const totals: UsageRowView = {
    key: "",
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
  return {
    window: { name, since: window.since ?? null, until: window.until ?? null },
    configured: false,
    totals,
    byProvider: [],
    byModel: [],
    pricesConfigured,
    catalogPath: path,
    costComplete: true,
    recent: [],
  };
}