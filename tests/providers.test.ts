import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  PROVIDERS,
  connectionModelOptions,
  connectionsEnv,
  fetchProviderModels,
  loadConnections,
  saveConnection,
} from "../src/providers";

const PATH = join(import.meta.dir, ".tmp-providers.json");

describe("BYOK providers", () => {
  test("connections persist, inject env and add models to the picker", () => {
    rmSync(PATH, { force: true });
    saveConnection(
      {
        id: "xiaomi",
        name: "Xiaomi MiMo",
        keyEnv: "XIAOMI_API_KEY",
        extraEnv: { XIAOMI_API_BASE: "https://example/v1" },
        prefix: "xiaomi",
        key: "tp-secret",
        models: ["mimo-v2.6-pro", "mimo-v2.6-flash"],
        defaultModel: "mimo-v2.6-pro",
        addedAt: 1,
      },
      PATH,
    );
    const saved = loadConnections(PATH);
    expect(saved.length).toBe(1);
    expect(saved[0].key).toBe("tp-secret");

    // reconnecting the same provider replaces (no duplicates)
    saveConnection({ ...saved[0], key: "tp-new", addedAt: 2 }, PATH);
    expect(loadConnections(PATH).map((c) => c.key)).toEqual(["tp-new"]);

    // keys + base urls reach the run environment
    expect(connectionsEnv(saved)).toEqual({
      XIAOMI_API_KEY: "tp-secret",
      XIAOMI_API_BASE: "https://example/v1",
    });

    // every catalog model shows up in /model
    expect(connectionModelOptions(saved).map((o) => o.value)).toEqual([
      "xiaomi/mimo-v2.6-pro",
      "xiaomi/mimo-v2.6-flash",
    ]);
    rmSync(PATH, { force: true });
  });

  test("fetchProviderModels parses OpenAI- and Anthropic-style catalogs", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (String(url).includes("anthropic")) {
          expect(headers["x-api-key"]).toBe("sk-ant");
          return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }));
        }
        expect(headers.Authorization).toBe("Bearer tp");
        return new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }] }));
      }) as typeof fetch;

      const openai = PROVIDERS.find((p) => p.probe === "openai")!;
      expect(await fetchProviderModels(openai, "tp")).toEqual(["a-model", "b-model"]); // sorted + deduped

      const anthropic = PROVIDERS.find((p) => p.probe === "anthropic")!;
      expect(await fetchProviderModels(anthropic, "sk-ant")).toEqual(["claude-sonnet-4-5"]);

      globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
      await expect(fetchProviderModels(openai, "bad")).rejects.toThrow("HTTP 401");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
