import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SelectOption } from "@opentui/core";

/** A BYOK provider: paste a key, pick a model, test it, and mini can use it. */
export interface ProviderDef {
  id: string;
  name: string;
  description: string;
  /** Env var mini/litellm reads the key from (the TUI injects it into the run). */
  keyEnv: string;
  /** Extra env (e.g. the API base) injected together with the key. */
  extraEnv?: Record<string, string>;
  /** Base URL used to list models. */
  baseUrl: string;
  /** How to talk to the provider's /models endpoint. */
  probe: "openai" | "anthropic";
  /** Model-name prefix used with `mini -m` (litellm style). */
  prefix: string;
  /** Shown when the catalog request fails. */
  staticModels: string[];
}

/**
 * Curated BYOK providers (OpenAI-compatible unless noted). Order = display order,
 * the ones you actually use first.
 */
export const PROVIDERS: ProviderDef[] = [
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    description: "MiMo V2.5/V2.6 (token plan)",
    keyEnv: "XIAOMI_API_KEY",
    extraEnv: { XIAOMI_API_BASE: "https://token-plan-sgp.xiaomimimo.com/v1" },
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    probe: "openai",
    prefix: "xiaomi",
    staticModels: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "deepseek-chat / deepseek-reasoner",
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    probe: "openai",
    prefix: "deepseek",
    staticModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax M-series",
    keyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/v1",
    probe: "openai",
    prefix: "minimax",
    staticModels: ["MiniMax-M3", "MiniMax-Text-01"],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models",
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
    keyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/v1",
    probe: "openai",
    prefix: "moonshot",
    staticModels: ["kimi-k2-0905-preview", "kimi-latest"],
  },
  {
    id: "zhipu",
    name: "Zhipu AI",
    description: "GLM models",
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
    keyEnv: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    probe: "openai",
    prefix: "openrouter",
    staticModels: ["anthropic/claude-sonnet-4.5", "deepseek/deepseek-chat-v3.1"],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    description: "subscription models over /zen/go",
    keyEnv: "OPENCODE_GO_API_KEY",
    baseUrl: "https://opencode.ai/zen/go/v1",
    probe: "openai",
    prefix: "opencode-go",
    staticModels: ["glm-5.3-flash", "mimo-v2.5", "deepseek-v4-flash"],
  },
];

export interface SavedConnection {
  id: string;
  name: string;
  keyEnv: string;
  extraEnv?: Record<string, string>;
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

/** Env injected into every `mini` run so the saved keys reach the harness. */
export function connectionsEnv(connections: SavedConnection[] = loadConnections()): Record<string, string> {
  const env: Record<string, string> = {};
  for (const connection of connections) {
    env[connection.keyEnv] = connection.key;
    for (const [name, value] of Object.entries(connection.extraEnv ?? {})) env[name] = value;
  }
  return env;
}

/** Model ids usable with `mini -m` from every saved connection. */
export function connectionModelOptions(connections: SavedConnection[] = loadConnections()): SelectOption[] {
  return connections.flatMap((connection) =>
    connection.models.map((id) => ({
      name: `${connection.prefix}/${id}`,
      description: `${connection.name} · ${id}`,
      value: `${connection.prefix}/${id}`,
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
 * Real connection test through mini's own model layer (the exact code path a run
 * uses), so a passing test means the provider actually works.
 */
export function testProviderModel(modelName: string, key: string): Promise<boolean> {
  return new Promise((resolve) => {
    const script = join(import.meta.dir, "..", "scripts", "test_model.py");
    const child = spawn("python3", [script, modelName], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...connectionsEnv([]), ...envFor(modelName, key) },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function envFor(modelName: string, key: string): Record<string, string> {
  const prefix = modelName.split("/")[0];
  const def = PROVIDERS.find((p) => p.id === prefix);
  const env: Record<string, string> = {};
  if (def) {
    env[def.keyEnv] = key;
    for (const [name, value] of Object.entries(def.extraEnv ?? {})) env[name] = value;
  }
  return env;
}
