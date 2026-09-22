import { useState } from "react";
import type { SelectOption } from "@opentui/core";

import { colors } from "../theme";
import { OUTPUT_MODES, indexForMode, type OutputMode, type Settings } from "../../settings";

export function SettingsPanel(props: {
  settings: Settings;
  onApply: (settings: Settings) => void;
  onCancel: () => void;
}) {
  const options: SelectOption[] = OUTPUT_MODES.map((mode) => ({
    name: mode.name,
    description: mode.description,
    value: mode.value,
  }));
  const [selectedIndex, setSelectedIndex] = useState(() => indexForMode(props.settings.outputMode));
  return (
    <box borderStyle="rounded" borderColor={colors.border} width="80%" paddingX={1} gap={0}>
      <text fg={colors.dim}>settings · output display · Enter apply · Esc close</text>
      <select
        options={options}
        selectedIndex={selectedIndex}
        focused
        wrapSelection
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
        onChange={(index: number) => setSelectedIndex(index)}
        onSelect={(_index: number, option: SelectOption | null) => {
          if (option?.value) props.onApply({ ...props.settings, outputMode: option.value as OutputMode });
        }}
      />
    </box>
  );
}
