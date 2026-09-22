import type { SelectOption } from "@opentui/core";

import { colors, DEFAULT_THEME, THEMES, type ThemeDef } from "../theme";
import { OUTPUT_MODES, indexForMode, type OutputMode, type Settings } from "../../settings";

const themeOptions: SelectOption[] = THEMES.map((theme: ThemeDef) => ({
  name: theme.name,
  description: theme.description,
  value: theme.id,
}));

function indexForTheme(id: string | undefined): number {
  const index = THEMES.findIndex((theme) => theme.id === (id ?? DEFAULT_THEME));
  return index >= 0 ? index : 0;
}

/**
 * `/settings` — two groups (output display · theme). Tab switches groups, ↑/↓
 * changes the highlighted option (applied live), Enter closes.
 */
export function SettingsPanel(props: {
  settings: Settings;
  group: number;
  onChange: (patch: Partial<Settings>) => void;
  onDone: () => void;
}) {
  const outputOptions: SelectOption[] = OUTPUT_MODES.map((mode) => ({
    name: mode.name,
    description: mode.description,
    value: mode.value,
  }));
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" paddingX={1} gap={0}>
      <text fg={colors.dim}>settings · Tab switches group · Enter done · Esc close</text>

      <text fg={props.group === 0 ? colors.text : colors.faint}>output display</text>
      <select
        options={outputOptions}
        selectedIndex={indexForMode(props.settings.outputMode)}
        focused={props.group === 0}
        showDescription
        width="100%"
        height={7}
        backgroundColor={colors.bg}
        focusedBackgroundColor={colors.bg}
        focusedTextColor={colors.text}
        textColor={colors.dim}
        selectedBackgroundColor={colors.panel}
        selectedTextColor={colors.text}
        descriptionColor={colors.faint}
        selectedDescriptionColor={colors.dim}
        onChange={(index: number) => props.onChange({ outputMode: OUTPUT_MODES[index].value as OutputMode })}
        onSelect={() => props.onDone()}
      />

      <text fg={props.group === 1 ? colors.text : colors.faint}>theme</text>
      <select
        options={themeOptions}
        selectedIndex={indexForTheme(props.settings.theme)}
        focused={props.group === 1}
        showDescription
        showScrollIndicator
        width="100%"
        height={13}
        backgroundColor={colors.bg}
        focusedBackgroundColor={colors.bg}
        focusedTextColor={colors.text}
        textColor={colors.dim}
        selectedBackgroundColor={colors.panel}
        selectedTextColor={colors.text}
        descriptionColor={colors.faint}
        selectedDescriptionColor={colors.dim}
        onChange={(index: number) => props.onChange({ theme: THEMES[index].id })}
        onSelect={() => props.onDone()}
      />
    </box>
  );
}
