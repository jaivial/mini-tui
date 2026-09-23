import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  PROVIDERS,
  connectionEnv,
  connectionModelOptions,
  fetchProviderModels,
  providerModelName,
  loadConnections,
  modelEnv,
  saveConnection,
} from "../src/providers";

const PATH = join(import.meta.dir, ".tmp-providers.json");

describe("provider registry", () => {
  test("covers the MiniMax Code catalog", () => {
    const byId = new Map(PROVIDERS.map((p) => [p.id, p]));
    // the five mcode providers
    expect([...byId.keys()]).toEqual(
      expect.arrayContaining(["xiaomi", "deepseek", "opencode-go", "zai", "minimax"]),
    );
    expect(byId.get("zai")!.staticModels).toContain("glm-5.3-flash");
    expect(byId.get("minimax")!.staticModels).toEqual([
      "MiniMax-M3.1",
      "MiniMax-M3",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.7",
    ]);
    expect(byId.get("opencode-go")!.staticModels.length).toBe(32); // the docs Endpoints table
    expect(byId.get("deepseek")!.staticModels).toContain("deepseek-v4-pro");
    // every provider has a direct route (its own env slot or the openai-compat slot)
    for (const provider of PROVIDERS) {
      expect(["native", "openai-compat"]).toContain(provider.route);
    }
  });

  test("model naming: native prefixes vs the openai-compat slot", () => {
    const xiaomi = PROVIDERS.find((p) => p.id === "xiaomi")!;
    expect(providerModelName(xiaomi.prefix, "mimo-v2.6-pro")).toBe("xiaomi/mimo-v2.6-pro");
    const zai = PROVIDERS.find((p) => p.id === "zai")!;
    expect(providerModelName(zai.prefix, "glm-5.3-flash")).toBe("zai/glm-5.3-flash");

    // native: the provider's own key env
    expect(
      connectionEnv({ route: "native", keyEnv: "XIAOMI_API_KEY", extraEnv: { XIAOMI_API_BASE: "b" }, baseUrl: "b", key: "k" }),
    ).toEqual({ XIAOMI_API_KEY: "k", XIAOMI_API_BASE: "b" });

    // openai-compat (legacy saved connections): the generic openai slot + mini's override env
    expect(connectionEnv({ route: "openai-compat", keyEnv: "ZAI_API_KEY", baseUrl: "https://z.ai/v4", key: "zk" })).toEqual({
      OPENAI_API_KEY: "zk",
      OPENAI_API_BASE: "https://z.ai/v4",
      MSWEA_OPENAI_API_KEY: "zk",
      MSWEA_OPENAI_API_BASE: "https://z.ai/v4",
    });
  });
});

describe("BYOK connections", () => {
  test("persist, inject per-model env and add models to the picker", () => {
    rmSync(PATH, { force: true });
    const xiaomi = PROVIDERS.find((p) => p.id === "xiaomi")!;
    saveConnection(
      {
        id: "xiaomi",
        name: xiaomi.name,
        route: xiaomi.route,
        keyEnv: xiaomi.keyEnv,
        extraEnv: xiaomi.extraEnv,
        baseUrl: xiaomi.baseUrl,
        prefix: xiaomi.prefix,
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

    // only the model's own provider credentials reach its runs
    expect(modelEnv("xiaomi/mimo-v2.6-flash", saved)).toEqual({
      XIAOMI_API_KEY: "tp-secret",
      XIAOMI_API_BASE: xiaomi.baseUrl,
    });
    expect(modelEnv("deepseek/deepseek-chat", saved)).toEqual({}); // other providers stay untouched

    // every catalog model shows up in /model with its provider name
    const options = connectionModelOptions(saved);
    expect(options.map((o) => o.value)).toEqual(["xiaomi/mimo-v2.6-pro", "xiaomi/mimo-v2.6-flash"]);
    expect(options[0].name).toContain("Xiaomi MiMo");
    rmSync(PATH, { force: true });
  });

  test("legacy openai-compat connections keep mapping onto the openai slot", () => {
    rmSync(PATH, { force: true });
    const zai = PROVIDERS.find((p) => p.id === "zai")!;
    saveConnection(
      {
        id: "zai",
        name: zai.name,
        route: "openai-compat",
        keyEnv: zai.keyEnv,
        baseUrl: zai.baseUrl,
        prefix: "openai",
        key: "zk",
        models: ["glm-5.3-flash"],
        defaultModel: "glm-5.3-flash",
        addedAt: 1,
      },
      PATH,
    );
    const saved = loadConnections(PATH);
    expect(connectionModelOptions(saved)[0].value).toBe("openai/glm-5.3-flash");
    const env = modelEnv("openai/glm-5.3-flash", saved);
    expect(env.OPENAI_API_KEY).toBe("zk");
    expect(env.OPENAI_API_BASE).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(env.MSWEA_OPENAI_API_KEY).toBe("zk");
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
      }) as unknown as typeof fetch;

      const openai = PROVIDERS.find((p) => p.probe === "openai")!;
      expect(await fetchProviderModels(openai, "tp")).toEqual(["a-model", "b-model"]); // sorted + deduped

      const anthropic = PROVIDERS.find((p) => p.probe === "anthropic")!;
      expect(await fetchProviderModels(anthropic, "sk-ant")).toEqual(["claude-sonnet-4-5"]);

      globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
      await expect(fetchProviderModels(openai, "bad")).rejects.toThrow("HTTP 401");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
