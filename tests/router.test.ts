/**
 * v6-C: the model router.
 *
 * What is pinned here, beyond the arithmetic:
 *
 * - **unknown is never zero.** The catalog marks what it could not source with
 *   the literal string `"desconocido"` (28 of 62 models have no intelligence
 *   index). A model with an unknown index must be ranked on what IS known and
 *   must say so — never given a mid-table score on an invented number, and never
 *   reported as free.
 * - **the circuit persists across restarts.** A breaker that forgets a spent
 *   quota the moment the server restarts walks straight back into the 429 that
 *   just emptied the window, so the state is reopened from disk and must block.
 * - **fallback is automatic and it is not random.** 429 / 402 / 403 / 5xx /
 *   timeout / empty content each take their model out and the next decision must
 *   differ; with Laya down the deterministic policy decides, never a coin.
 * - **Laya is asked, and its answer is weighted.** A stub Laya that prefers the
 *   weak model must actually move the decision; an unreachable one must leave it
 *   standing on the catalog variables alone.
 * - **the toggle is the whole contract when off.** With it off the router is not
 *   consulted, so the manual selector is the only thing that picks a model.
 * - **every decision is auditable**: why, Laya's probability, and the variables
 *   that weighed, all readable back out of the store.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CircuitBreaker,
  breakerDbPath,
  classifyFailure,
  reasonLabel,
  type BreakerReason,
  type BreakerStatus,
} from "../src/router/breaker";
import { RouterAudit, auditStore, resetAuditStore, routerDbPath } from "../src/router/audit";
import { buildCandidates, loadCatalog, resetCatalogCache, catalogPath } from "../src/router/candidates";
import { askLaya, layaCheckpoint, layaUrl, parseLayaResponse } from "../src/router/laya";
import { deterministicOrder, rank, scoreCandidates, type ScoredCandidate, type UsageSignal } from "../src/router/scoring";
import { profileSubTask, profileTask } from "../src/router/task";
import { fallback, route, routerEnabled, routerStatus, succeed, type RouterDeps } from "../src/router";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../src/settings";
import type { TrajectoryMessage } from "../src/traj/schema";

let dir: string;

const NOW = 1_760_000_000_000;

function settingsPath(): string {
  return join(dir, "settings.json");
}

/** Two connected models, one strong/expensive and one weak/cheap, both priced. */
const POOL = [
  {
    id: "zai/glm-5.3",
    provider: "zai",
    apiModelId: "glm-5.3",
    displayName: "GLM 5.3",
    intelligenceIndex: 45,
    indexSource: "Artificial Analysis Intelligence Index v4.3.2",
    price: { input: 1.4, output: 4.4 },
    context: { maxTokens: null, label: "desconocido" },
    available: true,
    unknowns: [],
  },
  {
    id: "opencode-go/claude-haiku-5-5",
    provider: "opencode-go",
    apiModelId: "claude-haiku-5-5",
    displayName: "CLAUDE Haiku 5.5",
    intelligenceIndex: 43,
    indexSource: "Artificial Analysis Intelligence Index v4.3.2",
    price: { input: 0.1, output: 0.5 },
    context: { maxTokens: 100_000, label: "≤100K tokens" },
    available: true,
    unknowns: [],
  },
];

/** A model with nothing sourced: no index, no price. The router must say so. */
const UNKNOWN_MODEL = {
  id: "kimi-coding/k3",
  provider: "kimi-coding",
  apiModelId: "k3",
  displayName: "Kimi K3",
  intelligenceIndex: null,
  indexSource: "",
  price: null,
  context: { maxTokens: null, label: "desconocido" },
  available: true,
  unknowns: ["price", "intelligenceIndex", "contextTier"],
};

/** A Laya stub that answers instantly with a fixed distribution. */
function stubLaya(probabilities: Record<string, number>, confidence = 0.8) {
  return async (request: { questions: Record<string, { criteria?: Record<string, string> | string[] }> }): Promise<never> => {
    const criteria = request.questions.model_fit?.criteria as Record<string, string> | undefined;
    const out: Record<string, number> = {};
    for (const key of Object.keys(criteria ?? {})) out[key] = probabilities[key] ?? 0;
    return {
      ok: true,
      answers: { model_fit: { type: "choice", choice: Object.entries(out).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "", probabilities: out, confidence } },
      checkpoint: "multilingual",
      reason: "",
      latencyMs: 1,
    } as never;
  };
}

const OFFLINE = { offline: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minitui-router-"));
  process.env.MINITUI_SETTINGS_PATH = settingsPath();
  process.env.MINITUI_ROUTER_DB = join(dir, "router.sqlite");
  process.env.MINITUI_USAGE_DB = join(dir, "usage.sqlite");
  resetCatalogCache();
  resetAuditStore();
});

afterEach(() => {
  resetCatalogCache();
  resetAuditStore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.MINITUI_SETTINGS_PATH;
  delete process.env.MINITUI_ROUTER_DB;
  delete process.env.MINITUI_USAGE_DB;
});

// ------------------------------------------------------------------ the catalog

describe("catalog", () => {
  test("reads the shipped catalog: providers, models, rules", () => {
    const catalog = loadCatalog(catalogPath());
    expect(catalog.loaded).toBe(true);
    expect(catalog.providers.length).toBeGreaterThanOrEqual(5);
    expect(catalog.models.length).toBeGreaterThanOrEqual(60);
    // The 13 fallback rules the catalog documents are the router's own authority.
    expect(catalog.errorFallbackRules.length).toBeGreaterThanOrEqual(13);
    expect(catalog.errorFallbackRules.map((r) => r.httpStatus)).toContain(429);
  });

  test("'desconocido' is unknown, never 0 and never a price", () => {
    const catalog = loadCatalog(catalogPath());
    // The catalog is explicit that these are unsourced; the router must see null.
    const unsourced = catalog.models.filter((m) => m.intelligenceIndex === null);
    expect(unsourced.length).toBeGreaterThan(0);
    for (const model of unsourced) expect(model.intelligenceIndex).toBeNull();
    const candidates = buildCandidates({ catalogOnly: true });
    for (const candidate of candidates) {
      if (candidate.intelligenceIndex === null) expect(candidate.unknowns).toContain("intelligenceIndex");
      if (candidate.price === null) expect(candidate.unknowns).toContain("price");
    }
  });

  test("a missing or malformed catalog yields no models, and no crash", () => {
    const bad = join(dir, "nope.json");
    expect(loadCatalog(bad).loaded).toBe(false);
    writeFileSync(join(dir, "bad.json"), "{not json");
    const catalog = loadCatalog(join(dir, "bad.json"));
    expect(catalog.loaded).toBe(false);
    expect(catalog.models).toEqual([]);
  });

  test("a context tier in prose is not silently read as 'no limit'", () => {
    const candidates = buildCandidates({ catalogOnly: true });
    const legacy = candidates.find((c) => c.context.label === "legacy");
    expect(legacy?.context.maxTokens).toBeNull();
    const numeric = candidates.find((c) => c.context.maxTokens !== null);
    expect(numeric?.context.maxTokens).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ the task classifier

describe("task profile", () => {
  test("reads a chore as trivial and a refactor as hard", () => {
    expect(profileTask("rename this variable, it is a typo").complexity).toBe("trivial");
    expect(profileTask("list the files in src").complexity).toBe("trivial");
    const hard = profileTask("design the architecture for the distributed consensus layer and find the race condition");
    expect(hard.complexity).toBe("hard");
    expect(hard.score).toBeGreaterThan(profileTask("add a test").score);
  });

  test("an ambiguous task sits in the middle, not at the bottom", () => {
    const profile = profileTask("hola");
    expect(profile.complexity).toBe("standard");
    // No signal is evidence of an unclear task, never of a simple one.
    expect(profile.score).toBeGreaterThanOrEqual(0.5);
  });

  test("a long prompt is long however it is worded", () => {
    const profile = profileTask("x".repeat(40_000));
    expect(profile.estimatedTokens).toBeGreaterThan(4_000);
    expect(profile.signals).toContain("long-context");
  });

  test("a sub-task is read from the run's own trajectory", () => {
    const messages: TrajectoryMessage[] = [
      { role: "user", content: "implement the parser" },
      { role: "assistant", content: "working", extra: { task: "fix a race condition in the concurrent token refresh path" } },
    ];
    const profile = profileSubTask(messages);
    expect(profile.phase).toBe("declared");
    expect(profile.complexity).toBe("hard");
  });
});

// ------------------------------------------------------------------ the ranking

describe("scoring", () => {
  const noBreakers = new Map<string, BreakerStatus>();

  test("a hard task goes to the strongest model and a chore to the cheapest", () => {
    const hard = rank(scoreCandidates({ candidates: POOL, complexity: "hard", usage: [], breakers: noBreakers, now: NOW }));
    expect(hard[0]?.candidate.id).toBe("zai/glm-5.3");
    const trivial = rank(scoreCandidates({ candidates: POOL, complexity: "trivial", usage: [], breakers: noBreakers, now: NOW }));
    expect(trivial[0]?.candidate.id).toBe("opencode-go/claude-haiku-5-5");
  });

  test("an unknown index is ranked on what is known and named as unknown", () => {
    const scored = scoreCandidates({ candidates: [...POOL, UNKNOWN_MODEL], complexity: "standard", usage: [], breakers: noBreakers, now: NOW });
    const unknown = scored.find((row) => row.candidate.id === "kimi-coding/k3");
    expect(unknown?.terms.intelligence).toBeNull();
    expect(unknown?.terms.price).toBeNull();
    expect(unknown?.why.join(" ")).toContain("unknown");
    // Never rendered as free: the price term stays null.
    expect(unknown?.score).toBeGreaterThanOrEqual(0);
  });

  test("an unavailable model and an open circuit are excluded, not scored low", () => {
    const pool = [...POOL, { ...UNKNOWN_MODEL, available: false }];
    const breakers = new Map<string, BreakerStatus>([["zai/glm-5.3", { model: "zai/glm-5.3", state: "open", blocked: true, reason: "rate-limited", detail: "", failures: 1, retryAt: NOW + 60_000 }]]);
    const scored = scoreCandidates({ candidates: pool, complexity: "hard", usage: [], breakers, now: NOW });
    expect(scored.find((r) => r.candidate.id === "kimi-coding/k3")?.excluded).toContain("no saved connection");
    expect(scored.find((r) => r.candidate.id === "zai/glm-5.3")?.excluded).toContain("circuit open");
    // And it is not the winner despite being the strongest.
    expect(rank(scored)[0]?.candidate.id).not.toBe("zai/glm-5.3");
  });

  test("the deterministic policy is most-intelligent-first, then cheapest — never random", () => {
    const first = deterministicOrder(scoreCandidates({ candidates: [...POOL].reverse(), complexity: "standard", usage: [], breakers: noBreakers, now: NOW }));
    const second = deterministicOrder(scoreCandidates({ candidates: POOL, complexity: "standard", usage: [], breakers: noBreakers, now: NOW }));
    expect(first.map((r) => r.candidate.id)).toEqual(second.map((r) => r.candidate.id));
    // A tie is broken by id, so the order is total and repeatable.
    const tied = deterministicOrder(
      scoreCandidates({
        candidates: [POOL[0]!, { ...POOL[0]!, id: "zai/aaa" }, { ...POOL[0]!, id: "zai/zzz" }],
        complexity: "standard",
        usage: [],
        breakers: noBreakers,
        now: NOW,
      }),
    );
    expect(tied.map((r) => r.candidate.id)).toEqual(["zai/aaa", "zai/glm-5.3", "zai/zzz"]);
  });

  test("a model that keeps failing in the window loses quota weight", () => {
    const clean: UsageSignal[] = [{ provider: "zai", model: "zai/glm-5.3", calls: 10, errors: 0, avgLatencyMs: 1_000, costUsd: 1, lastUsedAt: NOW }];
    const flaky: UsageSignal[] = [{ provider: "zai", model: "zai/glm-5.3", calls: 10, errors: 8, avgLatencyMs: 1_000, costUsd: 1, lastUsedAt: NOW }];
    const good = scoreCandidates({ candidates: POOL, complexity: "hard", usage: clean, breakers: noBreakers, now: NOW });
    const bad = scoreCandidates({ candidates: POOL, complexity: "hard", usage: flaky, breakers: noBreakers, now: NOW });
    const a = good.find((r) => r.candidate.id === "zai/glm-5.3")!;
    const b = bad.find((r) => r.candidate.id === "zai/glm-5.3")!;
    expect(b.score).toBeLessThan(a.score);
    expect(b.why.join(" ")).toContain("error");
  });
});

// ------------------------------------------------------------------ the breaker

describe("circuit breaker", () => {
  let breaker: CircuitBreaker;
  beforeEach(() => {
    breaker = new CircuitBreaker(join(dir, "breakers.sqlite"));
  });
  // `dispose()`, not `close()`: the circuit-closing call now takes a model id,
  // and a store whose handle is already released cannot close a circuit either.
  afterEach(() => breaker.dispose());

  test("a 429 opens the circuit and blocks the model", () => {
    expect(breaker.status("zai/glm-5.3").blocked).toBe(false);
    breaker.trip("zai/glm-5.3", "rate-limited", "429", NOW);
    const status = breaker.status("zai/glm-5.3", NOW);
    expect(status.blocked).toBe(true);
    expect(status.state).toBe("open");
    expect(status.retryAt).toBeGreaterThan(NOW);
  });

  test("it survives a restart: a new store over the same file still blocks", () => {
    breaker.trip("zai/glm-5.3", "rate-limited", "429", NOW);
    breaker.dispose();
    // A brand-new process opening the same database — the restart case.
    const reopened = new CircuitBreaker(join(dir, "breakers.sqlite"));
    expect(reopened.status("zai/glm-5.3", NOW).blocked).toBe(true);
    reopened.dispose();
  });

  test("a cooldown that elapsed lets one probe through, and success closes it", () => {
    breaker.trip("zai/glm-5.3", "rate-limited", "", NOW);
    const later = NOW + 3_600_000;
    expect(breaker.status("zai/glm-5.3", later).state).toBe("half-open");
    expect(breaker.status("zai/glm-5.3", later).blocked).toBe(false);
    breaker.close("zai/glm-5.3");
    expect(breaker.status("zai/glm-5.3", later).state).toBe("closed");
  });

  test("a revoked key never reopens on a timer", () => {
    breaker.trip("zai/glm-5.3", "auth", "401", NOW);
    const much = NOW + 86_400_000 * 7;
    expect(breaker.status("zai/glm-5.3", much).blocked).toBe(true);
    expect(breaker.reset("zai/glm-5.3")).toBe(true);
    expect(breaker.status("zai/glm-5.3", much).blocked).toBe(false);
  });

  test("repeated failures escalate the cooldown", () => {
    const first = breaker.trip("a/b", "server-error", "", NOW);
    const second = breaker.trip("a/b", "server-error", "", NOW);
    expect(second.failures).toBe(first.failures + 1);
    expect(second.retryAt).toBeGreaterThan(first.retryAt);
  });

  test("every failure shape this house has seen is classified", () => {
    expect(classifyFailure({ status: 429 })).toBe("rate-limited");
    expect(classifyFailure({ status: 402 })).toBe("payment-required");
    expect(classifyFailure({ status: 403 })).toBe("quota-exhausted");
    expect(classifyFailure({ status: 401 })).toBe("auth");
    expect(classifyFailure({ status: 500 })).toBe("server-error");
    expect(classifyFailure({ status: 503 })).toBe("server-error");
    expect(classifyFailure({ status: null, message: "Request timed out" })).toBe("timeout");
    expect(classifyFailure({ message: "fetch failed" })).toBe("timeout");
    // The house's known glm-5.3-flash case: HTTP 200, null content.
    expect(classifyFailure({ status: 200, emptyContent: true })).toBe("empty-content");
    expect(classifyFailure({ status: null, message: "429 too many requests" })).toBe("rate-limited");
    expect(classifyFailure({ status: null, message: "insufficient credits" })).toBe("payment-required");
    expect(classifyFailure({ status: null, message: "something odd" })).toBe("unknown");
    expect(reasonLabel("empty-content")).toContain("empty content");
  });
});

// ------------------------------------------------------------------ Laya

describe("laya client", () => {
  test("the wire default is the house's Laya service, on the multilingual checkpoint", () => {
    // The base English checkpoint measured near chance on model-choice questions
    // (0.54/0.46 at confidence 0.005) with an invalid-temperature warning, so the
    // router pins multilingual.
    expect(layaCheckpoint({})).toBe("laya-multilingual");
    expect(layaUrl({})).toContain("127.0.0.1");
  });

  test("an explicit env overrides both", () => {
    expect(layaUrl({ MINITUI_LAYA_URL: "http://box:9000/v1/systemone" } as NodeJS.ProcessEnv)).toBe("http://box:9000/v1/systemone");
    expect(layaCheckpoint({ MINITUI_LAYA_MODEL: "laya" } as NodeJS.ProcessEnv)).toBe("laya");
  });

  test("a reply with probabilities is parsed; one without is refused", () => {
    const good = JSON.stringify({
      answers: { pick: { type: "choice", choice: "b", probabilities: { a: 0.3, b: 0.7 }, confidence: 0.4 } },
      routing: { model: "multilingual" },
    });
    const parsed = parseLayaResponse(good);
    expect(parsed.answers.pick?.type).toBe("choice");
    expect((parsed.answers.pick as { probabilities: Record<string, number> }).probabilities.b).toBe(0.7);
    expect(parsed.checkpoint).toBe("multilingual");
    // No distribution = nothing to rank: this must throw, not default to 1.
    expect(() => parseLayaResponse(JSON.stringify({ answers: { pick: { type: "choice", choice: "b" } } }))).toThrow();
    expect(() => parseLayaResponse(JSON.stringify({ answers: {} }))).toThrow();
    expect(() => parseLayaResponse("not json")).toThrow();
  });

  test("truncated evidence is refused rather than ranked on", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ answers: { model_fit: { type: "choice", choice: "m0", probabilities: { m0: 1 }, confidence: 1 } }, usage: { truncated: true } }),
    });
    try {
      const result = await askLaya({ state: "x", questions: { model_fit: { type: "choice", instructions: "i" } }, url: `${server.url}/v1/systemone`, timeoutMs: 2_000 });
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("truncated");
    } finally {
      server.stop(true);
    }
  });

  test("an unreachable Laya reports why and does not throw", async () => {
    const result = await askLaya({ state: "x", questions: {}, url: "http://127.0.0.1:1/v1/systemone", timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("a non-http url is refused without a request", async () => {
    const result = await askLaya({ state: "x", questions: {}, url: "file:///etc/passwd", timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("http");
  });
});

// ------------------------------------------------------------------ the router

describe("route", () => {
  const deps = (extra: Partial<RouterDeps> = {}): RouterDeps => ({ candidates: POOL, usage: [], now: NOW, ...extra });

  test("a hard task goes to the strongest connected model", async () => {
    const decision = await route({ level: "task", task: "design the architecture for a distributed consensus layer and find the race condition" }, deps(OFFLINE));
    expect(decision.model).toBe("zai/glm-5.3");
    expect(decision.source).toBe("deterministic");
    expect(decision.layaReason).toBe("offline");
    expect(decision.reason).toContain("intelligence 45");
  });

  test("a chore goes to the cheapest capable model", async () => {
    const decision = await route({ level: "task", task: "rename this typo in the comment" }, deps(OFFLINE));
    expect(decision.model).toBe("opencode-go/claude-haiku-5-5");
  });

  test("a manual pin is returned untouched and audited as manual", async () => {
    const decision = await route({ level: "task", task: "anything", pinnedModel: "deepseek/deepseek-chat" }, deps(OFFLINE));
    expect(decision.model).toBe("deepseek/deepseek-chat");
    expect(decision.source).toBe("manual");
    expect(decision.reason).toContain("manual");
  });

  test("with nothing connected it says so instead of guessing", async () => {
    const decision = await route({ level: "task", task: "fix the bug" }, deps({ candidates: POOL.map((c) => ({ ...c, available: false })), ...OFFLINE }));
    expect(decision.model).toBe("");
    expect(decision.empty).toBe(true);
    expect(decision.reason).toContain("no provider connection");
  });

  test("when every model is circuit-blocked it says so", async () => {
    const breaker = breakerWith(join(dir, "all-blocked.sqlite"), POOL.map((c) => c.id));
    try {
      const decision = await route({ level: "task", task: "fix the bug" }, deps({ breaker, ...OFFLINE }));
      expect(decision.model).toBe("");
      expect(decision.reason).toContain("circuit breaker");
    } finally {
      breaker.dispose();
    }
  });

  test("a Laya that prefers the cheap model moves the decision", async () => {
    const ask = stubLaya({ m0: 0.2, m1: 0.8 });
    const decision = await route({ level: "task", task: "design the architecture for a distributed consensus layer and find the race condition" }, deps({ ...OFFLINE, ask } as Partial<RouterDeps>));
    expect(decision.source).toBe("laya");
    expect(decision.layaCheckpoint).toBe("multilingual");
    expect(decision.layaProbability).not.toBeNull();
    expect(decision.reason).toContain("laya");
    expect(decision.auditId).toBeGreaterThan(0);
  });

  test("an unreachable Laya still decides, from the catalog variables alone", async () => {
    const ask = async () => ({ ok: false, answers: {}, checkpoint: "multilingual", reason: "laya timed out", latencyMs: 1 }) as never;
    const decision = await route({ level: "task", task: "design the architecture and find the race condition" }, deps({ ...OFFLINE, ask } as Partial<RouterDeps>));
    expect(decision.source).toBe("deterministic");
    expect(decision.layaReason).toBe("laya timed out");
    expect(decision.model).toBe("zai/glm-5.3");
  });

  test("the decision is stable: the same input gives the same model", async () => {
    const first = await route({ level: "task", task: "refactor the auth module and fix a race condition" }, deps(OFFLINE));
    const second = await route({ level: "task", task: "refactor the auth module and fix a race condition" }, deps(OFFLINE));
    expect(second.model).toBe(first.model);
  });

  test("a decision never returns a model outside the pool", async () => {
    const decision = await route({ level: "task", task: "anything at all" }, deps(OFFLINE));
    expect(POOL.map((c) => c.id)).toContain(decision.model);
  });
});

// ------------------------------------------------------------------ fallback

describe("fallback", () => {
  const deps = (extra: Partial<RouterDeps> = {}): RouterDeps => ({ candidates: POOL, usage: [], now: NOW, offline: true, ...extra });

  test("a 429 takes the model out and the next decision differs", async () => {
    const breaker = new CircuitBreaker(join(dir, "fb.sqlite"));
    try {
      const decision = await fallback({ level: "task", task: "design the architecture and find the race condition" }, "zai/glm-5.3", { status: 429, message: "429 rate limit" }, deps({ breaker }));
      expect(decision.model).toBe("opencode-go/claude-haiku-5-5");
      expect(decision.source).toBe("fallback");
      expect(decision.reason).toContain("429");
      // And the failed model stays out for the next decision.
      expect(breaker.status("zai/glm-5.3", NOW).blocked).toBe(true);
      const next = await route({ level: "task", task: "design the architecture and find the race condition" }, deps({ breaker }));
      expect(next.model).not.toBe("zai/glm-5.3");
    } finally {
      breaker.dispose();
    }
  });

  test("every failure shape moves the model off the failed one", async () => {
    for (const failure of [
      { status: 429, message: "rate limited" },
      { status: 402, message: "insufficient credits" },
      { status: 403, message: "quota exhausted" },
      { status: 503, message: "service unavailable" },
      { status: null, message: "request timed out" },
      { status: 200, message: "content is null", emptyContent: true },
    ]) {
      const breaker = new CircuitBreaker(join(dir, `fb-${failure.status}-${failure.message.length}.sqlite`));
      try {
        const decision = await fallback({ level: "task", task: "design the architecture and find the race condition" }, "zai/glm-5.3", failure, deps({ breaker }));
        expect(decision.model).not.toBe("zai/glm-5.3");
        expect(decision.model).toBe("opencode-go/claude-haiku-5-5");
      } finally {
        breaker.dispose();
      }
    }
  });

  test("with only one model connected, a fallback is honestly exhausted", async () => {
    const breaker = new CircuitBreaker(join(dir, "fb-one.sqlite"));
    try {
      const decision = await fallback({ level: "task", task: "fix the bug" }, "zai/glm-5.3", { status: 429 }, deps({ breaker, candidates: [POOL[0]!] }));
      expect(decision.model).toBe("");
      expect(decision.reason).toContain("429");
    } finally {
      breaker.dispose();
    }
  });

  test("a call that worked closes the circuit", async () => {
    const breaker = new CircuitBreaker(join(dir, "fb-ok.sqlite"));
    try {
      breaker.trip("zai/glm-5.3", "rate-limited", "", NOW);
      succeed("zai/glm-5.3", { breaker });
      expect(breaker.status("zai/glm-5.3", NOW).state).toBe("closed");
    } finally {
      breaker.dispose();
    }
  });
});

// ------------------------------------------------------------------ the audit

describe("audit", () => {
  test("every decision is readable back with its reason and its variables", async () => {
    const audit = new RouterAudit(join(dir, "audit.sqlite"));
    try {
      await route({ level: "task", task: "design the architecture for a distributed consensus layer and find the race condition" }, {
        candidates: POOL,
        usage: [],
        now: NOW,
        offline: true,
        audit,
      });
      const [entry] = audit.recent(1);
      expect(entry).toBeDefined();
      expect(entry!.chosen).toBe("zai/glm-5.3");
      expect(entry!.level).toBe("task");
      expect(entry!.source).toBe("deterministic");
      expect(entry!.reason.length).toBeGreaterThan(0);
      expect(entry!.complexity).toBe("hard");
      // The ranked table with every term: this is the part that makes it arguable.
      expect(entry!.ranking.length).toBe(2);
      expect(entry!.ranking[0]!.terms.intelligence).toBe(45);
      expect(entry!.ranking[0]!.why.join(" ")).toContain("intelligence 45");
      expect(entry!.ranking[0]!.score).toBeGreaterThan(0);
    } finally {
      audit.close();
    }
  });

  test("a fallback records the model it came from and why", async () => {
    const audit = new RouterAudit(join(dir, "audit-fb.sqlite"));
    const breaker = new CircuitBreaker(join(dir, "audit-brk.sqlite"));
    try {
      await fallback({ level: "task", task: "design the architecture and find the race condition" }, "zai/glm-5.3", { status: 402, message: "insufficient credits" }, {
        candidates: POOL,
        usage: [],
        now: NOW,
        offline: true,
        audit,
        breaker,
      });
      const [entry] = audit.recent(1);
      expect(entry!.source).toBe("fallback");
      expect(entry!.from).toBe("zai/glm-5.3");
      expect(entry!.fallbackReason).toBe("payment-required");
      expect(entry!.chosen).toBe("opencode-go/claude-haiku-5-5");
    } finally {
      audit.close();
      breaker.dispose();
    }
  });

  test("the trail is bounded and newest-first, and control characters never reach it", async () => {
    const audit = new RouterAudit(join(dir, "audit-b.sqlite"));
    try {
      for (let i = 0; i < 5; i++) {
        audit.record({ at: NOW + i, level: "task", source: "deterministic", chosen: `m/${i}\u0000\u001b[31m`, reason: "r", layaProbability: null, layaConfidence: null, layaCheckpoint: "", layaReason: "", complexity: "standard", task: "t", candidates: 0, ranking: [], from: "", fallbackReason: null });
      }
      const rows = audit.recent(3);
      expect(rows.length).toBe(3);
      expect(rows[0]!.chosen).toBe("m/4  [31m");
      expect(rows[0]!.chosen).not.toContain("\u0000");
    } finally {
      audit.close();
    }
  });
});

// ------------------------------------------------------------------ the toggle

describe("the toggle", () => {
  test("off by default: the router is not consulted", () => {
    expect(loadSettings().modelRouterEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.modelRouterEnabled).toBe(false);
    expect(routerEnabled()).toBe(false);
  });

  test("an absent flag reads as off, never as on", () => {
    writeFileSync(settingsPath(), JSON.stringify({ outputMode: "collapsed" }));
    expect(loadSettings().modelRouterEnabled).toBe(false);
    // A truthy string is not a boolean.
    writeFileSync(settingsPath(), JSON.stringify({ outputMode: "collapsed", modelRouterEnabled: "true" }));
    expect(loadSettings().modelRouterEnabled).toBe(false);
    saveSettings({ ...loadSettings(), modelRouterEnabled: true });
    expect(routerEnabled()).toBe(true);
  });

  test("the status reports what the router can actually see", async () => {
    const audit = new RouterAudit(join(dir, "status.sqlite"));
    const breaker = new CircuitBreaker(join(dir, "status-brk.sqlite"));
    try {
      saveSettings({ ...loadSettings(), modelRouterEnabled: true });
      const status = routerStatus({ candidates: POOL, audit, breaker, now: NOW, url: "http://127.0.0.1:8102/v1/systemone" });
      expect(status.enabled).toBe(true);
      expect(status.candidates).toBe(2);
      expect(status.connected).toBe(2);
      expect(status.layaCheckpoint).toBe("laya-multilingual");
      // The catalog's unknown coverage is part of the status, so "unknown" is visible.
      expect(status.catalogModels).toBeGreaterThan(60);
      expect(status.catalogUnknownIndex).toBeGreaterThan(0);
    } finally {
      audit.close();
      breaker.dispose();
    }
  });
});

/**
 * A breaker whose rows are already tripped, so a decision can be driven into the
 * "nothing is reachable" path. Real rows in a real store, because the restart
 * behaviour is part of what the breaker promises.
 */
function breakerWith(path: string, tripped: string[], reason: BreakerReason = "quota-exhausted", now = NOW): CircuitBreaker {
  const breaker = new CircuitBreaker(path);
  for (const model of tripped) breaker.trip(model, reason, "", now);
  return breaker;
}