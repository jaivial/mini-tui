/**
 * v6-C: the variables, and the ranking they produce.
 *
 * Six inputs decide a routing decision, and each one is named here so the audit
 * can print *what weighed* rather than a bare winner:
 *
 * | variable          | source                                  | used as |
 * |-------------------|-----------------------------------------|---------|
 * | `intelligence`    | catalog index (Artificial Analysis)      | weight  |
 * | `price`           | catalog, USD/1M blended                 | weight  |
 * | `quota`           | usage ledger over the window            | filter + weight |
 * | `availability`    | circuit breaker + recent failures        | filter  |
 * | `latency`         | measured mean latency in the window      | weight  |
 * | `complexity`      | the task text (see `task.ts`)            | demand  |
 *
 * Two rules keep this honest:
 *
 * - **An unknown is not a number.** 28 of the 62 catalogued models have no
 *   intelligence index ("desconocido"), and many have no price. Those models are
 *   not ranked mid-table on an invented value: they are ranked on what IS known
 *   (availability, quota, latency, price when it exists) and the audit records
 *   the missing fields. A model with no index and no price is only ever chosen
 *   when everything better is blocked or unaffordable — and says so.
 * - **Availability and quota are filters, not penalties.** A model whose quota
 *   window is spent or whose circuit is open does not get a low score and lose
 *   to a rival; it is removed. Ranking a call that cannot succeed would make
 *   the router slower and no wiser.
 *
 * The deterministic policy (Laya absent) is the same ranking with the Laya term
 * at zero weight: most intelligent first, then cheapest, then fastest. **Never
 * random** — a tie is broken by a stable, stated order.
 */
import type { Candidate } from "./candidates";
import type { BreakerStatus } from "./breaker";
import type { Complexity } from "./task";

/** What the usage ledger says about a model over a window. */
export interface UsageSignal {
  provider: string;
  model: string;
  calls: number;
  errors: number;
  avgLatencyMs: number | null;
  costUsd: number | null;
  /** Epoch ms of the last call, or null when the model has never been used. */
  lastUsedAt: number | null;
}

export interface RouterWeights {
  intelligence: number;
  price: number;
  quota: number;
  latency: number;
  /** The task-complexity match: a hard task demands a higher index floor. */
  complexity: number;
  /** What Laya believes, when it answered. Zero = the deterministic policy. */
  laya: number;
}

export const DEFAULT_WEIGHTS: RouterWeights = {
  intelligence: 0.34,
  price: 0.18,
  quota: 0.14,
  latency: 0.08,
  complexity: 0.26,
  laya: 0.55,
};

export interface ScoredCandidate {
  candidate: Candidate;
  /** Total score, higher is better. Only comparable within one decision. */
  score: number;
  /** Every term, with the value that went into it — the audit's "why". */
  terms: {
    intelligence: number | null;
    price: number | null;
    quota: number | null;
    latency: number | null;
    complexity: number | null;
    laya: number | null;
  };
  /** The plain-language reason this model ended up where it did. */
  why: string[];
  /** Set when the model was filtered out before scoring. */
  excluded: string | null;
}

/** Blended USD/1M: 3 input : 1 output, the ratio agent runs actually produce. */
export function blendedPrice(candidate: Candidate): number | null {
  if (!candidate.price) return null;
  return (candidate.price.input * 3 + candidate.price.output) / 4;
}

/** Every term null: a model removed before scoring has no measured variables. */
function emptyTerms(): ScoredCandidate["terms"] {
  return { intelligence: null, price: null, quota: null, latency: null, complexity: null, laya: null };
}

/**
 * Normalise a raw number into 0..1 against the pool's own min/max.
 *
 * A pool-relative normalisation, deliberately: an absolute "index ≥ 40 is good"
 * rule would need a scale that changes with the catalog, and the catalog is
 * regenerated. Within one decision the ranking is what matters, and the audit
 * prints the raw number next to it.
 */
function normalise(value: number | null, values: number[], invert = false): number | null {
  if (value === null || !values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0.5;
  const scaled = (value - min) / (max - min);
  return Number((invert ? 1 - scaled : scaled).toFixed(4));
}

/**
 * How well a model's capability matches the task.
 *
 * `hard` demands the top of the pool and refuses anything below the median
 * unless nothing better is reachable; `trivial` inverts it, because the cheapest
 * capable model is the right answer for a rename. `standard` takes the middle.
 */
export function complexityFit(index: number | null, complexity: Complexity, pool: number[]): number | null {
  if (index === null || !pool.length) return null;
  const sorted = [...pool].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const floor = sorted[Math.floor(sorted.length * 0.15)]!;
  const ceiling = sorted[Math.floor(sorted.length * 0.85)]!;
  const span = Math.max(ceiling - floor, 1e-6);
  const position = Math.min(1, Math.max(0, (index - floor) / span));
  switch (complexity) {
    case "hard":
      // A hard task on a below-median model is a task that will be redone.
      return index < median ? Math.max(0, position * 0.35) : 0.35 + 0.65 * position;
    case "trivial":
      // The right model for a chore is the cheapest one that can still do it.
      return 1 - position * 0.8;
    default:
      return 0.35 + 0.5 * position;
  }
}

/** Error rate over a window, as a 0..1 penalty (1 = never failed). */
function reliability(signal: UsageSignal | undefined): number | null {
  if (!signal || !signal.calls) return null;
  return Number(Math.max(0, 1 - signal.errors / signal.calls).toFixed(4));
}

export interface ScoreInput {
  candidates: Candidate[];
  complexity: Complexity;
  usage: UsageSignal[];
  breakers: Map<string, BreakerStatus>;
  /** Laya's calibrated P(model) per model id, when it answered. */
  layaProbabilities?: Map<string, number> | null;
  weights?: Partial<RouterWeights>;
  now?: number;
}

/**
 * How decisively Laya answered, on 0..1.
 *
 * The margin between its best option and the runner-up: 0.6 for a 0.8/0.2
 * split, 0 for a coin flip, and near 0 for a flat distribution over a dozen
 * models. This is what decides how much Laya's opinion counts — Laya is the
 * decision model, but a model that cannot tell two options apart has not decided
 * anything, and averaging its flat distribution in as one term among six is how
 * a "Laya decided" decision ends up being the catalog's decision wearing Laya's
 * label.
 */
export function layaMargin(probabilities: Map<string, number> | null | undefined): number {
  if (!probabilities || probabilities.size < 2) return 0;
  const sorted = [...probabilities.values()].sort((a, b) => b - a);
  const margin = (sorted[0] ?? 0) - (sorted[1] ?? 0);
  return Number(Math.max(0, Math.min(1, margin)).toFixed(4));
}

/**
 * Score the pool. Deterministic given the same inputs and `now` — no clock reads,
 * no randomness, no I/O — which is what makes a decision reproducible in a test
 * and arguable in the audit.
 */
export function scoreCandidates(input: ScoreInput): ScoredCandidate[] {
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const usage = new Map(input.usage.map((row) => [row.model, row]));
  const prices = input.candidates.map(blendedPrice).filter((p): p is number => p !== null);
  const indexes = input.candidates.map((c) => c.intelligenceIndex).filter((i): i is number => i !== null);
  const latencies = input.usage.map((row) => row.avgLatencyMs).filter((l): l is number => l !== null && l > 0);
  const margin = layaMargin(input.layaProbabilities);
  const now = input.now ?? Date.now();

  return input.candidates.map((candidate) => {
    const signal = usage.get(candidate.id);
    const breaker = input.breakers.get(candidate.id);
    const why: string[] = [];

    // ---- filters: a call that cannot succeed is not ranked, it is removed ----
    if (!candidate.available) {
      return { candidate, score: -1, terms: emptyTerms(), why, excluded: "no saved connection for this provider" };
    }
    if (breaker?.blocked) {
      return {
        candidate,
        score: -1,
        terms: emptyTerms(),
        why: [`circuit open (${breaker.reason})`],
        excluded: `circuit open until ${breaker.retryAt ? new Date(breaker.retryAt).toISOString() : "it is reset"}`,
      };
    }

    // ---- terms ----
    const rawPrice = blendedPrice(candidate);
    const terms: ScoredCandidate["terms"] = {
      intelligence: candidate.intelligenceIndex,
      price: rawPrice,
      quota: null,
      latency: signal?.avgLatencyMs ?? null,
      complexity: complexityFit(candidate.intelligenceIndex, input.complexity, indexes),
      laya: input.layaProbabilities?.get(candidate.id) ?? null,
    };

    // Quota pressure: a provider this house already spent heavily this window is
    // more likely to be near its cap. Unknown (no usage) is null, never 1.
    const tokens = signal ? (signal.calls > 0 ? 1 : 0) : null;
    const spend = signal?.costUsd ?? null;
    terms.quota = signal ? Number(Math.max(0.15, 1 - (signal.errors / Math.max(signal.calls, 1)) * 0.6 - (tokens ? 0.05 : 0)).toFixed(4)) : null;

    const nPrice = normalise(rawPrice, prices, true);
    const nLatency = normalise(signal?.avgLatencyMs ?? null, latencies, true);
    const nReliability = normalise(reliability(signal), [0, 1]);
    // Quota blends spend and reliability: burning the window and failing in it
    // are the same problem from the router's side.
    const nQuota = terms.quota === null ? null : Number(((terms.quota + (nReliability ?? 0.5)) / 2).toFixed(4));

    let score = 0;
    let weightUsed = 0;
    const add = (term: number | null | undefined, weight: number) => {
      if (term === null || term === undefined || !Number.isFinite(term)) return;
      score += term * weight;
      weightUsed += weight;
    };
    // The index is a normalised position, not the raw number, so a 19 and a 53
    // from the same catalog are comparable even when the catalog is regenerated.
    add(normalise(candidate.intelligenceIndex, indexes), weights.intelligence);
    add(nPrice, weights.price);
    add(nQuota, weights.quota);
    add(nLatency, weights.latency);
    add(terms.complexity, weights.complexity);

    // A model whose index nobody sourced is ranked on what IS known. Dividing by
    // the weight actually applied keeps it from being punished for the gap, and
    // the audit still names the gap.
    score = weightUsed > 0 ? score / weightUsed : 0;

    // Laya is mixed in *after* the catalog score, not as another averaged term:
    // a 0.8/0.2 split has to be able to beat a 2-point index gap, or the decision
    // model decides nothing and every answer is really the catalog's. The
    // confidence margin sets how far it counts — a confident Laya leads, a flat
    // one defers to the variables it was shown.
    if (terms.laya !== null && margin > 0) {
      score = score * (1 - margin) + terms.laya * margin;
    }

    score = Number(score.toFixed(6));

    why.push(
      candidate.intelligenceIndex === null
        ? "intelligence index unknown (not sourced in the catalog)"
        : `intelligence ${candidate.intelligenceIndex}`,
    );
    if (rawPrice === null) why.push("price unknown (not sourced in the catalog)");
    else why.push(`$${rawPrice.toFixed(3)}/1M blended`);
    if (terms.laya !== null) why.push(`laya P=${terms.laya.toFixed(3)}`);
    if (breaker?.state === "half-open") why.push("circuit half-open (one probe)");
    if (signal?.avgLatencyMs) why.push(`latency ${Math.round(signal.avgLatencyMs)}ms`);
    if (signal?.errors) why.push(`${signal.errors} error(s) in window`);
    void spend;
    void now;

    return { candidate, score, terms, why, excluded: null };
  });
}

/** Ranked, best first. Excluded models sink to the bottom in a stable order. */
export function rank(scored: ScoredCandidate[]): ScoredCandidate[] {
  return [...scored].sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded === null ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    // The stated tie-break: more intelligent, then cheaper, then faster, then id.
    const ai = a.candidate.intelligenceIndex ?? -1;
    const bi = b.candidate.intelligenceIndex ?? -1;
    if (bi !== ai) return bi - ai;
    const ap = blendedPrice(a.candidate) ?? Number.POSITIVE_INFINITY;
    const bp = blendedPrice(b.candidate) ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    return a.candidate.id.localeCompare(b.candidate.id);
  });
}

/**
 * The deterministic policy, stated in one line: **most intelligent first, then
 * cheapest, then fastest, then id.** This is what runs when Laya is unavailable
 * or failed, and it is also the tie-break inside the Laya ranking, so the two
 * policies can never disagree about a tie.
 */
export function deterministicOrder(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return rank(candidates);
}