import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SelectOption } from "@opentui/core";

import { runHelperScript } from "./helpers";

/**
 * How the provider reaches the model layer (litellm):
 * - `native`: a litellm/mini provider prefix + its key env is enough (`moonshot/kimi-k2`).
 * - `openai-compat`: any OpenAI-compatible endpoint, reached through litellm's `openai/`
 *   provider with `OPENAI_API_BASE`/`OPENAI_API_KEY` (and mini's `MSWEA_OPENAI_*`).
 */
export type ProviderRoute = "native" | "openai-compat";

/** A BYOK provider: paste a key, pick a model, test it, and mini can use it. */
export interface ProviderDef {
  id: string;
  name: string;
  description: string;
  route: ProviderRoute;
  /** Unique env var name this connection's key is stored under. */
  keyEnv: string;
  /** Extra env injected together with the key (native routes). */
  extraEnv?: Record<string, string>;
  /** Base URL used to list models (and for openai-compat runs). */
  baseUrl: string;
  /** How to talk to the provider's /models endpoint. */
  probe: "openai" | "anthropic";
  /** Provider prefix used in model names (`<prefix>/<id>`), `openai` for compat routes. */
  prefix: string;
  /** Known model ids (used when the catalog request fails). */
  staticModels: string[];
}

/**
 * BYOK providers — the MiniMax Code catalog (MiniMax, Z.AI, DeepSeek, OpenCode Go,
 * Xiaomi Token Plan) plus other common litellm providers. Order = display order.
 */
export const PROVIDERS: ProviderDef[] = [
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    description: "MiMo V2.x (token plan, Singapore)",
    route: "native",
    keyEnv: "XIAOMI_API_KEY",
    extraEnv: { XIAOMI_API_BASE: "https://token-plan-sgp.xiaomimimo.com/v1" },
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    probe: "openai",
    prefix: "xiaomi",
    staticModels: [
      "mimo-v2.6-pro",
      "mimo-v2.6-flash",
      "mimo-v2.5-pro",
      "mimo-v2.5",
      "mimo-v2-pro",
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "deepseek-v4 / deepseek-chat",
    route: "native",
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    probe: "openai",
    prefix: "deepseek",
    staticModels: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-flash",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    description: "subscription models over /zen/go",
    route: "native",
    keyEnv: "OPENCODE_GO_API_KEY",
    extraEnv: { OPENCODE_GO_API_BASE: "https://opencode.ai/zen/go/v1" },
    baseUrl: "https://opencode.ai/zen/go/v1",
    probe: "openai",
    prefix: "opencode-go",
    staticModels: [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "deepseek-v4.1-flash",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5.6-luna",
      "grok-4.5",
      "grok-4.6",
      "grok-4.7",
      "hy3",
      "hy4-preview",
      "kimi-k2.5",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "longcat-2.0",
      "mimo-v2-omni",
      "mimo-v2-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m2.5",
      "minimax-m2.7",
      "minimax-m3",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "omen-alpha",
      "ox-alpha-free",
      "qwen3.5-plus",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.8-flash",
      "qwen3.8-max",
    ],
  },
  {
    id: "zai",
    name: "Z.AI",
    description: "GLM coding models",
    route: "openai-compat",
    keyEnv: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    probe: "openai",
    prefix: "openai",
    staticModels: [
      "glm-5.3-flash",
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "glm-5-turbo",
      "glm-5",
      "glm-4.7-flashx",
      "glm-4.7-flash",
      "glm-4.7",
      "glm-4.6v",
      "glm-4.6",
      "glm-4.5v",
      "glm-4.5-flash",
      "glm-4.5-air",
      "glm-4.5",
      "glm-5v-turbo",
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax M-series",
    route: "openai-compat",
    keyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/v1",
    probe: "openai",
    prefix: "openai",
    staticModels: ["MiniMax-M3.1", "MiniMax-M3", "MiniMax-M2.7-highspeed", "MiniMax-M2.7"],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models",
    route: "native",
    keyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    probe: "openai",
    prefix: "openai",
    staticModels: ["gpt-6-astra", "gpt-5.4", "gpt-4o-mini"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude models (Messages API)",
    route: "native",
    keyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    probe: "anthropic",
    prefix: "anthropic",
    staticModels: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    description: "Kimi K-series",
    route: "native",
    keyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/v1",
    probe: "openai",
    prefix: "moonshot",
    staticModels: ["kimi-k2-0905-preview", "kimi-latest"],
  },
  {
    id: "zhipu",
    name: "Zhipu AI",
    description: "GLM models (bigmodel.cn)",
    route: "native",
    keyEnv: "ZHIPUAI_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    probe: "openai",
    prefix: "zhipu",
    staticModels: ["glm-5.3-flash", "glm-4.7"],
  },
  {
    id: "groq",
    name: "Groq",
    description: "fast open-model inference",
    route: "native",
    keyEnv: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    probe: "openai",
    prefix: "groq",
    staticModels: ["llama-3.3-70b-versatile"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "hundreds of models, one key",
    route: "native",
    keyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    probe: "openai",
    prefix: "openrouter",
    staticModels: ["anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat-v3.1"],
  },
];

export interface SavedConnection {
  id: string;
  name: string;
  route: ProviderRoute;
  keyEnv: string;
  extraEnv?: Record<string, string>;
  baseUrl: string;
  prefix: string;
  key: string;
  models: string[];
  defaultModel: string;
  addedAt: number;
}

const CONNECTIONS_PATH = join(homedir(), ".config", "mini-tui", "providers.json");

export function loadConnections(path: string = CONNECTIONS_PATH): SavedConnection[] {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data) ? (data as SavedConnection[]) : [];
  } catch {
    return [];
  }
}

export function saveConnection(connection: SavedConnection, path: string = CONNECTIONS_PATH): void {
  const all = loadConnections(path).filter((c) => c.id !== connection.id);
  all.push(connection);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort permissions
  }
}

/** litellm/mini model name for a catalog id (`<prefix>/<id>`, or `openai/<id>` for compat). */
export function litellmName(prefix: string, id: string): string {
  return `${prefix}/${id}`;
}

/** Environment a connection contributes for its models (litellm reads these). */
export function connectionEnv(connection: {
  route: ProviderRoute;
  keyEnv: string;
  extraEnv?: Record<string, string>;
  baseUrl: string;
  key: string;
}): Record<string, string> {
  if (connection.route === "native") {
    return { [connection.keyEnv]: connection.key, ...(connection.extraEnv ?? {}) };
  }
  // OpenAI-compatible providers through litellm's `openai/` provider (MSWEA_ wins in mini).
  return {
    OPENAI_API_KEY: connection.key,
    OPENAI_API_BASE: connection.baseUrl,
    MSWEA_OPENAI_API_KEY: connection.key,
    MSWEA_OPENAI_API_BASE: connection.baseUrl,
  };
}

/** Env for a run using `modelName`: only its provider's credentials (no collisions). */
export function modelEnv(modelName: string, connections: SavedConnection[] = loadConnections()): Record<string, string> {
  for (const connection of connections) {
    const prefix = `${connection.prefix}/`;
    if (modelName.startsWith(prefix) && connection.models.includes(modelName.slice(prefix.length))) {
      return connectionEnv(connection);
    }
  }
  return {};
}

/** Model ids usable with `mini -m` from every saved connection. */
export function connectionModelOptions(connections: SavedConnection[] = loadConnections()): SelectOption[] {
  return connections.flatMap((connection) =>
    connection.models.map((id) => ({
      name: `${connection.name} · ${id}`,
      description: `${connection.route === "native" ? "litellm" : "openai-compat"} · ${connection.baseUrl}`,
      value: litellmName(connection.prefix, id),
    })),
  );
}

/** Ask the provider for its catalog (OpenAI-style or Anthropic-style /models). */
export async function fetchProviderModels(def: ProviderDef, key: string): Promise<string[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (def.probe === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  const response = await fetch(`${def.baseUrl.replace(/\/$/, "")}/models`, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { data?: unknown };
  const rows = Array.isArray(data.data) ? data.data : [];
  const ids = rows
    .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort();
}

/**
 * Real connection test through mini's own (litellm-based) model layer — a passing
 * test means a run will work with this key.
 */
export function testProviderModel(def: ProviderDef, modelName: string, key: string): Promise<boolean> {
  const script = join(import.meta.dir, "..", "scripts", "test_model.py");
  const env = connectionEnv({ route: def.route, keyEnv: def.keyEnv, extraEnv: def.extraEnv, baseUrl: def.baseUrl, key });
  return runHelperScript(script, [modelName], env).then((code) => code === 0);
}
