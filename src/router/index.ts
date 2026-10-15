/**
 * v6-C: the model router.
 *
 * One entry point, `route()`, decides a model for a task at three levels:
 *
 * 1. **`task`** — a new session or turn. The router picks the model before the
 *    run starts.
 * 2. **`delegate`** — a subagent the run delegates to. Same variables, but the
 *    delegated brief is usually smaller and narrower, which is exactly the
 *    signal that should push the choice down the capability ladder.
 * 3. **`subtask`** — *inside* a live agent, between steps. The hardest and most
 *    valuable of the three: the agent has context the router does not, so the
 *    router reads the run's own trajectory, classifies what the agent is doing
 *    right now, and asks for a model for *that* — switching mid-run only when
 *    the classification genuinely changed, because a model switch mid-context
 *    costs a cache miss and a re-read of the prefix.
 *
 * The decision itself is always the same shape (see `scoring.ts`): Laya's
 * calibrated distribution is one weighted term, and the catalog variables are the
 * rest. When Laya is unreachable, slow or wrong, `route()` still answers, from
 * the deterministic policy, and the audit says so in the `source` column.
 *
 * **Nothing here throws.** A router that can fail a run is worse than no router,
 * so every failure path returns a decision with a stated reason and the caller
 * keeps whatever model it already had.
 */
import { breakerStore, classifyFailure, reasonLabel, type BreakerReason, type BreakerStatus, type CircuitBreaker } from "./breaker";
import { auditStore, type DecisionSource, type RouteLevel, type RouterAudit } from "./audit";
import { buildCandidates, loadCatalog, type Candidate } from "./candidates";
import { askLaya, layaCheckpoint, layaUrl, type LayaResult } from "./laya";
import { deterministicOrder, rank, scoreCandidates, type ScoredCandidate, type UsageSignal } from "./scoring";
import { profileSubTask, profileTask, type TaskProfile } from "./task";
import { loadSettings } from "../settings";
import { usageDbPath } from "../usage/store";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface RouteRequest {
  level: RouteLevel;
  /** The task/sub-task text to classify. */
  task: string;
  /** A manual pin: when set, the router returns it untouched and records why. */
  pinnedModel?: string;
  /** Restrict the pool, e.g. to a provider the caller knows is reachable. */
  allow?: string[];
  /** Skip the Laya call (tests, and the audit CLI's offline mode). */
  offline?: boolean;
  /** The model this decision replaces, for the audit's `from` column. */
  from?: string;
  signal?: AbortSignal;
}

export interface RouteDecision {
  /** The model to run on, or "" when nothing could be decided (caller keeps its own). */
  model: string;
  level: RouteLevel;
  source: DecisionSource;
  reason: string;
  layaProbability: number | null;
  layaConfidence: number | null;
  layaCheckpoint: string;
  layaReason: string;
  profile: TaskProfile;
  candidates: ScoredCandidate[];
  /** The audit id, so a UI can link the decision to its record. */
  auditId: number;
  /** True when the router had nothing connected to choose from. */
  empty: boolean;
}

/** The usage ledger's per-model view, read read-only and bounded. */
export function readUsageSignals(windowMs = 86_400_000, now = Date.now(), env: NodeJS.ProcessEnv = process.env): UsageSignal[] {
  const path = usageDbPath(env);
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, create: false });
    const rows = db
      .query(`SELECT model, provider, COUNT(*) AS calls,
          SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors,
          AVG(latency_ms) AS avg_latency,
          SUM(cost_usd) AS cost_sum,
          MAX(at) AS last_used
        FROM usage_calls WHERE at >= ?1 GROUP BY model`)
      .all(now - windowMs) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      provider: String(row.provider ?? ""),
      model: String(row.model ?? ""),
      calls: Number(row.calls ?? 0),
      errors: Number(row.errors ?? 0),
      avgLatencyMs: row.avg_latency === null || row.avg_latency === undefined ? null : Math.round(Number(row.avg_latency)),
      costUsd: row.cost_sum === null || row.cost_sum === undefined ? null : Number(row.cost_sum),
      lastUsedAt: row.last_used === null || row.last_used === undefined ? null : Number(row.last_used),
    }));
  } catch {
    // A store written by a newer build, or no store at all: no signal, not an error.
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

function breakerMap(breaker: CircuitBreaker, candidates: Candidate[], now: number): Map<string, BreakerStatus> {
  return new Map(candidates.map((candidate) => [candidate.id, breaker.status(candidate.id, now)]));
}

/**
 * Laya's view of the pool.
 *
 * The option set is built from the candidates that survived the availability and
 * circuit filters, so the answer is always about a model the router could
 * actually pick. Each option's description carries the two numbers a reader needs
 * to sanity-check the answer (index and price, or "unknown" for each) — the
 * model card is prose, and the classification reads it as such.
 *
 * With more than a handful of options Laya's option budget (192 tokens on the
 * English card, 256 on multilingual) gives each label ~3-4 tokens and accuracy
 * falls off, so the pool is capped: the top N by the deterministic policy plus
 * the cheapest few, because "cheapest" is the answer a trivial task wants and
 * Laya would never see it otherwise. This cap is stated in the audit.
 */
function layaQuestion(candidates: ScoredCandidate[]): { criteria: Record<string, string>; keys: string[] } {
  const ranked = rank(candidates).filter((row) => row.excluded === null);
  const top = ranked.slice(0, 8);
  const cheapest = [...ranked].sort((a, b) => (a.candidate.price?.input ?? Infinity) - (b.candidate.price?.input ?? Infinity)).slice(0, 4);
  const picked = [...new Map([...top, ...cheapest].map((row) => [row.candidate.id, row])).values()].slice(0, 12);
  const criteria: Record<string, string> = {};
  const keys: string[] = [];
  picked.forEach((row, index) => {
    const key = `m${index}`;
    keys.push(row.candidate.id);
    const indexText = row.candidate.intelligenceIndex === null ? "intelligence unknown" : `intelligence ${row.candidate.intelligenceIndex}`;
    const priceText = row.candidate.price ? `$${row.candidate.price.input}/$${row.candidate.price.output} per 1M` : "price unknown";
    criteria[key] = `${row.candidate.displayName} (${row.candidate.provider}): ${indexText}, ${priceText}`;
  });
  return { criteria, keys };
}

/** The decision Laya makes, mapped back onto the pool. */
function probabilitiesFromLaya(result: LayaResult, candidates: ScoredCandidate[]): Map<string, number> | null {
  const answer = result.answers.model_fit;
  if (!answer || answer.type !== "choice") return null;
  const { criteria, keys } = layaQuestion(candidates);
  const out = new Map<string, number>();
  for (const [key, model] of keys.entries()) {
    const option = criteria[`m${key}`];
    if (!option) continue;
    const p = answer.probabilities[option];
    if (typeof p === "number" && Number.isFinite(p)) out.set(model, p);
  }
  return out.size ? out : null;
}

export interface RouterDeps {
  breaker?: CircuitBreaker;
  audit?: RouterAudit;
  candidates?: Candidate[];
  usage?: UsageSignal[];
  now?: number;
  /** Injected in tests so no HTTP happens. */
  ask?: typeof askLaya;
  url?: string;
  checkpoint?: string;
  /**
   * Decide without asking Laya at all — the deterministic policy alone. The
   * request carries the same flag for the normal path; this one lets a whole
   * suite (and an operator's dry run) run the decision logic with no service.
   */
  offline?: boolean;
}

export interface RouterStatus {
  enabled: boolean;
  /** Whether any provider is connected, i.e. whether the router can decide at all. */
  candidates: number;
  connected: number;
  layaUrl: string;
  layaCheckpoint: string;
  catalogLoaded: boolean;
  catalogModels: number;
  catalogUnknownIndex: number;
  breakers: BreakerStatus[];
  decisions24h: number;
  fallbacks24h: number;
}

/** Is the router on? The one gate every caller asks before routing anything. */
export function routerEnabled(): boolean {
  return loadSettings().modelRouterEnabled === true;
}

/** The Settings panel's view of the router: what it can see and what it would pick. */
export function routerStatus(deps: RouterDeps = {}): RouterStatus {
  const breaker = deps.breaker ?? breakerStore();
  const audit = deps.audit ?? auditStore();
  const now = deps.now ?? Date.now();
  const candidates = deps.candidates ?? buildCandidates();
  const catalog = loadCatalog();
  const counts = audit.counts(now - 86_400_000);
  let decisions = 0;
  let fallbacks = 0;
  for (const row of Object.values(counts)) {
    decisions += row.chosen + row.fallbacks;
    fallbacks += row.fallbacks;
  }
  return {
    enabled: routerEnabled(),
    candidates: candidates.length,
    connected: candidates.filter((c) => c.available).length,
    layaUrl: deps.url ?? layaUrl(),
    layaCheckpoint: deps.checkpoint ?? layaCheckpoint(),
    catalogLoaded: catalog.loaded,
    catalogModels: catalog.models.length,
    // How much of the catalog the router can rank by index, and how much it is
    // ranking on other grounds. The panel shows this so "unknown" is visible.
    catalogUnknownIndex: catalog.models.filter((m) => m.intelligenceIndex === null).length,
    breakers: breaker.list(now),
    decisions24h: decisions,
    fallbacks24h: fallbacks,
  };
}

/**
 * Decide a model. Never throws, never returns a model that is not in the pool,
 * and never picks at random.
 */
export async function route(request: RouteRequest, deps: RouterDeps = {}): Promise<RouteDecision> {
  const now = deps.now ?? Date.now();
  const breaker = deps.breaker ?? breakerStore();
  const audit = deps.audit ?? auditStore();
  const profile = request.level === "subtask" && !request.task ? profileSubTask([]) : profileTask(request.task);

  // ---- a manual pin short-circuits everything, and says so in the audit ----
  const pinned = (request.pinnedModel ?? "").trim();
  if (pinned) {
    return finish({
      decision: {
        model: pinned,
        level: request.level,
        source: "manual",
        reason: "manual model selection; the router does not override an explicit choice",
        layaProbability: null,
        layaConfidence: null,
        layaCheckpoint: "",
        layaReason: "",
        profile,
        candidates: [],
        auditId: 0,
        empty: false,
      },
      audit,
      request,
      from: request.from ?? "",
      fallbackReason: null,
    });
  }

  const pool = (deps.candidates ?? buildCandidates()).filter((c) => (request.allow?.length ? request.allow.includes(c.id) || request.allow.includes(c.provider) : true));
  const connected = pool.filter((c) => c.available);
  const usage = deps.usage ?? readUsageSignals(86_400_000, now);
  const breakers = breakerMap(breaker, pool, now);

  // ---- no connection: say so, do not guess ----
  if (!connected.length) {
    return finish({
      decision: {
        model: "",
        level: request.level,
        source: "deterministic",
        reason: pool.length ? "no provider connection for any catalogued model; the caller keeps its own model" : "the model catalog is missing or empty; the caller keeps its own model",
        layaProbability: null,
        layaConfidence: null,
        layaCheckpoint: "",
        layaReason: "",
        profile,
        candidates: [],
        auditId: 0,
        empty: true,
      },
      audit,
      request,
      from: request.from ?? "",
      fallbackReason: null,
    });
  }

  // ---- 1. Laya's calibrated view of the pool ----
  let layaResult: LayaResult | null = null;
  let layaProbabilities: Map<string, number> | null = null;
  if (!request.offline && !deps.offline) {
    const preliminary = rank(scoreCandidates({ candidates: connected, complexity: profile.complexity, usage, breakers, now }));
    const { criteria } = layaQuestion(preliminary);
    layaResult = await (deps.ask ?? askLaya)({
      state: buildState(request.task, profile),
      questions: {
        model_fit: {
          type: "choice",
          instructions:
            "Which of these language models is the best fit for the task above? Weigh reasoning difficulty against cost: a short, mechanical task wants the cheapest capable model, and a hard multi-file engineering task wants the strongest available model.",
          criteria,
        },
      },
      ...(deps.url ? { url: deps.url } : {}),
      ...(deps.checkpoint ? { checkpoint: deps.checkpoint } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (layaResult.ok) layaProbabilities = probabilitiesFromLaya(layaResult, preliminary);
  }

  // ---- 2. the ranking, with Laya as one weighted term ----
  const scored = scoreCandidates({
    candidates: connected,
    complexity: profile.complexity,
    usage,
    breakers,
    layaProbabilities,
    now,
  });
  const ranked = layaProbabilities ? rank(scored) : deterministicOrder(scored);
  const best = ranked[0];
  if (!best) {
    return finish({
      decision: {
        model: "",
        level: request.level,
        source: "deterministic",
        reason: "every connected model is excluded by the circuit breaker; the caller keeps its own model",
        layaProbability: null,
        layaConfidence: null,
        layaCheckpoint: layaResult?.checkpoint ?? "",
        layaReason: layaResult?.reason ?? "",
        profile,
        candidates: ranked,
        auditId: 0,
        empty: true,
      },
      audit,
      request,
      from: request.from ?? "",
      fallbackReason: null,
    });
  }

  // ---- 3. why, in one sentence ----
  const source: DecisionSource = layaProbabilities ? "laya" : "deterministic";
  const answer = layaResult?.answers.model_fit;
  const reason = layaProbabilities
    ? `laya ${answer?.type === "choice" ? answer.choice : ""} (P=${(layaProbabilities.get(best.candidate.id) ?? 0).toFixed(2)}); ${best.why.join(", ")}`
    : `laya unavailable (${layaResult?.reason || "not consulted"}); deterministic policy: ${best.why.join(", ")}`;

  return finish({
    decision: {
      model: best.candidate.id,
      level: request.level,
      source,
      reason,
      layaProbability: layaProbabilities?.get(best.candidate.id) ?? null,
      layaConfidence: answer && "confidence" in answer ? answer.confidence : null,
      layaCheckpoint: layaResult?.checkpoint ?? "",
      layaReason: layaProbabilities ? "" : layaResult?.reason ?? "offline",
      profile,
      candidates: ranked,
      auditId: 0,
      empty: false,
    },
    audit,
    request,
    from: request.from ?? "",
    fallbackReason: null,
  });
}

/**
 * The state Laya reads. Task text plus the variables a reader would need to
 * argue with the answer — but NOT the pool's own ranking, which would lead it.
 */
function buildState(task: string, profile: TaskProfile): string {
  const lines = [
    `task: ${profile.summary}`,
    `complexity: ${profile.complexity}`,
    `estimated_prompt_tokens: ${profile.estimatedTokens}`,
  ];
  if (profile.signals.length) lines.push(`signals: ${profile.signals.join(" | ")}`);
  return lines.join("\n");
}

function finish(args: {
  decision: RouteDecision;
  audit: RouterAudit;
  request: RouteRequest;
  from: string;
  fallbackReason: BreakerReason | null;
}): RouteDecision {
  const { decision } = args;
  try {
    decision.auditId = args.audit.record({
      at: Date.now(),
      level: decision.level,
      source: decision.source,
      chosen: decision.model || "(none)",
      reason: decision.reason,
      layaProbability: decision.layaProbability,
      layaConfidence: decision.layaConfidence,
      layaCheckpoint: decision.layaCheckpoint,
      layaReason: decision.layaReason,
      complexity: decision.profile.complexity,
      task: decision.profile.summary,
      candidates: decision.candidates.length,
      ranking: decision.candidates.slice(0, 12).map((row) => ({
        model: row.candidate.id,
        score: row.score,
        terms: row.terms,
        why: row.why,
        excluded: row.excluded,
      })),
      from: args.from,
      fallbackReason: args.fallbackReason,
    });
  } catch {
    // The audit must never take a run down with it.
  }
  return decision;
}

/**
 * Fallback: a model failed, so take its circuit out and ask again.
 *
 * The second call runs with `from` set, so the audit records the move as a
 * fallback with the reason, and the model that failed is *not* in the pool any
 * more (its breaker is open) — which is what makes the retry silent instead of
 * a second identical failure.
 */
export async function fallback(
  request: Omit<RouteRequest, "from">,
  failedModel: string,
  failure: { status?: number | null; message?: string; emptyContent?: boolean },
  deps: RouterDeps = {},
): Promise<RouteDecision> {
  const breaker = deps.breaker ?? breakerStore();
  const reason = classifyFailure(failure);
  const status = breaker.trip(failedModel, reason, failure.message ?? "", deps.now ?? Date.now());
  const decision = await route(
    { ...request, from: failedModel, // the failed model is filtered out by its own open circuit
      ...(deps.now !== undefined ? {} : {}) },
    deps,
  );
  decision.source = decision.model ? "fallback" : decision.source;
  decision.reason = `${failedModel} failed (${reasonLabel(reason)}); ${decision.reason}`;
  // Re-record with the fallback provenance so the trail says what happened.
  try {
    const audit = deps.audit ?? auditStore();
    decision.auditId = audit.record({
      at: Date.now(),
      level: decision.level,
      source: "fallback",
      chosen: decision.model || "(none)",
      reason: decision.reason,
      layaProbability: decision.layaProbability,
      layaConfidence: decision.layaConfidence,
      layaCheckpoint: decision.layaCheckpoint,
      layaReason: decision.layaReason,
      complexity: decision.profile.complexity,
      task: decision.profile.summary,
      candidates: decision.candidates.length,
      ranking: decision.candidates.slice(0, 12).map((row) => ({ model: row.candidate.id, score: row.score, terms: row.terms, why: row.why, excluded: row.excluded })),
      from: failedModel,
      fallbackReason: reason,
    });
  } catch {
    // best-effort
  }
  void status;
  return decision;
}

/** Close a circuit on a call that worked — the only way a tripped model returns. */
export function succeed(model: string, deps: RouterDeps = {}): void {
  (deps.breaker ?? breakerStore()).close(model);
}

export { breakerStore, auditStore, profileTask, profileSubTask };
export type { Candidate, BreakerStatus, ScoredCandidate, UsageSignal, TaskProfile };