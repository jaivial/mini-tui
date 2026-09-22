import { colors } from "../theme";
import type { SelectOption } from "@opentui/core";

export interface CommandOption {
  insert: string;
  label: string;
  detail: string;
}

export function buildOptions(models: SelectOption[]): CommandOption[] {
  return [
    { insert: "/model", label: "/model", detail: "open the model picker" },
    { insert: "/settings", label: "/settings", detail: "output display settings" },
    ...models.map((m) => ({
      insert: `/model ${m.value}`,
      label: `/model ${m.value}`,
      detail: m.description,
    })),
  ];
}

export function matchOptions(query: string, options: CommandOption[]): CommandOption[] {
  const q = query.toLowerCase();
  const starts: CommandOption[] = [];
  const includes: CommandOption[] = [];
  for (const option of options) {
    const label = option.label.toLowerCase();
    if (label.startsWith(q)) starts.push(option);
    else if (label.includes(q)) includes.push(option);
  }
  return [...starts, ...includes];
}

/** Slash-command completion popover (↑/↓ select · Enter/Tab/click fill the prompt). */
export function CommandPalette(props: {
  options: CommandOption[];
  selectedIndex: number;
  onPick: (option: CommandOption) => void;
}) {
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      {props.options.map((option, i) => {
        const selected = i === props.selectedIndex;
        return (
          <box key={option.insert} flexDirection="row" gap={1} onMouseDown={() => props.onPick(option)}>
            <text fg={colors.accent}>{selected ? "▸" : " "}</text>
            <text fg={selected ? colors.text : colors.dim}>{option.label}</text>
            <text fg={colors.faint}>{option.detail}</text>
          </box>
        );
      })}
    </box>
  );
}
