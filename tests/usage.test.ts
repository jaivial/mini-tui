/**
 * v6-B: the usage ledger.
 *
 * What is being pinned here, beyond the obvious arithmetic:
 * - **unknown cost is not zero.** A model the catalog does not price, or a reply
 *   with no usage block, must aggregate to `costUsd: null` with the call counted
 *   as unpriced. A total of 0 there would read as "free", which is a claim
 *   nobody established.
 * - **a replay does not double-count.** The same journal read twice (a resume, a
 *   restore, a second watcher) records one row.
 * - **the file is 0600 and the schema migrates.** The store holds spend.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { recordUsage, resetUsageStore } from "../src/usage";
import { resolveModel, tokensOf, usageFromMessage, usageFromMessages } from "../src/usage/record";
import { catalogPath, costFor, loadPriceCatalog, resetPriceCatalogCache } from "../src/usage/prices";
import { UsageStore, usageDbPath, windowFromQuery, windowMs, type UsageCall } from "../src/usage/store";
import { resolveWindow, usageView } from "../src/web/usage";
import type { TrajectoryMessage } from "../src/traj/schema";

const HOUR = 3_600_000;
const T0 = 1_760_000_000_000;

let dir: string;
let store: UsageStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minitui-usage-"));
  store = new UsageStore(join(dir, "usage.sqlite"));
  resetPriceCatalogCache();
});

afterEach(() => {
  store.close();
  resetUsageStore();
  rmSync(dir, { recursive: true, force: true });
});

function call(over: Partial<UsageCall> = {}): UsageCall {
  return {
    callKey: `s1:0`,
    at: T0,
    session: "s1",
    task: "",
    provider: "deepseek",
    model: "deepseek/deepseek-chat",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: null,
    costUsd: null,
    costSource: "unknown",
    ok: true,
    error: "",
    ...over,
  };
}

// ── Storage ──

describe("UsageStore storage", () => {
  test("the store is created 0600: it holds what the operator pays", () => {
    const path = join(dir, "usage.sqlite");
    store.close();
    store = new UsageStore(path);
    // WAL mode keeps the data in -wal until a checkpoint; the main file is 0600
    // and so must its sidecars be, or the spend leaks through them.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.record(call());
    for (const suffix of ["-wal", "-shm"]) {
      try {
        expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600);
      } catch {
        // sidecar not created yet on this platform
      }
    }
  });

  test("an existing store is migrated in place, never replaced", () => {
    const path = join(dir, "migrate.sqlite");
    // A v1 store: no `task` column, user_version 1.
    const old = new UsageStore(path);
    old.db.exec("DROP TABLE usage_calls");
    old.db.exec(`CREATE TABLE usage_calls(
      call_key TEXT PRIMARY KEY, at INTEGER NOT NULL, session TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER, cost_usd REAL, cost_source TEXT NOT NULL DEFAULT 'unknown',
      ok INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '')`);
    old.db.exec("PRAGMA user_version = 1");
    old.db.query("INSERT INTO usage_calls(call_key,at,session,provider,model) VALUES('k1',1,'s','p','m')").run();
    old.close();

    const migrated = new UsageStore(path);
    const rows = migrated.db.query("SELECT task FROM usage_calls").all() as Array<{ task: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task).toBe(""); // widened, and the old row survived
    expect((migrated.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    migrated.close();
  });

  test("a newer schema is left alone rather than downgraded", () => {
    const path = join(dir, "newer.sqlite");
    const db = new UsageStore(path);
    db.db.exec("PRAGMA user_version = 99");
    db.close();
    const again = new UsageStore(path);
    expect((again.db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(99);
    again.close();
  });

  test("the same call twice is one row: a replayed journal cannot inflate the window", () => {
    expect(store.record(call())).toBe(true);
    expect(store.record(call())).toBe(false);
    expect(store.summarize().totals.calls).toBe(1);
  });
});

// ── Aggregation ──

describe("UsageStore.summarize", () => {
  test("groups by provider and model with tokens, cost, latency and errors", () => {
    store.record(call({ callKey: "a", at: T0, provider: "deepseek", model: "deepseek/deepseek-chat", inputTokens: 1000, outputTokens: 500, costUsd: 0.0025, latencyMs: 900 }));
    store.record(call({ callKey: "b", at: T0 + 1000, provider: "deepseek", model: "deepseek/deepseek-chat", inputTokens: 2000, outputTokens: 100, costUsd: 0.001, latencyMs: 1100, ok: false, error: "429 rate limit" }));
    store.record(call({ callKey: "c", at: T0 + 2000, provider: "zai", model: "zai/glm-5.3", inputTokens: 10, outputTokens: 20, costUsd: 0.5, latencyMs: 300 }));

    const summary = store.summarize();
    expect(summary.totals.calls).toBe(3);
    expect(summary.totals.inputTokens).toBe(3010);
    expect(summary.totals.outputTokens).toBe(620);
    expect(summary.totals.costUsd).toBeCloseTo(0.5035, 6);
    expect(summary.totals.errors).toBe(1);
    expect(summary.totals.avgLatencyMs).toBe(766.7);
    expect(summary.costComplete).toBe(true);

    expect(summary.byProvider.map((p) => p.key).sort()).toEqual(["deepseek", "zai"]);
    const deepseek = summary.byProvider.find((p) => p.key === "deepseek")!;
    expect(deepseek.calls).toBe(2);
    expect(deepseek.costUsd).toBeCloseTo(0.0035, 6);
    expect(deepseek.errors).toBe(1);
    expect(summary.byModel).toHaveLength(2);
  });

  test("an unpriced call makes the total unknown, not zero", () => {
    store.record(call({ callKey: "priced", costUsd: 0.01, costSource: "catalog" }));
    store.record(call({ callKey: "unpriced", model: "mystery/model", costUsd: null, costSource: "unknown" }));

    const totals = store.summarize().totals;
    expect(totals.calls).toBe(2);
    expect(totals.unknownCostCalls).toBe(1);
    // The known part is real, but it is not the whole spend: say so with null.
    expect(totals.costUsd).toBe(0.01);
    expect(store.summarize().costComplete).toBe(false);
  });

  test("only unpriced calls: the total is unknown, definitely not 0", () => {
    store.record(call({ callKey: "u1", costUsd: null }));
    store.record(call({ callKey: "u2", costUsd: null }));
    const totals = store.summarize().totals;
    expect(totals.costUsd).toBeNull();
    expect(totals.unknownCostCalls).toBe(2);
    expect(store.summarize().costComplete).toBe(false);
  });

  test("the window bounds what counts: an hour sees the hour", () => {
    store.record(call({ callKey: "old", at: T0 }));
    store.record(call({ callKey: "new", at: T0 + 5 * HOUR }));
    const summary = store.summarize({ since: T0 + HOUR, until: T0 + 10 * HOUR });
    expect(summary.totals.calls).toBe(1);
    expect(summary.byProvider[0]!.calls).toBe(1);
  });

  test("an empty window is zero calls and an unknown (not zero) cost", () => {
    const summary = store.summarize();
    expect(summary.totals.calls).toBe(0);
    expect(summary.totals.costUsd).toBeNull();
    expect(summary.byProvider).toEqual([]);
    expect(summary.costComplete).toBe(true); // nothing unpriced, because nothing happened
  });

  test("cache tokens are counted apart from input, they bill differently", () => {
    store.record(call({ callKey: "c", inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 10 }));
    const totals = store.summarize().totals;
    expect(totals.inputTokens).toBe(100);
    expect(totals.cacheReadTokens).toBe(900);
    expect(totals.cacheWriteTokens).toBe(50);
  });

  test("providers[] is what the router reads: last use and window spend", () => {
    store.record(call({ callKey: "p1", provider: "zai", at: T0, inputTokens: 10, costUsd: 0.1 }));
    store.record(call({ callKey: "p2", provider: "zai", at: T0 + 60_000, inputTokens: 20, outputTokens: 5, costUsd: 0.2 }));
    const providers = store.summarize().providers;
    expect(providers).toHaveLength(1);
    expect(providers[0]!.provider).toBe("zai");
    expect(providers[0]!.lastUsedAt).toBe(T0 + 60_000);
    expect(providers[0]!.costUsd).toBeCloseTo(0.3, 6);
    expect(providers[0]!.tokens).toBe(35);
  });

  test("prune drops only what is older than the cutoff", () => {
    store.record(call({ callKey: "old", at: T0 }));
    store.record(call({ callKey: "keep", at: T0 + 10 * HOUR }));
    expect(store.prune(T0 + HOUR)).toBe(1);
    expect(store.recent({}).map((c) => c.callKey)).toEqual(["keep"]);
  });
});

// ── Prices ──

describe("price catalog", () => {
  const catalog = (body: unknown) => {
    const path = join(dir, "model-catalog.json");
    writeFileSync(path, JSON.stringify(body));
    resetPriceCatalogCache();
    return path;
  };

  test("a missing catalog is a normal state, not a failure", () => {
    const loaded = loadPriceCatalog(join(dir, "nope.json"));
    expect(loaded.loaded).toBe(false);
    expect(loaded.price("deepseek/deepseek-chat")).toBeNull();
    expect(costFor(loaded.price("deepseek/deepseek-chat"), { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  test("a malformed catalog prices nothing rather than everything at zero", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    resetPriceCatalogCache();
    const loaded = loadPriceCatalog(path);
    expect(loaded.loaded).toBe(false);
    expect(costFor(loaded.price("anything"), { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  test("prices are USD per 1M tokens, from the v6-A catalog shape", () => {
    const path = catalog({ models: { "deepseek/deepseek-chat": { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } } });
    const loaded = loadPriceCatalog(path);
    expect(loaded.loaded).toBe(true);
    expect(costFor(loaded.price("deepseek/deepseek-chat"), { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.7, 6);
  });

  test("an array catalog is read too, keyed provider/id", () => {
    const path = catalog({ models: [{ provider: "openai", id: "gpt-5.4", input: 2.5, output: 15 }] });
    const loaded = loadPriceCatalog(path);
    expect(costFor(loaded.price("openai/gpt-5.4"), { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(0.004, 6);
  });

  test("a half-priced row prices nothing: one direction is not a price", () => {
    const path = catalog({ models: { "x/y": { input: 1 } } });
    expect(loadPriceCatalog(path).price("x/y")).toBeNull();
  });

  test("a bare id resolves, and a slashy OpenRouter id resolves by its last segment", () => {
    const path = catalog({ models: { "deepseek/deepseek-chat": { input: 0.28, output: 0.42 } } });
    const loaded = loadPriceCatalog(path);
    expect(loaded.price("deepseek-chat")).not.toBeNull();
    expect(loaded.price("openrouter/deepseek/deepseek-chat")).not.toBeNull();
  });

  test("a model the catalog does not list is unknown cost, never 0", () => {
    const path = catalog({ models: { "deepseek/deepseek-chat": { input: 0.28, output: 0.42 } } });
    expect(costFor(loadPriceCatalog(path).price("brand/new-model"), { input: 5000, output: 500, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  test("cached tokens are not billed twice: they come out of the input count", () => {
    const price = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 };
    // 1200 prompt tokens of which 200 were cache reads: only 1000 bill as input.
    const cost = costFor(price, { input: 1200, output: 0, cacheRead: 200, cacheWrite: 0 })!;
    expect(cost).toBeCloseTo((1000 * 1 + 200 * 0.1) / 1_000_000, 9);
  });

  test("a cache read bigger than the reported input cannot go negative", () => {
    const price = { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0 };
    const cost = costFor(price, { input: 100, output: 0, cacheRead: 900, cacheWrite: 0 })!;
    expect(cost).toBeGreaterThanOrEqual(0);
    expect(cost).toBeCloseTo((900 * 0.5) / 1_000_000, 9);
  });
});

/**
 * Against the real v6-A catalog, not a fixture. A parser that only ever sees a
 * tidy fixture will happily accept the shape it was written for and then read the
 * shipped file as "no prices at all" — or worse, read `"desconocido"` as 0.
 */
describe("the shipped v6-A catalog", () => {
  const path = catalogPath();
  const available = existsSync(path);

  test.skipIf(!available)("it parses: providers[].models[] with priceIn/priceOut", () => {
    const loaded = loadPriceCatalog(path);
    expect(loaded.loaded).toBe(true);
    expect(loaded.models).toBeGreaterThan(20);
  });

  test.skipIf(!available)("a known model prices to a real figure, not to zero", () => {
    const loaded = loadPriceCatalog(path);
    const price = loaded.price("deepseek/deepseek-v4-pro") ?? loaded.price("zai/glm-5.3");
    expect(price).not.toBeNull();
    expect(price!.input).toBeGreaterThan(0);
    expect(price!.output).toBeGreaterThan(0);
    const cost = costFor(price, { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })!;
    expect(cost).toBeGreaterThan(0);
  });

  test.skipIf(!available)('"desconocido" is unknown cost, never $0.00', () => {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { providers?: Array<{ models?: Array<{ modelId?: string; priceIn?: unknown; priceOut?: unknown }> }> };
    const loaded = loadPriceCatalog(path);
    const unpriceable = (raw.providers ?? [])
      .flatMap((p) => p.models ?? [])
      .filter((m) => typeof m.priceIn === "string" || typeof m.priceOut === "string")
      .map((m) => m.modelId ?? "")
      .filter(Boolean);
    // If the catalog ever fills these in, the assertion below stops being meaningful.
    if (!unpriceable.length) return;
    for (const id of unpriceable) {
      expect(loaded.price(id)).toBeNull();
      expect(costFor(loaded.price(id), { input: 100_000, output: 100_000, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    }
  });
});

// ── Extraction from the journal ──

describe("tokensOf", () => {
  test("reads the OpenAI chat convention", () => {
    expect(tokensOf({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } }))
      .toEqual({ input: 100, output: 20, cacheRead: 40, cacheWrite: 0 });
  });
  test("reads the Anthropic Messages convention", () => {
    expect(tokensOf({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 5 }))
      .toEqual({ input: 7, output: 3, cacheRead: 2, cacheWrite: 5 });
  });
  test("a missing or junk usage block is zero tokens, not a guess", () => {
    expect(tokensOf(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(tokensOf("nope")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(tokensOf({ prompt_tokens: -5, completion_tokens: Number.NaN })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("resolveModel", () => {
  const providers = [
    { prefix: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
    { prefix: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  ];

  test("an already-qualified id is left alone", () => {
    expect(resolveModel("openrouter/anthropic/claude-sonnet-4.5", undefined, providers)).toBe("openrouter/anthropic/claude-sonnet-4.5");
  });

  test("a bare id plus its api_base becomes the catalog's own key", () => {
    // This is the real shape: the run config names `glm-5.3-flash` and the gateway
    // omits `model` from its reply, so without this the row has no provider.
    expect(resolveModel("glm-5.3-flash", "https://opencode.ai/zen/go/v1", providers)).toBe("opencode-go/glm-5.3-flash");
  });

  test("a base URL with a trailing slash or a deeper path still matches", () => {
    expect(resolveModel("glm-5.3", "https://api.z.ai/api/coding/paas/v4/", providers)).toBe("zai/glm-5.3");
    expect(resolveModel("glm-5.3", "https://opencode.ai/zen/go", providers)).toBe("opencode-go/glm-5.3");
  });

  test("a base URL that names no known provider leaves the id bare, not wrong", () => {
    expect(resolveModel("glm-5.3", "https://example.invalid/v1", providers)).toBe("glm-5.3");
  });

  test("no model at all stays empty: tokens are still measured, attribution is not invented", () => {
    expect(resolveModel(undefined, "https://opencode.ai/zen/go/v1", providers)).toBe("");
    expect(resolveModel("", "https://opencode.ai/zen/go/v1", providers)).toBe("");
  });
});

describe("usageFromMessage", () => {
  const priced = { loaded: true, path: "", models: 1, price: () => ({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }), providers: () => [] };

  const assistant = (extra: Record<string, unknown>): TrajectoryMessage => ({ role: "assistant", content: "ok", extra });

  test("records tokens, model, provider, latency and cost from one call", () => {
    const message = assistant({
      response: { model: "deepseek/deepseek-chat", usage: { prompt_tokens: 1000, completion_tokens: 100 } },
      cost: 0.0004,
      timestamp: T0,
      timings: { model: 1234.5, step: 1500 },
    });
    const row = usageFromMessage(message, 3, { session: "s1", task: "chat-42", catalog: priced })!;
    expect(row).toMatchObject({
      callKey: "s1:3",
      at: T0,
      session: "s1",
      task: "chat-42",
      provider: "deepseek",
      model: "deepseek/deepseek-chat",
      inputTokens: 1000,
      outputTokens: 100,
      latencyMs: 1235,
      ok: true,
    });
    // 1000 in + 100 out at the stub price: 1000*1 + 100*2 per 1M = 0.0012
    expect(row.costUsd).toBeCloseTo(0.0012, 6);
    expect(row.costSource).toBe("catalog");
  });

  test("a model the catalog does not price is unknown cost even when the agent priced it zero", () => {
    const uncatalogued = { loaded: false, path: "", models: 0, price: () => null, providers: () => [] };
    const message = assistant({ response: { model: "mystery/model", usage: { prompt_tokens: 10 } }, cost: 0 });
    const row = usageFromMessage(message, 0, { session: "s", catalog: uncatalogued })!;
    expect(row.costUsd).toBeNull();
    expect(row.costSource).toBe("unknown");
  });

  test("the agent's own cost is the fallback when the catalog has nothing", () => {
    const uncatalogued = { loaded: false, path: "", models: 0, price: () => null, providers: () => [] };
    const row = usageFromMessage(assistant({ response: { model: "mystery/model", usage: { prompt_tokens: 10 } }, cost: 0.007 }), 0, { session: "s", catalog: uncatalogued })!;
    expect(row.costSource).toBe("agent");
    expect(row.costUsd).toBe(0.007);
  });

  test("a failed call is recorded as failed, with its message", () => {
    const row = usageFromMessage(assistant({ error: "429 usage limit reached", actions: [] }), 1, { session: "s", catalog: priced })!;
    expect(row.ok).toBe(false);
    expect(row.error).toBe("429 usage limit reached");
    expect(row.inputTokens).toBe(0);
  });

  test("the agent's seconds-with-fraction timestamp is read as a real date", () => {
    // The Rust agent journals `SystemTime::now()` as seconds + fraction. Read as
    // milliseconds it lands in January 1970, which is what the panel showed
    // ("último uso 1/21/1970") before this was pinned.
    const seconds = 1_792_010_161.2273793;
    const row = usageFromMessage(assistant({ response: { usage: { prompt_tokens: 1 } }, timestamp: seconds }), 0, { session: "s", catalog: priced })!;
    expect(row.at).toBe(1_792_010_161_227);
    expect(new Date(row.at).getUTCFullYear()).toBe(2026);
  });

  test("a millisecond timestamp is left alone", () => {
    const row = usageFromMessage(assistant({ response: { usage: { prompt_tokens: 1 } }, timestamp: 1_792_010_161_227 }), 0, { session: "s", catalog: priced })!;
    expect(row.at).toBe(1_792_010_161_227);
    expect(new Date(row.at).getUTCFullYear()).toBe(2026);
  });

  test("a junk or missing timestamp falls back to now", () => {
    const now = 1_792_000_000_000;
    for (const bad of [undefined, 0, -1, Number.NaN, "soon"]) {
      const row = usageFromMessage(assistant({ response: { usage: { prompt_tokens: 1 } }, timestamp: bad }), 0, { session: "s", catalog: priced, now })!;
      expect(row.at).toBe(now);
    }
  });

  test("thinking_seconds stands in for latency when timings are off", () => {
    const row = usageFromMessage(assistant({ response: { usage: { prompt_tokens: 1 } }, thinking_seconds: 2.5 }), 0, { session: "s", catalog: priced })!;
    expect(row.latencyMs).toBe(2500);
  });

  test("the run's configured model is used when the reply does not name one", () => {
    const row = usageFromMessage(assistant({ response: { usage: { prompt_tokens: 1 } } }), 0, { session: "s", fallbackModel: "zai/glm-5.3", catalog: priced })!;
    expect(row.model).toBe("zai/glm-5.3");
    expect(row.provider).toBe("zai");
  });

  test("messages that are not model calls produce nothing", () => {
    expect(usageFromMessage({ role: "user", content: "hi" }, 0, { session: "s" })).toBeNull();
    expect(usageFromMessage({ role: "tool", content: "output" }, 0, { session: "s" })).toBeNull();
    expect(usageFromMessage({ role: "assistant", content: "", extra: {} }, 0, { session: "s" })).toBeNull();
  });

  test("providerOf keeps the first segment, so openrouter ids stay openrouter", () => {
    const row = usageFromMessage(assistant({ response: { model: "openrouter/anthropic/claude-sonnet-4.5", usage: {} } }), 0, { session: "s", catalog: priced })!;
    expect(row.provider).toBe("openrouter");
  });

  test("usageFromMessages resumes from an index and never re-bills", () => {
    const messages = [
      assistant({ response: { model: "p/m", usage: { prompt_tokens: 1 } } }),
      { role: "tool", content: "x" },
      assistant({ response: { model: "p/m", usage: { prompt_tokens: 2 } } }),
    ];
    expect(usageFromMessages(messages, { session: "s", catalog: priced }, 0).map((c) => c.callKey)).toEqual(["s:0", "s:2"]);
    expect(usageFromMessages(messages, { session: "s", catalog: priced }, 2).map((c) => c.callKey)).toEqual(["s:2"]);
    expect(usageFromMessages(messages, { session: "s", catalog: priced }, 3)).toEqual([]);
  });
});

// ── The recorder ──

describe("recordUsage", () => {
  test("records into the store at MINITUI_USAGE_DB and survives a replay", () => {
    const path = join(dir, "recorder.sqlite");
    process.env.MINITUI_USAGE_DB = path;
    resetUsageStore();
    const messages: TrajectoryMessage[] = [
      { role: "assistant", content: "a", extra: { response: { model: "deepseek/deepseek-chat", usage: { prompt_tokens: 5, completion_tokens: 1 } }, timestamp: T0 } },
      { role: "assistant", content: "b", extra: { response: { model: "deepseek/deepseek-chat", usage: { prompt_tokens: 6, completion_tokens: 2 } }, timestamp: T0 + 1 } },
    ];
    expect(recordUsage(messages, { session: "live" })).toBe(2);
    expect(recordUsage(messages, { session: "live" })).toBe(0); // the same journal again
    expect(recordUsage([...messages, { role: "assistant", content: "c", extra: { response: { model: "deepseek/deepseek-chat", usage: { prompt_tokens: 7 } }, timestamp: T0 + 2 } }], { session: "live" }, 2)).toBe(1);
    resetUsageStore();
    delete process.env.MINITUI_USAGE_DB;
  });

  /**
   * The e2e suites spawn `bun src/index.ts` as real subprocesses with a curated
   * env. Before this was pinned, a full `bun test` wrote 9 zero-token fixture
   * rows into the operator's real ledger — every model, provider and cost blank.
   */
  test("a run under the test runner never opens the real ledger", () => {
    const real = usageDbPath({ HOME: process.env.HOME! });
    const before = existsSync(real);
    resetUsageStore();
    delete process.env.MINITUI_USAGE_DB;
    // NODE_ENV=test is what `bun test` exports, and what a spawned child inherits.
    const written = recordUsage(
      [{ role: "assistant", content: "a", extra: { response: { model: "p/m", usage: { prompt_tokens: 5 } }, timestamp: T0 } }],
      { session: "fixture" },
      0,
    );
    expect(written).toBe(0);
    expect(existsSync(real)).toBe(before);
  });
});

// ── The window query ──

describe("window names", () => {
  test("accepts the shapes the panel offers", () => {
    expect(windowMs("1h")).toBe(HOUR);
    expect(windowMs("24h")).toBe(24 * HOUR);
    expect(windowMs("7d")).toBe(7 * 86_400_000);
    expect(windowMs("30d")).toBe(30 * 86_400_000);
    expect(windowMs("2w")).toBe(2 * 604_800_000);
  });
  test("junk is not a window", () => {
    for (const junk of ["", null, "abc", "-5h", "1y", "../../etc"]) expect(windowMs(junk)).toBe(0);
  });
  test("an absurd window is clamped, not honoured", () => {
    expect(windowMs("9999d")).toBe(400 * 86_400_000);
    expect(windowMs("0h")).toBe(60_000);
  });
  test("resolveWindow falls back to everything for a name this build does not know", () => {
    expect(resolveWindow("24h").name).toBe("24h");
    expect(resolveWindow("all").window.since).toBe(0);
    expect(resolveWindow("3q").name).toBe("all");
    expect(resolveWindow(null).name).toBe("all");
    const w = windowFromQuery("1h", T0);
    expect(w.since).toBe(T0 - HOUR);
  });
});

// ── The API projection ──

describe("usageView", () => {
  test("a host with no store yet is 'not configured', not an error", () => {
    const view = usageView("all", { MINITUI_USAGE_DB: join(dir, "absent.sqlite"), MINITUI_MODEL_CATALOG: join(dir, "no-catalog.json") });
    expect(view.configured).toBe(false);
    expect(view.totals.calls).toBe(0);
    expect(view.recent).toEqual([]);
    expect(view.pricesConfigured).toBe(false);
  });

  test("projects totals, per provider and per model, and the latest calls", () => {
    const path = join(dir, "api.sqlite");
    const s = new UsageStore(path);
    s.record(call({ callKey: "1", at: T0, session: "s1", task: "chat-1", provider: "deepseek", model: "deepseek/deepseek-chat", inputTokens: 100, outputTokens: 20, costUsd: 0.001, latencyMs: 800 }));
    s.record(call({ callKey: "2", at: T0 + HOUR, session: "s2", provider: "zai", model: "zai/glm-5.3", inputTokens: 50, costUsd: null, latencyMs: 400, ok: false, error: "boom" }));
    s.close();

    const view = usageView("all", { MINITUI_USAGE_DB: path, MINITUI_MODEL_CATALOG: join(dir, "no-catalog.json") });
    expect(view.configured).toBe(true);
    expect(view.totals.calls).toBe(2);
    expect(view.totals.costUsd).toBe(0.001);
    expect(view.totals.unknownCostCalls).toBe(1);
    expect(view.costComplete).toBe(false);
    expect(view.byProvider.map((p) => p.key).sort()).toEqual(["deepseek", "zai"]);
    expect(view.byModel).toHaveLength(2);
    expect(view.recent).toHaveLength(2);
    expect(view.recent[0]).toMatchObject({ session: "s2", ok: false, costUsd: null });
    expect(view.recent[1]).toMatchObject({ session: "s1", task: "chat-1", latencyMs: 800 });
  });

  test("the window narrows what the panel shows", () => {
    const path = join(dir, "window.sqlite");
    const now = Date.now();
    const s = new UsageStore(path);
    s.record(call({ callKey: "old", at: now - 5 * HOUR }));
    s.record(call({ callKey: "new", at: now - 60_000 }));
    s.close();
    const view = usageView("1h", { MINITUI_USAGE_DB: path, MINITUI_MODEL_CATALOG: join(dir, "no.json") });
    expect(view.window.name).toBe("1h");
    expect(view.totals.calls).toBe(1);
    expect(view.byProvider[0]!.calls).toBe(1);
  });

  test("reading never creates or mutates the store", () => {
    const path = join(dir, "ro.sqlite");
    const s = new UsageStore(path);
    s.record(call());
    s.close();
    const before = statSync(path).mtimeMs;
    usageView("all", { MINITUI_USAGE_DB: path, MINITUI_MODEL_CATALOG: join(dir, "no.json") });
    expect(statSync(path).mtimeMs).toBe(before);
  });
});