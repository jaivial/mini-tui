/**
 * v6-C: the Laya decision client.
 *
 * Laya (`convaiinnovations/laya`, Apache-2.0, ModernBERT-large + a typed
 * decision head) is **not** a chat model: it takes a state plus typed questions
 * and answers every question in ONE forward pass with calibrated probabilities
 * (`choice` over an option set, `score` on an ordinal scale, `noul` = P(true)).
 * That is exactly the shape a router needs — score N candidates without
 * generating a token — so this module never asks it to write anything.
 *
 * Transport is the SystemOne HTTP server (`laya-serve`, the `POST
 * /v1/systemone` route the Rust agent's goal oracle already speaks), because
 * that keeps the 800 MB checkpoint in its own process: the router pays a
 * loopback HTTP call instead of loading a model into the web server's heap.
 *
 * Every failure path here is honest and quiet. A missing server, a timeout, a
 * truncated payload or a malformed probability is reported as
 * `unavailable` with a reason, and the caller falls back to the deterministic
 * policy (see `policy.ts`). **Never a random choice, and never a fabricated
 * probability.**
 */
import { loadCatalog } from "./candidates";

/** A typed question, in Laya's own wire shape. */
export interface LayaQuestion {
  type: "choice" | "score" | "noul";
  instructions: string;
  /** `choice` only: the option set. `score` uses an ordinal list instead. */
  criteria?: Record<string, string> | string[];
}

export interface LayaChoiceAnswer {
  type: "choice";
  choice: string;
  /** Calibrated P(option) per option key. Absent when the service omits it. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface LayaNoulAnswer {
  type: "noul";
  /** P(true) — the probability the statement is true, NOT a confidence in an answer. */
  noul: number;
  confidence: number;
}

export interface LayaScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
}

export type LayaAnswer = LayaChoiceAnswer | LayaNoulAnswer | LayaScoreAnswer;

export interface LayaResult {
  ok: boolean;
  answers: Record<string, LayaAnswer>;
  /** Which checkpoint answered — the audit needs this to be reproducible. */
  checkpoint: string;
  /** Why it failed, when `ok` is false. Never thrown: the router degrades, it does not die. */
  reason: string;
  latencyMs: number;
}

export function layaUrl(env: NodeJS.ProcessEnv = process.env): string {
  // The same variable the Rust goal oracle reads, so one URL configures both.
  const configured = env.MINITUI_LAYA_URL ?? env.MINI_AGENT_GOAL_ORACLE_URL ?? "";
  const url = configured.trim() || "http://127.0.0.1:8102/v1/systemone";
  return url;
}

/**
 * The checkpoint this router asks.
 *
 * The base English `convaiinnovations/laya` checkpoint scores near chance on
 * model-choice questions and warns that its shipped temperatures are out of the
 * valid range (`choice:11+` clamped to 0.5) — measured here: the same hard
 * refactor that `laya-multilingual` answers 0.85 "frontier reasoning" comes back
 * 0.54/0.46 at confidence 0.005. So the router pins the multilingual checkpoint,
 * which is also the Rust agent's own default (`MINI_AGENT_LAYA_MODEL`).
 */
export function layaCheckpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINITUI_LAYA_MODEL?.trim() || "laya-multilingual";
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse the SystemOne reply into typed answers, rejecting anything not a probability. */
export function parseLayaResponse(text: string): { answers: Record<string, LayaAnswer>; checkpoint: string; truncated: boolean } {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("laya returned invalid JSON");
  }
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const truncated = usage.truncated === true || (Array.isArray(usage.truncated_questions) && usage.truncated_questions.length > 0);
  const raw = (payload.answers ?? {}) as Record<string, Record<string, unknown>>;
  const answers: Record<string, LayaAnswer> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const confidence = finite(value.confidence) ?? 0;
    if (value.type === "choice") {
      const probabilities: Record<string, number> = {};
      for (const [option, probability] of Object.entries((value.probabilities ?? {}) as Record<string, unknown>)) {
        const p = finite(probability);
        if (p !== null && p >= 0 && p <= 1) probabilities[option] = p;
      }
      // A choice answer with no usable distribution cannot rank anything. Refusing it
      // here is what stops a silently-wrong winner from reaching the audit.
      if (!Object.keys(probabilities).length) throw new Error(`laya answer ${key} carries no probabilities`);
      answers[key] = {
        type: "choice",
        choice: typeof value.choice === "string" ? value.choice : Object.keys(probabilities)[0]!,
        probabilities,
        confidence,
      };
    } else if (value.type === "noul") {
      const noul = finite(value.noul);
      if (noul === null || noul < 0 || noul > 1) throw new Error(`laya answer ${key} omitted its noul probability`);
      answers[key] = { type: "noul", noul, confidence };
    } else if (value.type === "score") {
      const score = finite(value.score);
      if (score === null) throw new Error(`laya answer ${key} omitted its score`);
      answers[key] = { type: "score", score, confidence };
    }
  }
  if (!Object.keys(answers).length) throw new Error("laya returned no usable answers");
  const routing = (payload.routing ?? {}) as Record<string, unknown>;
  return { answers, checkpoint: typeof routing.model === "string" ? routing.model : "", truncated };
}

export interface LayaRequestOptions {
  /** The task/sub-task text Laya classifies. */
  state: string;
  questions: Record<string, LayaQuestion>;
  url?: string;
  checkpoint?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * One SystemOne call. Never throws: an unreachable or wrong-answering Laya is a
 * normal state of this house, and the router has a deterministic policy for it.
 */
export async function askLaya(request: LayaRequestOptions): Promise<LayaResult> {
  const url = request.url ?? layaUrl();
  const checkpoint = request.checkpoint ?? layaCheckpoint();
  const started = Date.now();
  if (!/^https?:\/\//.test(url)) {
    return { ok: false, answers: {}, checkpoint, reason: `laya url must be http(s): ${url.slice(0, 80)}`, latencyMs: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 8_000);
  // A caller-side abort (a shutting-down server) must not be swallowed by ours.
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_len: 2048, model: checkpoint, state: request.state, questions: request.questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, answers: {}, checkpoint, reason: `laya http ${response.status}`, latencyMs: Date.now() - started };
    }
    const text = await response.text();
    if (text.length > 512_000) return { ok: false, answers: {}, checkpoint, reason: "laya response exceeded 512 KB", latencyMs: Date.now() - started };
    let parsed: ReturnType<typeof parseLayaResponse>;
    try {
      parsed = parseLayaResponse(text);
    } catch (error) {
      return { ok: false, answers: {}, checkpoint, reason: (error as Error).message, latencyMs: Date.now() - started };
    }
    if (parsed.truncated) {
      // Truncated evidence means the probabilities describe a state Laya did not
      // fully read. They are reported, never ranked on.
      return { ok: false, answers: {}, checkpoint, reason: "laya truncated the evidence or the questions", latencyMs: Date.now() - started };
    }
    return { ok: true, answers: parsed.answers, checkpoint: parsed.checkpoint || checkpoint, reason: "", latencyMs: Date.now() - started };
  } catch (error) {
    const reason = (error as Error).name === "AbortError" ? "laya timed out" : (error as Error).message.slice(0, 160);
    return { ok: false, answers: {}, checkpoint, reason, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Whether a Laya service is reachable at all — the Settings panel's health line.
 * A GET on the same origin is the cheapest probe there is; it never runs the model.
 */
export async function layaHealth(url: string = layaUrl(), timeoutMs = 2_500): Promise<{ reachable: boolean; detail: string; catalogModels: number }> {
  const catalog = loadCatalog();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const base = url.replace(/\/v1\/systemone\/?$/, "");
      // The SystemOne server answers `/health`; it has no `/healthz`, which
      // returns a JSON 404 that would read as "Laya is down" on a service that
      // is up and serving.
      const response = await fetch(`${base}/health`, { signal: controller.signal });
      if (!response.ok) return { reachable: false, detail: `http ${response.status}`, catalogModels: catalog.models.length };
      const body = (await response.json()) as { status?: string; models?: string[] };
      return {
        reachable: body.status === "ok",
        detail: body.status === "ok" ? `checkpoint: ${(body.models ?? []).join(", ") || "unknown"}` : `status ${body.status ?? "?"}`,
        catalogModels: catalog.models.length,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { reachable: false, detail: (error as Error).message.slice(0, 120), catalogModels: catalog.models.length };
  }
}