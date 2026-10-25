/**
 * Provider/model reasoning-effort catalogue.
 *
 * This is deliberately a deny-by-default map: an unknown model gets Auto only rather than a
 * plausible-looking control whose parameter its endpoint may reject. Sources and the research
 * table live in docs/model-effort.md. Keep the Rust wire mapping in agent-rs/src/models in sync.
 */
export const EFFORT_LEVELS = ["auto", "off", "on", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type ConfiguredEffort = Exclude<EffortLevel, "auto">;
export type EffortKind = "openai" | "anthropic" | "thinking" | "openrouter" | "ollama" | "none";

export interface EffortCapability {
  /** Selectable levels, excluding Auto (which every picker adds). */
  levels: ConfiguredEffort[];
  kind: EffortKind;
  /** Provider default, when documented. Empty means not explicitly documented. */
  defaultEffort?: ConfiguredEffort;
  source?: string;
  note?: string;
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  auto: "Auto",
  off: "Off",
  on: "On",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const EFFORT_HINTS: Record<EffortLevel, string> = {
  auto: "Use the provider default",
  off: "Disable reasoning where supported",
  on: "Enable reasoning with the provider default depth",
  minimal: "Least reasoning; lowest latency",
  low: "Fast, lightweight reasoning",
  medium: "Balanced quality and latency",
  high: "Deeper reasoning for difficult work",
  xhigh: "Extended long-horizon reasoning",
  max: "Maximum reasoning; highest latency and cost",
};

const OPENAI = "https://platform.openai.com/docs/guides/reasoning";
const OPENAI_MODELS = "https://platform.openai.com/docs/models";
const CLAUDE = "https://docs.anthropic.com/en/docs/build-with-claude/effort";
const OPENROUTER = "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens";
const OLLAMA = "https://docs.ollama.com/capabilities/thinking";
const GROQ = "https://console.groq.com/docs/reasoning";
const DEEPSEEK = "https://api-docs.deepseek.com/guides/reasoning_model";
const MOONSHOT = "https://platform.moonshot.ai/docs/api/chat";
const ZAI = "https://docs.z.ai/guides/llm/glm-5.3";

const cap = (levels: ConfiguredEffort[], kind: EffortKind, source?: string, defaultEffort?: ConfiguredEffort, note?: string): EffortCapability =>
  ({ levels, kind, ...(source ? { source } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(note ? { note } : {}) });
const NONE = cap([], "none");
const CLAUDE_55 = cap(["low", "medium", "high", "xhigh", "max"], "anthropic", CLAUDE, "medium", "Adaptive thinking stays enabled; effort controls its depth.");
const GLM_53 = cap(["low", "high", "max"], "openai", ZAI, "max", "GLM-5.3 always reasons; it does not accept thinking.disabled.");
const KIMI_K3 = cap(["low", "high", "max"], "openai", MOONSHOT, "max", "Kimi K3 always reasons and preserves thinking.");

/** First segment is mini's route; later segments can be a gateway's upstream provider. */
export function effortProvider(model: string): string {
  return model.split("/")[0]?.toLowerCase() || "other";
}

export function bareModel(model: string): string {
  const i = model.indexOf("/");
  return (i >= 0 ? model.slice(i + 1) : model).toLowerCase();
}

function claudeCapability(id: string): EffortCapability {
  if (/claude-(opus|haiku)-5-5/.test(id)) return CLAUDE_55;
  if (/claude-(opus|sonnet)-5(?:-|$)/.test(id)) return cap(["low", "medium", "high", "xhigh", "max"], "anthropic", CLAUDE, "high");
  if (/claude-(opus|sonnet)-4-6/.test(id)) return cap(["low", "medium", "high", "max"], "anthropic", CLAUDE, "high");
  if (/claude-opus-4-5/.test(id)) return cap(["low", "medium", "high"], "anthropic", CLAUDE, "high", "Opus 4.5 combines effort with its extended-thinking budget.");
  return NONE;
}

function openAICapability(id: string): EffortCapability {
  if (/^gpt-6(?:$|[.-])/.test(id)) return cap(["low", "medium", "high", "xhigh", "max"], "openai", `${OPENAI_MODELS}/gpt-6-astra`, undefined, "GPT-6 Astra rejects reasoning effort none.");
  if (/^gpt-5\.6/.test(id)) return cap(["off", "low", "medium", "high", "xhigh", "max"], "openai", `${OPENAI_MODELS}/gpt-5.6-luna`, "medium");
  if (/^gpt-5\.5/.test(id)) return cap(["off", "low", "medium", "high", "xhigh"], "openai", `${OPENAI_MODELS}/gpt-5.5`, "medium");
  if (/^gpt-5\.4/.test(id)) return cap(["off", "low", "medium", "high", "xhigh"], "openai", `${OPENAI_MODELS}/gpt-5.4`, "off");
  if (/^gpt-5\.2/.test(id)) return cap(["off", "low", "medium", "high", "xhigh"], "openai", `${OPENAI_MODELS}/gpt-5.2`, "off");
  if (/^gpt-5\.1/.test(id)) return cap(["off", "low", "medium", "high"], "openai", `${OPENAI_MODELS}/gpt-5.1`, "off");
  if (/^gpt-5(?:-|$)/.test(id)) return cap(["minimal", "low", "medium", "high"], "openai", `${OPENAI_MODELS}/gpt-5`);
  // Unverified GPT-5.x families stay on Auto; never inherit another model's levels.
  if (/^o[134](?:$|-)/.test(id)) return cap(["low", "medium", "high"], "openai", OPENAI, "medium");
  if (/gpt-oss/.test(id)) return cap(["low", "medium", "high"], "openai", OPENAI, "medium");
  return NONE;
}

function glmCapability(id: string): EffortCapability {
  if (/glm-5\.3/.test(id)) return GLM_53;
  if (/glm-5\.2/.test(id)) return cap(["off", "low", "high", "max"], "openai", "https://docs.z.ai/guides/llm/glm-5.2", "max");
  if (/glm-(5(?:\.1)?|4\.[567])/.test(id)) return cap(["off", "on"], "thinking", "https://docs.z.ai/guides/capabilities/thinking-mode");
  return NONE;
}

function kimiCapability(id: string): EffortCapability {
  if (/(?:^|\/)k3(?:-|$)|kimi-k3/.test(id)) return KIMI_K3;
  if (/kimi-k2\.7-code/.test(id)) return cap(["on"], "thinking", MOONSHOT, "on", "Kimi K2.7 Code always reasons.");
  if (/kimi-k2\.6/.test(id)) return cap(["off", "on"], "thinking", MOONSHOT);
  return NONE;
}

/** The exact capabilities for one fully-qualified mini model id. */
export function effortCapability(model: string): EffortCapability {
  const provider = effortProvider(model);
  const id = bareModel(model);
  if (provider === "openrouter") {
    const upstreamId = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    let base: EffortCapability = NONE;
    if (/^(?:anthropic\/)?claude-/.test(id) || /^(?:opus|sonnet|haiku)-/.test(upstreamId)) base = claudeCapability(upstreamId);
    else if (/^(?:openai\/)?(?:gpt-|o[134](?:-|$))/.test(id)) base = openAICapability(upstreamId);
    else if (/(?:^|\/)glm-/.test(id)) base = glmCapability(upstreamId);
    else if (/(?:^|\/)kimi-|(?:^|\/)k3(?:-|$)/.test(id)) base = kimiCapability(upstreamId);
    else if (/(?:^|\/)deepseek-/.test(id)) {
      base = /reasoner/.test(upstreamId)
        ? cap(["on"], "thinking", DEEPSEEK, "on")
        : cap(["off", "low", "medium", "high"], "openai", DEEPSEEK);
    }
    return base.levels.length
      ? { ...base, kind: "openrouter", source: OPENROUTER, note: "OpenRouter translates this model family's levels through its unified reasoning control." }
      : NONE;
  }
  if (provider === "ollama") {
    // Ollama's /api/show is authoritative for custom models. These are the documented named-level
    // families; unknown local ids stay on Auto rather than receiving an invalid think value.
    if (/gpt-oss|qwen3|deepseek-r1/.test(id)) return cap(["off", "low", "medium", "high"], "ollama", OLLAMA, "medium");
    return NONE;
  }
  if (provider === "groq") {
    if (/qwen.*3\.8/.test(id)) return cap(["off", "low", "medium", "high", "xhigh"], "openai", GROQ, "xhigh");
    if (/gpt-oss|muse-spark/.test(id)) return cap(["low", "medium", "high"], "openai", GROQ, "medium");
    return NONE;
  }
  if (provider === "anthropic" || ((provider === "cliproxy" || provider === "opencode-go") && /claude|sonnet|opus|haiku/.test(id))) return claudeCapability(id);
  if (provider === "openai" || (provider === "opencode-go" && /^gpt-/.test(id))) return openAICapability(id);
  if (provider === "opencode-go" && /^grok-/.test(id)) return cap(["low", "medium", "high", "xhigh"], "openai", "https://docs.x.ai/docs/models/grok-4.7", "high");
  if (provider === "zai" || provider === "zhipu" || /(?:^|\/)glm-/.test(id)) return glmCapability(id);
  if (provider === "kimi-coding" || provider === "moonshot" || /(?:^|\/)kimi-|(?:^|\/)k3(?:-|$)/.test(id)) return kimiCapability(id);
  if (provider === "deepseek" || /(?:^|\/)deepseek-/.test(id)) {
    if (/reasoner/.test(id)) return cap(["on"], "thinking", DEEPSEEK, "on");
    if (/deepseek-(?:chat|flash)|deepseek-v4/.test(id)) return cap(["off", "low", "medium", "high"], "openai", DEEPSEEK);
    return NONE;
  }
  if (provider === "xiaomi" || /(?:^|\/)mimo-/.test(id)) return cap(["off", "on"], "thinking", "https://platform.xiaomimimo.com/docs");
  // MiniMax's public chat API does not expose a portable effort enum. Do not infer one from its
  // reasoning output or from another gateway's implementation.
  return NONE;
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function selectedEffort(model: string, preferences: Partial<Record<string, EffortLevel>> = {}): EffortLevel {
  const value = preferences[model];
  return value && isEffortLevel(value) && (value === "auto" || effortCapability(model).levels.includes(value)) ? value : "auto";
}

/** Only concrete, valid choices cross into a child process. Auto means no parameter on the wire. */
export function effortRunEnv(preferences: Partial<Record<string, EffortLevel>> = {}): Record<string, string> {
  const clean = Object.fromEntries(
    Object.entries(preferences).filter(([model, level]) => level !== "auto" && selectedEffort(model, preferences) === level),
  );
  return Object.keys(clean).length ? { MINI_AGENT_MODEL_EFFORTS: JSON.stringify(clean) } : {};
}
