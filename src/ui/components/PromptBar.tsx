import { useRef } from "react";
import type { InputRenderable } from "@opentui/core";

import { colors } from "../theme";

/** Claude-Code-style prompt bar pinned to the bottom: always one Enter away. */
export function PromptBar(props: {
  focused: boolean;
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const inputRef = useRef<InputRenderable>(null);
  const hint = props.busy ? "continue the conversation…" : "what should mini do?";
  return (
    <box
      borderStyle="rounded"
      borderColor={props.focused ? colors.borderActive : colors.border}
      title="prompt"
      titleColor={props.focused ? colors.accent : colors.dim}
      paddingX={1}
    >
      <input
        ref={inputRef}
        focused={props.focused}
        placeholder={`${hint}  (Enter send · /model switch model)`}
        textColor={colors.text}
        backgroundColor={colors.bg}
        cursorColor={colors.accent}
        onSubmit={((value: string | { value?: string }) => {
          const text = typeof value === "string" ? value : String(value?.value ?? "");
          if (inputRef.current) inputRef.current.value = "";
          props.onSend(text);
        }) as never}
      />
    </box>
  );
}
