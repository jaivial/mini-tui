/**
 * Read-only usage client for the Settings/Canales panel: what each provider and
 * model has spent over a window (tokens, cost, latency, failures).
 *
 * The server answers from its own read-only store; the client only renders. It
 * validates fail-closed, like the channels client: a malformed or oversized
 * projection is refused whole, never rendered half-rendered.
 *
 * One rule the types carry deliberately: `costUsd` is `number | null`, and null
 * means "not priced". The panel must show that as unknown — the temptation to
 * print 0 is exactly the lie this task is meant to prevent.
 */

export interface UsageRow {
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

export interface UsageRecentCall {
  at: number;
  session: string;
  task: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  ok: boolean;
}

export interface UsageView {
  window: { name: string; since: number | null; until: number | null };
  /** False on a host where nothing has run yet (no ledger file). */
  configured: boolean;
  totals: UsageRow;
  byProvider: UsageRow[];
  byModel: UsageRow[];
  /** Whether the price catalog is present. False = every cost is unknown, by design. */
  pricesConfigured: boolean;
  costComplete: boolean;
  recent: UsageRecentCall[];
}

/** Windows the panel offers, in the operator's own units. */
export const USAGE_WINDOWS = [
  { id: "1h", label: "1 h" },
  { id: "24h", label: "24 h" },
  { id: "7d", label: "7 d" },
  { id: "30d", label: "30 d" },
  { id: "all", label: "Todo" },
] as const;

const MAX_ROWS = 500;
const MAX_RECENT = 100;

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** Cost is a non-negative number or null. A negative or non-numeric cost is junk. */
function money(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function validRow(value: unknown): UsageRow | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const calls = int(r.calls);
  const input = int(r.inputTokens);
  const output = int(r.outputTokens);
  const cacheRead = int(r.cacheReadTokens);
  const cacheWrite = int(r.cacheWriteTokens);
  const unknown = int(r.unknownCostCalls);
  const errors = int(r.errors);
  const cost = money(r.costUsd);
  const latency = r.avgLatencyMs === null ? null : int(r.avgLatencyMs);
  const lastUsed = r.lastUsedAt === null ? null : int(r.lastUsedAt);
  const key = str(r.key, 200);
  if (calls === null || calls < 0 || input === null || output === null) return null;
  if (cacheRead === null || cacheWrite === null || unknown === null || errors === null) return null;
  if (cost === undefined || latency === undefined || lastUsed === undefined || key === null) return null;
  return {
    key,
    label: str(r.label, 200) ?? "",
    calls,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUsd: cost,
    unknownCostCalls: unknown,
    errors,
    avgLatencyMs: latency,
    lastUsedAt: lastUsed,
  };
}

function validCall(value: unknown): UsageRecentCall | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  const at = int(c.at);
  const cost = money(c.costUsd);
  const latency = c.latencyMs === null ? null : int(c.latencyMs);
  if (at === null || typeof c.ok !== "boolean" || cost === undefined || latency === undefined) return null;
  return {
    at,
    session: str(c.session, 256) ?? "",
    task: str(c.task, 256) ?? "",
    provider: str(c.provider, 128) ?? "",
    model: str(c.model, 200) ?? "",
    inputTokens: int(c.inputTokens) ?? 0,
    outputTokens: int(c.outputTokens) ?? 0,
    costUsd: cost,
    latencyMs: latency,
    ok: c.ok,
  };
}

export function parseUsage(value: unknown): UsageView {
  if (!value || typeof value !== "object") throw new Error("invalid usage projection");
  const v = value as Record<string, unknown>;
  if (typeof v.configured !== "boolean" || typeof v.pricesConfigured !== "boolean" || typeof v.costComplete !== "boolean") {
    throw new Error("invalid usage projection");
  }
  const w = v.window;
  if (!w || typeof w !== "object") throw new Error("invalid usage window");
  const name = str((w as Record<string, unknown>).name, 16);
  if (name === null) throw new Error("invalid usage window");
  const totals = validRow(v.totals);
  if (!totals) throw new Error("invalid usage totals");
  if (!Array.isArray(v.byProvider) || v.byProvider.length > MAX_ROWS) throw new Error("invalid usage rows");
  if (!Array.isArray(v.byModel) || v.byModel.length > MAX_ROWS) throw new Error("invalid usage rows");
  if (!Array.isArray(v.recent) || v.recent.length > MAX_RECENT) throw new Error("invalid usage rows");
  const byProvider = v.byProvider.map(validRow);
  const byModel = v.byModel.map(validRow);
  const recent = v.recent.map(validCall);
  if (byProvider.some((r) => r === null) || byModel.some((r) => r === null) || recent.some((r) => r === null)) {
    throw new Error("invalid usage rows");
  }
  return {
    window: { name, since: int((w as Record<string, unknown>).since), until: int((w as Record<string, unknown>).until) },
    configured: v.configured,
    totals,
    byProvider: byProvider as UsageRow[],
    byModel: byModel as UsageRow[],
    pricesConfigured: v.pricesConfigured,
    costComplete: v.costComplete,
    recent: recent as UsageRecentCall[],
  };
}

export class UsageClient {
  constructor(readonly base = "/api") {}

  async window(id: string): Promise<UsageView> {
    const res = await fetch(`${this.base}/usage?window=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`usage unavailable (${res.status})`);
    return parseUsage(await res.json() as unknown);
  }
}

// ── Formatting ──

/** A cost cell. Unknown is spelled out; it is never rendered as $0.00. */
export function formatCost(costUsd: number | null, unknownCalls = 0): string {
  if (costUsd === null) return unknownCalls > 0 ? `desconocido (${unknownCalls})` : "desconocido";
  if (costUsd === 0) return "$0.00";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatWhen(at: number | null): string {
  if (!at) return "nunca";
  const delta = Date.now() - at;
  if (delta < 60_000) return "hace un momento";
  if (delta < 3_600_000) return `hace ${Math.floor(delta / 60_000)} min`;
  if (delta < 86_400_000) return `hace ${Math.floor(delta / 3_600_000)} h`;
  return new Date(at).toLocaleDateString();
}

/** Total tokens of a row, cache included: what the operator actually paid for. */
export function rowTokens(row: UsageRow): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}