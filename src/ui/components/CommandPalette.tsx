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
    { insert: "/new", label: "/new", detail: "start a new session (stops the current run)" },
    { insert: "/resume", label: "/resume", detail: "browse sessions saved in this folder" },
    { insert: "/connect", label: "/connect", detail: "connect a provider with your own API key" },
    { insert: "/help", label: "/help", detail: "commands and keys" },
    { insert: "/quit", label: "/quit", detail: "close mini-tui" },
    { insert: "/exit", label: "/exit", detail: "close mini-tui" },
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

/** Row budget for the popover: connected providers can contribute hundreds of models. */
export const PALETTE_ROWS = 12;

/** Visible window of options around the selection (lists never overflow the panel). */
export function paletteWindow(options: CommandOption[], selectedIndex: number): { start: number; items: CommandOption[] } {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(PALETTE_ROWS / 2), Math.max(0, options.length - PALETTE_ROWS)));
  return { start, items: options.slice(start, start + PALETTE_ROWS) };
}

/** Slash-command completion popover (↑/↓ select · Enter/Tab/click fill the prompt). */
export function CommandPalette(props: {
  options: CommandOption[];
  selectedIndex: number;
  onPick: (option: CommandOption) => void;
}) {
  const { start, items } = paletteWindow(props.options, props.selectedIndex);
  return (
    <box borderStyle="rounded" borderColor={colors.border} paddingX={1} gap={0}>
      {items.map((option, k) => {
        const i = start + k;
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
