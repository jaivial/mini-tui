/**
 * The v6-B end-to-end path: a journal written by the agent shape the Rust
 * runner actually produces, read through the real `watchTrajectory` → recorder →
 * store → API projection chain.
 *
 * This is the test that would catch the integration drifting: the unit tests can
 * all pass while the wiring records nothing, because the journal's `extra` shape
 * is owned by `agent-rs` and not by this code.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetUsageStore, recordUsage } from "../src/usage";
import { resetPriceCatalogCache } from "../src/usage/prices";
import { UsageStore } from "../src/usage/store";
import { journalPathFor, readTrajectory } from "../src/traj/watch";
import { usageView } from "../src/web/usage";

const NOW = Date.now();
let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minitui-usage-e2e-"));
  dbPath = join(dir, "usage.sqlite");
  process.env.MINITUI_USAGE_DB = dbPath;
  resetUsageStore();
  resetPriceCatalogCache();
});

afterEach(() => {
  resetUsageStore();
  delete process.env.MINITUI_USAGE_DB;
  delete process.env.MINITUI_MODEL_CATALOG;
  rmSync(dir, { recursive: true, force: true });
});

/** The journal next to a trajectory: `<traj>.json` → `<traj>.jsonl` (suffix replaced). */
const journalOf = (traj: string) => journalPathFor(traj);

/** One journal line in the shape `agent-rs` writes (`t: "msg"`, the message under `m`). */
function journalLine(message: unknown): string {
  return `${JSON.stringify({ t: "msg", m: message })}\n`;
}

/** A call exactly as wire.rs formats it: actions + the full response + cost + timings. */
function agentCall(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    content: "done",
    extra: {
      actions: [{ name: "bash", input: { command: "ls" } }],
      response: {
        model: "deepseek/deepseek-chat",
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 340, prompt_tokens_details: { cached_tokens: 200 } },
      },
      cost: 0.00079,
      timestamp: NOW,
      timings: { step: 1500.2, model: 1234.5, view: 12.1, actions: 100.4, save: 3.1 },
      ...over,
    },
  };
}

describe("journal to ledger", () => {
  test("a real agent call lands in the store with tokens, cost and latency", () => {
    const traj = join(dir, "traj.json");
    appendFileSync(journalOf(traj), journalLine({ role: "user", content: "ls" }));
    appendFileSync(journalOf(traj), journalLine(agentCall()));
    appendFileSync(journalOf(traj), journalLine({ role: "tool", content: "a.txt" }));

    const messages = readTrajectory(traj)!.messages!;
    expect(recordUsage(messages, { session: "live-1", fallbackModel: "deepseek/deepseek-chat" })).toBe(1);

    const store = new UsageStore(dbPath);
    const row = store.recent({})[0]!;
    expect(row.provider).toBe("deepseek");
    expect(row.model).toBe("deepseek/deepseek-chat");
    expect(row.inputTokens).toBe(1200);
    expect(row.outputTokens).toBe(340);
    expect(row.cacheReadTokens).toBe(200);
    expect(row.latencyMs).toBe(1235);
    expect(row.ok).toBe(true);
    expect(row.session).toBe("live-1");
    // No catalog on disk here: the agent's own price is the fallback, and it is
    // positive, so it is trusted rather than discarded.
    expect(row.costSource).toBe("agent");
    expect(row.costUsd).toBeCloseTo(0.00079, 6);
    store.close();
  });

  test("a multi-step run bills every call, and re-reading bills none of them again", () => {
    const traj = join(dir, "multi.json");
    for (let step = 0; step < 4; step++) appendFileSync(journalOf(traj), journalLine(agentCall({ timestamp: NOW + step })));

    const first = readTrajectory(traj)!.messages!;
    expect(recordUsage(first, { session: "s" })).toBe(4);
    // The live path re-reads the same journal on every poll.
    expect(recordUsage(readTrajectory(traj)!.messages!, { session: "s" })).toBe(0);

    const store = new UsageStore(dbPath);
    expect(store.summarize().totals.calls).toBe(4);
    expect(store.summarize().totals.inputTokens).toBe(4800);
    store.close();
  });

  test("the API projects a recorded run end to end", () => {
    const traj = join(dir, "api.json");
    appendFileSync(journalOf(traj), journalLine(agentCall()));
    recordUsage(readTrajectory(traj)!.messages!, { session: "web-1", task: "chat-9" });
    resetUsageStore();

    const view = usageView("24h", { MINITUI_USAGE_DB: dbPath, MINITUI_MODEL_CATALOG: join(dir, "absent.json") });
    expect(view.configured).toBe(true);
    expect(view.totals.calls).toBe(1);
    expect(view.byProvider[0]!.key).toBe("deepseek");
    expect(view.byModel[0]!.key).toBe("deepseek/deepseek-chat");
    expect(view.totals.costUsd).toBeCloseTo(0.00079, 6);
    expect(view.recent[0]).toMatchObject({ session: "web-1", task: "chat-9", ok: true });
    // No catalog present: the panel is told so instead of showing a confident zero.
    expect(view.pricesConfigured).toBe(false);
  });

  test("with the v6-A catalog present, the price comes from there", () => {
    const catalog = join(dir, "model-catalog.json");
    appendFileSync(catalog, JSON.stringify({ models: { "deepseek/deepseek-chat": { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 } } }));
    // The extractor resolves the catalog from the env, so point it at this file.
    process.env.MINITUI_MODEL_CATALOG = catalog;
    resetPriceCatalogCache();
    const traj = join(dir, "priced.json");
    appendFileSync(journalOf(traj), journalLine(agentCall()));
    recordUsage(readTrajectory(traj)!.messages!, { session: "s", catalog: undefined }, 0);

    const store = new UsageStore(dbPath);
    const row = store.recent({})[0]!;
    // The extractor loads the catalog from MINITUI_MODEL_CATALOG.
    expect(row.costSource).toBe("catalog");
    // 1000 billable input + 200 cache read, 340 output.
    const expected = (1000 * 0.28 + 200 * 0.028 + 340 * 0.42) / 1_000_000;
    expect(row.costUsd).toBeCloseTo(expected, 6);
    store.close();
  });

  test("a model missing from the catalog is unknown cost, and the panel says so", () => {
    const catalog = join(dir, "catalog-partial.json");
    appendFileSync(catalog, JSON.stringify({ models: { "deepseek/deepseek-chat": { input: 0.28, output: 0.42 } } }));
    process.env.MINITUI_MODEL_CATALOG = catalog;
    resetPriceCatalogCache();

    const traj = join(dir, "partial.json");
    appendFileSync(journalOf(traj), journalLine(agentCall({ response: { model: "unlisted/model-x", usage: { prompt_tokens: 5000, completion_tokens: 500 } }, cost: 0 })));
    recordUsage(readTrajectory(traj)!.messages!, { session: "s" });
    resetUsageStore();

    const view = usageView("all", { MINITUI_USAGE_DB: dbPath, MINITUI_MODEL_CATALOG: catalog });
    expect(view.pricesConfigured).toBe(true); // the catalog itself loaded
    expect(view.totals.calls).toBe(1);
    expect(view.totals.unknownCostCalls).toBe(1);
    // The catalog priced this model to nothing, and the agent reported cost 0 —
    // both are "we could not price it", so the total is unknown, not $0.00.
    expect(view.totals.costUsd).toBeNull();
    expect(view.costComplete).toBe(false);
    delete process.env.MINITUI_MODEL_CATALOG;
  });

  test("a call the agent could not price at all still counts its tokens", () => {
    const traj = join(dir, "noprice.json");
    appendFileSync(journalOf(traj), journalLine(agentCall({ response: { model: "brand/new", usage: { prompt_tokens: 900, completion_tokens: 90 } }, cost: 0 })));
    recordUsage(readTrajectory(traj)!.messages!, { session: "s" });
    const store = new UsageStore(dbPath);
    const row = store.recent({})[0]!;
    expect(row.inputTokens).toBe(900);
    expect(row.costUsd).toBeNull();
    expect(row.costSource).toBe("unknown");
    store.close();
  });

  test("a failed call is recorded as a failure, not dropped", () => {
    const traj = join(dir, "failed.json");
    appendFileSync(journalOf(traj), journalLine({
      role: "assistant",
      content: "",
      extra: { actions: [], error: "429 usage limit reached", timestamp: NOW, timings: { model: 300 } },
    }));
    expect(recordUsage(readTrajectory(traj)!.messages!, { session: "s" })).toBe(1);
    const store = new UsageStore(dbPath);
    const summary = store.summarize();
    expect(summary.totals.errors).toBe(1);
    expect(store.recent({})[0]!.error).toBe("429 usage limit reached");
    store.close();
  });
});