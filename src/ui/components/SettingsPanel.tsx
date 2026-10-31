import type { SelectOption } from "@opentui/core";

import { colors, DEFAULT_THEME, THEMES, type ThemeDef } from "../theme";
import { CHAT_MODES, OUTPUT_MODES, chatModeOf, indexForMode, type OutputMode, type Settings } from "../../settings";

const themeOptions: SelectOption[] = THEMES.map((theme: ThemeDef) => ({
  name: theme.name,
  description: theme.description,
  value: theme.id,
}));

const chatOptions: SelectOption[] = CHAT_MODES.map((mode) => ({ name: mode.name, description: mode.description, value: mode.value }));

function indexForTheme(id: string | undefined): number {
  const index = THEMES.findIndex((theme) => theme.id === (id ?? DEFAULT_THEME));
  return index >= 0 ? index : 0;
}

/** Group of the main chat mode (its own view: the panel with both selects is already full). */
export const CHAT_GROUP = 2;
/** Group 3 (jev) is its own overlay, rendered by App instead of this panel. */
export const JEV_GROUP = 3;
/** Groups cycled by Tab. */
export const SETTINGS_GROUPS = 4;

/**
 * `/settings` — output display and theme, then the main chat mode, then the jev group (its own
 * panel). ↑/↓ changes the highlighted option (applied live), Enter closes.
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
  if (props.group === CHAT_GROUP) {
    const current = Math.max(0, CHAT_MODES.findIndex((mode) => mode.value === chatModeOf(props.settings)));
    return (
      <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" paddingX={1} gap={0}>
        <text fg={colors.dim}>settings · Tab switches group · Enter done · Esc close</text>
        <text fg={colors.text}>main chat</text>
        <select
          options={chatOptions}
          selectedIndex={current}
          focused
          showDescription
          width="100%"
          height={4}
          backgroundColor={colors.bg}
          focusedBackgroundColor={colors.bg}
          focusedTextColor={colors.text}
          textColor={colors.dim}
          selectedBackgroundColor={colors.panel}
          selectedTextColor={colors.text}
          descriptionColor={colors.faint}
          selectedDescriptionColor={colors.dim}
          onChange={(index: number) => props.onChange({ chatMode: CHAT_MODES[index]!.value })}
          onSelect={() => props.onDone()}
        />
        <text fg={colors.faint}>
          dispatcher: /tasks lists the queue (needs the web server; started for you when none runs) · manual: /workspaces
        </text>
        <text fg={colors.faint}>shared with the web app · applies now</text>
      </box>
    );
  }
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
      <text fg={colors.faint}>Tab → main chat (dispatcher / manual) · jev</text>
    </box>
  );
}
