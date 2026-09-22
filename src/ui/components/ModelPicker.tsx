import { useState } from "react";
import type { SelectOption } from "@opentui/core";

import { colors } from "../theme";

/** Curated model list for the `/model` picker (custom ids can still be passed with -m). */
export const MODELS: SelectOption[] = [
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

export function indexForModel(model: string | undefined): number {
  const index = MODELS.findIndex((option) => option.value === model);
  return index >= 0 ? index : 1;
}

export function ModelPicker(props: {
  current?: string;
  models?: SelectOption[];
  onPick: (model: string) => void;
  onCancel: () => void;
}) {
  const models = props.models ?? MODELS;
  const indexFor = (model: string | undefined): number => {
    const index = models.findIndex((option) => option.value === model);
    return index >= 0 ? index : 0;
  };
  const [selectedIndex, setSelectedIndex] = useState(() => indexFor(props.current));
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      <text fg={colors.dim}>model · ↑/↓ choose · Enter apply · Esc close (applies from the next step)</text>
      <select
        options={models}
        selectedIndex={selectedIndex}
        focused
        wrapSelection
        showDescription
        showScrollIndicator
        width="100%"
        height={14}
        backgroundColor={colors.bg}
        focusedBackgroundColor={colors.bg}
        focusedTextColor={colors.text}
        textColor={colors.dim}
        selectedBackgroundColor={colors.panel}
        selectedTextColor={colors.text}
        descriptionColor={colors.faint}
        selectedDescriptionColor={colors.dim}
        onChange={(index: number) => setSelectedIndex(index)}
        onSelect={(_index: number, option: SelectOption | null) => {
          if (option?.value) props.onPick(String(option.value));
        }}
      />
    </box>
  );
}
