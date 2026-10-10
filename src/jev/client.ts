/**
 * Jev = TypeSafe's System One decision model. It does not generate text: you send a JSON `state`
 * and a map of typed `questions` (Noul / Choice / Score) and get back typed answers with
 * probabilities in ~600 ms. Code owns the workflow; Jev supplies the judgement.
 *
 * Endpoint: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`.
 * NOT `jevtypesafeai.com` and not OpenRouter — OpenRouter is a separate OpenAI-compatible chat
 * provider that happens to sit in the same keyring; System One is only served by the host above.
 * `GET /v1/models` on the same base lists the models (`jev-latest`, `jev-preview`), and the
 * response's `model` field pins the concrete build in force (today `jev-1.13.0`).
 *
 * Docs (source of truth): https://docs.typesafe.ai/llms.txt
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { JEV_KEY_NAME, getSecret } from "./vault";

export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";

/** The three typed judgement primitives of the Decisions API. */
export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  /** The whole meaning lives here: question ids are for our code, never sent to the model. */
  instructions: string;
  /** `choice`: closed set of labels. `score`: ordered levels, low to high. */
  criteria?: Record<string, string | null> | string[] | null;
}

export interface JevAnswer {
  type: JevQuestionType;
  /** noul: the probability the condition holds. */
  noul?: number;
  /** choice/score: the selected label. */
  choice?: string;
  score?: number;
  /** The distribution behind the pick — the raw numbers thresholds are tuned on. */
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
  confidence?: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  _meta?: { latency_ms?: number; questions?: number };
}

// ------------------------------------------------------------------ key resolution

export interface JevKeySource {
  key: string;
  model: string;
  baseUrl: string;
  /** Where the key came from — never the key itself, for display. */
  source: string;
}

/**
 * Key resolution, in the same order as the `jev` CLI skill uses so a machine configured for the
 * skill works here with no extra setup:
 *   vault `jev-api-key` → `$TYPESAFE_API_KEY` → `~/.config/typesafe/config.json`
 *   → `~/.config/mini-swe-agent/brain.json`.
 *
 * The vault is FIRST, and that is the one rule worth stating out loud: a key the user typed into
 * this TUI's `/settings` is an explicit choice and must win over a machine-wide file they may
 * have forgotten is there. Everything else keeps the skill's order, so a box configured for the
 * skill needs no setup at all. Every caller resolves through this one function, so what
 * `mini-tui settings` prints, what `mini-tui jev check` probes and what a run judges with can
 * never disagree about which key is in force.
 */
export function resolveJevKey(preferVault = true): JevKeySource {
  const baseUrl = (process.env.TYPESAFE_BASE_URL || JEV_BASE_URL).replace(/\/$/, "");
  let key = "";
  let model = process.env.TYPESAFE_DEFAULT_MODEL || JEV_DEFAULT_MODEL;
  let source = "";

  // One small file read, and only when a key is actually wanted: Jev being off costs nothing.
  if (preferVault) {
    const vaulted = getSecret(JEV_KEY_NAME);
    if (vaulted) {
      key = vaulted;
      source = `vault:${JEV_KEY_NAME}`;
    }
  }
  if (!key) key = process.env.TYPESAFE_API_KEY || "";
  if (key && !source) source = "TYPESAFE_API_KEY";

  if (!key) {
    for (const path of [join(homedir(), ".config", "typesafe", "config.json"), join(homedir(), ".config", "mini-swe-agent", "brain.json")]) {
      if (!existsSync(path)) continue;
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        key = typeof data.api_key === "string" && data.api_key ? data.api_key : typeof data.typesafe_api_key === "string" ? data.typesafe_api_key : "";
        model = (typeof data.model === "string" && data.model) || (typeof data.typesafe_model === "string" && data.typesafe_model) || model;
        if (key) {
          source = path;
          break;
        }
      } catch {
        // a broken config file is skipped, like the CLI does
      }
    }
  }



  return { key, model, baseUrl, source };
}

// ------------------------------------------------------------------ the call

async function jevRequest<T>(path: string, body: unknown, auth: JevKeySource, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${auth.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      // The API asks for back-off on 429/529; the caller decides, we only surface the reason.
      const detail = text.slice(0, 400);
      throw new Error(`jev: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface JevCallResult {
  ok: boolean;
  response?: JevResponse;
  error?: string;
  /** Whether the failure was "no key configured" (distinct from a network/authority failure). */
  unconfigured?: boolean;
}

/** One state, many questions in one request — the fan-out the API is designed around. */
export async function jevAsk(state: unknown, questions: Record<string, JevQuestion>, auth = resolveJevKey()): Promise<JevCallResult> {
  if (!auth.key) return { ok: false, unconfigured: true, error: "no jev api key" };
  try {
    const response = await jevRequest<JevResponse>("/v1/systemone", { state, model: auth.model, questions }, auth);
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** `GET /v1/models` — reachability plus the concrete model ids. Also the "test my key" probe. */
export async function jevModels(auth = resolveJevKey()): Promise<{ ok: boolean; models: string[]; model: string; source: string; baseUrl: string; error?: string }> {
  const base = { models: [] as string[], model: auth.model, source: auth.source, baseUrl: auth.baseUrl };
  if (!auth.key) return { ...base, ok: false, error: "no jev api key" };
  try {
    const response = await fetch(`${auth.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${auth.key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ...base, ok: false, error: `HTTP ${response.status}` };
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    return { ...base, ok: true, models };
  } catch (error) {
    return { ...base, ok: false, error: (error as Error).message };
  }
}