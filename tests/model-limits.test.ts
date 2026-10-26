import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { MODELS } from "../src/models";
import { PROVIDERS } from "../src/providers";

interface LimitRow { contextWindow: number; maxOutputTokens: number }
const catalog = JSON.parse(readFileSync(new URL("../config/model-limits.json", import.meta.url), "utf8")) as { models: Record<string, LimitRow> };
const routerCatalog = JSON.parse(readFileSync(new URL("../config/model-catalog.json", import.meta.url), "utf8")) as {
  providers: Array<{ models: Array<{ modelId: string }> }>;
};

function limit(model: string): LimitRow | undefined {
  return catalog.models[model.toLowerCase()];
}

describe("model limits catalog", () => {
  test("covers every static model of every BYOK provider", () => {
    const missing: string[] = [];
    for (const provider of PROVIDERS) {
      for (const id of provider.staticModels) {
        const model = `${provider.prefix}/${id}`;
        if (!limit(model)) missing.push(model);
      }
    }
    expect(missing).toEqual([]);
  });

  test("covers the curated remote models; local Ollama stays dynamic", () => {
    for (const option of MODELS) {
      const model = String(option.value);
      if (model.startsWith("ollama/")) {
        expect(limit(model)).toBeUndefined();
      } else {
        expect(limit(model), model).toBeDefined();
      }
    }
  });

  test("covers every remote model in the router catalog", () => {
    const ids = new Set(routerCatalog.providers.flatMap((provider) => provider.models.map((model) => model.modelId)));
    const missing = [...ids].filter((id) => !id.startsWith("ollama/") && !limit(id));
    expect(missing).toEqual([]);
  });

  test("uses positive provider-specific limits, not blanket defaults", () => {
    for (const [id, row] of Object.entries(catalog.models)) {
      expect(row.contextWindow, id).toBeGreaterThan(0);
      expect(row.maxOutputTokens, id).toBeGreaterThan(0);
    }
    expect(limit("opencode-go/grok-4.7")).toEqual({ contextWindow: 500_000, maxOutputTokens: 500_000 });
    expect(limit("minimax/MiniMax-M3.1-Flash")).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 524_288 });
    expect(limit("openrouter/anthropic/claude-sonnet-4.5")?.contextWindow).toBe(1_000_000);
    expect(limit("anthropic/claude-sonnet-4-5")?.contextWindow).toBe(200_000);
  });
});
