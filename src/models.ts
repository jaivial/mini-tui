import type { SelectOption } from "@opentui/core";

/** Curated model list for the `/model` picker (custom ids can still be passed with -m). */
export const MODELS: SelectOption[] = [
  {
    name: "cliproxy/claude-opus-5-5",
    description: "cli-proxy · Claude Opus 5.5 (Claude subscription)",
    value: "cliproxy/claude-opus-5-5",
  },
  { name: "xiaomi/mimo-v2.6-pro", description: "Xiaomi MiMo V2.6 Pro", value: "xiaomi/mimo-v2.6-pro" },
  { name: "xiaomi/mimo-v2.6-flash", description: "Xiaomi MiMo V2.6 Flash (fast)", value: "xiaomi/mimo-v2.6-flash" },
  { name: "deepseek/deepseek-chat", description: "DeepSeek chat", value: "deepseek/deepseek-chat" },
  { name: "deepseek/deepseek-flash", description: "DeepSeek flash (fast)", value: "deepseek/deepseek-flash" },
  { name: "opencode-go/glm-5.3-flash", description: "OpenCode Go · GLM 5.3 flash", value: "opencode-go/glm-5.3-flash" },
  { name: "opencode-go/mimo-v2.5", description: "OpenCode Go · MiMo V2.5", value: "opencode-go/mimo-v2.5" },
  { name: "rosetta/zai-glm/glm-5.3-flash", description: "Rosetta · GLM 5.3 flash", value: "rosetta/zai-glm/glm-5.3-flash" },
  {
    name: "rosetta/minimax/claude-minimax-m3",
    description: "Rosetta · MiniMax M3",
    value: "rosetta/minimax/claude-minimax-m3",
  },
  { name: "openai/gpt-6-astra", description: "OpenAI GPT-6 Astra (Responses API)", value: "openai/gpt-6-astra" },
];
