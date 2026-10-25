import { describe, expect, test } from "bun:test";
import { effortCapability, effortRunEnv, selectedEffort } from "../src/effort";

describe("model effort catalogue", () => {
  test("maps provider-specific levels instead of offering one generic enum", () => {
    expect(effortCapability("openai/gpt-6-astra").levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortCapability("opencode-go/gpt-5.6-luna").levels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(effortCapability("anthropic/claude-opus-5-5").levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortCapability("zai/glm-5.3").levels).toEqual(["low", "high", "max"]);
    expect(effortCapability("moonshot/kimi-k2.6").levels).toEqual(["off", "on"]);
    expect(effortCapability("minimax/MiniMax-M3").levels).toEqual([]);
  });

  test("recognises upstream families behind gateways", () => {
    expect(effortCapability("cliproxy/claude-sonnet-5-5").kind).toBe("anthropic");
    expect(effortCapability("opencode-go/glm-5.3-flash").levels).toContain("max");
    expect(effortCapability("opencode-go/gpt-5.6-luna").kind).toBe("openai");
    expect(effortCapability("opencode-go/claude-haiku-5-5").kind).toBe("anthropic");
    expect(effortCapability("opencode-go/grok-4.7").levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortCapability("openrouter/anthropic/claude-opus-5-5").kind).toBe("openrouter");
    expect(effortCapability("openrouter/anthropic/claude-opus-5-5").levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortCapability("openrouter/openai/gpt-4o-mini").levels).toEqual([]);
  });

  test("mandatory-reasoning models do not offer Off", () => {
    expect(effortCapability("zai/glm-5.3").levels).not.toContain("off");
    expect(effortCapability("kimi-coding/k3").levels).not.toContain("off");
    expect(effortCapability("anthropic/claude-opus-5-5").levels).not.toContain("off");
  });

  test("an unknown model stays on Auto rather than receiving guessed parameters", () => {
    expect(effortCapability("acme/model-from-the-future").levels).toEqual([]);
    expect(effortCapability("openai/gpt-4o-mini").levels).toEqual([]);
  });

  test("invalid or stale preferences fall back to Auto and never reach the run env", () => {
    const prefs = { "zai/glm-5.3": "off", "openai/gpt-6-astra": "high" } as never;
    expect(selectedEffort("zai/glm-5.3", prefs)).toBe("auto");
    expect(selectedEffort("openai/gpt-6-astra", prefs)).toBe("high");
    expect(effortRunEnv(prefs)).toEqual({ MINI_AGENT_MODEL_EFFORTS: JSON.stringify({ "openai/gpt-6-astra": "high" }) });
    expect(effortRunEnv({ "openai/gpt-6-astra": "auto" })).toEqual({});
  });
});
