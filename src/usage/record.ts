/**
 * v6-B: the identity of the model a run was using, resolved from the parts that
 * are actually available.
 *
 * `info.config.model.model_name` is a **bare** id (`glm-5.3-flash`), so on its own
 * it names neither the provider nor the catalog key — a row keyed by that would
 * aggregate every provider's model under an empty provider and could never be
 * priced. The reply often omits `model` too (the OpenCode Go gateway does), so
 * this combines the config's own `api_base` with the catalog's provider list:
 * a base URL that identifies one provider in the catalog qualifies the bare id.
 *
 * Anything still unresolved stays empty. An empty model is honest — the tokens are
 * still measured, and the row says plainly that it could not be priced or attributed.
 */
export function resolveModel(
  infoModel: string | undefined,
  apiBase: string | undefined,
  knownProviders: ReadonlyArray<{ prefix: string; baseUrl?: string }>,
): string {
  const bare = (infoModel ?? "").trim();
  if (bare.includes("/")) return bare; // already qualified
  const base = (apiBase ?? "").trim().replace(/\/+$/, "");
  if (!bare) return "";
  if (!base) return bare;
  const owner = knownProviders.find((p) => {
    const url = (p.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!url) return false;
    return base === url || base.startsWith(`${url}/`) || url.startsWith(`${base}/`);
  });
  return owner ? `${owner.prefix}/${bare}` : bare;
}

/**
 * v6-B: turn one journalled assistant message into a usage row.
 *
 * The agent already journals everything needed per call — the API reply
 * (`extra.response`, whose `usage` block carries input/output/cache tokens), the
 * cost it computed (`extra.cost`), when the call landed (`extra.timestamp`) and
 * how long it took (`extra.timings.model`, falling back to `thinking_seconds`).
 * Reading those instead of instrumenting the model layer keeps this a pure,
 * testable function and covers every runner (the web server, the headless CLI,
 * the TUI) through the one path they all share: the journal.
 *
 * Honesty rules that shape this file:
 * - tokens are reported as the provider reported them; a reply with no usage block
 *   is recorded with zero tokens, never estimated;
 * - the price comes from the v6-A catalog, and a model it does not list is
 *   "unknown cost", not zero;
 * - a call that errored is recorded as failed with its message, so the router can
 *   see a provider that burns time without producing tokens.
 */
import type { TrajectoryMessage } from "../traj/schema";

import { costFor, loadPriceCatalog, type PriceCatalog, type TokenCounts } from "./prices";
import type { CostSource, UsageCall } from "./store";

/** Provider implied by a mini model name (`openrouter/anthropic/claude-x` → `openrouter`). */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "";
}

function record(source: unknown): Record<string, unknown> | undefined {
  return source && typeof source === "object" ? (source as Record<string, unknown>) : undefined;
}

function num(source: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!source) return 0;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * Tokens from any of the three usage conventions in play (OpenAI chat, the
 * Responses API, Anthropic Messages). Cache tokens are reported separately from
 * input because they are billed differently — folding them together would inflate
 * the input token count the router budgets from.
 */
export function tokensOf(usage: unknown): TokenCounts {
  const u = record(usage);
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const details = record(u.prompt_tokens_details) ?? record(u.input_tokens_details);
  const openAi = "prompt_tokens" in u || "completion_tokens" in u;
  return {
    input: openAi ? num(u, "prompt_tokens", "input_tokens") : num(u, "input_tokens", "prompt_tokens"),
    output: num(u, "completion_tokens", "output_tokens"),
    cacheRead: num(u, "cache_read_input_tokens") || num(details, "cached_tokens", "cache_read_tokens"),
    cacheWrite: num(u, "cache_creation_input_tokens") || num(details, "cache_creation_tokens"),
  };
}

function extraOf(message: TrajectoryMessage): Record<string, unknown> {
  return record(message.extra) ?? {};
}

/**
 * Cost and its provenance. The catalog is authoritative (v6-A owns the prices);
 * the agent's own `extra.cost` is a fallback that is only trusted when it is a
 * positive number, because a run that failed to price a model reports 0 and 0 is
 * not a cost.
 */
function resolveCost(
  model: string,
  tokens: TokenCounts,
  agentCost: unknown,
  catalog: PriceCatalog,
): { costUsd: number | null; costSource: CostSource } {
  const fromCatalog = costFor(catalog.price(model), tokens);
  if (fromCatalog !== null) return { costUsd: fromCatalog, costSource: "catalog" };
  if (typeof agentCost === "number" && Number.isFinite(agentCost) && agentCost > 0) {
    return { costUsd: Math.round(agentCost * 1e6) / 1e6, costSource: "agent" };
  }
  return { costUsd: null, costSource: "unknown" };
}

/** Latency of the model call itself, in ms, from whichever timing the run stamped. */
function latencyOf(extra: Record<string, unknown>): number | null {
  const timings = record(extra.timings);
  if (timings) {
    const model = timings.model;
    if (typeof model === "number" && Number.isFinite(model) && model >= 0) return Math.round(model);
  }
  const thinking = extra.thinking_seconds;
  if (typeof thinking === "number" && Number.isFinite(thinking) && thinking >= 0) return Math.round(thinking * 1000);
  return null;
}

/**
 * Epoch **ms** for one call.
 *
 * The agent journals `extra.timestamp` from `util::now()`, which is
 * `SystemTime::now()` as **seconds** with a fractional part — reading it as
 * milliseconds put every call in January 1970. The magnitude decides: anything
 * below ~1e11 is seconds (that is year 5138 in seconds, but 1973 in ms), so a
 * seconds value is scaled and a real millisecond value is left alone. Both are
 * rounded to ms because a fractional-second precision is noise in a ledger.
 */
function epochMs(timestamp: unknown, fallback: number): number {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return fallback;
  const asMs = timestamp > 1e11 ? timestamp : timestamp * 1000;
  return Math.round(asMs);
}

export interface UsageContext {
  /** Session id the run belongs to. */
  session: string;
  /** Queue task / channel turn behind the run, when there was one. */
  task?: string;
  /** Model the run was configured with, used when the reply does not name one. */
  fallbackModel?: string;
  /** The run's `api_base`, which qualifies a bare model id into `provider/id`. */
  apiBase?: string;
  catalog?: PriceCatalog;
  /** Epoch ms used when the message carries no timestamp of its own. */
  now?: number;
}

/**
 * The usage row for one journalled assistant message, or null when the message
 * is not a model call (a tool result, a system note, a message with no actions and
 * no reply — the shape the fast path and the closure gate produce).
 */
export function usageFromMessage(message: TrajectoryMessage, index: number, context: UsageContext): UsageCall | null {
  if (message.role !== "assistant") return null;
  const extra = extraOf(message);
  const response = record(extra.response);
  const usage = response ? record(response.usage) : undefined;
  // An assistant line with neither a reply nor an actions array is bookkeeping
  // (an interrupted draft), not a call that spent money.
  const hasActions = Array.isArray(extra.actions) && extra.actions.length > 0;
  const error = typeof extra.error === "string" ? extra.error : "";
  // A message that carries only an error is a call that was made and failed: it cost
  // time and often tokens, and the router needs to see the failure, so it counts.
  if (!response && !usage && !hasActions && !error) return null;

  const catalog = context.catalog ?? loadPriceCatalog();
  const replyModel = typeof response?.model === "string" ? response.model : "";
  // The reply's model wins; otherwise qualify the run's configured id with its base.
  const model = resolveModel(replyModel || context.fallbackModel, context.apiBase, catalog.providers());
  const tokens = tokensOf(usage);
  const { costUsd, costSource } = resolveCost(model, tokens, extra.cost, catalog);
  const at = epochMs(extra.timestamp, context.now ?? Date.now());

  return {
    // The message index is the call's identity in its run: a re-read of the same
    // journal (a resume, a restore, a second watcher) dedupes on it.
    callKey: `${context.session}:${index}`,
    at,
    session: context.session,
    task: context.task ?? "",
    provider: providerOf(model),
    model,
    inputTokens: Math.round(tokens.input),
    outputTokens: Math.round(tokens.output),
    cacheReadTokens: Math.round(tokens.cacheRead),
    cacheWriteTokens: Math.round(tokens.cacheWrite),
    latencyMs: latencyOf(extra),
    costUsd,
    costSource,
    ok: !error,
    error,
  };
}

/**
 * Every usage row in a run's messages, from `from` onwards. Callers that already
 * track how many messages they have consumed pass it, so a live watcher records
 * each call exactly once; `from = 0` replays a whole run (a restore, a CLI
 * backfill) and the store's dedupe makes that harmless.
 */
export function usageFromMessages(
  messages: readonly TrajectoryMessage[],
  context: UsageContext,
  from = 0,
): UsageCall[] {
  const out: UsageCall[] = [];
  for (let i = Math.max(0, from); i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    const call = usageFromMessage(message, i, context);
    if (call) out.push(call);
  }
  return out;
}