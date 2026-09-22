import { useRef } from "react";
import type { TextareaRenderable } from "@opentui/core";

import { colors } from "../theme";

// Claude-Code style: Enter sends; Alt+Enter / Ctrl+J insert a newline (Shift+Enter too,
// on terminals that report it through the kitty keyboard protocol).
const PROMPT_KEY_BINDINGS = [
  { name: "return", shift: false, ctrl: false, meta: false, action: "submit" },
  { name: "return", meta: true, action: "newline" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "newline" },
];

/** Multi-line prompt bar pinned to the bottom: always one Enter away. */
export function PromptBar(props: {
  focused: boolean;
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const ref = useRef<TextareaRenderable>(null);
  const hint = props.busy ? "continue the conversation…" : "what should mini do?";
  return (
    <box
      borderStyle="rounded"
      borderColor={props.focused ? colors.borderActive : colors.border}
      paddingX={1}
    >
      <textarea
        ref={ref}
        focused={props.focused}
        height={3}
        keyBindings={PROMPT_KEY_BINDINGS as never}
        placeholder={`${hint}  (Enter send · Alt+Enter/Ctrl+J newline · /model · /settings)`}
        textColor={colors.text}
        placeholderColor={colors.faint}
        backgroundColor={colors.bg}
        onSubmit={() => {
          const text = (ref.current?.editorView.getText() ?? "").replace(/\n+$/, "");
          ref.current?.setText("");
          props.onSend(text);
        }}
      />
    </box>
  );
}
